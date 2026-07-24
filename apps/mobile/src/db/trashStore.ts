/**
 * Durable trash-attempt lifecycle (m0.7 item H: P6#4, P7#4, P8#3, P8#4,
 * P5#4). The dangerous window is: measure sizes → Android trashes → the
 * process dies before SQLite records anything. So the attempt is durable
 * BEFORE native dispatch:
 *
 *   prepareTrashBatch   one transaction: batch row (`preparing`), member
 *                       rows with measured bytes + captured generation,
 *                       one reservation per photo (PK = one live attempt).
 *   markBatchLaunching  just before the consent dialog shows.
 *   resolveTrashBatch   after the native result: per-member tri-state
 *                       verification → outcomes + queue cleanup + credit;
 *                       cancelled/still-present members release back to
 *                       the cull queue.
 *   recoverTrashBatches at startup: an interrupted `preparing` batch was
 *                       never dispatched → released; an interrupted
 *                       `launching` batch is verified conservatively —
 *                       authoritative absence repairs the photo but earns
 *                       the UNCREDITED `absent_after_interrupted_launch`
 *                       outcome (P8#3: the stored state cannot prove which
 *                       side of dispatch the crash hit; absence alone
 *                       never claims reclaimed bytes).
 *
 * Batches are bounded by TRASH_BATCH_LIMIT per OS request (P5#4); credit
 * derives from verified member rows only; `(photo, trash_generation)`
 * terminal uniqueness is schema-enforced; a verified post-restore
 * re-trash legitimately counts the next generation (P8#4).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { closeShareCycleIfQueueEmpty } from './shareStore';

/** Conservative app cap per MediaStore consent request (P5#4; platform
 * limit is 2000 — autonomous: 500, matching the SQL chunk size). */
export const TRASH_BATCH_LIMIT = 500;

export type TrashOutcome =
  'pending' | 'trashed' | 'absent_after_interrupted_launch' | 'still_present' | 'unknown';

export interface PreparedTrashBatch {
  batchId: number;
  members: { photoId: string; contentUri: string | null; measuredBytes: number }[];
}

export interface TrashMemberInput {
  photoId: string;
  measuredBytes: number;
}

export interface PrepareTrashBatchOptions {
  /** Edited-copy cull (Home): members currently 'to_edit' are staged to
   * 'culled' in the SAME transaction as the reservation, so no crash
   * window can leave a staged-but-unreserved photo behind. A non-trashed
   * outcome reverts via unstageCullDirect (needs_edit stays set). */
  stageToEditMembers?: boolean;
}

/**
 * Reserve up to TRASH_BATCH_LIMIT staged culls into a `preparing` batch.
 * Photos already reserved by a live attempt are skipped (P8#4: one live
 * attempt per photo — the reservation PK enforces it; this pre-filter
 * keeps the transaction conflict-free). Returns null when nothing could
 * be reserved.
 */
