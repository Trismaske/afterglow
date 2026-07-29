/**
 * Library insights (m0.8.2): histogram geometry and labelling, the month
 * range a tapped bar filters to, the frontier sentence, and the burst
 * tax — including the two ratios that must refuse to answer.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHistogram,
  frontierLine,
  keepsPerGroup,
  monthRange,
  rangeOfMonth,
  redundantFrames,
} from './libraryInsights';
import { UNDATED_DAY_KEY } from './dates';

const month = (m: string | null, total: number, reviewed: number) => ({
  month: m,
  total,
  reviewed,
});

describe('buildHistogram', () => {
  it('orders months oldest first and scales against the tallest in view', () => {
    const histogram = buildHistogram([
      month('2024-03', 50, 50),
      month('2024-01', 200, 100),
      month('2024-02', 100, 0),
    ]);
    expect(histogram.bars.map((bar) => bar.key)).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(histogram.bars.map((bar) => bar.height)).toEqual([1, 0.5, 0.25]);
    expect(histogram.total).toBe(350);
    expect(histogram.reviewed).toBe(150);
  });

  it('fills empty months so the timeline measures real distance', () => {
    // Without this a quiet year and a busy year occupy the same width,
    // and the quarter ticks drift off the calendar.
    const histogram = buildHistogram([month('2024-01', 10, 0), month('2024-05', 20, 0)]);
    expect(histogram.bars.map((bar) => bar.key)).toEqual([
      '2024-01',
      '2024-02',
      '2024-03',
      '2024-04',
      '2024-05',
    ]);
    expect(histogram.bars[1].total).toBe(0);
    expect(histogram.bars[1].height).toBe(0);
    // An empty month is not a reviewed month — painting it green made a
    // quiet year read as a finished one.
    expect(histogram.bars[1].reviewedFraction).toBe(0);
    // Filled months are empty, so they cannot move the totals.
    expect(histogram.total).toBe(30);
  });

  it('spans year boundaries when filling', () => {
    const histogram = buildHistogram([month('2023-11', 5, 0), month('2024-02', 5, 0)]);
    expect(histogram.bars.map((bar) => bar.key)).toEqual([
      '2023-11',
      '2023-12',
      '2024-01',
      '2024-02',
    ]);
  });

  it('shades each bar by ITS OWN reviewed share', () => {
    const histogram = buildHistogram([month('2024-01', 200, 50), month('2024-02', 100, 100)]);
    expect(histogram.bars[0].reviewedFraction).toBe(0.25);
    expect(histogram.bars[1].reviewedFraction).toBe(1);
  });

  it('puts undated FIRST, before the timeline starts', () => {
    // It has no calendar position, so it must not sit BETWEEN two known
    // months and imply an age; leading also keeps it clear of the recent
    // end, where the chart opens.
    const histogram = buildHistogram([
      month(null, 12, 4),
      month('2024-01', 30, 0),
      month('2024-02', 10, 0),
    ]);
    expect(histogram.bars.map((bar) => bar.key)).toEqual([UNDATED_DAY_KEY, '2024-01', '2024-02']);
    expect(histogram.bars[0].undated).toBe(true);
    expect(histogram.bars[0].label).toBe('Undated');
    expect(histogram.bars[0].yearTick).toBeNull();
  });

  it('omits an empty undated bucket entirely', () => {
    const histogram = buildHistogram([month(null, 0, 0), month('2024-01', 10, 0)]);
    expect(histogram.bars).toHaveLength(1);
  });

  it('survives an empty library without dividing by zero', () => {
    expect(buildHistogram([])).toEqual({ bars: [], total: 0, reviewed: 0 });
    const zeroes = buildHistogram([month('2024-01', 0, 0)]);
    expect(zeroes.bars[0].height).toBe(0);
    expect(zeroes.bars[0].reviewedFraction).toBe(0);
  });
});

describe('the two-row axis', () => {
  it('ticks calendar quarters, leaving room between labels', () => {
    const histogram = buildHistogram([month('2024-01', 1, 0), month('2024-12', 1, 0)]);
    expect(histogram.bars.map((bar) => bar.monthTick)).toEqual([
      'Jan',
      null,
      null,
      'Apr',
      null,
      null,
      'Jul',
      null,
      null,
      'Oct',
      null,
      null,
    ]);
  });

  it('prints the year on the second row, under January', () => {
    const histogram = buildHistogram([month('2023-11', 1, 0), month('2024-03', 1, 0)]);
    const ticks = histogram.bars.map((bar) => [bar.key, bar.yearTick]);
    expect(ticks).toEqual([
      ['2023-11', null],
      ['2023-12', null],
      ['2024-01', '2024'],
      ['2024-02', null],
      ['2024-03', null],
    ]);
  });

  it('falls back to the first bar when a short span holds no January', () => {
    // Otherwise a library spanning Mar–Jun would never name its year.
    const histogram = buildHistogram([month('2024-03', 1, 0), month('2024-06', 1, 0)]);
    expect(histogram.bars[0].yearTick).toBe('2024');
    expect(histogram.bars.slice(1).every((bar) => bar.yearTick === null)).toBe(true);
  });

  it('gives every bar a full label for accessibility', () => {
    const histogram = buildHistogram([month('2024-11', 1, 0)]);
    expect(histogram.bars[0].label).toBe('Nov 2024');
  });
});

describe('monthRange', () => {
  it('is inclusive at both ends and rolls the year over', () => {
    expect(monthRange('2024-11', '2025-02')).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
    expect(monthRange('2024-05', '2024-05')).toEqual(['2024-05']);
  });
});

describe('rangeOfMonth', () => {
  it('spans the whole month, including the last day', () => {
    const { startMs, endMs } = rangeOfMonth('2024-02');
    expect(new Date(startMs).getDate()).toBe(1);
    expect(new Date(startMs).getMonth()).toBe(1);
    // 2024 is a leap year — the table-free "day 0 of next month" trick.
    expect(new Date(endMs).getDate()).toBe(29);
    expect(new Date(endMs).getHours()).toBe(23);
  });

  it('handles December without rolling into the wrong year', () => {
    const { startMs, endMs } = rangeOfMonth('2024-12');
    expect(new Date(startMs).getFullYear()).toBe(2024);
    expect(new Date(endMs).getFullYear()).toBe(2024);
    expect(new Date(endMs).getMonth()).toBe(11);
    expect(new Date(endMs).getDate()).toBe(31);
  });
});

describe('frontierLine', () => {
  const fmt = (key: string) => `[${key}]`;

  it('says how far back the front has reached', () => {
    expect(frontierLine({ reviewedBackTo: '2024-03-14', undatedPending: 0 }, fmt)).toBe(
      'Reviewed back to [2024-03]',
    );
  });

  it('adds the undated backlog, which sits outside the calendar', () => {
    expect(frontierLine({ reviewedBackTo: '2024-03-14', undatedPending: 18 }, fmt)).toBe(
      'Reviewed back to [2024-03] · 18 undated waiting',
    );
  });

  it('says NOTHING on a fresh library rather than an empty value', () => {
    expect(frontierLine({ reviewedBackTo: null, undatedPending: 0 }, fmt)).toBeNull();
  });

  it('still reports undated photos before anything has been reviewed', () => {
    expect(frontierLine({ reviewedBackTo: null, undatedPending: 5 }, fmt)).toBe(
      '5 undated waiting',
    );
  });
});

describe('the burst tax', () => {
  it('counts frames beyond one per group', () => {
    expect(redundantFrames({ photosInGroups: 4456, groups: 1244 })).toBe(3212);
  });

  it('never goes negative on inconsistent input', () => {
    expect(redundantFrames({ photosInGroups: 0, groups: 3 })).toBe(0);
  });

  it('reports keeps per group over fully decided groups', () => {
    expect(keepsPerGroup({ decidedMembers: 34, decidedKept: 10 })).toBeCloseTo(3.4, 10);
  });

  it('refuses when nothing is decided, or nothing was kept', () => {
    // A user who culled one whole group must not be told they keep 1 of ∞.
    expect(keepsPerGroup({ decidedMembers: 0, decidedKept: 0 })).toBeNull();
    expect(keepsPerGroup({ decidedMembers: 5, decidedKept: 0 })).toBeNull();
  });
});
