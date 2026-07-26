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
 * m0.8: a keep writes 'done' at swipe time (no kept state); 'done' +
 * needs_edit = 1 is stored as 'to_edit' — the CASE expressions below keep
 * that invariant no matter which path writes the state. 'confirmed' is
 * deliberately never persisted (m0.1 decision: SQLite keeps 'culled'
 * until the system trash request succeeds).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DuelRecord, PhotoState } from '@afterglow/core';
import { lifetimeReclaimedBytes } from './trashStore';
import type { LoadedPhoto } from '../lib/media';
import { frozenPhotos, reconcileWindowGroups } from '../lib/regroupBoundary';
import { sourceLikePattern } from '../lib/sources';
import { UNDATED_DAY_KEY } from '../lib/dates';
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
  /** Star a group best in the SAME transaction (compare verdicts: duel,
   * loser state, and the star must land or fail together). */
  setBest?: { groupId: number; assetId: string | null };
  /** Validate — inside the transaction — that every listed photo still
   * belongs to the given group (Keep remaining: a warm scan can rebuild
   * an all-unreviewed group between render and tap; writing the stale
   * member list would partially freeze the superseding groups). */
  requireGroupMembership?: { groupId: number; assetIds: readonly string[] };
  /** Validate each photo's RENDERED assignment (group id, or null for a
   * single) inside the transaction — a scan can reassign an unreviewed
   * photo between render and tap, and a verdict against the stale
   * assignment would freeze a group the user never reviewed. */
  requireAssignment?: readonly { assetId: string; groupId: number | null }[];
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
    ? scope.day === UNDATED_DAY_KEY
      ? // The Unknown-day pseudo-day: photos without a capture date.
        { sql: 'day IS NULL', params: [] }
      : { sql: 'day = ?', params: [scope.day] }
    : {
        sql: 'taken_at BETWEEN ? AND ?',
        // An open-ended range arrives as Infinity (undated-photo
        // contract in lib/media.ts) — clamp for the SQL binding.
        params: [
          scope.startMs,
          Number.isFinite(scope.endMs) ? scope.endMs : Number.MAX_SAFE_INTEGER,
        ],
      };
}

/**
 * Photo-source roots as an SQL fragment over `photos.uri` (m0.3.1).
 * `roots` null/empty = "All folders" (no filter). The LIKE containment
 * match (`%/<root>/%`, ASCII-case-insensitive by SQLite default) is the
 * DB-side counterpart of the album matching in sources.ts — see its
 * module docs for the accepted looseness.
 */
