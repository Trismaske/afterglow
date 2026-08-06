/**
 * Pending actions (v18) — layer 2 of docs/STATE_MODEL.md.
 *
 * ONE store for edit, favourite, organize and share. Before this, the
 * same four ideas had four implementations: a boolean flag with two
 * timestamps, a five-value enum with a target, a four-value enum with a
 * requested AND an applied target, and a whole relational queue. Each
 * had its own count query, its own "is it queued" predicate, and its own
 * way of being subtly wrong.
 *
 * The rules that make it one thing:
 *
 * - **Queued means `state = 'queued'`.** Never "queued_at is set and
 *   resolved_at is null" — that conflates "waiting" with "never done",
 *   and breaks the moment an action is re-queued after being applied.
 * - **`resolved_at` is permanent.** It survives the queue being cleared,
 *   which is exactly what lets the forecast compute base rates and the
 *   Habits card compute turnaround. Clearing a queue is not forgetting.
 * - **Actions never touch the verdict.** A photo's `photos.state` is
 *   layer 1 and is written only by the review flow. Queuing an edit no
 *   longer rewrites the verdict to 'to_edit' the way it used to.
 *
 * Share is modelled here like the other three; its BATCH log
 * (share_cycles / share_batches / share_batch_members) lives in
 * shareStore.ts, because a batch is a fact about a group of photos sent
 * together, not about one photo.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withWriteTransaction } from './database';
import { chunk, IN_CHUNK, type FavouriteState } from './store';

/** The four pending actions. Order matches the tab bar. */
export const ACTION_KINDS = ['edit', 'favourite', 'organize', 'share'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionState = 'queued' | 'applied' | 'error';

/**
 * SQL: is this photo still LIVE WORK?
 *
 * Queue membership is `state IN ('queued', 'error')` AND this. A photo staged for
 * deletion or already trashed is not waiting for you, however many
 * actions are attached to it — showing it in the Edit tab next to its own
 * row in the cull list is two answers to one question. Before v18 the
 * edit queue got this for free, because 'to_edit' was a verdict and
 * staging a cull overwrote it; the other three queues each solved it
 * their own way, or not at all.
 *
 * This is deliberately NOT applied to per-photo BADGE reads: "what does
 * this photo carry" is a different question from "what is waiting for
 * you", and a staged cull must still show the edit flag it kept — that is
 * exactly what a cancelled trash attempt restores it to.
 */
export function livePhotoClause(photoIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM photos live_p
                   WHERE live_p.asset_id = ${photoIdExpr}
                     AND live_p.is_present = 1
                     AND live_p.state NOT IN ('culled', 'trashed'))`;
}

/** SQL: this photo has `kind` waiting in its queue AND is live work.
 * Parenthesised, so it composes safely inside an OR. */
export function queuedClause(kind: ActionKind, photoIdExpr: string): string {
  return `(EXISTS (SELECT 1 FROM photo_actions qa
                    WHERE qa.photo_id = ${photoIdExpr} AND qa.kind = '${kind}'
                      AND qa.state IN ('queued', 'error'))
           AND ${livePhotoClause(photoIdExpr)})`;
}

export interface PhotoAction {
  photoId: string;
  kind: ActionKind;
  state: ActionState;
  /** Per-kind payload: organize = "volume\npath", favourite = '1'/'0'. */
  target: string | null;
  /** What the last applied run actually achieved (organize's real
   * destination, which can differ from the requested one). */
  appliedTarget: string | null;
  queuedAt: number;
  /** Permanent proof the action happened; null until it has. */
  resolvedAt: number | null;
}

interface ActionRow {
  photo_id: string;
  kind: ActionKind;
  state: ActionState;
  target: string | null;
  applied_target: string | null;
  queued_at: number;
  resolved_at: number | null;
}

function toAction(row: ActionRow): PhotoAction {
  return {
    photoId: row.photo_id,
    kind: row.kind,
    state: row.state,
    target: row.target,
    appliedTarget: row.applied_target,
    queuedAt: Number(row.queued_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

/**
 * Queue an action, or re-target one already queued.
 *
 * Re-queuing something already applied deliberately KEEPS `resolved_at`:
 * that a photo was once favourited stays true even while a new favourite
 * change is pending, and the stats read it as "has ever been actioned".
 */
export async function queueAction(
  db: SQLiteDatabase,
  photoId: string,
  kind: ActionKind,
  at: number,
  target: string | null = null,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    await txn.runAsync(
      `INSERT INTO photo_actions (photo_id, kind, state, target, queued_at)
       VALUES (?, ?, 'queued', ?, ?)
       ON CONFLICT(photo_id, kind) DO UPDATE SET
         state = 'queued', target = excluded.target, queued_at = excluded.queued_at`,
      photoId,
      kind,
      target,
      at,
    );
  });
}

/**
 * Take one action out of the queue without performing it, INSIDE the
 * caller's transaction. Returns how many rows left the queue.
 *
 * ALWAYS TWO STATEMENTS, which is the whole reason this is a function.
 * A queued row that never completed is DELETED; one that completed
 * earlier is demoted to its applied record, keeping the proof. Writing
 * only the delete — the shape every caller reached for first — leaves a
 * re-queued-after-applying row sitting at `state = 'queued'` forever:
 * still counted, still listed, and impossible to remove from the UI.
 */
export async function leaveQueue(
  txn: SQLiteDatabase,
  photoId: string,
  kind: ActionKind,
): Promise<number> {
  const dropped = await txn.runAsync(
    `DELETE FROM photo_actions
      WHERE photo_id = ? AND kind = ? AND resolved_at IS NULL`,
    photoId,
    kind,
  );
  const demoted = await txn.runAsync(
    `UPDATE photo_actions SET state = 'applied', target = NULL
      WHERE photo_id = ? AND kind = ? AND state IN ('queued', 'error')
        AND resolved_at IS NOT NULL`,
    photoId,
    kind,
  );
  return Number(dropped.changes) + Number(demoted.changes);
}

/**
 * Take an action out of the queue without performing it — the
 * transaction-owning wrapper around `leaveQueue`.
 */
export async function unqueueAction(
  db: SQLiteDatabase,
  photoId: string,
  kind: ActionKind,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    await leaveQueue(txn, photoId, kind);
  });
}

/**
 * Mark queued actions done, in one transaction (batched applies).
 *
 * `onlyIfTarget` guards against the mid-flight RETARGET: a batch apply
 * runs behind an OS consent dialog, and the user can change what they
 * want in the meantime. Resolving unconditionally would stamp the NEW
 * intent as applied while the OLD one is what actually ran — recording a
 * gallery state that does not exist. (`commitOrganizeOutcomes` has
 * guarded its own version of this since m0.7; this is the same rule for
 * every other kind.) Omit it only where the action carries no target and
 * so cannot be retargeted.
 */
export async function resolveActions(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  kind: ActionKind,
  at: number,
  appliedTarget: string | null = null,
  onlyIfTarget?: string | null,
): Promise<void> {
  if (photoIds.length === 0) return;
  // `IS` rather than `=`, so a null target matches a null target.
  const guard = onlyIfTarget === undefined ? '' : ' AND target IS ?';
  await withWriteTransaction(db, async (txn) => {
    for (const ids of chunk([...photoIds], IN_CHUNK)) {
      await txn.runAsync(
        `UPDATE photo_actions
            SET state = 'applied', resolved_at = ?,
                applied_target = COALESCE(?, target)
          WHERE kind = ? AND photo_id IN (${ids.map(() => '?').join(',')})${guard}`,
        at,
        appliedTarget,
        kind,
        ...ids,
        ...(onlyIfTarget === undefined ? [] : [onlyIfTarget]),
      );
    }
  });
}

/** Flag actions that failed, so the queue can show them instead of
 * silently dropping the work (no silent data loss). */
export async function failActions(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  kind: ActionKind,
  /** Same guard as `resolveActions`, for the same race: a failure
   * reported for the direction that RAN must not brand a newer
   * retargeted intent — nor drag a demoted historical `applied` row back
   * into the queue as an error. */
  onlyIfTarget?: string | null,
): Promise<void> {
  if (photoIds.length === 0) return;
  const guard = onlyIfTarget === undefined ? '' : ' AND target IS ?';
  await withWriteTransaction(db, async (txn) => {
    for (const ids of chunk([...photoIds], IN_CHUNK)) {
      await txn.runAsync(
        `UPDATE photo_actions SET state = 'error'
          WHERE kind = ? AND state = 'queued'
            AND photo_id IN (${ids.map(() => '?').join(',')})${guard}`,
        kind,
        ...ids,
        ...(onlyIfTarget === undefined ? [] : [onlyIfTarget]),
      );
    }
  });
}

/** Empty a whole queue. Applied rows keep their permanent record; rows
 * that never completed are dropped (see unqueueAction). */
export async function clearQueue(db: SQLiteDatabase, kind: ActionKind): Promise<number> {
  let cleared = 0;
  await withWriteTransaction(db, async (txn) => {
    const row = await txn.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM photo_actions WHERE kind = ? AND state IN ('queued', 'error')",
      kind,
    );
    cleared = Number(row?.n ?? 0);
    // Same two statements as leaveQueue, over the whole kind at once.
    await txn.runAsync(
      `DELETE FROM photo_actions
        WHERE kind = ? AND state IN ('queued', 'error') AND resolved_at IS NULL`,
      kind,
    );
    await txn.runAsync(
      `UPDATE photo_actions SET state = 'applied', target = NULL
        WHERE kind = ? AND state IN ('queued', 'error') AND resolved_at IS NOT NULL`,
      kind,
    );
  });
  return cleared;
}

/** Reachability half of the queue question (m0.8.3 §5): a queued action
 * on an unmounted volume's photo is not work waiting for you — its file
 * is away — so queue lists and badges exclude it (the ACTION ROW itself
 * is untouched and returns with the card). Null = unknowable, no filter. */
export function reachExists(
  mounted: readonly string[] | null | undefined,
  photoIdExpr: string,
): { sql: string; params: string[] } {
  if (mounted === null || mounted === undefined) return { sql: '', params: [] };
  if (mounted.length === 0) return { sql: ' AND 0', params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM photos reach_p
             WHERE reach_p.asset_id = ${photoIdExpr}
               AND reach_p.volume_name IN (${mounted.map(() => '?').join(',')}))`,
    params: [...mounted],
  };
}

