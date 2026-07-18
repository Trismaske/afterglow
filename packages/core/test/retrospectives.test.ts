import { describe, it, expect } from 'vitest';
import { thisDayInHistory, onePerDayOfMonth, onePerMonthOfYear, mulberry32 } from '../src/index';
import { item, ts } from './helpers';

describe('thisDayInHistory', () => {
  const items = [
    item('a2020', ts(2020, 7, 17)),
    item('a2023', ts(2023, 7, 17, 23, 59)),
    item('b', ts(2023, 7, 16)),
    item('c', ts(2023, 7, 19)),
    item('d', ts(2024, 1, 1)),
    item('e', ts(2023, 12, 31)),
  ];

  it('matches the same calendar day across years, sorted by timestamp', () => {
    const out = thisDayInHistory(items, { month: 7, day: 17 });
    expect(out.map((i) => i.id)).toEqual(['a2020', 'a2023']);
  });

  it('tolerance widens the net by calendar days', () => {
    const out = thisDayInHistory(items, { month: 7, day: 17, toleranceDays: 1 });
    expect(out.map((i) => i.id)).toEqual(['a2020', 'b', 'a2023']);
    const wider = thisDayInHistory(items, { month: 7, day: 17, toleranceDays: 2 });
    expect(wider.map((i) => i.id)).toEqual(['a2020', 'b', 'a2023', 'c']);
  });

  it('handles year wraparound (Dec 31 photo near a Jan 1 target)', () => {
    const out = thisDayInHistory(items, { month: 1, day: 1, toleranceDays: 1 });
    expect(out.map((i) => i.id)).toEqual(['e', 'd']);
  });

  it('returns [] when nothing matches, and validates inputs', () => {
    expect(thisDayInHistory(items, { month: 3, day: 3 })).toEqual([]);
    expect(() => thisDayInHistory(items, { month: 0, day: 1 })).toThrow();
    expect(() => thisDayInHistory(items, { month: 13, day: 1 })).toThrow();
    expect(() => thisDayInHistory(items, { month: 1, day: 0 })).toThrow();
    expect(() => thisDayInHistory(items, { month: 1, day: 1, toleranceDays: -1 })).toThrow();
  });
});

describe('onePerDayOfMonth', () => {
  const items = [
    item('d1a', ts(2023, 7, 1, 9)),
    item('d1b', ts(2023, 7, 1, 18)),
    item('d5', ts(2023, 7, 5)),
    item('d20a', ts(2023, 7, 20, 8)),
    item('d20b', ts(2023, 7, 20, 12)),
    item('d20c', ts(2023, 7, 20, 22)),
    item('otherMonth', ts(2023, 6, 20)),
    item('otherYear', ts(2022, 7, 20)),
  ];

  it('picks exactly one item per day that has photos, ordered by day', () => {
    const out = onePerDayOfMonth(items, { year: 2023, month: 7, rng: mulberry32(1) });
    expect(out).toHaveLength(3);
    expect(new Date(out[0].timestamp).getDate()).toBe(1);
    expect(new Date(out[1].timestamp).getDate()).toBe(5);
    expect(new Date(out[2].timestamp).getDate()).toBe(20);
    expect(out[1].id).toBe('d5');
    // Nothing from other months/years leaks in.
    for (const it of out) {
      const d = new Date(it.timestamp);
      expect(d.getFullYear()).toBe(2023);
      expect(d.getMonth()).toBe(6);
    }
  });

  it('is deterministic under a seeded rng', () => {
    const a = onePerDayOfMonth(items, { year: 2023, month: 7, rng: mulberry32(99) });
    const b = onePerDayOfMonth(items, { year: 2023, month: 7, rng: mulberry32(99) });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });

  it('returns [] for an empty month', () => {
    expect(onePerDayOfMonth(items, { year: 2019, month: 7, rng: mulberry32(1) })).toEqual([]);
  });
});

describe('onePerMonthOfYear', () => {
  const items = [
    item('jan1', ts(2023, 1, 5)),
    item('jan2', ts(2023, 1, 25)),
    item('mar', ts(2023, 3, 10)),
    item('dec', ts(2023, 12, 31)),
    item('other', ts(2022, 6, 1)),
  ];

  it('picks one item per month with photos, ordered by month', () => {
    const out = onePerMonthOfYear(items, { year: 2023, rng: mulberry32(4) });
    expect(out).toHaveLength(3);
    expect(out.map((i) => new Date(i.timestamp).getMonth())).toEqual([0, 2, 11]);
    expect(out[1].id).toBe('mar');
    expect(out[2].id).toBe('dec');
  });

  it('is deterministic under a seeded rng and empty for a bare year', () => {
    const a = onePerMonthOfYear(items, { year: 2023, rng: mulberry32(8) });
    const b = onePerMonthOfYear(items, { year: 2023, rng: mulberry32(8) });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(onePerMonthOfYear(items, { year: 1999, rng: mulberry32(8) })).toEqual([]);
  });
});
