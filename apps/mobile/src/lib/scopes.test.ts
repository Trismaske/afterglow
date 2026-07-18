import { describe, expect, it } from 'vitest';
import { allTimeUnlocked, DAY_MS, remainingToReview, rollingRange, SCOPE_DEFS } from './scopes';

const NOW = Date.UTC(2026, 6, 17, 15, 30, 0); // arbitrary mid-afternoon

describe('SCOPE_DEFS', () => {
  it('lists every chip in Home order, custom last', () => {
    expect(SCOPE_DEFS.map((d) => d.key)).toEqual([
      'day1',
      'days7',
      'days30',
      'months6',
      'year1',
      'all',
      'custom',
    ]);
  });
});

describe('rollingRange', () => {
  it('ends exactly at now (rolling, not calendar-aligned)', () => {
    for (const key of ['day1', 'days7', 'days30', 'months6', 'year1', 'all'] as const) {
      expect(rollingRange(key, NOW).endMs).toBe(NOW);
    }
  });

  it('spans the fixed day counts', () => {
    expect(NOW - rollingRange('day1', NOW).startMs).toBe(1 * DAY_MS);
    expect(NOW - rollingRange('days7', NOW).startMs).toBe(7 * DAY_MS);
    expect(NOW - rollingRange('days30', NOW).startMs).toBe(30 * DAY_MS);
    expect(NOW - rollingRange('months6', NOW).startMs).toBe(183 * DAY_MS);
    expect(NOW - rollingRange('year1', NOW).startMs).toBe(365 * DAY_MS);
  });

  it('all time starts at epoch 0', () => {
    expect(rollingRange('all', NOW).startMs).toBe(0);
  });

  it('carries the chip label', () => {
    expect(rollingRange('days7', NOW).label).toBe('Last 7 days');
    expect(rollingRange('all', NOW).label).toBe('All time');
  });

  it('nests: every window is contained in the next-larger one', () => {
    const keys = ['day1', 'days7', 'days30', 'months6', 'year1', 'all'] as const;
    for (let i = 1; i < keys.length; i++) {
      expect(rollingRange(keys[i], NOW).startMs).toBeLessThan(
        rollingRange(keys[i - 1], NOW).startMs,
      );
    }
  });
});

describe('remainingToReview', () => {
  it('is MediaStore total minus handled', () => {
    expect(remainingToReview(40, 3)).toBe(37);
  });

  it('clamps at zero when the DB knows more than MediaStore', () => {
    expect(remainingToReview(5, 9)).toBe(0);
  });

  it('is zero for an empty range', () => {
    expect(remainingToReview(0, 0)).toBe(0);
  });
});

describe('allTimeUnlocked', () => {
  it('unlocks only at exactly zero remaining in the last year', () => {
    expect(allTimeUnlocked(0)).toBe(true);
    expect(allTimeUnlocked(1)).toBe(false);
    expect(allTimeUnlocked(500)).toBe(false);
  });
});
