import { describe, expect, it } from 'vitest';
import { formatDateTime, overlayDateLine, splitPath } from '../src/renderer/format';

describe('formatDateTime', () => {
  it('formats a local timestamp as "d Mon yyyy, HH:MM"', () => {
    const ms = new Date(2026, 6, 17, 2, 5).getTime(); // 17 Jul 2026 02:05 local
    expect(formatDateTime(ms)).toBe('17 Jul 2026, 02:05');
  });

  it('pads hours and minutes', () => {
    const ms = new Date(2024, 0, 3, 9, 7).getTime();
    expect(formatDateTime(ms)).toBe('3 Jan 2024, 09:07');
  });
});

describe('splitPath', () => {
  it('splits POSIX paths', () => {
    expect(splitPath('/home/tris/Pictures/IMG_1.jpg')).toEqual({
      dir: '/home/tris/Pictures',
      name: 'IMG_1.jpg',
    });
  });

  it('splits Windows paths', () => {
    expect(splitPath('C:\\Users\\tris\\Pictures\\a.jpg')).toEqual({
      dir: 'C:\\Users\\tris\\Pictures',
      name: 'a.jpg',
    });
  });

  it('handles a bare filename', () => {
    expect(splitPath('photo.png')).toEqual({ dir: '', name: 'photo.png' });
  });
});

describe('overlayDateLine', () => {
  const capture = new Date(2025, 4, 12, 14, 33).getTime();
  const file = new Date(2026, 0, 1, 0, 0).getTime();

  it('prefers the EXIF capture date', () => {
    expect(overlayDateLine(capture, file)).toBe('12 May 2025, 14:33');
  });

  it('falls back to the file date, labeled honestly', () => {
    expect(overlayDateLine(null, file)).toBe('1 Jan 2026, 00:00 (file date)');
  });

  it('yields an empty string when nothing is known', () => {
    expect(overlayDateLine(null, null)).toBe('');
  });
});
