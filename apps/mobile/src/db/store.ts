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
import { sourceLikePattern } from '../lib/sources';
import type { StateCounts } from '../lib/progress';

/** Max ids per IN (...) chunk — stays under SQLite's bind-parameter limit. */
const IN_CHUNK = 500;

/**
 * DB-side photo scope (m0.4 stage 3). Day-keyed queries use the `day`
 * column (matching the Recent-days rollups exactly); everything else
 * scopes by `taken_at` range. Both progress pages share the same store
 * functions through this union.
 */
export type PhotoScope = { day: string } | { startMs: number; endMs: number };

function scopeClause(scope: PhotoScope): { sql: string; params: (string | number)[] } {
  return 'day' in scope
    ? { sql: 'day = ?', params: [scope.day] }
    : { sql: 'taken_at BETWEEN ? AND ?', params: [scope.startMs, scope.endMs] };
}

/**
 * Photo-source roots as an SQL fragment over `photos.uri` (m0.3.1).
 * `roots` null/empty = "All folders" (no filter). The LIKE containment
 * match (`%/<root>/%`, ASCII-case-insensitive by SQLite default) is the
 * DB-side counterpart of the album matching in sources.ts — see its
 * module docs for the accepted looseness.
 */
function sourceClause(roots: readonly string[] | null | undefined): {
  sql: string;
  params: string[];
} {
  if (!roots || roots.length === 0) return { sql: '', params: [] };
  const likes = roots.map(() => "uri LIKE ? ESCAPE '\\'").join(' OR ');
  return { sql: ` AND (${likes})`, params: roots.map(sourceLikePattern) };
}

/** Read one settings value (null when unset). */
export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

/** Upsert one settings value. */
export async function setSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

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

/**
 * Bank an about-to-be-replaced session's keep decisions (m0.5: "starting
 * a new session never discards decisions"). Kept photos converge to done
 * exactly like normal session completion ('to_edit' rows are untouched
 * — the CASE remap already put them there; per-photo states and compare
 * history were persisted after every decision, so nothing else is
 * pending). Staged culls deliberately stay 'culled': they were never
 * confirmed, and per the m0.2 #3 rule a stale delete list must be
 * re-earned, never silently carried or dropped. Reads the persisted
 * snapshot rather than in-memory state so it also covers a session that
 * was never resumed after an app restart. Unparseable snapshots (e.g.
 * bracket-era) are skipped — their SQLite rows are already the durable
 * truth.
 */
