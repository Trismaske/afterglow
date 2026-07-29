/**
 * The COVERAGE goal (m0.8.1 round 8, tester design) — the second,
 * independent goal. Where the count goal (`dailyGoal.ts`) measures
 * EFFORT ("review 50 photos today", any photo of any age), coverage
 * measures KEEPING UP: "leave nothing unreviewed from the last N days".
 *
 * The two are deliberately separate settings with separate indicators
 * and separate charts. That is not just richer — it is less code: the
 * count goal stays a plain integer, so the ring, its streaks and the
 * activity chart are untouched by everything here.
 *
 * Axis note: coverage is scoped by CAPTURE day (`photos.day`), while the
 * count goal counts DECISION days (`decided_at`). Reviewing 200 photos
 * from 2019 today moves the count goal and not coverage; that asymmetry
 * is the point of having both.
 *
 * "All time" is the 100%-of-everything goal: the same mechanism with an
 * unbounded window. It is the one mode with no streak — being at inbox
 * zero is a state, not a run of days — so it reports percent complete
 * instead.
 *
 * Undated photos (no capture date) cannot sit in a rolling window, so
 * they count only toward "all time".
 */

export const COVERAGE_GOAL_KEY = 'coverage_goal';

export const COVERAGE_GOAL_CHOICES = ['off', 'today', '2days', '7days', 'all'] as const;
export type CoverageGoal = (typeof COVERAGE_GOAL_CHOICES)[number];

/** Keeping up with the last two days: forgiving of evening shooting. */
export const DEFAULT_COVERAGE_GOAL: CoverageGoal = '2days';

export function parseCoverageGoal(raw: string | null): CoverageGoal {
  return (COVERAGE_GOAL_CHOICES as readonly string[]).includes(raw ?? '')
    ? (raw as CoverageGoal)
    : DEFAULT_COVERAGE_GOAL;
}

export function serializeCoverageGoal(goal: CoverageGoal): string {
  return goal;
}

/** Calendar days the window spans; null = all time; 0 = no goal set. */
export function coverageWindowDays(goal: CoverageGoal): number | null | 0 {
  switch (goal) {
    case 'off':
      return 0;
    case 'today':
      return 1;
    case '2days':
      return 2;
    case '7days':
      return 7;
    case 'all':
      return null;
  }
}

export const COVERAGE_GOAL_LABELS: Record<CoverageGoal, string> = {
  off: 'Off',
  today: 'Today',
  '2days': '2 days',
  '7days': '7 days',
  all: 'All time',
};

/** One capture day's review coverage (from db `getCoverageByDay`). */
export interface DayCoverage {
  /** Local "YYYY-MM-DD"; null is the undated bucket. */
  day: string | null;
  /** Tracked, present photos captured that day. */
  total: number;
  /** Of those, still unreviewed. */
  pending: number;
}

export interface CoverageStatus {
  /** Photos in the window. */
  total: number;
  /** Of those, still unreviewed — the work left to be "kept up". */
  pending: number;
  /** 0..1; an empty window is vacuously complete (1). */
  ratio: number;
  /** Consecutive cleared shooting days ending at today — null for all
   * time, where a run of days is meaningless. An unfinished today defers
   * to yesterday's streak, exactly like the count goal's streaks. */
  streak: number | null;
}

/**
 * Coverage over `dayKeys` (the calendar sequence to judge, oldest FIRST
 * and ending today). For 'all' the keys are ignored and every row counts,
 * including the undated bucket.
 *
 * `rows` must span the whole of `dayKeys`, not just the window: the
 * window bounds `total`/`pending`, but the streak reads back across every
 * key, and a day whose row was never loaded is indistinguishable from a
 * day with no photos.
 */