function sourceClause(
  roots: readonly string[] | null | undefined,
  column = 'uri',
): {
  sql: string;
  params: string[];
} {
  if (!roots || roots.length === 0) return { sql: '', params: [] };
  const likes = roots.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ');
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

/** Remove a setting row entirely — an UNSET setting is distinct from any
 * explicit value (e.g. the photo-source dynamic default). */
export async function deleteSetting(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM settings WHERE key = ?', key);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
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

/** A direct review verdict (m0.8 — the DB-backed deck writes photos
 * directly; decision 2: keeps write done at swipe, no kept state). */
export type ReviewVerdict = 'done' | 'culled' | 'to_edit' | 'unreviewed';

/**
 * Persist review decisions atomically — verdicts, needs-edit flips,
 * favourite intents, compare records, ejections, and copy-match
 * resolutions in ONE transaction (the m0.7 edit-cycle hardening carried
 * over sessionless):
 *
 * - 'done'   → state done (or to_edit when the needs-edit flag is up);
 *              reviewed_at stamps once (first review wins, survives
 *              re-decides so lifetime stats never undercount).
 * - 'to_edit'→ state to_edit + needs_edit, to_edit_at first-entry stamp
 *              (the m0.3 detection cycle key); reviewed_at stamps too —
 *              flagging IS the review moment (markEditDone later flips
 *              to done without re-stamping).
 * - 'culled' → staged cull; reviewed_at + culled_at stamp once.
 * - 'unreviewed' → verdict cleared (re-decide/undo/Restore); leaving a
 *              completed edit ALSO resets the edit-cycle columns so a
 *              later re-flag starts a fresh detection cycle instead of
 *              consuming the old baseline/hash.
 */
export async function applyReviewDecisions(
  db: SQLiteDatabase,
  changes: readonly [assetId: string, verdict: ReviewVerdict][],
  at: number,
  extras: PersistDecisionExtras = {},
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const expected of extras.requireAssignment ?? []) {
      const row = await txn.getFirstAsync<{ group_id: number | null }>(
        'SELECT group_id FROM photo_group_assignments WHERE photo_id = ?',
        expected.assetId,
      );
      // A MISSING row always fails — a settings reset can delete a
      // rendered single's assignment, and a verdict on it would freeze a
      // photo whose assignment can never be rebuilt.
      const actual = row === null ? undefined : row.group_id === null ? null : Number(row.group_id);
      if (actual !== expected.groupId) {
        throw new Error('This group changed while reviewing — reopen it and try again.');
      }
    }
    if (extras.requireGroupMembership) {
      const { groupId, assetIds } = extras.requireGroupMembership;
      if (assetIds.length > 0) {
        const rows = await txn.getAllAsync<{ photo_id: string }>(
          `SELECT a.photo_id FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
           WHERE a.group_id = ? AND a.photo_id IN (${assetIds.map(() => '?').join(',')})
             AND p.is_present = 1`,
          groupId,
          ...assetIds,
        );
        if (rows.length !== assetIds.length) {
          throw new Error('This group changed while reviewing — reopen it and try again.');
        }
      }
    }
    // Compare verdicts validate IN the transaction: a warm scan can
    // replace an all-unreviewed group between Compare's load and this
    // write — starring/culling against the wrong group must abort whole
    // (the provider surfaces the error; nothing commits).
    if (extras.duel && extras.setBest) {
      const members = await txn.getAllAsync<{ photo_id: string }>(
        `SELECT a.photo_id FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id = ? AND a.photo_id IN (?, ?)
           -- Both endpoints must still be REVIEWABLE: an externally
           -- removed (or already-decided) endpoint would record a duel
           -- and could star an unavailable photo, metadata-freezing the
           -- group around it.
           AND p.is_present = 1 AND p.state = 'unreviewed'`,
        extras.setBest.groupId,
        extras.duel.winnerId,
        extras.duel.loserId,
      );
      if (members.length !== 2) {
        throw new Error('This group changed while comparing — reopen it and try again.');
      }
    }
    for (const change of extras.needsEditChanges ?? []) {
      const flag = change.needsEdit ? 1 : 0;
      const flagged = await txn.runAsync(
        `UPDATE photos
         SET needs_edit = ?,
             state = CASE
               WHEN ? = 1 AND state = 'done' THEN 'to_edit'
               WHEN ? = 0 AND state = 'to_edit' THEN 'done'
               ELSE state
             END,
             to_edit_at = CASE
               WHEN ? = 1 AND state = 'done' THEN ?
               ELSE to_edit_at
             END,
             mod_time = CASE WHEN ? = 1 AND state = 'done' THEN NULL ELSE mod_time END,
             content_hash = CASE WHEN ? = 1 AND state = 'done' THEN NULL ELSE content_hash END,
             activity_at = ?
         WHERE asset_id = ?
           -- A reconciled (absent) row must not regain the flag: a later
           -- Gallery restore would turn an ordinary Keep into to_edit.
           AND is_present = 1`,
        flag,
        flag,
        flag,
        flag,
        at,
        flag,
        flag,
        at,
        change.assetId,
      );
      if (
        Number(flagged.changes) === 0 &&
        changes.length === 0 &&
        (extras.needsEditChanges?.length ?? 0) === 1
      ) {
        // A lone flag toggle on a reconciled photo surfaces (batch
        // paths converge on refresh).
        throw new Error('This photo is no longer available — it was removed outside Afterglow.');
      }
    }
    let staleChanges = 0;
    for (const [assetId, verdict] of changes) {
      const applied = await txn.runAsync(
        `UPDATE photos
         SET state = CASE
               WHEN ? = 'done' AND needs_edit = 1 THEN 'to_edit'
               WHEN ? = 'to_edit' THEN 'to_edit'
               ELSE ?
             END,
             needs_edit = CASE
               WHEN ? = 'to_edit' THEN 1
               WHEN ? = 'unreviewed' THEN 0
               ELSE needs_edit
             END,
             to_edit_at = CASE
               WHEN ? IN ('to_edit', 'done') AND (needs_edit = 1 OR ? = 'to_edit')
                    AND to_edit_at IS NULL THEN ?
               WHEN ? = 'unreviewed' THEN NULL
               ELSE to_edit_at
             END,
             -- EVERY return to 'unreviewed' resets the full edit-cycle
             -- baseline (also from 'culled'): a later re-flag must never
             -- reuse a previous cycle's detection evidence.
             mod_time = CASE
               WHEN ? = 'unreviewed' THEN NULL
               ELSE mod_time
             END,
             content_hash = CASE
               WHEN ? = 'unreviewed' THEN NULL
               ELSE content_hash
             END,
             reviewed_at = CASE
               WHEN ? IN ('done', 'culled', 'to_edit') THEN COALESCE(reviewed_at, ?)
               ELSE reviewed_at
             END,
             culled_at = CASE
               WHEN ? = 'culled' THEN COALESCE(culled_at, ?)
               ELSE culled_at
             END,
             activity_at = ?
         WHERE asset_id = ?
           -- Externally removed/converged rows reject decisions: a stale
           -- deck tile deciding a reconciled photo would overwrite
           -- 'trashed' and strand it from the scan's restore path.
           AND is_present = 1 AND state NOT IN ('trashed', 'confirmed')`,
        verdict,
        verdict,
        verdict,
        verdict,
        verdict,
        verdict,
        verdict,
        at,
        verdict,
        verdict,
        verdict,
        verdict,
        at,
        verdict,
        at,
        at,
        assetId,
      );
      if (Number(applied.changes) === 0) {
        staleChanges += 1;
        continue;
      }
      if (verdict === 'culled') {
        // A staged cull is not ALIVE — a star pointing at it would show a
        // cull as best and freeze the group via the metadata boundary.
        // extras.setBest (the compare winner) applies below and may star
        // a replacement.
        await txn.runAsync(
          'UPDATE photo_groups SET best_photo_id = NULL WHERE best_photo_id = ?',
          assetId,
        );
      }
    }
    if (staleChanges > 0) {
      if (changes.length === 1) {
        // A single-photo decision on a reconciled row must SURFACE — the
        // deck tile is stale and nothing was saved.
        throw new Error('This photo is no longer available — it was removed outside Afterglow.');
      }
      // Batch keeps (keep-rest / keep-all) racing reconciliation converge
      // on the refresh; loud once, no user interruption.
      console.warn(`[review] ${staleChanges} decisions skipped — photos removed externally`);
    }
    if (extras.setBest) {
      await txn.runAsync(
        'UPDATE photo_groups SET best_photo_id = ? WHERE id = ?',
        extras.setBest.assetId,
        extras.setBest.groupId,
      );
    }

    if (extras.duel) {
      await txn.runAsync(
        `INSERT INTO duels (group_id, winner_id, loser_id, kept_both, at)
         VALUES (?, ?, ?, ?, ?)`,
        extras.duel.groupId,
        extras.duel.winnerId,
        extras.duel.loserId,
        extras.duel.keptBoth ? 1 : 0,
        extras.duel.at,
      );
    }
    for (const change of extras.favouriteChanges ?? []) {
      const applied = await txn.runAsync(
        `UPDATE photos
         SET favourite_state = ?, favourite_target = ?, favourite_changed_at = ?,
             activity_at = ?
         WHERE asset_id = ?
           -- Removal cleanup cancelled the row's intents; a stale tile's
           -- toggle must not recreate an impossible gallery operation.
           AND is_present = 1`,
        change.state,
        change.target === null ? null : change.target ? 1 : 0,
        at,
        at,
        change.assetId,
      );
      if (Number(applied.changes) === 0 && changes.length === 0) {
        // A lone favourite toggle on a reconciled photo surfaces like a
        // lone verdict would (batch paths converge on refresh).
        throw new Error('This photo is no longer available — it was removed outside Afterglow.');
      }
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
 * Set/clear the "this keeper needs editing" flag (m0.8: kept is gone —
 * the flag flips a done photo to to_edit and back). Entering to_edit
 * records `to_edit_at` (first entry wins) and resets the detection
 * baseline for a fresh cycle.
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
           WHEN ? = 1 AND state = 'done' THEN 'to_edit'
           WHEN ? = 0 AND state = 'to_edit' THEN 'done'
           ELSE state
         END,
         to_edit_at = CASE
           WHEN ? = 1 AND state = 'done' THEN ?
           ELSE to_edit_at
         END,
         mod_time = CASE WHEN ? = 1 AND state = 'done' THEN NULL ELSE mod_time END,
         content_hash = CASE WHEN ? = 1 AND state = 'done' THEN NULL ELSE content_hash END,
         activity_at = ?
     WHERE asset_id = ?`,
    flag,
    flag,
    flag,
    flag,
    at,
    flag,
    flag,
    at,
    assetId,
  );
}

/**
 * "Not related — review as single" (m0.4, completed m0.7; m0.8: durable
 * user-ejection): the given photos left their cull group — the ejected
 * photo plus the survivor when the group dissolved. Marks user_single so
 * no scan ever regroups them, then runs the shared repairs.
 */
async function applyPhotoSingles(txn: SQLiteDatabase, assetIds: readonly string[]): Promise<void> {
  const placeholders = assetIds.map(() => '?').join(',');
  // "Not related" on a pair judged BOTH photos: the survivor of a group
  // this ejection shrinks to one member becomes a durable user single too
  // — the bare membership repair would leave it regroupable, silently
  // undoing the decision (the session flow persisted both ids).
  await txn.runAsync(
    `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0, user_single = 1
     WHERE photo_id IN (
       SELECT a.photo_id FROM photo_group_assignments a
       WHERE a.group_id IS NOT NULL
         AND a.photo_id NOT IN (${placeholders})
         AND a.group_id IN (SELECT group_id FROM photo_group_assignments
                            WHERE photo_id IN (${placeholders}) AND group_id IS NOT NULL)
         AND (SELECT COUNT(*) FROM photo_group_assignments b
              WHERE b.group_id = a.group_id AND b.photo_id NOT IN (${placeholders})) = 1
     )`,
    ...assetIds,
    ...assetIds,
    ...assetIds,
  );
  await txn.runAsync(
    `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0, user_single = 1
     WHERE photo_id IN (${placeholders})`,
    ...assetIds,
  );
  await repairGroupMembership(txn);
}

/**
 * Shared membership repairs (N#1, applied by single ejections, regroup
 * resets, window writes, and removal reconciliation alike): a group with
 * fewer than 2 PRESENT members dissolves — an absent (trashed/removed)
 * member must not hold a one-photo group in the deck; an orphaned best
 * clears; empty groups are deleted. photo_group_assignments is the ONE
 * membership truth (m0.8: the legacy photos.group_id column is gone).
 */
export async function repairGroupMembership(txn: SQLiteDatabase): Promise<void> {
  await txn.runAsync(
    `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0
     WHERE group_id IN (
       SELECT g.id FROM photo_groups g
       WHERE (SELECT COUNT(*) FROM photo_group_assignments a
              JOIN photos p ON p.asset_id = a.photo_id
              WHERE a.group_id = g.id AND p.is_present = 1) < 2
     )`,
  );
  await txn.runAsync(
    `UPDATE photo_groups SET best_photo_id = NULL
     WHERE best_photo_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id = photo_groups.id AND a.photo_id = photo_groups.best_photo_id
           AND p.is_present = 1
       )`,
  );
  await txn.runAsync(
    `DELETE FROM photo_groups
     WHERE (SELECT COUNT(*) FROM photo_group_assignments a WHERE a.group_id = photo_groups.id) = 0`,
  );
}

export async function makePhotoSingles(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  /** The group the USER was looking at — a background rescan can rebuild
   * an all-unreviewed group between render and tap; ejecting from the
   * wrong group (and user_single-freezing its unseen survivor) must
   * abort whole instead. Omit for callers without a group context. */
  expectedGroupId?: number,
): Promise<void> {
  if (assetIds.length === 0) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (expectedGroupId !== undefined) {
      const rows = await txn.getAllAsync<{ photo_id: string }>(
        `SELECT a.photo_id FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id = ? AND a.photo_id IN (${assetIds.map(() => '?').join(',')})
           -- An absent member must not become user_single: a Gallery
           -- restore would honor the flag and never regroup it.
           AND p.is_present = 1`,
        expectedGroupId,
        ...assetIds,
      );
      if (rows.length !== assetIds.length) {
        throw new Error('This group changed while reviewing — reopen it and try again.');
      }
    }
    await applyPhotoSingles(txn, assetIds);
  });
}

// --------------------------------------------- m0.8 DB-backed review reads

/** One member of a review group (durable truth join). */
export interface ReviewMemberRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  state: PhotoState;
  needs_edit: number;
  time_attached: number;
}

/** One reviewable cull group from the continuous grouping run. */
export interface ReviewGroupRow {
  groupId: number;
  bestPhotoId: string | null;
  /** Chronological members, all states (the deck badges non-unreviewed). */
  members: ReviewMemberRow[];
}

/**
 * The review queue: groups that still hold at least one unreviewed,
 * present member, newest group first (continuous scan fills newest-first,
 * so review starts with the most recent shots). `limit` bounds the page.
 */
async function listReviewGroupsIn(
  txn: SQLiteDatabase,
  limit: number,
  roots: readonly string[] | null,
): Promise<ReviewGroupRow[]> {
  // The source filter gates which groups QUEUE (a pending in-source
  // member); a queued group still shows all its members — the deck always
  // works on whole groups.
  const src = sourceClause(roots, 'p.uri');
  {
    const groups = await txn.getAllAsync<{
      id: number;
      best_photo_id: string | null;
      newest: number;
    }>(
      `SELECT g.id, g.best_photo_id,
            (SELECT MAX(p.taken_at) FROM photo_group_assignments a
              JOIN photos p ON p.asset_id = a.photo_id
              WHERE a.group_id = g.id AND p.is_present = 1) AS newest
     FROM photo_groups g
     WHERE EXISTS (
       SELECT 1 FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id = g.id AND p.state = 'unreviewed' AND p.is_present = 1${src.sql}
     )
     ORDER BY newest DESC
     LIMIT ?`,
      ...src.params,
      limit,
    );
    if (groups.length === 0) return [];
    const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
      `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.state, p.needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IN (${groups.map(() => '?').join(',')}) AND p.is_present = 1
       ORDER BY p.taken_at ASC, p.asset_id ASC`,
      ...groups.map((g) => g.id),
    );
    const byGroup = new Map<number, ReviewMemberRow[]>();
    for (const m of members) {
      const bucket = byGroup.get(Number(m.group_id));
      const row: ReviewMemberRow = {
        asset_id: m.asset_id,
        uri: m.uri,
        taken_at: m.taken_at,
        state: m.state,
        needs_edit: m.needs_edit,
        time_attached: m.time_attached,
      };
      if (bucket) bucket.push(row);
      else byGroup.set(Number(m.group_id), [row]);
    }
    return groups.map((g) => ({
      groupId: Number(g.id),
      bestPhotoId: g.best_photo_id,
      members: byGroup.get(Number(g.id)) ?? [],
    }));
  }
}

/** Public wrapper: headers and members read from ONE exclusive snapshot —
 * a scan window committing between the split queries could return
 * obsolete groups with empty member lists (blank deck). */
export async function listReviewGroups(
  db: SQLiteDatabase,
  limit: number,
  roots: readonly string[] | null = null,
): Promise<ReviewGroupRow[]> {
  let out: ReviewGroupRow[] = [];
  await db.withExclusiveTransactionAsync(async (txn) => {
    out = await listReviewGroupsIn(txn, limit, roots);
  });
  return out;
}

/**
 * One group by id regardless of completion (browse/re-decide of a
 * finished group — gate 5); null when the group no longer exists or has
 * no present members.
 */
export async function getReviewGroup(
  db: SQLiteDatabase,
  groupId: number,
): Promise<ReviewGroupRow | null> {
  // One snapshot for header + members (same race as listReviewGroups).
  let out: ReviewGroupRow | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const group = await txn.getFirstAsync<{ id: number; best_photo_id: string | null }>(
      'SELECT id, best_photo_id FROM photo_groups WHERE id = ?',
      groupId,
    );
    if (!group) return;
    const members = await txn.getAllAsync<ReviewMemberRow>(
      `SELECT p.asset_id, p.uri, p.taken_at, p.state, p.needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id = ? AND p.is_present = 1
       ORDER BY p.taken_at ASC, p.asset_id ASC`,
      groupId,
    );
    if (members.length === 0) return;
    out = { groupId: Number(group.id), bestPhotoId: group.best_photo_id, members };
  });
  return out;
}

/**
 * The singles feed (gate 5): unreviewed present singles PLUS staged
 * culls — a culled single stays in the feed badged with its verdict
 * until the final delete confirmation, so re-deciding never needs a
 * detour through the cull list. Newest first.
 */
async function listSinglesFeedIn(
  txn: SQLiteDatabase,
  limit: number,
  roots: readonly string[] | null,
): Promise<ReviewMemberRow[]> {
  const src = sourceClause(roots, 'p.uri');
  return txn.getAllAsync<ReviewMemberRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.state, p.needs_edit, a.time_attached
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NULL AND p.state IN ('unreviewed', 'culled') AND p.is_present = 1${src.sql}
     ORDER BY p.taken_at DESC, p.asset_id DESC
     LIMIT ?`,
    ...src.params,
    limit,
  );
}

