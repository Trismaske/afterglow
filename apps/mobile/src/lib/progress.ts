/**
 * Progress-page logic (m0.4 stage 3) — pure TypeScript, unit-tested.
 *
 * Shared by the Day progress and Global progress screens: state
 * classification for grid photos, the inbox-zero breakdown math (moved
 * here from DayProgressScreen so both pages share it), and the state
 * editor's allowed transitions.
 *
 * TRANSITION AUDIT (against db/store.ts semantics — nothing invented;
 * v18: three layers, docs/STATE_MODEL.md):
 * - kept + edit pending → resolve the edit ACTION; the verdict does not
 *                         move, because completing an edit was never a
 *                         change of mind about keeping the photo
 * - kept → queue an edit ACTION (again, verdict untouched)
 * - culled → kept ....... unstageCullDirect (un-cull)
 * - unreviewed / untracked: read-only — the review flow owns them.
 * - trashed:              read-only — gone.
 */
import type { PhotoState } from '@afterglow/core';

/** Per-verdict counts for one scope (day or ms range), from SQLite. */
export interface StateCounts {
  unreviewed: number;
  kept: number;
  staged: number;
  trashed: number;
  /** All rows for the scope. */
  tracked: number;
  /** ALIVE rows dated only by the D15 EXIF rescue (marker present) —
   * invisible to MediaStore range counts, so a day's "still being
   * analyzed" line subtracts them from the ingested-dated population
   * (Tristan, grilling Q8). */
  rescued: number;
  /** Of the above, how many sit in a similarity group — the ANNOTATION
   * layer, counted per verdict so the grouped underline can span them
   * all (docs/STATE_MODEL.md rule 5). */
  grouped: { unreviewed: number; kept: number; staged: number };
  /** Layer 2: photos in the scope with each action WAITING. Not part of
   * the bar — actions are orthogonal to the verdict — but the chips that
   * filter by them need a number, or tapping one is a guess. */
  actions: { edit: number; favourite: number; organize: number; share: number };
}

export interface StateBreakdown {
  /** All photos taken in the scope (incl. already-trashed ones). */
  total: number;
  unreviewed: number;
  kept: number;
  staged: number;
  /** Photos in a group, per verdict. Never a verdict itself. */
  grouped: { unreviewed: number; kept: number; staged: number };
  /** Photos with each action waiting (layer 2, never in the bar). */
  actions: { edit: number; favourite: number; organize: number; share: number };
}

/** Empty share left in a segmented progress bar; never goes negative. */
export function progressRemainder(total: number, counts: readonly number[]): number {
  return Math.max(0, total - counts.reduce((sum, count) => sum + Math.max(0, count), 0));
}

/** One run of the grouped underline: marked spans alternate with blanks. */
export interface GroupedRun {
  weight: number;
  marked: boolean;
}

/**
 * Flex weights for the grouped-underline row (docs/STATE_MODEL.md rule 5).
 *
 * The underline is an ANNOTATION drawn beneath the bar, so it only means
 * anything while it lines up with the segment it annotates. The spans
 * describe the TRACKED photos per verdict; `total` can exceed their sum
 * (photos MediaStore has that the scan never ingested count as
 * unreviewed), and without a trailing blank the row's flex would rescale
 * to the spans alone — pointing the underline at the wrong photos.
 */
export function groupedUnderlineRuns(
  total: number,
  spans: readonly { count: number; of: number }[],
): GroupedRun[] {
  const runs: GroupedRun[] = [];
  let described = 0;
  for (const span of spans) {
    const of = Math.max(0, span.of);
    const marked = Math.min(Math.max(0, span.count), of);
    described += of;
    if (marked > 0) runs.push({ weight: marked, marked: true });
    if (of - marked > 0) runs.push({ weight: of - marked, marked: false });
  }
  const tail = Math.max(0, total - described);
  if (tail > 0) runs.push({ weight: tail, marked: false });
  return runs;
}

