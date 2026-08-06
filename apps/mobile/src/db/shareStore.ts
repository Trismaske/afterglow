/**
 * Multi-pass share queue (m0.7 item E: R#7, N#5, C#10). The queue is a
 * persistent working set; each share is a recorded PASS over a chosen
 * subset. Nothing claims delivery — Android reports only that a sheet was
 * dispatched — so states are `launching → sheet_opened | error` and copy
 * says "share sheet opened", never "shared".
 *
 * Cycle identity is explicit (N#5): a monotonic cycle row is minted when
 * the queue goes empty → non-empty, and ANY transition back to empty ends
 * it — explicit clear, removing the last row, or missing-media/trash
 * cleanup — so a requeued photo always starts a fresh cycle with zero
 * passes. A ✓ pass-count badge counts only same-cycle `sheet_opened`
 * batches containing the photo, so failed launches never badge (C#10) and
 * History keeps batches attached to their original cycle after a clear.
 *
 * At-most-once accounting (C#10): the batch row is inserted as `launching`
 * BEFORE dispatch; the native module reports successful dispatch
 * separately from the sheet's lifetime, and the row is promoted
 * immediately after. A `launching` row found at startup reconciles to
 * `error` — deliberately undercounting a pass lost in the crash window
 * rather than ever fabricating one.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withWriteTransaction } from './database';
import { leaveQueue, livePhotoClause, reachExists } from './actions';
import { chunk, IN_CHUNK } from './store';

/** Soft warning threshold — many receivers degrade above this (R#7). */
export const SHARE_SOFT_WARN_COUNT = 50;

export interface ShareQueueRow {
  photo_id: string;
  uri: string;
  taken_at: number;
  day: string | null;
  queued_at: number;
  /** Same-cycle sheet_opened passes that included this photo. */
  pass_count: number;
}

/** The open cycle id, minting one if the queue is empty/new (N#5). */
async function ensureOpenCycle(db: SQLiteDatabase, at: number): Promise<number> {
  const open = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM share_cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
  );
  if (open) return open.id;
  const minted = await db.runAsync('INSERT INTO share_cycles (started_at) VALUES (?)', at);
  return Number(minted.lastInsertRowId);
}

/** Queue a photo (dedup by PK; re-queueing is a no-op returning false).
 * Only present photos may enter a live queue (C#7). */
export async function addToShareQueue(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<boolean> {
  let added = false;
  await withWriteTransaction(db, async (txn) => {
    const photo = await txn.getFirstAsync<{ is_present: number }>(
      'SELECT is_present FROM photos WHERE asset_id = ?',
      photoId,
    );
    if (!photo || photo.is_present !== 1) return;
    const existing = await txn.getFirstAsync<{ photo_id: string }>(
      `SELECT photo_id FROM photo_actions WHERE kind = 'share' AND state IN ('queued', 'error') AND photo_id = ?`,
      photoId,
    );
    if (existing) return;
    // A cycle only carries across a NON-EMPTY LIVE queue. Culling the
    // last live shared photo empties the visible queue without any share
    // code running (verdict writes never touch this module), so a stale
    // open cycle can linger — close it before choosing one, or the next
    // queued photo inherits the old cycle's pass history instead of
    // starting a fresh empty→non-empty cycle (codex r4).
    await txn.runAsync(
      `UPDATE share_cycles SET ended_at = ? WHERE ended_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM photo_actions
                          WHERE kind = 'share' AND state IN ('queued', 'error')
                            AND ${livePhotoClause('photo_actions.photo_id')})`,
      at,
    );
    const open = await txn.getFirstAsync<{ id: number }>(
      'SELECT id FROM share_cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
    );
    const cycleId =
      open?.id ??
      Number(
        (await txn.runAsync('INSERT INTO share_cycles (started_at) VALUES (?)', at))
          .lastInsertRowId,
      );
    await txn.runAsync(
      `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
       VALUES (?, 'share', 'queued', ?)
       ON CONFLICT(photo_id, kind) DO UPDATE SET state = 'queued', queued_at = excluded.queued_at`,
      photoId,
      at,
    );
    // The open cycle is created on first queue and closed on clear; the
    // queue row no longer repeats it (v18).
    void cycleId;
    await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
    added = true;
  });
  return added;
}

/** End the open cycle when the queue just became empty (N#5) — shared by
 * every queue-emptying path; also exported for the trash-cleanup path.
 * LIVE rows only: a staged cull's retained action is not queue
 * membership (STATE_MODEL.md) and must not hold a cycle open. */
export async function closeShareCycleIfQueueEmpty(db: SQLiteDatabase, at: number): Promise<void> {
  await db.runAsync(
    `UPDATE share_cycles SET ended_at = ? WHERE ended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM photo_actions
                        WHERE kind = 'share' AND state IN ('queued', 'error')
                          AND ${livePhotoClause('photo_actions.photo_id')})`,
    at,
  );
}

export async function removeFromShareQueue(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    await leaveQueue(txn, photoId, 'share');
    await closeShareCycleIfQueueEmpty(txn, at);
  });
}