/** Public wrapper (tests, ad-hoc reads); ReviewContext uses
 * readReviewQueue for a cross-slice snapshot. */
export async function listSinglesFeed(
  db: SQLiteDatabase,
  limit: number,
  roots: readonly string[] | null = null,
): Promise<ReviewMemberRow[]> {
  return listSinglesFeedIn(db, limit, roots);
}

/**
 * Every group with a present member taken on the given local day, newest
 * first, completion state irrespective — a completed day re-shows its
 * groups for browse/re-decide (gate 5). Members outside the day ride
 * along (groups may span midnight; the deck always shows whole groups).
 */
export async function listGroupsForDay(
  db: SQLiteDatabase,
  day: string,
  roots: readonly string[] | null = null,
): Promise<ReviewGroupRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const dayPredicate = day === UNDATED_DAY_KEY ? 'p.day IS NULL' : 'p.day = ?';
  const ids = await db.getAllAsync<{ group_id: number }>(
    `SELECT DISTINCT a.group_id FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NOT NULL AND ${dayPredicate} AND p.is_present = 1${src.sql}`,
    ...(day === UNDATED_DAY_KEY ? [] : [day]),
    ...src.params,
  );
  // Sequential: each getReviewGroup opens its own snapshot transaction —
  // interleaving them via Promise.all would nest transactions.
  const groups: ReviewGroupRow[] = [];
  for (const r of ids) {
    const group = await getReviewGroup(db, Number(r.group_id));
    if (group) groups.push(group);
  }
  // Members are chronologically ASCENDING — newest-first ordering keys
  // on each group's LAST member.
  const newest = (g: ReviewGroupRow): number => g.members[g.members.length - 1]?.taken_at ?? 0;
  return groups.sort((a, b) => newest(b) - newest(a));
}

