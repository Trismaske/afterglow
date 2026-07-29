/**
 * Persistence operations over the schema in database.ts.
 * All multi-statement writes run in exclusive transactions.
 *
 * State machine (PLAN.md, m0.2): SQLite `photos.state` is the source of
 * truth and everything converges on 'kept':
 *
 *   unreviewed ──review──┬─▶ culled ─▶ (system trash) ─▶ trashed
 *                        └─▶ kept ──┬─▶ to_edit ─▶ done
 *                                   └─(session finish)─▶ done
 *
 * m0.8: a keep writes 'kept' at swipe time (no kept state); 'kept' +
 * needs_edit = 1 is stored as 'to_edit' — the CASE expressions below keep
 * that invariant no matter which path writes the state. 'confirmed' is
 * deliberately never persisted (m0.1 decision: SQLite keeps 'culled'
 * until the system trash request succeeds).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withReadTransaction, withWriteTransaction } from './database';
import type { DuelRecord, PhotoState } from '@afterglow/core';
import { lifetimeReclaimedBytes } from './trashStore';
import {
  ACTION_KINDS,
  leaveQueue,
  livePhotoClause,
  queuedClause,
  type ActionKind,
} from './actions';
import type { LoadedPhoto } from '../lib/media';
import { frozenPhotos, reconcileWindowGroups } from '../lib/regroupBoundary';
import { sourceLikePattern } from '../lib/sources';
import { rangeOfDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import type { StateCounts } from '../lib/progress';

/** Max ids per IN (...) chunk — stays under SQLite's bind-parameter limit. */
export const IN_CHUNK = 500;

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
 * functions through this union. An open-ended range (`startMs: 0`,
 * `endMs: Infinity`) is the whole tracked corpus — undated photos
 * included, since `taken_at` is NOT NULL (the mtime fallback) even when
 * their `day` is.
 */
export type PhotoScope = { day: string } | { startMs: number; endMs: number };

/** Stable identity string for a scope — the effect-dependency stand-in
 * for the scope object in the progress screens. */
export function scopeKeyOf(scope: PhotoScope): string {
  return 'day' in scope ? `d:${scope.day}` : `r:${scope.startMs}:${scope.endMs}`;
}

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