/** Photos waiting in one queue, oldest first (the order they were asked
 * for is the order they should be worked). */
export async function getQueue(
  db: SQLiteDatabase,
  kind: ActionKind,
  mounted: readonly string[] | null = null,
): Promise<PhotoAction[]> {
  const reach = reachExists(mounted, 'photo_actions.photo_id');
  const rows = await db.getAllAsync<ActionRow>(
    `SELECT photo_id, kind, state, target, applied_target, queued_at, resolved_at
       FROM photo_actions
      WHERE kind = ? AND state IN ('queued', 'error')
        AND ${livePhotoClause('photo_actions.photo_id')}${reach.sql}
      ORDER BY queued_at ASC`,
    kind,
    ...reach.params,
  );
  return rows.map(toAction);
}

/** Queue depth per kind — the tab-bar badges, in ONE query rather than
 * the four bespoke count functions this replaces. */
export async function countQueues(
  db: SQLiteDatabase,
  mounted: readonly string[] | null = null,
): Promise<Record<ActionKind, number>> {
  const reach = reachExists(mounted, 'photo_actions.photo_id');
  const rows = await db.getAllAsync<{ kind: ActionKind; n: number }>(
    `SELECT kind, COUNT(*) AS n FROM photo_actions
      WHERE state IN ('queued', 'error')
        AND ${livePhotoClause('photo_actions.photo_id')}${reach.sql}
      GROUP BY kind`,
    ...reach.params,
  );
  const counts: Record<ActionKind, number> = { edit: 0, favourite: 0, organize: 0, share: 0 };
  for (const row of rows) counts[row.kind] = Number(row.n);
  return counts;
}

