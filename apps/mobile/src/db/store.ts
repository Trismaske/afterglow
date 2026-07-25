/**
 * Persistence operations over the schema in database.ts.
 * All multi-statement writes run in exclusive transactions.
 *
 * State machine (PLAN.md, m0.2): SQLite `photos.state` is the source of
 * truth and everything converges on 'done':
 *
 *   unreviewed ──review──┬─▶ culled ─▶ (system trash) ─▶ trashed
 *                        └─▶ kept ──┬─▶ to_edit ─▶ done
 *                                   └─(session finish)─▶ done
 *
 * 'kept' + needs_edit = 1 is stored as 'to_edit' — the CASE expressions
 * below keep that invariant no matter which path writes the state.
 * 'confirmed' is deliberately never persisted (m0.1 decision: SQLite keeps
 * 'culled' until the system trash request succeeds).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DuelRecord, PhotoState } from '@afterglow/core';
import { lifetimeReclaimedBytes } from './trashStore';
import type { LoadedPhoto } from '../lib/media';
import { sourceLikePattern } from '../lib/sources';
import type { StateCounts } from '../lib/progress';

/** Max ids per IN (...) chunk — stays under SQLite's bind-parameter limit. */
const IN_CHUNK = 500;

export type FavouriteState = 'none' | 'queued_apply' | 'applied' | 'queued_remove' | 'error';

export interface FavouriteIntentChange {
  assetId: string;
  state: FavouriteState;
  target: boolean | null;
}

export interface NeedsEditIntentChange {
  assetId: string;
  needsEdit: boolean;
}

export interface PersistDecisionExtras {
  duel?: DuelRecord;
  favouriteChanges?: readonly FavouriteIntentChange[];
  needsEditChanges?: readonly NeedsEditIntentChange[];
  /** Photos that left their group ("not related" ejection + dissolve
   * survivor) — durable membership updates ride the same transaction. */
  madeSingles?: readonly string[];
  /** Restored staged culls: resolve their PENDING edited-copy matches —
   * un-culling answers the copy prompt's question, so its stale re-emit
   * must not return, nor block a future cycle's fresh match (C#12). */
  resolveCopyMatchesFor?: readonly string[];
}

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
 * Read-only: the active session's kept ids from its persisted snapshot
 * (empty when no session or the snapshot is unparseable — bracket-era
 * rows are already the durable truth). The session loader counts these
 * as handled so a new draw excludes them WITHOUT mutating anything
 * (m0.5: "starting a new session never discards decisions") — they bank
 * to done only inside the atomic replacement transaction
 * (replaceActiveSession), so an aborted start leaves the old session
 * fully intact. Staged culls deliberately stay 'culled' in the durable
 * global cull queue either way.
 */
export async function getActiveSessionKeptIds(db: SQLiteDatabase): Promise<string[]> {
  const row = await getActiveSession(db);
  if (!row) return [];
  try {
    const snap = JSON.parse(row.snapshot) as { states?: Record<string, string> };
    if (typeof snap !== 'object' || snap === null || typeof snap.states !== 'object') return [];
    return Object.entries(snap.states ?? {})
      .filter(([, state]) => state === 'kept')
      .map(([id]) => id);
  } catch {
    return [];
  }
}

export interface NewSessionInput {
  label: string;
  rangeStart: number;
  rangeEnd: number;
  snapshot: string;
  photos: readonly (LoadedPhoto & { groupId: string | null; day: string })[];
  createdAt: number;
}

/**
 * Shared body for createSession / replaceActiveSession: insert the session
 * row, upsert photo rows (carry policy, P4#1: an existing staged cull KEEPS
 * `culled` — nothing is ever reset by a draw), write the durable grouping
 * run/groups/assignments (membership is durable from creation, item C),
 * then repair intersected leftovers from earlier runs (N#1: a group left
 * with < 2 members dissolves; a best whose assignment moved is cleared).
 */
