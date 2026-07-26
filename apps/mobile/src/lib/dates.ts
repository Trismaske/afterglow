/**
 * Date-scope helpers for the Home screen (Today / Yesterday / custom range).
 * Pure logic, local time — clustering and review are day-scoped in the
 * user's own timezone, matching how they think about "today's photos".
 */

export interface DateRange {
  /** Inclusive start, ms since epoch. */
  startMs: number;
  /** Inclusive end, ms since epoch. */
  endMs: number;
  /** Human label, e.g. "Today" or "Jul 12 – Jul 14". */
  label: string;
}

/** Midnight (00:00:00.000) local time of the given date's day. */
export function startOfDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** End of day (23:59:59.999) local time of the given date's day. */
export function endOfDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy.getTime();
}

export function todayRange(now: Date): DateRange {
  return { startMs: startOfDay(now), endMs: endOfDay(now), label: 'Today' };
}

export function yesterdayRange(now: Date): DateRange {
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return { startMs: startOfDay(y), endMs: endOfDay(y), label: 'Yesterday' };
}

/**
 * Local calendar-day key, "YYYY-MM-DD" — the `photos.day` column. Must
 * stay lexicographically sortable (day comparisons use string >=).
 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The full local-day range for a "YYYY-MM-DD" key. */
export function rangeOfDayKey(key: string): DateRange {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    startMs: startOfDay(date),
    endMs: endOfDay(date),
    label: labelForDayKey(key),
  };
}

/** "Today" / "Yesterday" / "Jul 12" for a day key, relative to now. */
export function labelForDayKey(key: string, now: Date = new Date()): string {
  if (key === dayKey(now.getTime())) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  return formatDay(rangeStartOfKey(key));
}

/** Midnight ms of a day key (internal helper for labeling). */
function rangeStartOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** The last `count` day keys ending at `now`'s day, newest first. */
export function recentDayKeys(count: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  const d = new Date(now);
  for (let i = 0; i < count; i++) {
    keys.push(dayKey(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, DAY_FORMAT);
}

/**
 * Custom range spanning whole days. Start/end may be given in either order;
 * the range always covers full local days.
 */
export function customRange(a: Date, b: Date): DateRange {
  const [from, to] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
  const startMs = startOfDay(from);
  const endMs = endOfDay(to);
  const label =
    startOfDay(from) === startOfDay(to)
      ? formatDay(startMs)
      : `${formatDay(startMs)} – ${formatDay(endMs)}`;
  return { startMs, endMs, label };
}
