/**
 * Stats-page pure logic: the review-activity window behind the
 * last-N-days bar chart and its headline numbers.
 *
 * The per-day counts come from `getReviewedCountsByDay` — DECISION-day
 * counts, the same source as the Home goal ring and streaks — so a bar
 * is "the reviewing work done that day", never "photos taken that day".
 *
 * Bars scale against the tallest thing IN VIEW (the best day or the
 * goal, whichever is larger): the goal line can never leave the plot,
 * and a quiet fortnight cannot fake a full-looking chart.
 */

/** Days the Stats chart plots (the streak window stays longer). */
export const ACTIVITY_WINDOW_DAYS = 30;

export interface ActivityBar {
  /** Local "YYYY-MM-DD" key. */
  day: string;
  /** Photos decided that day. */
  count: number;
  /** Share of the plot height, 0..1. */
  height: number;
  goalReached: boolean;
  /** True for the last key — `dayKeys` must end at today. */
  isToday: boolean;
}

export interface ActivityWindow {
  /** One bar per key, in `dayKeys` order (oldest first). */
  bars: ActivityBar[];
  /** Decisions across the whole window. */
  total: number;
  /** Days with at least one decision. */
  activeDays: number;
  /** Days that reached the goal (the streak-eligible days). */
  goalDays: number;
  /** Best single day in the window. */
  best: number;
  /** Goal-line height, 0..1 (0 when there is no positive goal). */
  goalLine: number;
}

/**
 * Derive the chart from per-day decision counts. `dayKeys` is the
 * calendar sequence to plot, oldest FIRST and ending today (gaps count
 * as zero, exactly like `goalStreaks`).
 */
export function activityWindow(
  reviewedByDay: ReadonlyMap<string, number>,
  dayKeys: readonly string[],
  goal: number,
): ActivityWindow {
  const counts = dayKeys.map((day) => Math.max(0, reviewedByDay.get(day) ?? 0));
  const best = counts.reduce((max, count) => Math.max(max, count), 0);
  // The 1 keeps an all-zero window from dividing by zero; a positive
  // goal always outranks it, so the goal line stays on the plot.
  const scale = Math.max(best, goal, 1);
  const bars = dayKeys.map((day, i) => ({
    day,
    count: counts[i],
    height: counts[i] / scale,
    goalReached: goal > 0 && counts[i] >= goal,
    isToday: i === dayKeys.length - 1,
  }));
  return {
    bars,
    total: counts.reduce((sum, count) => sum + count, 0),
    activeDays: counts.filter((count) => count > 0).length,
    goalDays: bars.filter((bar) => bar.goalReached).length,
    best,
    goalLine: goal > 0 ? Math.min(1, goal / scale) : 0,
  };
}

export interface IntakePair {
  day: string;
  captured: number;
  reviewed: number;
  /** Shares of the plot height, 0..1. */
  capturedHeight: number;
  reviewedHeight: number;
}

export interface IntakeWindow {
  pairs: IntakePair[];
  captured: number;
  reviewed: number;
  /** reviewed − captured over the window: positive is catching up. */
  net: number;
}

/**
 * "Am I keeping up?" as two series on ONE scale.
 *
 * Both sides share a single divisor deliberately: separate scales would
 * make a day of 3 captures and 3 decisions look like a day of 300 and 3,
 * which is the exact comparison the chart exists to make.
 *
 * `capturedByDay` is capture-day keyed, `reviewedByDay` is decision-day
 * keyed — they are different questions about the same days, which is why
 * the net figure is a WINDOW total rather than a per-day difference: no
 * individual day's decisions are about that day's photos.
 */
export function intakeWindow(
  capturedByDay: ReadonlyMap<string, number>,
  reviewedByDay: ReadonlyMap<string, number>,
  dayKeys: readonly string[],
): IntakeWindow {
  const captured = dayKeys.map((day) => Math.max(0, capturedByDay.get(day) ?? 0));
  const reviewed = dayKeys.map((day) => Math.max(0, reviewedByDay.get(day) ?? 0));
  const scale = Math.max(1, ...captured, ...reviewed);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    pairs: dayKeys.map((day, i) => ({
      day,
      captured: captured[i],
      reviewed: reviewed[i],
      capturedHeight: captured[i] / scale,
      reviewedHeight: reviewed[i] / scale,
    })),
    captured: sum(captured),
    reviewed: sum(reviewed),
    net: sum(reviewed) - sum(captured),
  };
}
