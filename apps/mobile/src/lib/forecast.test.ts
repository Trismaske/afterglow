/**
 * Forecast math (m0.8.2): pace and intake, the four finish-line states —
 * including the three that REFUSE to print a date — the precision ladder,
 * self-tuned sittings, the split-half timing gate, and projected ranges.
 *
 * Two kinds of case here, deliberately:
 * - hand-built inputs with exact expected values, for every rule and
 *   boundary (a fixture cannot pin "exactly at ±25%");
 * - the shared 90-day fixture, for behaviour over realistic data, with
 *   expectations computed independently of the implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_DECISIONS_FOR_FORECAST,
  MIN_DELTAS_FOR_TIMING,
  PACE_WINDOW_DAYS,
  SITTING_GAP_CEILING_MS,
  SITTING_GAP_FLOOR_MS,
  SITTING_GAP_MULTIPLE,
  composeForecast,
  decisionDeltas,
  etaPrecision,
  finishLine,
  intakeRate,
  median,
  projectOutcomes,
  reviewPace,
  sittingGapThreshold,
  splitSittings,
  timePerPhoto,
  timeRemainingMs,
  type OutcomeChunk,
} from './forecast';
import { buildReviewHistory, outcomeChunks } from '../__fixtures__/reviewHistory';
import { dayKey } from './dates';

/** n calendar keys, oldest first, ending "today" — the caller's shape. */
const keys = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);

const counts = (spec: Record<string, number>): Map<string, number> => new Map(Object.entries(spec));

describe('reviewPace', () => {
  it('averages over completed days, counting zero days', () => {
    const days = keys(4); // 3 completed + today
    // 30 + 0 + 60 over three completed days = 30/day.
    const pace = reviewPace(
      counts({ '2026-01-01': 30, '2026-01-02': 0, '2026-01-03': 60, '2026-01-04': 999 }),
      days,
      null,
    );
    expect(pace).toBe(30);
  });

  it('excludes today, so a partial day cannot drag the mean', () => {
    const days = keys(3);
    const withoutToday = reviewPace(counts({ '2026-01-01': 50, '2026-01-02': 50 }), days, null);
    const withHugeToday = reviewPace(
      counts({ '2026-01-01': 50, '2026-01-02': 50, '2026-01-03': 5000 }),
      days,
      null,
    );
    expect(withoutToday).toBe(50);
    expect(withHugeToday).toBe(50);
  });

  it('shortens the denominator for a new user', () => {
    const days = keys(11); // 10 completed
    // 100 decisions, but the user only started on day 9 (2 completed days).
    const pace = reviewPace(counts({ '2026-01-09': 40, '2026-01-10': 60 }), days, '2026-01-09');
    expect(pace).toBe(50); // not 100/10 = 10
  });

  it('caps the window at PACE_WINDOW_DAYS', () => {
    const days = keys(PACE_WINDOW_DAYS + 20);
    // One decision on the very first day, far outside the window.
    expect(reviewPace(counts({ '2026-01-01': 300 }), days, null)).toBe(0);
  });

  it('is zero with no completed days', () => {
    expect(reviewPace(counts({ '2026-01-01': 10 }), ['2026-01-01'], null)).toBe(0);
  });
});

describe('intakeRate', () => {
  it('averages captures over the same completed days', () => {
    const days = keys(5); // 4 completed
    expect(intakeRate(counts({ '2026-01-01': 8, '2026-01-03': 4 }), days)).toBe(3);
  });

  it('ignores capture days with no key (undated photos)', () => {
    const days = keys(3);
    // An undated bucket simply has no calendar key to be counted under.
    expect(intakeRate(counts({ '2026-01-01': 10, '2026-01-02': 10 }), days)).toBe(10);
  });
});

