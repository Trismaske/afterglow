import { describe, it, expect } from 'vitest';
import {
  formatClockMillis,
  formatClockPrecise,
  formatClockSeconds,
  millisNeeded,
} from './format';

/** Local-time timestamp with explicit seconds/millis. */
function ts(h: number, m: number, s: number, ms = 0): number {
  return new Date(2026, 6, 17, h, m, s, ms).getTime();
}

describe('formatClockSeconds / formatClockMillis', () => {
  it('always renders HH:MM:SS, zero-padded, 24h', () => {
    expect(formatClockSeconds(ts(9, 5, 7))).toBe('09:05:07');
    expect(formatClockSeconds(ts(23, 59, 59))).toBe('23:59:59');
    expect(formatClockSeconds(ts(0, 0, 0))).toBe('00:00:00');
  });

  it('millis variant appends a zero-padded .mmm', () => {
    expect(formatClockMillis(ts(14, 32, 5, 123))).toBe('14:32:05.123');
    expect(formatClockMillis(ts(14, 32, 5, 7))).toBe('14:32:05.007');
    expect(formatClockMillis(ts(14, 32, 5, 0))).toBe('14:32:05.000');
  });

  it('formatClockPrecise switches on the flag', () => {
    expect(formatClockPrecise(ts(8, 1, 2, 450), false)).toBe('08:01:02');
    expect(formatClockPrecise(ts(8, 1, 2, 450), true)).toBe('08:01:02.450');
  });
});

describe('millisNeeded', () => {
  it('no collisions → no millis', () => {
    expect(millisNeeded([ts(10, 0, 1, 500), ts(10, 0, 2, 500), ts(10, 0, 9)])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('adjacent same-second pair with sub-second data marks both', () => {
    expect(millisNeeded([ts(10, 0, 1, 100), ts(10, 0, 1, 800), ts(10, 0, 3)])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('same second but both timestamps are second-resolution → data does not support millis', () => {
    expect(millisNeeded([ts(10, 0, 1, 0), ts(10, 0, 1, 0)])).toEqual([false, false]);
  });

  it('one of the pair having millis is enough', () => {
    expect(millisNeeded([ts(10, 0, 1, 0), ts(10, 0, 1, 250)])).toEqual([true, true]);
  });

  it('collisions chain through the middle photo', () => {
    // p1 collides with p0 and p2 — all three flagged.
    expect(
      millisNeeded([ts(10, 0, 1, 100), ts(10, 0, 1, 500), ts(10, 0, 1, 900), ts(10, 0, 5)]),
    ).toEqual([true, true, true, false]);
  });

  it('handles empty and single-item lists', () => {
    expect(millisNeeded([])).toEqual([]);
    expect(millisNeeded([ts(1, 2, 3, 4)])).toEqual([false]);
  });
});
