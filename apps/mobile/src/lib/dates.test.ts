import { describe, expect, it } from 'vitest';
import { dayKey, exifDateTimeToMs } from './dates';

describe('dayKey', () => {
  it('is lexicographically sortable (zero-padded)', () => {
    const jan5 = dayKey(new Date(2026, 0, 5).getTime());
    expect(jan5).toBe('2026-01-05');
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
