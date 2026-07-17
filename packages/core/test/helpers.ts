import type { MediaItem } from '../src/index';

/** Build a photo MediaItem with a short id and a timestamp. */
export function item(id: string, timestamp: number): MediaItem {
  return { id, timestamp, uri: `/photos/${id}.jpg`, kind: 'photo' };
}

/** n items starting at `start`, spaced `stepMs` apart, ids p0..p(n-1). */
export function burst(n: number, start: number, stepMs: number, prefix = 'p'): MediaItem[] {
  return Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, start + i * stepMs));
}

/** Local-time timestamp helper (month is 1-12). */
export function ts(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}
