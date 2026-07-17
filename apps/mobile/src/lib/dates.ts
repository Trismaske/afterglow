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
