/**
 * Habits (m0.8.2, pure) — the shape of how you review, as opposed to how
 * much is left (that is `forecast.ts`).
 *
 * Everything here is descriptive: it reports what already happened and
 * never predicts. That distinction is why the refusal rules differ — the
 * forecast declines to print a number it cannot stand behind, whereas a
 * habit stat with a thin sample is simply a thin sample, and says so.
 *
 * Two things it still refuses to do:
 * - report a queue COMPLETION RATE at all (m0.8.2). The queues are
 *   designed to drain — review, then clear each queue, often the same
 *   day — so `finished/(waiting+finished)` converges on 100% for every
 *   user reviewing normally, and the only way to score badly is to be
 *   mid-session. A number that reads the same for everyone in every
 *   healthy state is decoration. What varies, and what a badge count
 *   cannot carry, is how long work SITS: the typical turnaround, and
 *   whether anything is sitting longer than your own typical.
 * - describe a rhythm from a handful of decisions, where the "peak hour"
 *   is just the hour you happened to open the app.
 */
import { longestGoalRun } from './dailyGoal';
import { median } from './forecast';
import { dayKey } from './dates';

/** Decisions before the rhythm grid claims to show a pattern. */
export const MIN_DECISIONS_FOR_RHYTHM = 100;

/** Completed actions before a queue reports a typical turnaround. */
export const MIN_FINISHED_FOR_TURNAROUND = 5;

/** Days in the rolling window the decisiveness trend compares. */
export const DECISIVENESS_WINDOW_DAYS = 30;

export interface RhythmInput {
  weekday: number;
  hour: number;
  count: number;
}

export interface RhythmGrid {
  /** 7 rows (Sun..Sat) × 24 columns, counts. Always fully populated. */
  cells: number[][];
  /** Busiest cell's count — the normaliser for the heat scale. */
  peak: number;
  total: number;
  /** The busiest cell, or null when there is not enough to have one. */
  peakCell: { weekday: number; hour: number } | null;
}

/**
 * Fill the 7×24 grid. Sparse input on purpose: a user who never reviews
 * at 4am has no row for it, and rendering that as a gap rather than a
 * zero would make the grid's shape depend on the query's shape.
 */
export function rhythmGrid(cells: readonly RhythmInput[]): RhythmGrid {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  let peak = 0;
  let peakCell: { weekday: number; hour: number } | null = null;
  for (const cell of cells) {
    if (cell.weekday < 0 || cell.weekday > 6 || cell.hour < 0 || cell.hour > 23) continue;
    const count = Math.max(0, cell.count);
    grid[cell.weekday][cell.hour] += count;
    total += count;
  }
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      if (grid[weekday][hour] > peak) {
        peak = grid[weekday][hour];
        peakCell = { weekday, hour };
      }
    }
  }
  return {
    cells: grid,
    peak,
    total,
    // Below the floor the "peak" is the hour you happened to open the app.
    peakCell: total >= MIN_DECISIONS_FOR_RHYTHM ? peakCell : null,
  };
}

export interface SittingSummary {
  /** Sittings found in the sampled stamps. */
  count: number;
  /** Median photos decided per sitting. */
  medianPhotos: number;
  /** Median wall-clock length of a sitting, in ms. */
  medianDurationMs: number;
}

/**
 * Sittings over the sampled decision stamps, using the SAME self-tuned
 * boundary the time estimate uses (`forecast.splitSittings`) so the two
 * stats can never describe different sittings.
 *
 * A sitting's photo count is its delta count + 1: n gaps join n+1
 * decisions. Its duration is the sum of its gaps — the time between its
 * first and last decision, which is all the stamps can support.
 */
export function summariseSittings(sittings: readonly { deltas: number[] }[]): SittingSummary {
  if (sittings.length === 0) return { count: 0, medianPhotos: 0, medianDurationMs: 0 };
  return {
    count: sittings.length,
    medianPhotos: Math.round(median(sittings.map((sitting) => sitting.deltas.length + 1))),
    medianDurationMs: Math.round(
      median(sittings.map((sitting) => sitting.deltas.reduce((sum, delta) => sum + delta, 0))),
    ),
  };
}

export interface TurnaroundInput {
  waiting: number;
  finished: number;
  /** When the oldest still-waiting item was queued (null = empty queue). */
  oldestWaitingAt: number | null;
  gaps: readonly number[];
}