export function chunk<T>(items: readonly T[], size: number): T[][] {
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

export async function getStagedCulls(
  db: SQLiteDatabase,
  /** Cap the read (m0.8.1). The confirm loop batches at TRASH_BATCH_LIMIT
   * and used to re-read EVERY staged row per batch, then measure a file
   * size for each before the batch discarded all but the first 500 — a
   * 3,000-cull confirm did ~18,000 native stats to trash 3,000 photos. */
  limit?: number,
): Promise<StagedCullRow[]> {
  return db.getAllAsync<StagedCullRow>(
    `SELECT asset_id, uri, taken_at, day FROM photos
     WHERE state = 'culled' AND is_present = 1
     ORDER BY taken_at ASC${limit === undefined ? '' : ' LIMIT ?'}`,
    ...(limit === undefined ? [] : [limit]),
  );
}

/**
 * SQL: is an edit cycle LIVE for this row right now?
 *
 * Correlated on the enclosing statement's `photos` row, so it reads the
 * value as it stands before the update. Used to protect a running edit
 * cycle's detection baseline from verdict writes (see below).
 */
const queuedEditExists = `EXISTS (SELECT 1 FROM photo_actions live_edit
  WHERE live_edit.photo_id = photos.asset_id AND live_edit.kind = 'edit'
    AND live_edit.state IN ('queued', 'error'))`;

/** A direct review VERDICT (layer 1, docs/STATE_MODEL.md). v18: no
 * 'to_edit' — flagging an edit is a pending ACTION and leaves the
 * verdict alone, so the deck writes 'kept' either way. */
export type ReviewVerdict = 'kept' | 'culled' | 'unreviewed';

/**
 * Persist review decisions atomically — verdicts, needs-edit flips,
 * favourite intents, compare records, ejections, and copy-match
 * resolutions in ONE transaction (the m0.7 edit-cycle hardening carried
 * over sessionless):
 *
 * - 'kept'   → state kept; reviewed_at stamps once (first review wins,
 *              survives re-decides so lifetime stats never undercount).
 * - 'culled' → staged cull; reviewed_at + culled_at stamp once.
 * - 'unreviewed' → verdict cleared (re-decide/undo/Restore).
 *
 * v18: edit flags are no longer written here. Queuing or clearing an
 * edit is a photo_actions write (db/actions.ts) and never moves the
 * verdict — the CASE ladders that kept state and needs_edit in lockstep
 * are gone with the column.
 */
export async function applyReviewDecisions(
  db: SQLiteDatabase,
  changes: readonly [assetId: string, verdict: ReviewVerdict][],
  at: number,
  extras: PersistDecisionExtras = {},
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
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
      // v18: the verdict is untouched. Flagging an edit queues an ACTION
      // and resets the detection baseline so the next edit is detected
      // against THIS cycle, not a stale hash from the previous one.
      const flagged = change.needsEdit
        ? await txn.runAsync(
            `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
             SELECT ?, 'edit', 'queued', ?
               FROM photos
              -- A reconciled (absent) row must not gain the flag: a later
              -- Gallery restore would turn an ordinary Keep into an edit.
              WHERE asset_id = ? AND is_present = 1
             ON CONFLICT(photo_id, kind) DO UPDATE SET
               state = 'queued', queued_at = excluded.queued_at`,
            change.assetId,
            at,
            change.assetId,
          )
        : { changes: await leaveQueue(txn, change.assetId, 'edit') };
      if (change.needsEdit) {
        await txn.runAsync(
          `UPDATE photos SET mod_time = NULL, content_hash = NULL, activity_at = ?
            WHERE asset_id = ? AND is_present = 1`,
          at,
          change.assetId,
        );
      }
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
         SET state = ?,
             -- A return to 'unreviewed' resets the edit-cycle baseline so
             -- a later re-flag can never reuse a previous cycle's
             -- detection evidence — UNLESS an edit is queued right now.
             -- v18 made the layers independent, so clearing a verdict no
             -- longer clears the flag: wiping a LIVE cycle's baseline
             -- here would re-baseline against the already-edited file and
             -- silently lose the detection the user is waiting on.
             mod_time = CASE WHEN ? = 'unreviewed' AND NOT ${queuedEditExists}
                             THEN NULL ELSE mod_time END,
             content_hash = CASE WHEN ? = 'unreviewed' AND NOT ${queuedEditExists}
                                 THEN NULL ELSE content_hash END,
             reviewed_at = CASE
               WHEN ? IN ('kept', 'culled') THEN COALESCE(reviewed_at, ?)
               ELSE reviewed_at
             END,
             -- decided_at RE-stamps on every verdict (v15): the daily
             -- goal counts today's reviewing work; a clear keeps the
             -- stamp (the earlier decision still happened).
             decided_at = CASE WHEN ? IN ('kept', 'culled') THEN ? ELSE decided_at END,
             culled_at = CASE WHEN ? = 'culled' THEN COALESCE(culled_at, ?) ELSE culled_at END,
             activity_at = ?
         WHERE asset_id = ?
           -- Externally removed/converged rows reject decisions: a stale
           -- deck tile deciding a reconciled photo would overwrite
           -- 'trashed' and strand it from the scan's restore path.
           AND is_present = 1 AND state <> 'trashed'`,
        verdict,
        verdict,
        verdict,
        verdict,
        at,
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
      // v18: a favourite intent is a photo_actions row like any other
      // action. `target` carries the DIRECTION ('1' apply, '0' remove),
      // which is what made favourite the odd one out before.
      const applied =
        change.target === null
          ? { changes: await leaveQueue(txn, change.assetId, 'favourite') }
          : await txn.runAsync(
              `INSERT INTO photo_actions (photo_id, kind, state, target, queued_at)
               SELECT ?, 'favourite', 'queued', ?, ?
                 FROM photos
                -- Removal cleanup cancelled the row's intents; a stale
                -- tile's toggle must not recreate an impossible gallery
                -- operation.
                WHERE asset_id = ? AND is_present = 1
               ON CONFLICT(photo_id, kind) DO UPDATE SET
                 state = 'queued', target = excluded.target,
                 queued_at = excluded.queued_at`,
              change.assetId,
              change.target ? '1' : '0',
              at,
              change.assetId,
            );
      if (Number(applied.changes) === 0 && changes.length === 0) {
        // A lone favourite toggle on a reconciled photo surfaces like a
        // lone verdict would (batch paths converge on refresh).
        throw new Error('This photo is no longer available — it was removed outside Afterglow.');
      }
      // History is ORDERED BY activity_at and requires it non-null, so a
      // favourite change that does not stamp it lands at a stale
      // position — or never appears at all on a photo nothing else has
      // touched. The pre-v18 column write stamped it; moving the fact
      // into photo_actions must not quietly drop it from the feed.
      await txn.runAsync(
        'UPDATE photos SET activity_at = ? WHERE asset_id = ?',
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
 * Eject photos to durable singles: the explicitly "not related" photo
 * plus the survivor when the group dissolved. Marks user_single so no
 * scan ever regroups them, then runs the shared repairs.
 */
async function applyPhotoSingles(txn: SQLiteDatabase, assetIds: readonly string[]): Promise<void> {
  // The survivor query interpolates the id list THREE times, so batches
  // stay ≤ 300 ids (3 × 300 < SQLite's 999-parameter floor) — the callers
  // used to pass 1-2 ids by discipline, but m0.8.2's batch flows made
  // "the first caller that passes a batch" real (TODO rider). Sequential
  // batches compose: an earlier batch's ejections are already
  // group_id = NULL, so a later batch's survivor count still lands on
  // exactly the member left behind.
  for (const batch of chunk(assetIds, 300)) {
    const placeholders = batch.map(() => '?').join(',');
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
      ...batch,
      ...batch,
      ...batch,
    );
    await txn.runAsync(
      `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0, user_single = 1
       WHERE photo_id IN (${placeholders})`,
      ...batch,
    );
  }
  await repairGroupMembership(txn);
}

/**
 * Queue or clear the "this keeper needs editing" ACTION (v18).
 *
 * The verdict is not touched: wanting an edit was never a change of mind
 * about keeping the photo. Queuing resets the detection baseline
 * (mod_time + content_hash) so the next detected change belongs to THIS
 * edit cycle — the action's `queued_at` is that cycle's key, the role
 * `to_edit_at` used to play.
 */
export async function setNeedsEdit(
  db: SQLiteDatabase,
  assetId: string,
  needsEdit: boolean,
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    if (needsEdit) {
      await txn.runAsync(
        `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
         VALUES (?, 'edit', 'queued', ?)
         ON CONFLICT(photo_id, kind) DO UPDATE SET
           state = 'queued', queued_at = excluded.queued_at`,
        assetId,
        at,
      );
      await txn.runAsync(
        `UPDATE photos SET mod_time = NULL, content_hash = NULL, activity_at = ?
          WHERE asset_id = ?`,
        at,
        assetId,
      );
    } else {
      await leaveQueue(txn, assetId, 'edit');
      await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, assetId);
    }
  });
}

export async function repairGroupMembership(
  txn: SQLiteDatabase,
  groupIds?: readonly number[],
): Promise<void> {
  if (groupIds !== undefined && groupIds.length === 0) return;
  const scopes: (readonly number[] | null)[] =
    groupIds === undefined ? [null] : chunk([...new Set(groupIds)], IN_CHUNK);
  for (const scope of scopes) {
    const inList = scope === null ? '' : `(${scope.map(() => '?').join(',')})`;
    const params = scope === null ? [] : scope;
    await txn.runAsync(
      `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0
       WHERE group_id IN (
         SELECT g.id FROM photo_groups g
         WHERE ${scope === null ? '' : `g.id IN ${inList} AND `}
           (SELECT COUNT(*) FROM photo_group_assignments a
                JOIN photos p ON p.asset_id = a.photo_id
                WHERE a.group_id = g.id AND p.is_present = 1) < 2
       )`,
      ...params,
    );
    await txn.runAsync(
      `UPDATE photo_groups SET best_photo_id = NULL
       WHERE ${scope === null ? '' : `id IN ${inList} AND `}best_photo_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
           WHERE a.group_id = photo_groups.id AND a.photo_id = photo_groups.best_photo_id
             AND p.is_present = 1
         )`,
      ...params,
    );
    await txn.runAsync(
      `DELETE FROM photo_groups
       WHERE ${scope === null ? '' : `id IN ${inList} AND `}
         (SELECT COUNT(*) FROM photo_group_assignments a
          WHERE a.group_id = photo_groups.id) = 0`,
      ...params,
    );
  }
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
  await withWriteTransaction(db, async (txn) => {
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
  /** Local capture-day key (photos.day); null = undated. The timeline
   * splits singles runs on it (lib/timeline.ts). */
  day: string | null;
  state: PhotoState;
  needs_edit: number;
  time_attached: number;
}

/** One reviewable cull group from the continuous grouping run. */
export interface ReviewGroupRow {
  groupId: number;
  bestPhotoId: string | null;
  /** NEWEST-first members, all states (the deck badges non-unreviewed).
   * Every deck reads most-recently-taken first (Tristan, m0.8.2). */
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
    // CROSS JOIN is SQLite's documented join-order hint: the EXISTS must
    // walk THIS group's few assignments and probe photos by primary key.
    // Left to itself the planner started from idx_photos_present_state —
    // every group re-scanning every unreviewed photo, ~200M probes and a
    // 14 s read on a 27k corpus (measured; queuePlan.real.test.ts pins
    // the plan).
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
       SELECT 1 FROM photo_group_assignments a CROSS JOIN photos p
       WHERE a.group_id = g.id AND p.asset_id = a.photo_id
         AND p.state = 'unreviewed' AND p.is_present = 1${src.sql}
     )
     ORDER BY newest DESC
     LIMIT ?`,
      ...src.params,
      limit,
    );
    if (groups.length === 0) return [];
    const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
      `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IN (${groups.map(() => '?').join(',')}) AND p.is_present = 1
       ORDER BY p.taken_at DESC, p.asset_id DESC`,
      ...groups.map((g) => g.id),
    );
    const byGroup = new Map<number, ReviewMemberRow[]>();
    for (const m of members) {
      const bucket = byGroup.get(Number(m.group_id));
      const row: ReviewMemberRow = {
        asset_id: m.asset_id,
        uri: m.uri,
        taken_at: m.taken_at,
        day: m.day,
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
  await withReadTransaction(db, async (txn) => {
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
  await withReadTransaction(db, async (txn) => {
    const group = await txn.getFirstAsync<{ id: number; best_photo_id: string | null }>(
      'SELECT id, best_photo_id FROM photo_groups WHERE id = ?',
      groupId,
    );
    if (!group) return;
    const members = await txn.getAllAsync<ReviewMemberRow>(
      `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id = ? AND p.is_present = 1
       ORDER BY p.taken_at DESC, p.asset_id DESC`,
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
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
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
 * The singles a DECK reviews (m0.8.2 timeline): one local day's
 * ungrouped photos, optionally narrowed to a run's taken_at range,
 * NEWEST first (Tristan's call — groups stay chronological, singles
 * decks read newest-first) — and INCLUDING kept ones. The pending feed
 * drops a kept single (it is no longer to-do), but an open deck keeps
 * every decided photo in place badged (group-deck parity, F10), so deck
 * rows come through this wider predicate: everything but trashed, which
 * never renders on a review surface. The day scope exists because the
 * global feed is a bounded newest-first page — an older day's singles
 * are simply not in it (m0.8.2 day decks), and a run is one day's
 * slice by construction.
 */
export async function listSinglesForDeck(
  db: SQLiteDatabase,
  day: string,
  roots: readonly string[] | null = null,
  range: { from: number; to: number } | null = null,
  limit = 500,
): Promise<ReviewMemberRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const dayPredicate = day === UNDATED_DAY_KEY ? ' AND p.day IS NULL' : ' AND p.day = ?';
  const rangePredicate = range ? ' AND p.taken_at BETWEEN ? AND ?' : '';
  return db.getAllAsync<ReviewMemberRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NULL AND p.state IN ('unreviewed', 'culled', 'kept') AND p.is_present = 1${src.sql}${dayPredicate}${rangePredicate}
     ORDER BY p.taken_at DESC, p.asset_id DESC
     LIMIT ?`,
    ...src.params,
    ...(day === UNDATED_DAY_KEY ? [] : [day]),
    ...(range ? [range.from, range.to] : []),
    limit,
  );
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
  // ONE snapshot for ids + headers + members (m0.8.1 — the previous
  // one-transaction-per-group shape opened a fresh SQLite connection per
  // group, a visible per-day cost on older devices).
  const groups: ReviewGroupRow[] = [];
  await withReadTransaction(db, async (txn) => {
    const ids = await txn.getAllAsync<{ group_id: number }>(
      `SELECT DISTINCT a.group_id FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IS NOT NULL AND ${dayPredicate} AND p.is_present = 1${src.sql}`,
      ...(day === UNDATED_DAY_KEY ? [] : [day]),
      ...src.params,
    );
    for (const batch of chunk(
      ids.map((r) => Number(r.group_id)),
      IN_CHUNK,
    )) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      const headers = await txn.getAllAsync<{ id: number; best_photo_id: string | null }>(
        `SELECT id, best_photo_id FROM photo_groups WHERE id IN (${placeholders})`,
        ...batch,
      );
      const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
        `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
         FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id IN (${placeholders}) AND p.is_present = 1
         ORDER BY p.taken_at DESC, p.asset_id DESC`,
        ...batch,
      );
      const byGroup = new Map<number, ReviewMemberRow[]>();
      for (const m of members) {
        const row: ReviewMemberRow = {
          asset_id: m.asset_id,
          uri: m.uri,
          taken_at: m.taken_at,
          day: m.day,
          state: m.state,
          needs_edit: m.needs_edit,
          time_attached: m.time_attached,
        };
        const bucket = byGroup.get(Number(m.group_id));
        if (bucket) bucket.push(row);
        else byGroup.set(Number(m.group_id), [row]);
      }
      for (const header of headers) {
        const groupMembers = byGroup.get(Number(header.id)) ?? [];
        if (groupMembers.length === 0) continue;
        groups.push({
          groupId: Number(header.id),
          bestPhotoId: header.best_photo_id,
          members: groupMembers,
        });
      }
    }
  });
  // Members are newest-first — ordering keys on each group's FIRST member.
  const newest = (g: ReviewGroupRow): number => g.members[0]?.taken_at ?? 0;
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
  /** Favourite direction currently queued: 1 apply, 0 remove, null none. */
  favourite_queued: number | null;
  /** An organize move is waiting. */
  organize_queued: number;
  /** When the last organize move actually landed. */
  organize_applied_at: number | null;
  reviewed_at: number | null;
  /** Last completed edit cycle (the edit action's resolved_at). */
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
    `SELECT p.asset_id, p.uri, p.taken_at, p.state, p.reviewed_at,
            (EXISTS (SELECT 1 FROM photo_actions e WHERE e.photo_id = p.asset_id
                      AND e.kind = 'edit' AND e.state IN ('queued', 'error'))) AS needs_edit,
            (SELECT CAST(f.target AS INTEGER) FROM photo_actions f
              WHERE f.photo_id = p.asset_id AND f.kind = 'favourite'
                AND f.state IN ('queued', 'error')) AS favourite_queued,
            (EXISTS (SELECT 1 FROM photo_actions o WHERE o.photo_id = p.asset_id
                      AND o.kind = 'organize' AND o.state IN ('queued', 'error')))
              AS organize_queued,
            (SELECT o2.resolved_at FROM photo_actions o2 WHERE o2.photo_id = p.asset_id
              AND o2.kind = 'organize') AS organize_applied_at,
            (SELECT e2.resolved_at FROM photo_actions e2 WHERE e2.photo_id = p.asset_id
              AND e2.kind = 'edit') AS edit_completed_at,
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
 * cull-list sheet). Both targets land on the verdict `kept` — v18 has no
 * `to_edit` verdict — and differ only in what they ASK FOR:
 * - keep: kept, and pending actions are left exactly as they were. It is
 *   reachable only from a staged cull, and rescuing a photo from
 *   deletion says "do not delete this", not "and cancel the edit I asked
 *   for". `unstageCullDirect` — the same culled -> kept transition from
 *   the state editor and the trash rollback — has always carried the
 *   edit across, and one transition must not mean two things.
 *   (Until m0.8.2 this abandoned the edit. That existed to escape the
 *   pre-v18 CASE ladder, where keep + flag bounced the verdict straight
 *   back to `to_edit`; with the bounce gone, so is the reason.)
 * - to_edit: kept, with a FRESH edit cycle (queued_at re-stamped
 *   unconditionally + baseline reset — reusing a completed cycle's stamp
 *   would let stale detection evidence auto-complete the new one). This
 *   one IS an explicit statement about the edit, which is why it writes.
 * Both resolve pending edited-copy matches (C#12: an explicit
 * keep/to-edit answers the copy prompt). Only decided states transition;
 * an unreviewed photo takes the normal verdict path instead.
 */
export async function applyRedecision(
  db: SQLiteDatabase,
  assetId: string,
  target: 'keep' | 'to_edit',
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    if (target === 'keep') {
      const moved = await txn.runAsync(
        `UPDATE photos SET state = 'kept',
           mod_time = NULL, content_hash = NULL,
           reviewed_at = COALESCE(reviewed_at, ?), decided_at = ?, activity_at = ?
         WHERE asset_id = ? AND state IN ('culled', 'kept')`,
        at,
        at,
        at,
        assetId,
      );
      // A STALE sheet: the photo left the decided states while it was
      // open. The guard above already refused the verdict, so nothing
      // below may run either — resolving copy matches for a decision
      // that did not happen is the same bug the guard exists to
      // prevent, just further down the function.
      if (Number(moved.changes) === 0) return;
    } else {
      const moved = await txn.runAsync(
        `UPDATE photos SET state = 'kept', mod_time = NULL, content_hash = NULL,
           reviewed_at = COALESCE(reviewed_at, ?), decided_at = ?, activity_at = ?
         WHERE asset_id = ? AND state IN ('culled', 'kept')`,
        at,
        at,
        at,
        assetId,
      );
      if (Number(moved.changes) === 0) return; // stale sheet — see above

      // A FRESH edit cycle: queued_at is re-stamped unconditionally,
      // because reusing a completed cycle's stamp would let stale
      // detection evidence auto-complete the new one.
      await txn.runAsync(
        `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
         VALUES (?, 'edit', 'queued', ?)
         ON CONFLICT(photo_id, kind) DO UPDATE SET
           -- resolved_at is NOT cleared: that an edit once completed
           -- stays true while a new cycle runs (the cycle key is
           -- queued_at, and the base rates read resolved_at).
           state = 'queued', queued_at = excluded.queued_at`,
        assetId,
        at,
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
               AND p.state NOT IN ('culled', 'trashed')
           )`,
          bestPhotoId,
          groupId,
          bestPhotoId,
        );
  if (Number(result.changes) === 0) {
    throw new Error('This group changed while reviewing — reopen it and try again.');
  }
}

/** Unreviewed present photos still to review: how many sit in groups /
 * as singles, and how many GROUPS the grouped ones span (Home's "N in M
 * groups" line — the loaded queue page is bounded, so the group count
 * cannot be taken from the queue array). */
export interface QueueCounts {
  grouped: number;
  singles: number;
  groups: number;
}

async function countReviewQueueIn(
  txn: SQLiteDatabase,
  roots: readonly string[] | null,
): Promise<QueueCounts> {
  const src = sourceClause(roots, 'p.uri');
  const row = await txn.getFirstAsync<{ grouped: number; singles: number; groups: number }>(
    `SELECT
       SUM(CASE WHEN a.group_id IS NOT NULL THEN 1 ELSE 0 END) AS grouped,
       SUM(CASE WHEN a.group_id IS NULL THEN 1 ELSE 0 END) AS singles,
       COUNT(DISTINCT a.group_id) AS groups
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE p.state = 'unreviewed' AND p.is_present = 1${src.sql}`,
    ...src.params,
  );
  return { grouped: row?.grouped ?? 0, singles: row?.singles ?? 0, groups: row?.groups ?? 0 };
}

/** Public wrapper (Home CTA counts outside the queue snapshot). */
export async function countReviewQueue(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<QueueCounts> {
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
  counts: QueueCounts;
}> {
  let out: {
    groups: ReviewGroupRow[];
    singles: ReviewMemberRow[];
    counts: QueueCounts;
  } = { groups: [], singles: [], counts: { grouped: 0, singles: 0, groups: 0 } };
  await withReadTransaction(db, async (txn) => {
    out = {
      groups: await listReviewGroupsIn(txn, groupLimit, roots),
      singles: await listSinglesFeedIn(txn, singlesLimit, roots),
      counts: await countReviewQueueIn(txn, roots),
    };
  });
  return out;
}

/**
 * Capture-day coverage (m0.8.1 round 8, the coverage goal): per local
 * capture day, how many tracked present photos exist and how many are
 * still unreviewed. `day IS NULL` comes back as the undated bucket,
 * which only the all-time goal counts.
 *
 * ONE indexed grouped read — no MediaStore involvement — so the Home
 * "keeping up" card and the Stats coverage chart share it.
 * `sinceDay` bounds the rolling-window case; null means all time.
 */
export interface DayCoverageRow {
  day: string | null;
  total: number;
  pending: number;
}

export async function getCoverageByDay(
  db: SQLiteDatabase,
  sinceDay: string | null,
  roots: readonly string[] | null = null,
): Promise<DayCoverageRow[]> {
  const src = sourceClause(roots);
  // The undated bucket must survive a sinceDay bound (all-time needs it,
  // and `NULL >= '2026-01-01'` is NULL — i.e. filtered out), so the
  // bound explicitly keeps the NULL day.
  const bound = sinceDay === null ? '' : ' AND (day IS NULL OR day >= ?)';
  const rows = await db.getAllAsync<{ day: string | null; total: number; pending: number }>(
    `SELECT day,
            COUNT(*) AS total,
            SUM(CASE WHEN state = 'unreviewed' THEN 1 ELSE 0 END) AS pending
     FROM photos
     WHERE is_present = 1${src.sql}${bound}
     GROUP BY day`,
    ...src.params,
    ...(sinceDay === null ? [] : [sinceDay]),
  );
  return rows.map((r) => ({ day: r.day, total: Number(r.total), pending: Number(r.pending) }));
}

/** Review-ACTION counts per local day (the daily goal ring and streaks).
 * m0.8.1 (tester decision): the goal is today's reviewing WORK — a photo
 * decided today counts regardless of when it was first reviewed, so this
 * reads the re-stamping decided_at, not reviewed_at's first-stamp
 * (which stays the lifetime-stats truth). One photo decided twice in a
 * day still counts once (the column holds only the latest stamp). */
export async function getReviewedCountsByDay(
  db: SQLiteDatabase,
  /** Epoch ms lower bound — NOT a day key: bounding on decided_at keeps
   * the filter indexable and, critically, avoids the alias trap below. */
  sinceMs: number,
  /** SOURCE-SCOPED (m0.8.2): the ring, the streaks, the 30-day chart and
   * the forecast's pace all read this, and every one of them is a claim
   * about the library you selected. See statsLoad.ts for where the line
   * between "your library now" and "what you did" is drawn. */
  roots: readonly string[] | null = null,
): Promise<Map<string, number>> {
  const src = sourceClause(roots);
  // `AS decided_day`, never `AS day`: `day` is a REAL COLUMN on photos
  // (the capture day), and SQLite resolves a bare name in GROUP BY /
  // HAVING to the COLUMN, not to the output alias. The old
  // `… AS day … GROUP BY day HAVING day >= ?` therefore grouped and
  // filtered by CAPTURE day — silently dropping photos captured before
  // the window but decided today, which is exactly the semantics the
  // daily goal promises (proven in store.real.test.ts).
  const rows = await db.getAllAsync<{ decided_day: string; n: number }>(
    `SELECT date(decided_at / 1000, 'unixepoch', 'localtime') AS decided_day, COUNT(*) AS n
     FROM photos WHERE decided_at IS NOT NULL AND decided_at >= ?${src.sql}
     GROUP BY decided_day`,
    sinceMs,
    ...src.params,
  );
  return new Map(rows.map((r) => [r.decided_day, r.n]));
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
        WHERE p.state IN ('kept', 'culled')
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
  await withWriteTransaction(db, (txn) => resetUnreviewedGroupsIn(txn));
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
  await withWriteTransaction(db, async (txn) => {
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

/** The staged culls with their last-scanned sizes, one snapshot. The
 * EXACT reclaimable figure stats each file LIVE (an in-place edit after
 * the last scan would otherwise report a stale size) and falls back to
 * the recorded size only when the stat fails — the staged set is
 * user-bounded, so the sweep stays cheap. */
export async function getStagedCullBytes(
  db: SQLiteDatabase,
): Promise<{ scanned: number; unsized: string[] }> {
  // The SUM lives in SQL (m0.8.1): Home used to receive EVERY staged row
  // and blocking-stat each one on the JS thread, per focus. Only rows the
  // v14 scan never sized need a stat, and the caller caps those.
  const row = await db.getFirstAsync<{ total: number; unsized: number }>(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total,
            SUM(CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END) AS unsized
     FROM photos WHERE state = 'culled' AND is_present = 1`,
  );
  const unsized =
    (row?.unsized ?? 0) === 0
      ? []
      : (
          await db.getAllAsync<{ uri: string }>(
            `SELECT uri FROM photos
             WHERE state = 'culled' AND is_present = 1 AND size_bytes IS NULL
             LIMIT 200`,
          )
        ).map((r) => r.uri);
  return { scanned: Number(row?.total ?? 0), unsized };
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
  /** File size at scan time (v14) — NULL when the stat failed; powers
   * the exact reclaimable-bytes sum. */
  sizeBytes: number | null;
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
  await withWriteTransaction(db, async (txn) => {
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
           mod_time = NULL, content_hash = NULL,
           activity_at = ?
         WHERE asset_id IN (${ids.map(() => '?').join(',')}) AND state = 'trashed'`,
        at,
        ...ids,
      );
    }
    for (const photo of write.photos) {
      await txn.runAsync(
        `INSERT INTO photos (asset_id, uri, taken_at, state, mod_time, day,
                             volume_name, raw_id, size_bytes)
         VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           uri = excluded.uri,
           taken_at = excluded.taken_at,
           size_bytes = COALESCE(excluded.size_bytes, photos.size_bytes),
           -- photos.mod_time is the in-place edit detector's baseline
           -- while a row is in an edit cycle: refreshing it here would
           -- make the pending edit look unchanged (silent detection loss).
           mod_time = CASE WHEN ${queuedClause('edit', 'photos.asset_id')}
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
        photo.sizeBytes,
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

    // UNCHANGED assignments are NO-OPS (m0.8.1): re-scan windows used to
    // delete-and-recreate identical unreviewed groups under fresh ids,
    // invalidating the ids the deck had rendered — every decision taken
    // mid-scan on such a group then hit the staleness guard ("group
    // changed while reviewing"). Skipping identical writes keeps group
    // ids stable across re-scans (and drops thousands of redundant
    // window writes per pass). A group is identical only when every
    // planned member already sits in ONE existing group of exactly the
    // planned size with matching time-attached flags.
    const identicalGroup = (group: ContinuousGroupWrite): boolean => {
      const timeAttached = new Set(group.timeAttached);
      let existing: number | null = null;
      for (const member of group.members) {
        const live = liveAssignments.get(member);
        if (!live || live.groupId === null) return false;
        if (existing === null) existing = live.groupId;
        else if (live.groupId !== existing) return false;
        if (live.timeAttached !== timeAttached.has(member)) return false;
      }
      if (existing === null) return false;
      const liveSet = liveMembers.get(existing);
      // Same size + every planned member inside ⇒ the sets are equal.
      return liveSet !== undefined && liveSet.length === group.members.length;
    };

    const runId = await ensureContinuousRun(txn, at);
    // Repair scope: the groups these photos already belonged to (they can
    // be left short a member) plus the ones written below.
    const touchedGroups = new Set<number>(liveTouched);
    for (const group of plan.groups) {
      if (identicalGroup(group)) continue;
      const groupResult = await txn.runAsync(
        'INSERT INTO photo_groups (run_id, best_photo_id) VALUES (?, NULL)',
        runId,
      );
      const groupId = Number(groupResult.lastInsertRowId);
      touchedGroups.add(groupId);
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
      const live = liveAssignments.get(assetId);
      if (live && live.groupId === null && !live.timeAttached) continue; // already this single
      await txn.runAsync(
        `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
         VALUES (?, ?, NULL, 0)`,
        assetId,
        runId,
      );
    }
    await repairGroupMembership(txn, [...touchedGroups]);
  });
}

/** One photo's current durable group assignment. */
export interface GroupAssignmentRow {
  /** null = assigned single. */
  groupId: number | null;
  /** The USER ejected this photo to singles — never regroup it. */
  userSingle: boolean;
  /** Grouped by time only (embedding was unavailable). */
  timeAttached: boolean;
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
      time_attached: number;
    }>(
      `SELECT photo_id, group_id, user_single, time_attached FROM photo_group_assignments
       WHERE photo_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows)
      out.set(row.photo_id, {
        groupId: row.group_id === null ? null : Number(row.group_id),
        userSingle: row.user_single === 1,
        timeAttached: row.time_attached === 1,
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
  await withWriteTransaction(db, async (txn) => {
    // v18: completing an edit RESOLVES the action. The verdict is
    // already 'kept' and does not move — finishing an edit was never a
    // change of mind about keeping the photo.
    const guard = onlyIfToEditAt === undefined ? '' : ' AND queued_at IS ?';
    const params: (string | number | null)[] = [at, assetId];
    if (onlyIfToEditAt !== undefined) params.push(onlyIfToEditAt);
    const result = await txn.runAsync(
      // resolved_at takes the LATEST completion, not the first. COALESCE
      // here looks conservative but is not: a second edit cycle moves
      // queued_at forward while leaving an older resolved_at behind, and
      // `resolved_at < queued_at` makes getQueueTurnaround drop the row
      // for good. "Ever actioned" survives either way — the column stays
      // non-null — so the only thing COALESCE preserved was a stale gap.
      `UPDATE photo_actions
          SET state = 'applied', resolved_at = ?
        WHERE photo_id = ? AND kind = 'edit' AND state IN ('queued', 'error')${guard}`,
      ...params,
    );
    applied = result.changes > 0;
    if (applied) {
      await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, assetId);
    }
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

/** The photo facts a QUEUE ROW needs beside its action: the thumbnail and
 * the CAPTURE time. Queue screens hand these to the standard viewer,
 * which labels the timestamp as when the photo was taken — so passing an
 * action's `queued_at` there tells the user the wrong thing. */
export async function getPhotoQueueFacts(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, { uri: string; takenAt: number }>> {
  const facts = new Map<string, { uri: string; takenAt: number }>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; uri: string; taken_at: number }>(
      `SELECT asset_id, uri, taken_at FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      facts.set(row.asset_id, { uri: row.uri, takenAt: Number(row.taken_at) });
    }
  }
  return facts;
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
      `SELECT p.asset_id FROM photos p WHERE (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AND p.asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) flagged.add(row.asset_id);
  }
  return flagged;
}

/** Queue membership behind the deck/Groups badges: a photo waiting in the
 * share queue or with a queued (or retryable-error) organize intent. Read
 * for the loaded queue ids on every refresh — the badges must show the
 * same durable rows the Share/Organize tabs list. */
export interface QueuedForAssets {
  share: Set<string>;
  organize: Set<string>;
}

export async function getQueuedForAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<QueuedForAssets> {
  const out: QueuedForAssets = { share: new Set(), organize: new Set() };
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; shared: number; organized: number }>(
      `SELECT p.asset_id,
              (EXISTS (SELECT 1 FROM photo_actions s WHERE s.photo_id = p.asset_id AND s.kind = 'share' AND s.state IN ('queued', 'error'))) AS shared,
              (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'organize' AND pa.state IN ('queued', 'error'))) AS organized
       FROM photos p
       WHERE p.asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      if (row.shared) out.share.add(row.asset_id);
      if (row.organized) out.organize.add(row.asset_id);
    }
  }
  return out;
}

export interface ToEditRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  day: string | null;
}