/** Everything the standard photo viewer's detail panel shows for one
 * photo (gate 5); null when the photo was never tracked. */
export interface PhotoFacts {
  asset_id: string;
  uri: string;
  taken_at: number;
  state: PhotoState;
  needs_edit: number;
  favourite_state: FavouriteState;
  organize_state: string;
  organize_applied_at: number | null;
  reviewed_at: number | null;
  /** Last completed edit-queue cycle (durable marker). */
  edit_completed_at: number | null;
  /** Continuous group membership (null = single). */
  group_id: number | null;
  /** Grouped by time only — embedding missing (decision 5). */
  time_attached: number;
  /** User ejected it from a group ("Not related"). */
  user_single: number;
  /** This photo is its group's starred best. */
  is_best: number;
}

export async function getPhotoFacts(
  db: SQLiteDatabase,
  assetId: string,
): Promise<PhotoFacts | null> {
  return db.getFirstAsync<PhotoFacts>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.state, p.needs_edit, p.favourite_state,
            p.organize_state, p.organize_applied_at, p.reviewed_at, p.edit_completed_at,
            a.group_id, COALESCE(a.time_attached, 0) AS time_attached,
            COALESCE(a.user_single, 0) AS user_single,
            CASE WHEN g.best_photo_id = p.asset_id THEN 1 ELSE 0 END AS is_best
     FROM photos p
     LEFT JOIN photo_group_assignments a ON a.photo_id = p.asset_id
     LEFT JOIN photo_groups g ON g.id = a.group_id
     WHERE p.asset_id = ?`,
    assetId,
  );
}

/**
 * State-aware RE-decision on an already-decided photo (gate 5 browse,
 * cull-list sheet) — the initial-decision verdict path deliberately
 * honors the needs-edit flag and first-entry cycle stamps, which is
 * wrong for an explicit change of mind:
 * - keep: done + flag CLEARED (an explicit Keep overrides the flag; the
 *   initial path would bounce a flagged photo straight back to to_edit)
 *   with the abandoned cycle's baseline reset;
 * - to_edit: a FRESH edit cycle (unconditional to_edit_at + baseline
 *   reset — reusing a completed cycle's stamp would let stale detection
 *   evidence auto-complete the new cycle).
 * Both targets resolve pending edited-copy matches (C#12: an explicit
 * keep/to-edit answers the copy prompt). Only decided states transition;
 * an unreviewed photo takes the normal verdict path instead.
 */
export async function applyRedecision(
  db: SQLiteDatabase,
  assetId: string,
  target: 'keep' | 'to_edit',
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (target === 'keep') {
      await txn.runAsync(
        `UPDATE photos SET state = 'done', needs_edit = 0,
           to_edit_at = NULL, mod_time = NULL, content_hash = NULL,
           reviewed_at = COALESCE(reviewed_at, ?), activity_at = ?
         WHERE asset_id = ? AND state IN ('culled', 'to_edit')`,
        at,
        at,
        assetId,
      );
    } else {
      await txn.runAsync(
        `UPDATE photos SET state = 'to_edit', needs_edit = 1,
           to_edit_at = ?, mod_time = NULL, content_hash = NULL,
           reviewed_at = COALESCE(reviewed_at, ?), activity_at = ?
         WHERE asset_id = ? AND state IN ('culled', 'done')`,
        at,
        at,
        at,
        assetId,
      );
    }
    await txn.runAsync(
      "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
      assetId,
    );
  });
}

/** Star/unstar a group's best (NULL clears; FK enforces membership). A
 * warm scan can rebuild an unreviewed group under a new id between
 * render and tap — a zero-row update is a STALE write and rejects, like
 * the compare and ejection paths. */
export async function setGroupBest(
  db: SQLiteDatabase,
  groupId: number,
  bestPhotoId: string | null,
): Promise<void> {
  // A non-null best must be a PRESENT, reviewable member — reconciliation
  // keeps an absent member's assignment (only clearing its star), and the
  // deferred FK would accept it, re-freezing the group around an
  // unavailable photo.
  const result =
    bestPhotoId === null
      ? await db.runAsync('UPDATE photo_groups SET best_photo_id = NULL WHERE id = ?', groupId)
      : await db.runAsync(
          `UPDATE photo_groups SET best_photo_id = ?
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM photo_group_assignments a
             JOIN photos p ON p.asset_id = a.photo_id
             WHERE a.group_id = photo_groups.id AND a.photo_id = ?
               AND p.is_present = 1
               AND p.state NOT IN ('culled', 'confirmed', 'trashed')
           )`,
          bestPhotoId,
          groupId,
          bestPhotoId,
        );
  if (Number(result.changes) === 0) {
    throw new Error('This group changed while reviewing — reopen it and try again.');
  }
}

/** Home CTA counts: unreviewed present photos in groups / as singles. */
async function countReviewQueueIn(
  txn: SQLiteDatabase,
  roots: readonly string[] | null,
): Promise<{ grouped: number; singles: number }> {
  const src = sourceClause(roots, 'p.uri');
  const row = await txn.getFirstAsync<{ grouped: number; singles: number }>(
    `SELECT
       SUM(CASE WHEN a.group_id IS NOT NULL THEN 1 ELSE 0 END) AS grouped,
       SUM(CASE WHEN a.group_id IS NULL THEN 1 ELSE 0 END) AS singles
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE p.state = 'unreviewed' AND p.is_present = 1${src.sql}`,
    ...src.params,
  );
  return { grouped: row?.grouped ?? 0, singles: row?.singles ?? 0 };
}

/** Public wrapper (Home CTA counts outside the queue snapshot). */
export async function countReviewQueue(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<{ grouped: number; singles: number }> {
  return countReviewQueueIn(db, roots);
}

/** THE queue read (gate 5 + final review): groups, singles feed, and
 * counts from ONE exclusive snapshot — a scan window committing between
 * independent reads could cache a photo as both grouped and single, or
 * counts disagreeing with the arrays. */
export async function readReviewQueue(
  db: SQLiteDatabase,
  groupLimit: number,
  singlesLimit: number,
  roots: readonly string[] | null = null,
): Promise<{
  groups: ReviewGroupRow[];
  singles: ReviewMemberRow[];
  counts: { grouped: number; singles: number };
}> {
  let out: {
    groups: ReviewGroupRow[];
    singles: ReviewMemberRow[];
    counts: { grouped: number; singles: number };
  } = { groups: [], singles: [], counts: { grouped: 0, singles: 0 } };
  await db.withExclusiveTransactionAsync(async (txn) => {
    out = {
      groups: await listReviewGroupsIn(txn, groupLimit, roots),
      singles: await listSinglesFeedIn(txn, singlesLimit, roots),
      counts: await countReviewQueueIn(txn, roots),
    };
  });
  return out;
}

/** Reviewed-photo counts per local day (first-review stamps; the daily
 * goal and streaks read these — decision 4). */
export async function getReviewedCountsByDay(
  db: SQLiteDatabase,
  sinceDay: string,
): Promise<Map<string, number>> {
  const rows = await db.getAllAsync<{ day: string; n: number }>(
    `SELECT date(reviewed_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
     FROM photos WHERE reviewed_at IS NOT NULL
     GROUP BY day HAVING day >= ?`,
    sinceDay,
  );
  return new Map(rows.map((r) => [r.day, r.n]));
}

/** Home corpus stats: groups found + rows with a CURRENT verdict (a
 * cleared verdict returns to the pending pool even though reviewed_at
 * stays first-stamped for lifetime stats). */
export async function getCorpusStats(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<{ groupsFound: number; reviewed: number }> {
  const src = sourceClause(roots, 'p.uri');
  const row = await db.getFirstAsync<{ groups: number; reviewed: number }>(
    `SELECT
       (SELECT COUNT(DISTINCT a.group_id) FROM photo_group_assignments a
        JOIN photos p ON p.asset_id = a.photo_id
        WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}) AS groups,
       (SELECT COUNT(*) FROM photos p
        -- Home's denominator is the current MediaStore corpus — count
        -- only verdicts on PRESENT photos (trashed/removed rows left it).
        WHERE p.state IN ('done', 'to_edit', 'culled', 'confirmed')
          AND p.is_present = 1${src.sql}) AS reviewed`,
    ...src.params,
    ...src.params,
  );
  return { groupsFound: row?.groups ?? 0, reviewed: row?.reviewed ?? 0 };
}

/**
 * Decision 5's explicit opt-in "regroup everything not yet done": drop
 * the assignments of photos that are unreviewed AND not user-ejected —
 * the next scan rebuilds them under the new grouping settings. Reviewed
 * groups and user singles stay untouched (the regroup boundary would
 * freeze them anyway; deleting their assignments would lose membership).
 */
async function resetUnreviewedGroupsIn(txn: SQLiteDatabase): Promise<void> {
  {
    // A group with ANY reviewed member — or GROUP-LEVEL metadata (starred
    // best, recorded duels) — is frozen WHOLE by the regroup boundary;
    // deleting its members here would dissolve it and lose the star and
    // orphan the duels. Reset only fully-unreviewed metadata-free groups
    // and non-ejected singles.
    await txn.runAsync(
      `DELETE FROM photo_group_assignments
       WHERE user_single = 0
         AND photo_id IN (SELECT asset_id FROM photos WHERE state = 'unreviewed')
         AND (group_id IS NULL OR (
           group_id NOT IN (
             SELECT a2.group_id FROM photo_group_assignments a2
             JOIN photos p2 ON p2.asset_id = a2.photo_id
             WHERE a2.group_id IS NOT NULL AND p2.state <> 'unreviewed'
           )
           AND group_id NOT IN (
             SELECT id FROM photo_groups
             WHERE best_photo_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM duels d WHERE d.group_id = CAST(photo_groups.id AS TEXT))
           )
         ))`,
    );
    await repairGroupMembership(txn);
  }
}

/** Public wrapper (tests). */
export async function resetUnreviewedGroups(db: SQLiteDatabase): Promise<void> {
  await db.withExclusiveTransactionAsync((txn) => resetUnreviewedGroupsIn(txn));
}

/**
 * A grouping-relevant setting change (photo source, strictness) and its
 * unfrozen-assignment reset commit in ONE exclusive transaction — a
 * process death between them would leave the next launch rendering old
 * assignments under the new scope (whole-group rendering could expose
 * excluded members whose decisions freeze stale membership). `value =
 * null` deletes the row (an unset source keeps its dynamic default).
 */
export async function applyGroupingSettingChange(
  db: SQLiteDatabase,
  key: string,
  value: string | null,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (value === null) {
      await txn.runAsync('DELETE FROM settings WHERE key = ?', key);
    } else {
      await txn.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
    }
    await resetUnreviewedGroupsIn(txn);
  });
}

/** Among the given groups, those carrying GROUP-LEVEL review metadata —
 * a starred best or recorded duels — which freezes them whole against
 * regroup rewrites even while every member is still unreviewed. */
export async function getMetadataGroupIds(
  db: SQLiteDatabase,
  groupIds: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  for (const ids of chunk(groupIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const rows = await db.getAllAsync<{ id: number }>(
      `SELECT id FROM photo_groups
       WHERE id IN (${ids.map(() => '?').join(',')})
         AND (best_photo_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM duels d WHERE d.group_id = CAST(photo_groups.id AS TEXT)))`,
      ...ids,
    );
    for (const row of rows) out.add(Number(row.id));
  }
  return out;
}

/** Alive tracked undated photos (the Unknown-day pseudo-day's
 * "MediaStore total" equivalent — MediaStore cannot be queried for
 * missing DATE_TAKEN, and the scan is the only review ingress, so the
 * tracked rows ARE the population). */
export async function countUndatedAlive(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<number> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos
     WHERE day IS NULL AND is_present = 1${src.sql}`,
    ...src.params,
  );
  return row?.n ?? 0;
}

