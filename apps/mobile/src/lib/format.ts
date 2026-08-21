/** Formatting helpers — pure, platform-free. */

/** "1.2 GB", "340 MB", "12 kB", "0 B". */
/** Count-noun agreement (m0.8.7, Errors_design D5 — landed by F15's
 * copy audit, which found 47 hand-rolled ternaries): "1 photo",
 * "3 photos". Locale-formats the number so large counts keep their
 * thousands separators; irregular nouns pass their own plural. */
export function plural(n: number, noun: string, pluralForm = `${noun}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? noun : pluralForm}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/** "14:32" local time of a timestamp. */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * m0.7 (#21): date + time together wherever a timestamp shows —
 * "17 Jul · 14:32" (current year) or "17 Jul 2025 · 14:32" (other years).
 */
export function formatDayClock(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${day} · ${formatClock(ms)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * "14:32:05" — local time with seconds, 24h (m0.4 deck/compare labels
 * always show seconds; hand-rolled so HH:MM:SS holds in every locale).
 */
export function formatClockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "14:32:05.123" — formatClockSeconds plus milliseconds. */
export function formatClockMillis(ms: number): string {
  const frac = ((ms % 1000) + 1000) % 1000;
  return `${formatClockSeconds(ms)}.${String(frac).padStart(3, '0')}`;
}

/**
 * Which of these ordered timestamps need millisecond precision (m0.4):
 * a photo shows millis when an ADJACENT photo in the list shares its
 * wall-clock second AND the data supports it — at least one of the
 * colliding pair carries a nonzero sub-second part (MediaStore
 * creationTime is ms, but some sources are second-resolution and ".000"
 * everywhere would be noise, not signal).
 */
export function millisNeeded(timestamps: readonly number[]): boolean[] {
  const need = timestamps.map(() => false);
  for (let i = 1; i < timestamps.length; i++) {
    const a = timestamps[i - 1];
    const b = timestamps[i];
    const sameSecond = Math.floor(a / 1000) === Math.floor(b / 1000);
    if (sameSecond && (a % 1000 !== 0 || b % 1000 !== 0)) {
      need[i - 1] = true;
      need[i] = true;
    }
  }
  return need;
}

/** One deck/compare label: seconds always, millis when flagged. */
export function formatClockPrecise(ms: number, withMillis: boolean): string {
  return withMillis ? formatClockMillis(ms) : formatClockSeconds(ms);
}