async function insertSessionWithPhotos(
  txn: SQLiteDatabase,
  input: NewSessionInput,
): Promise<number> {
  const result = await txn.runAsync(
    `INSERT INTO sessions (label, range_start, range_end, snapshot, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    input.label,
    input.rangeStart,
    input.rangeEnd,
    input.snapshot,
    input.createdAt,
  );
  const sessionId = Number(result.lastInsertRowId);
  for (const photo of input.photos) {
    await txn.runAsync(
      `INSERT INTO photos (asset_id, uri, taken_at, state, group_id, session_day,
                           mod_time, day, needs_edit, volume_name, raw_id, activity_at)
       VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         uri = excluded.uri,
         state = CASE WHEN photos.state = 'culled' THEN 'culled' ELSE 'unreviewed' END,
         group_id = excluded.group_id,
         session_day = excluded.session_day,
         mod_time = excluded.mod_time,
         day = excluded.day,
         needs_edit = CASE WHEN photos.state = 'culled' THEN photos.needs_edit ELSE 0 END,
         volume_name = excluded.volume_name,
         raw_id = excluded.raw_id`,
      photo.item.id,
      photo.item.uri,
      photo.item.timestamp,
      photo.groupId,
      input.label,
      photo.modTime,
      photo.day,
      photo.volumeName,
      photo.rawId,
      input.createdAt,
    );
  }

  // Durable grouping (item C): one run per session; legacy string cluster
  // ids become photo_groups rows; every drawn photo gets exactly one
  // assignment (group or NULL single). INSERT OR REPLACE moves a redrawn
  // photo's assignment to this run.
  const runResult = await txn.runAsync(
    `INSERT INTO grouping_runs (session_id, provenance, created_at, scope)
     VALUES (?, 'session', ?, ?)`,
    sessionId,
    input.createdAt,
    input.label,
  );
  const runId = Number(runResult.lastInsertRowId);
  const groupIds = new Map<string, number>();
  for (const photo of input.photos) {
    if (photo.groupId === null || groupIds.has(photo.groupId)) continue;
    const groupResult = await txn.runAsync(
      'INSERT INTO photo_groups (run_id, best_photo_id) VALUES (?, NULL)',
      runId,
    );
    groupIds.set(photo.groupId, Number(groupResult.lastInsertRowId));
  }
  for (const photo of input.photos) {
    await txn.runAsync(
      `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id)
       VALUES (?, ?, ?)`,
      photo.item.id,
      runId,
      photo.groupId === null ? null : (groupIds.get(photo.groupId) ?? null),
    );
  }

  // Repair intersected leftovers from earlier runs (N#1) — shared with
  // single ejections; also re-syncs survivors' legacy photos.group_id.
  await repairGroupMembership(txn);
  return sessionId;
}

/** Create a session and upsert its photo rows. Returns the session id. */
export async function createSession(db: SQLiteDatabase, input: NewSessionInput): Promise<number> {
  let sessionId = -1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    sessionId = await insertSessionWithPhotos(txn, input);
  });
  return sessionId;
}

/**
 * Atomic session replacement (N#2, P4#1, item H): bank the old session's
 * keepers, abandon it, and create the new session — one exclusive
 * transaction. Staged culls are CARRIED: their rows are not touched (the
 * durable global cull queue owns them), so replacement is silent — nothing
 * is ever lost. A failure anywhere rolls the whole replacement back and
 * the old session stays active and resumable.
 */
export async function replaceActiveSession(
  db: SQLiteDatabase,
  input: NewSessionInput,
  at: number,
): Promise<number> {
  let sessionId = -1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const active = await txn.getFirstAsync<SessionRow>(
      'SELECT * FROM sessions WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1',
    );
    if (active) {
      // Bank keepers exactly like session completion (kept → done;
      // to_edit rows already remapped). Snapshot-driven so a session that
      // was never resumed after a restart still banks correctly.
      try {
        const snap = JSON.parse(active.snapshot) as { states?: Record<string, string> };
        const keptIds = Object.entries(snap.states ?? {})
          .filter(([, state]) => state === 'kept')
          .map(([id]) => id);
        for (const ids of chunk(keptIds, IN_CHUNK)) {
          const placeholders = ids.map(() => '?').join(',');
          await txn.runAsync(
            `UPDATE photos SET state = 'done', activity_at = ?
             WHERE state = 'kept' AND asset_id IN (${placeholders})`,
            at,
            ...ids,
          );
        }
      } catch {
        // Unparseable snapshot: per-photo rows are already the durable truth.
      }
      await txn.runAsync('UPDATE sessions SET completed_at = ? WHERE id = ?', at, active.id);
    }
    sessionId = await insertSessionWithPhotos(txn, input);
  });
  return sessionId;
}

/** Staged, present culls in the durable global queue (Home card badge —
 * the queue must stay reachable with no active session, P4#1). */
export async function countStagedCulls(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM photos WHERE state = 'culled' AND is_present = 1",
  );
  return row?.n ?? 0;
}

/** The durable global cull queue (P4#1): every staged, present cull. */
export interface StagedCullRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  day: string | null;
}

export async function getStagedCulls(db: SQLiteDatabase): Promise<StagedCullRow[]> {
  return db.getAllAsync<StagedCullRow>(
    `SELECT asset_id, uri, taken_at, day FROM photos
     WHERE state = 'culled' AND is_present = 1
     ORDER BY taken_at ASC`,
  );
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
  extras: PersistDecisionExtras = {},
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('UPDATE sessions SET snapshot = ? WHERE id = ?', snapshot, sessionId);
    for (const change of extras.needsEditChanges ?? []) {
      const flag = change.needsEdit ? 1 : 0;
      await txn.runAsync(
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
             END,
             activity_at = ?
         WHERE asset_id = ?`,
        flag,
        flag,
        flag,
        flag,
        at,
        at,
        change.assetId,
      );
      if (change.needsEdit) {
        // Re-flagging an already-completed edit re-queues it for a fresh
        // detection cycle — same transition as markDoneToEdit, so the
        // edit queue and detection see the photo again (a 'done' row
        // with needs_edit = 1 is visible to neither).
        await txn.runAsync(
          `UPDATE photos
           SET state = 'to_edit', needs_edit = 1, to_edit_at = ?,
               mod_time = NULL, content_hash = NULL,
               activity_at = ?
           WHERE asset_id = ? AND state = 'done'`,
          at,
          at,
          change.assetId,
        );
      }
    }
    for (const [assetId, state] of changedStates) {
      // Reopening a COMPLETED photo (explicit verdict clear: done →
      // unreviewed) also resets its edit-cycle columns — a later re-flag
      // must start a fresh detection cycle, not consume the old edit's
      // baseline/hash. (All CASEs read the pre-update row state.)
      await txn.runAsync(
        `UPDATE photos
         SET state = CASE WHEN ? = 'kept' AND needs_edit = 1 THEN 'to_edit' ELSE ? END,
             to_edit_at = CASE
               WHEN ? = 'kept' AND needs_edit = 1 AND to_edit_at IS NULL THEN ?
               WHEN ? = 'unreviewed' AND state = 'done' THEN NULL
               ELSE to_edit_at
             END,
             mod_time = CASE
               WHEN ? = 'unreviewed' AND state = 'done' THEN NULL
               ELSE mod_time
             END,
             content_hash = CASE
               WHEN ? = 'unreviewed' AND state = 'done' THEN NULL
               ELSE content_hash
             END,
             reviewed_at = CASE
               WHEN ? IN ('kept', 'culled') THEN COALESCE(reviewed_at, ?)
               ELSE reviewed_at
             END,
             culled_at = CASE
               WHEN ? = 'culled' THEN COALESCE(culled_at, ?)
               ELSE culled_at
             END,
             activity_at = ?
         WHERE asset_id = ?`,
        state,
        state,
        state,
        at,
        state,
        state,
        state,
        state,
        at,
        state,
        at,
        at,
        assetId,
      );
    }
    if (extras.duel) {
      await txn.runAsync(
        `INSERT INTO duels (session_id, group_id, winner_id, loser_id, kept_both, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        extras.duel.groupId,
        extras.duel.winnerId,
        extras.duel.loserId,
        extras.duel.keptBoth ? 1 : 0,
        extras.duel.at,
      );
    }
    for (const change of extras.favouriteChanges ?? []) {
      await txn.runAsync(
        `UPDATE photos
         SET favourite_state = ?, favourite_target = ?, favourite_changed_at = ?,
             activity_at = ?
         WHERE asset_id = ?`,
        change.state,
        change.target === null ? null : change.target ? 1 : 0,
        at,
        at,
        change.assetId,
      );
    }
    if (extras.madeSingles && extras.madeSingles.length > 0) {
      await applyPhotoSingles(txn, extras.madeSingles);
    }
    for (const assetId of extras.resolveCopyMatchesFor ?? []) {
      await txn.runAsync(
        "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
        assetId,
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
         END,
         activity_at = ?
     WHERE asset_id = ?`,
    flag,
    flag,
    flag,
    flag,
    at,
    at,
    assetId,
  );
}