/** Whether a photo is currently queued (deck button state). */
export async function isInShareQueue(db: SQLiteDatabase, photoId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ photo_id: string }>(
    `SELECT photo_id FROM photo_actions WHERE kind = 'share' AND state IN ('queued', 'error') AND photo_id = ?`,
    photoId,
  );
  return row !== null;
}

/** The queue with per-photo pass counts, chronological. Missing-media rows
 * (is_present = 0) are dropped from the live queue (C#7). */
export async function getShareQueue(
  db: SQLiteDatabase,
  at: number = Date.now(),
  mounted: readonly string[] | null = null,
): Promise<ShareQueueRow[]> {
  // One transaction: deleting the final missing-media row and closing
  // the emptied cycle must land together, or a crash in between would
  // leave the old cycle open for a later requeue to inherit its badges.
  await withWriteTransaction(db, async (txn) => {
    // Missing media leaves the queue on the SAME two terms as every
    // other exit: forget what never went out, keep the record of what
    // did. Demoting matters here too — a row left at 'queued' on an
    // absent photo would hold its cycle open forever.
    await txn.runAsync(
      `DELETE FROM photo_actions WHERE kind = 'share' AND resolved_at IS NULL
         AND photo_id IN (SELECT asset_id FROM photos WHERE is_present = 0)`,
    );
    await txn.runAsync(
      `UPDATE photo_actions SET state = 'applied', target = NULL
        WHERE kind = 'share' AND state IN ('queued', 'error') AND resolved_at IS NOT NULL
          AND photo_id IN (SELECT asset_id FROM photos WHERE is_present = 0)`,
    );
    await closeShareCycleIfQueueEmpty(txn, at);
  });
  // m0.8.3 §5: an unmounted volume's queued shares wait for remount —
  // the rows survive; only the list hides them.
  const reach = reachExists(mounted, 'q.photo_id');
  return db.getAllAsync<ShareQueueRow>(
    `SELECT q.photo_id, p.uri, p.taken_at, p.day, q.queued_at,
       (SELECT COUNT(*) FROM share_batch_members m
          JOIN share_batches b ON b.id = m.batch_id
        WHERE m.photo_id = q.photo_id
          AND b.cycle_id = (SELECT id FROM share_cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1)
          AND b.state = 'sheet_opened') AS pass_count
     FROM photo_actions q JOIN photos p ON p.asset_id = q.photo_id
     -- v18: the queue is an action row, so the cycle comes from the ONE
     -- open cycle rather than a column repeated on every queued photo.
     WHERE q.kind = 'share' AND q.state IN ('queued', 'error')
       AND ${livePhotoClause('q.photo_id')}${reach.sql}
     ORDER BY p.taken_at ASC`,
    ...reach.params,
  );
}

/** Insert the `launching` batch BEFORE dispatch (C#10). */
export async function createShareBatch(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  at: number,
): Promise<number> {
  let batchId = -1;
  await withWriteTransaction(db, async (txn) => {
    const cycle = await txn.getFirstAsync<{ cycle_id: number }>(
      'SELECT id AS cycle_id FROM share_cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
    );
    // No open cycle with LIVE queued work present is a legal state
    // (codex r9): a staged cull's retained share row becomes live again
    // on un-staging WITHOUT passing through addToShareQueue, and the
    // empty-tab visit in between closed the old cycle. That resurfacing
    // is its own empty→non-empty transition — mint the cycle here.
    const cycleId =
      cycle?.cycle_id ??
      Number(
        (await txn.runAsync('INSERT INTO share_cycles (started_at) VALUES (?)', at))
          .lastInsertRowId,
      );
    const batch = await txn.runAsync(
      `INSERT INTO share_batches (cycle_id, attempted_at, state)
       VALUES (?, ?, 'launching')`,
      cycleId,
      at,
    );
    batchId = Number(batch.lastInsertRowId);
    for (const id of photoIds) {
      await txn.runAsync(
        'INSERT INTO share_batch_members (batch_id, photo_id) VALUES (?, ?)',
        batchId,
        id,
      );
    }
  });
  return batchId;
}

