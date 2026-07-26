/**
 * The presentational daily goal (m0.8 gate 4, decision 4): drives the
 * Home goal ring, celebrations, and streaks — it gates NOTHING. A streak
 * day is a day whose reviewed count reached the goal (evaluated against
 * the CURRENT goal — retroactive goal changes deliberately re-color
 * history rather than freezing per-day goals, which would need a goal
 * journal nobody asked for).
 *
 * Pure logic; the settings row follows the parse-with-fallback pattern.
 */

export const DAILY_GOAL_KEY = 'daily_goal';

/** Selectable goals (Settings chips). */
export const DAILY_GOAL_CHOICES = [25, 50, 100, 200, 500] as const;

export const DEFAULT_DAILY_GOAL = 50;

export function parseDailyGoal(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw);
  return (DAILY_GOAL_CHOICES as readonly number[]).includes(value) ? value : DEFAULT_DAILY_GOAL;
}

export function serializeDailyGoal(goal: number): string {
  return String(goal);
}

/** Ring progress in [0, 1]; a reached goal clamps at 1. */
export function goalProgress(reviewedToday: number, goal: number): number {
  if (goal <= 0) return 1;
  return Math.min(1, Math.max(0, reviewedToday / goal));
}

export interface GoalStreaks {
  /** Consecutive goal-reached days ending today (or yesterday, when
   * today's goal is not yet reached — an in-progress day never breaks
   * the streak it is about to extend). */
  current: number;
  longest: number;
}

/**
 * Streaks over per-day reviewed counts. `days` maps "YYYY-MM-DD" → count;
 * `dayKeys` must be the calendar sequence ending at today (newest LAST),
 * e.g. from dates.recentDayKeys reversed — gaps count as zero.
 */
export function goalStreaks(
  days: ReadonlyMap<string, number>,
  dayKeys: readonly string[],
  goal: number,
): GoalStreaks {
  let longest = 0;
  let run = 0;
  for (const key of dayKeys) {
    if ((days.get(key) ?? 0) >= goal) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // Current streak counts back from today; an unfinished today defers to
  // yesterday's streak.
  let current = 0;
  for (let i = dayKeys.length - 1; i >= 0; i--) {
    const reached = (days.get(dayKeys[i]) ?? 0) >= goal;
    if (i === dayKeys.length - 1 && !reached) continue; // today in progress
    if (reached) current += 1;
    else break;
  }
  return { current, longest };
}
