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

/** The one-tap goals (Settings chips); any other whole number in
 * [MIN, MAX] is reachable through the Custom chip. */
export const DAILY_GOAL_CHOICES = [25, 50, 100] as const;

export const DEFAULT_DAILY_GOAL = 50;

/** A goal of 0 would make the ring meaningless; the ceiling is simply
 * more photos than a phone plausibly holds. */
export const MIN_DAILY_GOAL = 1;
export const MAX_DAILY_GOAL = 100_000;

export function parseDailyGoal(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw);
  return isValidDailyGoal(value) ? value : DEFAULT_DAILY_GOAL;
}

export function isValidDailyGoal(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_DAILY_GOAL && value <= MAX_DAILY_GOAL;
}

/**
 * A typed custom goal, or an error naming what to fix. Whole numbers
 * only: half a photo is not a decision.
 */
export function parseCustomDailyGoal(text: string): { goal: number } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: 'Enter a number of photos.' };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value))
    return { error: 'Whole numbers only, e.g. 75.' };
  if (!isValidDailyGoal(value))
    return { error: `Pick between ${MIN_DAILY_GOAL} and ${MAX_DAILY_GOAL.toLocaleString()}.` };
  return { goal: value };
}

export function serializeDailyGoal(goal: number): string {
  return String(goal);
}

/** Ring progress in [0, 1]; a reached goal clamps at 1. */
export function goalProgress(reviewedToday: number, goal: number): number {
  if (goal <= 0) return 1;
  return Math.min(1, Math.max(0, reviewedToday / goal));
}

/** One clipped half of the ring's border-drawn arc (GoalRing). */
export interface RingArc {
  /** Degrees of this half filled, 0..180. */
  sweep: number;
  /** Rotation (deg, clockwise) for the border-semicircle View. */
  rotation: number;
}

/**
 * Arc geometry for the two-half border ring. Angles are measured
 * clockwise from 12 o'clock. A View with borderTop+borderRight colored
 * shows a semicircle spanning [rotation − 45°, rotation + 135°]; each
 * half-clip anchors that block's END at its sweep angle so the visible
 * part is exactly [0, sweep] on the right (clip [0°, 180°]) and
 * [180°, 180° + sweep] on the left (clip [180°, 360°]) — the fill grows
 * clockwise from 12 and a reached goal closes the circle.
 */
export function ringArcs(progress: number): { right: RingArc; left: RingArc } {
  const clamped = Math.min(1, Math.max(0, progress));
  const rightSweep = Math.min(clamped, 0.5) * 360;
  const leftSweep = Math.max(0, clamped - 0.5) * 360;
  return {
    right: { sweep: rightSweep, rotation: rightSweep - 135 },
    left: { sweep: leftSweep, rotation: 45 + leftSweep },
  };
}

/** The angular range [from, to] (deg clockwise from 12) a border
 * semicircle at `rotation` actually shows inside one half-clip — the
 * testable ground truth for ringArcs (from == to means nothing shows). */
export function visibleArcRange(
  rotation: number,
  clip: 'right' | 'left',
): { from: number; to: number } {
  const [clipFrom, clipTo] = clip === 'right' ? [0, 180] : [180, 360];
  // Normalize the colored block [rotation − 45, rotation + 135] onto the
  // clip window (the block is 180° wide, so one contiguous overlap).
  let from = rotation - 45;
  let to = rotation + 135;
  while (to < clipFrom) {
    from += 360;
    to += 360;
  }
  while (from > clipTo) {
    from -= 360;
    to -= 360;
  }
  const overlapFrom = Math.max(from, clipFrom);
  const overlapTo = Math.min(to, clipTo);
  return overlapTo > overlapFrom ? { from: overlapFrom, to: overlapTo } : { from: 0, to: 0 };
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

// ------------------------------------------------------------------
// In-deck goal celebration (m0.8.2, F14)

/** Settings key: what has already been celebrated — the local day plus
 * the goal it was reached at, so the moment fires once per day and again
 * for a goal you deliberately raised (m0.8.5, F5). */
export const GOAL_CELEBRATED_KEY = 'goal_celebrated_day';

/** The day already celebrated, and the highest goal celebrated on it. */
export interface CelebratedGoal {
  day: string;
  goal: number;
}

/**
 * ONE settings row, not two: a day and a value written separately can
 * tear, leaving a day marked at no value — which would either
 * re-celebrate every crossing or suppress them all, depending on which
 * write survived.
 *
 * The stored shape is "YYYY-MM-DD:GOAL".
 */
export function serializeCelebratedGoal(celebrated: CelebratedGoal): string {
  return `${celebrated.day}:${celebrated.goal}`;
}

/**
 * Parse-with-fallback, like every other setting here. Anything
 * unreadable means "nothing celebrated", which can only ever cost one
 * extra moment — the honest failure direction, since the alternative is
 * silently swallowing a goal the user did reach.
 */
export function parseCelebratedGoal(raw: string | null): CelebratedGoal | null {
  if (raw === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const goal = Number(match[2]);
  return isValidDailyGoal(goal) ? { day: match[1], goal } : null;
}

/**
 * Fire exactly at the CROSSING — the decision that takes today's count
 * from below the goal to at or past it.
 *
 * Once per day, and again when the goal is RAISED above the one already
 * celebrated (F5): raising the goal past today's count drops today from
 * the streak, so reaching the new number is a real achievement and gets
 * its moment. There is no cap, because nothing in the app counts
 * celebrations — every goal figure (`goalDays`, both streaks) is derived
 * per day from reviewed counts, so repeated crossings cannot inflate any
 * statistic, and each one still costs the work of reaching a higher
 * number.
 *
 * Lowering the goal never re-arms: `celebrated.goal` only ever holds the
 * HIGHEST value celebrated today. Neither does raising it to a number
 * today's count has already passed — `before < goal` fails — which keeps
 * m0.8.2's rule that sailing past an already-reached goal was never a
 * moment.
 */
export function shouldCelebrateGoal(args: {
  before: number;
  after: number;
  goal: number;
  celebrated: CelebratedGoal | null;
  today: string;
}): boolean {
  if (args.goal <= 0) return false;
  if (args.before >= args.goal || args.after < args.goal) return false;
  const { celebrated } = args;
  return celebrated === null || celebrated.day !== args.today || args.goal > celebrated.goal;
}
