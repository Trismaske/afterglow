/**
 * Delta-scan range derivation (m0.8.2, pure) — the half of the delta
 * design that has logic rather than plumbing.
 *
 * A full continuous pass costs ~204 s of sustained CPU on a 27k corpus
 * and runs whenever MediaStore's per-volume generation moved — which any
 * app's media activity does, so on a chatty phone that is most opens.
 * The delta pass makes the cost proportional to what CHANGED.
 *
 * The one thing that cannot be naive: **a changed photo must be
 * regrouped with its whole window, not with a fixed slice around it.**
 * Grouping is window-based (`scanWindows.ts`) and core never links
 * photos across a gap larger than the adjacent-merge window, so
 * re-deriving a changed photo's window reproduces exactly what a full
 * pass would have produced there — but a window is a maximal CHAIN of
 * ≤gap steps and can run for hours, so its bounds have to be walked from
 * the library's own timestamps rather than assumed (see planDeltaRanges).
 *
 * RANGES ARE QUERIED BY DATE_TAKEN ALONE. `lib/media.ts` timestamps a
 * photo `creationTime || modificationTime || 0` for GROUPING, but the
 * re-page query a range is handed to filters on `DATE_TAKEN`
 * (fetchPhotoPageDesc) — so a changed photo with no DATE_TAKEN (a
 * WhatsApp image is the common case, not an edge case) can never be
 * returned by any range, wherever its mtime would place it. Deriving a
 * range from the mtime fallback claims coverage the query cannot
 * deliver: the modification is never re-ingested, the generation
 * advances past it, and the delta silently stops equalling a full pass —
 * which is the one property the design cannot lose. Every changed row
 * without a DATE_TAKEN therefore counts as `undated` and forces the
 * full-pass fallback (a full pass's unbounded query does return those
 * rows, batched by effective time).
 *
 * Everything here was measured on real devices before anything routed
 * through it — the trash finding, the mtime fallback and the window-walk
 * correction all came from that pass, and none was predictable from
 * reading the MediaStore documentation.
 */
import type { ChangedMediaRow } from '../../modules/media-store-actions';

/** One contiguous time range to re-page and regroup. */
export interface DeltaRange {
  startMs: number;
  endMs: number;
  /** Changed photos whose expansion produced this range (>= 1). */
  changed: number;
}

export interface DeltaPlan {
  /** Ranges to re-page, ascending, non-overlapping. */
  ranges: DeltaRange[];
  /** Changed rows with no DATE_TAKEN — no range can cover them, because
   * the re-page query filters on DATE_TAKEN alone (an mtime-only row is
   * placeable in the timeline but not fetchable by range). Any of these
   * forces the full-pass fallback. */
  undated: number;
  /** Changed rows carrying IS_TRASHED — a deletion made VISIBLE. */
  trashed: number;
  /** Total changed rows considered. */
  changed: number;
}

/**
 * Fixed cost of one range, expressed in PHOTO-EQUIVALENTS — a ranged
 * MediaStore query per source bucket, divided by the per-photo cost.
 *
 * Derivation: the native catalog walk does ~0.5 ms per bucket cursor, a
 * ranged page query is the same order (call it 15 ms to be generous),
 * and the measured per-photo cost is 7.5 ms on the S23 / 14.3 ms on the
 * S10e — so R/c lands at 1-2. Phase 2 replaces this estimate with a
 * measurement; it enters the same formula rather than changing it.
 */
export const RANGE_COST_IN_PHOTOS = 2;

/**
 * How decisive the win must be. At `cost === corpus` the two passes cost
 * the same, so anything below 1 is a win; ½ keeps the marginal cases on
 * the well-tested full path.
 */
export const DELTA_WIN_MARGIN = 0.5;

export interface DeltaVerdict {
  /** What the delta would cost, in photo-equivalents. */
  cost: number;
  /** What it must come in under. */
  budget: number;
  worthIt: boolean;
}

/**
 * Is the delta cheaper than a full pass?
 *
 *     cost   = covered + changed + RANGE_COST_IN_PHOTOS × ranges
 *     budget = margin × corpus
 *
 * CAPPING ON RANGE COUNT MEASURES THE WRONG THING. 200 ranges holding
 * one photo each is trivially cheap; three ranges covering 20,000 photos
 * is a full pass in disguise. And any constant is right for one corpus
 * and wrong for another — with a 50-photo burst per range, break-even
 * sits at ~520 ranges on a 27k library and ~114 on a 5.8k one, a 4.5×
 * spread. Both sides here are in photo-equivalents, so the rule scales
 * with the library instead of hard-coding one phone's arithmetic.
 *
 * Fail-safe by construction: every wrong answer degrades to a full pass,
 * which is exactly what shipped before the delta existed.
 */