/** Every action currently attached to the given photos, for badges. */
export async function getActionsForPhotos(
  db: SQLiteDatabase,
  photoIds: readonly string[],
): Promise<Map<string, PhotoAction[]>> {
  const byPhoto = new Map<string, PhotoAction[]>();
  for (const ids of chunk([...photoIds], IN_CHUNK)) {
    if (ids.length === 0) continue;
    const rows = await db.getAllAsync<ActionRow>(
      `SELECT photo_id, kind, state, target, applied_target, queued_at, resolved_at
         FROM photo_actions
        WHERE photo_id IN (${ids.map(() => '?').join(',')})`,
      ...ids,
    );
    for (const row of rows) {
      const list = byPhoto.get(row.photo_id) ?? [];
      list.push(toAction(row));
      byPhoto.set(row.photo_id, list);
    }
  }
  return byPhoto;
}

/** One photo's actions (the viewer's detail panel). */
export async function getPhotoActions(db: SQLiteDatabase, photoId: string): Promise<PhotoAction[]> {
  return (await getActionsForPhotos(db, [photoId])).get(photoId) ?? [];
}

/** Organize's payload packs a volume and a relative path; favourite's is
 * a direction. Encoding lives here so no caller invents its own. */
export function encodeOrganizeTarget(volume: string, path: string): string {
  return `${volume}\n${path}`;
}

