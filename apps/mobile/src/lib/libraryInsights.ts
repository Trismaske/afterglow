/**
 * Library-insight math (m0.8.2) — the pure half of the redesigned
 * Progress page: capture-histogram geometry, the backlog frontier
 * sentence, storage shares, and the burst tax.
 *
 * The histogram is NAVIGATION, not decoration: each bar carries the
 * month range the grid filters to when it is tapped, so the picture of
 * where the backlog sits and the way to go and work on it are the same
 * control.
 *
 * Bars scale against the tallest month in the WHOLE library, not the
 * scrolled-to window. A scale that re-normalised as you scrolled would
 * redraw the same month at different heights depending on where you had
 * dragged to, which makes the chart unreadable as a comparison — at the
 * cost that a sparse stretch genuinely looks sparse.
 */
import { UNDATED_DAY_KEY } from './dates';

/** A month's bar in the capture histogram. */
export interface HistogramBar {
  /** "YYYY-MM", or UNDATED_DAY_KEY for the undated bucket. */
  key: string;
  /** Full name ("Nov 2024" / "Undated") — accessibility and the grid header. */
  label: string;
  /**
   * Quarter tick ("Jan"/"Apr"/"Jul"/"Oct"), or null between them.
   *
   * A label under EVERY bar is unreadable — device-observed, a 48-month
   * library gives ~17 px columns where even a four-digit year truncates
   * to an ellipsis. Ticking quarters leaves three bar-widths of space
   * per label, and because the month range is gap-filled the ticks land
   * on real calendar quarters rather than drifting with missing months.
   */
  monthTick: string | null;
  /** Year for the axis's second row, printed under January (or under the
   * first bar when the span is too short to contain one). */
  yearTick: string | null;
  total: number;
  reviewed: number;
  /** Share of the plot height, 0..1. */
  height: number;
  /** Reviewed share of THIS bar, 0..1 (the shaded portion). */
  reviewedFraction: number;
  /** True for the undated bucket, which has no calendar position. */
  undated: boolean;
}

export interface Histogram {
  bars: HistogramBar[];
  /** Tracked photos across every bar. */
  total: number;
  /** Of those, carrying a verdict. */
  reviewed: number;
}

/** Month buckets as the store returns them (null month = undated). */
export interface MonthInput {
  month: string | null;
  total: number;
  reviewed: number;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Every "YYYY-MM" from `first` to `last` inclusive. */
export function monthRange(first: string, last: string): string[] {
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  const months: string[] = [];
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm);) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/**
 * Build the histogram: the undated bucket FIRST, then every calendar
 * month from the oldest to the newest — including the empty ones.
 *
 * Gap-filling is what makes this a timeline rather than a bar list. With
 * only non-empty months rendered, a quiet year and a busy year occupy
 * the same width and the chart lies about when things happened; it also
 * makes quarter ticks drift off the real calendar. The chart scrolls
 * horizontally, so the extra columns cost nothing but honesty.
 *
 * Undated leads rather than trails: it has no calendar position, so it
 * must not sit BETWEEN two known months and imply an age, and these are
 * typically old imports whose metadata was stripped. Leftmost also keeps
 * it clear of the recent end, which is where the chart opens.
 */
export function buildHistogram(buckets: readonly MonthInput[]): Histogram {
  const dated = buckets
    .filter((bucket): bucket is MonthInput & { month: string } => bucket.month !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const byMonth = new Map(dated.map((bucket) => [bucket.month, bucket]));
  const filled: MonthInput[] =
    dated.length === 0
      ? []
      : monthRange(dated[0].month, dated[dated.length - 1].month).map(
          (month) => byMonth.get(month) ?? { month, total: 0, reviewed: 0 },
        );
  const undated = buckets.find((bucket) => bucket.month === null);
  const all = [...(undated && undated.total > 0 ? [undated] : []), ...filled];
  const tallest = all.reduce((max, bucket) => Math.max(max, bucket.total), 0);
  // Without a January in range (a span under a year) the year would go
  // unnamed entirely, so the first dated bar carries it instead.
  const firstDated = filled[0]?.month ?? null;
  const hasJanuary = filled.some((bucket) => bucket.month?.endsWith('-01'));
  const bars: HistogramBar[] = all.map((bucket) => {
    if (bucket.month === null) {
      return {
        key: UNDATED_DAY_KEY,
        label: 'Undated',
        monthTick: 'Und',
        yearTick: null,
        total: bucket.total,
        reviewed: bucket.reviewed,
        height: tallest === 0 ? 0 : bucket.total / tallest,
        // A month with no photos is NOT "fully reviewed": with gap-filling
        // that mistake paints every empty month a solid reviewed-green
        // dash, and a quiet year reads as a finished one (device-observed).
        reviewedFraction: bucket.total === 0 ? 0 : bucket.reviewed / bucket.total,
        undated: true,
      };
    }
    const month = Number(bucket.month.slice(5, 7));
    const year = bucket.month.slice(0, 4);
    return {
      key: bucket.month,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      // Quarters: Jan, Apr, Jul, Oct.
      monthTick: month % 3 === 1 ? MONTH_NAMES[month - 1] : null,
      yearTick: month === 1 || (!hasJanuary && bucket.month === firstDated) ? year : null,
      total: bucket.total,
      reviewed: bucket.reviewed,
      height: tallest === 0 ? 0 : bucket.total / tallest,
      // A month with no photos is NOT "fully reviewed": with gap-filling
      // that mistake paints every empty month a solid reviewed-green
      // dash, and a quiet year reads as a finished one (device-observed).
      reviewedFraction: bucket.total === 0 ? 0 : bucket.reviewed / bucket.total,
      undated: false,
    };
  });
  return {
    bars,
    total: all.reduce((sum, bucket) => sum + bucket.total, 0),
    reviewed: all.reduce((sum, bucket) => sum + bucket.reviewed, 0),
  };
}

/** Local ms range covering a whole "YYYY-MM" month. */
export function rangeOfMonth(key: string): { startMs: number; endMs: number } {
  const [year, month] = key.split('-').map(Number);
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  // Day 0 of the NEXT month is the last day of this one — no 28/30/31
  // table, and leap years handle themselves.
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * The frontier sentence, or null when there is nothing true to say.
 *
 * Returns null rather than an empty-ish string on a fresh library: a
 * page that says "reviewed back to —" reads as a broken value, while a
 * missing line reads as "not yet".
 */
export function frontierLine(
  frontier: { reviewedBackTo: string | null; undatedPending: number },
  formatMonth: (key: string) => string,
): string | null {
  const parts: string[] = [];
  if (frontier.reviewedBackTo !== null)
    parts.push(`Reviewed back to ${formatMonth(frontier.reviewedBackTo.slice(0, 7))}`);
  if (frontier.undatedPending > 0) parts.push(`${frontier.undatedPending} undated waiting`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The burst tax: frames a group holds beyond the one it stands for. */
export function redundantFrames(stats: { photosInGroups: number; groups: number }): number {
  return Math.max(0, stats.photosInGroups - stats.groups);
}

/**
 * "You keep 1 of N" over fully decided groups, or null when too little
 * has been decided to mean anything.
 *
 * Null when nothing was kept, too: dividing by zero kept photos would
 * report an infinite ratio from a user who culled one whole group.
 */
export function keepsPerGroup(stats: {
  decidedMembers: number;
  decidedKept: number;
}): number | null {
  if (stats.decidedMembers === 0 || stats.decidedKept === 0) return null;
  return stats.decidedMembers / stats.decidedKept;
}