/**
 * "Not related — review as single" (m0.4, completed m0.7): the given
 * photos left their cull group — the ejected photo plus the survivor when
 * the group dissolved (core makeSingle reports both). Updates BOTH
 * membership representations: photos.group_id (day-progress accounting)
 * and photo_group_assignments (the durable truth), then runs the shared
 * repairs. In the app this rides the persistence queue as a
 * PersistDecisionExtras field (madeSingles) so a failed write retries
 * with the snapshot instead of being lost; the standalone export serves
 * tests and non-session callers.
 */
async function applyPhotoSingles(txn: SQLiteDatabase, assetIds: readonly string[]): Promise<void> {
  const placeholders = assetIds.map(() => '?').join(',');
  await txn.runAsync(
    `UPDATE photos SET group_id = NULL WHERE asset_id IN (${placeholders})`,
    ...assetIds,
  );
  await txn.runAsync(
    `UPDATE photo_group_assignments SET group_id = NULL WHERE photo_id IN (${placeholders})`,
    ...assetIds,
  );
  await repairGroupMembership(txn);
}

/**
 * Shared membership repairs (N#1, applied by session draws and single
 * ejections alike): a group under 2 members dissolves; an orphaned best
 * clears; empty groups are deleted; and the legacy photos.group_id column
 * is re-synced to NULL wherever the durable assignment says single — the
 * progress/grid queries classify grouping from photos.group_id, so a
 * dissolved survivor must clear there too.
 */
