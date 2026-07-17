/**
 * Persistence operations over the schema in database.ts.
 * All multi-statement writes run in exclusive transactions.
 *
 * State machine (PLAN.md, m0.2): SQLite `photos.state` is the source of
 * truth and everything converges on 'done':
 *
 *   unreviewed ──review──┬─▶ culled ─▶ (system delete) ─▶ trashed
 *                        └─▶ kept ──┬─▶ to_edit ─▶ done
 *                                   └─(session finish)─▶ done
 *
 * 'kept' + needs_edit = 1 is stored as 'to_edit' — the CASE expressions
 * below keep that invariant no matter which path writes the state.
 * 'confirmed' is deliberately never persisted (m0.1 decision: SQLite keeps
 * 'culled' until the system delete succeeds).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DuelRecord, PhotoState } from '@afterglow/core';
import type { LoadedPhoto } from '../lib/media';

/** Max ids per IN (...) chunk — stays under SQLite's bind-parameter limit. */
const IN_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

export interface SessionRow {
  id: number;
  label: string;
  range_start: number;
  range_end: number;
  snapshot: string;
  reclaimed_bytes: number;
  created_at: number;
  completed_at: number | null;
}

/** The most recent unfinished session, if any (one active at a time). */
export async function getActiveSession(db: SQLiteDatabase): Promise<SessionRow | null> {
  return db.getFirstAsync<SessionRow>(
    'SELECT * FROM sessions WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
}

/** Mark every unfinished session as ended (used when starting fresh). */
export async function abandonActiveSessions(db: SQLiteDatabase, at: number): Promise<void> {
  await db.runAsync('UPDATE sessions SET completed_at = ? WHERE completed_at IS NULL', at);
}

export interface NewSessionInput {
  label: string;
  rangeStart: number;
  rangeEnd: number;
  snapshot: string;
  photos: readonly (LoadedPhoto & { groupId: string | null; day: string })[];
  createdAt: number;
}

/** Create a session and upsert its photo rows. Returns the session id. */
export async function createSession(db: SQLiteDatabase, input: NewSessionInput): Promise<number> {
  let sessionId = -1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync(
      `INSERT INTO sessions (label, range_start, range_end, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.label,
      input.rangeStart,
      input.rangeEnd,
      input.snapshot,
      input.createdAt,
    );
    sessionId = Number(result.lastInsertRowId);
    for (const photo of input.photos) {
      await txn.runAsync(
        `INSERT INTO photos (asset_id, uri, taken_at, state, group_id, session_day, mod_time, day, needs_edit)
         VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?, 0)
         ON CONFLICT(asset_id) DO UPDATE SET
           uri = excluded.uri,
           state = 'unreviewed',
           group_id = excluded.group_id,
           session_day = excluded.session_day,
           mod_time = excluded.mod_time,
           day = excluded.day,
           needs_edit = 0`,
        photo.item.id,
        photo.item.uri,
        photo.item.timestamp,
        photo.groupId,
        input.label,
        photo.modTime,
        photo.day,
      );
    }
  });
  return sessionId;
}

/**
 * Persist one review decision atomically: the new session snapshot, the
 * photo states that changed, and (for duels) the duel record.
 *
 * Core only knows 'kept'; the CASE maps kept + needs_edit → 'to_edit' so
 * the edit flag survives every state write (duel keeps, bracket completion,
 * un-culling). A row entering to_edit records `to_edit_at` (first entry
 * wins) — the scan window for m0.3 edited-copy detection.
 */
export async function persistDecision(
  db: SQLiteDatabase,
  sessionId: number,
  snapshot: string,
  changedStates: readonly [assetId: string, state: PhotoState][],
  at: number,
  duel?: DuelRecord,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('UPDATE sessions SET snapshot = ? WHERE id = ?', snapshot, sessionId);
    for (const [assetId, state] of changedStates) {
      await txn.runAsync(
        `UPDATE photos
         SET state = CASE WHEN ? = 'kept' AND needs_edit = 1 THEN 'to_edit' ELSE ? END,
             to_edit_at = CASE
               WHEN ? = 'kept' AND needs_edit = 1 AND to_edit_at IS NULL THEN ?
               ELSE to_edit_at
             END
         WHERE asset_id = ?`,
        state,
        state,
        state,
        at,
        assetId,
      );
    }
    if (duel) {
      await txn.runAsync(
        `INSERT INTO duels (session_id, group_id, winner_id, loser_id, kept_both, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        duel.groupId,
        duel.winnerId,
        duel.loserId,
        duel.keptBoth ? 1 : 0,
        duel.at,
      );
    }
  });
}