/** The to-edit queue: every photo flagged for editing, newest first.
 * Live work only — a staged cull is not waiting to be edited. */
export async function getToEditPhotos(db: SQLiteDatabase): Promise<ToEditRow[]> {
  return db.getAllAsync<ToEditRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id
      WHERE pa.kind = 'edit' AND pa.state IN ('queued', 'error')
        AND ${livePhotoClause('p.asset_id')}
      ORDER BY p.taken_at DESC`,
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
    `SELECT p.asset_id, p.uri, p.taken_at, p.mod_time, p.content_hash,
            pa.queued_at AS to_edit_at
       FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id
      WHERE pa.kind = 'edit' AND pa.state IN ('queued', 'error')
        AND ${livePhotoClause('p.asset_id')}`,
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
    `UPDATE photos SET mod_time = ?
      WHERE asset_id = ?
        AND EXISTS (SELECT 1 FROM photo_actions pa
                     WHERE pa.photo_id = photos.asset_id AND pa.kind = 'edit'
                       AND pa.state IN ('queued', 'error') AND pa.queued_at IS ?)`,
    modTime,
    assetId,
    onlyIfToEditAt,
  );
}

/**
 * Track a detected edited copy AND record its durable original ↔ copy
 * match (C#12) in ONE transaction — a crash between the two would leave
 * a tracked copy whose prompt could never be recovered (tracked photos
 * are excluded from future scans). One best copy per original: an
 * original that already has ANY recorded match is skipped entirely (the
 * table's (original, copy) key alone would let every candidate pair
 * insert) — returns false and nothing is written, so an unchosen
 * candidate stays untracked and reviewable.
 *
 * THE COPY IS A NEW PHOTO, NOT A DECIDED ONE (Tristan, 2026-07-28). It
 * is written `unreviewed`, so it joins the review queue like anything
 * else the camera produced — the app has no business deciding you want
 * to keep a photo you have never seen. Only `activity_at` is stamped,
 * which is all "tracked" needs (see getDetectionTrackedAssets: a row is
 * tracked unless it is unreviewed AND activity-less), so it still never
 * re-enters candidate scanning.
 *
 * It carries NO edit action either: an action row means work was queued
 * against a photo, and the copy was never in a queue — it is the OUTPUT
 * of the original's edit. The relationship it does have lives in
 * edit_copy_matches, and "edits completed" counts the ORIGINAL's
 * resolved action, once, whichever way the prompt is answered.
 *
 * Known limit: the copy will not be GROUPED with its original, because
 * the regroup boundary freezes any photo that has left 'unreviewed' and
 * the original has a verdict by then (docs/TODO.md). The exception is
 * pleasant — flag an edit while the original is still undecided and both
 * stay unfrozen, so the scan can pair them.
 */
export async function insertDetectedCopyWithMatch(
  db: SQLiteDatabase,
  originalId: string,
  copy: { assetId: string; uri: string; takenAt: number; modTime: number; day: string },
  detectedAt: number,
  /** The edit cycle the detection evidence belongs to — the original must
   * still be in THAT cycle (its edit action still queued, same
   * `queued_at`), or nothing records. */
  onlyIfToEditAt: number | null,
): Promise<boolean> {
  let recorded = false;
  await withWriteTransaction(db, async (txn) => {
    const original = await txn.getFirstAsync<{ to_edit_at: number | null }>(
      `SELECT queued_at AS to_edit_at FROM photo_actions
        WHERE photo_id = ? AND kind = 'edit' AND state IN ('queued', 'error')`,
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
    // The continuous scan may have inserted the copy's row first
    // (scan-only: unreviewed, no activity); stamping activity_at is what
    // marks it tracked. A row a user already touched never gets
    // clobbered (it was not a candidate anyway).
    const upsert = await txn.runAsync(
      `INSERT INTO photos
         (asset_id, uri, taken_at, state, mod_time, day, activity_at)
       VALUES (?, ?, ?, 'unreviewed', ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         activity_at = excluded.activity_at
       WHERE photos.state = 'unreviewed' AND photos.activity_at IS NULL`,
      copy.assetId,
      copy.uri,
      copy.takenAt,
      copy.modTime,
      copy.day,
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
  state: PhotoState;
  needs_edit: number;
  favourited: number;
  organized: number;
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
 * "This photo has EVER had a move applied" as a WHERE-clause predicate.
 * The SELECT list exposes the same fact as `organize_applied_at`, but a
 * result alias cannot be referenced from WHERE in SQLite, so the filters
 * spell the subquery out. Correlated on `photos.asset_id`, which every
 * caller here selects from.
 */
const ORGANIZE_APPLIED = `EXISTS (SELECT 1 FROM photo_actions pv_organize
  WHERE pv_organize.photo_id = photos.asset_id AND pv_organize.kind = 'organize'
    AND pv_organize.resolved_at IS NOT NULL)`;

/** "An edit is waiting on this photo." Badge semantics on purpose: the
 * History feed reports what a photo carries, not what a queue serves. */
const EDIT_QUEUED = `EXISTS (SELECT 1 FROM photo_actions pa_edit
  WHERE pa_edit.photo_id = photos.asset_id AND pa_edit.kind = 'edit'
    AND pa_edit.state IN ('queued', 'error'))`;

/** "A favourite was ever queued or ever applied" — the pinned formula. */
const FAVOURITE_TOUCHED = `(EXISTS (SELECT 1 FROM photo_actions pa_favourite
  WHERE pa_favourite.photo_id = photos.asset_id AND pa_favourite.kind = 'favourite'
    AND pa_favourite.state IN ('queued', 'error'))
  OR EXISTS (SELECT 1 FROM photo_actions pv_favourite
  WHERE pv_favourite.photo_id = photos.asset_id AND pv_favourite.kind = 'favourite'
    AND pv_favourite.resolved_at IS NOT NULL))`;

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
      ? // The VERDICT, nothing more (v18): a kept photo with an edit
        // queued is still kept, and excluding it here kept the retired
        // mutually-exclusive done-vs-to_edit model alive on this surface.
        // It appears under Kept AND under To edit, which is the point of
        // having two layers.
        "AND state = 'kept'"
      : filter === 'culled'
        ? "AND state = 'culled'"
        : filter === 'to_edit'
          ? `AND ${EDIT_QUEUED}`
          : filter === 'favourite'
            ? `AND ${FAVOURITE_TOUCHED}`
            : filter === 'organized'
              ? // The retained applied marker, NOT the live queue state:
                // re-queueing another move must not erase the photo's
                // organized history (possibly forever, on error).
                `AND ${ORGANIZE_APPLIED}`
              : // All is the UNION of the specific filters, and has to be
                // kept one: v18 lets an UNREVIEWED photo carry a queued
                // edit, so leaving the edit term out here hid photos that
                // the To-edit filter beside it happily listed. A
                // merely-drawn photo (activity_at stamped at insert) still
                // matches none of these.
                `AND (state <> 'unreviewed'
                   OR ${ORGANIZE_APPLIED}
                   OR ${EDIT_QUEUED}
                   OR ${FAVOURITE_TOUCHED})`;
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
          `SELECT asset_id, uri, taken_at, state, day, activity_at,
                  EXISTS (SELECT 1 FROM photo_actions pa_edit WHERE pa_edit.photo_id = photos.asset_id AND pa_edit.kind = 'edit' AND pa_edit.state IN ('queued', 'error')) AS needs_edit,
                  (EXISTS (SELECT 1 FROM photo_actions pa_favourite WHERE pa_favourite.photo_id = photos.asset_id AND pa_favourite.kind = 'favourite' AND pa_favourite.state IN ('queued', 'error')) OR EXISTS (SELECT 1 FROM photo_actions pv_favourite WHERE pv_favourite.photo_id = photos.asset_id AND pv_favourite.kind = 'favourite' AND pv_favourite.resolved_at IS NOT NULL)) AS favourited,
                  (EXISTS (SELECT 1 FROM photo_actions pa_organize WHERE pa_organize.photo_id = photos.asset_id AND pa_organize.kind = 'organize' AND pa_organize.state IN ('queued', 'error')) OR EXISTS (SELECT 1 FROM photo_actions pv_organize WHERE pv_organize.photo_id = photos.asset_id AND pv_organize.kind = 'organize' AND pv_organize.resolved_at IS NOT NULL)) AS organized,
                  (SELECT o.resolved_at FROM photo_actions o WHERE o.photo_id = photos.asset_id
                    AND o.kind = 'organize') AS organize_applied_at
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

/**
 * Per-state DB counts for one scope, split by cull-group membership, PLUS
 * the pending-action counts for the same scope (StateCounts lives in
 * lib/progress.ts — pure, shared with the breakdown math).
 *
 * Both layers in one call because both label the same chip rows: a
 * verdict chip and an action chip that disagreed about their scope would
 * be two different questions wearing one design.
 */
export async function getStateCountsInScope(
  db: SQLiteDatabase,
  scope: PhotoScope,
  roots: readonly string[] | null = null,
): Promise<StateCounts> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  const [rows, actionRows] = await Promise.all([
    db.getAllAsync<{ state: PhotoState; grouped: number; n: number }>(
      `SELECT state,
              EXISTS (SELECT 1 FROM photo_group_assignments a
                      WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped,
              COUNT(*) AS n
       FROM photos WHERE ${where.sql}${src.sql} GROUP BY state, grouped`,
      ...where.params,
      ...src.params,
    ),
    // Deliberately NOT the queue rule: these chips label a BROWSE grid
    // that already shows staged culls under its own verdict chip, and a
    // photo visible there but missing from "To edit" while wearing an
    // edit badge would be the page contradicting itself. The predicate
    // is GRID_FILTER_SQL's, exactly — chip and grid must agree, and it
    // is the tab badges (countQueues) that answer "waiting for you".
    db.getAllAsync<{ kind: ActionKind; n: number }>(
      `SELECT pa.kind, COUNT(*) AS n
         FROM photos
         JOIN photo_actions pa ON pa.photo_id = photos.asset_id
        WHERE ${where.sql}${src.sql}
          AND pa.state IN ('queued', 'error')
          AND photos.state <> 'trashed'
        GROUP BY pa.kind`,
      ...where.params,
      ...src.params,
    ),
  ]);
  const counts: StateCounts = {
    unreviewed: 0,
    kept: 0,
    staged: 0,
    trashed: 0,
    tracked: 0,
    grouped: { unreviewed: 0, kept: 0, staged: 0 },
    actions: { edit: 0, favourite: 0, organize: 0, share: 0 },
  };
  for (const row of actionRows) counts.actions[row.kind] = Number(row.n);
  for (const row of rows) {
    counts.tracked += row.n;
    // Grouping is an ANNOTATION counted per verdict, not a verdict of
    // its own (docs/STATE_MODEL.md): it is what the grouped underline
    // spans, and a grouped unreviewed photo is still simply unreviewed.
    const verdict =
      row.state === 'culled'
        ? 'staged'
        : row.state === 'kept'
          ? 'kept'
          : row.state === 'unreviewed'
            ? 'unreviewed'
            : null;
    if (row.state === 'trashed') counts.trashed += row.n;
    else if (verdict !== null) {
      counts[verdict] += row.n;
      if (row.grouped) counts.grouped[verdict] += row.n;
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
  /** An edit action is queued (layer 2). */
  needs_edit: number;
  asset_id: string;
  uri: string;
  taken_at: number;
  state: PhotoState;
  grouped: number;
}

/**
 * SQL predicate per DB-backed grid filter (v18).
 *
 * Verdicts and pending ACTIONS both filter the same grid, from the two
 * different layers of docs/STATE_MODEL.md — action filters carry an
 * `act:` prefix so the two vocabularies can never collide.
 */
const GRID_FILTER_SQL: Record<string, string> = {
  // 'all'/'unreviewed' are DB-backed ONLY for the Unknown-day pseudo-day
  // (its photos cannot be paged from MediaStore; the tracked rows are the
  // complete population there).
  all: "state <> 'trashed'",
  unreviewed: "state = 'unreviewed'",
  staged: "state = 'culled'",
  // 'trashed' rows count as kept in the summaries (both converged), but
  // their files are gone — no thumbnail to show, so the grid excludes
  // them and the UI notes how many are hidden.
  kept: "state = 'kept'",
};

for (const kind of ['edit', 'favourite', 'organize', 'share']) {
  GRID_FILTER_SQL[`act:${kind}`] = `state <> 'trashed' AND EXISTS (SELECT 1 FROM photo_actions pa
      WHERE pa.photo_id = photos.asset_id AND pa.kind = '${kind}'
        AND pa.state IN ('queued', 'error'))`;
}

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
  filter: string,
  limit: number,
  offset: number,
): Promise<GridPhotoRow[]> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  return db.getAllAsync<GridPhotoRow>(
    `SELECT asset_id, uri, taken_at, state,
            EXISTS (SELECT 1 FROM photo_group_assignments a
                    WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped,
            EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = photos.asset_id
                     AND pa.kind = 'edit' AND pa.state IN ('queued', 'error')) AS needs_edit
     FROM photos WHERE ${where.sql} AND (${GRID_FILTER_SQL[filter] ?? GRID_FILTER_SQL.all})${src.sql}
     ORDER BY taken_at DESC, asset_id DESC LIMIT ? OFFSET ?`,
    ...where.params,
    ...src.params,
    limit,
    offset,
  );
}

/**
 * State editor: send a converged 'kept' photo back to the edit queue.
 * A re-queue starts a FRESH edit cycle: the detection baseline
 * (mod_time + content hash) resets — the previous cycle's edit was
 * already consumed, and a stale baseline would auto-complete the photo
 * before any new edit — and the action's `queued_at` re-stamps, so copy
 * detection scans only from THIS cycle (an old untracked copy in the
 * previous window must not be claimed as the new cycle's result).
 */
export async function markDoneToEdit(
  db: SQLiteDatabase,
  assetId: string,
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    const moved = await txn.runAsync(
      `UPDATE photos
       SET mod_time = NULL, content_hash = NULL, activity_at = ?
       WHERE asset_id = ? AND state = 'kept'`,
      at,
      assetId,
    );
    // Only a kept photo re-enters the edit queue; anything else (staged,
    // trashed, never reviewed) is not a "converged keeper" and the sheet
    // does not offer this.
    if (Number(moved.changes) === 0) return;
    await txn.runAsync(
      `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
       VALUES (?, 'edit', 'queued', ?)
       ON CONFLICT(photo_id, kind) DO UPDATE SET
         state = 'queued', queued_at = excluded.queued_at`,
      assetId,
      at,
    );
  });
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
  await withWriteTransaction(db, async (txn) => {
    await txn.runAsync(
      // Same rule as the verdict path: a LIVE edit cycle keeps its
      // detection baseline, because the verdict says nothing about it.
      `UPDATE photos SET state = 'unreviewed',
         mod_time = CASE WHEN ${queuedEditExists} THEN mod_time ELSE NULL END,
         content_hash = CASE WHEN ${queuedEditExists} THEN content_hash ELSE NULL END,
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
  await withWriteTransaction(db, async (txn) => {
    await txn.runAsync(
      `UPDATE photos
       SET state = 'kept',
           decided_at = ?,
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
             AND p.state NOT IN ('culled', 'trashed')
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
            SUM(CASE WHEN state IN ('kept', 'trashed') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
            -- PENDING WORK, so it takes the queue rule, not the badge
            -- one: Home's day row must not say "1 to edit" about a photo
            -- the Edit tab correctly refuses to list because it is
            -- staged for deletion.
            SUM(CASE WHEN ${queuedClause('edit', 'photos.asset_id')} THEN 1 ELSE 0 END) AS toEdit,
            SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END) AS staged
     FROM photos WHERE day IS NOT NULL`;

/**
 * What was DECIDED on one local day (Stats/Summary "done for today"):
 * counts by current state over photos DECIDED that day.
 *
 * m0.8.1 — two fixes in one: it keyed on `reviewed_at` (the FIRST-ever
 * verdict, which never moves), so a photo first reviewed last week and
 * re-decided today was missing — the same screen's goal ring counts it
 * (decided_at), and the two "today" numbers disagreed. It also filtered
 * with `date(reviewed_at…) = ?`, an expression no index can serve, so it
 * full-scanned the corpus per Stats/Summary open. Now: `decided_at`
 * BETWEEN the day's bounds (inclusive, like every other range scope
 * here — rangeOfDayKey's endMs IS 23:59:59.999), which the decided_at
 * index serves.
 */
export async function getDayReviewSummary(
  db: SQLiteDatabase,
  day: string,
  roots: readonly string[] | null = null,
): Promise<{ reviewed: number; kept: number; staged: number; trashed: number }> {
  const range = rangeOfDayKey(day);
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{
    reviewed: number;
    kept: number;
    staged: number;
    trashed: number;
  }>(
    `SELECT COUNT(*) AS reviewed,
            SUM(CASE WHEN state = 'kept' THEN 1 ELSE 0 END) AS kept,
            SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END) AS staged,
            SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed
     FROM photos
     WHERE decided_at BETWEEN ? AND ?${src.sql}`,
    range.startMs,
    range.endMs,
    ...src.params,
  );
  return {
    reviewed: row?.reviewed ?? 0,
    kept: row?.kept ?? 0,
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
              SUM(CASE WHEN state IN ('kept', 'trashed') THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN state = 'trashed' THEN 1 ELSE 0 END) AS trashed,
              -- PENDING WORK, so it takes the queue rule, not the badge
            -- one: Home's day row must not say "1 to edit" about a photo
            -- the Edit tab correctly refuses to list because it is
            -- staged for deletion.
            SUM(CASE WHEN ${queuedClause('edit', 'photos.asset_id')} THEN 1 ELSE 0 END) AS toEdit,
              SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END) AS staged
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

// The favourite queue lived here as six bespoke functions over four
// photos columns. v18: it is four rows in photo_actions like every
// other action — see db/actions.ts. Lifetime metrics stay below.

// ------------------------------------------------------------- forecast

/** One equal slice of the decision history, in decision order. Chunk
 * boundaries come from SQL NTILE, so the slices stay balanced without
 * shipping every decided row to JS. */
/**
 * Every tracked, present photo's timestamp in scope, ASCENDING — the one
 * read the delta scan's planning needs (lib/deltaScan.ts).
 *
 * It answers both questions at once: the merge-window bounds around each
 * changed photo are WALKED through this array (a window is a maximal
 * chain of ≤gap steps, so its extent cannot be assumed), and the cost
 * model's `covered` term is counted from the same array — so the ranges
 * and the number of photos in them can never disagree.
 *
 * There is deliberately no index on `taken_at` (m0.8.1 measured it
 * costing the scan's write path more than it saves any read), so this
 * sorts via a temp B-tree. Paid once per delta decision, against a pass
 * it may save entirely.
 */
export async function getPhotoTimestamps(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<number[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ taken_at: number }>(
    `SELECT taken_at FROM photos WHERE is_present = 1${src.sql} ORDER BY taken_at ASC`,
    ...src.params,
  );
  return rows.map((row) => Number(row.taken_at));
}

/**
 * Present, tracked photos in scope — the `corpus` term in the delta-scan
 * cost model, and the population a full pass walks.
 *
 * Counted from the DB rather than MediaStore deliberately: `covered`
 * comes from the same table, and the comparison only means anything if
 * both sides count the same population. A library with photos the scan
 * has never ingested reads slightly low here, which biases toward the
 * full pass — the safe direction.
 */
export async function countTrackedPhotos(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<number> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos WHERE is_present = 1${src.sql}`,
    ...src.params,
  );
  return Number(row?.n ?? 0);
}

