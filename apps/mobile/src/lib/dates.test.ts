import { describe, expect, it } from 'vitest';
import { currentStreak, dayKey, previousDayKey, streakStats } from './dates';

describe('previousDayKey', () => {
  it('steps back one day', () => {
    expect(previousDayKey('2026-07-17')).toBe('2026-07-16');
  });

  it('rolls over months and years', () => {
    expect(previousDayKey('2026-07-01')).toBe('2026-06-30');
    expect(previousDayKey('2026-01-01')).toBe('2025-12-31');
    expect(previousDayKey('2024-03-01')).toBe('2024-02-29'); // leap year
  });
});

describe('currentStreak', () => {
  const today = '2026-07-17';

  it('is 0 with no sessions', () => {
    expect(currentStreak([], today)).toBe(0);
  });

  it('counts consecutive days ending today', () => {
    expect(currentStreak(['2026-07-17', '2026-07-16', '2026-07-15'], today)).toBe(3);
  });

  it('preserves the streak when today has no session yet', () => {
    expect(currentStreak(['2026-07-16', '2026-07-15'], today)).toBe(2);
  });

  it('breaks on a gap', () => {
    expect(currentStreak(['2026-07-17', '2026-07-15'], today)).toBe(1);
    expect(currentStreak(['2026-07-14', '2026-07-13'], today)).toBe(0);
  });

  it('ignores duplicates and ordering', () => {
    expect(currentStreak(['2026-07-15', '2026-07-17', '2026-07-16', '2026-07-16'], today)).toBe(3);
  });

  it('crosses month boundaries', () => {
    expect(currentStreak(['2026-07-01', '2026-06-30'], '2026-07-01')).toBe(2);
  });
});

describe('dayKey', () => {
  it('is lexicographically sortable (zero-padded)', () => {
    const jan5 = dayKey(new Date(2026, 0, 5).getTime());
    expect(jan5).toBe('2026-01-05');
  });
});

describe('streakStats', () => {
  it('reports current and longest runs independently', () => {
    expect(
      streakStats(
        ['2026-07-17', '2026-07-16', '2026-07-10', '2026-07-09', '2026-07-08', '2026-07-09'],
        '2026-07-18',
      ),
    ).toEqual({ current: 2, longest: 3 });
  });

  it('returns zeroes for no finished sessions', () => {
    expect(streakStats([], '2026-07-18')).toEqual({ current: 0, longest: 0 });
  });
});
