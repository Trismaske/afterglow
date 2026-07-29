/**
 * The forecast (m0.8.2) — the app's only forward-looking math, and the
 * one place allowed to say when the backlog ends.
 *
 * Pure logic over numbers the app already stores: per-day decision counts
 * (the goal ring's source), per-capture-day totals (the coverage goal's
 * source), the corpus breakdown, and a bounded list of decision stamps.
 * Nothing here is ML, nothing here is a heuristic over pixels — it is
 * arithmetic that refuses to answer when the arithmetic would lie.
 *
 * THE REFUSALS ARE THE DESIGN (decisions D1, D10, and the 200-decision
 * floor). Three of the four finish-line states decline to print a date:
 *
 * - nothing left            -> "all caught up", no projection at all
 * - too little history      -> no numbers, because a pace from four days
 *                              of use predicts nothing
 * - intake >= review pace   -> NO DATE EVER. A date computed from a pace
 *                              that never closes the gap is a knowingly
 *                              wrong number; the honest output is the
 *                              growth rate and the pace that breaks even.
 *
 * Only the fourth state — actually finishing — gets a date, and even then
 * its PRECISION degrades with distance (§ etaPrecision): an exact day for
 * a 400-day projection claims certainty the inputs cannot support.
 *
 * DIRECTION OF THE SAMPLE. Review runs newest->oldest, so the photos
 * decided most recently are the OLDEST ones reached: they sit adjacent to
 * the frontier and the remaining pool lies just beyond them. Base rates
 * from decision history are therefore the best available proxy for what
 * is left, not a biased one (imperfect only because day rows and Groups
 * allow out-of-order review).
 */

/** Days of completed history the pace and intake means cover. */
export const PACE_WINDOW_DAYS = 30;

/** Lifetime decisions before any projection is shown at all. */
export const MIN_DECISIONS_FOR_FORECAST = 200;

/** Consecutive-delta count below which per-photo time stays hidden. */
export const MIN_DELTAS_FOR_TIMING = 50;

/** Split-half medians must agree within this fraction (D10). */
export const TIMING_STABILITY_TOLERANCE = 0.25;

/**
 * SITTING BOUNDARY (Tristan, 2026-07-28). A pause ends a sitting when it
 * exceeds `clamp(K x median(all deltas), floor, ceiling)`.
 *
 * The design rests on one observation: a BREAK and a THINKING GAP scale
 * differently. A break is an absolute human event — phone down, message,
 * coffee — and five minutes is five minutes however fast you review. A
 * thinking gap DOES scale with how carefully you review: agonising over
 * a group, flipping between duels without committing, writes no
 * `decided_at` at all and surfaces as one long gap.
 *
 * So the three parameters have distinct jobs:
 * - K clears the longest plausible THINKING gap, which scales per user;
 * - the ceiling is the shortest gap that unambiguously means "stopped",
 *   which does NOT scale, so it is an absolute number;
 * - the floor is insurance at the fast end.
 *
 * Where each one takes over, given K = 40:
 *
 * ```
 * median delta   threshold          governed by
 * < 1.5 s        60 s               floor    (insurance; rare)
 * 1.5 - 7.5 s    40 x median        K
 * > 7.5 s        300 s              ceiling
 * ```
 *
 * K = 40 puts a typical 5 s reviewer at a 200 s threshold, so an
 * agonising round has to run past 3 1/3 minutes with NO decision before
 * it splits a sitting. K = 15 (the first guess) put the floor's crossover
 * at a 4 s median — above the middle of the distribution — so the floor
 * governed almost everyone and the self-tuning never engaged.
 *
 * The ceiling is deliberately tight, because the two failure directions
 * are NOT symmetric. Clamping too low fragments sittings and nudges
 * `timePerPhoto`, which is a median of individual deltas and barely
 * moves. Clamping too high lets a real break be ABSORBED, and
 * `summariseSittings` reports duration as a SUM — so the whole break
 * lands in the figure ("37 photos over 3 hours" for three minutes of
 * tapping either side of lunch). The ceiling IS the bound on how much
 * dead time one absorbed gap can inject.
 *
 * The slow tail cannot be served multiplicatively at any honest ceiling:
 * reaching a 45 s median at K = 40 would need a 30-minute ceiling, which
 * would absorb a 25-minute break. A flat five minutes is the right answer
 * for them, not a limitation.
 *
 * Still assumed: the real distribution of per-user median deltas
 * (docs/TODO.md). Everything above is arithmetic over that one input.
 */
export const SITTING_GAP_MULTIPLE = 40;