async function repairGroupMembership(txn: SQLiteDatabase): Promise<void> {
  await txn.runAsync(
    `UPDATE photo_group_assignments SET group_id = NULL
     WHERE group_id IN (
       SELECT g.id FROM photo_groups g
       WHERE (SELECT COUNT(*) FROM photo_group_assignments a WHERE a.group_id = g.id) < 2
     )`,
  );
  await txn.runAsync(
    `UPDATE photo_groups SET best_photo_id = NULL
     WHERE best_photo_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM photo_group_assignments a
         WHERE a.group_id = photo_groups.id AND a.photo_id = photo_groups.best_photo_id
       )`,
  );
  await txn.runAsync(
    `DELETE FROM photo_groups
     WHERE (SELECT COUNT(*) FROM photo_group_assignments a WHERE a.group_id = photo_groups.id) = 0`,
  );
  await txn.runAsync(
    `UPDATE photos SET group_id = NULL
     WHERE group_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM photo_group_assignments a
         WHERE a.photo_id = photos.asset_id AND a.group_id IS NULL
       )`,
  );
}

export async function makePhotoSingles(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  await db.withExclusiveTransactionAsync((txn) => applyPhotoSingles(txn, assetIds));
}

/**
 * "Mark done" (manual or auto-detected): to_edit → done. The photo's
 * LIVE copy match resolves in the same transaction (C#12) — the original
 * has converged, and a match left pending would block future copy cycles
 * and re-emit its stale prompt when the photo is re-queued.
 *
 * `onlyIfToEditAt` scopes the completion to one edit CYCLE: detection
 * passes the `to_edit_at` it captured with its evidence, so a row
 * re-queued mid-run (fresh cycle, new timestamp) is not completed on
 * stale evidence. Omit it for explicit user actions. Returns whether
 * the completion applied.
 */
export async function markEditDone(
  db: SQLiteDatabase,
  assetId: string,
  at: number = Date.now(),
  onlyIfToEditAt?: number | null,
): Promise<boolean> {
  let applied = false;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const guard = onlyIfToEditAt === undefined ? '' : ' AND to_edit_at IS ?';
    const params: (string | number | null)[] = [at, at, assetId];
    if (onlyIfToEditAt !== undefined) params.push(onlyIfToEditAt);
    const result = await txn.runAsync(
      `UPDATE photos
       SET state = 'done', needs_edit = 0, edit_completed_at = COALESCE(edit_completed_at, ?),
           activity_at = ?
       WHERE asset_id = ? AND state = 'to_edit'${guard}`,
      ...params,
    );
    applied = result.changes > 0;
    if (!applied) return;
    await txn.runAsync(
      "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
      assetId,
    );
  });
  return applied;
}

/**
 * Converge a finished session's keepers: every given photo still 'kept'
 * becomes 'done' ('to_edit' rows are left for the edit queue).
 */
export async function markKeptDone(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  at: number = Date.now(),
): Promise<void> {
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE photos SET state = 'done', activity_at = ? WHERE state = 'kept' AND asset_id IN (${placeholders})`,
      at,
      ...ids,
    );
  }
}

/** Current stored state per asset id (missing rows are simply absent). */
/** Durable photos.uri per asset (organize moves repair it) — resume
 * reconciles session snapshots against these, the single source of truth. */
export async function getPhotoUris(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, string>> {
  const uris = new Map<string, string>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; uri: string }>(
      `SELECT asset_id, uri FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) uris.set(row.asset_id, row.uri);
  }
  return uris;
}

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
 * isn't re-checked on every detection run. Cycle-guarded by the caller's
 * captured `to_edit_at`: evidence gathered for cycle A must not move a
 * re-queued cycle B's baseline.
 */
export async function updateModTimeBaseline(
  db: SQLiteDatabase,
  assetId: string,
  modTime: number,
  onlyIfToEditAt: number | null,
): Promise<void> {
  await db.runAsync(
    "UPDATE photos SET mod_time = ? WHERE asset_id = ? AND state = 'to_edit' AND to_edit_at IS ?",
    modTime,
    assetId,
    onlyIfToEditAt,
  );
}

/**
 * Track a detected edited copy as already-done AND record its durable
 * original ↔ copy match (C#12) in ONE transaction — a crash between the
 * two would leave a tracked copy whose prompt could never be recovered
 * (tracked photos are excluded from future scans). One best copy per
 * original: an original that already has ANY recorded match is skipped
 * entirely (the table's (original, copy) key alone would let every
 * candidate pair insert) — returns false and nothing is written, so an
 * unchosen candidate stays untracked and reviewable. activity_at is
 * stamped so the detected copy appears in the History feed.
 */