export interface OutcomeChunkRow {
  chunk: number;
  total: number;
  culled: number;
  toEdit: number;
  favourited: number;
  shared: number;
  organized: number;
}

export interface DecisionTotals {
  /** Lifetime decisions — the floor that gates every projection. */
  decisions: number;
  /** Epoch ms of the earliest verdict, or null when nothing is decided.
   * Shortens the pace denominator for a new user. */
  firstDecidedAt: number | null;
}

export interface ForecastBaseRates extends DecisionTotals {
  chunks: OutcomeChunkRow[];
}

/**
 * The two numbers the finish line needs beyond what Home already loads.
 * Split out from `getForecastBaseRates` deliberately: Home renders only
 * the headline, and must not pay for an NTILE pass over every decision
 * to do it. One aggregate on `idx_photos_decided`.
 */
export async function getDecisionTotals(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<DecisionTotals> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ decisions: number; firstDecidedAt: number | null }>(
    `SELECT COUNT(*) AS decisions, MIN(decided_at) AS firstDecidedAt
     FROM photos WHERE decided_at IS NOT NULL${src.sql}`,
    ...src.params,
  );
  return { decisions: Number(row?.decisions ?? 0), firstDecidedAt: row?.firstDecidedAt ?? null };
}

/**
 * Base rates over EVERY decision ever made (D11), sliced into `chunks`
 * equal parts in decision order.
 *
 * The slices ARE the uncertainty the projections render as a range (D12):
 * a user whose culling standards drifted produces widely-spread chunks
 * and therefore a wide range, which is the honest output — rather than a
 * confident point estimate or a hidden card.
 *
 * `shared` is the only outcome without a column: `clearShareQueue` deletes
 * queue rows, so the sole durable per-photo record of a share is
 * membership of a batch that actually reached the sheet. That is the same
 * definition `countNeverShared` uses (shareStore.ts) — deliberately not a
 * second, subtly different one.
 */
