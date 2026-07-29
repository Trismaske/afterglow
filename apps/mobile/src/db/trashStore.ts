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
import { withWriteTransaction } from './database';
import { closeShareCycleIfQueueEmpty } from './shareStore';
// Runtime-only circular edge (store also imports a trashStore helper):
// both are plain function refs resolved at call time — safe under ESM.
import { chunk, IN_CHUNK, repairGroupMembership } from './store';

/** Conservative app cap per MediaStore consent request (P5#4; platform
 * limit is 2000 — autonomous: 500, matching the SQL chunk size). */
export const TRASH_BATCH_LIMIT = 500;

export type TrashOutcome =
  'pending' | 'trashed' | 'absent_after_interrupted_launch' | 'still_present' | 'unknown';

export interface PreparedTrashBatch {
  batchId: number;
  members: { photoId: string; contentUri: string | null; measuredBytes: number }[];
  /** Best stars cleared by the stage-and-reserve transition (edited-copy
   * culls) — a DEFINITIVE non-application restores them with the
   * un-staging (a cancelled sheet must be a true no-op). */
  clearedStars: { groupId: number; photoId: string }[];
}

export interface TrashMemberInput {
  photoId: string;
  measuredBytes: number;
}

export interface PrepareTrashBatchOptions {
  /** Edited-copy cull (Home): members still WAITING IN THE EDIT QUEUE are
   * staged to 'culled' in the SAME transaction as the reservation, so no
   * crash window can leave a staged-but-unreserved photo behind, and
   * their edit is RESOLVED in that transaction too — the editor already
   * produced the copy, so the edit is done whatever happens to the
   * original next. A non-trashed outcome reverts the verdict via
   * unstageCullDirect; the photo comes back kept with its edit finished
   * rather than still queued, which is the truth of what happened. */
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
  at: number,
  options: PrepareTrashBatchOptions = {},
): Promise<PreparedTrashBatch | null> {
  let result: PreparedTrashBatch | null = null;
  await withWriteTransaction(db, async (txn) => {
    const reserved = await txn.getAllAsync<{ photo_id: string }>(
      'SELECT photo_id FROM trash_reservations',
    );
    const taken = new Set(reserved.map((r) => r.photo_id));
    const eligible = members.filter((m) => !taken.has(m.photoId)).slice(0, TRASH_BATCH_LIMIT);
    if (eligible.length === 0) return;
    const clearedStars: { groupId: number; photoId: string }[] = [];
    if (options.stageToEditMembers) {
      for (const member of eligible) {
        const staged = await txn.runAsync(
          `UPDATE photos SET state = 'culled', culled_at = COALESCE(culled_at, ?),
             -- A staged cull is a VERDICT, and this path can reach an
             -- unreviewed photo (flagging to edit does not decide) — so
             -- it stamps like every other verdict write: reviewed_at
             -- first-stamps, decided_at re-stamps.
             reviewed_at = COALESCE(reviewed_at, ?), decided_at = ?, activity_at = ?
           WHERE asset_id = ? AND state IN ('unreviewed', 'kept')
             AND EXISTS (SELECT 1 FROM photo_actions pa
                          WHERE pa.photo_id = photos.asset_id AND pa.kind = 'edit'
                            AND pa.state IN ('queued', 'error'))`,
          at,
          at,
          at,
          at,
          member.photoId,
        );
        // The edit COMPLETED the moment the editor wrote the copy — that
        // is the whole reason this prompt exists — so record it here,
        // inside the same transaction, right after the guard has
        // confirmed the photo was still in the queue. Order matters: do
        // it earlier and the guard finds no queued edit and stages
        // nothing; do it later and the verified-removal cleanup has
        // already deleted the unresolved row, so an edit you really did
        // would count for nothing. The Keep-original branch of the same
        // prompt records it too, so it counts exactly once either way.
        if (Number(staged.changes) > 0) {
          await txn.runAsync(
            `UPDATE photo_actions
                SET state = 'applied', resolved_at = ?
              WHERE photo_id = ? AND kind = 'edit' AND state IN ('queued', 'error')`,
            at,
            member.photoId,
          );
        }
        // A stale prompt whose original left the edit queue stages NOTHING —
        // clearing its star anyway would lose it silently (the empty
        // batch returns null and Home never sees clearedStars).
        if (Number(staged.changes) === 0) continue;
        // Every transition to 'culled' clears a star pointing at the
        // photo (same hygiene as applyReviewDecisions): if the attempt
        // stays ambiguous the photo remains staged, and a culled best
        // would freeze its group. Record what was cleared — a DEFINITIVE
        // cancellation restores it with the un-staging.
        const starred = await txn.getAllAsync<{ id: number }>(
          'SELECT id FROM photo_groups WHERE best_photo_id = ?',
          member.photoId,
        );
        for (const group of starred) {
          clearedStars.push({ groupId: Number(group.id), photoId: member.photoId });
        }
        await txn.runAsync(
          'UPDATE photo_groups SET best_photo_id = NULL WHERE best_photo_id = ?',
          member.photoId,
        );
      }
    }
    const batch = await txn.runAsync(
      `INSERT INTO trash_batches (state, created_at) VALUES ('preparing', ?)`,
      at,
    );
    const batchId = Number(batch.lastInsertRowId);
    const out: PreparedTrashBatch = { batchId, members: [], clearedStars };
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
 * transaction: the verdict converges to trashed, presence drops, every
 * OUTSTANDING pending action leaves its queue (queued AND error — the
 * queue views include 'error', so a later Gallery restore must not
 * resurrect a stale favourite/organize intent), and any pending
 * edited-copy match where this photo is the ORIGINAL resolves — a
 * removed original can never be re-prompted, and a stale pending match
 * would block detection for it after a Gallery restore. Shared by
 * verified trash outcomes and external-removal reconciliation.
 *
 * v18: the four action queues leave on the same terms `unqueueAction`
 * uses — work that never happened is forgotten, work that DID happen
 * keeps its `resolved_at` proof, because the base rates and turnaround
 * stats are computed over exactly that. Removing the photo is not
 * forgetting that it was once favourited.
 *
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
    `UPDATE photos SET state = 'trashed', is_present = 0,
       culled_at = CASE WHEN ? = 1 THEN COALESCE(culled_at, ?) ELSE culled_at END,
       activity_at = ?
     WHERE asset_id = ?`,
    markCulled ? 1 : 0,
    at,
    at,
    photoId,
  );
  await txn.runAsync(
    `DELETE FROM photo_actions
      WHERE photo_id = ? AND state IN ('queued', 'error') AND resolved_at IS NULL`,
    photoId,
  );
  await txn.runAsync(
    `UPDATE photo_actions SET state = 'applied', target = NULL
      WHERE photo_id = ? AND state IN ('queued', 'error') AND resolved_at IS NOT NULL`,
    photoId,
  );
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
 * restored from system trash re-enters via the scan/reconciliation restore
 * reconciliation as usual.
 */
/** The distinct groups the given photos currently belong to — the repair
 * scope for removal/trash paths. */
async function groupsOfPhotos(txn: SQLiteDatabase, photoIds: readonly string[]): Promise<number[]> {
  const out = new Set<number>();
  for (const ids of chunk(photoIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const rows = await txn.getAllAsync<{ group_id: number }>(
      `SELECT DISTINCT group_id FROM photo_group_assignments
       WHERE photo_id IN (${ids.map(() => '?').join(',')}) AND group_id IS NOT NULL`,
      ...ids,
    );
    for (const row of rows) out.add(Number(row.group_id));
  }
  return [...out];
}

export async function reconcileExternallyRemoved(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  at: number,
): Promise<void> {
  if (photoIds.length === 0) return;
  await withWriteTransaction(db, async (txn) => {
    // The groups these photos sit in, read BEFORE cleanup (m0.8.1 scope:
    // the whole-table repair costs ~12 ms even as a no-op).
    const affected = await groupsOfPhotos(txn, photoIds);
    for (const id of photoIds) await applyRemovalCleanup(txn, id, at, false);
    // A removal can leave a group with one present member — dissolve it
    // in the same transaction so the deck never receives a 1-photo group.
    await repairGroupMembership(txn, affected);
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
  await withWriteTransaction(db, async (txn) => {
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

    // Verified removals can leave 1-present-member groups — dissolve them
    // with the outcomes (same transaction), scoped to their groups.
    await repairGroupMembership(
      txn,
      await groupsOfPhotos(
        txn,
        members.map((m) => m.photo_id),
      ),
    );
    // Trash cleanup may have emptied the share queue — the open cycle
    // must end with it (N#5) so a later requeue starts a fresh cycle.
    await closeShareCycleIfQueueEmpty(txn, input.at);

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
   * these into the durable rows the screens read, or the stale 'culled' state
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
      await withWriteTransaction(db, async (txn) => {
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

/** Restore support (P8#4): when a scan/loader sees a 'trashed'-state
 * photo in a MediaStore page (proof of a Gallery restore), this increments
 * the generation exactly once so a later verified re-trash counts again.
 * The edit-detection baseline resets too: a restored photo starts over,
 * and a re-queued edit must not compare against a pre-trash baseline/hash.
 * (Its pending actions left when it was trashed — applyRemovalCleanup —
 * so there is no queue membership to undo here.) */
export async function markPhotoRestored(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos SET state = 'unreviewed', is_present = 1,
       trash_generation = trash_generation + 1,
       mod_time = NULL, content_hash = NULL,
       activity_at = ?
     WHERE asset_id = ? AND state = 'trashed'`,
    at,
    photoId,
  );
}