/**
 * Photos MediaStore has for the scope but the DB has never tracked count
 * as unreviewed; trashed photos are gone from MediaStore, so the scope's
 * true total is MediaStore + trashed rows.
 *
 * Trashed folds into `kept` — not because it was kept, but because both
 * have converged: the work is finished and nothing else will happen to
 * them. Keeping them apart would add a fourth bar segment for photos the
 * user can no longer see.
 */
export function computeBreakdown(mediaStoreTotal: number, db: StateCounts): StateBreakdown {
  const trackedAlive = db.tracked - db.trashed;
  const neverLoaded = Math.max(0, mediaStoreTotal - trackedAlive);
  return {
    total: mediaStoreTotal + db.trashed,
    unreviewed: neverLoaded + db.unreviewed,
    kept: db.kept + db.trashed,
    staged: db.staged,
    grouped: db.grouped,
    actions: db.actions,
  };
}

/** Photos in the scope still needing review (feeds the day-review CTA).
 * Staged culls count as handled: they are CARRIED in the durable global
 * cull queue and a draw never re-presents them (m0.7 P4#1) — counting
 * them as remaining would enable a review CTA that loads nothing. */
export function remainingReviewable(b: StateBreakdown): number {
  return Math.max(0, b.total - b.kept - b.staged);
}

/** Photos carrying a VERDICT — the one definition of "reviewed" every
 * surface uses (docs/STATE_MODEL.md). Kept already absorbs trashed. */
export function reviewedOf(b: StateBreakdown): number {
  return b.kept + b.staged;
}

/** Whole-percent reviewed share; an empty scope counts as 100%. */
export function reviewedPct(b: StateBreakdown): number {
  return b.total > 0 ? Math.round((reviewedOf(b) / b.total) * 100) : 100;
}

/**
 * Grid/summary filter: everything, one verdict, or one pending action.
 *
 * Verdicts and actions filter the same grid but come from different
 * layers, which is why they render as two chip rows rather than one.
 */
export type ProgressFilter = 'all' | EffectiveState | ActionFilter;

/** The VERDICT a photo shows in progress UIs. Grouping is not here: it
 * is an annotation drawn under the bar, not a state (rule 5). */
export type EffectiveState = 'unreviewed' | 'kept' | 'staged';

/** Pending-action filters, prefixed so they cannot collide with a
 * verdict now or when either list grows. */
export type ActionFilter = 'act:edit' | 'act:favourite' | 'act:organize' | 'act:share';

export function isActionFilter(filter: ProgressFilter): filter is ActionFilter {
  return filter.startsWith('act:');
}

/**
 * Verdict of an alive MediaStore photo given its DB row (absent row =
 * never tracked = unreviewed). Trashed converges with kept: the work is
 * over and the file is gone from the grid either way.
 */
export function classifyPhotoState(row: { state: PhotoState } | undefined): EffectiveState {
  if (!row) return 'unreviewed';
  switch (row.state) {
    case 'culled':
      return 'staged';
    case 'trashed':
    case 'kept':
      return 'kept';
    case 'unreviewed':
    default:
      return 'unreviewed';
  }
}

/** What the state editor sheet may do to a photo (see module docs). */
export type EditorAction = 'complete_edit' | 'queue_edit' | 'unstage_cull';

/**
 * Allowed transitions for the state editor.
 *
 * v18: this now takes the VERDICT and the edit ACTION separately,
 * because they are separate layers. Previously a single `to_edit` value
 * meant both "kept" and "edit pending", so the two could never disagree
 * — and could never be changed independently either.
 */
export function editorActions(verdict: PhotoState | null, editPending: boolean): EditorAction[] {
  switch (verdict) {
    case 'culled':
      return ['unstage_cull'];
    case 'kept':
      return editPending ? ['complete_edit'] : ['queue_edit'];
    default:
      // null / unreviewed / trashed → read-only.
      return [];
  }
}