/** Insurance at the fast end. With a 3 s fast tail this never binds; it
 * exists for a burst of obvious culls at ~1 s each, where the multiple
 * alone would split a sitting on one pause to look properly. */
export const SITTING_GAP_FLOOR_MS = 60_000;

/** The shortest gap that unambiguously means "stopped", for anyone. Even
 * at a 60 s median it is five missed decisions. */
export const SITTING_GAP_CEILING_MS = 300_000;

/** Per-day counts keyed "YYYY-MM-DD" (decision days or capture days). */
export type DayCounts = ReadonlyMap<string, number>;

// --------------------------------------------------------------- pace

/**
 * Mean decisions per day over the COMPLETED days of the window.
 *
 * Today is excluded deliberately: a partial day drags the mean down every
 * morning and would make the projected date drift with the clock. Zero
 * days are included — they are the honest denominator of "when will this
 * be done", where rest days count.
 *
 * `dayKeys` is the calendar sequence oldest FIRST, ending TODAY (the same
 * shape goalStreaks takes). `firstDecisionDay` shortens the denominator
 * for a new user, so four days of use is not divided by thirty.
 */
export function reviewPace(
  reviewedByDay: DayCounts,
  dayKeys: readonly string[],
  firstDecisionDay: string | null,
): number {
  const completed = dayKeys.slice(0, -1).slice(-PACE_WINDOW_DAYS);
  if (completed.length === 0) return 0;
  const counted =
    firstDecisionDay === null ? completed : completed.filter((day) => day >= firstDecisionDay);
  if (counted.length === 0) return 0;
  const total = counted.reduce((sum, day) => sum + Math.max(0, reviewedByDay.get(day) ?? 0), 0);
  return total / counted.length;
}

/**
 * Mean photos CAPTURED per day over the same completed days.
 *
 * The undated bucket is excluded by construction: `capturedByDay` is keyed
 * by capture day, and a photo with no date has no key, which is correct —
 * an undated photo is an old import, not today's shooting.
 *
 * Known understatement, deliberately uncorrected: the source query counts
 * photos still present, so recent photos already culled to trash no longer
 * count as intake. Correcting it means reading trashed rows' capture days
 * for a second-order effect.
 */
export function intakeRate(capturedByDay: DayCounts, dayKeys: readonly string[]): number {
  const completed = dayKeys.slice(0, -1).slice(-PACE_WINDOW_DAYS);
  if (completed.length === 0) return 0;
  const total = completed.reduce((sum, day) => sum + Math.max(0, capturedByDay.get(day) ?? 0), 0);
  return total / completed.length;
}

// ----------------------------------------------------------- the states

export type FinishLine =
  | { kind: 'caught_up' }
  | { kind: 'insufficient_history'; decisions: number }
  /** Intake outruns reviewing: no date exists, so none is printed (D1). */
  | {
      kind: 'growing';
      remaining: number;
      pace: number;
      intake: number;
      /** Photos per day the backlog grows by (intake − pace). */
      growth: number;
      /** The pace that would hold the line. */
      breakEven: number;
      /** Days to clear at the daily goal, or null when even the goal
       * cannot out-run intake. */
      goalDays: number | null;
    }
  | {
      kind: 'finishing';
      remaining: number;
      pace: number;
      intake: number;
      /** Net burn-down: pace − intake. */
      net: number;
      days: number;
      /** Days to clear at the daily goal instead of the actual pace. */
      goalDays: number | null;
    };

export interface FinishLineInput {
  /** Photos still needing review (progress.remainingReviewable). */
  remaining: number;
  reviewedByDay: DayCounts;
  capturedByDay: DayCounts;
  /** Oldest FIRST, ending today. */
  dayKeys: readonly string[];
  /** Lifetime decisions — the floor that gates every projection. */
  decisions: number;
  firstDecisionDay: string | null;
  /** The presentational daily goal, for the second line. */
  goal: number;
}

/**
 * The finish line, in strict evaluation order. The order matters: being
 * caught up outranks having no history, and having no history outranks
 * every arithmetic answer.
 */
export function finishLine(input: FinishLineInput): FinishLine {
  const { remaining, reviewedByDay, capturedByDay, dayKeys, decisions, goal } = input;
  if (remaining <= 0) return { kind: 'caught_up' };
  if (decisions < MIN_DECISIONS_FOR_FORECAST) return { kind: 'insufficient_history', decisions };

  const pace = reviewPace(reviewedByDay, dayKeys, input.firstDecisionDay);
  if (pace <= 0) return { kind: 'insufficient_history', decisions };

  const intake = intakeRate(capturedByDay, dayKeys);
  const net = pace - intake;
  // The goal only helps if it out-runs intake too — otherwise "hit your
  // goal and you're done" would be the same lie in a different hat.
  const goalNet = goal - intake;
  const goalDays = goalNet > 0 ? Math.ceil(remaining / goalNet) : null;

  if (net <= 0) {
    return {
      kind: 'growing',
      remaining,
      pace,
      intake,
      growth: intake - pace,
      breakEven: intake,
      goalDays,
    };
  }
  return {
    kind: 'finishing',
    remaining,
    pace,
    intake,
    net,
    days: Math.ceil(remaining / net),
    goalDays,
  };
}