export function decodeOrganizeTarget(
  target: string | null,
): { volume: string; path: string } | null {
  if (target === null) return null;
  const newline = target.indexOf('\n');
  if (newline < 0) return null;
  return { volume: target.slice(0, newline), path: target.slice(newline + 1) };
}

/**
 * What a photo's badge should say about one action (m0.8.2).
 *
 * - `live` — the action is WAITING: `state IN ('queued','error')`. This is
 *   the same predicate the tab badges, the queue screens and the deck's
 *   action buttons use, so the loud badge and the counted work are always
 *   the same set.
 * - `carried` — the action HAPPENED and is not waiting again:
 *   `resolved_at IS NOT NULL`. A permanent property of the photo, not a
 *   chore — "this one was edited", "this one went to an album".
 *
 * Waiting beats carried, which is why a share row keeps reading `live`
 * after a successful pass: a share stays queued across passes by design.
 * An action queued and then abandoned leaves NO row at all (leaveQueue
 * deletes the never-resolved one), so cancelling really does erase it.
 */
export type ActionWeight = 'live' | 'carried';

/** The three DIRECTIONLESS actions. Favourite is excluded deliberately:
 * it is the only action that can point backwards (a verified REMOVAL is
 * an applied row), so its badge is derived from its full status in
 * lib/favouriteState.ts rather than read a second, direction-blind way
 * here. Two sources for one fact is the defect this avoids. */
export const BADGE_ACTION_KINDS = ['edit', 'organize', 'share'] as const;
export type BadgeActionKind = (typeof BADGE_ACTION_KINDS)[number];

export type ActionBadgeMap = Map<string, Partial<Record<BadgeActionKind, ActionWeight>>>;

/**
 * Per-photo action weights for the BADGE reads (deck, Groups strips).
 *
 * Deliberately does NOT apply `livePhotoClause`: "what does this photo
 * carry" is a different question from "what is waiting for you", and a
 * staged cull must still show the edit it kept — that is exactly what a
 * cancelled trash attempt restores it to.
 */
export async function getActionBadges(
  db: SQLiteDatabase,
  photoIds: readonly string[],
): Promise<ActionBadgeMap> {
  const out: ActionBadgeMap = new Map();
  for (const ids of chunk(photoIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{
      photo_id: string;
      kind: BadgeActionKind;
      state: ActionState;
      resolved_at: number | null;
    }>(
      `SELECT photo_id, kind, state, resolved_at
         FROM photo_actions
        WHERE kind IN ('edit', 'organize', 'share') AND photo_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) {
      const weight: ActionWeight | null =
        row.state === 'queued' || row.state === 'error'
          ? 'live'
          : row.resolved_at === null
            ? null
            : 'carried';
      if (weight === null) continue;
      const entry = out.get(row.photo_id) ?? {};
      entry[row.kind] = weight;
      out.set(row.photo_id, entry);
    }
  }
  return out;
}

export function encodeFavouriteTarget(favourite: boolean): string {
  return favourite ? '1' : '0';
}

export function decodeFavouriteTarget(target: string | null): boolean | null {
  if (target === null) return null;
  return target === '1';
}

/**
 * Favourite status per photo, in the shape `lib/favouriteState.ts`
 * reasons about.
 *
 * The old five-value column encoded direction and progress together
 * ('queued_apply' vs 'queued_remove' vs 'applied'); here direction is
 * the action's `target` and progress is its `state`, so this reassembles
 * the pair rather than storing it twice.
 */
export async function getFavouriteActionStates(
  db: SQLiteDatabase,
  photoIds: readonly string[],
): Promise<Map<string, { state: FavouriteState; target: boolean | null }>> {
  const byPhoto = await getActionsForPhotos(db, photoIds);
  const out = new Map<string, { state: FavouriteState; target: boolean | null }>();
  for (const [photoId, actions] of byPhoto) {
    const favourite = actions.find((action) => action.kind === 'favourite');
    if (favourite === undefined) continue;
    const target = decodeFavouriteTarget(favourite.target ?? favourite.appliedTarget);
    const state: FavouriteState =
      favourite.state === 'error'
        ? 'error'
        : favourite.state === 'queued'
          ? target === false
            ? 'queued_remove'
            : 'queued_apply'
          : 'applied';
    out.set(photoId, { state, target });
  }
  return out;
}