export async function insertDetectedCopyWithMatch(
  db: SQLiteDatabase,
  originalId: string,
  copy: { assetId: string; uri: string; takenAt: number; modTime: number; day: string },
  detectedAt: number,
  /** The edit cycle the detection evidence belongs to — the original must
   * still be in it (state to_edit, same to_edit_at), or nothing records. */
  onlyIfToEditAt: number | null,
): Promise<boolean> {
  let recorded = false;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const original = await txn.getFirstAsync<{ to_edit_at: number | null }>(
      "SELECT to_edit_at FROM photos WHERE asset_id = ? AND state = 'to_edit'",
      originalId,
    );
    if (!original || original.to_edit_at !== onlyIfToEditAt) return; // superseded cycle
    // Only a LIVE (pending) match blocks: a resolved match belongs to a
    // finished edit cycle — a photo re-queued done → to_edit can produce
    // a genuinely new copy that must track and prompt again — and a
    // dismissed match (its copy deleted) must not block either. The same
    // physical copy can never re-insert regardless: tracked photos are
    // excluded from candidate scans.
    const existing = await txn.getFirstAsync<{ x: number }>(
      "SELECT 1 AS x FROM edit_copy_matches WHERE original_id = ? AND state = 'pending'",
      originalId,
    );
    if (existing) return;
    await txn.runAsync(
      `INSERT OR IGNORE INTO photos
         (asset_id, uri, taken_at, state, mod_time, day, needs_edit, edit_completed_at, reviewed_at, activity_at)
       VALUES (?, ?, ?, 'done', ?, ?, 0, ?, ?, ?)`,
      copy.assetId,
      copy.uri,
      copy.takenAt,
      copy.modTime,
      copy.day,
      detectedAt,
      detectedAt,
      detectedAt,
    );
    await txn.runAsync(
      `INSERT OR IGNORE INTO edit_copy_matches (original_id, copy_id, state, detected_at)
       VALUES (?, ?, 'pending', ?)`,
      originalId,
      copy.assetId,
      detectedAt,
    );
    recorded = true;
  });
  return recorded;
}

export interface PendingCopyMatch {
  original_id: string;
  copy_id: string;
}

/** One pending match per original (earliest detected wins). */
export async function getPendingCopyMatches(db: SQLiteDatabase): Promise<PendingCopyMatch[]> {
  return db.getAllAsync<PendingCopyMatch>(
    `SELECT original_id, copy_id FROM edit_copy_matches
     WHERE state = 'pending'
     GROUP BY original_id HAVING MIN(detected_at)`,
  );
}

/** A pending match whose detected copy no longer exists in MediaStore is
 * dismissed — it must not keep blocking future detection for its
 * original (see insertDetectedCopyWithMatch). */
export async function dismissCopyMatch(
  db: SQLiteDatabase,
  originalId: string,
  copyId: string,
): Promise<void> {
  await db.runAsync(
    "UPDATE edit_copy_matches SET state = 'dismissed' WHERE original_id = ? AND copy_id = ? AND state = 'pending'",
    originalId,
    copyId,
  );
}

// ---------------------------------------------------------------- History
// m0.7 item G: a reconciled current-state feed ordered by activity_at,
// with share-sheet batches interleaved as true events. Keyset pagination
// over (activity_at, asset_id) — offset paging would skip/duplicate rows
// once a mutation moves a row's sort key (C#15).

export interface HistoryPhotoRow {
  kind: 'photo';
  asset_id: string;
  uri: string;
  taken_at: number;
  state: PhotoState | 'done' | 'to_edit';
  needs_edit: number;
  favourite_state: FavouriteState;
  organize_state: string;
  organize_applied_at: number | null;
  day: string | null;
  activity_at: number;
}

export interface HistoryShareRow {
  kind: 'share';
  batch_id: number;
  opened_at: number;
  label: string | null;
  member_count: number;
  thumb_uris: string[];
}

export type HistoryRow = HistoryPhotoRow | HistoryShareRow;

export type HistoryFilter =
  'all' | 'kept' | 'culled' | 'to_edit' | 'favourite' | 'organized' | 'shared';

/** Per-stream keyset position: 'top' = not yet consumed, 'end' = exhausted. */
type StreamPos<K> = K | 'top' | 'end';

/** Combined cursor — photo decisions and share events paginate as
 * independent keyset streams merged by timestamp. */
export interface HistoryCursor {
  photo: StreamPos<{ activityAt: number; assetId: string }>;
  share: StreamPos<{ openedAt: number; batchId: number }>;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** Cursor for the next page; null when every stream is exhausted. */
  next: HistoryCursor | null;
}

const HISTORY_PAGE = 40;

/**
 * One keyset page of the History feed. Photo rows require presence
 * (is_present = 1 — trashed/deleted photos drop out; restore brings them
 * back) and at least one recorded decision (activity_at beyond the draw).
 * Share events form a second stream (keyset on opened_at) merged by
 * timestamp, so every page — not just the first — interleaves both, and
 * the Shared filter pages through all events.
 */