// ------------------------------------------------------- precision ladder

/** How precisely a projected date may be stated (see etaPrecision). */
export type EtaPrecision = 'days' | 'date' | 'month' | 'beyond';

/**
 * Precision degrades with distance. Printing "19 Sep 2026" for a 400-day
 * projection claims a certainty the inputs cannot support — the pace it
 * rests on is a 30-day mean that will have moved long before then.
 */
export function etaPrecision(days: number): EtaPrecision {
  if (days <= 14) return 'days';
  if (days <= 90) return 'date';
  if (days <= 730) return 'month';
  return 'beyond';
}

// ------------------------------------------------------------ sittings

export interface Sitting {
  /** Consecutive deltas (ms) inside one sitting; length = photos − 1, so
   * an EMPTY array is a one-photo sitting (a decision isolated between
   * two breaks), not an absent one. */
  deltas: number[];
}

/**
 * Split consecutive decision deltas into sittings at self-tuned breaks.
 *
 * `deltas` must be in chronological order. The threshold reads the median
 * of EVERY delta first: breaks are rare relative to in-sitting decisions,
 * so they live in the tail and cannot move the middle — which is exactly
 * why a self-tuned boundary is safe here.
 *
 * Every break-delimited segment IS a sitting, empty deltas included: n
 * breaks always yield n + 1 sittings, and a decision isolated between two
 * breaks is a one-photo sitting (photos = deltas + 1). Dropping those
 * segments (as this once did) made a history of all-isolated decisions
 * yield ZERO sittings and biased the count and median-photos figures
 * upward. Consumers that need only INTERNAL deltas — the timing estimate
 * flattens `deltas` — are unaffected by construction: a one-photo sitting
 * contributes nothing to flatten.
 */
export function splitSittings(deltas: readonly number[]): Sitting[] {
  if (deltas.length === 0) return [];
  const threshold = sittingGapThreshold(deltas);
  const sittings: Sitting[] = [{ deltas: [] }];
  for (const delta of deltas) {
    if (delta > threshold) {
      sittings.push({ deltas: [] });
      continue;
    }
    sittings[sittings.length - 1].deltas.push(delta);
  }
  return sittings;
}

/** The self-tuned break threshold in ms, clamped at both ends. */
export function sittingGapThreshold(deltas: readonly number[]): number {
  const tuned = median(deltas) * SITTING_GAP_MULTIPLE;
  return Math.min(SITTING_GAP_CEILING_MS, Math.max(SITTING_GAP_FLOOR_MS, tuned));
}

/** Consecutive gaps (ms) between decision stamps, chronological. */
export function decisionDeltas(stampsNewestFirst: readonly number[]): number[] {
  const chronological = [...stampsNewestFirst].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < chronological.length; i += 1) {
    deltas.push(chronological[i] - chronological[i - 1]);
  }
  return deltas;
}

// ------------------------------------------------------------- timing

export type TimePerPhoto =
  { kind: 'unknown'; reason: 'too_few' | 'unstable' } | { kind: 'known'; msPerPhoto: number };

/**
 * Median milliseconds per decision, or an explicit refusal.
 *
 * The visibility gate (D10) tests the estimate AGAINST ITSELF: split the
 * deltas into an older and a newer half and require their medians to agree
 * within TIMING_STABILITY_TOLERANCE. That gates on reproducibility rather
 * than on a guessed sample size — a steady reviewer qualifies quickly, an
 * erratic one only once the number means something.
 *
 * Only in-sitting deltas count; between-sitting gaps are the overnight
 * breaks the sitting split exists to remove.
 */
export function timePerPhoto(deltas: readonly number[]): TimePerPhoto {
  const inSitting = splitSittings(deltas).flatMap((sitting) => sitting.deltas);
  if (inSitting.length < MIN_DELTAS_FOR_TIMING) return { kind: 'unknown', reason: 'too_few' };
  const half = Math.floor(inSitting.length / 2);
  const older = median(inSitting.slice(0, half));
  const newer = median(inSitting.slice(half));
  const larger = Math.max(older, newer);
  if (larger <= 0) return { kind: 'unknown', reason: 'unstable' };
  if (Math.abs(older - newer) / larger > TIMING_STABILITY_TOLERANCE)
    return { kind: 'unknown', reason: 'unstable' };
  return { kind: 'known', msPerPhoto: median(inSitting) };
}