/**
 * Dispatch confirmed: promote to sheet_opened durably (C#10), and stamp
 * the members' share ACTIONS as having happened.
 *
 * Share is the one action whose completion is an event about a BATCH
 * rather than about a photo, so without this its `resolved_at` would
 * stay null forever and every "ever shared" reader — the Habits
 * turnaround row above all — would report that no share has ever
 * finished, on a photo that visibly went out to the sheet.
 *
 * The rows stay QUEUED on purpose: multi-pass sharing is the feature, so
 * a photo that has been sent once is still in the working set for the
 * next pass. `resolved_at` set with `state = 'queued'` is exactly the
 * "applied once, pending again" shape the action model already defines,
 * and COALESCE keeps the FIRST send as the turnaround's start.
 */
export async function promoteShareBatch(
  db: SQLiteDatabase,
  batchId: number,
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    const promoted = await txn.runAsync(
      "UPDATE share_batches SET state = 'sheet_opened', opened_at = ? WHERE id = ? AND state = 'launching'",
      at,
      batchId,
    );
    // Only a batch this call actually promoted may stamp its members: a
    // re-run against an already-opened batch must not move the record.
    if (Number(promoted.changes) === 0) return;
    // The LATEST send, not the first: a photo re-queued into a new cycle
    // moves queued_at forward, and keeping an older resolved_at would
    // leave resolved_at < queued_at — which getQueueTurnaround discards.
    // Within one cycle the passes are minutes apart, so this also makes
    // the badge's "last sent" honest.
    await txn.runAsync(
      `UPDATE photo_actions
          SET resolved_at = ?
        WHERE kind = 'share'
          AND photo_id IN (SELECT photo_id FROM share_batch_members WHERE batch_id = ?)`,
      at,
      batchId,
    );
  });
}

/** Dispatch failed: the attempt earns no badge and no History event. */
export async function failShareBatch(db: SQLiteDatabase, batchId: number): Promise<void> {
  await db.runAsync(
    "UPDATE share_batches SET state = 'error' WHERE id = ? AND state = 'launching'",
    batchId,
  );
}

/** Optional after-the-fact label ("Mum") — the only honest recipient record. */
export async function labelShareBatch(
  db: SQLiteDatabase,
  batchId: number,
  label: string,
): Promise<void> {
  await db.runAsync('UPDATE share_batches SET label = ? WHERE id = ?', label, batchId);
}

/** Recently used labels for the prompt chips. */
export async function recentShareLabels(db: SQLiteDatabase, limit = 6): Promise<string[]> {
  const rows = await db.getAllAsync<{ label: string }>(
    `SELECT label FROM share_batches
     WHERE label IS NOT NULL AND label <> ''
     GROUP BY label ORDER BY MAX(attempted_at) DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => r.label);
}

export interface ClearShareQueueResult {
  cleared: number;
  neverShared: number;
}

/** How many queued photos have zero passes this cycle (clear-confirm copy). */
export async function countNeverShared(
  db: SQLiteDatabase,
  mounted: readonly string[] | null = null,
): Promise<number> {
  const reach = reachExists(mounted, 'q.photo_id');
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photo_actions q
     WHERE q.kind = 'share' AND q.state IN ('queued', 'error')
       AND ${livePhotoClause('q.photo_id')}${reach.sql}
       AND NOT EXISTS (
       SELECT 1 FROM share_batch_members m
         JOIN share_batches b ON b.id = m.batch_id
       WHERE m.photo_id = q.photo_id AND b.cycle_id = (SELECT id FROM share_cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1)
         AND b.state = 'sheet_opened'
     )`,
    ...reach.params,
  );
  return row?.n ?? 0;
}

/** Explicit clear: empties the queue and ends the cycle. Share batches are
 * kept for History (R#7) — clearing never erases events.
 *
 * m0.8.3 §5 (codex phase-3): the clear touches ONLY the rows the screen
 * showed — an unreachable photo's action row survives byte-for-byte and
 * re-lists on remount (it batches into whichever cycle is open then).
 * Such a partial clear leaves the cycle OPEN: the hidden unreachable
 * rows are still queued, and closeShareCycleIfQueueEmpty only ends a
 * cycle when the queue truly empties. */
