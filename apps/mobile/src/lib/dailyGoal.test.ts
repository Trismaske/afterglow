/** Daily-goal pure logic (m0.8 gate 4): parsing, ring progress, streaks,
 * ring-arc geometry (m0.8.1 — the inverted-arc regression). */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_GOAL,
  goalProgress,
  goalStreaks,
  MAX_DAILY_GOAL,
  parseCustomDailyGoal,
  parseDailyGoal,
  ringArcs,
  serializeDailyGoal,
  shouldCelebrateGoal,
  visibleArcRange,
} from './dailyGoal';

describe('parseDailyGoal', () => {
  it('round-trips a chip choice AND a custom number, rejecting nonsense', () => {
    expect(parseDailyGoal(serializeDailyGoal(25))).toBe(25);
    // Off-chip values are legitimate now that Custom can set them, so a
    // stored 75 must survive rather than silently snapping to 50.
    expect(parseDailyGoal('75')).toBe(75);
    expect(parseDailyGoal(null)).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('garbage')).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('0')).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('-10')).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('12.5')).toBe(DEFAULT_DAILY_GOAL);
  });
});

describe('parseCustomDailyGoal', () => {
  it('accepts a whole number in range, trimmed', () => {
    expect(parseCustomDailyGoal(' 75 ')).toEqual({ goal: 75 });
    expect(parseCustomDailyGoal('1')).toEqual({ goal: 1 });
    expect(parseCustomDailyGoal(String(MAX_DAILY_GOAL))).toEqual({ goal: MAX_DAILY_GOAL });
  });

  it('names what to fix instead of guessing', () => {
    // Every rejection carries an actionable message (never a silent default).
    for (const bad of ['', '   ', 'abc', '7.5', '0', '-5', String(MAX_DAILY_GOAL + 1)]) {
      const result = parseCustomDailyGoal(bad);
      expect(result, bad).toHaveProperty('error');
      expect((result as { error: string }).error.length).toBeGreaterThan(0);
    }
  });
});

describe('goalProgress', () => {
  it('clamps to [0, 1]', () => {
    expect(goalProgress(0, 50)).toBe(0);
    expect(goalProgress(25, 50)).toBe(0.5);
    expect(goalProgress(80, 50)).toBe(1);
    expect(goalProgress(-3, 50)).toBe(0);
    expect(goalProgress(10, 0)).toBe(1);
  });
});

describe('goalStreaks', () => {
  const days = (counts: Record<string, number>) => new Map(Object.entries(counts));
  // Calendar sequence ending at "today" (d5), newest LAST.
  const keys = ['d1', 'd2', 'd3', 'd4', 'd5'];

  it('counts current and longest runs over the calendar, gaps as zero', () => {
    const s = goalStreaks(days({ d1: 50, d2: 60, d4: 55, d5: 70 }), keys, 50);
    expect(s).toEqual({ current: 2, longest: 2 });
  });

  it('an unfinished today defers to yesterday without breaking the streak', () => {
    const s = goalStreaks(days({ d3: 50, d4: 50, d5: 10 }), keys, 50);
    expect(s).toEqual({ current: 2, longest: 2 });
  });

  it('a missed yesterday ends the current streak even mid-today', () => {
    const s = goalStreaks(days({ d1: 50, d2: 50, d5: 10 }), keys, 50);
    expect(s).toEqual({ current: 0, longest: 2 });
  });

  it('a reached today extends the run', () => {
    const s = goalStreaks(days({ d4: 50, d5: 50 }), keys, 50);
    expect(s).toEqual({ current: 2, longest: 2 });
  });
});

describe('ringArcs (regression: 1/50 rendered a half-full ring)', () => {
  /** Total degrees of ring actually visible for a progress value. */
  function visibleDegrees(progress: number): number {
    const { right, left } = ringArcs(progress);
    const r = right.sweep > 0 ? visibleArcRange(right.rotation, 'right') : { from: 0, to: 0 };
    const l = left.sweep > 0 ? visibleArcRange(left.rotation, 'left') : { from: 0, to: 0 };
    return r.to - r.from + (l.to - l.from);
  }

  it("the visible arc equals progress × 360° and grows from 12 o'clock", () => {
    for (const progress of [0, 0.02, 0.25, 0.5, 0.51, 0.75, 1]) {
      expect(visibleDegrees(progress)).toBeCloseTo(progress * 360, 6);
    }
    // 1/50 shows a sliver STARTING at 12 o'clock, not the complement.
    const sliver = visibleArcRange(ringArcs(0.02).right.rotation, 'right');
    expect(sliver.from).toBe(0);
    expect(sliver.to).toBeCloseTo(7.2, 6);
  });

  it('a reached goal closes the circle; half fills exactly the right side', () => {
    const half = ringArcs(0.5);
    expect(visibleArcRange(half.right.rotation, 'right')).toEqual({ from: 0, to: 180 });
    expect(half.left.sweep).toBe(0);
    const full = ringArcs(1);
    expect(visibleArcRange(full.right.rotation, 'right')).toEqual({ from: 0, to: 180 });
    expect(visibleArcRange(full.left.rotation, 'left')).toEqual({ from: 180, to: 360 });
  });

  it('clamps out-of-range progress', () => {
    expect(visibleDegrees(-1)).toBe(0);
    expect(visibleDegrees(2)).toBeCloseTo(360, 6);
  });
});

describe('shouldCelebrateGoal (F14)', () => {
  const base = { goal: 50, celebratedDay: null, today: '2026-07-29' };

  it('fires exactly at the crossing decision', () => {
    expect(shouldCelebrateGoal({ ...base, before: 49, after: 50 })).toBe(true);
    // A batch keep can jump straight past the goal — still a crossing.
    expect(shouldCelebrateGoal({ ...base, before: 40, after: 90 })).toBe(true);
    expect(shouldCelebrateGoal({ ...base, before: 50, after: 51 })).toBe(false);
    expect(shouldCelebrateGoal({ ...base, before: 10, after: 20 })).toBe(false);
  });

  it('fires once per day, however often the deck remounts', () => {
    expect(
      shouldCelebrateGoal({ ...base, before: 49, after: 50, celebratedDay: '2026-07-29' }),
    ).toBe(false);
    expect(
      shouldCelebrateGoal({ ...base, before: 49, after: 50, celebratedDay: '2026-07-28' }),
    ).toBe(true);
  });
});