export async function getHistoryPage(
  db: SQLiteDatabase,
  filter: HistoryFilter,
  after: HistoryCursor | null,
): Promise<HistoryPage> {
  const filterSql =
    filter === 'kept'
      ? "AND state IN ('kept', 'done') AND needs_edit = 0"
      : filter === 'culled'
        ? "AND state = 'culled'"
        : filter === 'to_edit'
          ? "AND state = 'to_edit'"
          : filter === 'favourite'
            ? "AND favourite_state IN ('queued_apply', 'applied')"
            : filter === 'organized'
              ? // The retained applied marker, NOT the live queue state:
                // re-queueing another move must not erase the photo's
                // organized history (possibly forever, on error).
                'AND organize_applied_at IS NOT NULL'
              : // All is the union of the specific filters: a review
                // decision, an applied move, or a favourite intent — a
                // merely-drawn photo (activity_at stamped at insert) has
                // none of these.
                `AND (state <> 'unreviewed'
                   OR organize_applied_at IS NOT NULL
                   OR favourite_state IN ('queued_apply', 'applied'))`;
  const photoPos: HistoryCursor['photo'] = filter === 'shared' ? 'end' : (after?.photo ?? 'top');
  const sharePos: HistoryCursor['share'] =
    filter === 'all' || filter === 'shared' ? (after?.share ?? 'top') : 'end';

  const photoKeyset =
    photoPos === 'top' || photoPos === 'end'
      ? ''
      : 'AND (activity_at < ? OR (activity_at = ? AND asset_id < ?))';
  const photoParams: (string | number)[] =
    photoPos === 'top' || photoPos === 'end'
      ? []
      : [photoPos.activityAt, photoPos.activityAt, photoPos.assetId];
  const photos =
    photoPos === 'end'
      ? []
      : await db.getAllAsync<Omit<HistoryPhotoRow, 'kind'>>(
          `SELECT asset_id, uri, taken_at, state, needs_edit, favourite_state, organize_state, organize_applied_at, day, activity_at
           FROM photos
           WHERE is_present = 1 AND activity_at IS NOT NULL ${filterSql} ${photoKeyset}
           ORDER BY activity_at DESC, asset_id DESC
           LIMIT ${HISTORY_PAGE}`,
          ...photoParams,
        );

  const shareKeyset =
    sharePos === 'top' || sharePos === 'end'
      ? ''
      : 'AND (b.opened_at < ? OR (b.opened_at = ? AND b.id < ?))';
  const shareParams: number[] =
    sharePos === 'top' || sharePos === 'end'
      ? []
      : [sharePos.openedAt, sharePos.openedAt, sharePos.batchId];
  const shareRows =
    sharePos === 'end'
      ? []
      : await db.getAllAsync<{
          batch_id: number;
          opened_at: number;
          label: string | null;
          member_count: number;
        }>(
          `SELECT b.id AS batch_id, b.opened_at, b.label,
             (SELECT COUNT(*) FROM share_batch_members m WHERE m.batch_id = b.id) AS member_count
           FROM share_batches b
           WHERE b.state = 'sheet_opened' ${shareKeyset}
           ORDER BY b.opened_at DESC, b.id DESC
           LIMIT ${HISTORY_PAGE}`,
          ...shareParams,
        );

  const photoRows: HistoryPhotoRow[] = photos.map((p) => ({ kind: 'photo', ...p }));
  const bareShares: HistoryShareRow[] = shareRows.map((r) => ({
    kind: 'share',
    ...r,
    thumb_uris: [],
  }));
  const tsOf = (r: HistoryRow) => (r.kind === 'photo' ? r.activity_at : r.opened_at);
  const merged: HistoryRow[] = [...photoRows, ...bareShares].sort((a, b) => tsOf(b) - tsOf(a));
  const rows = merged.slice(0, HISTORY_PAGE);
  for (const row of rows) {
    if (row.kind !== 'share') continue;
    const thumbs = await db.getAllAsync<{ uri: string }>(
      `SELECT p.uri FROM share_batch_members m JOIN photos p ON p.asset_id = m.photo_id
       WHERE m.batch_id = ? LIMIT 4`,
      row.batch_id,
    );
    row.thumb_uris = thumbs.map((t) => t.uri);
  }

  // Advance each stream to its last EMITTED row; a stream ends when its
  // fetch came back short AND everything fetched was emitted (unemitted
  // rows are refetched from the unchanged position next page).
  const emittedPhotos = rows.filter((r) => r.kind === 'photo').length;
  const emittedShares = rows.filter((r) => r.kind === 'share').length;
  const lastPhoto = [...rows].reverse().find((r) => r.kind === 'photo');
  const lastShare = [...rows].reverse().find((r) => r.kind === 'share');
  const nextPhoto: HistoryCursor['photo'] =
    photoPos === 'end' || (photos.length < HISTORY_PAGE && emittedPhotos === photos.length)
      ? 'end'
      : lastPhoto && lastPhoto.kind === 'photo'
        ? { activityAt: lastPhoto.activity_at, assetId: lastPhoto.asset_id }
        : photoPos;
  const nextShare: HistoryCursor['share'] =
    sharePos === 'end' || (shareRows.length < HISTORY_PAGE && emittedShares === shareRows.length)
      ? 'end'
      : lastShare && lastShare.kind === 'share'
        ? { openedAt: lastShare.opened_at, batchId: lastShare.batch_id }
        : sharePos;
  return {
    rows,
    next:
      nextPhoto === 'end' && nextShare === 'end' ? null : { photo: nextPhoto, share: nextShare },
  };
}