export async function clearShareQueue(
  db: SQLiteDatabase,
  at: number,
  mounted: readonly string[] | null = null,
  /** The queue rows the confirmation DESCRIBED (final cycle T2): given,
   * the clear touches only these ids — a card remounting while the
   * dialog sat open may shrink the write (reachability), never widen it
   * past what the user confirmed. Omitted = whole reachable queue. */
  displayedIds: readonly string[] | null = null,
): Promise<ClearShareQueueResult> {
  const neverShared = await countNeverShared(db, mounted);
  const reach = reachExists(mounted, 'photo_actions.photo_id');
  // The bound is CHUNKED (final cycle U2): the queue has no size cap,
  // and one IN list per rendered row would hit SQLite's 999-variable
  // compatibility floor around a thousand rows — "Clear queue" must not
  // be the one write that fails at exactly the scale it exists for.
  const boundParts: (readonly string[] | null)[] =
    displayedIds === null ? [null] : chunk(displayedIds, IN_CHUNK);
  let cleared = 0;
  await withWriteTransaction(db, async (txn) => {
    for (const part of boundParts) {
      const bound =
        part === null
          ? { sql: '', params: [] as string[] }
          : {
              sql: ` AND photo_actions.photo_id IN (${part.map(() => '?').join(',')})`,
              params: [...part],
            };
      // LIVE rows only, on BOTH legs — exactly the rows this count reports
      // and the screen showed (Tristan, grilling Q12): a staged cull's
      // hidden retained row SURVIVES the clear, because STATE_MODEL
      // promises un-staging returns a photo to every queue it was in. The
      // old "nothing else would ever remove it" worry is obsolete — the
      // trash-verification cleanup demotes/deletes it when the cull
      // completes, and a resurfaced row mints its own cycle (codex r9).
      const row = await txn.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM photo_actions
          WHERE kind = 'share' AND state IN ('queued', 'error')
            AND ${livePhotoClause('photo_actions.photo_id')}${reach.sql}${bound.sql}`,
        ...reach.params,
        ...bound.params,
      );
      cleared += row?.n ?? 0;
      // BOTH halves, exactly as unqueueAction/clearQueue do it: a row that
      // never went out is forgotten, and one that DID keeps its permanent
      // record while leaving the queue. Without the second statement an
      // already-shared photo stays `state = 'queued'` after a clear, so the
      // queue never reads as empty and the next queue-up silently rejoins
      // the closed cycle instead of starting a new one.
      await txn.runAsync(
        // IN ('queued','error') like clearQueue: an errored-but-never-
        // sent row is still a queue exit, and 'queued' alone would
        // strand it.
        `DELETE FROM photo_actions
          WHERE kind = 'share' AND state IN ('queued', 'error') AND resolved_at IS NULL
            AND ${livePhotoClause('photo_actions.photo_id')}${reach.sql}${bound.sql}`,
        ...reach.params,
        ...bound.params,
      );
      await txn.runAsync(
        `UPDATE photo_actions SET state = 'applied', target = NULL
          WHERE kind = 'share' AND state IN ('queued', 'error') AND resolved_at IS NOT NULL
            AND ${livePhotoClause('photo_actions.photo_id')}${reach.sql}${bound.sql}`,
        ...reach.params,
        ...bound.params,
      );
    }
    // The cycle ends only when the queue is EMPTY (final cycle V2): a
    // reachability-scoped or bounded clear can leave hidden unreachable
    // rows queued, and closing their cycle would zero their pass counts
    // on remount — user actions on the reachable subset must not alter
    // an unreachable row's working state.
    await closeShareCycleIfQueueEmpty(txn, at);
  });
  return { cleared, neverShared };
}

/** Startup recovery (C#10): a `launching` row from a dead process becomes
 * `error` — no badge, no event; the photos can simply be shared again. */
export async function recoverShareBatches(db: SQLiteDatabase): Promise<number> {
  const stale = await db.getAllAsync<{ id: number }>(
    "SELECT id FROM share_batches WHERE state = 'launching'",
  );
  for (const batch of stale) await failShareBatch(db, batch.id);
  return stale.length;
}

export async function countShareQueue(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photo_actions
      WHERE kind = 'share' AND state IN ('queued', 'error')
        AND ${livePhotoClause('photo_actions.photo_id')}`,
  );
  return row?.n ?? 0;
}

export { ensureOpenCycle as _testOnlyEnsureOpenCycle };
