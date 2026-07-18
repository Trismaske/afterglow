import { dayKey } from './dates';

/** Pure tally used by the single ranged MediaStore scan on Home. */
export function tallyPhotoDays(timestamps: readonly number[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const timestamp of timestamps) {
    const key = dayKey(timestamp);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