export async function getForecastBaseRates(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
  chunks = 5,
): Promise<ForecastBaseRates> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{
    chunk: number;
    total: number;
    culled: number;
    toEdit: number;
    favourited: number;
    shared: number;
    organized: number;
  }>(
    `WITH decided AS (
       SELECT asset_id, state,
              NTILE(?) OVER (ORDER BY decided_at) AS chunk
       FROM photos
       WHERE decided_at IS NOT NULL${src.sql}
     )
     SELECT chunk,
            COUNT(*) AS total,
            SUM(CASE WHEN state IN ('culled', 'trashed') THEN 1 ELSE 0 END) AS culled,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM photo_actions pa_edit WHERE pa_edit.photo_id = decided.asset_id AND pa_edit.kind = 'edit' AND pa_edit.state IN ('queued', 'error')) OR EXISTS (SELECT 1 FROM photo_actions pv_edit WHERE pv_edit.photo_id = decided.asset_id AND pv_edit.kind = 'edit' AND pv_edit.resolved_at IS NOT NULL) THEN 1 ELSE 0 END) AS toEdit,
            -- Direction matters here where it does not elsewhere: an
            -- un-favourite is an action, but it is not a favourite, and
            -- counting it would project the opposite of what happened.
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM photo_actions f
                   WHERE f.photo_id = decided.asset_id AND f.kind = 'favourite'
                     AND COALESCE(f.target, f.applied_target) = '1'
                ) THEN 1 ELSE 0 END) AS favourited,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM share_batch_members m
                    JOIN share_batches b ON b.id = m.batch_id
                  WHERE m.photo_id = decided.asset_id AND b.state = 'sheet_opened'
                ) THEN 1 ELSE 0 END) AS shared,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM photo_actions pa_organize WHERE pa_organize.photo_id = decided.asset_id AND pa_organize.kind = 'organize' AND pa_organize.state IN ('queued', 'error')) OR EXISTS (SELECT 1 FROM photo_actions pv_organize WHERE pv_organize.photo_id = decided.asset_id AND pv_organize.kind = 'organize' AND pv_organize.resolved_at IS NOT NULL) THEN 1 ELSE 0 END) AS organized
     FROM decided
     GROUP BY chunk
     ORDER BY chunk`,
    chunks,
    ...src.params,
  );
  const totals = await getDecisionTotals(db, roots);
  return {
    chunks: rows.map((row) => ({
      chunk: Number(row.chunk),
      total: Number(row.total),
      culled: Number(row.culled),
      toEdit: Number(row.toEdit),
      favourited: Number(row.favourited),
      shared: Number(row.shared),
      organized: Number(row.organized),
    })),
    ...totals,
  };
}