export async function bankActiveSessionKeepers(db: SQLiteDatabase): Promise<void> {
  const row = await getActiveSession(db);
  if (!row) return;
  let keptIds: string[];
  try {
    const snap = JSON.parse(row.snapshot) as { states?: Record<string, string> };
    if (typeof snap !== 'object' || snap === null || typeof snap.states !== 'object') return;
    keptIds = Object.entries(snap.states ?? {})
      .filter(([, state]) => state === 'kept')
      .map(([id]) => id);
  } catch {
    return;
  }
  if (keptIds.length > 0) await markKeptDone(db, keptIds);
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

/**
 * "Not related — review as single" (m0.4): the photo left its cull group,
 * so day-progress accounting must stop counting it as "in a group".
 */
export async function clearPhotoGroup(db: SQLiteDatabase, assetId: string): Promise<void> {
  await db.runAsync('UPDATE photos SET group_id = NULL WHERE asset_id = ?', assetId);
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

/**
 * Per-state DB counts for one scope, split by cull-group membership
 * (StateCounts lives in lib/progress.ts — pure, shared with the
 * breakdown math). Replaces m0.2's getDayStateCounts and m0.3.1's
 * countHandledInRange: "handled" = toEdit + done (still in MediaStore;
 * trashed rows are deliberately separate — they left MediaStore, so
 * they are not part of the count this gets subtracted from).
 */
export async function getStateCountsInScope(
  db: SQLiteDatabase,
  scope: PhotoScope,
  roots: readonly string[] | null = null,
): Promise<StateCounts> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ state: PhotoState; grouped: number; n: number }>(
    `SELECT state, (group_id IS NOT NULL) AS grouped, COUNT(*) AS n
     FROM photos WHERE ${where.sql}${src.sql} GROUP BY state, grouped`,
    ...where.params,
    ...src.params,
  );
  const counts: StateCounts = {
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

/** State + group membership per asset (missing rows simply absent). */
export async function getStateRowsForAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, { state: PhotoState; grouped: boolean }>> {
  const out = new Map<string, { state: PhotoState; grouped: boolean }>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; state: PhotoState; grouped: number }>(
      `SELECT asset_id, state, (group_id IS NOT NULL) AS grouped
       FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) out.set(row.asset_id, { state: row.state, grouped: !!row.grouped });
  }
  return out;
}

/** One photo row for the progress grids' DB-backed filters. */
export interface GridPhotoRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  state: PhotoState;
  grouped: number;
}

/** SQL predicate per DB-backed grid filter (see getGridPhotosByFilter). */
const GRID_FILTER_SQL: Record<'in_group' | 'kept' | 'to_edit' | 'staged' | 'done', string> = {
  in_group: "state = 'unreviewed' AND group_id IS NOT NULL",
  kept: "state = 'kept'",
  to_edit: "state = 'to_edit'",
  staged: "state IN ('culled', 'confirmed')",
  // 'trashed' rows also count as done in the summaries, but their files
  // are gone — no thumbnail to show, so the grid excludes them (the UI
  // notes how many are hidden).
  done: "state = 'done'",
};

/**
 * One newest-first page of tracked photos in a DB-backed grid filter.
 * ('all' and 'unreviewed' grids page MediaStore instead — untracked
 * photos have no DB row to query.) Offset paging is fine here: pages
 * are small and a shifted row after a state edit only dupes/skips one
 * grid tile until the next refresh.
 */
export async function getGridPhotosByFilter(
  db: SQLiteDatabase,
  scope: PhotoScope,
  roots: readonly string[] | null,
  filter: keyof typeof GRID_FILTER_SQL,
  limit: number,
  offset: number,
): Promise<GridPhotoRow[]> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  return db.getAllAsync<GridPhotoRow>(
    `SELECT asset_id, uri, taken_at, state, (group_id IS NOT NULL) AS grouped
     FROM photos WHERE ${where.sql} AND (${GRID_FILTER_SQL[filter]})${src.sql}
     ORDER BY taken_at DESC, asset_id DESC LIMIT ? OFFSET ?`,
    ...where.params,
    ...src.params,
    limit,
    offset,
  );
}

/**
 * State editor: send a converged 'done' photo back to the edit queue.
 * Mirrors the CASE-write semantics everywhere else: entering to_edit
 * sets the needs_edit flag and records to_edit_at (first entry wins).
 */
export async function markDoneToEdit(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos
     SET state = 'to_edit', needs_edit = 1, to_edit_at = COALESCE(to_edit_at, ?)
     WHERE asset_id = ? AND state = 'done'`,
    at,
    assetId,
  );
}

/**
 * State editor: un-cull a staged photo OUTSIDE any live session (rows
 * left 'culled' by an abandoned session). Same outcome as the in-session
 * cull-list unstage: back to 'kept', or 'to_edit' when the needs-edit
 * flag is set (m0.2 #8). NEVER call this for a photo in the active
 * session — that must go through the session (the snapshot would still
 * delete it at confirm otherwise); the editor UI enforces this by
 * making active-session photos read-only.
 */
export async function unstageCullDirect(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos
     SET state = CASE WHEN needs_edit = 1 THEN 'to_edit' ELSE 'kept' END,
         to_edit_at = CASE
           WHEN needs_edit = 1 AND to_edit_at IS NULL THEN ?
           ELSE to_edit_at
         END
     WHERE asset_id = ? AND state = 'culled'`,
    at,
    assetId,
  );
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
  roots: readonly string[] | null = null,
): Promise<Map<string, DaySummaryRow>> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<DaySummaryRow>(
    `SELECT day,
            COUNT(*) AS tracked,
            SUM(CASE WHEN state IN ('done', 'trashed') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
            SUM(CASE WHEN state = 'to_edit' THEN 1 ELSE 0 END) AS toEdit,
            SUM(CASE WHEN state IN ('culled', 'confirmed') THEN 1 ELSE 0 END) AS staged
     FROM photos WHERE day IS NOT NULL AND day >= ?${src.sql}
     GROUP BY day`,
    sinceDay,
    ...src.params,
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

// ----------------------------------------------------- perceptual hashes

/** Cached dHash for one asset (m0.4, photo_hashes table). */
export interface PhotoHashRow {
  asset_id: string;
  hash: string;
  mod_time: number;
}

/** Cached dHashes for the given assets (missing rows simply absent). */
export async function getPhotoHashes(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, PhotoHashRow>> {
  const out = new Map<string, PhotoHashRow>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<PhotoHashRow>(
      `SELECT asset_id, hash, mod_time FROM photo_hashes WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) out.set(row.asset_id, row);
  }
  return out;
}

/** Upsert one computed dHash (recomputed when mod_time changes). */
export async function setPhotoHash(
  db: SQLiteDatabase,
  assetId: string,
  hash: string,
  modTime: number,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO photo_hashes (asset_id, hash, mod_time) VALUES (?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET hash = excluded.hash, mod_time = excluded.mod_time`,
    assetId,
    hash,
    modTime,
  );
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
