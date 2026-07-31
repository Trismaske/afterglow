import { describe, expect, it } from 'vitest';
import { dayKey, exifDateTimeToMs, labelForDayKey, UNDATED_DAY_KEY } from './dates';

describe('dayKey', () => {
  it('is lexicographically sortable (zero-padded)', () => {
    const jan5 = dayKey(new Date(2026, 0, 5).getTime());
    expect(jan5).toBe('2026-01-05');
  });
});

describe('labelForDayKey', () => {
  /** Anchoring "now" is what makes Today/Yesterday assertable at all —
   * the label is relative by definition, so a test without a fixed now
   * would pass or fail by the calendar. */
  const now = new Date(2026, 6, 31, 14, 0, 0);

  /** The absolute label carries the year — the m0.8.4 change. Asserted
   * through the SAME Intl call the code makes, because the format is
   * locale-dependent ("17 Aug 2024" here, "Aug 17, 2024" under en-US)
   * and hardcoding one locale's output would pin the test environment
   * rather than the behaviour. What is asserted is that the year is
   * present and the day is right. */
  function expectedAbsolute(y: number, m: number, d: number): string {
    return new Date(y, m, d).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  it('carries the year on a past-year day', () => {
    const label = labelForDayKey('2024-08-17', now);
    expect(label).toBe(expectedAbsolute(2024, 7, 17));
    expect(label).toContain('2024');
  });

  it('carries the year on a CURRENT-year day too (unconditional)', () => {
    // The whole point of not making it conditional: two "17 Aug" rows a
    // year apart must not both render bare.
    const label = labelForDayKey('2026-08-17', now);
    expect(label).toBe(expectedAbsolute(2026, 7, 17));
    expect(label).toContain('2026');
    // ...and it must differ from the same day in another year.
    expect(label).not.toBe(labelForDayKey('2024-08-17', now));
  });

  it('leaves the relative and absent labels alone', () => {
    // These return before formatDay is reached, so the year never
    // applies to them.
    expect(labelForDayKey('2026-07-31', now)).toBe('Today');
    expect(labelForDayKey('2026-07-30', now)).toBe('Yesterday');
    expect(labelForDayKey(UNDATED_DAY_KEY, now)).toBe('Unknown day');
  });
});

describe('exifDateTimeToMs (D15 date rescue)', () => {
  it('parses the standard EXIF shape as device-local time', () => {
    // The spike-verified D300s value: DateTimeOriginal 2024:08:17 16:58:32.
    const ms = exifDateTimeToMs('2024:08:17 16:58:32');
    expect(ms).toBe(new Date(2024, 7, 17, 16, 58, 32).getTime());
    // The rescued photo must land on its real capture DAY (§11 matrix).
    expect(dayKey(ms!)).toBe('2024-08-17');
  });

  it('tolerates surrounding whitespace and a T separator', () => {
    expect(exifDateTimeToMs(' 2024:08:17 16:58:32 ')).not.toBeNull();
    expect(exifDateTimeToMs('2024:08:17T16:58:32')).toBe(exifDateTimeToMs('2024:08:17 16:58:32'));
  });

  it('rejects placeholders, malformed strings, and out-of-range fields', () => {
    // Unset camera clocks write the all-zeros placeholder.
    expect(exifDateTimeToMs('0000:00:00 00:00:00')).toBeNull();
    expect(exifDateTimeToMs('')).toBeNull();
    expect(exifDateTimeToMs('2024-08-17 16:58:32')).toBeNull();
    expect(exifDateTimeToMs('2024:13:01 00:00:00')).toBeNull();
    expect(exifDateTimeToMs('2024:00:10 00:00:00')).toBeNull();
    expect(exifDateTimeToMs('2024:08:17 24:00:00')).toBeNull();
    expect(exifDateTimeToMs('1969:12:31 23:59:59')).toBeNull();
  });

  it('rejects impossible calendar dates instead of letting Date roll them over', () => {
    expect(exifDateTimeToMs('2024:02:30 12:00:00')).toBeNull();
    // A real leap day stays valid.
    expect(exifDateTimeToMs('2024:02:29 12:00:00')).not.toBeNull();
  });
});