/**
 * The most recent decision stamps, NEWEST first, for the per-photo timing
 * median. Bounded because the estimate needs a rhythm, not a biography —
 * and the bound keeps this on `idx_photos_decided` instead of the table.
 */
export async function getRecentDecisionStamps(
  db: SQLiteDatabase,
  limit = 2000,
  roots: readonly string[] | null = null,
): Promise<number[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ decided_at: number }>(
    `SELECT decided_at FROM photos
     WHERE decided_at IS NOT NULL${src.sql}
     ORDER BY decided_at DESC
     LIMIT ?`,
    ...src.params,
    limit,
  );
  return rows.map((row) => Number(row.decided_at));
}

/**
 * Mean file size of photos still awaiting review — the pool whose bytes a
 * projected cull would actually free. Sizes of photos already culled
 * describe a different set and would price the projection wrongly.
 *
 * `sized` is reported so the caller can see how much of the pool the mean
 * rests on: `size_bytes` is NULL until the scan has walked a photo.
 */
export async function getRemainingPoolSize(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<{ sized: number; meanBytes: number }> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ sized: number; meanBytes: number | null }>(
    `SELECT COUNT(size_bytes) AS sized, AVG(size_bytes) AS meanBytes
     FROM photos
     WHERE state = 'unreviewed' AND is_present = 1${src.sql}`,
    ...src.params,
  );
  return { sized: Number(row?.sized ?? 0), meanBytes: Math.round(row?.meanBytes ?? 0) };
}