/** Refresh a photo's uri after it moved WITHOUT changing MediaStore id
 * (scan reconciliation: present-but-unseen assets) — source-scoped reads
 * key on the uri, so a stale path would surface an out-of-scope photo
 * (often with a dead file uri) indefinitely. */
export async function updatePhotoUri(
  db: SQLiteDatabase,
  assetId: string,
  uri: string,
): Promise<void> {
  await db.runAsync('UPDATE photos SET uri = ? WHERE asset_id = ?', uri, assetId);
}

/** Present tracked asset ids inside the source scope — the scan's
 * completion reconciliation diffs these against what it actually saw. */
export async function getPresentAssetIds(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<string[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ asset_id: string }>(
    `SELECT asset_id FROM photos WHERE is_present = 1${src.sql}`,
    ...src.params,
  );
  return rows.map((r) => r.asset_id);
}

/** One photo row the continuous scan upserts (m0.8 gate 2). */
export interface ContinuousPhotoUpsert {
  assetId: string;
  uri: string;
  takenAt: number;
  modTime: number;
  /** Local day key — NULL for UNDATED photos (no DATE_TAKEN): their
   * taken_at is only the mtime fallback, and finite MediaStore day/range
   * queries exclude them, so the DB day surfaces must too. They stay
   * fully reviewable via the queue and all-photos surfaces. */
  day: string | null;
  volumeName: string;
  rawId: string;
}