export function deltaVerdict(args: {
  /** Tracked photos inside the merged ranges. */
  covered: number;
  /** Changed rows (some may not be tracked yet — they are new). */
  changed: number;
  ranges: number;
  /** Total tracked photos. */
  corpus: number;
  perRangeCost?: number;
  margin?: number;
}): DeltaVerdict {
  const cost =
    args.covered + args.changed + (args.perRangeCost ?? RANGE_COST_IN_PHOTOS) * args.ranges;
  const budget = (args.margin ?? DELTA_WIN_MARGIN) * args.corpus;
  return { cost, budget, worthIt: cost < budget };
}

/**
 * Build the re-page plan for a change set.
 *
 * A merge window is a MAXIMAL CHAIN of photos whose consecutive gaps are
 * all ≤ `gapMs` (`scanWindows.ts` closes a window only when the next
 * photo falls more than the gap from the window's oldest member). Such a
 * chain has no length limit — photos every 10 minutes for three hours
 * are ONE window — so expanding a fixed ±gap around a changed photo
 * captures a FRAGMENT of its window, and grouping a fragment in
 * isolation does not equal grouping the whole. The delta would quietly
 * produce different groups from a full pass.
 *
 * So the bounds are walked, not assumed: from each changed timestamp,
 * step outward through the library's own timestamps while the gaps stay
 * within the merge gap, and stop at the first real break. That is the
 * exact window a full pass would have built.
 *
 * `sortedTimestamps` is every tracked photo's effective timestamp in
 * scope, ascending — the same population and the same ordering the scan
 * pages. A changed photo need not appear in it (a brand-new photo is not
 * tracked yet); the walk starts from its timestamp either way.
 *
 * Degenerate by design: a library that is one unbroken chain expands to
 * itself, and the cost model then correctly picks the full pass.
 */
export function planDeltaRanges(
  changed: readonly ChangedMediaRow[],
  sortedTimestamps: readonly number[],
  gapMs: number,
): DeltaPlan {
  const changedAts: number[] = [];
  let undated = 0;
  let trashed = 0;
  for (const row of changed) {
    if (row.isTrashed) trashed += 1;
    // DATE_TAKEN only — the range query cannot fetch anything else (see
    // header). This includes trashed rows: their surviving neighbours
    // need rewindowing, which is range work too.
    if (row.dateTakenMs === null) undated += 1;
    else changedAts.push(row.dateTakenMs);
  }
  changedAts.sort((a, b) => a - b);
  const ranges: DeltaRange[] = [];
  for (const at of changedAts) {
    const last = ranges[ranges.length - 1];
    // Already inside a window this pass has walked: nothing to re-derive.
    if (last && at <= last.endMs) {
      last.changed += 1;
      continue;
    }
    const { startMs, endMs } = walkWindow(sortedTimestamps, at, gapMs);
    // Touching counts as overlapping: two ranges meeting exactly would
    // regroup the same boundary photo twice for an identical union.
    if (last && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      last.changed += 1;
    } else {
      ranges.push({ startMs, endMs, changed: 1 });
    }
  }
  return { ranges, undated, trashed, changed: changed.length };
}

/** The maximal ≤`gapMs`-chain around `at`, in `sorted` (ascending). */
function walkWindow(
  sorted: readonly number[],
  at: number,
  gapMs: number,
): { startMs: number; endMs: number } {
  // First index whose timestamp is >= at.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  let startMs = at;
  for (let i = lo - 1; i >= 0 && startMs - sorted[i] <= gapMs; i -= 1) startMs = sorted[i];
  let endMs = at;
  for (let i = lo; i < sorted.length && sorted[i] - endMs <= gapMs; i += 1) endMs = sorted[i];
  return { startMs, endMs };
}

/** Tracked photos inside the planned ranges — the cost model's `covered`
 * term, counted from the SAME array the ranges were walked in, so the
 * two can never disagree. Ranges are non-overlapping by construction. */
export function coveredBy(
  sortedTimestamps: readonly number[],
  ranges: readonly DeltaRange[],
): number {
  let covered = 0;
  let i = 0;
  for (const range of ranges) {
    while (i < sortedTimestamps.length && sortedTimestamps[i] < range.startMs) i += 1;
    while (i < sortedTimestamps.length && sortedTimestamps[i] <= range.endMs) {
      covered += 1;
      i += 1;
    }
  }
  return covered;
}

/** One-line field summary of a pass decision (`[scan] delta …`). */
export function describeDeltaPlan(plan: DeltaPlan, verdict?: DeltaVerdict): string {
  if (plan.changed === 0) return 'delta: nothing changed';
  const spanMs = plan.ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  const decision =
    verdict === undefined
      ? ''
      : ` — cost ${Math.round(verdict.cost)} vs budget ${Math.round(verdict.budget)} photos: ` +
        (verdict.worthIt ? 'DELTA wins' : 'full pass wins');
  return (
    `delta: ${plan.changed} changed (${plan.trashed} trashed, ${plan.undated} undated) → ` +
    `${plan.ranges.length} ranges spanning ${Math.round(spanMs / 60_000)} min` +
    decision
  );
}
