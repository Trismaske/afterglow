/**
 * Pure formatting helpers shared by the overlay and the queue window.
 * Hand-rolled date formatting (no Intl) so output is identical across
 * machines/locales — these strings are also asserted in unit tests.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "17 Jul 2026, 02:31" (local time). */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface SplitPath {
  /** Directory part, no trailing separator ('' if the path has none). */
  dir: string;
  /** Final path segment. */
  name: string;
}

/** Split on the last / or \ — pure string logic, works for both OS styles. */
export function splitPath(filePath: string): SplitPath {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', name: filePath };
  return { dir: filePath.slice(0, idx), name: filePath.slice(idx + 1) };
}

/**
 * The overlay's date line: EXIF capture date when we have one, otherwise the
 * file's mtime labeled honestly, otherwise nothing.
 */
export function overlayDateLine(captureDateMs: number | null, fileDateMs: number | null): string {
  if (captureDateMs !== null) return formatDateTime(captureDateMs);
  if (fileDateMs !== null) return `${formatDateTime(fileDateMs)} (file date)`;
  return '';
}