// ------------------------------------------------------------- habits

/** Decisions in one (weekday, hour) cell of the rhythm heatmap. */
export interface RhythmCell {
  /** 0 = Sunday, matching SQLite's %w. */
  weekday: number;
  hour: number;
  count: number;
}

/**
 * When you actually review, as a weekday × hour grid.
 *
 * Bucketed in SQLite with 'localtime' rather than in JS: the alternative
 * reads every decided_at into memory to divide it by 3.6e6, and the
 * whole point of the cell is the LOCAL hour — 23:30 on Saturday is
 * Saturday night, whatever UTC calls it.
 *
 * Empty cells are simply absent; the caller fills the grid.
 */
export async function getDecisionRhythm(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<RhythmCell[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ weekday: string; hour: string; n: number }>(
    `SELECT strftime('%w', decided_at / 1000, 'unixepoch', 'localtime') AS weekday,
            strftime('%H', decided_at / 1000, 'unixepoch', 'localtime') AS hour,
            COUNT(*) AS n
     FROM photos
     WHERE decided_at IS NOT NULL${src.sql}
     GROUP BY weekday, hour`,
    ...src.params,
  );
  return rows.map((row) => ({
    weekday: Number(row.weekday),
    hour: Number(row.hour),
    count: Number(row.n),
  }));
}

/** How one action queue behaves over time (the Habits turnaround rows). */
export interface QueueTurnaround {
  kind: ActionKind;
  /** Waiting right now — the same number the tab badge shows. */
  waiting: number;
  /** Ever completed. NOTE: `waiting + finished` is NOT the total ever
   * queued — work removed from a queue without being done leaves no row,
   * which is why no completion RATE is derived from these two (m0.8.2:
   * queues are designed to drain, so any such rate converges on 100% for
   * every healthy user and says nothing). */
  finished: number;
  /** When the oldest thing still waiting was queued, or null when the
   * queue is empty. The one queue signal a badge count cannot carry: a
   * badge showing 3 looks identical whether they arrived this morning or
   * three weeks ago. */
  oldestWaitingAt: number | null;
  /** Recent completed turnarounds in ms, for the median. Bounded: the
   * habit is a rhythm, not a biography. */
  gaps: number[];
}

const TURNAROUND_SAMPLE = 500;

/**
 * Per-kind queue behaviour: how much is waiting, how much you have ever
 * finished, and how long finishing usually takes.
 *
 * This is the question "why does my edit queue never empty?" — and it is
 * answerable at all only because `resolved_at` is permanent, so clearing
 * a queue does not erase the evidence that its work once got done.
 */
