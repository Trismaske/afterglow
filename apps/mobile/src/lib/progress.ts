/**
 * Progress-page logic (m0.4 stage 3) — pure TypeScript, unit-tested.
 *
 * Shared by the Day progress and Global progress screens: state
 * classification for grid photos, the inbox-zero breakdown math (moved
 * here from DayProgressScreen so both pages share it), and the state
 * editor's allowed transitions.
 *
 * TRANSITION AUDIT (against db/store.ts semantics — nothing invented;
 * m0.8: kept is gone, every keep IS done):
 * - to_edit → done ...... markEditDone (also clears needs_edit)
 * - done → to_edit ...... setNeedsEdit(true) / markDoneToEdit
 *                         (needs_edit=1, to_edit_at first-entry-wins)
 * - culled → done ....... unstageCullDirect (un-cull; comes back as
 *                         to_edit when the needs-edit flag is set)
 * - unreviewed / untracked: read-only — the review flow owns them.
 * - trashed / confirmed:  read-only — gone (or mid-delete).
 */
import type { PhotoState } from '@afterglow/core';

/** Per-state counts for one scope (day or ms range), from SQLite. */
export interface StateCounts {
  /** Rows in the DB for this scope, by state. */
  unreviewedGrouped: number;
  unreviewedSingle: number;
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
  toEdit: number;
  staged: number;
  /** done + trashed — both have converged. */
  done: number;
}

/** Empty share left in a segmented progress bar; never goes negative. */
export function progressRemainder(total: number, counts: readonly number[]): number {
  return Math.max(0, total - counts.reduce((sum, count) => sum + Math.max(0, count), 0));
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
    toEdit: db.toEdit,
    staged: db.staged,
    done: db.done + db.trashed,
  };
}

/** Photos in the scope still needing review (feeds the day-review CTA).
 * Staged culls count as handled: they are CARRIED in the durable global
 * cull queue and a draw never re-presents them (m0.7 P4#1) — counting
 * them as remaining would enable a review CTA that loads nothing. */
export function remainingReviewable(b: StateBreakdown): number {
  return Math.max(0, b.total - b.done - b.toEdit - b.staged);
}

/** Whole-percent done share; an empty scope counts as 100% (inbox zero). */
export function donePct(b: StateBreakdown): number {
  return b.total > 0 ? Math.round((b.done / b.total) * 100) : 100;
}

/** Grid/summary filter: 'all' or one effective per-photo state. */
export type ProgressFilter = 'all' | EffectiveState;

/** The state a photo *shows* in progress UIs (grid badges, filters). */
export type EffectiveState = 'unreviewed' | 'in_group' | 'to_edit' | 'staged' | 'done';

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
 * actual `photos.state` row value (null = untracked).
 */
export function editorActions(dbState: PhotoState | null): EditorAction[] {
  switch (dbState) {
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
