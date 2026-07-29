/**
 * Habits math (m0.8.2). The cases that matter are the refusals: a queue
 * with no completions has no completion rate, and a rhythm from a handful
 * of decisions is not a rhythm.
 */
import { describe, expect, it } from 'vitest';
import { buildReviewHistory } from '../__fixtures__/reviewHistory';
import { decisionDeltas, splitSittings } from './forecast';
import {
  decisiveness,
  MIN_DECISIONS_FOR_RHYTHM,
  MIN_FINISHED_FOR_TURNAROUND,
  milestone,
  nextMilestone,
  personalRecords,
  queueTurnaround,
  rhythmGrid,
  summariseSittings,
} from './habits';

describe('rhythmGrid', () => {
  it('fills every cell of the 7x24 grid from sparse input', () => {
    const grid = rhythmGrid([
      { weekday: 0, hour: 9, count: 5 },
      { weekday: 6, hour: 23, count: 2 },
    ]);
    expect(grid.cells).toHaveLength(7);
    expect(grid.cells.every((row) => row.length === 24)).toBe(true);
    expect(grid.cells[0][9]).toBe(5);
    expect(grid.cells[6][23]).toBe(2);
    expect(grid.cells[3][3]).toBe(0);
    expect(grid.total).toBe(7);
    expect(grid.peak).toBe(5);
  });

  it('refuses to name a peak below the noise floor', () => {
    const thin = rhythmGrid([{ weekday: 2, hour: 14, count: MIN_DECISIONS_FOR_RHYTHM - 1 }]);
    expect(thin.peak).toBe(MIN_DECISIONS_FOR_RHYTHM - 1);
    // The busiest cell exists, but calling it a habit would be a lie.
    expect(thin.peakCell).toBeNull();
    const enough = rhythmGrid([{ weekday: 2, hour: 14, count: MIN_DECISIONS_FOR_RHYTHM }]);
    expect(enough.peakCell).toEqual({ weekday: 2, hour: 14 });
  });

  it('ignores out-of-range cells rather than growing the grid', () => {
    const grid = rhythmGrid([
      { weekday: 7, hour: 0, count: 99 },
      { weekday: 0, hour: 24, count: 99 },
      { weekday: -1, hour: 5, count: 99 },
    ]);
    expect(grid.total).toBe(0);
    expect(grid.cells).toHaveLength(7);
  });

  it('reads the fixture history as a real weekly shape', () => {
    // Sittings start at 09:00 and 20:00 in the fixture, so the peak hour
    // must be one of those two — this is the end-to-end sanity check that
    // the grid is not silently transposed.
    const history = buildReviewHistory();
    const cells = new Map<string, number>();
    for (const photo of history.photos) {
      if (photo.decidedAt === null) continue;
      const date = new Date(photo.decidedAt);
      const key = `${date.getDay()}:${date.getHours()}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    const grid = rhythmGrid(
      [...cells].map(([key, count]) => {
        const [weekday, hour] = key.split(':').map(Number);
        return { weekday, hour, count };
      }),
    );
    expect(grid.total).toBe(history.decisionStamps.length);
    expect(grid.peakCell).not.toBeNull();
    expect([9, 10, 20, 21]).toContain(grid.peakCell?.hour);
  });
});

describe('summariseSittings', () => {
  it('counts photos as gaps + 1 and duration as the sum of gaps', () => {
    const summary = summariseSittings([
      { deltas: [1_000, 2_000] }, // 3 photos over 3 s
      { deltas: [4_000, 4_000, 4_000] }, // 4 photos over 12 s
    ]);
    expect(summary.count).toBe(2);
    expect(summary.medianPhotos).toBe(4); // median of [3, 4] = 3.5 -> 4
    expect(summary.medianDurationMs).toBe(7_500);
  });

  it('is empty rather than zero-ish when there is nothing', () => {
    expect(summariseSittings([])).toEqual({
      count: 0,
      medianPhotos: 0,
      medianDurationMs: 0,
    });
  });

  it('describes the SAME sittings the timing estimate uses', () => {
    const history = buildReviewHistory();
    const sittings = splitSittings(decisionDeltas(history.decisionStamps));
    const summary = summariseSittings(sittings);
    expect(summary.count).toBe(sittings.length);
    // The fixture reviews 10-45 photos a day across one or two sittings.
    expect(summary.medianPhotos).toBeGreaterThan(4);
    expect(summary.medianPhotos).toBeLessThan(60);
  });
});

describe('queueTurnaround', () => {
  const NOW = 1_800_000_000_000;

  it('says nothing about turnaround when nothing has ever been finished', () => {
    expect(
      queueTurnaround({ waiting: 12, finished: 0, oldestWaitingAt: NOW, gaps: [] }, NOW),
    ).toEqual({ kind: 'no_history', waiting: 12 });
  });

  it('stays thin until enough work has completed', () => {
    const thin = queueTurnaround(
      {
        waiting: 3,
        finished: MIN_FINISHED_FOR_TURNAROUND - 1,
        oldestWaitingAt: NOW,
        gaps: [1000],
      },
      NOW,
    );
    expect(thin.kind).toBe('thin');
  });

  it('reports the median gap, and no completion rate', () => {
    // m0.8.2: the queues are designed to drain, so a completion rate
    // converges on 100% for every healthy user. Only the median varies.
    const result = queueTurnaround(
      { waiting: 4, finished: 6, oldestWaitingAt: NOW - 1_000, gaps: [1_000, 3_000, 5_000] },
      NOW,
    );
    expect(result).toEqual({
      kind: 'known',
      waiting: 4,
      finished: 6,
      medianMs: 3_000,
      // Waited 1 s against a 3 s typical — normal, so nothing is said.
      stalledMs: null,
    });
  });

  it('names the oldest wait only once it outlasts YOUR typical turnaround', () => {
    const input = { waiting: 2, finished: 9, gaps: [1_000, 3_000, 5_000] };
    // One millisecond under the median is still normal.
    expect(queueTurnaround({ ...input, oldestWaitingAt: NOW - 3_000 }, NOW)).toMatchObject({
      stalledMs: null,
    });
    expect(queueTurnaround({ ...input, oldestWaitingAt: NOW - 3_001 }, NOW)).toMatchObject({
      stalledMs: 3_001,
    });
  });

  it('has nothing to say about an empty queue that has history', () => {
    const result = queueTurnaround(
      { waiting: 0, finished: 20, oldestWaitingAt: null, gaps: [500, 700] },
      NOW,
    );
    expect(result).toMatchObject({ kind: 'known', waiting: 0, stalledMs: null });
  });

  it('never reports a negative wait from a clock that moved backwards', () => {
    const result = queueTurnaround(
      { waiting: 1, finished: 9, oldestWaitingAt: NOW + 60_000, gaps: [1_000, 3_000, 5_000] },
      NOW,
    );
    expect(result).toMatchObject({ stalledMs: null });
  });
});

describe('decisiveness', () => {
  it('compares the rolling rate with the all-time one', () => {
    expect(decisiveness({ decided: 100, culled: 40 }, { decided: 1000, culled: 300 })).toEqual({
      kind: 'known',
      recent: 0.4,
      lifetime: 0.3,
      delta: expect.closeTo(0.1, 10),
      recentDecisions: 100,
    });
  });

  it('refuses when either side is empty', () => {
    expect(decisiveness({ decided: 0, culled: 0 }, { decided: 10, culled: 3 })).toEqual({
      kind: 'unknown',
    });
    expect(decisiveness({ decided: 10, culled: 3 }, { decided: 0, culled: 0 })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('milestones', () => {
  it('counts up to the next round number', () => {
    expect(nextMilestone(0)).toBe(100);
    expect(nextMilestone(100)).toBe(250);
    expect(nextMilestone(99)).toBe(100);
    expect(nextMilestone(999_999)).toBeNull();
  });

  it('carries the label and the target together', () => {
    expect(milestone('photos reviewed', 820)).toEqual({
      label: 'photos reviewed',
      value: 820,
      next: 1000,
    });
  });
});

describe('personalRecords (F13)', () => {
  const map = (entries: [string, number][]) => new Map(entries);

  it('finds the best day, ties going to the most recent', () => {
    const records = personalRecords(
      map([
        ['2026-07-01', 40],
        ['2026-07-02', 90],
        ['2026-07-10', 90],
        ['2026-07-11', 12],
      ]),
      50,
    );
    expect(records.bestDay).toEqual({ day: '2026-07-10', count: 90 });
  });

  it('measures the longest consecutive goal-reached run, month boundaries included', () => {
    const records = personalRecords(
      map([
        ['2026-06-29', 55],
        ['2026-06-30', 60],
        ['2026-07-01', 50], // 3-day run across the month edge
        ['2026-07-03', 80], // isolated
        ['2026-07-05', 10], // below goal — never counts
      ]),
      50,
    );
    expect(records.longestStreak).toBe(3);
  });

  it('is empty-safe', () => {
    expect(personalRecords(new Map(), 50)).toEqual({ longestStreak: 0, bestDay: null });
  });
});