export async function prepareTrashBatch(
  db: SQLiteDatabase,
  members: readonly TrashMemberInput[],
  launchedFromSessionId: number | null,
  at: number,
  options: PrepareTrashBatchOptions = {},
): Promise<PreparedTrashBatch | null> {
  let result: PreparedTrashBatch | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const reserved = await txn.getAllAsync<{ photo_id: string }>(
      'SELECT photo_id FROM trash_reservations',
    );
    const taken = new Set(reserved.map((r) => r.photo_id));
    const eligible = members.filter((m) => !taken.has(m.photoId)).slice(0, TRASH_BATCH_LIMIT);
    if (eligible.length === 0) return;
    if (options.stageToEditMembers) {
      for (const member of eligible) {
        await txn.runAsync(
          `UPDATE photos SET state = 'culled', culled_at = COALESCE(culled_at, ?), activity_at = ?
           WHERE asset_id = ? AND state = 'to_edit'`,
          at,
          at,
          member.photoId,
        );
      }
    }
    const batch = await txn.runAsync(
      `INSERT INTO trash_batches (state, launched_from_session_id, created_at)
       VALUES ('preparing', ?, ?)`,
      launchedFromSessionId,
      at,
    );
    const batchId = Number(batch.lastInsertRowId);
    const out: PreparedTrashBatch = { batchId, members: [] };
    for (const member of eligible) {
      const row = await txn.getFirstAsync<{
        trash_generation: number;
        content_uri: string | null;
        state: string;
      }>(
        'SELECT trash_generation, content_uri, state FROM photos WHERE asset_id = ?',
        member.photoId,
      );
      if (!row || row.state !== 'culled') continue; // only staged culls
      await txn.runAsync(
        `INSERT INTO trash_batch_members (batch_id, photo_id, trash_generation, measured_bytes)
         VALUES (?, ?, ?, ?)`,
        batchId,
        member.photoId,
        row.trash_generation,
        member.measuredBytes,
      );
      await txn.runAsync(
        'INSERT INTO trash_reservations (photo_id, batch_id, trash_generation) VALUES (?, ?, ?)',
        member.photoId,
        batchId,
        row.trash_generation,
      );
      out.members.push({
        photoId: member.photoId,
        contentUri: row.content_uri,
        measuredBytes: member.measuredBytes,
      });
    }
    if (out.members.length === 0) {
      await txn.runAsync('DELETE FROM trash_batches WHERE id = ?', batchId);
      return;
    }
    result = out;
  });
  return result;
}

/** The consent dialog is about to show — record durable dispatch intent. */
export async function markBatchLaunching(
  db: SQLiteDatabase,
  batchId: number,
  at: number,
): Promise<void> {
  await db.runAsync(
    "UPDATE trash_batches SET state = 'launching', dispatched_at = ? WHERE id = ?",
    at,
    batchId,
  );
}

/**
 * C#7 terminal-removal cleanup for one photo, inside the caller's
 * transaction: state converges to trashed, presence drops, queued AND
 * error-state intents cancel with their targets (the queue views include
 * 'error', so a later Gallery restore must not resurrect a stale
 * favourite/organize intent), the share-queue row leaves, and any
 * pending edited-copy match where this photo is the ORIGINAL resolves —
 * a removed original can never be re-prompted, and a stale pending match
 * would block detection for it after a Gallery restore. Shared by
 * verified trash outcomes and external-removal reconciliation.
 * `markCulled` stamps the culled_at lifetime-event marker — true only
 * for verified Afterglow cull outcomes; an external removal was never an
 * Afterglow cull decision and must not inflate the lifetime count.
 */
async function applyRemovalCleanup(
  txn: SQLiteDatabase,
  photoId: string,
  at: number,
  markCulled: boolean,
): Promise<void> {
  await txn.runAsync(
    `UPDATE photos SET state = 'trashed', is_present = 0, needs_edit = 0,
       favourite_state = CASE WHEN favourite_state IN ('queued_apply', 'queued_remove', 'error')
         THEN 'none' ELSE favourite_state END,
       favourite_target = CASE WHEN favourite_state IN ('queued_apply', 'queued_remove', 'error')
         THEN NULL ELSE favourite_target END,
       organize_state = CASE WHEN organize_state IN ('queued', 'error') THEN 'none'
         ELSE organize_state END,
       organize_volume = CASE WHEN organize_state IN ('queued', 'error') THEN NULL
         ELSE organize_volume END,
       organize_path = CASE WHEN organize_state IN ('queued', 'error') THEN NULL
         ELSE organize_path END,
       culled_at = CASE WHEN ? = 1 THEN COALESCE(culled_at, ?) ELSE culled_at END,
       activity_at = ?
     WHERE asset_id = ?`,
    markCulled ? 1 : 0,
    at,
    at,
    photoId,
  );
  await txn.runAsync('DELETE FROM share_queue WHERE photo_id = ?', photoId);
  await txn.runAsync(
    "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
    photoId,
  );
}

/**
 * External-removal reconciliation (the History "deleted outside
 * Afterglow drop out" contract): the given photos were authoritatively
 * found trashed or gone in MediaStore without an Afterglow attempt —
 * converge them exactly like a verified trash outcome, with NO
 * reclaimed-bytes credit (nothing was measured or verified through the
 * lifecycle) and NO culled_at marker (the user made no Afterglow cull
 * decision, so the lifetime culled count is untouched). A photo later
 * restored from system trash re-enters via the session-draw restore
 * reconciliation as usual.
 */