/** Number of photos waiting in the to-edit queue. */
export async function countToEdit(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM photos WHERE state = 'to_edit'",
  );
  return row?.n ?? 0;
}

/**
 * Kept rows in scope belonging to the given id set (the active session's
 * pending-bank keepers) — the ONLY kept rows a new draw excludes. Kept
 * rows from an abandoned/discarded session are deliberately
 * re-reviewable (m0.3.1) and must stay in remaining counts.
 */
export async function countKeptInScopeAmong(
  db: SQLiteDatabase,
  scope: PhotoScope,
  roots: readonly string[] | null | undefined,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  let total = 0;
  for (const chunkIds of chunk(ids, IN_CHUNK)) {
    const placeholders = chunkIds.map(() => '?').join(',');
    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM photos
       WHERE state = 'kept' AND ${where.sql}${src.sql} AND asset_id IN (${placeholders})`,
      ...where.params,
      ...src.params,
      ...chunkIds,
    );
    total += row?.n ?? 0;
  }
  return total;
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
 * A re-queue starts a FRESH edit cycle: the detection baseline
 * (mod_time + content hash) resets — the previous cycle's edit was
 * already consumed, and a stale baseline would auto-complete the photo
 * before any new edit — and to_edit_at resets too, so copy detection
 * scans only from THIS cycle (an old untracked copy in the previous
 * window must not be claimed as the new cycle's result).
 */
export async function markDoneToEdit(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos
     SET state = 'to_edit', needs_edit = 1, to_edit_at = ?,
         mod_time = NULL, content_hash = NULL,
         activity_at = ?
     WHERE asset_id = ? AND state = 'done'`,
    at,
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
/**
 * Cull-list "Restore to unreviewed" for a CARRIED cull (staged in an
 * earlier session, absent from the active one): back to the review pool.
 * Like every other un-staging path, the restore resolves any pending
 * edited-copy match (C#12) in the same transaction.
 */
export async function restoreCarriedCull(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "UPDATE photos SET state = 'unreviewed', activity_at = ? WHERE asset_id = ? AND state = 'culled'",
      at,
      assetId,
    );
    await txn.runAsync(
      "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
      assetId,
    );
  });
}

export async function unstageCullDirect(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
  /**
   * True when the un-cull is the user's explicit restore decision — it
   * answers the copy prompt's question, so the pending match resolves
   * (C#12). False when the un-cull merely rolls back a trash attempt
   * that never happened (cancel/failure): the question is still open
   * and the prompt must stay re-emittable.
   */
  resolveCopyMatches: boolean,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `UPDATE photos
       SET state = CASE WHEN needs_edit = 1 THEN 'to_edit' ELSE 'kept' END,
           to_edit_at = CASE
             WHEN needs_edit = 1 AND to_edit_at IS NULL THEN ?
             ELSE to_edit_at
           END,
           activity_at = ?
       WHERE asset_id = ? AND state = 'culled'`,
      at,
      at,
      assetId,
    );
    if (resolveCopyMatches) {
      await txn.runAsync(
        "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
        assetId,
      );
    }
  });
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

// ------------------------------------------------ favourite queue + lifetime metrics

export interface FavouriteQueueRow {
  asset_id: string;
  uri: string;
  favourite_state: FavouriteState;
  favourite_target: number | null;
}

/** Favourite state for current-session UI; absent rows are `none`. */
export async function getFavouriteStates(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, { state: FavouriteState; target: boolean | null }>> {
  const out = new Map<string, { state: FavouriteState; target: boolean | null }>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{
      asset_id: string;
      favourite_state: FavouriteState;
      favourite_target: number | null;
    }>(
      `SELECT asset_id, favourite_state, favourite_target FROM photos
       WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      out.set(row.asset_id, {
        state: row.favourite_state,
        target: row.favourite_target === null ? null : row.favourite_target === 1,
      });
    }
  }
  return out;
}

/** Record user intent before opening Android's batch confirmation sheet. */
export async function queueFavouriteChange(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  favourite: boolean,
  at: number,
): Promise<void> {
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE photos SET favourite_state = ?, favourite_target = ?, favourite_changed_at = ?
       WHERE asset_id IN (${placeholders})`,
      favourite ? 'queued_apply' : 'queued_remove',
      favourite ? 1 : 0,
      at,
      ...ids,
    );
  }
}