/** One group's continuous-scan write (post-reconciliation). */
export interface ContinuousGroupWrite {
  members: readonly string[];
  /** Members grouped by time because their embedding was unavailable. */
  timeAttached: readonly string[];
}

/** One grouped window's membership writes (post-reconciliation). */
export interface ContinuousWindowWrite {
  /** Every window photo — row upsert only; review state is never touched. */
  photos: readonly ContinuousPhotoUpsert[];
  /** Multi-photo groups to (re)assign. */
  groups: readonly ContinuousGroupWrite[];
  /** Photos to (re)assign as singles (NULL group). */
  singles: readonly string[];
}

/** The scan-owned grouping run's id, creating it on first use. */
async function ensureContinuousRun(txn: SQLiteDatabase, at: number): Promise<number> {
  const existing = await txn.getFirstAsync<{ id: number }>(
    "SELECT id FROM grouping_runs WHERE provenance = 'continuous'",
  );
  if (existing) return Number(existing.id);
  const result = await txn.runAsync(
    `INSERT INTO grouping_runs (provenance, created_at) VALUES ('continuous', ?)`,
    at,
  );
  return Number(result.lastInsertRowId);
}

/**
 * Persist one grouped scan window (m0.8 gate 2) atomically: upsert the
 * photo rows (identity/metadata only — an existing row's review state,
 * queues, and flags are never modified), then write the given group and
 * single assignments into the one 'continuous' grouping run, then run
 * the shared membership repairs. Photos in `photos` but in neither
 * `groups` nor `singles` were frozen by the regroup boundary
 * (reconcileWindowGroups) and keep their existing assignments.
 *
 */
export async function writeContinuousGroups(
  db: SQLiteDatabase,
  write: ContinuousWindowWrite,
  at: number,
  /** Checked INSIDE the exclusive transaction: a scan window whose
   * settings were superseded mid-embed must not commit after the reset
   * cleared the queue (entry-time fences alone leave that race open). */
  options: { abortIf?: () => boolean } = {},
): Promise<void> {
  if (write.photos.length === 0) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (options.abortIf?.()) return;
    // A scanned photo EXISTS in MediaStore — authoritative presence. A row
    // still marked trashed was restored outside Afterglow (Gallery
    // "Restore"); apply the standard restore transition (same semantics as
    // trashStore.markPhotoRestored: back to review, generation bump so a
    // later verified re-trash counts again, fresh edit-cycle baseline).
    for (const ids of chunk(
      write.photos.map((p) => p.assetId),
      IN_CHUNK,
    )) {
      if (ids.length === 0) continue;
      await txn.runAsync(
        `UPDATE photos SET state = 'unreviewed', is_present = 1,
           trash_generation = trash_generation + 1,
           to_edit_at = NULL, mod_time = NULL, content_hash = NULL,
           activity_at = ?
         WHERE asset_id IN (${ids.map(() => '?').join(',')}) AND state = 'trashed'`,
        at,
        ...ids,
      );
    }
    for (const photo of write.photos) {
      await txn.runAsync(
        `INSERT INTO photos (asset_id, uri, taken_at, state, mod_time, day,
                             volume_name, raw_id)
         VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           uri = excluded.uri,
           taken_at = excluded.taken_at,
           -- photos.mod_time is the in-place edit detector's baseline
           -- while a row is in an edit cycle: refreshing it here would
           -- make the pending edit look unchanged (silent detection loss).
           mod_time = CASE WHEN photos.state = 'to_edit'
                           THEN photos.mod_time ELSE excluded.mod_time END,
           day = excluded.day,
           volume_name = excluded.volume_name,
           raw_id = excluded.raw_id`,
        photo.assetId,
        photo.uri,
        photo.takenAt,
        photo.modTime,
        photo.day,
        photo.volumeName,
        photo.rawId,
      );
    }
    // Revalidate the plan INSIDE the transaction: the runner computed it
    // from reads that predate this write, and a review decision can land
    // in between (the scan runs in the background). Fresh state/assignment
    // reads + the same pure freeze rules decide what may still be written.
    const plannedIds = [
      ...new Set([...write.groups.flatMap((g) => [...g.members]), ...write.singles]),
    ];
    const liveAssignments = await getGroupAssignments(txn, plannedIds);
    const liveTouched = [
      ...new Set(
        [...liveAssignments.values()].map((a) => a.groupId).filter((g): g is number => g !== null),
      ),
    ];
    const liveMembers = await getGroupMembers(txn, liveTouched);
    const liveStateIds = new Set(plannedIds);
    for (const memberIds of liveMembers.values()) for (const m of memberIds) liveStateIds.add(m);
    const liveStates = await getStatesForAssets(txn, [...liveStateIds]);
    const frozen = frozenPhotos(plannedIds, {
      states: liveStates,
      assignments: liveAssignments,
      groupMembers: liveMembers,
      metadataGroups: await getMetadataGroupIds(txn, [...liveMembers.keys()]),
    });
    const plan = reconcileWindowGroups(
      [...write.groups, ...write.singles.map((s) => ({ members: [s], timeAttached: [] }))],
      frozen,
    );

    const runId = await ensureContinuousRun(txn, at);
    for (const group of plan.groups) {
      const groupResult = await txn.runAsync(
        'INSERT INTO photo_groups (run_id, best_photo_id) VALUES (?, NULL)',
        runId,
      );
      const groupId = Number(groupResult.lastInsertRowId);
      const timeAttached = new Set(group.timeAttached);
      for (const assetId of group.members) {
        await txn.runAsync(
          `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
           VALUES (?, ?, ?, ?)`,
          assetId,
          runId,
          groupId,
          timeAttached.has(assetId) ? 1 : 0,
        );
      }
    }
    for (const assetId of plan.singles) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
         VALUES (?, ?, NULL, 0)`,
        assetId,
        runId,
      );
    }
    await repairGroupMembership(txn);
  });
}

/** One photo's current durable group assignment. */
export interface GroupAssignmentRow {
  /** null = assigned single. */
  groupId: number | null;
  /** The USER ejected this photo to singles — never regroup it. */
  userSingle: boolean;
}

/** Current durable group membership for the given photos (missing = no
 * assignment yet). */
export async function getGroupAssignments(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, GroupAssignmentRow>> {
  const out = new Map<string, GroupAssignmentRow>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{
      photo_id: string;
      group_id: number | null;
      user_single: number;
    }>(
      `SELECT photo_id, group_id, user_single FROM photo_group_assignments
       WHERE photo_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows)
      out.set(row.photo_id, {
        groupId: row.group_id === null ? null : Number(row.group_id),
        userSingle: row.user_single === 1,
      });
  }
  return out;
}