export async function reconcileExternallyRemoved(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  at: number,
): Promise<void> {
  if (photoIds.length === 0) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const id of photoIds) await applyRemovalCleanup(txn, id, at, false);
    await closeShareCycleIfQueueEmpty(txn, at);
  });
}

export type PresenceCheck = 'present' | 'absent' | 'unknown';

export interface ResolveInput {
  batchId: number;
  /** Per member: what an authoritative post-dialog check found (C#1
   * tri-state; permission failures and errors must be 'unknown'). */
  verify: (photoId: string) => Promise<PresenceCheck>;
  /** The consent dialog outcome for the whole batch. */
  dialog: 'applied' | 'cancelled' | 'unsupported' | 'failed';
  /** True when this resolution recovers an interrupted `launching` attempt
   * after process death — absence then earns NO credit (P8#3). */
  interrupted?: boolean;
  at: number;
}

export interface ResolveResult {
  outcomes: Record<string, TrashOutcome>;
  creditedBytes: number;
  batchState: 'verified' | 'verified_partial' | 'cancelled' | 'error';
}

/**
 * Resolve a dispatched (or recovered) batch: verify each member
 * tri-state, write outcomes + queue cleanup + presence in ONE
 * transaction, release the reservations, and derive the batch display
 * state from member outcomes (P8#4). C#7 cleanup on a trashed member:
 * `state = trashed`, `is_present = 0`, `needs_edit = 0`, pending
 * favourite/organize intents cancelled, `activity_at` stamped.
 */
export async function resolveTrashBatch(
  db: SQLiteDatabase,
  input: ResolveInput,
): Promise<ResolveResult> {
  const members = await db.getAllAsync<{
    photo_id: string;
    trash_generation: number;
    measured_bytes: number;
  }>(
    'SELECT photo_id, trash_generation, measured_bytes FROM trash_batch_members WHERE batch_id = ?',
    input.batchId,
  );

  // Native verification happens OUTSIDE the transaction (no SQLite lock
  // held across MediaStore queries), then everything commits at once.
  const checks = new Map<string, PresenceCheck>();
  if (input.dialog === 'applied' || input.interrupted) {
    for (const member of members) checks.set(member.photo_id, await input.verify(member.photo_id));
  }

  const outcomes: Record<string, TrashOutcome> = {};
  let creditedBytes = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const member of members) {
      const check = checks.get(member.photo_id);
      let outcome: TrashOutcome;
      if (
        input.dialog === 'cancelled' ||
        input.dialog === 'unsupported' ||
        input.dialog === 'failed'
      ) {
        outcome = 'still_present';
      } else if (check === 'absent') {
        outcome = input.interrupted ? 'absent_after_interrupted_launch' : 'trashed';
      } else if (check === 'present') {
        outcome = 'still_present';
      } else {
        outcome = 'unknown';
      }
      outcomes[member.photo_id] = outcome;

      await txn.runAsync(
        'UPDATE trash_batch_members SET outcome = ? WHERE batch_id = ? AND photo_id = ?',
        outcome,
        input.batchId,
        member.photo_id,
      );
      if (outcome === 'trashed' || outcome === 'absent_after_interrupted_launch') {
        // C#7 transition contract, one transaction with the outcome.
        await applyRemovalCleanup(txn, member.photo_id, input.at, true);
        if (outcome === 'trashed') creditedBytes += member.measured_bytes;
      }
      // 'still_present' / 'unknown': the reservation releases below; a
      // still-present photo simply stays staged in the cull queue.
      await txn.runAsync('DELETE FROM trash_reservations WHERE photo_id = ?', member.photo_id);
    }

    // Trash cleanup may have emptied the share queue — the open cycle
    // must end with it (N#5) so a later requeue starts a fresh cycle.
    await closeShareCycleIfQueueEmpty(txn, input.at);

    if (creditedBytes > 0) {
      // The launching session's aggregate credits ATOMICALLY with the
      // terminal outcomes — recovery skips terminal batches, so a credit
      // written separately could be lost to a crash in the gap. (Lifetime
      // stats derive from the verified member rows regardless; a batch
      // launched without a session credits no aggregate.)
      await txn.runAsync(
        `UPDATE sessions SET reclaimed_bytes = reclaimed_bytes + ?
         WHERE id = (SELECT launched_from_session_id FROM trash_batches WHERE id = ?)`,
        creditedBytes,
        input.batchId,
      );
    }

    const values = Object.values(outcomes);
    const batchState: ResolveResult['batchState'] =
      input.dialog === 'cancelled'
        ? 'cancelled'
        : input.dialog === 'failed' || input.dialog === 'unsupported'
          ? 'error'
          : values.every((o) => o === 'trashed' || o === 'absent_after_interrupted_launch')
            ? 'verified'
            : 'verified_partial';
    await txn.runAsync(
      'UPDATE trash_batches SET state = ?, verified_at = ? WHERE id = ?',
      batchState,
      input.at,
      input.batchId,
    );
  });

  const values = Object.values(outcomes);
  const batchState: ResolveResult['batchState'] =
    input.dialog === 'cancelled'
      ? 'cancelled'
      : input.dialog === 'failed' || input.dialog === 'unsupported'
        ? 'error'
        : values.every((o) => o === 'trashed' || o === 'absent_after_interrupted_launch')
          ? 'verified'
          : 'verified_partial';
  return { outcomes, creditedBytes, batchState };
}