/** Pending favourite work survives restarts and is safe to retry. */
export async function getFavouriteQueue(db: SQLiteDatabase): Promise<FavouriteQueueRow[]> {
  return db.getAllAsync<FavouriteQueueRow>(
    `SELECT asset_id, uri, favourite_state, favourite_target FROM photos
     WHERE favourite_state IN ('queued_apply', 'queued_remove', 'error')
     ORDER BY favourite_changed_at, taken_at`,
  );
}

export async function countFavouriteQueue(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos
     WHERE favourite_state IN ('queued_apply', 'queued_remove', 'error')`,
  );
  return row?.n ?? 0;
}

/** Commit a verified MediaStore outcome; removal retains lifetime history.
 * C#14/P5#4: every SQL chunk for ONE verified OS batch commits in ONE
 * exclusive transaction — a late chunk failure can never record a partial
 * verified outcome. */
export async function markFavouriteBatchApplied(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  favourite: boolean,
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const ids of chunk(assetIds, IN_CHUNK)) {
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(',');
      await txn.runAsync(
        `UPDATE photos
         SET favourite_state = ?,
             favourite_target = NULL,
             favourite_changed_at = ?,
             favourite_applied_at = CASE
               WHEN ? = 1 THEN COALESCE(favourite_applied_at, ?)
               ELSE favourite_applied_at
             END,
             activity_at = ?
         WHERE asset_id IN (${placeholders})
           AND favourite_state IN ('queued_apply', 'queued_remove', 'error')
           AND favourite_target = ?`,
        favourite ? 'applied' : 'none',
        at,
        favourite ? 1 : 0,
        at,
        at,
        ...ids,
        favourite ? 1 : 0,
      );
    }
  });
}

export async function markFavouriteBatchError(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  target: boolean,
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const ids of chunk(assetIds, IN_CHUNK)) {
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(',');
      await txn.runAsync(
        `UPDATE photos
         SET favourite_state = 'error', favourite_changed_at = ?,
             activity_at = ?
         WHERE asset_id IN (${placeholders})
           AND favourite_state IN ('queued_apply', 'queued_remove')
           AND favourite_target = ?`,
        at,
        at,
        ...ids,
        target ? 1 : 0,
      );
    }
  });
}

/**
 * Exact lifetime dashboard semantics:
 * - reviewed/culled/edit/favourite count unique tracked photos that have
 *   ever reached the event (timestamps are first-event markers);
 * - reclaimed bytes come from the authoritative verified trash-member
 *   rows (trashStore.lifetimeReclaimedBytes) — batches launched without
 *   an active session count too; sessions.reclaimed_bytes is only the
 *   per-session display stat.
 */
export interface LifetimeStats {
  reviewed: number;
  culled: number;
  editsCompleted: number;
  favouritesApplied: number;
  reclaimedBytes: number;
}

export async function getLifetimeStats(db: SQLiteDatabase): Promise<LifetimeStats> {
  const photo = await db.getFirstAsync<{
    reviewed: number;
    culled: number;
    editsCompleted: number;
    favouritesApplied: number;
  }>(
    `SELECT
       SUM(CASE WHEN reviewed_at IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
       SUM(CASE WHEN culled_at IS NOT NULL THEN 1 ELSE 0 END) AS culled,
       SUM(CASE WHEN edit_completed_at IS NOT NULL THEN 1 ELSE 0 END) AS editsCompleted,
       SUM(CASE WHEN favourite_applied_at IS NOT NULL THEN 1 ELSE 0 END) AS favouritesApplied
     FROM photos`,
  );
  return {
    reviewed: photo?.reviewed ?? 0,
    culled: photo?.culled ?? 0,
    editsCompleted: photo?.editsCompleted ?? 0,
    favouritesApplied: photo?.favouritesApplied ?? 0,
    reclaimedBytes: await lifetimeReclaimedBytes(db),
  };
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

/** Store a lazily computed content hash (fallback identity). Pass
 * `onlyIfToEditAt` when the hash is a detection baseline for a captured
 * edit cycle — a re-queued row (fresh cycle) then stays untouched. */
export async function setContentHash(
  db: SQLiteDatabase,
  assetId: string,
  hash: string,
  onlyIfToEditAt?: number | null,
): Promise<void> {
  const guard = onlyIfToEditAt === undefined ? '' : " AND state = 'to_edit' AND to_edit_at IS ?";
  const params: (string | number | null)[] = [hash, assetId];
  if (onlyIfToEditAt !== undefined) params.push(onlyIfToEditAt);
  await db.runAsync(
    `UPDATE photos SET content_hash = ? WHERE asset_id = ? AND content_hash IS NULL${guard}`,
    ...params,
  );
}
