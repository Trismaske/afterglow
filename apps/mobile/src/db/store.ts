/**
 * Persistence operations over the schema in database.ts.
 * All multi-statement writes run in exclusive transactions.
 *
 * Verdicts (docs/STATE_MODEL.md): SQLite `photos.state` is the source of
 * truth and holds exactly ONE verdict per photo:
 *
 *   unreviewed ──review──┬─▶ culled ─▶ (system trash) ─▶ trashed
 *                        └─▶ kept
 *
 * A keep writes 'kept' at swipe time. Edit is a pending ACTION in
 * photo_actions (m0.8.2), never a verdict. 'confirmed' is deliberately
 * never persisted (m0.1 decision: SQLite keeps 'culled' until the system
 * trash request succeeds).
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
import { sourceLikePattern, type SourceRoot } from '../lib/sources';
import { rawIdOf, volumeOf } from '../lib/mediaIdentity';
import { dayKey, monthDayBounds, rangeOfDayKey, UNDATED_DAY_KEY } from '../lib/dates';
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
  /** The mounted set the UI rendered under (m0.8.3 §5): the compare
   * whole-table revalidation judges outsiders over the SAME population
   * Compare showed — an unreachable member is outside the table. */
  mounted?: readonly string[] | null;
  /** A duel carrying verdicts claims to be the whole table UNLESS this
   * is explicitly false (m0.8.6 D7): the triage "Keep this one" writes a
   * NARROW, explicitly-targeted keep on the winner and says nothing
   * about the rest of the table, so the outsider check must not run for
   * it. Defaulting to the stricter claim keeps the guard fail-closed. */
  duelClaimsWholeTable?: boolean;
  /** D5 (m0.8.6): the state editor's DELIBERATE un-review clears its
   * group's entire Compare history in the same transaction, so the
   * metadata freeze releases and the group returns to the scan's reach.
   * Editor-only by design — the deck's undo and CullList's Restore never
   * pass this, so a transient unreviewed state cannot dissolve duels. */
  deleteDuelsForGroup?: number;
}

/**
 * DB-side photo scope (m0.4 stage 3). Day-keyed queries use the `day`
 * column (matching the Recent-days rollups exactly); month scopes key on
 * the same column (m0.8.6 change 6 — `taken_at` is the mtime fallback
 * for undated photos, so a month keyed on it sweeps them into whichever
 * month their file times land in, the S10e "chip over-counts by exactly
 * the undated GIFs" defect); everything else scopes by `taken_at` range.
 * All progress surfaces share the same store functions through this
 * union. An open-ended range (`startMs: 0`, `endMs: Infinity`) is the
 * whole tracked corpus — undated photos included, since `taken_at` is
 * NOT NULL (the mtime fallback) even when their `day` is.
 */
export type PhotoScope = { day: string } | { month: string } | { startMs: number; endMs: number };

/** Stable identity string for a scope — the effect-dependency stand-in
 * for the scope object in the progress screens. */
export function scopeKeyOf(scope: PhotoScope): string {
  if ('day' in scope) return `d:${scope.day}`;
  if ('month' in scope) return `m:${scope.month}`;
  return `r:${scope.startMs}:${scope.endMs}`;
}

function scopeClause(scope: PhotoScope): { sql: string; params: (string | number)[] } {
  if ('day' in scope) {
    return scope.day === UNDATED_DAY_KEY
      ? // The Unknown-day pseudo-day: photos without a capture date.
        { sql: 'day IS NULL', params: [] }
      : { sql: 'day = ?', params: [scope.day] };
  }
  if ('month' in scope) {
    // Half-open range on the indexed `day` column (idx_photos_day):
    // NULL day matches no month by construction — undated photos live
    // only in the Unknown-day pseudo-day, never in a calendar month.
    const bounds = monthDayBounds(scope.month);
    return { sql: 'day >= ? AND day < ?', params: [bounds.fromDay, bounds.toDayExclusive] };
  }
  return {
    sql: 'taken_at BETWEEN ? AND ?',
    // An open-ended range arrives as Infinity (undated-photo
    // contract in lib/media.ts) — clamp for the SQL binding.
    params: [scope.startMs, Number.isFinite(scope.endMs) ? scope.endMs : Number.MAX_SAFE_INTEGER],
  };
}

/**
 * Photo-source roots as an SQL fragment (m0.3.1; volume-qualified since
 * m0.8.3 D4). `roots` null/empty = "All folders" (no filter). Each root
 * contributes `volume_name = ? AND uri LIKE '%/<dir>/%'` — the volume
 * term is what keeps the same relative path on two volumes two distinct
 * sources; the LIKE half's accepted looseness is documented in
 * sources.ts. `column` prefixes BOTH terms' table alias.
 */
function sourceClause(
  roots: readonly SourceRoot[] | null | undefined,
  column = 'uri',
): {
  sql: string;
  params: string[];
} {
  if (!roots || roots.length === 0) return { sql: '', params: [] };
  const table = column.includes('.') ? `${column.slice(0, column.indexOf('.'))}.` : '';
  const terms = roots
    .map(() => `(${table}volume_name = ? AND ${column} LIKE ? ESCAPE '\\')`)
    .join(' OR ');
  return {
    sql: ` AND (${terms})`,
    params: roots.flatMap((root) => [root.volume, sourceLikePattern(root.dir)]),
  };
}

/**
 * Reachability predicate (m0.8.3 phase 3, D5b): `volume_name IN
 * (mounted)` beside `is_present = 1` on every review-scope read. SCOPE,
 * NOT STATE — derived at query time from the mounted set the caller
 * fetched for this burst (lib/mountedVolumes.ts); nothing is ever
 * stored, and unmount/unmount writes nothing. Null/undefined = the set
 * is unknowable — no predicate, show everything (the provider's
 * documented fail direction). Empty = nothing mounted — match nothing.
 */
function reachClause(
  mounted: readonly string[] | null | undefined,
  column = 'volume_name',
): { sql: string; params: string[] } {
  if (mounted === null || mounted === undefined) return { sql: '', params: [] };
  if (mounted.length === 0) return { sql: ' AND 0', params: [] };
  return {
    sql: ` AND ${column} IN (${mounted.map(() => '?').join(',')})`,
    params: [...mounted],
  };
}