export async function getQueueTurnaround(db: SQLiteDatabase): Promise<QueueTurnaround[]> {
  const [waiting, finished, gaps] = await Promise.all([
    db.getAllAsync<{ kind: ActionKind; n: number; oldest: number | null }>(
      `SELECT kind, COUNT(*) AS n, MIN(queued_at) AS oldest FROM photo_actions
        WHERE state IN ('queued', 'error')
          AND ${livePhotoClause('photo_actions.photo_id')}
        GROUP BY kind`,
    ),
    db.getAllAsync<{ kind: ActionKind; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM photo_actions
        WHERE resolved_at IS NOT NULL GROUP BY kind`,
    ),
    // PER KIND, not one shared bound: a single 2,000-row read ordered by
    // resolved_at would give the whole sample to whichever queue is
    // busiest, and a rarely-used one would report no turnaround at all
    // despite having finished work. Four bounded index reads instead.
    Promise.all(
      ACTION_KINDS.map(async (kind) => ({
        kind,
        rows: await db.getAllAsync<{ gap: number }>(
          `SELECT resolved_at - queued_at AS gap FROM photo_actions
            WHERE kind = ? AND resolved_at IS NOT NULL AND resolved_at >= queued_at
            ORDER BY resolved_at DESC
            LIMIT ?`,
          kind,
          TURNAROUND_SAMPLE,
        ),
      })),
    ),
  ]);
  const waitingBy = new Map(waiting.map((row) => [row.kind, Number(row.n)]));
  const oldestBy = new Map(
    waiting.map((row) => [row.kind, row.oldest === null ? null : Number(row.oldest)]),
  );
  const finishedBy = new Map(finished.map((row) => [row.kind, Number(row.n)]));
  const gapsBy = new Map<ActionKind, number[]>(
    gaps.map((entry) => [entry.kind, entry.rows.map((row) => Number(row.gap))]),
  );
  return ACTION_KINDS.map((kind) => ({
    kind,
    waiting: waitingBy.get(kind) ?? 0,
    finished: finishedBy.get(kind) ?? 0,
    oldestWaitingAt: oldestBy.get(kind) ?? null,
    gaps: gapsBy.get(kind) ?? [],
  }));
}

/** Compare-screen history: how often a duel ended in keeping both. */
export interface DuelSummary {
  duels: number;
  keptBoth: number;
}

export async function getDuelSummary(db: SQLiteDatabase): Promise<DuelSummary> {
  const row = await db.getFirstAsync<{ duels: number; keptBoth: number }>(
    `SELECT COUNT(*) AS duels, SUM(kept_both) AS keptBoth FROM duels`,
  );
  return { duels: Number(row?.duels ?? 0), keptBoth: Number(row?.keptBoth ?? 0) };
}

/** Decisions and culls since a timestamp — the decisiveness trend's
 * numerator and denominator, against the all-time rate the base rates
 * already carry. */
export async function getDecisionOutcomesSince(
  db: SQLiteDatabase,
  sinceMs: number,
  roots: readonly string[] | null = null,
): Promise<{ decided: number; culled: number }> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ decided: number; culled: number }>(
    `SELECT COUNT(*) AS decided,
            SUM(CASE WHEN state IN ('culled', 'trashed') THEN 1 ELSE 0 END) AS culled
     FROM photos
     WHERE decided_at IS NOT NULL AND decided_at >= ?${src.sql}`,
    sinceMs,
    ...src.params,
  );
  return { decided: Number(row?.decided ?? 0), culled: Number(row?.culled ?? 0) };
}

// ----------------------------------------------------- library insights

/** One month of the capture histogram; `month` is null for undated. */
export interface MonthBucket {
  /** "YYYY-MM", or null for the undated bucket. */
  month: string | null;
  total: number;
  /** Of those, carrying a verdict. */
  reviewed: number;
}

/**
 * Photos per capture MONTH with their reviewed share (m0.8.2).
 *
 * Grouped on `substr(day, 1, 7)` rather than on `taken_at`: `day` is the
 * indexed local-day key the rest of the app already agrees on, and
 * deriving months from a UTC epoch would drift across timezones for
 * photos taken near midnight. Undated photos have a NULL day and land in
 * their own bucket, which is exactly where the UI wants them.
 *
 * Counts TRACKED rows, so it plots what the scan has seen — unlike the
 * corpus breakdown, which uses the MediaStore total. Documented rather
 * than corrected: MediaStore cannot report per-month counts without a
 * query per month.
 */
export async function getCaptureHistogram(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<MonthBucket[]> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ month: string | null; total: number; reviewed: number }>(
    `SELECT substr(day, 1, 7) AS month,
            COUNT(*) AS total,
            SUM(CASE WHEN state IN ('kept', 'culled', 'trashed')
                     THEN 1 ELSE 0 END) AS reviewed
     FROM photos
     WHERE is_present = 1${src.sql}
     GROUP BY month
     ORDER BY month`,
    ...src.params,
  );
  return rows.map((row) => ({
    month: row.month,
    total: Number(row.total),
    reviewed: Number(row.reviewed),
  }));
}

/** Where the review front has reached (m0.8.2). */
export interface BacklogFrontier {
  /** Oldest capture day carrying a verdict — how far back you have got. */
  reviewedBackTo: string | null;
  /** Oldest capture day still holding unreviewed photos. */
  oldestUnreviewedDay: string | null;
  /** Undated photos still awaiting review (they sit outside the calendar). */
  undatedPending: number;
}

export async function getBacklogFrontier(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<BacklogFrontier> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{
    reviewedBackTo: string | null;
    oldestUnreviewedDay: string | null;
    undatedPending: number;
  }>(
    `SELECT
       MIN(CASE WHEN state IN ('kept', 'culled', 'trashed') THEN day END)
         AS reviewedBackTo,
       MIN(CASE WHEN state = 'unreviewed' THEN day END) AS oldestUnreviewedDay,
       SUM(CASE WHEN state = 'unreviewed' AND day IS NULL THEN 1 ELSE 0 END) AS undatedPending
     FROM photos WHERE is_present = 1${src.sql}`,
    ...src.params,
  );
  return {
    reviewedBackTo: row?.reviewedBackTo ?? null,
    oldestUnreviewedDay: row?.oldestUnreviewedDay ?? null,
    undatedPending: Number(row?.undatedPending ?? 0),
  };
}

/** Scan-recorded bytes by review state (m0.8.2). */
export interface StorageBreakdown {
  /** Photos with a recorded size — the mean's honest denominator. */
  sized: number;
  /** Photos the scan has not sized yet (excluded from every sum). */
  unsized: number;
  bytes: { kept: number; staged: number; unreviewed: number };
}

export async function getStorageBreakdown(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<StorageBreakdown> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{
    sized: number;
    unsized: number;
    kept: number;
    staged: number;
    unreviewed: number;
  }>(
    `SELECT COUNT(size_bytes) AS sized,
            SUM(CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END) AS unsized,
            COALESCE(SUM(CASE WHEN state IN ('kept', 'trashed') THEN size_bytes END), 0) AS kept,
            COALESCE(SUM(CASE WHEN state = 'culled' THEN size_bytes END), 0)
              AS staged,
            COALESCE(SUM(CASE WHEN state = 'unreviewed' THEN size_bytes END), 0) AS unreviewed
     FROM photos WHERE is_present = 1${src.sql}`,
    ...src.params,
  );
  return {
    sized: Number(row?.sized ?? 0),
    unsized: Number(row?.unsized ?? 0),
    bytes: {
      kept: Number(row?.kept ?? 0),
      staged: Number(row?.staged ?? 0),
      unreviewed: Number(row?.unreviewed ?? 0),
    },
  };
}

/** Similarity-group shape — the app's reason for existing, in numbers. */
export interface BurstStats {
  /** Present photos sitting in a similarity group. */
  photosInGroups: number;
  /** Groups holding them. */
  groups: number;
  /** Members of groups where EVERY member has been decided. */
  decidedMembers: number;
  /** Of those, the ones kept (done or to-edit). */
  decidedKept: number;
}

/**
 * Burst statistics. `decidedMembers / decidedKept` is the "you keep 1 of
 * N" figure, and it counts only FULLY decided groups: a half-reviewed
 * group would report a keep rate for work not yet done.
 */
export async function getBurstStats(
  db: SQLiteDatabase,
  roots: readonly string[] | null = null,
): Promise<BurstStats> {
  const src = sourceClause(roots, 'p.uri');
  const row = await db.getFirstAsync<{ photosInGroups: number; groups: number }>(
    `SELECT COUNT(*) AS photosInGroups, COUNT(DISTINCT a.group_id) AS groups
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}`,
    ...src.params,
  );
  const decided = await db.getFirstAsync<{ members: number; kept: number }>(
    `SELECT COUNT(*) AS members,
            SUM(CASE WHEN p.state = 'kept' THEN 1 ELSE 0 END) AS kept
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}
       AND a.group_id NOT IN (
         SELECT a2.group_id FROM photo_group_assignments a2
         JOIN photos p2 ON p2.asset_id = a2.photo_id
         WHERE a2.group_id IS NOT NULL AND p2.state = 'unreviewed'
       )`,
    ...src.params,
  );
  return {
    photosInGroups: Number(row?.photosInGroups ?? 0),
    groups: Number(row?.groups ?? 0),
    decidedMembers: Number(decided?.members ?? 0),
    decidedKept: Number(decided?.kept ?? 0),
  };
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
       (SELECT COUNT(*) FROM photo_actions
         WHERE kind = 'edit' AND resolved_at IS NOT NULL) AS editsCompleted,
       (SELECT COUNT(*) FROM photo_actions
         WHERE kind = 'favourite' AND resolved_at IS NOT NULL) AS favouritesApplied
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
  const guard =
    onlyIfToEditAt === undefined
      ? ''
      : ` AND EXISTS (SELECT 1 FROM photo_actions pa
                       WHERE pa.photo_id = photos.asset_id AND pa.kind = 'edit'
                         AND pa.state IN ('queued', 'error') AND pa.queued_at IS ?)`;
  const params: (string | number | null)[] = [hash, assetId];
  if (onlyIfToEditAt !== undefined) params.push(onlyIfToEditAt);
  await db.runAsync(
    `UPDATE photos SET content_hash = ? WHERE asset_id = ? AND content_hash IS NULL${guard}`,
    ...params,
  );
}
