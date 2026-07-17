/**
 * Progress-page logic (m0.4 stage 3) — pure TypeScript, unit-tested.
 *
 * Shared by the Day progress and Global progress screens: state
 * classification for grid photos, the inbox-zero breakdown math (moved
 * here from DayProgressScreen so both pages share it), and the state
 * editor's allowed transitions.
 *
 * TRANSITION AUDIT (against db/store.ts semantics — nothing invented):
 * - kept → done ......... markKeptDone (kept rows only; finish-time path)
 * - kept → to_edit ...... setNeedsEdit(true) (the CASE remap, m0.2 #1)
 * - to_edit → done ...... markEditDone (also clears needs_edit)
 * - done → to_edit ...... markDoneToEdit (needs_edit=1, to_edit_at
 *                         first-entry-wins — mirrors the CASE writes)
 * - culled → kept ....... unstageCullDirect (un-cull; comes back as
 *                         to_edit when the needs-edit flag is set,
 *                         m0.2 #8 — same as the in-session cull list)
 * - unreviewed / untracked: read-only — the review flow owns them.
 * - trashed / confirmed:  read-only — gone (or mid-delete).
 * - anything in the ACTIVE session: read-only. Direct DB writes would
 *   desync the authoritative session snapshot (e.g. un-culling a staged
 *   photo here would not stop the session from deleting it at confirm).
 *   The session's own screens (deck, cull list, edit flags) are the
 *   editing surface while a session is live.
 */
import type { PhotoState } from '@afterglow/core';

/** Per-state counts for one scope (day or ms range), from SQLite. */
export interface StateCounts {
  /** Rows in the DB for this scope, by state. */
  unreviewedGrouped: number;
  unreviewedSingle: number;
  kept: number;
  toEdit: number;
  staged: number;
  trashed: number;
  done: number;
  /** All rows for the scope (sum of the above + any transient states). */
  tracked: number;
}

export interface StateBreakdown {
  /** All photos taken in the scope (incl. already-trashed ones). */
  total: number;
  unreviewed: number;
  inGroups: number;
  kept: number;
  toEdit: number;
  staged: number;
  /** done + trashed — both have converged. */
  done: number;
}

/**
 * Everything converges to done: photos MediaStore has for the scope but
 * the DB has never tracked count as unreviewed; trashed photos are gone
 * from MediaStore, so the scope's true total is MediaStore + trashed rows.
 */
export function computeBreakdown(mediaStoreTotal: number, db: StateCounts): StateBreakdown {
  const trackedAlive = db.tracked - db.trashed;
  const neverLoaded = Math.max(0, mediaStoreTotal - trackedAlive);
  return {
    total: mediaStoreTotal + db.trashed,
    unreviewed: neverLoaded + db.unreviewedSingle,
    inGroups: db.unreviewedGrouped,
    kept: db.kept,
    toEdit: db.toEdit,
    staged: db.staged,
    done: db.done + db.trashed,
  };
}

/** Photos in the scope still needing review (feeds the day-review CTA). */
export function remainingReviewable(b: StateBreakdown): number {
  return Math.max(0, b.total - b.done - b.toEdit);
}

/** Whole-percent done share; an empty scope counts as 100% (inbox zero). */
export function donePct(b: StateBreakdown): number {
  return b.total > 0 ? Math.round((b.done / b.total) * 100) : 100;
}

/** Grid/summary filter: 'all' or one effective per-photo state. */
export type ProgressFilter = 'all' | EffectiveState;

/** The state a photo *shows* in progress UIs (grid badges, filters). */
export type EffectiveState =
  | 'unreviewed'
  | 'in_group'
  | 'kept'
  | 'to_edit'
  | 'staged'
  | 'done';

/**
 * Effective state of an alive MediaStore photo given its DB row (absent
 * row = never tracked = unreviewed). Mirrors the m0.2 accounting:
 * unreviewed rows with a group are "in a group"; culled/confirmed are
 * staged; done and trashed have both converged.
 */
export function classifyPhotoState(
  row: { state: PhotoState; grouped: boolean } | undefined,
): EffectiveState {
  if (!row) return 'unreviewed';
  switch (row.state) {
    case 'kept':
      return 'kept';
    case 'to_edit':
      return 'to_edit';
    case 'culled':
    case 'confirmed':
      return 'staged';
    case 'trashed':
    case 'done':
      return 'done';
    case 'unreviewed':
    default:
      return row.grouped ? 'in_group' : 'unreviewed';
  }
}

/** What the state editor sheet may do to a photo (see module docs). */
export type EditorAction = 'mark_done' | 'queue_edit' | 'unstage_cull';

/**
 * Allowed transitions for the state editor. `dbState` is the photo's
 * actual `photos.state` row value (null = untracked). Photos belonging
 * to the active session are always read-only here.
 */
export function editorActions(
  dbState: PhotoState | null,
  inActiveSession: boolean,
): EditorAction[] {
  if (inActiveSession) return [];
  switch (dbState) {
    case 'kept':
      return ['mark_done', 'queue_edit'];
    case 'to_edit':
      return ['mark_done'];
    case 'done':
      return ['queue_edit'];
    case 'culled':
      return ['unstage_cull'];
    default:
      // null / unreviewed / confirmed / trashed → read-only.
      return [];
  }
}