/** Read one settings value (null when unset). Settings are plain
 * key/value rows; every consumer parses the raw string with
 * fallback-to-default (the lib/comparePrefs.ts / lib/accentTheme.ts
 * pattern), so an unset or unparseable row never wedges a screen. */
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
export async function countStagedCulls(
  db: SQLiteDatabase,
  /** m0.8.3 §5: an unreachable staged cull is not confirmable work — its
   * file is on an absent card — so the queue badge excludes it. */
  mounted: readonly string[] | null = null,
): Promise<number> {
  const reach = reachClause(mounted);
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos WHERE state = 'culled' AND is_present = 1${reach.sql}`,
    ...reach.params,
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
  /** m0.8.3 §5: unreachable staged culls stay staged but leave the list
   * (and the confirm flow) until their card returns. */
  mounted: readonly string[] | null = null,
): Promise<StagedCullRow[]> {
  const reach = reachClause(mounted);
  return db.getAllAsync<StagedCullRow>(
    `SELECT asset_id, uri, taken_at, day FROM photos
     WHERE state = 'culled' AND is_present = 1${reach.sql}
     ORDER BY taken_at ASC${limit === undefined ? '' : ' LIMIT ?'}`,
    ...reach.params,
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
export interface ReviewDecisionResult {
  /** Ids whose verdict UPDATE actually landed. */
  appliedIds: string[];
  /**
   * How many of those went unreviewed → kept/culled: the day's FRESH
   * review work, and the only thing the daily goal counts.
   *
   * Sourced here rather than by the caller (m0.8.5, A3) so that every
   * verdict path credits the goal by construction — including the ones
   * that do not exist yet.
   */
  freshDecisions: number;
}

export async function applyReviewDecisions(
  db: SQLiteDatabase,
  changes: readonly [assetId: string, verdict: ReviewVerdict][],
  at: number,
  extras: PersistDecisionExtras = {},
): Promise<ReviewDecisionResult> {
  // The ids whose verdict UPDATE actually landed (codex r9): a batch
  // deliberately skips externally-reconciled rows without throwing, so
  // callers crediting counts (goal notes, optimistic patches) must be
  // told what committed, not what was requested.
  const appliedIds: string[] = [];
  let freshDecisions = 0;
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
    // write — recording/culling against the wrong group must abort whole
    // (the provider surfaces the error; nothing commits).
    if (extras.duel) {
      const members = await txn.getAllAsync<{ photo_id: string }>(
        `SELECT a.photo_id FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id = ? AND a.photo_id IN (?, ?)
           -- Both endpoints must still be DUELABLE — undecided or kept
           -- (F11 lets kept members rejoin a duel; staged culls stay
           -- out on both endpoints): an externally removed, trashed or
           -- staged endpoint would record a duel against an unavailable
           -- photo, metadata-freezing the group around it.
           AND p.is_present = 1 AND p.state IN ('unreviewed', 'kept')`,
        Number(extras.duel.groupId),
        extras.duel.winnerId,
        extras.duel.loserId,
      );
      if (members.length !== 2) {
        throw new Error('This group changed while comparing — reopen it and try again.');
      }
      // A duel that WRITES verdicts claims to be the whole table (F15):
      // every alive member must be one of the two endpoints. Compare
      // checks this before offering the dialog, but a warm scan can add
      // an undecided member between its load and this write — a verdict
      // would then close a question the duel never asked. The triage
      // "Keep this one" (m0.8.6 D7) opts out explicitly: a targeted keep
      // on one endpoint makes no whole-table claim, and the endpoint
      // check above is its narrow guard.
      if (changes.length > 0 && extras.duelClaimsWholeTable !== false) {
        // The whole-table claim is judged over the SAME population the
        // UI showed (m0.8.3 §5, codex phase-3): an unreviewed member on
        // an ejected card is outside the table Compare offered, so it
        // must not fail a legitimate duel — its verdict question waits
        // for remount, exactly like the rest of its card.
        const duelReach = reachClause(extras.mounted ?? null, 'p.volume_name');
        const outsider = await txn.getFirstAsync<{ photo_id: string }>(
          `SELECT a.photo_id FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
           WHERE a.group_id = ? AND a.photo_id NOT IN (?, ?)
             AND p.is_present = 1 AND p.state = 'unreviewed'${duelReach.sql}
           LIMIT 1`,
          Number(extras.duel.groupId),
          extras.duel.winnerId,
          extras.duel.loserId,
          ...duelReach.params,
        );
        if (outsider) {
          throw new Error('This group changed while comparing — reopen it and try again.');
        }
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
    // Each row's prior decided_at, read INSIDE the transaction (m0.8.5,
    // A3). The daily goal counts today's reviewing WORK, and that
    // judgment must come from the write's own view of the rows, never
    // from what a screen rendered: every caller used to compute it from
    // a cached member list, and every caller that forgot simply did not
    // count (the state editor, History re-decides).
    //
    // decided_at, not the prior verdict, is what makes a decision
    // "fresh", because that is exactly what `getReviewedCountsByDay`
    // counts — one row per photo whose LATEST stamp falls in the day. A
    // photo already stamped today therefore adds nothing however often
    // it is re-decided, cleared and decided again included (clearing
    // deliberately keeps the stamp). A photo stamped on an earlier day
    // does count: its row moves into today's bucket. Judging on the
    // verdict alone drifted from the number the ring shows, which is how
    // a celebration fires before the goal is visibly reached.
    //
    // Chunked to stay clear of SQLite's variable limit; one query per
    // 400 rows, against a loop that already runs one UPDATE per row.
    const priorDecidedAt = new Map<string, number | null>();
    for (let i = 0; i < changes.length; i += 400) {
      const slice = changes.slice(i, i + 400);
      const rows = await txn.getAllAsync<{ asset_id: string; decided_at: number | null }>(
        `SELECT asset_id, decided_at FROM photos WHERE asset_id IN (${slice
          .map(() => '?')
          .join(',')})`,
        ...slice.map(([assetId]) => assetId),
      );
      for (const row of rows) priorDecidedAt.set(row.asset_id, row.decided_at);
    }
    const today = dayKey(at);
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
      appliedIds.push(assetId);
      // Fresh work only: a clear writes no stamp, and a row already
      // stamped today is already inside the number the goal ring shows.
      const stamp = priorDecidedAt.get(assetId) ?? null;
      if (
        (verdict === 'kept' || verdict === 'culled') &&
        (stamp === null || dayKey(stamp) !== today)
      )
        freshDecisions += 1;
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
    if (extras.duel) {
      await txn.runAsync(
        `INSERT INTO duels (group_id, winner_id, loser_id, kept_both, at)
         VALUES (?, ?, ?, ?, ?)`,
        extras.duel.groupId,
        extras.duel.winnerId,
        extras.duel.loserId,
        // null = verdict-free triage — excluded from the kept-both stat.
        extras.duel.keptBoth === null ? null : extras.duel.keptBoth ? 1 : 0,
        extras.duel.at,
      );
    }
    if (extras.deleteDuelsForGroup !== undefined) {
      // D5: group-wide, or the metadata freeze survives on the pairs not
      // deleted (any remaining duel keeps EXISTS true).
      await txn.runAsync(
        `DELETE FROM duels WHERE group_id = ?`,
        String(extras.deleteDuelsForGroup),
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
  return { appliedIds, freshDecisions };
}

/**
 * Eject photos to durable singles: the explicitly "not related" photo
 * plus the survivor when the group dissolved. Marks user_single so no
 * scan ever regroups them, then runs the shared repairs.
 */
async function applyPhotoSingles(
  txn: SQLiteDatabase,
  assetIds: readonly string[],
  /** Mounted volumes (m0.8.3 final cycle O1): the survivor promotion is
   * a durable, never-regroupable verdict about a photo — it must not
   * land on a member the user could not see. Null = unknowable =
   * today's semantics (query-side fail open). */
  mounted: readonly string[] | null = null,
): Promise<void> {
  // An UNREACHABLE present survivor keeps its assignment byte-for-byte
  // (plan §5): the promotion skips it, and the mounted-aware repair
  // below defers its rump group; the next pass with every member
  // reachable re-windows it normally.
  const survivorReachable =
    mounted === null
      ? ''
      : mounted.length === 0
        ? ` AND NOT EXISTS (SELECT 1 FROM photos sp
              WHERE sp.asset_id = a.photo_id AND sp.is_present = 1)`
        : ` AND NOT EXISTS (SELECT 1 FROM photos sp
              WHERE sp.asset_id = a.photo_id AND sp.is_present = 1
                AND sp.volume_name NOT IN (${mounted.map(() => '?').join(',')}))`;
  const survivorParams = mounted ?? [];
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
           ${survivorReachable}
       )`,
      ...batch,
      ...batch,
      ...batch,
      ...survivorParams,
    );
    await txn.runAsync(
      `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0, user_single = 1
       WHERE photo_id IN (${placeholders})`,
      ...batch,
    );
  }
  await repairGroupMembership(txn, undefined, mounted);
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
  /** Mounted volumes (m0.8.3 phase 2, codex): when given, a group
   * holding any member on an UNMOUNTED volume is left alone by the
   * dissolve step — a real deletion of its mounted partner must not
   * rewrite the unreachable member's assignment while its card is out
   * (plan §5 byte-for-byte). The deferral self-heals: the next pass
   * with every member reachable re-windows and repairs normally.
   * Scan AND user-driven removal paths pass it (final cycle O1/O2);
   * omitted/null = pre-m0.8.3 semantics (mount state unknowable). */
  mountedVolumes?: readonly string[] | null,
): Promise<void> {
  if (groupIds !== undefined && groupIds.length === 0) return;
  const scopes: (readonly number[] | null)[] =
    groupIds === undefined ? [null] : chunk([...new Set(groupIds)], IN_CHUNK);
  // The deferral predicate: no member on an unmounted volume. With no
  // mounted set given, every group qualifies (1=1).
  const reachableGuard =
    mountedVolumes === null || mountedVolumes === undefined
      ? '1=1'
      : mountedVolumes.length === 0
        ? // Nothing mounted: every grouped photo is unreachable — defer all.
          '0'
        : `NOT EXISTS (
             SELECT 1 FROM photo_group_assignments ua
             JOIN photos up ON up.asset_id = ua.photo_id
             WHERE ua.group_id = g.id
               -- PRESENT unreachable members only (final cycle M3): an
               -- absent tombstone on an ejected volume is not "waiting
               -- to be seen again" — deferring for it would strand live
               -- one-photo rump groups.
               AND up.is_present = 1
               AND up.volume_name NOT IN (${mountedVolumes.map(() => '?').join(',')})
           )`;
  const guardParams = mountedVolumes ?? [];
  for (const scope of scopes) {
    const inList = scope === null ? '' : `(${scope.map(() => '?').join(',')})`;
    const params = scope === null ? [] : scope;
    await txn.runAsync(
      `UPDATE photo_group_assignments SET group_id = NULL, time_attached = 0
       WHERE group_id IN (
         SELECT g.id FROM photo_groups g
         WHERE ${scope === null ? '' : `g.id IN ${inList} AND `}
           ${reachableGuard} AND
           (SELECT COUNT(*) FROM photo_group_assignments a
                JOIN photos p ON p.asset_id = a.photo_id
                WHERE a.group_id = g.id AND p.is_present = 1) < 2
       )`,
      ...params,
      ...guardParams,
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
  /** Mounted volumes at the tap (final cycle O1) — see applyPhotoSingles. */
  mounted: readonly string[] | null = null,
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
    await applyPhotoSingles(txn, assetIds, mounted);
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
  /** 1 = the member itself matches the active source filter (always 1
   * when unfiltered). Projected ONLY by listGroupsForDay, for the
   * DayProgress CTA's eligibility check: a group queues whole via any
   * in-source member, so out-of-source members must not qualify it
   * (codex r7). */
  in_source?: number;
}

/** One reviewable cull group from the continuous grouping run. */
export interface ReviewGroupRow {
  groupId: number;
  /** The browse read's SQL ordering key (MAX taken_at over src+reach
   * filtered, non-trashed members) — the ONLY legal source for the next
   * page's keyset cursor (m0.8.6 self-review finding 2): the members
   * projection applies no source filter, so re-deriving the cursor from
   * members[0] can inflate past the SQL anchor and re-match the same
   * group. Minted by fetchBrowseGroupsPage; absent on pending reads. */
  anchor?: number;
  /** NEWEST-first members, all states (the deck badges non-unreviewed).
   * Every deck reads most-recently-taken first (Tristan, m0.8.2). */
  members: ReviewMemberRow[];
  /** Present members hidden by the mounted filter (m0.8.3, §5 partial-
   * group naming: "N on unmounted SD card"). Absent/0 = whole group. */
  unreachableCount?: number;
}

/**
 * The review queue: groups that still hold at least one unreviewed,
 * present member, newest group first (continuous scan fills newest-first,
 * so review starts with the most recent shots). `limit` bounds the page.
 */
async function listReviewGroupsIn(
  txn: SQLiteDatabase,
  limit: number,
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
): Promise<ReviewGroupRow[]> {
  // The source filter gates which groups QUEUE (a pending in-source
  // member); a queued group still shows all its members — the deck always
  // works on whole groups. Reachability (m0.8.3, D5b) gates BOTH sides:
  // an unreachable pending member must not queue its group, and a queued
  // group shows only its reachable members while a card is out (§5 — the
  // deck header names the rest).
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  {
    // CROSS JOIN is SQLite's documented join-order hint: the EXISTS must
    // walk THIS group's few assignments and probe photos by primary key.
    // Left to itself the planner started from idx_photos_present_state —
    // every group re-scanning every unreviewed photo, ~200M probes and a
    // 14 s read on a 27k corpus (measured; queuePlan.real.test.ts pins
    // the plan).
    const groups = await txn.getAllAsync<{
      id: number;
      newest: number;
    }>(
      `SELECT g.id,
            (SELECT MAX(p.taken_at) FROM photo_group_assignments a
              JOIN photos p ON p.asset_id = a.photo_id
              WHERE a.group_id = g.id AND p.is_present = 1${reach.sql}) AS newest
     FROM photo_groups g
     WHERE EXISTS (
       SELECT 1 FROM photo_group_assignments a CROSS JOIN photos p
       WHERE a.group_id = g.id AND p.asset_id = a.photo_id
         AND p.state = 'unreviewed' AND p.is_present = 1${src.sql}${reach.sql}
     )
     ORDER BY newest DESC
     LIMIT ?`,
      ...reach.params,
      ...src.params,
      ...reach.params,
      limit,
    );
    if (groups.length === 0) return [];
    // Ordered by the newest REACHABLE member (codex phase-3): a hidden
    // newer SD member must not pull a group ahead of what the page
    // actually shows — the timeline's anchors come from visible members.
    const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
      `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IN (${groups.map(() => '?').join(',')}) AND p.is_present = 1${reach.sql}
       ORDER BY p.taken_at DESC, p.asset_id DESC`,
      ...groups.map((g) => g.id),
      ...reach.params,
    );
    // §5 partial-group naming for the COMMON pending path (codex
    // phase-3): the deck renders queue rows directly, so the hidden
    // count must ride the same snapshot — not only getReviewGroup's.
    const hiddenByGroup = new Map<number, number>();
    if (reach.sql !== '') {
      const totals = await txn.getAllAsync<{ group_id: number; n: number }>(
        `SELECT a.group_id, COUNT(*) AS n
           FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
          WHERE a.group_id IN (${groups.map(() => '?').join(',')}) AND p.is_present = 1
          GROUP BY a.group_id`,
        ...groups.map((g) => g.id),
      );
      for (const row of totals) hiddenByGroup.set(Number(row.group_id), Number(row.n));
    }
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
    return groups.map((g) => {
      const groupMembers = byGroup.get(Number(g.id)) ?? [];
      const present = hiddenByGroup.get(Number(g.id));
      return {
        groupId: Number(g.id),
        members: groupMembers,
        unreachableCount: present === undefined ? 0 : Math.max(0, present - groupMembers.length),
      };
    });
  }
}

/** Public wrapper: headers and members read from ONE exclusive snapshot —
 * a scan window committing between the split queries could return
 * obsolete groups with empty member lists (blank deck). */
export async function listReviewGroups(
  db: SQLiteDatabase,
  limit: number,
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<ReviewGroupRow[]> {
  let out: ReviewGroupRow[] = [];
  await withReadTransaction(db, async (txn) => {
    out = await listReviewGroupsIn(txn, limit, roots, mounted);
  });
  return out;
}

/** Keyset cursor for the browse-timeline group stream (m0.8.6 D1):
 * anchor = the group's newest visible member's taken_at, id-tiebroken
 * like every newest-first read here. */
export interface BrowseGroupCursor {
  anchor: number;
  groupId: number;
}

/**
 * One newest-first keyset page of ALL groups — reviewed included — for
 * the Timeline's Everything filter (m0.8.6, F2/D1). A separate read
 * path by design: the pending feed's predicates, optimistic patches and
 * horizon tails stay untouched behind the Unfinished filter, while this
 * read is plain refetch-on-version browse data. Members are visible
 * rows only (present, not trashed, reachable); a group whose every
 * member is trashed or unreachable simply has no anchor and drops out.
 * Hidden reachable-vs-not members are named exactly like the pending
 * read (unreachableCount).
 */
export async function fetchBrowseGroupsPage(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
  before: BrowseGroupCursor | undefined,
  limit: number,
): Promise<ReviewGroupRow[]> {
  const srcExists = sourceClause(roots, 'p2.uri');
  const reachExists = reachClause(mounted, 'p2.volume_name');
  const reach = reachClause(mounted, 'p.volume_name');
  const keyset = before === undefined ? '' : ' HAVING anchor < ? OR (anchor = ? AND g.id < ?)';
  const keysetParams = before === undefined ? [] : [before.anchor, before.anchor, before.groupId];
  // The source filter gates ELIGIBILITY only; the anchor — the ordering
  // key AND the cursor — spans the WHOLE reachable group (codex r5),
  // exactly as the pending read anchors (listReviewGroupsIn): the card
  // displays members[0] of the whole reachable projection, so a source-
  // scoped anchor let a card wearing timestamp 90 merge below units at
  // 50. With no source filter the EXISTS collapses away entirely.
  const eligibility =
    srcExists.sql === ''
      ? ''
      : ` AND EXISTS (SELECT 1 FROM photo_group_assignments a2
             JOIN photos p2 ON p2.asset_id = a2.photo_id
            WHERE a2.group_id = g.id AND p2.is_present = 1
              AND p2.state <> 'trashed'${srcExists.sql}${reachExists.sql})`;
  const eligibilityParams =
    srcExists.sql === '' ? [] : [...srcExists.params, ...reachExists.params];
  let out: ReviewGroupRow[] = [];
  await withReadTransaction(db, async (txn) => {
    const heads = await txn.getAllAsync<{ id: number; anchor: number }>(
      `SELECT g.id AS id, MAX(p.taken_at) AS anchor
         FROM photo_groups g
         JOIN photo_group_assignments a ON a.group_id = g.id
         JOIN photos p ON p.asset_id = a.photo_id
        WHERE p.is_present = 1 AND p.state <> 'trashed'${reach.sql}${eligibility}
        GROUP BY g.id${keyset}
        ORDER BY anchor DESC, g.id DESC
        LIMIT ?`,
      ...reach.params,
      ...eligibilityParams,
      ...keysetParams,
      limit,
    );
    if (heads.length === 0) return;
    const ids = heads.map((h) => Number(h.id));
    const placeholders = ids.map(() => '?').join(',');
    const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
      `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
         FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
        WHERE a.group_id IN (${placeholders}) AND p.is_present = 1 AND p.state <> 'trashed'${reach.sql}
        ORDER BY p.taken_at DESC, p.asset_id DESC`,
      ...ids,
      ...reach.params,
    );
    const hiddenByGroup = new Map<number, number>();
    if (reach.sql !== '') {
      const totals = await txn.getAllAsync<{ group_id: number; n: number }>(
        // The SAME visibility rules as the members query beside it
        // (self-review finding 3): without the trashed exclusion, a
        // present-but-trashed member counted as "on unmounted SD card".
        `SELECT a.group_id, COUNT(*) AS n
           FROM photo_group_assignments a
           JOIN photos p ON p.asset_id = a.photo_id
          WHERE a.group_id IN (${placeholders}) AND p.is_present = 1
            AND p.state <> 'trashed'
          GROUP BY a.group_id`,
        ...ids,
      );
      for (const row of totals) hiddenByGroup.set(Number(row.group_id), Number(row.n));
    }
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
    const anchorOf = new Map(heads.map((h) => [Number(h.id), Number(h.anchor)]));
    out = heads
      .map((h) => {
        const groupMembers = byGroup.get(Number(h.id)) ?? [];
        const present = hiddenByGroup.get(Number(h.id));
        return {
          groupId: Number(h.id),
          anchor: anchorOf.get(Number(h.id)),
          members: groupMembers,
          unreachableCount: present === undefined ? 0 : Math.max(0, present - groupMembers.length),
        };
      })
      .filter((g) => g.members.length > 0);
  });
  return out;
}

/**
 * One newest-first keyset page of ALL ungrouped singles — reviewed
 * included, trashed excluded — for the Timeline's Everything filter
 * (m0.8.6, F2/D1). Same visibility rules as the browse groups read.
 */
export async function fetchBrowseSinglesPage(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
  before: { takenAt: number; assetId: string } | undefined,
  limit: number,
): Promise<ReviewMemberRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const keyset =
    before === undefined ? '' : ' AND (p.taken_at < ? OR (p.taken_at = ? AND p.asset_id < ?))';
  const keysetParams = before === undefined ? [] : [before.takenAt, before.takenAt, before.assetId];
  return db.getAllAsync<ReviewMemberRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
      WHERE a.group_id IS NULL AND p.is_present = 1 AND p.state <> 'trashed'${src.sql}${reach.sql}${keyset}
      ORDER BY p.taken_at DESC, p.asset_id DESC
      LIMIT ?`,
    ...src.params,
    ...reach.params,
    ...keysetParams,
    limit,
  );
}

/**
 * One group by id regardless of completion (browse/re-decide of a
 * finished group — gate 5); null when the group no longer exists or has
 * no present members.
 */
export async function getReviewGroup(
  db: SQLiteDatabase,
  groupId: number,
  mounted: readonly string[] | null = null,
): Promise<ReviewGroupRow | null> {
  // One snapshot for header + members (same race as listReviewGroups).
  let out: ReviewGroupRow | null = null;
  const reach = reachClause(mounted, 'p.volume_name');
  await withReadTransaction(db, async (txn) => {
    const group = await txn.getFirstAsync<{ id: number }>(
      'SELECT id FROM photo_groups WHERE id = ?',
      groupId,
    );
    if (!group) return;
    const members = await txn.getAllAsync<ReviewMemberRow>(
      `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id = ? AND p.is_present = 1${reach.sql}
       ORDER BY p.taken_at DESC, p.asset_id DESC`,
      groupId,
      ...reach.params,
    );
    if (members.length === 0) return;
    // §5 partial-group naming: how many members the mounted filter hid —
    // the deck header carries "N on unmounted SD card".
    const hidden =
      reach.sql === ''
        ? 0
        : Number(
            (
              await txn.getFirstAsync<{ n: number }>(
                `SELECT COUNT(*) AS n FROM photo_group_assignments a
                  JOIN photos p ON p.asset_id = a.photo_id
                  WHERE a.group_id = ? AND p.is_present = 1`,
                groupId,
              )
            )?.n ?? 0,
          ) - members.length;
    out = {
      groupId: Number(group.id),
      members,
      unreachableCount: hidden,
    };
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
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
): Promise<ReviewMemberRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const page = await txn.getAllAsync<ReviewMemberRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NULL AND p.state IN ('unreviewed', 'culled') AND p.is_present = 1${src.sql}${reach.sql}
     ORDER BY p.taken_at DESC, p.asset_id DESC
     LIMIT ?`,
    ...src.params,
    ...reach.params,
    limit,
  );
  // A WALL of staged culls must not hide older pending work (codex r9):
  // the feed keeps decided singles in place, so a full page can be all
  // staged culls — the timeline then holds no pending unit while the
  // queue counts say otherwise, and every "continue" door dead-ends on
  // the overview. When a FULL page carries no unreviewed row, append a
  // bounded unreviewed-only continuation from past the tail; every
  // appended row is older than the whole page, so the newest-first
  // ordering (and the timeline's read-time tail) stays truthful.
  if (page.length >= limit && !page.some((row) => row.state === 'unreviewed')) {
    const tail = page[page.length - 1];
    const pending = await txn.getAllAsync<ReviewMemberRow>(
      `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
       FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IS NULL AND p.state = 'unreviewed' AND p.is_present = 1${src.sql}${reach.sql}
         AND (p.taken_at < ? OR (p.taken_at = ? AND p.asset_id < ?))
       ORDER BY p.taken_at DESC, p.asset_id DESC
       LIMIT ?`,
      ...src.params,
      ...reach.params,
      tail.taken_at,
      tail.taken_at,
      tail.asset_id,
      limit,
    );
    return [...page, ...pending];
  }
  return page;
}