/** Milliseconds of tapping left, or null while the rate is unknown. */
export function timeRemainingMs(time: TimePerPhoto, remaining: number): number | null {
  if (time.kind !== 'known' || remaining <= 0) return null;
  return time.msPerPhoto * remaining;
}

// -------------------------------------------------------- projections

/** One projected outcome over the remaining pool, as a range (D3). */
export interface ProjectedRange {
  low: number;
  high: number;
}

export interface OutcomeChunk {
  /** Decisions in this chunk. */
  total: number;
  culled: number;
  toEdit: number;
  favourited: number;
  shared: number;
  organized: number;
}

export type OutcomeKind = 'culled' | 'toEdit' | 'favourited' | 'shared' | 'organized';

export interface Projections {
  culled: ProjectedRange;
  toEdit: ProjectedRange;
  favourited: ProjectedRange;
  shared: ProjectedRange;
  organized: ProjectedRange;
  /** Bytes the projected culls would free, as a range. */
  reclaimableBytes: ProjectedRange;
}

/**
 * Project each outcome onto the remaining pool from per-chunk base rates.
 *
 * The chunks ARE the uncertainty (D12): rather than hiding the projection
 * when habits drift, the spread between the most and least aggressive
 * chunk becomes the rendered range. Consistent culling gives a tight
 * range; changed standards give a wide one, which is the truth.
 *
 * `chunks` must be equal-sized slices of the decision history in decision
 * order. `meanRemainingBytes` is the mean size of photos still to review —
 * the pool whose bytes actually get freed, not the ones already culled.
 */
export function projectOutcomes(
  chunks: readonly OutcomeChunk[],
  remaining: number,
  meanRemainingBytes: number,
): Projections | null {
  const usable = chunks.filter((chunk) => chunk.total > 0);
  if (usable.length === 0 || remaining <= 0) return null;
  const culled = rangeFor(usable, 'culled', remaining);
  return {
    culled,
    toEdit: rangeFor(usable, 'toEdit', remaining),
    favourited: rangeFor(usable, 'favourited', remaining),
    shared: rangeFor(usable, 'shared', remaining),
    organized: rangeFor(usable, 'organized', remaining),
    reclaimableBytes: {
      low: Math.round(culled.low * meanRemainingBytes),
      high: Math.round(culled.high * meanRemainingBytes),
    },
  };
}

function rangeFor(
  chunks: readonly OutcomeChunk[],
  kind: OutcomeKind,
  remaining: number,
): ProjectedRange {
  const rates = chunks.map((chunk) => chunk[kind] / chunk.total);
  return {
    low: Math.round(Math.min(...rates) * remaining),
    high: Math.round(Math.max(...rates) * remaining),
  };
}

// ------------------------------------------------------- the whole view

/** Everything a forecast surface renders, from one composition. */
export interface ForecastView {
  finish: FinishLine;
  time: TimePerPhoto;
  /** Milliseconds of tapping left, or null while the rate is unknown. */
  timeLeftMs: number | null;
  /** Null below the decision floor, or with nothing left to review. */
  projections: Projections | null;
}

export interface ForecastViewInput extends FinishLineInput {
  /** Decision stamps newest first (store read order). */
  stamps: readonly number[];
  /** Equal slices of the decision history, in decision order. */
  chunks: readonly OutcomeChunk[];
  /** Mean size of photos still to review. */
  meanRemainingBytes: number;
}

/**
 * Compose every forecast number in one place.
 *
 * Home and the Stats Forecast tab both render this; composing here is
 * what stops the two from drifting into different answers to the same
 * question. The projection floor is the SAME decision count the finish
 * line refuses below — a page that declines to give a date while
 * confidently projecting 1,200 culls would be talking out of both sides
 * of its mouth.
 */
export function composeForecast(input: ForecastViewInput): ForecastView {
  const finish = finishLine(input);
  const time = timePerPhoto(decisionDeltas(input.stamps));
  const projectable = finish.kind === 'finishing' || finish.kind === 'growing';
  return {
    finish,
    time,
    timeLeftMs: timeRemainingMs(time, input.remaining),
    projections: projectable
      ? projectOutcomes(input.chunks, input.remaining, input.meanRemainingBytes)
      : null,
  };
}

// -------------------------------------------------------------- shared

/** Median of the values (mean of the middle two when even). Empty = 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