/** All members of the given groups (regroup-boundary freeze checks). */
export async function getGroupMembers(
  db: SQLiteDatabase,
  groupIds: readonly number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const ids of chunk(groupIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ photo_id: string; group_id: number }>(
      `SELECT photo_id, group_id FROM photo_group_assignments
       WHERE group_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      const gid = Number(row.group_id);
      const bucket = out.get(gid);
      if (bucket) bucket.push(row.photo_id);
      else out.set(gid, [row.photo_id]);
    }
  }
  return out;
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
 * Asset ids that are TRACKED for edited-copy detection: a row exists and
 * has been touched by review (any state change or decision stamps
 * activity_at). Rows the continuous scan created but nobody reviewed
 * (state 'unreviewed', activity_at NULL) do NOT count — in the m0.8
 * continuous world every photo gets a row within seconds of appearing,
 * so "row exists" would blind the detector to freshly saved editor
 * copies (m0.8 gate-2 review finding).
 */
export async function getDetectionTrackedAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string }>(
      `SELECT asset_id FROM photos
       WHERE asset_id IN (${placeholders})
         AND NOT (state = 'unreviewed' AND activity_at IS NULL)`,
      ...ids,
    );
    for (const row of rows) out.add(row.asset_id);
  }
  return out;
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
    // The continuous scan may have inserted the copy's row first (scan-only:
    // unreviewed, no activity); flip exactly those to done — a row a user
    // already touched never gets clobbered (it was not a candidate anyway).
    const upsert = await txn.runAsync(
      `INSERT INTO photos
         (asset_id, uri, taken_at, state, mod_time, day, needs_edit, edit_completed_at, reviewed_at, activity_at)
       VALUES (?, ?, ?, 'done', ?, ?, 0, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         state = 'done',
         needs_edit = 0,
         edit_completed_at = excluded.edit_completed_at,
         reviewed_at = excluded.reviewed_at,
         activity_at = excluded.activity_at
       WHERE photos.state = 'unreviewed' AND photos.activity_at IS NULL`,
      copy.assetId,
      copy.uri,
      copy.takenAt,
      copy.modTime,
      copy.day,
      detectedAt,
      detectedAt,
      detectedAt,
    );
    if (Number(upsert.changes) === 0) {
      // The guarded upsert lost its race — the user touched the copy row
      // between candidate filtering and this transaction. Recording the
      // match anyway would emit a pending prompt for a reviewed photo.
      return;
    }
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
      ? "AND state = 'done' AND needs_edit = 0"
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
    `SELECT state,
            EXISTS (SELECT 1 FROM photo_group_assignments a
                    WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped,
            COUNT(*) AS n
     FROM photos WHERE ${where.sql}${src.sql} GROUP BY state, grouped`,
    ...where.params,
    ...src.params,
  );
  const counts: StateCounts = {
    unreviewedGrouped: 0,
    unreviewedSingle: 0,
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
      `SELECT asset_id, state,
              EXISTS (SELECT 1 FROM photo_group_assignments a
                      WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped
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
const GRID_FILTER_SQL: Record<
  'in_group' | 'to_edit' | 'staged' | 'done' | 'all' | 'unreviewed',
  string
> = {
  // 'all'/'unreviewed' are DB-backed ONLY for the Unknown-day pseudo-day
  // (its photos cannot be paged from MediaStore; the tracked rows are the
  // complete population there).
  all: "state <> 'trashed'",
  unreviewed:
    "state = 'unreviewed' AND NOT EXISTS (SELECT 1 FROM photo_group_assignments a " +
    'WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL)',
  in_group:
    "state = 'unreviewed' AND EXISTS (SELECT 1 FROM photo_group_assignments a " +
    'WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL)',
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
    `SELECT asset_id, uri, taken_at, state,
            EXISTS (SELECT 1 FROM photo_group_assignments a
                    WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped
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
 * "Restore to unreviewed" for a staged cull: back to the review pool,
 * resetting the edit-cycle baseline like every other return to
 * 'unreviewed'. CullList's explicit Restore resolves any pending
 * edited-copy match (C#12 — the user handled the photo); the re-decide
 * sheet's tap-to-clear passes resolvePendingMatches=false — going back
 * to unreviewed answers nothing, and the prompt must survive.
 */
export async function restoreCarriedCull(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
  resolvePendingMatches = true,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `UPDATE photos SET state = 'unreviewed',
         to_edit_at = NULL, mod_time = NULL, content_hash = NULL, needs_edit = 0,
         activity_at = ?
       WHERE asset_id = ? AND state = 'culled'`,
      at,
      assetId,
    );
    if (resolvePendingMatches) {
      await txn.runAsync(
        "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
        assetId,
      );
    }
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
  /** Stars the staging cleared (edited-copy cancel, round 31) — restored
   * in THIS transaction so a crash between the two writes cannot lose
   * them (clearedStars lives only in memory). Best-effort per star: the
   * group must still exist with this photo as a present member. */
  restoreStars: readonly { groupId: number; photoId: string }[] = [],
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `UPDATE photos
       SET state = CASE WHEN needs_edit = 1 THEN 'to_edit' ELSE 'done' END,
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
    for (const star of restoreStars) {
      // Same validity guard as setGroupBest; a changed group skips
      // silently (best-effort restore of the user's prior star).
      await txn.runAsync(
        `UPDATE photo_groups SET best_photo_id = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
           WHERE a.group_id = photo_groups.id AND a.photo_id = ?
             AND p.is_present = 1
             AND p.state NOT IN ('culled', 'confirmed', 'trashed')
         )`,
        star.photoId,
        star.groupId,
        star.photoId,
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

const DAY_SUMMARY_SELECT = `SELECT day,
            COUNT(*) AS tracked,
            SUM(CASE WHEN state IN ('done', 'trashed') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
            SUM(CASE WHEN state = 'to_edit' THEN 1 ELSE 0 END) AS toEdit,
            SUM(CASE WHEN state IN ('culled', 'confirmed') THEN 1 ELSE 0 END) AS staged
     FROM photos WHERE day IS NOT NULL`;

/** What was DECIDED on one local day (Summary "done for today"): counts
 * by current state over photos whose first review stamp fell that day —
 * capture-day rollups miss older photos reviewed today. */
export async function getDayReviewSummary(
  db: SQLiteDatabase,
  day: string,
): Promise<{ reviewed: number; done: number; staged: number; trashed: number }> {
  const row = await db.getFirstAsync<{
    reviewed: number;
    done: number;
    staged: number;
    trashed: number;
  }>(
    `SELECT COUNT(*) AS reviewed,
            SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN state IN ('culled', 'confirmed') THEN 1 ELSE 0 END) AS staged,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed
     FROM photos
     WHERE reviewed_at IS NOT NULL
       AND date(reviewed_at / 1000, 'unixepoch', 'localtime') = ?`,
    day,
  );
  return {
    reviewed: row?.reviewed ?? 0,
    done: row?.done ?? 0,
    staged: row?.staged ?? 0,
    trashed: row?.trashed ?? 0,
  };
}

/** Per-day rollups for every day >= sinceDay that has tracked photos. */
export async function getDaySummaries(
  db: SQLiteDatabase,
  sinceDay: string,
  roots: readonly string[] | null = null,
): Promise<Map<string, DaySummaryRow>> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<DaySummaryRow>(
    `${DAY_SUMMARY_SELECT} AND day >= ?${src.sql} GROUP BY day`,
    sinceDay,
    ...src.params,
  );
  return new Map(rows.map((r) => [r.day, r]));
}

/** Per-day rollups for an explicit day list (gate 5's unreviewed-day
 * rows sit outside any contiguous recent window). */
export async function getDaySummariesForDays(
  db: SQLiteDatabase,
  days: readonly string[],
  roots: readonly string[] | null = null,
): Promise<Map<string, DaySummaryRow>> {
  if (days.length === 0) return new Map();
  const src = sourceClause(roots);
  const dated = days.filter((d) => d !== UNDATED_DAY_KEY);
  const out = new Map<string, DaySummaryRow>();
  if (dated.length > 0) {
    const rows = await db.getAllAsync<DaySummaryRow>(
      `${DAY_SUMMARY_SELECT} AND day IN (${dated.map(() => '?').join(',')})${src.sql} GROUP BY day`,
      ...dated,
      ...src.params,
    );
    for (const r of rows) out.set(r.day, r);
  }
  if (days.includes(UNDATED_DAY_KEY)) {
    const row = await db.getFirstAsync<Omit<DaySummaryRow, 'day'>>(
      `SELECT COUNT(*) AS tracked,
              SUM(CASE WHEN state IN ('done', 'trashed') THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
              SUM(CASE WHEN state = 'to_edit' THEN 1 ELSE 0 END) AS toEdit,
              SUM(CASE WHEN state IN ('culled', 'confirmed') THEN 1 ELSE 0 END) AS staged
       FROM photos WHERE day IS NULL${src.sql}`,
      ...src.params,
    );
    if (row && Number(row.tracked) > 0) out.set(UNDATED_DAY_KEY, { day: UNDATED_DAY_KEY, ...row });
  }
  return out;
}

/** Local days that still hold unreviewed present photos, newest first,
 * with their pending counts (Home's still-unreviewed day rows, gate 5). */
export async function getUnreviewedDayRows(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<{ day: string; pending: number }[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ day: string; pending: number }>(
    `SELECT day, COUNT(*) AS pending FROM photos
     WHERE day IS NOT NULL AND state = 'unreviewed' AND is_present = 1${src.sql}
     GROUP BY day ORDER BY day DESC`,
    ...src.params,
  );
  // The Unknown-day pseudo-day rides along (after the dated days) when
  // undated photos await review.
  const undated = await db.getFirstAsync<{ pending: number }>(
    `SELECT COUNT(*) AS pending FROM photos
     WHERE day IS NULL AND state = 'unreviewed' AND is_present = 1${src.sql}`,
    ...src.params,
  );
  if ((undated?.pending ?? 0) > 0) rows.push({ day: UNDATED_DAY_KEY, pending: undated!.pending });
  return rows;
}

// ------------------------------------------------ favourite queue + lifetime metrics

export interface FavouriteQueueRow {
  asset_id: string;
  uri: string;
  taken_at: number;
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
    `SELECT asset_id, uri, taken_at, favourite_state, favourite_target FROM photos
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
 *   rows (trashStore.lifetimeReclaimedBytes).
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

/** Hash producers — resample differently, never Hamming-compare across
 * sources (schema comment in database.ts). */
export type PhotoHashSource = 'manipulator' | 'native';

/** Cached dHash for one asset (m0.4, photo_hashes table). */
export interface PhotoHashRow {
  asset_id: string;
  hash: string;
  mod_time: number;
  source: PhotoHashSource;
}

/** Cached dHashes for the given assets (missing rows simply absent).
 * `source` is REQUIRED — hashes from different producers are never
 * Hamming-comparable, so every caller states whose hashes it wants. */
export async function getPhotoHashes(
  db: SQLiteDatabase,
  assetIds: readonly string[],
  source: PhotoHashSource,
): Promise<Map<string, PhotoHashRow>> {
  const out = new Map<string, PhotoHashRow>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<PhotoHashRow>(
      `SELECT asset_id, hash, mod_time, source FROM photo_hashes
       WHERE asset_id IN (${placeholders}) AND source = ?`,
      ...ids,
      source,
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
  source: PhotoHashSource,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO photo_hashes (asset_id, hash, mod_time, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       hash = excluded.hash, mod_time = excluded.mod_time, source = excluded.source`,
    assetId,
    hash,
    modTime,
    source,
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
