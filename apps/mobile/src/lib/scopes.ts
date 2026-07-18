/**
 * Review-scope logic (m0.3.1) — pure TypeScript, unit-tested.
 *
 * Scopes are ROLLING windows ending at "now" (last 24 h, last 7×24 h, …),
 * deliberately not calendar-aligned: "Last day" at 15:00 covers yesterday
 * 15:00 → now. Day-scoped thinking still exists via the Recent-days rows;
 * the scope chips answer "how far back do I want to catch up?", where a
 * rolling window matches the mental model and avoids timezone/calendar
 * edge cases. "Last 6 months" and "Last year" use fixed day counts
 * (183 / 365) for the same reason.
 *
 * "All time" is gated: it stays disabled until the "Last year" scope has
 * zero photos left to review. The ranges nest (all time ⊃ last year), so
 * last-year-clear means everything younger than 365 days is clear and
 * "All time" only adds the older backlog.
 */

export type ScopeKey = 'day1' | 'days7' | 'days30' | 'months6' | 'year1' | 'all' | 'custom';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScopeDef {
  key: ScopeKey;
  label: string;
  /** Window length in days; null = all time / custom (no fixed window). */
  days: number | null;
}

/** Chip order on the Home screen. */
export const SCOPE_DEFS: readonly ScopeDef[] = [
  { key: 'day1', label: 'Last day', days: 1 },
  { key: 'days7', label: 'Last 7 days', days: 7 },
  { key: 'days30', label: 'Last 30 days', days: 30 },
  { key: 'months6', label: 'Last 6 months', days: 183 },
  { key: 'year1', label: 'Last year', days: 365 },
  { key: 'all', label: 'All time', days: null },
  { key: 'custom', label: 'Custom', days: null },
];

export interface ScopeRange {
  /** Inclusive start, ms since epoch (0 for all time). */
  startMs: number;
  /** Inclusive end, ms since epoch — always "now" (rolling). */
  endMs: number;
  label: string;
}

/**
 * The rolling window for a non-custom scope, ending at `nowMs`.
 * 'custom' has no rolling window — callers use the date-range picker.
 */
export function rollingRange(key: Exclude<ScopeKey, 'custom'>, nowMs: number): ScopeRange {
  const def = SCOPE_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`rollingRange: unknown scope ${key}`);
  if (key === 'all') return { startMs: 0, endMs: nowMs, label: def.label };
  return { startMs: nowMs - (def.days ?? 0) * DAY_MS, endMs: nowMs, label: def.label };
}

/**
 * Photos still needing review in a range, from two cheap counts:
 * MediaStore's total for the range (source-filtered) minus the DB rows
 * already converged to to_edit/done ('trashed' rows are excluded from
 * `handledCount` by the caller — they have left MediaStore, so they are
 * not part of `mediaStoreCount` either). Clamped at 0 because the DB can
 * briefly know more than MediaStore (e.g. a photo deleted externally
 * after being marked done).
 */
export function remainingToReview(mediaStoreCount: number, handledCount: number): number {
  return Math.max(0, mediaStoreCount - handledCount);
}

/**
 * The "All time" gate: enabled only once the last-year window has nothing
 * left to review (done/trashed/to_edit all count as reviewed).
 */
export function allTimeUnlocked(remainingInLastYear: number): boolean {
  return remainingInLastYear === 0;
}