export type Turnaround =
  /** Nothing has ever been completed in this queue — no rate exists. */
  | { kind: 'no_history'; waiting: number }
  | { kind: 'thin'; waiting: number; finished: number }
  | {
      kind: 'known';
      waiting: number;
      finished: number;
      medianMs: number;
      /** How long the oldest waiting item has waited — set ONLY when that
       * exceeds `medianMs`, i.e. when it is unusual FOR YOU. A queue you
       * deliberately batch for a week stays quiet; a stalled one speaks
       * up. No fixed "N days is bad" threshold exists, because your own
       * normal is the threshold. */
      stalledMs: number | null;
    };

/**
 * How a queue behaves: how long finishing usually takes, and whether
 * anything has been waiting longer than that.
 *
 * `at` is injected rather than read, so the stalled test is a pure
 * function of its inputs.
 */
export function queueTurnaround(input: TurnaroundInput, at: number): Turnaround {
  const { waiting, finished, oldestWaitingAt } = input;
  if (finished === 0) return { kind: 'no_history', waiting };
  if (finished < MIN_FINISHED_FOR_TURNAROUND || input.gaps.length === 0)
    return { kind: 'thin', waiting, finished };
  const medianMs = Math.round(median(input.gaps));
  const waitedMs = oldestWaitingAt === null ? null : Math.max(0, at - oldestWaitingAt);
  return {
    kind: 'known',
    waiting,
    finished,
    medianMs,
    stalledMs: waitedMs !== null && waitedMs > medianMs ? waitedMs : null,
  };
}

export type Decisiveness =
  | { kind: 'unknown' }
  | {
      kind: 'known';
      /** Cull rate over the rolling window. */
      recent: number;
      /** Cull rate over every decision ever made. */
      lifetime: number;
      /** Positive = culling harder lately. */
      delta: number;
      recentDecisions: number;
    };

/**
 * Rolling cull rate against the all-time one.
 *
 * Both rates come from the same definition of "culled" (staged or
 * trashed), so the comparison is of one habit with itself over time
 * rather than of two differently-counted numbers.
 */
export function decisiveness(
  recent: { decided: number; culled: number },
  lifetime: { decided: number; culled: number },
): Decisiveness {
  if (recent.decided === 0 || lifetime.decided === 0) return { kind: 'unknown' };
  const recentRate = recent.culled / recent.decided;
  const lifetimeRate = lifetime.culled / lifetime.decided;
  return {
    kind: 'known',
    recent: recentRate,
    lifetime: lifetimeRate,
    delta: recentRate - lifetimeRate,
    recentDecisions: recent.decided,
  };
}

export interface Milestone {
  label: string;
  value: number;
  /** The next round number above `value`, or null once past the largest. */
  next: number | null;
}

/** Round numbers a milestone counts up to. */
const STEPS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];

/** The next round number strictly above `value`, or null past the top. */
export function nextMilestone(value: number): number | null {
  return STEPS.find((step) => step > value) ?? null;
}

export function milestone(label: string, value: number): Milestone {
  return { label, value, next: nextMilestone(value) };
}

// ------------------------------------------------------------------
// Personal records (m0.8.2, F13)

export interface PersonalRecords {
  /** All-time longest run of consecutive goal-reached days. */
  longestStreak: number;
  /** The single day with the most decisions; ties go to the most
   * recent day (the newer achievement is the memorable one). */
  bestDay: { day: string; count: number } | null;
}

/**
 * All-time bests over the FIRST-decision-day counts (gap 8: the map
 * reads decided_first_at, so a re-decide can no longer erode a
 * historical best or fire "new personal best" because history shrank).
 * The streak IS goalStreaks' longest (gap 9: longestGoalRun, one
 * definition) — Home and this record can never disagree. Records only:
 * there is deliberately NO days-since-goal guilt counter.
 */
export function personalRecords(
  reviewedByDay: ReadonlyMap<string, number>,
  goal: number,
): PersonalRecords {
  let bestDay: { day: string; count: number } | null = null;
  for (const [day, count] of reviewedByDay) {
    if (count <= 0) continue;
    if (!bestDay || count > bestDay.count || (count === bestDay.count && day > bestDay.day)) {
      bestDay = { day, count };
    }
  }
  return { longestStreak: longestGoalRun(reviewedByDay, goal), bestDay };
}
