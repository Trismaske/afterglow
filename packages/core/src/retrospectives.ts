import type { MediaItem, Rng } from './types.js';
import { pickOne } from './rng.js';

/**
 * Retrospective selectors (desktop v0.7 modes; usable anywhere).
 *
 * All date math is *local naive time* via the JS Date local getters —
 * per PLAN.md, EXIF timestamps are treated as best-effort local time.
 */

export interface ThisDayOptions {
  /** Month 1–12. */
  month: number;
  /** Day of month 1–31. */
  day: number;
  /** Also include photos within ± this many calendar days (default 0). */
  toleranceDays?: number;
}

const DAY_MS = 86_400_000;

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`month must be 1-12, got ${month}`);
  }
}

/** Distance in calendar days between an item's local date and (month, day), ignoring year. */
function dayDistance(d: Date, month: number, day: number): number {
  const itemMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let best = Infinity;
  // Check the target date in the surrounding years to handle year wraparound
  // (e.g. a Dec 31 photo vs a Jan 1 target).
  for (const year of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    const target = new Date(year, month - 1, day).getTime();
    // Math.round absorbs DST hour offsets.
    best = Math.min(best, Math.abs(Math.round((itemMidnight - target) / DAY_MS)));
  }
  return best;
}

/**
 * "This day in history": every photo taken on (month, day) in any year,
 * optionally within ± toleranceDays. Sorted by timestamp ascending.
 * Note: a Feb 29 target rolls to Mar 1 in non-leap years (JS Date overflow).
 */
export function thisDayInHistory(
  items: readonly MediaItem[],
  options: ThisDayOptions,
): MediaItem[] {
  const { month, day, toleranceDays = 0 } = options;
  assertMonth(month);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`day must be 1-31, got ${day}`);
  }
  if (toleranceDays < 0) throw new Error(`toleranceDays must be >= 0, got ${toleranceDays}`);
  return items
    .filter((it) => dayDistance(new Date(it.timestamp), month, day) <= toleranceDays)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export interface OnePerDayOptions {
  year: number;
  /** Month 1–12. */
  month: number;
  /** Injected random source used to pick among a day's photos. */
  rng: Rng;
}

/**
 * One randomly-picked photo for each day of the given month that has any.
 * Result is ordered by day of month. Deterministic under a seeded rng.
 */
export function onePerDayOfMonth(
  items: readonly MediaItem[],
  options: OnePerDayOptions,
): MediaItem[] {
  const { year, month, rng } = options;
  assertMonth(month);
  const byDay = new Map<number, MediaItem[]>();
  for (const it of items) {
    const d = new Date(it.timestamp);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1) continue;
    const day = d.getDate();
    const bucket = byDay.get(day);
    if (bucket) bucket.push(it);
    else byDay.set(day, [it]);
  }
  return [...byDay.keys()].sort((a, b) => a - b).map((day) => pickOne(byDay.get(day)!, rng));
}

export interface OnePerMonthOptions {
  year: number;
  /** Injected random source used to pick among a month's photos. */
  rng: Rng;
}

/**
 * One randomly-picked photo for each month of the given year that has any.
 * Result is ordered by month. Deterministic under a seeded rng.
 */
export function onePerMonthOfYear(
  items: readonly MediaItem[],
  options: OnePerMonthOptions,
): MediaItem[] {
  const { year, rng } = options;
  const byMonth = new Map<number, MediaItem[]>();
  for (const it of items) {
    const d = new Date(it.timestamp);
    if (d.getFullYear() !== year) continue;
    const month = d.getMonth();
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(it);
    else byMonth.set(month, [it]);
  }
  return [...byMonth.keys()].sort((a, b) => a - b).map((m) => pickOne(byMonth.get(m)!, rng));
}
