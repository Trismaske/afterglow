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
  await db.withExclusiveTransactionAsync(async (txn) => {
    const photo = await txn.getFirstAsync<{ is_present: number }>(
      'SELECT is_present FROM photos WHERE asset_id = ?',
      photoId,
    );
    if (!photo || photo.is_present !== 1) return;
    const existing = await txn.getFirstAsync<{ photo_id: string }>(
      'SELECT photo_id FROM share_queue WHERE photo_id = ?',
      photoId,
    );
    if (existing) return;
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
      'INSERT INTO share_queue (photo_id, cycle_id, queued_at) VALUES (?, ?, ?)',
      photoId,
      cycleId,
      at,
    );
    await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
    added = true;
  });
  return added;
}

/** End the open cycle when the queue just became empty (N#5) — shared by
 * every queue-emptying path; also exported for the trash-cleanup path. */
export async function closeShareCycleIfQueueEmpty(db: SQLiteDatabase, at: number): Promise<void> {
  await db.runAsync(
    `UPDATE share_cycles SET ended_at = ? WHERE ended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM share_queue)`,
    at,
  );
}

export async function removeFromShareQueue(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM share_queue WHERE photo_id = ?', photoId);
    await closeShareCycleIfQueueEmpty(txn, at);
  });
}

/** Whether a photo is currently queued (deck button state). */
export async function isInShareQueue(db: SQLiteDatabase, photoId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ photo_id: string }>(
    'SELECT photo_id FROM share_queue WHERE photo_id = ?',
    photoId,
  );
  return row !== null;
}

/** The queue with per-photo pass counts, chronological. Missing-media rows
 * (is_present = 0) are dropped from the live queue (C#7). */
export async function getShareQueue(
  db: SQLiteDatabase,
  at: number = Date.now(),
): Promise<ShareQueueRow[]> {
  // One transaction: deleting the final missing-media row and closing
  // the emptied cycle must land together, or a crash in between would
  // leave the old cycle open for a later requeue to inherit its badges.
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      'DELETE FROM share_queue WHERE photo_id IN (SELECT asset_id FROM photos WHERE is_present = 0)',
    );
    await closeShareCycleIfQueueEmpty(txn, at);
  });
  return db.getAllAsync<ShareQueueRow>(
    `SELECT q.photo_id, p.uri, p.taken_at, p.day, q.queued_at,
       (SELECT COUNT(*) FROM share_batch_members m
          JOIN share_batches b ON b.id = m.batch_id
        WHERE m.photo_id = q.photo_id
          AND b.cycle_id = q.cycle_id
          AND b.state = 'sheet_opened') AS pass_count
     FROM share_queue q JOIN photos p ON p.asset_id = q.photo_id
     ORDER BY p.taken_at ASC`,
  );
}

/** Insert the `launching` batch BEFORE dispatch (C#10). */
export async function createShareBatch(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  at: number,
): Promise<number> {
  let batchId = -1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const cycle = await txn.getFirstAsync<{ cycle_id: number }>(
      'SELECT cycle_id FROM share_queue WHERE photo_id = ? LIMIT 1',
      photoIds[0],
    );
    if (!cycle) throw new Error('createShareBatch: photos are not queued');
    const batch = await txn.runAsync(
      `INSERT INTO share_batches (cycle_id, attempted_at, state)
       VALUES (?, ?, 'launching')`,
      cycle.cycle_id,
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

/** Dispatch confirmed: promote to sheet_opened durably (C#10). */
export async function promoteShareBatch(
  db: SQLiteDatabase,
  batchId: number,
  at: number,
): Promise<void> {
  await db.runAsync(
    "UPDATE share_batches SET state = 'sheet_opened', opened_at = ? WHERE id = ? AND state = 'launching'",
    at,
    batchId,
  );
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
export async function countNeverShared(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM share_queue q
     WHERE NOT EXISTS (
       SELECT 1 FROM share_batch_members m
         JOIN share_batches b ON b.id = m.batch_id
       WHERE m.photo_id = q.photo_id AND b.cycle_id = q.cycle_id
         AND b.state = 'sheet_opened'
     )`,
  );
  return row?.n ?? 0;
}

/** Explicit clear: empties the queue and ends the cycle. Share batches are
 * kept for History (R#7) — clearing never erases events. */
export async function clearShareQueue(
  db: SQLiteDatabase,
  at: number,
): Promise<ClearShareQueueResult> {
  const neverShared = await countNeverShared(db);
  let cleared = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = await txn.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM share_queue');
    cleared = row?.n ?? 0;
    await txn.runAsync('DELETE FROM share_queue');
    await txn.runAsync('UPDATE share_cycles SET ended_at = ? WHERE ended_at IS NULL', at);
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
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM share_queue');
  return row?.n ?? 0;
}

export { ensureOpenCycle as _testOnlyEnsureOpenCycle };