/**
 * Set/clear the "this keeper needs editing" flag. If the photo has already
 * converged to kept/to_edit, its state is remapped immediately; otherwise
 * the flag applies when the state next becomes 'kept' (see persistDecision).
 * Entering to_edit records `to_edit_at` (first entry wins).
 */
export async function setNeedsEdit(
  db: SQLiteDatabase,
  assetId: string,
  needsEdit: boolean,
  at: number,
): Promise<void> {
  const flag = needsEdit ? 1 : 0;
  await db.runAsync(
    `UPDATE photos
     SET needs_edit = ?,
         state = CASE
           WHEN ? = 1 AND state = 'kept' THEN 'to_edit'
           WHEN ? = 0 AND state = 'to_edit' THEN 'kept'
           ELSE state
         END,
         to_edit_at = CASE
           WHEN ? = 1 AND state = 'kept' AND to_edit_at IS NULL THEN ?
           ELSE to_edit_at
         END
     WHERE asset_id = ?`,
    flag,
    flag,
    flag,
    flag,
    at,
    assetId,
  );
}

/** Manual "mark done" from the edit queue: to_edit → done. */
export async function markEditDone(db: SQLiteDatabase, assetId: string): Promise<void> {
  await db.runAsync(
    "UPDATE photos SET state = 'done', needs_edit = 0 WHERE asset_id = ? AND state = 'to_edit'",
    assetId,
  );
}

/**
 * Converge a finished session's keepers: every given photo still 'kept'
 * becomes 'done' ('to_edit' rows are left for the edit queue).
 */
export async function markKeptDone(db: SQLiteDatabase, assetIds: readonly string[]): Promise<void> {
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE photos SET state = 'done' WHERE state = 'kept' AND asset_id IN (${placeholders})`,
      ...ids,
    );
  }
}

/** Current stored state per asset id (missing rows are simply absent). */
export async function getStatesForAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, PhotoState>> {
  const states = new Map<string, PhotoState>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; state: PhotoState }>(
      `SELECT asset_id, state FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) states.set(row.asset_id, row.state);
  }
  return states;
}

/** Which of the given assets currently carry the needs-edit flag. */
export async function getNeedsEditAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Set<string>> {
  const flagged = new Set<string>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string }>(
      `SELECT asset_id FROM photos WHERE needs_edit = 1 AND asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) flagged.add(row.asset_id);
  }
  return flagged;
}

export interface ToEditRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  day: string | null;
}

/** The to-edit queue: every photo flagged for editing, newest first. */
export async function getToEditPhotos(db: SQLiteDatabase): Promise<ToEditRow[]> {
  return db.getAllAsync<ToEditRow>(
    "SELECT asset_id, uri, taken_at, day FROM photos WHERE state = 'to_edit' ORDER BY taken_at DESC",
  );
}

/** Everything edit detection needs about the to-edit queue (m0.3). */
export interface EditDetectionRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  mod_time: number | null;
  content_hash: string | null;
  to_edit_at: number | null;
}

export async function getEditDetectionRows(db: SQLiteDatabase): Promise<EditDetectionRow[]> {
  return db.getAllAsync<EditDetectionRow>(
    `SELECT asset_id, uri, taken_at, mod_time, content_hash, to_edit_at
     FROM photos WHERE state = 'to_edit'`,
  );
}

/**
 * Refresh the stored modification-time baseline after a metadata-only
 * change (mod time moved but the content hash matched) so the same photo
 * isn't re-checked on every detection run.
 */
export async function updateModTimeBaseline(
  db: SQLiteDatabase,
  assetId: string,
  modTime: number,
): Promise<void> {
  await db.runAsync('UPDATE photos SET mod_time = ? WHERE asset_id = ?', modTime, assetId);
}

/**
 * Track a detected edited copy as already-done. INSERT OR IGNORE: if the
 * asset is somehow already tracked, its existing state wins.
 */
export async function insertDetectedCopy(
  db: SQLiteDatabase,
  copy: { assetId: string; uri: string; takenAt: number; modTime: number; day: string },
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO photos (asset_id, uri, taken_at, state, mod_time, day, needs_edit)
     VALUES (?, ?, ?, 'done', ?, ?, 0)`,
    copy.assetId,
    copy.uri,
    copy.takenAt,
    copy.modTime,
    copy.day,
  );
}

/**
 * Record an out-of-session deletion (the "cull the original" path after an
 * edited copy was detected). Only ever called after the system delete
 * dialog succeeded.
 */
export async function markTrashedDirect(db: SQLiteDatabase, assetId: string): Promise<void> {
  await db.runAsync(
    "UPDATE photos SET state = 'trashed', needs_edit = 0 WHERE asset_id = ?",
    assetId,
  );
}

