/**
 * Session-size settings (m0.5, "Sessions" section in Settings) — pure
 * parse/serialize logic, unit-tested; persisted in the m0.3.1 settings
 * table (same pattern as accent_color / similarity_threshold).
 *
 * Three knobs, all consumed by lib/reviewLoader.ts:
 * - Max photos per session (replaces the hardcoded 500 cap; default 50 —
 *   tester fatigue after ~10 groups is normal, sessions should end
 *   before it sets in).
 * - "Don't split groups" (default ON): when the cap lands mid-group the
 *   whole group is included — the cap is soft by up to one group.
 * - Draw order: which end of the scope a session draws from (oldest
 *   first walks the backlog forward like m0.3.1; newest first reviews
 *   fresh shots immediately). Review presentation stays chronological
 *   either way — this only selects WHICH photos the session takes.
 */

export const SESSION_CAP_KEY = 'session_photo_cap';
export const SESSION_WHOLE_GROUPS_KEY = 'session_whole_groups';
export const SESSION_ORDER_KEY = 'session_review_order';

export const DEFAULT_SESSION_CAP = 50;
export const MIN_SESSION_CAP = 10;
export const MAX_SESSION_CAP = 500;

/** The chip choices offered in Settings (any 10–500 value stays valid). */
export const SESSION_CAP_CHOICES: readonly number[] = [25, 50, 100, 200, 500];

export type ReviewOrder = 'oldest' | 'newest';
export const DEFAULT_REVIEW_ORDER: ReviewOrder = 'oldest';

/** All three knobs, resolved (what reviewLoader consumes). */
export interface SessionPrefs {
  cap: number;
  wholeGroups: boolean;
  order: ReviewOrder;
}

export const DEFAULT_SESSION_PREFS: SessionPrefs = {
  cap: DEFAULT_SESSION_CAP,
  wholeGroups: true,
  order: DEFAULT_REVIEW_ORDER,
};

/**
 * Parse a persisted cap. Any integer within [10, 500] is accepted;
 * absent or garbage values fall back to the default (same convention as
 * parseSimilarityThreshold).
 */
export function parseSessionCap(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_SESSION_CAP;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_SESSION_CAP || n > MAX_SESSION_CAP) {
    return DEFAULT_SESSION_CAP;
  }
  return n;
}

export function serializeSessionCap(cap: number): string {
  return String(cap);
}

/** '0' = split groups at the cap; anything else (incl. unset) = don't. */
export function parseWholeGroups(raw: string | null): boolean {
  return raw !== '0';
}

export function serializeWholeGroups(wholeGroups: boolean): string {
  return wholeGroups ? '1' : '0';
}

export function parseReviewOrder(raw: string | null): ReviewOrder {
  return raw === 'newest' ? 'newest' : DEFAULT_REVIEW_ORDER;
}

export function serializeReviewOrder(order: ReviewOrder): string {
  return order;
}
