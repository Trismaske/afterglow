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

/** The state editor's full offer for one photo (m0.8.6, F9): the state
 * model made touchable — one verdict, every action independently
 * addable and removable, refusing only what genuinely cannot be undone.
 * Pure; the sheet supplies the facts row. */
export interface EditorOffer {
  /** The whole sheet is read-only, with this explanation. Exactly two
   * cases: trashed (the OS owns it) and untracked (the scan owns it). */
  readOnly: 'trashed' | 'untracked' | null;
  /** The verdict control's current position. */
  verdict: 'unreviewed' | 'kept' | 'culled' | null;
  /** Edit row: add a cycle, or (queued) remove / complete it. */
  edit: 'add' | 'queued' | null;
  /** Favourite row, tri-state honest (docs/STATE_MODEL.md): what one
   * tap does next. `remove_applied` queues the un-favourite — an
   * APPLIED favourite is removable (the heart-off badge models it).
   * `suspended` (m0.8.7, F21 point 2): on a STAGED cull with nothing
   * queued, the addition is refused — the row says why, offers nothing. */
  favourite: 'add' | 'cancel_add' | 'remove_applied' | 'cancel_remove' | 'suspended' | null;
  /** Share row: a queued pass is removable; a resolved one is fact —
   * only a NEW pass can be added (nothing recalls a sent share). Share
   * stays fully offerable on a staged cull (F21 point 1). */
  share: 'add' | 'remove' | null;
  /** Organize row: a queued move is removable; an APPLIED move is fact
   * (the album line names it) — a new move stays addable, except on a
   * staged cull (`suspended`, F21 point 2). */
  organize: 'add' | 'remove' | 'suspended' | null;
}

/** The facts slice the offer derives from (a projection of PhotoFacts +
 * the share-queue membership read). */
export interface EditorFacts {
  state: PhotoState | null;
  editPending: boolean;
  /** 1 = queued apply, 0 = queued removal, null = nothing queued. */
  favouriteQueued: number | null;
  favouriteApplied: boolean;
  shareQueued: boolean;
  organizeQueued: boolean;
}

export function editorOffer(facts: EditorFacts): EditorOffer {
  if (facts.state === 'trashed' || facts.state === null) {
    return {
      readOnly: facts.state === 'trashed' ? 'trashed' : 'untracked',
      verdict: null,
      edit: null,
      favourite: null,
      share: null,
      organize: null,
    };
  }
  // F21 (m0.8.7): on a STAGED cull, share and edit stay fully offerable
  // (point 1 — "delete it, but share it first"), while favourite and
  // organize refuse ADDITIONS (point 2). Existing queued rows stay
  // cancellable — removing work is always safe.
  const staged = facts.state === 'culled';
  return {
    readOnly: null,
    verdict: facts.state,
    edit: facts.editPending ? 'queued' : 'add',
    favourite:
      facts.favouriteQueued === 1
        ? 'cancel_add'
        : facts.favouriteQueued === 0
          ? 'cancel_remove'
          : staged
            ? 'suspended'
            : facts.favouriteApplied
              ? 'remove_applied'
              : 'add',
    share: facts.shareQueued ? 'remove' : 'add',
    organize: facts.organizeQueued ? 'remove' : staged ? 'suspended' : 'add',
  };
}
