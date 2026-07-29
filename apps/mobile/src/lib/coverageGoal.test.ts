/** Coverage goal (m0.8.1 round 8): parsing, window scoping, streaks,
 * the all-time mode, and the Stats chart markers. */
import { describe, expect, it } from 'vitest';
import {
  coverageStatus,
  coverageStreak,
  coverageWindow,
  coverageWindowDays,
  lastCoverageDays,
  DEFAULT_COVERAGE_GOAL,
  parseCoverageGoal,
  serializeCoverageGoal,
  type DayCoverage,
} from './coverageGoal';

/** d1..d5 oldest first, "today" last — the shape every caller passes. */
const keys = ['d1', 'd2', 'd3', 'd4', 'd5'];
const rows = (spec: Record<string, [number, number]>): DayCoverage[] =>
  Object.entries(spec).map(([day, [total, pending]]) => ({ day, total, pending }));

describe('parseCoverageGoal', () => {
  it('accepts the known choices and falls back otherwise', () => {
    expect(parseCoverageGoal('today')).toBe('today');
    expect(parseCoverageGoal('all')).toBe('all');
    expect(parseCoverageGoal('off')).toBe('off');
    expect(parseCoverageGoal(null)).toBe(DEFAULT_COVERAGE_GOAL);
    expect(parseCoverageGoal('7')).toBe(DEFAULT_COVERAGE_GOAL);
    expect(parseCoverageGoal('')).toBe(DEFAULT_COVERAGE_GOAL);
  });

  it('round-trips', () => {
    expect(parseCoverageGoal(serializeCoverageGoal('7days'))).toBe('7days');
  });

  it('maps choices to window lengths (null = all time, 0 = off)', () => {
    expect(coverageWindowDays('off')).toBe(0);
    expect(coverageWindowDays('today')).toBe(1);
    expect(coverageWindowDays('2days')).toBe(2);
    expect(coverageWindowDays('7days')).toBe(7);
    expect(coverageWindowDays('all')).toBeNull();
  });
});

describe('coverageStatus — rolling windows', () => {
  it('scopes to the last N days only', () => {
    // d3 is dirty but outside a 2-day window; d4/d5 are clean.
    const data = rows({ d3: [10, 10], d4: [4, 0], d5: [6, 0] });
    const twoDays = coverageStatus(data, '2days', keys);
    expect(twoDays).toMatchObject({ total: 10, pending: 0 });
    expect(twoDays.ratio).toBe(1);
    // A 7-day window sees d3's backlog.
    const week = coverageStatus(data, '7days', keys);
    expect(week).toMatchObject({ total: 20, pending: 10 });
    expect(week.ratio).toBe(0.5);
  });

  it('a day with no photos contributes nothing to keep up with', () => {
    const status = coverageStatus(rows({ d5: [3, 0] }), '2days', keys);
    expect(status.total).toBe(3); // d4 had no photos at all
    expect(status.ratio).toBe(1);
  });

  it('an empty window is vacuously complete', () => {
    expect(coverageStatus([], 'today', keys)).toMatchObject({ total: 0, ratio: 1 });
  });

  it('EXCLUDES undated photos from rolling windows', () => {
    const data: DayCoverage[] = [...rows({ d5: [2, 0] }), { day: null, total: 99, pending: 99 }];
    expect(coverageStatus(data, 'today', keys)).toMatchObject({ total: 2, pending: 0, ratio: 1 });
  });

  it('off reports nothing', () => {
    expect(coverageStatus(rows({ d5: [10, 10] }), 'off', keys)).toMatchObject({
      total: 0,
      pending: 0,
      streak: null,
    });
  });
});

describe('coverageStatus — all time (the 100% goal)', () => {
  const data: DayCoverage[] = [
    ...rows({ d1: [10, 5], d5: [10, 0] }),
    { day: null, total: 4, pending: 1 },
  ];

  it('counts every day AND the undated bucket, with no streak', () => {
    const status = coverageStatus(data, 'all', keys);
    expect(status.total).toBe(24);
    expect(status.pending).toBe(6);
    expect(status.ratio).toBeCloseTo(18 / 24, 6);
    expect(status.streak).toBeNull(); // inbox zero is a state, not a run
  });

  it('reaches 1 exactly at inbox zero', () => {
    const clean: DayCoverage[] = [
      { day: 'd1', total: 10, pending: 0 },
      { day: null, total: 4, pending: 0 },
    ];
    expect(coverageStatus(clean, 'all', keys).ratio).toBe(1);
  });
});

describe('coverageStreak', () => {
  it('counts consecutive cleared SHOOTING days ending today', () => {
    expect(coverageStreak(rows({ d3: [5, 0], d4: [5, 0], d5: [5, 0] }), keys)).toBe(3);
  });

  it('days with no photos neither break the run nor earn a day', () => {
    // A phone in a drawer must not accrue a streak: d2/d4 are empty.
    expect(coverageStreak(rows({ d1: [5, 0], d3: [5, 0], d5: [5, 0] }), keys)).toBe(3);
    expect(coverageStreak([], keys)).toBe(0);
  });

  it('an unfinished today defers to yesterday rather than breaking it', () => {
    const data = rows({ d3: [5, 0], d4: [5, 0], d5: [5, 2] });
    expect(coverageStreak(data, keys)).toBe(2); // d5 pending, d3+d4 clear
  });

  it('a dirty yesterday ends the streak even with today clear', () => {
    expect(coverageStreak(rows({ d3: [5, 0], d4: [5, 3], d5: [5, 0] }), keys)).toBe(1);
  });

  it('backlog clearing retroactively lights up old days (accepted trade)', () => {
    const dirty = rows({ d1: [5, 5], d2: [5, 0], d3: [5, 0], d4: [5, 0], d5: [5, 0] });
    expect(coverageStreak(dirty, keys)).toBe(4);
    const cleaned = rows({ d1: [5, 0], d2: [5, 0], d3: [5, 0], d4: [5, 0], d5: [5, 0] });
    expect(coverageStreak(cleaned, keys)).toBe(5);
  });
});

describe('coverageWindow (Stats chart markers)', () => {
  it('marks cleared, dirty and empty days and flags today', () => {
    const win = coverageWindow(rows({ d2: [4, 0], d3: [6, 2], d5: [1, 0] }), keys);
    expect(win.markers.map((m) => [m.cleared, m.empty])).toEqual([
      [false, true], // d1: no photos
      [true, false], // d2: cleared
      [false, false], // d3: 2 pending
      [false, true], // d4: no photos
      [true, false], // d5: cleared
    ]);
    expect(win.markers[4].isToday).toBe(true);
    expect(win).toMatchObject({ clearedDays: 2, daysWithPhotos: 3, pending: 2 });
  });

  it('lines up column-for-column with the activity chart keys', () => {
    expect(coverageWindow([], keys).markers.map((m) => m.day)).toEqual(keys);
  });

  it('narrowing to the plotted days recomputes the totals with them', () => {
    // d1's photos are outside the plotted slice: its 5 pending must not
    // be counted in a caption sitting under a chart that omits d1.
    const win = coverageWindow(rows({ d1: [5, 5], d4: [2, 0], d5: [3, 1] }), keys);
    expect(win).toMatchObject({ daysWithPhotos: 3, pending: 6 });
    const plotted = lastCoverageDays(win, 3);
    expect(plotted.markers.map((m) => m.day)).toEqual(['d3', 'd4', 'd5']);
    expect(plotted).toMatchObject({ clearedDays: 1, daysWithPhotos: 2, pending: 1 });
  });
});