export interface TrashRecoveryResult {
  /** Interrupted batches found (released or resolved). */
  staleBatches: number;
  /** Photos verified gone during recovery — the caller must reconcile
   * these into any resumed session snapshot, or the stale 'culled' state
   * would be resurrected on restore. */
  trashedIds: string[];
}

/**
 * Startup recovery (P8#3, ninth-review watchlist): `preparing` batches
 * were never dispatched — release them; `launching` batches resolve
 * conservatively via the injected verifier (ambiguous absence is
 * uncredited).
 */
export async function recoverTrashBatches(
  db: SQLiteDatabase,
  verify: (photoId: string) => Promise<PresenceCheck>,
  at: number,
): Promise<TrashRecoveryResult> {
  const stale = await db.getAllAsync<{ id: number; state: string }>(
    "SELECT id, state FROM trash_batches WHERE state IN ('preparing', 'launching')",
  );
  const trashedIds: string[] = [];
  for (const batch of stale) {
    if (batch.state === 'preparing') {
      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync('DELETE FROM trash_reservations WHERE batch_id = ?', batch.id);
        await txn.runAsync("UPDATE trash_batches SET state = 'cancelled' WHERE id = ?", batch.id);
      });
    } else {
      const resolved = await resolveTrashBatch(db, {
        batchId: batch.id,
        verify,
        dialog: 'applied',
        interrupted: true,
        at,
      });
      for (const [photoId, outcome] of Object.entries(resolved.outcomes)) {
        if (outcome === 'trashed' || outcome === 'absent_after_interrupted_launch') {
          trashedIds.push(photoId);
        }
      }
    }
  }
  return { staleBatches: stale.length, trashedIds };
}

/** Lifetime reclaimed bytes = the sum of verified member rows. (The v7
 * legacy-aggregate term returns with the post-v1 upgrade story; pre-v1
 * databases start fresh.) */
export async function lifetimeReclaimedBytes(db: SQLiteDatabase): Promise<number> {
  const verified = await db.getFirstAsync<{ total: number | null }>(
    "SELECT SUM(measured_bytes) AS total FROM trash_batch_members WHERE outcome = 'trashed'",
  );
  return verified?.total ?? 0;
}

/** Restore support (P8#4): when the session loader sees a 'trashed'-state
 * photo in a MediaStore page (proof of a Gallery restore), this increments
 * the generation exactly once so a later verified re-trash counts again. */
export async function markPhotoRestored(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos SET state = 'unreviewed', is_present = 1,
       trash_generation = trash_generation + 1, activity_at = ?
     WHERE asset_id = ? AND state = 'trashed'`,
    at,
    photoId,
  );
}