describe('finishLine', () => {
  const base = {
    reviewedByDay: counts({ '2026-01-01': 100, '2026-01-02': 100 }),
    capturedByDay: counts({ '2026-01-01': 10, '2026-01-02': 10 }),
    dayKeys: keys(3),
    decisions: 5000,
    firstDecisionDay: null,
    goal: 200,
  };

  it('reports caught up before anything else', () => {
    expect(finishLine({ ...base, remaining: 0 }).kind).toBe('caught_up');
    // Even with no history at all.
    expect(finishLine({ ...base, remaining: 0, decisions: 0 }).kind).toBe('caught_up');
  });

  it('refuses to project below the decision floor', () => {
    const result = finishLine({
      ...base,
      remaining: 500,
      decisions: MIN_DECISIONS_FOR_FORECAST - 1,
    });
    expect(result).toEqual({
      kind: 'insufficient_history',
      decisions: MIN_DECISIONS_FOR_FORECAST - 1,
    });
  });

  it('refuses to project when the window holds no decisions', () => {
    const result = finishLine({
      ...base,
      remaining: 500,
      reviewedByDay: counts({}),
    });
    expect(result.kind).toBe('insufficient_history');
  });

  it('projects a date when reviewing outruns shooting', () => {
    // pace 100/day, intake 10/day -> net 90; 450 remaining -> 5 days.
    const result = finishLine({ ...base, remaining: 450 });
    expect(result).toMatchObject({ kind: 'finishing', pace: 100, intake: 10, net: 90, days: 5 });
  });

  it('gives NO date when the backlog is growing, and says by how much', () => {
    const result = finishLine({
      ...base,
      remaining: 450,
      reviewedByDay: counts({ '2026-01-01': 10, '2026-01-02': 10 }),
      capturedByDay: counts({ '2026-01-01': 40, '2026-01-02': 40 }),
    });
    expect(result).toMatchObject({
      kind: 'growing',
      pace: 10,
      intake: 40,
      growth: 30,
      breakEven: 40,
    });
    expect(result).not.toHaveProperty('days');
  });

  it('offers the goal-pace date only when the goal itself outruns intake', () => {
    const growingButGoalHelps = finishLine({
      ...base,
      remaining: 900,
      reviewedByDay: counts({ '2026-01-01': 10, '2026-01-02': 10 }),
      capturedByDay: counts({ '2026-01-01': 50, '2026-01-02': 50 }),
      goal: 200, // 200 - 50 = 150/day -> 6 days
    });
    expect(growingButGoalHelps).toMatchObject({ kind: 'growing', goalDays: 6 });

    const goalCannotKeepUp = finishLine({
      ...base,
      remaining: 900,
      reviewedByDay: counts({ '2026-01-01': 10, '2026-01-02': 10 }),
      capturedByDay: counts({ '2026-01-01': 50, '2026-01-02': 50 }),
      goal: 40, // below intake: the goal is no escape either
    });
    expect(goalCannotKeepUp).toMatchObject({ kind: 'growing', goalDays: null });
  });

  it('treats exactly break-even as growing, not as an infinite date', () => {
    const result = finishLine({
      ...base,
      remaining: 100,
      reviewedByDay: counts({ '2026-01-01': 20, '2026-01-02': 20 }),
      capturedByDay: counts({ '2026-01-01': 20, '2026-01-02': 20 }),
    });
    expect(result).toMatchObject({ kind: 'growing', growth: 0, breakEven: 20 });
  });
});

describe('etaPrecision', () => {
  it('degrades with distance, at the stated boundaries', () => {
    expect(etaPrecision(1)).toBe('days');
    expect(etaPrecision(14)).toBe('days');
    expect(etaPrecision(15)).toBe('date');
    expect(etaPrecision(90)).toBe('date');
    expect(etaPrecision(91)).toBe('month');
    expect(etaPrecision(730)).toBe('month');
    expect(etaPrecision(731)).toBe('beyond');
  });
});

