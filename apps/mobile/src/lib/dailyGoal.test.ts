/** Daily-goal pure logic (m0.8 gate 4): parsing, ring progress, streaks. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_GOAL,
  goalProgress,
  goalStreaks,
  parseDailyGoal,
  serializeDailyGoal,
} from './dailyGoal';

describe('parseDailyGoal', () => {
  it('round-trips every choice and falls back to the default otherwise', () => {
    expect(parseDailyGoal(serializeDailyGoal(200))).toBe(200);
    expect(parseDailyGoal(null)).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('75')).toBe(DEFAULT_DAILY_GOAL);
    expect(parseDailyGoal('garbage')).toBe(DEFAULT_DAILY_GOAL);
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