/** Public wrapper (tests, ad-hoc reads); ReviewContext uses
 * readReviewQueue for a cross-slice snapshot. */
export async function listSinglesFeed(
  db: SQLiteDatabase,
  limit: number,
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<ReviewMemberRow[]> {
  return listSinglesFeedIn(db, limit, roots, mounted);
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
 *
 * A WHOLE-DAY read (no range) is UNCAPPED: the day itself bounds it, and
 * the routes that take it — DayProgress "Review this day", the day deck,
 * keepAllSingles — promise the entire day, so a hidden page cap would
 * silently truncate a >cap-photo day while the header claims
 * completeness. A RUN read keeps the cap as insurance only: runs are cut
 * from the bounded pending feed, so a legitimate run can never reach it.
 */
export async function listSinglesForDeck(
  db: SQLiteDatabase,
  day: string,
  roots: readonly SourceRoot[] | null = null,
  range: { from: number; to: number } | null = null,
  mounted: readonly string[] | null = null,
): Promise<ReviewMemberRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const dayPredicate = day === UNDATED_DAY_KEY ? ' AND p.day IS NULL' : ' AND p.day = ?';
  // UNCAPPED for range reads too (codex r10): the cull-wall continuation
  // means a legitimate run CAN exceed the old 500-row insurance cap —
  // its range then spans a wall of staged culls plus the pending photos
  // past it, and a capped read would cut exactly the pending tail the
  // run exists to reach. Both scopes are naturally bounded (a day, a
  // run's inclusive range).
  const rangePredicate = range ? ' AND p.taken_at BETWEEN ? AND ?' : '';
  return db.getAllAsync<ReviewMemberRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NULL AND p.state IN ('unreviewed', 'culled', 'kept') AND p.is_present = 1${src.sql}${reach.sql}${dayPredicate}${rangePredicate}
     ORDER BY p.taken_at DESC, p.asset_id DESC`,
    ...src.params,
    ...reach.params,
    ...(day === UNDATED_DAY_KEY ? [] : [day]),
    ...(range ? [range.from, range.to] : []),
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<ReviewGroupRow[]> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const dayPredicate = day === UNDATED_DAY_KEY ? 'p.day IS NULL' : 'p.day = ?';
  // Per-member in_source projection (codex r7): the SAME containment
  // match the group-selection filter above uses, applied to each member
  // — a group queues whole via any in-source member, and the DayProgress
  // CTA must not count the out-of-source ones as eligible work.
  const memberInSource =
    !roots || roots.length === 0
      ? { sql: '1', params: [] as string[] }
      : {
          sql: `(CASE WHEN ${roots
            .map(() => "(p.volume_name = ? AND p.uri LIKE ? ESCAPE '\\')")
            .join(' OR ')} THEN 1 ELSE 0 END)`,
          params: roots.flatMap((root) => [root.volume, sourceLikePattern(root.dir)]),
        };
  // ONE snapshot for ids + headers + members (m0.8.1 — the previous
  // one-transaction-per-group shape opened a fresh SQLite connection per
  // group, a visible per-day cost on older devices).
  const groups: ReviewGroupRow[] = [];
  await withReadTransaction(db, async (txn) => {
    const ids = await txn.getAllAsync<{ group_id: number }>(
      `SELECT DISTINCT a.group_id FROM photo_group_assignments a
       JOIN photos p ON p.asset_id = a.photo_id
       WHERE a.group_id IS NOT NULL AND ${dayPredicate} AND p.is_present = 1${src.sql}${reach.sql}`,
      ...(day === UNDATED_DAY_KEY ? [] : [day]),
      ...src.params,
      ...reach.params,
    );
    for (const batch of chunk(
      ids.map((r) => Number(r.group_id)),
      IN_CHUNK,
    )) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      const headers = await txn.getAllAsync<{ id: number }>(
        `SELECT id FROM photo_groups WHERE id IN (${placeholders})`,
        ...batch,
      );
      const members = await txn.getAllAsync<ReviewMemberRow & { group_id: number }>(
        `SELECT a.group_id, p.asset_id, p.uri, p.taken_at, p.day, p.state, (EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = p.asset_id AND pa.kind = 'edit' AND pa.state IN ('queued', 'error'))) AS needs_edit, a.time_attached, ${memberInSource.sql} AS in_source
         FROM photo_group_assignments a
         JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id IN (${placeholders}) AND p.is_present = 1${reach.sql}
         ORDER BY p.taken_at DESC, p.asset_id DESC`,
        ...memberInSource.params,
        ...batch,
        ...reach.params,
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
          in_source: m.in_source,
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
  /** Capture day; NULL = honestly undated (m0.8.6 change 5) — the
   * viewer and editor render "Unknown day", never the mtime fallback. */
  day: string | null;
  state: PhotoState;
  needs_edit: number;
  /** Favourite direction currently queued: 1 apply, 0 remove, null none. */
  favourite_queued: number | null;
  /** Carried favourite: a RESOLVED apply whose direction still points at
   * favourited — the resolved half of FAVOURITE_HELD (directional; a
   * verified removal is not a favourite). Without it the panel would go
   * blank the moment a queued favourite applies, while the photo's badge
   * and History keep showing the carried heart. */
  favourite_applied: number;
  /** An organize move is waiting. */
  organize_queued: number;
  /** When the last organize move actually landed. */
  organize_applied_at: number | null;
  /** The organize row's RAW encoded target (volume + newline + path;
   * decodeOrganizeTarget in db/actions.ts). Null = no row, or a
   * target-less queue row (m0.8.2 F6). The panel shows the full album
   * path — the one place it lives one long-press away (codex r7). */
  organize_target: string | null;
  /** The last APPLIED move's raw encoded target (null before any
   * apply) — survives re-queues, so the superseded line can name the
   * album the photo actually sits in (codex r7). */
  organize_applied_target: string | null;
  /** A share pass resolved this photo at least once (resolved_at set) —
   * the carried half of the share pair, mirroring edit_completed_at
   * (codex r7). */
  share_carried: number;
  reviewed_at: number | null;
  /** Last completed edit cycle (the edit action's resolved_at). */
  edit_completed_at: number | null;
  /** Continuous group membership (null = single). */
  group_id: number | null;
  /** Grouped by time only — embedding missing (decision 5). */
  time_attached: number;
  /** User ejected it from a group ("Not related"). */
  user_single: number;
  /** Its group carries Compare history (m0.8.6 D5) — the state editor's
   * un-review confirm names the deletion this implies. */
  group_has_duels: number;
}

export async function getPhotoFacts(
  db: SQLiteDatabase,
  assetId: string,
): Promise<PhotoFacts | null> {
  return db.getFirstAsync<PhotoFacts>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day, p.state, p.reviewed_at,
            (EXISTS (SELECT 1 FROM photo_actions e WHERE e.photo_id = p.asset_id
                      AND e.kind = 'edit' AND e.state IN ('queued', 'error'))) AS needs_edit,
            (SELECT CAST(f.target AS INTEGER) FROM photo_actions f
              WHERE f.photo_id = p.asset_id AND f.kind = 'favourite'
                AND f.state IN ('queued', 'error')) AS favourite_queued,
            (EXISTS (SELECT 1 FROM photo_actions fv WHERE fv.photo_id = p.asset_id
                      AND fv.kind = 'favourite' AND fv.resolved_at IS NOT NULL
                      AND COALESCE(fv.target, fv.applied_target) = '1'))
              AS favourite_applied,
            (EXISTS (SELECT 1 FROM photo_actions o WHERE o.photo_id = p.asset_id
                      AND o.kind = 'organize' AND o.state IN ('queued', 'error')))
              AS organize_queued,
            (SELECT o2.resolved_at FROM photo_actions o2 WHERE o2.photo_id = p.asset_id
              AND o2.kind = 'organize') AS organize_applied_at,
            (SELECT o3.target FROM photo_actions o3 WHERE o3.photo_id = p.asset_id
              AND o3.kind = 'organize') AS organize_target,
            (SELECT o4.applied_target FROM photo_actions o4 WHERE o4.photo_id = p.asset_id
              AND o4.kind = 'organize') AS organize_applied_target,
            (EXISTS (SELECT 1 FROM photo_actions s WHERE s.photo_id = p.asset_id
                      AND s.kind = 'share' AND s.resolved_at IS NOT NULL)) AS share_carried,
            (SELECT e2.resolved_at FROM photo_actions e2 WHERE e2.photo_id = p.asset_id
              AND e2.kind = 'edit') AS edit_completed_at,
            a.group_id, COALESCE(a.time_attached, 0) AS time_attached,
            COALESCE(a.user_single, 0) AS user_single,
            (a.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM duels d
              WHERE d.group_id = CAST(a.group_id AS TEXT))) AS group_has_duels
     FROM photos p
     LEFT JOIN photo_group_assignments a ON a.photo_id = p.asset_id
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
 *
 * Returns the same ReviewDecisionResult contract as
 * applyReviewDecisions, and for the same reason (m0.8.5, A3): both
 * targets land on the verdict `kept`, so a re-decide made on a later
 * day than the original decision is fresh goal work — rescuing
 * yesterday's staged cull counts today (§10 check 13 found this path
 * returning nothing, so the ring never moved).
 */
export async function applyRedecision(
  db: SQLiteDatabase,
  assetId: string,
  target: 'keep' | 'to_edit',
  at: number,
): Promise<ReviewDecisionResult> {
  const result: ReviewDecisionResult = { appliedIds: [], freshDecisions: 0 };
  await withWriteTransaction(db, async (txn) => {
    // The prior stamp is read BEFORE the update writes decided_at = at —
    // the freshness rule compares the day of the decision being replaced.
    const prior = await txn.getFirstAsync<{ decided_at: number | null }>(
      'SELECT decided_at FROM photos WHERE asset_id = ?',
      assetId,
    );
    if (target === 'keep') {
      // The detection baseline (mod_time/content_hash) is NOT touched:
      // keep carries a queued edit across (header above), and the
      // baseline is that edit cycle's evidence — wiping it would
      // re-baseline against the already-edited file and silently lose
      // the detection the user is waiting on (the same guard
      // applyReviewDecisions carries on its 'unreviewed' reset).
      const moved = await txn.runAsync(
        `UPDATE photos SET state = 'kept',
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
    result.appliedIds.push(assetId);
    // Same rule as applyReviewDecisions: a row already stamped today is
    // already inside the number the goal ring shows.
    const stamp = prior?.decided_at ?? null;
    if (stamp === null || dayKey(stamp) !== dayKey(at)) result.freshDecisions = 1;
  });
  return result;
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
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
): Promise<QueueCounts> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const row = await txn.getFirstAsync<{ grouped: number; singles: number; groups: number }>(
    `SELECT
       SUM(CASE WHEN a.group_id IS NOT NULL THEN 1 ELSE 0 END) AS grouped,
       SUM(CASE WHEN a.group_id IS NULL THEN 1 ELSE 0 END) AS singles,
       COUNT(DISTINCT a.group_id) AS groups
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE p.state = 'unreviewed' AND p.is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
  );
  return { grouped: row?.grouped ?? 0, singles: row?.singles ?? 0, groups: row?.groups ?? 0 };
}

/** Public wrapper (Home CTA counts outside the queue snapshot). */
export async function countReviewQueue(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<QueueCounts> {
  return countReviewQueueIn(db, roots, mounted);
}

/** THE queue read (gate 5 + final review): groups, singles feed, and
 * counts from ONE exclusive snapshot — a scan window committing between
 * independent reads could cache a photo as both grouped and single, or
 * counts disagreeing with the arrays. */
export async function readReviewQueue(
  db: SQLiteDatabase,
  groupLimit: number,
  singlesLimit: number,
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
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
      groups: await listReviewGroupsIn(txn, groupLimit, roots, mounted),
      singles: await listSinglesFeedIn(txn, singlesLimit, roots, mounted),
      counts: await countReviewQueueIn(txn, roots, mounted),
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
  roots: readonly SourceRoot[] | null = null,
  /** Coverage and clear streaks EXCLUDE unreachable photos (m0.8.3 §5);
   * the Home banner carries the asterisk for a "clear" day earned by
   * ejecting a card. */
  mounted: readonly string[] | null = null,
): Promise<DayCoverageRow[]> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  // The undated bucket must survive a sinceDay bound (all-time needs it,
  // and `NULL >= '2026-01-01'` is NULL — i.e. filtered out), so the
  // bound explicitly keeps the NULL day.
  const bound = sinceDay === null ? '' : ' AND (day IS NULL OR day >= ?)';
  const rows = await db.getAllAsync<{ day: string | null; total: number; pending: number }>(
    `SELECT day,
            COUNT(*) AS total,
            SUM(CASE WHEN state = 'unreviewed' THEN 1 ELSE 0 END) AS pending
     FROM photos
     WHERE is_present = 1${src.sql}${reach.sql}${bound}
     GROUP BY day`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<{ groupsFound: number; reviewed: number }> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  const row = await db.getFirstAsync<{ groups: number; reviewed: number }>(
    `SELECT
       (SELECT COUNT(DISTINCT a.group_id) FROM photo_group_assignments a
        JOIN photos p ON p.asset_id = a.photo_id
        WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}${reach.sql}) AS groups,
       (SELECT COUNT(*) FROM photos p
        -- Home's denominator is the current MediaStore corpus — count
        -- only verdicts on PRESENT photos (trashed/removed rows left it).
        WHERE p.state IN ('kept', 'culled')
          AND p.is_present = 1${src.sql}${reach.sql}) AS reviewed`,
    ...src.params,
    ...reach.params,
    ...src.params,
    ...reach.params,
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
    // A group with ANY reviewed member — or GROUP-LEVEL metadata
    // (recorded duels) — is frozen WHOLE by the regroup boundary;
    // deleting its members here would dissolve it and orphan the duels.
    // Reset only fully-unreviewed metadata-free groups and non-ejected
    // singles.
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
             WHERE EXISTS (SELECT 1 FROM duels d WHERE d.group_id = CAST(photo_groups.id AS TEXT))
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
 * recorded compares (duel rows) — which freezes them whole against
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
         AND EXISTS (SELECT 1 FROM duels d WHERE d.group_id = CAST(photo_groups.id AS TEXT))`,
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
  /** m0.8.3 §5 (codex phase-3): the estimate must describe the SAME rows
   * as the mounted-scoped cull count beside it — and never stat files on
   * an absent card. */
  mounted: readonly string[] | null = null,
): Promise<{ scanned: number; unsized: string[] }> {
  const reach = reachClause(mounted);
  // The SUM lives in SQL (m0.8.1): Home used to receive EVERY staged row
  // and blocking-stat each one on the JS thread, per focus. Only rows the
  // v14 scan never sized need a stat, and the caller caps those.
  const row = await db.getFirstAsync<{ total: number; unsized: number }>(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total,
            SUM(CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END) AS unsized
     FROM photos WHERE state = 'culled' AND is_present = 1${reach.sql}`,
    ...reach.params,
  );
  const unsized =
    (row?.unsized ?? 0) === 0
      ? []
      : (
          await db.getAllAsync<{ uri: string }>(
            `SELECT uri FROM photos
             WHERE state = 'culled' AND is_present = 1 AND size_bytes IS NULL${reach.sql}
             LIMIT 200`,
            ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<number> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos
     WHERE day IS NULL AND is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
  /** Restrict to these volumes (m0.8.3 phase 2): the scan's unseen
   * reconciliation may only consider MOUNTED volumes' rows — an
   * unmounted volume's photos are absent from enumeration because the
   * volume is away, which is no evidence about the photos (plan §4
   * invariants 2 + 6). Null = no restriction. */
  volumes: readonly string[] | null = null,
): Promise<string[]> {
  const src = sourceClause(roots);
  // An EMPTY volume list means "nothing is mounted" — match no rows
  // (`IN ()` is not valid SQLite).
  const volumeClause =
    volumes === null
      ? ''
      : volumes.length === 0
        ? ' AND 0'
        : ` AND volume_name IN (${volumes.map(() => '?').join(',')})`;
  const rows = await db.getAllAsync<{ asset_id: string }>(
    `SELECT asset_id FROM photos WHERE is_present = 1${src.sql}${volumeClause}`,
    ...src.params,
    ...(volumes ?? []),
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
  /** D15 rescue marker: the mod_time at which this pass COMPLETED an
   * EXIF date read (found or absent). Absent/NULL = no read completed
   * this pass — the upsert then RETAINS the stored marker (COALESCE), so
   * a dated photo or a reuse pass never erases a past rescue's proof. */
  exifCheckedModTime?: number | null;
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
  /** Grow-only appends (m0.8.3 grilling): unfrozen photos the engine
   * clustered with an unreachable-frozen group's reachable members —
   * added to that group without touching any existing member row.
   * Revalidated in the transaction; a target that no longer qualifies
   * degrades the entry to the pre-grow plan shape (own group / single). */
  appends?: readonly ContinuousAppendWrite[];
}

export interface ContinuousAppendWrite {
  groupId: number;
  members: readonly string[];
  timeAttached: readonly string[];
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
  options: {
    abortIf?: () => boolean;
    /** Mounted volumes (m0.8.3 phase 2): the membership repair defers
     * dissolving groups that still hold an unreachable member. */
    mountedVolumes?: readonly string[] | null;
  } = {},
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
                             volume_name, raw_id, size_bytes, exif_checked_mod_time)
         VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           uri = excluded.uri,
           taken_at = excluded.taken_at,
           -- A scanned photo IS present, whatever marked it absent —
           -- including a "Forget this card, keep history" assertion whose
           -- card came back (m0.8.3 §7): the honest edge in that flow's
           -- copy is exactly this revival. (Trashed rows take the fuller
           -- restore transition above.)
           is_present = 1,
           size_bytes = COALESCE(excluded.size_bytes, photos.size_bytes),
           -- photos.mod_time is the in-place edit detector's baseline
           -- while a row is in an edit cycle: refreshing it here would
           -- make the pending edit look unchanged (silent detection loss).
           mod_time = CASE WHEN ${queuedClause('edit', 'photos.asset_id')}
                           THEN photos.mod_time ELSE excluded.mod_time END,
           day = excluded.day,
           volume_name = excluded.volume_name,
           raw_id = excluded.raw_id,
           -- The D15 marker only ever advances on a COMPLETED read; a
           -- pass that did not probe an UNDATED row passes NULL and must
           -- not erase the stored proof. But a DATED incoming row
           -- without the marker never entered the rescue at all — its
           -- date came from MediaStore, and a surviving marker would
           -- make Home's disjoint union (MediaStore range + rescued)
           -- count it twice (final cycle Q3).
           exif_checked_mod_time =
             CASE
               WHEN excluded.exif_checked_mod_time IS NOT NULL
                 THEN excluded.exif_checked_mod_time
               WHEN excluded.day IS NOT NULL THEN NULL
               ELSE photos.exif_checked_mod_time
             END`,
        photo.assetId,
        photo.uri,
        photo.takenAt,
        photo.modTime,
        photo.day,
        photo.volumeName,
        photo.rawId,
        photo.sizeBytes,
        photo.exifCheckedModTime ?? null,
      );
    }
    // Revalidate the plan INSIDE the transaction: the runner computed it
    // from reads that predate this write, and a review decision can land
    // in between (the scan runs in the background). Fresh state/assignment
    // reads + the same pure freeze rules decide what may still be written.
    const appendWrites = write.appends ?? [];
    const plannedIds = [
      ...new Set([
        ...write.groups.flatMap((g) => [...g.members]),
        ...write.singles,
        ...appendWrites.flatMap((a) => [...a.members]),
      ]),
    ];
    const liveAssignments = await getGroupAssignments(txn, plannedIds);
    const liveTouched = [
      ...new Set([
        ...[...liveAssignments.values()]
          .map((a) => a.groupId)
          .filter((g): g is number => g !== null),
        ...appendWrites.map((a) => a.groupId),
      ]),
    ];
    const liveMembers = await getGroupMembers(txn, liveTouched);
    const liveStateIds = new Set(plannedIds);
    for (const memberIds of liveMembers.values()) for (const m of memberIds) liveStateIds.add(m);
    const liveStates = await getStatesForAssets(txn, [...liveStateIds]);
    const metadataLive = await getMetadataGroupIds(txn, [...liveMembers.keys()]);
    const frozen = frozenPhotos(plannedIds, {
      states: liveStates,
      assignments: liveAssignments,
      groupMembers: liveMembers,
      metadataGroups: metadataLive,
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
      const groupResult = await txn.runAsync('INSERT INTO photo_groups (run_id) VALUES (?)', runId);
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
    // GROW-ONLY appends, revalidated on live state (m0.8.3 grilling): the
    // target must still be a growable group — it exists, carries no
    // review metadata, and holds at least one unreviewed member (D4,
    // codex r3: the old all-unreviewed demand was the retired contagion
    // rule — the planner marks unfinished MIXED unreachable groups
    // growable, and this guard rejected every one of its appends,
    // splitting similar photos solely because an SD card was absent) —
    // and each appended photo must itself still be unfrozen. A
    // disqualified entry degrades to the pre-grow plan shape (own group
    // when ≥2, single otherwise); existing member rows are never
    // touched either way.
    for (const append of appendWrites) {
      const additions = append.members.filter((id) => !frozen.has(id));
      if (additions.length === 0) continue;
      const targetMembers = liveMembers.get(append.groupId) ?? [];
      const targetGrowable =
        targetMembers.length > 0 &&
        !metadataLive.has(append.groupId) &&
        targetMembers.some((m) => (liveStates.get(m) ?? 'unreviewed') === 'unreviewed');
      const timeAttached = new Set(append.timeAttached);
      if (targetGrowable) {
        touchedGroups.add(append.groupId);
        for (const assetId of additions) {
          const live = liveAssignments.get(assetId);
          if (live && live.groupId === append.groupId) continue; // already a member
          await txn.runAsync(
            `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
             VALUES (?, ?, ?, ?)`,
            assetId,
            runId,
            append.groupId,
            timeAttached.has(assetId) ? 1 : 0,
          );
        }
      } else if (additions.length >= 2) {
        const groupResult = await txn.runAsync(
          'INSERT INTO photo_groups (run_id) VALUES (?)',
          runId,
        );
        const groupId = Number(groupResult.lastInsertRowId);
        touchedGroups.add(groupId);
        for (const assetId of additions) {
          await txn.runAsync(
            `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
             VALUES (?, ?, ?, ?)`,
            assetId,
            runId,
            groupId,
            timeAttached.has(assetId) ? 1 : 0,
          );
        }
      } else {
        await txn.runAsync(
          `INSERT OR REPLACE INTO photo_group_assignments (photo_id, run_id, group_id, time_attached)
           VALUES (?, ?, NULL, 0)`,
          additions[0],
          runId,
        );
      }
    }
    await repairGroupMembership(txn, [...touchedGroups], options.mountedVolumes);
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
): Promise<Map<string, { uri: string; takenAt: number; day: string | null }>> {
  const facts = new Map<string, { uri: string; takenAt: number; day: string | null }>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{
      asset_id: string;
      uri: string;
      taken_at: number;
      day: string | null;
    }>(
      `SELECT asset_id, uri, taken_at, day FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      facts.set(row.asset_id, { uri: row.uri, takenAt: Number(row.taken_at), day: row.day });
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

/** Which of the given assets carry the needs-edit flag. STATE-BLIND on
 * purpose: this set is the optimistic patch model's flag truth (the
 * patch carries a flag across cull/restore, and a live-only read would
 * disagree with it after every refresh — reviewPatch parity pins this).
 * The DECK disables the chip itself for a staged cull; the queues and
 * badges apply their own liveness where their question demands it. */
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
 * Live work only — a staged cull is not waiting to be edited, and
 * (m0.8.3 §5) neither is a photo whose volume is out; its action row
 * survives and the queue re-lists it on remount. Decided or not: a flag
 * on an undecided photo is legitimate ("the edit is what tells me
 * whether to keep it"), and the completed edit leaves the verdict alone
 * either way (see markEditDone). */
export async function getToEditPhotos(
  db: SQLiteDatabase,
  mounted: readonly string[] | null = null,
): Promise<ToEditRow[]> {
  const reach = reachClause(mounted, 'p.volume_name');
  return db.getAllAsync<ToEditRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.day FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id
      WHERE pa.kind = 'edit' AND pa.state IN ('queued', 'error')
        AND ${livePhotoClause('p.asset_id')}${reach.sql}
      ORDER BY p.taken_at DESC`,
    ...reach.params,
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

export async function getEditDetectionRows(
  db: SQLiteDatabase,
  /** m0.8.3 §5: detection probes stat files — an unmounted volume's
   * probes can only fail as noise, so those rows wait for remount. */
  mounted: readonly string[] | null = null,
): Promise<EditDetectionRow[]> {
  const reach = reachClause(mounted, 'p.volume_name');
  return db.getAllAsync<EditDetectionRow>(
    `SELECT p.asset_id, p.uri, p.taken_at, p.mod_time, p.content_hash,
            pa.queued_at AS to_edit_at
       FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id
      WHERE pa.kind = 'edit' AND pa.state IN ('queued', 'error')
        AND ${livePhotoClause('p.asset_id')}${reach.sql}`,
    ...reach.params,
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
         (asset_id, uri, taken_at, state, mod_time, day, volume_name, raw_id, activity_at)
       VALUES (?, ?, ?, 'unreviewed', ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         activity_at = excluded.activity_at
       WHERE photos.state = 'unreviewed' AND photos.activity_at IS NULL`,
      copy.assetId,
      copy.uri,
      copy.takenAt,
      copy.modTime,
      copy.day,
      // The canonical id IS `<volume>/<raw id>` — identity columns are
      // derivable, and v20 requires them on every insert.
      volumeOf(copy.assetId),
      rawIdOf(copy.assetId),
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
  /** Per-kind LIVE (`state IN ('queued','error')`; favourite additionally
   * directional, target = '1') and CARRIED (`resolved_at IS NOT NULL`;
   * favourite: COALESCE(target, applied_target) = '1') facts — the two
   * halves every badge weight is built from (docs/STATE_MODEL.md, layer
   * 2), so History rows render the same weighted vocabulary as the
   * grid/deck. Live and carried stay separate columns because a
   * superseding queued action must render loud over its earlier applied
   * one. */
  needs_edit: number;
  edit_applied: number;
  favourite_live: number;
  /** A queued REMOVAL (target '0') — renders the heart-off badge at the
   * live weight (grilling Q5): waiting work, read apart from apply. */
  favourite_removing: number;
  favourite_carried: number;
  organize_pending: number;
  /** Latest applied move (MAX resolved_at), null when none ever applied. */
  organize_applied_at: number | null;
  share_live: number;
  share_applied: number;
  day: string | null;
  activity_at: number;
  /** 0 = a TOMBSTONE (m0.8.6 D9): the bytes are gone — a forgotten
   * card's decided photo, or an executed cull once the scan concluded
   * the deletion. The feed keeps the row as a placeholder tile; the
   * screen's MediaStore reconcile must skip it (it is expected-gone). */
  is_present: number;
}

export interface HistoryShareRow {
  kind: 'share';
  batch_id: number;
  /** The chosen-component time — when sharing actually happened (D10). */
  chosen_at: number;
  label: string | null;
  member_count: number;
  thumb_uris: string[];
}

export type HistoryRow = HistoryPhotoRow | HistoryShareRow;

export type HistoryFilter =
  'all' | 'kept' | 'culled' | 'trashed' | 'to_edit' | 'favourite' | 'organized' | 'shared';

/** Per-stream keyset position: 'top' = not yet consumed, 'end' = exhausted. */
type StreamPos<K> = K | 'top' | 'end';

/** Combined cursor — photo decisions and share events paginate as
 * independent keyset streams merged by timestamp. */
export interface HistoryCursor {
  photo: StreamPos<{ activityAt: number; assetId: string }>;
  share: StreamPos<{ chosenAt: number; batchId: number }>;
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

/** "This photo holds (or is gaining) a favourite" — DIRECTIONAL, the SQL
 * mirror of `favouriteBadgeWeight` (lib/favouriteState.ts): favourite is
 * the only action that can point backwards, so a queued or verified
 * REMOVAL must not read as a favourite (STATE_MODEL.md). Same predicate
 * family as getForecastBaseRates. */
const FAVOURITE_HELD = `(EXISTS (SELECT 1 FROM photo_actions pa_favourite
  WHERE pa_favourite.photo_id = photos.asset_id AND pa_favourite.kind = 'favourite'
    AND pa_favourite.state IN ('queued', 'error') AND pa_favourite.target = '1')
  OR EXISTS (SELECT 1 FROM photo_actions pv_favourite
  WHERE pv_favourite.photo_id = photos.asset_id AND pv_favourite.kind = 'favourite'
    AND pv_favourite.resolved_at IS NOT NULL
    AND COALESCE(pv_favourite.target, pv_favourite.applied_target) = '1'))`;

/**
 * One keyset page of the History feed. Photo rows require presence
 * (is_present = 1 — trashed/deleted photos drop out; restore brings them
 * back) and at least one recorded decision (activity_at beyond the draw).
 * Share events form a second stream (keyset on chosen_at) merged by
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
        : filter === 'trashed'
          ? // The verdict-chip family's third member (m0.8.6 D9):
            // executed culls are completed review work, and the feed is
            // the record of completed work.
            "AND state = 'trashed'"
          : filter === 'to_edit'
            ? `AND ${EDIT_QUEUED}`
            : filter === 'favourite'
              ? `AND ${FAVOURITE_HELD}`
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
                   OR ${FAVOURITE_HELD})`;
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
          `SELECT asset_id, uri, taken_at, state, day, activity_at, is_present,
                  EXISTS (SELECT 1 FROM photo_actions pa_edit WHERE pa_edit.photo_id = photos.asset_id AND pa_edit.kind = 'edit' AND pa_edit.state IN ('queued', 'error')) AS needs_edit,
                  EXISTS (SELECT 1 FROM photo_actions pc_edit WHERE pc_edit.photo_id = photos.asset_id AND pc_edit.kind = 'edit' AND pc_edit.resolved_at IS NOT NULL) AS edit_applied,
                  EXISTS (SELECT 1 FROM photo_actions pl_fav WHERE pl_fav.photo_id = photos.asset_id AND pl_fav.kind = 'favourite' AND pl_fav.state IN ('queued', 'error') AND pl_fav.target = '1') AS favourite_live,
                  EXISTS (SELECT 1 FROM photo_actions pr_fav WHERE pr_fav.photo_id = photos.asset_id AND pr_fav.kind = 'favourite' AND pr_fav.state IN ('queued', 'error') AND pr_fav.target = '0') AS favourite_removing,
                  EXISTS (SELECT 1 FROM photo_actions pc_fav WHERE pc_fav.photo_id = photos.asset_id AND pc_fav.kind = 'favourite' AND pc_fav.resolved_at IS NOT NULL AND COALESCE(pc_fav.target, pc_fav.applied_target) = '1') AS favourite_carried,
                  EXISTS (SELECT 1 FROM photo_actions pa_organize WHERE pa_organize.photo_id = photos.asset_id AND pa_organize.kind = 'organize' AND pa_organize.state IN ('queued', 'error')) AS organize_pending,
                  (SELECT MAX(o.resolved_at) FROM photo_actions o WHERE o.photo_id = photos.asset_id
                    AND o.kind = 'organize') AS organize_applied_at,
                  EXISTS (SELECT 1 FROM photo_actions pl_share WHERE pl_share.photo_id = photos.asset_id AND pl_share.kind = 'share' AND pl_share.state IN ('queued', 'error')) AS share_live,
                  EXISTS (SELECT 1 FROM photo_actions pc_share WHERE pc_share.photo_id = photos.asset_id AND pc_share.kind = 'share' AND pc_share.resolved_at IS NOT NULL) AS share_applied
           FROM photos
           -- TOMBSTONES stay on the record (m0.8.6 D9): a DECIDED row
           -- whose bytes left (forget-keep, executed culls) renders as
           -- a placeholder tile — History's charter is completed work
           -- as fact. Absent UNDECIDED rows stay out: they carry none.
           -- decided_at is the discriminator (codex r2): the external-
           -- removal reconcile rewrites even a never-reviewed photo to
           -- 'trashed', but only a real verdict ever stamps decided_at —
           -- without this, deleting an undecided photo in the gallery
           -- minted a Trashed tombstone claiming completed work.
           WHERE (is_present = 1 OR (state <> 'unreviewed' AND decided_at IS NOT NULL))
             AND activity_at IS NOT NULL ${filterSql} ${photoKeyset}
           ORDER BY activity_at DESC, asset_id DESC
           LIMIT ${HISTORY_PAGE}`,
          ...photoParams,
        );

  const shareKeyset =
    sharePos === 'top' || sharePos === 'end'
      ? ''
      : 'AND (b.chosen_at < ? OR (b.chosen_at = ? AND b.id < ?))';
  const shareParams: number[] =
    sharePos === 'top' || sharePos === 'end'
      ? []
      : [sharePos.chosenAt, sharePos.chosenAt, sharePos.batchId];
  const shareRows =
    sharePos === 'end'
      ? []
      : await db.getAllAsync<{
          batch_id: number;
          chosen_at: number;
          label: string | null;
          member_count: number;
        }>(
          // Ordered and stamped by the CHOSEN-COMPONENT time (codex r1):
          // 'shared' is D10's target-confirmed state and chosen_at is
          // written with it, while opened_at is only when the sheet rose
          // — a chooser left open for an hour would otherwise file the
          // share an hour early.
          `SELECT b.id AS batch_id, b.chosen_at, b.label,
             (SELECT COUNT(*) FROM share_batch_members m WHERE m.batch_id = b.id) AS member_count
           FROM share_batches b
           WHERE b.state = 'shared' ${shareKeyset}
           ORDER BY b.chosen_at DESC, b.id DESC
           LIMIT ${HISTORY_PAGE}`,
          ...shareParams,
        );

  const photoRows: HistoryPhotoRow[] = photos.map((p) => ({ kind: 'photo', ...p }));
  const bareShares: HistoryShareRow[] = shareRows.map((r) => ({
    kind: 'share',
    ...r,
    thumb_uris: [],
  }));
  const tsOf = (r: HistoryRow) => (r.kind === 'photo' ? r.activity_at : r.chosen_at);
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
        ? { chosenAt: lastShare.chosen_at, batchId: lastShare.batch_id }
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<StateCounts> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const [rows, actionRows] = await Promise.all([
    db.getAllAsync<{ state: PhotoState; grouped: number; n: number; rescued: number }>(
      // LEFT JOIN, not a correlated EXISTS per row (m0.8.6 — the parked
      // m0.8.1 cost, taken now because change 6 opens this query's WHERE
      // head anyway; 22 ms whole-corpus measured on the EXISTS shape).
      // Safe against row multiplication: photo_id is the assignments PK,
      // so at most one join row exists per photo.
      `SELECT state,
              (a.photo_id IS NOT NULL) AS grouped,
              COUNT(*) AS n,
              -- Alive rescue-dated rows (same rule as DAY_SUMMARY's
              -- rescued): the day page's analyzing line needs them.
              SUM(CASE WHEN photos.exif_checked_mod_time IS NOT NULL
                        AND photos.state <> 'trashed' THEN 1 ELSE 0 END) AS rescued
       FROM photos
       LEFT JOIN photo_group_assignments a
         ON a.photo_id = photos.asset_id AND a.group_id IS NOT NULL
       WHERE ${where.sql}${src.sql}
         -- Keep-history tombstones (m0.8.3 §7) are ABSENT rows with
         -- ordinary verdicts — a browse surface must not revive them.
         -- Trashed rows stay countable (the chips' trashed figure)
         -- WHEREVER their volume is: a tombstoned fact is not waiting on
         -- a card (final cycle O3) — reachability scopes live rows only.
         AND (photos.state = 'trashed' OR (photos.is_present = 1${reach.sql}))
       GROUP BY state, grouped`,
      ...where.params,
      ...src.params,
      ...reach.params,
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
        WHERE ${where.sql}${src.sql}${reach.sql}
          AND pa.state IN ('queued', 'error')
          AND photos.state <> 'trashed'
          AND photos.is_present = 1
        GROUP BY pa.kind`,
      ...where.params,
      ...src.params,
      ...reach.params,
    ),
  ]);
  const counts: StateCounts = {
    unreviewed: 0,
    kept: 0,
    staged: 0,
    trashed: 0,
    tracked: 0,
    rescued: 0,
    grouped: { unreviewed: 0, kept: 0, staged: 0 },
    actions: { edit: 0, favourite: 0, organize: 0, share: 0 },
  };
  for (const row of actionRows) counts.actions[row.kind] = Number(row.n);
  for (const row of rows) {
    counts.tracked += row.n;
    counts.rescued += Number(row.rescued ?? 0);
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

/** What the MediaStore-engine grid learns about a tracked photo, per
 * page (missing rows simply absent = untracked). `taken_at`/`day` are
 * the DB's date truth (m0.8.6 changes 2+5): the MediaStore item's
 * timestamp is the mtime fallback for undated photos, and a tracked
 * row's dates must come from here. `rescued` marks a D15-rescued photo
 * (checked AND dated): the MediaStore stream's copy of such a photo is
 * skipped — the rescued-rows fetcher supplies it at its true position
 * (change 4). */
export interface AssetStateRow {
  state: PhotoState;
  grouped: boolean;
  taken_at: number;
  day: string | null;
  rescued: boolean;
}

export async function getStateRowsForAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, AssetStateRow>> {
  const out = new Map<string, AssetStateRow>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{
      asset_id: string;
      state: PhotoState;
      grouped: number;
      taken_at: number;
      day: string | null;
      rescued: number;
    }>(
      `SELECT asset_id, state, taken_at, day,
              (exif_checked_mod_time IS NOT NULL AND day IS NOT NULL) AS rescued,
              EXISTS (SELECT 1 FROM photo_group_assignments a
                      WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped
       FROM photos WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows)
      out.set(row.asset_id, {
        state: row.state,
        grouped: !!row.grouped,
        taken_at: row.taken_at,
        day: row.day,
        rescued: !!row.rescued,
      });
  }
  return out;
}

/** One rescued row for the library grid's DB-sourced merge stream
 * (m0.8.6 change 4): a D15-rescued photo sits in MediaStore's undated
 * tail wearing its mtime, so its newest-first slot must come from a
 * stream that knows its real `taken_at`. */
export interface RescuedPhotoRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  day: string;
}

/**
 * One newest-first keyset page of alive rescued photos (checked AND
 * dated), for `progressPager` to merge beside the MediaStore bucket
 * streams. Keyset on (taken_at, asset_id) — the same tiebreak order
 * every newest-first read here uses. `before` = the previous page's last
 * row; undefined starts from the top.
 */
export async function getRescuedPhotoPage(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null,
  mounted: readonly string[] | null,
  before: { takenAt: number; assetId: string } | undefined,
  limit: number,
): Promise<RescuedPhotoRow[]> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const keyset =
    before === undefined ? '' : ' AND (taken_at < ? OR (taken_at = ? AND asset_id < ?))';
  const keysetParams = before === undefined ? [] : [before.takenAt, before.takenAt, before.assetId];
  return db.getAllAsync<RescuedPhotoRow>(
    `SELECT asset_id, uri, taken_at, day
       FROM photos
      WHERE exif_checked_mod_time IS NOT NULL AND day IS NOT NULL
        AND state <> 'trashed' AND is_present = 1${src.sql}${reach.sql}${keyset}
      ORDER BY taken_at DESC, asset_id DESC LIMIT ?`,
    ...src.params,
    ...reach.params,
    ...keysetParams,
    limit,
  );
}

/** One photo row for the progress grids' DB-backed filters. */
export interface GridPhotoRow {
  /** An edit action is queued (layer 2). */
  needs_edit: number;
  /** A favourite is waiting TOWARD TRUE (directional — a queued removal
   * wears no heart, favouriteState.ts). */
  fav_pending: number;
  /** An organize action is queued. */
  organize_pending: number;
  /** A share action is queued. */
  share_pending: number;
  asset_id: string;
  uri: string;
  taken_at: number;
  /** Capture day; NULL = honestly undated (taken_at is the mtime
   * fallback then — surfaces must say "Unknown day", m0.8.6 change 5). */
  day: string | null;
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
  roots: readonly SourceRoot[] | null,
  filter: string,
  limit: number,
  offset: number,
  mounted: readonly string[] | null = null,
): Promise<GridPhotoRow[]> {
  const where = scopeClause(scope);
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  // Explicit over implicit: an unknown key must not silently broaden to
  // the whole library (the chip's number would still claim a filter).
  const filterSql = GRID_FILTER_SQL[filter];
  if (filterSql === undefined) throw new Error(`unknown grid filter: ${filter}`);
  return db.getAllAsync<GridPhotoRow>(
    `SELECT asset_id, uri, taken_at, day, state,
            EXISTS (SELECT 1 FROM photo_group_assignments a
                    WHERE a.photo_id = photos.asset_id AND a.group_id IS NOT NULL) AS grouped,
            EXISTS (SELECT 1 FROM photo_actions pa WHERE pa.photo_id = photos.asset_id
                     AND pa.kind = 'edit' AND pa.state IN ('queued', 'error')) AS needs_edit,
            EXISTS (SELECT 1 FROM photo_actions pf WHERE pf.photo_id = photos.asset_id
                     AND pf.kind = 'favourite' AND pf.state IN ('queued', 'error')
                     AND pf.target = '1') AS fav_pending,
            EXISTS (SELECT 1 FROM photo_actions po WHERE po.photo_id = photos.asset_id
                     AND po.kind = 'organize' AND po.state IN ('queued', 'error')) AS organize_pending,
            EXISTS (SELECT 1 FROM photo_actions ps WHERE ps.photo_id = photos.asset_id
                     AND ps.kind = 'share' AND ps.state IN ('queued', 'error')) AS share_pending
     FROM photos WHERE ${where.sql} AND (${filterSql})${src.sql}${reach.sql}
       -- Grid filters never select trashed rows, so presence is the
       -- whole predicate here (keep-history tombstones stay out).
       AND is_present = 1
     ORDER BY taken_at DESC, asset_id DESC LIMIT ? OFFSET ?`,
    ...where.params,
    ...src.params,
    ...reach.params,
    limit,
    offset,
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
  /** D5 (m0.8.6): the STATE EDITOR's culled → unreviewed also clears its
   * group's Compare history, in this transaction, so the metadata freeze
   * releases with the verdict. CullList's Restore never passes this. */
  deleteDuelsForGroup?: number,
): Promise<boolean> {
  // True when the restore actually landed — callers gate their
  // optimistic patches on it (a guarded no-op must stay a no-op in the
  // cached snapshot too, codex device-pass round). No fresh-work count:
  // unreviewed carries no decided_at, so the ring cannot move.
  let applied = false;
  await withWriteTransaction(db, async (txn) => {
    const moved = await txn.runAsync(
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
    // A stale restore (the photo left 'culled' concurrently) is a
    // complete no-op: resolving copy matches for a decision that did
    // not happen would silently consume the edited-copy prompt (the
    // same rule applyRedecision pins).
    if (Number(moved.changes) === 0) return;
    applied = true;
    if (resolvePendingMatches) {
      await txn.runAsync(
        "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
        assetId,
      );
    }
    if (deleteDuelsForGroup !== undefined) {
      // Group-wide, like the extras path: any surviving duel would keep
      // the metadata freeze standing (D5).
      await txn.runAsync(`DELETE FROM duels WHERE group_id = ?`, String(deleteDuelsForGroup));
    }
  });
  return applied;
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
): Promise<ReviewDecisionResult> {
  // The write moves decided_at into today, so it MUST report fresh work
  // like every other verdict write (A3): the ring counts the row the
  // moment it lands, and an uncredited path is a crossing that never
  // fires (§10 check 13's defect class). The trash-rollback caller
  // ignores the result deliberately — its staging happened moments
  // earlier the same day, so the day rule yields 0 by construction.
  const result: ReviewDecisionResult = { appliedIds: [], freshDecisions: 0 };
  await withWriteTransaction(db, async (txn) => {
    const prior = await txn.getFirstAsync<{ decided_at: number | null }>(
      'SELECT decided_at FROM photos WHERE asset_id = ?',
      assetId,
    );
    const moved = await txn.runAsync(
      `UPDATE photos
       SET state = 'kept',
           -- reviewed_at first-stamps like every verdict write: a cull
           -- staged from the edited-copy prompt can land on a photo that
           -- was never reviewed, and kept is a verdict.
           reviewed_at = COALESCE(reviewed_at, ?),
           decided_at = ?,
           activity_at = ?
       WHERE asset_id = ? AND state = 'culled'`,
      at,
      at,
      at,
      assetId,
    );
    // A stale un-stage is a complete no-op across every layer — a
    // resolved copy match for a transition that did not happen is the
    // same bug applyRedecision's guard prevents.
    if (Number(moved.changes) === 0) return;
    result.appliedIds.push(assetId);
    const stamp = prior?.decided_at ?? null;
    if (stamp === null || dayKey(stamp) !== dayKey(at)) result.freshDecisions = 1;
    if (resolveCopyMatches) {
      await txn.runAsync(
        "UPDATE edit_copy_matches SET state = 'resolved' WHERE original_id = ? AND state = 'pending'",
        assetId,
      );
    }
  });
  return result;
}

export interface DaySummaryRow {
  day: string;
  tracked: number;
  done: number; // done + trashed (both are converged)
  trashed: number; // subset of `done`; gone from MediaStore
  toEdit: number;
  staged: number;
  /** ALIVE rows whose date exists only in the DB (the D15 EXIF rescue's
   * marker — MediaStore has no DATE_TAKEN for them), so no MediaStore
   * range count includes them. Home's day total is the disjoint union
   * `MediaStore range + rescued` (final cycle P4: max() alone missed a
   * day holding both a rescued photo and a not-yet-ingested one). */
  rescued: number;
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
            SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END) AS staged,
            -- The rescue marker only ever lands on MediaStore-UNDATED
            -- photos, so a dated+marked ALIVE row is exactly a photo no
            -- MediaStore range count can see (DaySummaryRow.rescued).
            SUM(CASE WHEN exif_checked_mod_time IS NOT NULL AND state <> 'trashed'
                     THEN 1 ELSE 0 END) AS rescued
     -- Keep-history tombstones (m0.8.3 §7) are absent rows with ordinary
     -- verdicts — day populations must not count them as live photos;
     -- trashed rows stay counted (toRow's total adds them deliberately).
     -- The presence predicate lives at the call sites so reachability
     -- can scope the LIVE branch only (final cycle O3): a trashed
     -- tombstone is a fact, not a photo waiting on an unmounted card —
     -- the cycling-card workflow's whole day history lives on ejected
     -- volumes (plan §7 "per-day charts stay exactly right").
     FROM photos WHERE day IS NOT NULL`;

/** ` AND (state = 'trashed' OR (is_present = 1 <reach>))` — the shared
 * presence-or-fact predicate of the day summaries (O3, see
 * DAY_SUMMARY_SELECT). Params: the reach clause's, in place. */
function presentOrTrashedClause(reach: { sql: string; params: string[] }): {
  sql: string;
  params: string[];
} {
  return {
    sql: ` AND (state = 'trashed' OR (is_present = 1${reach.sql}))`,
    params: reach.params,
  };
}

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
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<Map<string, DaySummaryRow>> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const present = presentOrTrashedClause(reach);
  const rows = await db.getAllAsync<DaySummaryRow>(
    `${DAY_SUMMARY_SELECT} AND day >= ?${src.sql}${present.sql} GROUP BY day`,
    sinceDay,
    ...src.params,
    ...present.params,
  );
  return new Map(rows.map((r) => [r.day, r]));
}

/** Per-day rollups for an explicit day list (gate 5's unreviewed-day
 * rows sit outside any contiguous recent window). */
export async function getDaySummariesForDays(
  db: SQLiteDatabase,
  days: readonly string[],
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<Map<string, DaySummaryRow>> {
  if (days.length === 0) return new Map();
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const dated = days.filter((d) => d !== UNDATED_DAY_KEY);
  const out = new Map<string, DaySummaryRow>();
  const present = presentOrTrashedClause(reach);
  if (dated.length > 0) {
    const rows = await db.getAllAsync<DaySummaryRow>(
      `${DAY_SUMMARY_SELECT} AND day IN (${dated.map(() => '?').join(',')})${src.sql}${present.sql} GROUP BY day`,
      ...dated,
      ...src.params,
      ...present.params,
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
              SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END) AS staged,
              -- A marker on an UNDATED row means "checked, nothing found"
              -- — not a rescue; and the undated pseudo-day has no
              -- MediaStore range to union with anyway.
              0 AS rescued
       FROM photos WHERE day IS NULL${src.sql}${present.sql}`,
      ...src.params,
      ...present.params,
    );
    if (row && Number(row.tracked) > 0) out.set(UNDATED_DAY_KEY, { day: UNDATED_DAY_KEY, ...row });
  }
  return out;
}

/** Local days that still hold unreviewed present photos, newest first,
 * with their pending counts (Home's still-unreviewed day rows, gate 5). */
export async function getUnreviewedDayRows(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<{ day: string; pending: number }[]> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const rows = await db.getAllAsync<{ day: string; pending: number }>(
    `SELECT day, COUNT(*) AS pending FROM photos
     WHERE day IS NOT NULL AND state = 'unreviewed' AND is_present = 1${src.sql}${reach.sql}
     GROUP BY day ORDER BY day DESC`,
    ...src.params,
    ...reach.params,
  );
  // The Unknown-day pseudo-day rides along (after the dated days) when
  // undated photos await review.
  const undated = await db.getFirstAsync<{ pending: number }>(
    `SELECT COUNT(*) AS pending FROM photos
     WHERE day IS NULL AND state = 'unreviewed' AND is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
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
/** Stored effective timestamps for these ids (absent ids omitted) — the
 * delta planner compares them against each changed row's current
 * DATE_TAKEN: a moved timestamp means the OLD window's survivors need
 * rewindowing too, which only a full pass can deliver. */
export async function getTakenAtForAssets(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const batch of chunk(assetIds, IN_CHUNK)) {
    const rows = await db.getAllAsync<{ asset_id: string; taken_at: number }>(
      `SELECT asset_id, taken_at FROM photos
        WHERE is_present = 1 AND asset_id IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
    for (const row of rows) result.set(row.asset_id, Number(row.taken_at));
  }
  return result;
}

/** One stored row per id for the D15 EXIF date rescue's once-per-photo
 * contract (m0.8.3): a photo whose header was already read at its
 * current content version reuses its stored taken_at/day instead of a
 * re-read — and MUST, because the scan's upsert rewrites taken_at/day
 * from the ingested values, so a rescue that ran only once would be
 * clobbered back to the mtime fallback on the next pass. The version is
 * `exif_checked_mod_time`, the rescue's own marker (codex r1) — NOT
 * photos.mod_time, which edit detection owns and resets/preserves for
 * its own reasons, and NULL for a photo whose read never completed, so
 * transient failures stay retry-eligible instead of freezing undated. */
export interface RescueBaselineRow {
  takenAt: number;
  day: string | null;
  exifCheckedModTime: number | null;
}

export async function getRescueBaselines(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, RescueBaselineRow>> {
  const result = new Map<string, RescueBaselineRow>();
  for (const batch of chunk(assetIds, IN_CHUNK)) {
    const rows = await db.getAllAsync<{
      asset_id: string;
      taken_at: number;
      day: string | null;
      exif_checked_mod_time: number | null;
    }>(
      `SELECT asset_id, taken_at, day, exif_checked_mod_time FROM photos
        WHERE asset_id IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
    for (const row of rows) {
      result.set(row.asset_id, {
        takenAt: Number(row.taken_at),
        day: row.day,
        exifCheckedModTime:
          row.exif_checked_mod_time === null ? null : Number(row.exif_checked_mod_time),
      });
    }
  }
  return result;
}

/** How many of these ids are still tracked as present — the delta
 * tripwire's correction term for gallery-trashed rows that MediaStore
 * already hides but the DB still holds (scanRunner.planPass). */
export async function countPresentPhotos(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<number> {
  let present = 0;
  for (const batch of chunk(assetIds, IN_CHUNK)) {
    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM photos
        WHERE is_present = 1 AND asset_id IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
    present += Number(row?.n ?? 0);
  }
  return present;
}

export async function getPhotoTimestamps(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
): Promise<number> {
  const src = sourceClause(roots);
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos WHERE is_present = 1${src.sql}`,
    ...src.params,
  );
  return Number(row?.n ?? 0);
}

/** Tracked present rows PER VOLUME under the source scope (m0.8.3
 * phase 2) — one side of the per-volume tripwires (plan §4 invariant 1).
 * Volumes with no rows simply have no entry; callers default to 0. */
export async function countTrackedByVolume(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null = null,
): Promise<Record<string, number>> {
  const src = sourceClause(roots);
  const rows = await db.getAllAsync<{ volume_name: string; n: number }>(
    `SELECT volume_name, COUNT(*) AS n FROM photos
      WHERE is_present = 1${src.sql} GROUP BY volume_name`,
    ...src.params,
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.volume_name] = Number(row.n);
  return out;
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
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
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
                  WHERE m.photo_id = decided.asset_id AND b.state = 'shared'
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
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
  /** The forecast's REMAINING pool excludes unreachable photos (m0.8.3
   * §5) — the finish line describes work you can actually do; the base
   * RATES deliberately stay history-wide (completed work is fact). */
  mounted: readonly string[] | null = null,
): Promise<{ sized: number; meanBytes: number }> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const row = await db.getFirstAsync<{ sized: number; meanBytes: number | null }>(
    `SELECT COUNT(size_bytes) AS sized, AVG(size_bytes) AS meanBytes
     FROM photos
     WHERE state = 'unreviewed' AND is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
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
export async function getQueueTurnaround(
  db: SQLiteDatabase,
  /** m0.8.3 §5: the WAITING half matches the tab badge, which excludes
   * unreachable photos; the finished counts and turnaround gaps stay
   * unscoped — they are history. */
  mounted: readonly string[] | null = null,
): Promise<QueueTurnaround[]> {
  const reach = reachClause(mounted, 'live_p.volume_name');
  const [waiting, finished, gaps] = await Promise.all([
    db.getAllAsync<{ kind: ActionKind; n: number; oldest: number | null }>(
      `SELECT kind, COUNT(*) AS n, MIN(queued_at) AS oldest FROM photo_actions
        WHERE state IN ('queued', 'error')
          AND EXISTS (SELECT 1 FROM photos live_p
                       WHERE live_p.asset_id = photo_actions.photo_id
                         AND live_p.is_present = 1
                         AND live_p.state NOT IN ('culled', 'trashed')${reach.sql})
        GROUP BY kind`,
      ...reach.params,
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
  /** Every duel, triage included — the "N head-to-head compares" count. */
  duels: number;
  /** Duels that carried a DIALOG outcome (kept_both non-null, v19) — the
   * kept-both percentage's denominator. Triage writes no verdict and
   * counting it as a keep-both decision inflated the figure. */
  verdictDuels: number;
  keptBoth: number;
}

export async function getDuelSummary(db: SQLiteDatabase): Promise<DuelSummary> {
  const row = await db.getFirstAsync<{ duels: number; verdictDuels: number; keptBoth: number }>(
    `SELECT COUNT(*) AS duels, COUNT(kept_both) AS verdictDuels,
            SUM(kept_both) AS keptBoth
       FROM duels`,
  );
  return {
    duels: Number(row?.duels ?? 0),
    verdictDuels: Number(row?.verdictDuels ?? 0),
    keptBoth: Number(row?.keptBoth ?? 0),
  };
}

/** Decisions and culls since a timestamp — the decisiveness trend's
 * numerator and denominator, against the all-time rate the base rates
 * already carry. */
export async function getDecisionOutcomesSince(
  db: SQLiteDatabase,
  sinceMs: number,
  roots: readonly SourceRoot[] | null = null,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<MonthBucket[]> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
  const rows = await db.getAllAsync<{ month: string | null; total: number; reviewed: number }>(
    `SELECT substr(day, 1, 7) AS month,
            COUNT(*) AS total,
            SUM(CASE WHEN state IN ('kept', 'culled', 'trashed')
                     THEN 1 ELSE 0 END) AS reviewed
     FROM photos
     WHERE is_present = 1${src.sql}${reach.sql}
     GROUP BY month
     ORDER BY month`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<BacklogFrontier> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
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
     FROM photos WHERE is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<StorageBreakdown> {
  const src = sourceClause(roots);
  const reach = reachClause(mounted);
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
     FROM photos WHERE is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
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
  roots: readonly SourceRoot[] | null = null,
  mounted: readonly string[] | null = null,
): Promise<BurstStats> {
  const src = sourceClause(roots, 'p.uri');
  const reach = reachClause(mounted, 'p.volume_name');
  // The fully-decided test runs over the SAME scoped population as the
  // outer counts (codex phase-3 + final cycle M8): a hidden unreviewed
  // member — ejected, tombstoned, or out of the selected source — must
  // not block a group whose measured members are all decided.
  const subReach = reachClause(mounted, 'p2.volume_name');
  const subSrc = sourceClause(roots, 'p2.uri');
  const row = await db.getFirstAsync<{ photosInGroups: number; groups: number }>(
    `SELECT COUNT(*) AS photosInGroups, COUNT(DISTINCT a.group_id) AS groups
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}${reach.sql}`,
    ...src.params,
    ...reach.params,
  );
  const decided = await db.getFirstAsync<{ members: number; kept: number }>(
    `SELECT COUNT(*) AS members,
            SUM(CASE WHEN p.state = 'kept' THEN 1 ELSE 0 END) AS kept
     FROM photo_group_assignments a
     JOIN photos p ON p.asset_id = a.photo_id
     WHERE a.group_id IS NOT NULL AND p.is_present = 1${src.sql}${reach.sql}
       AND a.group_id NOT IN (
         SELECT a2.group_id FROM photo_group_assignments a2
         JOIN photos p2 ON p2.asset_id = a2.photo_id
         WHERE a2.group_id IS NOT NULL AND p2.state = 'unreviewed'
           AND p2.is_present = 1${subSrc.sql}${subReach.sql}
       )`,
    ...src.params,
    ...reach.params,
    ...subSrc.params,
    ...subReach.params,
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
         -- Directional AND verified (STATE_MODEL.md): a verified
         -- un-favourite resolves too, but it is not a favourite. The
         -- VERIFIED direction (applied_target) outranks the current
         -- intent (target) here, unlike the heart/forecast predicates:
         -- "applied" is a statement about what the gallery holds, and a
         -- merely QUEUED reversal has not changed that yet (codex r4).
         WHERE kind = 'favourite' AND resolved_at IS NOT NULL
           AND COALESCE(applied_target, target) = '1') AS favouritesApplied
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