export function coverageStatus(
  rows: readonly DayCoverage[],
  goal: CoverageGoal,
  dayKeys: readonly string[],
): CoverageStatus {
  if (goal === 'off') return { total: 0, pending: 0, ratio: 1, streak: null };

  if (goal === 'all') {
    let total = 0;
    let pending = 0;
    for (const row of rows) {
      total += row.total;
      pending += row.pending;
    }
    return {
      total,
      pending,
      ratio: total === 0 ? 1 : (total - pending) / total,
      streak: null,
    };
  }

  const windowDays = coverageWindowDays(goal);
  const keys = typeof windowDays === 'number' ? dayKeys.slice(-windowDays) : dayKeys;
  // Rolling windows are CAPTURE-day scoped, so the undated bucket has no
  // day to belong to and is excluded.
  const byDay = new Map(rows.filter((r) => r.day !== null).map((r) => [r.day as string, r]));
  let total = 0;
  let pending = 0;
  for (const key of keys) {
    const row = byDay.get(key);
    total += row?.total ?? 0;
    pending += row?.pending ?? 0;
  }
  return {
    total,
    pending,
    ratio: total === 0 ? 1 : (total - pending) / total,
    streak: coverageStreak(rows, dayKeys),
  };
}

/**
 * Consecutive cleared SHOOTING days ending at today: days you captured
 * something and left nothing unreviewed.
 *
 * Days with no photos pass straight through — they neither break the run
 * (not shooting is not a failure) nor extend it (a phone left in a drawer
 * must not earn a streak). Today counts only once it is clear; an
 * unfinished today defers to yesterday's run rather than breaking it
 * (same rule as the count goal's streaks).
 */
export function coverageStreak(rows: readonly DayCoverage[], dayKeys: readonly string[]): number {
  const byDay = new Map(rows.filter((r) => r.day !== null).map((r) => [r.day as string, r]));
  let streak = 0;
  for (let i = dayKeys.length - 1; i >= 0; i -= 1) {
    const row = byDay.get(dayKeys[i]);
    if (row === undefined || row.total === 0) continue; // nothing shot that day
    if (row.pending === 0) streak += 1;
    else if (i < dayKeys.length - 1) break; // today is still in progress
  }
  return streak;
}

/** One day's marker in the Stats coverage chart. */
export interface CoverageMarker {
  day: string;
  total: number;
  pending: number;
  /** Nothing left from that day. */
  cleared: boolean;
  /** No photos captured that day — rendered as a gap, not a win. */
  empty: boolean;
  isToday: boolean;
}

export interface CoverageWindow {
  markers: CoverageMarker[];
  /** Days with photos that are fully reviewed. */
  clearedDays: number;
  /** Days with photos at all (the denominator worth showing). */
  daysWithPhotos: number;
  /** Photos still unreviewed across the plotted window. */
  pending: number;
}

/**
 * The Stats coverage chart: one marker per plotted day, cleared or not.
 * `dayKeys` is oldest FIRST and ends today, exactly like the activity
 * chart, so the two charts line up column for column.
 */
export function coverageWindow(
  rows: readonly DayCoverage[],
  dayKeys: readonly string[],
): CoverageWindow {
  const byDay = new Map(rows.filter((r) => r.day !== null).map((r) => [r.day as string, r]));
  const markers = dayKeys.map((day, i) => {
    const row = byDay.get(day);
    const total = row?.total ?? 0;
    const pending = row?.pending ?? 0;
    return {
      day,
      total,
      pending,
      cleared: total > 0 && pending === 0,
      empty: total === 0,
      isToday: i === dayKeys.length - 1,
    };
  });
  return summarize(markers);
}

/**
 * The same window narrowed to its most recent `days`. The streak needs a
 * long horizon while the chart plots a short one, so the totals MUST be
 * recomputed from the plotted markers — a caption counting days the chart
 * does not draw is how "0 of 10 days" ends up over an empty chart.
 */
export function lastCoverageDays(window: CoverageWindow, days: number): CoverageWindow {
  return summarize(window.markers.slice(-days));
}

function summarize(markers: CoverageMarker[]): CoverageWindow {
  return {
    markers,
    clearedDays: markers.filter((m) => m.cleared).length,
    daysWithPhotos: markers.filter((m) => !m.empty).length,
    pending: markers.reduce((sum, m) => sum + m.pending, 0),
  };
}
