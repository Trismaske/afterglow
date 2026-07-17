/** Formatting helpers — pure, platform-free. */

/** "1.2 GB", "340 MB", "12 kB", "0 B". */
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