/** Number of photos waiting in the to-edit queue. */
export async function countToEdit(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM photos WHERE state = 'to_edit'",
  );
  return row?.n ?? 0;
}

/** Per-state counts for one local day, split by cull-group membership. */
export interface DayStateCounts {
  /** Rows in the DB for this day, by state. */
  unreviewedGrouped: number;
  unreviewedSingle: number;
  kept: number;
  toEdit: number;
  staged: number;
  trashed: number;
  done: number;
  /** All rows for the day (sum of the above + any transient states). */
  tracked: number;
}

export async function getDayStateCounts(db: SQLiteDatabase, day: string): Promise<DayStateCounts> {
  const rows = await db.getAllAsync<{ state: PhotoState; grouped: number; n: number }>(
    `SELECT state, (group_id IS NOT NULL) AS grouped, COUNT(*) AS n
     FROM photos WHERE day = ? GROUP BY state, grouped`,
    day,
  );
  const counts: DayStateCounts = {
    unreviewedGrouped: 0,
    unreviewedSingle: 0,
    kept: 0,
    toEdit: 0,
    staged: 0,
    trashed: 0,
    done: 0,
    tracked: 0,
  };
  for (const row of rows) {
    counts.tracked += row.n;
    switch (row.state) {
      case 'unreviewed':
        if (row.grouped) counts.unreviewedGrouped += row.n;
        else counts.unreviewedSingle += row.n;
        break;
      case 'kept':
        counts.kept += row.n;
        break;
      case 'to_edit':
        counts.toEdit += row.n;
        break;
      case 'culled':
      case 'confirmed': // never persisted by design, but count it as staged
        counts.staged += row.n;
        break;
      case 'trashed':
        counts.trashed += row.n;
        break;
      case 'done':
        counts.done += row.n;
        break;
    }
  }
  return counts;
}

export interface DaySummaryRow {
  day: string;
  tracked: number;
  done: number; // done + trashed (both are converged)
  trashed: number; // subset of `done`; gone from MediaStore
  toEdit: number;
  staged: number;
}

/** Per-day rollups for every day >= sinceDay that has tracked photos. */
export async function getDaySummaries(
  db: SQLiteDatabase,
  sinceDay: string,
): Promise<Map<string, DaySummaryRow>> {
  const rows = await db.getAllAsync<DaySummaryRow>(
    `SELECT day,
            COUNT(*) AS tracked,
            SUM(CASE WHEN state IN ('done', 'trashed') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
            SUM(CASE WHEN state = 'to_edit' THEN 1 ELSE 0 END) AS toEdit,
            SUM(CASE WHEN state IN ('culled', 'confirmed') THEN 1 ELSE 0 END) AS staged
     FROM photos WHERE day IS NOT NULL AND day >= ?
     GROUP BY day`,
    sinceDay,
  );
  return new Map(rows.map((r) => [r.day, r]));
}

/** Record bytes reclaimed by the confirmed delete batch. */
export async function addReclaimedBytes(
  db: SQLiteDatabase,
  sessionId: number,
  bytes: number,
): Promise<void> {
  await db.runAsync(
    'UPDATE sessions SET reclaimed_bytes = reclaimed_bytes + ? WHERE id = ?',
    bytes,
    sessionId,
  );
}

/** Mark the session finished (the user pressed Finish — feeds the streak). */
export async function completeSession(
  db: SQLiteDatabase,
  sessionId: number,
  at: number,
): Promise<void> {
  await db.runAsync(
    'UPDATE sessions SET completed_at = ?, finished = 1 WHERE id = ?',
    at,
    sessionId,
  );
}

/**
 * Local days ("YYYY-MM-DD") with at least one *finished* session, newest
 * first — abandoned sessions don't count. Feeds the review streak.
 */
export async function getFinishedSessionDays(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ day: string }>(
    `SELECT DISTINCT date(completed_at / 1000, 'unixepoch', 'localtime') AS day
     FROM sessions WHERE finished = 1 AND completed_at IS NOT NULL
     ORDER BY day DESC`,
  );
  return rows.map((r) => r.day);
}

/** Total bytes reclaimed across every session, ever. */
export async function getAllTimeReclaimedBytes(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number | null }>(
    'SELECT SUM(reclaimed_bytes) AS n FROM sessions',
  );
  return row?.n ?? 0;
}

/** Store a lazily computed content hash (fallback identity). */
export async function setContentHash(
  db: SQLiteDatabase,
  assetId: string,
  hash: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE photos SET content_hash = ? WHERE asset_id = ? AND content_hash IS NULL',
    hash,
    assetId,
  );
}