describe('median', () => {
  it('takes the middle, or the mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('sittings', () => {
  it('scales with the median between the floor and the ceiling', () => {
    // The band K actually governs is 1.5-7.5 s of median delta; outside
    // it the clamps take over. Each row is one region of that table.
    // Below 1.5 s the floor holds: 1 s * 40 = 40 s.
    expect(sittingGapThreshold([1_000, 1_000, 1_000])).toBe(SITTING_GAP_FLOOR_MS);
    // A typical 5 s reviewer is squarely inside the band: 200 s, which
    // is what lets an agonising round of 3 minutes stay one sitting.
    expect(sittingGapThreshold([5_000, 5_000, 5_000])).toBe(5_000 * SITTING_GAP_MULTIPLE);
    // Above 7.5 s the ceiling holds — a slow reviewer is NOT given a
    // half-hour threshold, because five minutes with no decision means
    // stopped for anyone.
    expect(sittingGapThreshold([30_000, 30_000, 30_000])).toBe(SITTING_GAP_CEILING_MS);
  });

  it('puts the crossovers exactly where the header claims', () => {
    // The table is load-bearing: it is how the next person re-derives K
    // instead of re-guessing it. Both edges, to the millisecond.
    const floorEdge = SITTING_GAP_FLOOR_MS / SITTING_GAP_MULTIPLE; // 1.5 s
    const ceilingEdge = SITTING_GAP_CEILING_MS / SITTING_GAP_MULTIPLE; // 7.5 s
    expect(floorEdge).toBe(1_500);
    expect(ceilingEdge).toBe(7_500);
    expect(sittingGapThreshold([floorEdge - 1])).toBe(SITTING_GAP_FLOOR_MS);
    expect(sittingGapThreshold([floorEdge + 1])).toBeGreaterThan(SITTING_GAP_FLOOR_MS);
    expect(sittingGapThreshold([ceilingEdge - 1])).toBeLessThan(SITTING_GAP_CEILING_MS);
    expect(sittingGapThreshold([ceilingEdge + 1])).toBe(SITTING_GAP_CEILING_MS);
  });

  it('keeps a long THINKING gap inside its sitting, but splits a break', () => {
    // The distinction the whole design rests on. A 5 s reviewer gets a
    // 200 s threshold: a 3-minute agonise over one group stays in, a
    // 6-minute break does not.
    const think = [5_000, 5_000, 180_000, 5_000, 5_000];
    expect(splitSittings(think)).toHaveLength(1);
    const brk = [5_000, 5_000, 360_000, 5_000, 5_000];
    expect(splitSittings(brk)).toHaveLength(2);
  });

  it('splits on breaks and drops the break gaps themselves', () => {
    const deltas = [3_000, 3_000, 4 * 3_600_000, 3_000, 3_000];
    const sittings = splitSittings(deltas);
    expect(sittings).toHaveLength(2);
    expect(sittings[0].deltas).toEqual([3_000, 3_000]);
    expect(sittings[1].deltas).toEqual([3_000, 3_000]);
  });

  it('keeps two isolated decisions hours apart as two one-photo sittings', () => {
    // One break delta joins two decisions: photos = deltas + 1 per
    // segment, so each side is a sitting of one photo — not zero
    // sittings, which is what filtering empty segments used to yield.
    const sittings = splitSittings([4 * 3_600_000]);
    expect(sittings).toHaveLength(2);
    expect(sittings[0].deltas).toEqual([]);
    expect(sittings[1].deltas).toEqual([]);
  });

  it('retains a final isolated decision after a run', () => {
    const sittings = splitSittings([3_000, 3_000, 4 * 3_600_000]);
    expect(sittings).toHaveLength(2);
    expect(sittings[0].deltas).toEqual([3_000, 3_000]);
    expect(sittings[1].deltas).toEqual([]);
  });

  it('yields n + 1 one-photo sittings from n all-break deltas', () => {
    // A history of nothing but isolated decisions is still a history of
    // sittings — hiding it biased the count and median upward.
    const sittings = splitSittings([4 * 3_600_000, 4 * 3_600_000]);
    expect(sittings).toHaveLength(3);
    expect(sittings.every((sitting) => sitting.deltas.length === 0)).toBe(true);
  });

  it('keeps a long think inside the sitting for a fast reviewer', () => {
    // 45 s would exceed 15x a 2 s median, but the floor keeps it in.
    const sittings = splitSittings([2_000, 2_000, 45_000, 2_000]);
    expect(sittings).toHaveLength(1);
    expect(sittings[0].deltas).toEqual([2_000, 2_000, 45_000, 2_000]);
  });

  it('builds chronological deltas from newest-first stamps', () => {
    expect(decisionDeltas([500, 300, 100])).toEqual([200, 200]);
    expect(decisionDeltas([100])).toEqual([]);
    expect(decisionDeltas([])).toEqual([]);
  });
});

describe('timePerPhoto', () => {
  const steady = (n: number, ms: number) => Array.from({ length: n }, () => ms);

  it('refuses below the delta floor', () => {
    expect(timePerPhoto(steady(MIN_DELTAS_FOR_TIMING - 1, 3_000))).toEqual({
      kind: 'unknown',
      reason: 'too_few',
    });
  });

  it('reports the median once the halves agree', () => {
    expect(timePerPhoto(steady(MIN_DELTAS_FOR_TIMING, 3_000))).toEqual({
      kind: 'known',
      msPerPhoto: 3_000,
    });
  });

  it('refuses when the halves disagree beyond tolerance', () => {
    // Older half 2 s, newer half 8 s: 75% apart.
    const deltas = [...steady(40, 2_000), ...steady(40, 8_000)];
    expect(timePerPhoto(deltas)).toEqual({ kind: 'unknown', reason: 'unstable' });
  });

  it('accepts drift exactly at the tolerance and rejects just beyond it', () => {
    // 4000 vs 3000 -> |diff| / max = 0.25, exactly the tolerance.
    expect(timePerPhoto([...steady(40, 3_000), ...steady(40, 4_000)]).kind).toBe('known');
    // 4001 vs 3000 -> just over.
    expect(timePerPhoto([...steady(40, 3_000), ...steady(40, 4_001)])).toEqual({
      kind: 'unknown',
      reason: 'unstable',
    });
  });

  it('ignores between-sitting breaks when judging stability', () => {
    // Same steady rhythm, interrupted by overnight gaps.
    const night = 10 * 3_600_000;
    const deltas = [...steady(30, 3_000), night, ...steady(30, 3_000), night, ...steady(30, 3_000)];
    expect(timePerPhoto(deltas)).toEqual({ kind: 'known', msPerPhoto: 3_000 });
  });

  it('converts a known rate into remaining time, and nothing otherwise', () => {
    expect(timeRemainingMs({ kind: 'known', msPerPhoto: 3_000 }, 100)).toBe(300_000);
    expect(timeRemainingMs({ kind: 'unknown', reason: 'too_few' }, 100)).toBeNull();
    expect(timeRemainingMs({ kind: 'known', msPerPhoto: 3_000 }, 0)).toBeNull();
  });
});

describe('projectOutcomes', () => {
  const chunk = (total: number, culled: number): OutcomeChunk => ({
    total,
    culled,
    toEdit: 0,
    favourited: 0,
    shared: 0,
    organized: 0,
  });

  it('spans the least and most aggressive chunks', () => {
    // 20% .. 40% of 1000 remaining.
    const projections = projectOutcomes([chunk(100, 20), chunk(100, 30), chunk(100, 40)], 1000, 0);
    expect(projections?.culled).toEqual({ low: 200, high: 400 });
  });

  it('collapses to a point when habits are consistent', () => {
    const projections = projectOutcomes([chunk(100, 25), chunk(100, 25)], 800, 0);
    expect(projections?.culled).toEqual({ low: 200, high: 200 });
  });

  it('prices the culls from the REMAINING pool mean, not from history', () => {
    const projections = projectOutcomes([chunk(100, 50)], 100, 4_000_000);
    expect(projections?.culled).toEqual({ low: 50, high: 50 });
    expect(projections?.reclaimableBytes).toEqual({ low: 200_000_000, high: 200_000_000 });
  });

  it('ignores empty chunks and gives nothing when there is no sample', () => {
    expect(projectOutcomes([chunk(0, 0)], 100, 0)).toBeNull();
    expect(projectOutcomes([chunk(100, 10)], 0, 0)).toBeNull();
  });
});

describe('composeForecast', () => {
  const base = {
    remaining: 450,
    reviewedByDay: counts({ '2026-01-01': 100, '2026-01-02': 100 }),
    capturedByDay: counts({ '2026-01-01': 10, '2026-01-02': 10 }),
    dayKeys: keys(3),
    decisions: 5000,
    firstDecisionDay: null,
    goal: 200,
    stamps: [] as number[],
    chunks: [{ total: 100, culled: 30, toEdit: 5, favourited: 2, shared: 1, organized: 1 }],
    meanRemainingBytes: 4_000_000,
  };

  it('projects alongside a date', () => {
    const view = composeForecast(base);
    expect(view.finish.kind).toBe('finishing');
    expect(view.projections?.culled).toEqual({ low: 135, high: 135 });
  });

  it('still projects while the backlog is growing', () => {
    // Knowing 1,200 culls are coming is useful even when no date exists.
    const view = composeForecast({
      ...base,
      reviewedByDay: counts({ '2026-01-01': 5, '2026-01-02': 5 }),
      capturedByDay: counts({ '2026-01-01': 50, '2026-01-02': 50 }),
    });
    expect(view.finish.kind).toBe('growing');
    expect(view.projections).not.toBeNull();
  });

  it('refuses to project whenever it refuses to date', () => {
    // A page that declines a date while confidently projecting culls
    // would be talking out of both sides of its mouth.
    expect(composeForecast({ ...base, decisions: 10 }).projections).toBeNull();
    expect(composeForecast({ ...base, remaining: 0 }).projections).toBeNull();
  });

  it('leaves time unknown without stamps, without blocking the date', () => {
    const view = composeForecast(base);
    expect(view.time).toEqual({ kind: 'unknown', reason: 'too_few' });
    expect(view.timeLeftMs).toBeNull();
    expect(view.finish.kind).toBe('finishing');
  });
});

describe('over the shared 90-day fixture', () => {
  const history = buildReviewHistory();

  it('builds a dataset with rest days, empty capture days and a backlog', () => {
    // Guards the fixture itself: flat data would hide the bugs above.
    const reviewDays = history.dayKeys.filter((day) => (history.reviewedByDay.get(day) ?? 0) > 0);
    const captureDays = history.dayKeys.filter((day) => (history.capturedByDay.get(day) ?? 0) > 0);
    expect(reviewDays.length).toBeLessThan(history.dayKeys.length);
    expect(captureDays.length).toBeLessThan(history.dayKeys.length);
    expect(history.remaining).toBeGreaterThan(0);
    expect(history.decisionStamps.length).toBeGreaterThan(MIN_DECISIONS_FOR_FORECAST);
  });

  it('paces against an independently summed window', () => {
    const completed = history.dayKeys.slice(0, -1).slice(-PACE_WINDOW_DAYS);
    let total = 0;
    for (const day of completed) total += history.reviewedByDay.get(day) ?? 0;
    const expected = total / completed.length;
    expect(reviewPace(history.reviewedByDay, history.dayKeys, null)).toBeCloseTo(expected, 10);
  });

  it('finds sittings, not one undifferentiated run', () => {
    const deltas = decisionDeltas(history.decisionStamps);
    const sittings = splitSittings(deltas);
    // The simulation runs one or two sittings on ~4 of every 5 days.
    expect(sittings.length).toBeGreaterThan(50);
    expect(sittings.length).toBeLessThan(deltas.length / 10);
  });

  it('reports a per-photo time consistent with the simulated rhythm', () => {
    const time = timePerPhoto(decisionDeltas(history.decisionStamps));
    expect(time.kind).toBe('known');
    // In-sitting gaps are 1.5-6 s plus an occasional longer think.
    if (time.kind === 'known') {
      expect(time.msPerPhoto).toBeGreaterThan(1_500);
      expect(time.msPerPhoto).toBeLessThan(7_000);
    }
  });

  it('produces a projected range with real width, from drifting rates', () => {
    const projections = projectOutcomes(outcomeChunks(history, 5), history.remaining, 4_000_000);
    expect(projections).not.toBeNull();
    if (projections === null) return;
    // The fixture drifts the cull rate 0.20 -> 0.36, so low must trail high.
    expect(projections.culled.low).toBeLessThan(projections.culled.high);
    expect(projections.culled.low).toBeGreaterThan(0);
    expect(projections.culled.high).toBeLessThan(history.remaining);
    expect(projections.reclaimableBytes.low).toBe(projections.culled.low * 4_000_000);
  });

  it('projects a finish line from the fixture rather than refusing', () => {
    const result = finishLine({
      remaining: history.remaining,
      reviewedByDay: history.reviewedByDay,
      capturedByDay: history.capturedByDay,
      dayKeys: history.dayKeys,
      decisions: history.decisionStamps.length,
      firstDecisionDay: dayKey(history.decisionStamps[history.decisionStamps.length - 1]),
      goal: 50,
    });
    // The simulation reviews far faster than it shoots.
    expect(result.kind).toBe('finishing');
    if (result.kind === 'finishing') {
      expect(result.pace).toBeGreaterThan(result.intake);
      expect(result.days).toBe(Math.ceil(result.remaining / result.net));
    }
  });
});
