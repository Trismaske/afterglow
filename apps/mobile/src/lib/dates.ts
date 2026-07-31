/**
 * Day helpers. Pure logic, local time — clustering and review are
 * day-scoped in the user's own timezone, matching how they think about
 * "today's photos".
 *
 * m0.8.2: the Today/Yesterday/custom RANGE builders are gone with the
 * range scope they served. Sessions took the UI that set an arbitrary
 * review range, but the builders outlived it with no callers; the
 * surviving range is `rangeOfDayKey`, which a real day still needs.
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

/**
 * The pseudo-day for photos WITHOUT a capture date (NULL day in SQLite,
 * no DATE_TAKEN in MediaStore). It gets its own still-to-review row and
 * day-progress page; the reserved key can never collide with a
 * "YYYY-MM-DD" calendar key.
 */
export const UNDATED_DAY_KEY = 'undated';

/** "Today" / "Yesterday" / "12 Jul 2025" for a day key, relative to now.
 *
 * The chokepoint for every day label in the app — Home's day rows, the
 * timeline's group and singles cards, DayProgress headings, the Edit
 * queue and PhotoViewer all render through here. */
export function labelForDayKey(key: string, now: Date = new Date()): string {
  if (key === UNDATED_DAY_KEY) return 'Unknown day';
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

/**
 * The year is UNCONDITIONAL (m0.8.4). Home routinely lists two rows both
 * reading "17 Aug" — one 2024, one 2025 — with nothing to tell them
 * apart. A conditional "only when the year differs from now" was
 * considered and rejected as the MORE confusing option: a label whose
 * format changes with the calendar makes the reader work out which rule
 * is in force, and this year's bare "17 Aug" would silently start
 * meaning something else next January.
 */
const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

/** Private: labelForDayKey is the only caller, and every day label in
 * the app goes through it — a second entry point would let a surface
 * print a differently-shaped date. */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, DAY_FORMAT);
}

/**
 * EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS", naive local time) → epoch
 * ms in the DEVICE timezone — the D15 date rescue's pure half (m0.8.3).
 * EXIF times carry no zone, so device-local is the same best-effort
 * stance clustering already takes for every timestamp.
 *
 * Null for anything else: malformed strings, out-of-range fields, and the
 * all-zeros placeholder unset camera clocks write. Pre-1970 dates are
 * rejected too — MediaStore time is epoch ms, and a negative timestamp is
 * far more likely a mangled header than a real photo.
 *
 * The round-trip guard covers CALENDAR fields only (Feb 30 must not
 * become Mar 2). A wall time falling in a DST spring-forward gap is
 * deliberately accepted as JS normalizes it (02:30 → 03:30, same day):
 * the capture DAY — what the rescue exists to recover — survives, and
 * rejecting would demote a real, dated photo to Unknown day over an
 * hour-level ambiguity the no-zone format cannot resolve anyway.
 */
export function exifDateTimeToMs(value: string): number | null {
  const m = value.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Round-trip guard: JS Date silently rolls over impossible dates
  // (Feb 30 → Mar 2), which would file the photo under a day its header
  // never named.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return null;
  }
  return date.getTime();
}
