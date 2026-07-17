/**
 * Session photo loading (m0.3.1, reworked for m0.5) — paged,
 * state-filtered, capped by the user's session settings.
 *
 * Large scopes (6 months / year / all time) can hold thousands of
 * photos. This loader pages MediaStore (never materializing the full
 * range), drops already-converged photos page by page against SQLite,
 * and caps a session per the m0.5 "Sessions" settings (sessionPrefs.ts):
 * max photos (default 50), draw order (oldest first walks the backlog
 * forward chunk by chunk; newest first reviews fresh shots immediately),
 * and "don't split groups" (the cap is soft by up to one time-gap group
 * — sessionSelect.ts, gap = core MOMENTS_GAP_MS so the boundary matches
 * the session's own clustering; similarity refinement only ever splits
 * further, never merges across a time gap).
 *
 * Multi-album correctness: each source bucket is paged in draw order and
 * early-stopped per sessionSelect.bucketNeedsMore, then the per-bucket
 * survivors are merged, re-sorted, and re-capped. The overall first
 * `cap(+group)` photos are always a subset of the union of each bucket's
 * first `cap(+group)`, so early-stopping per bucket is safe and memory
 * stays ≤ buckets × (cap + one group). Group-boundary detection on the
 * merged stream is time-gap based, so bucket interleaving cannot hide a
 * boundary that exists in the merged order.
 *
 * The returned photos are ALWAYS chronological (oldest first) regardless
 * of draw order — draw order selects WHICH photos; review presentation
 * stays chronological (groups are time clusters either way).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { MOMENTS_GAP_MS } from '@afterglow/core';
import { pagePhotosInRange, type LoadedPhoto } from './media';
import { getSetting, getStatesForAssets } from '../db/store';
import {
  parseReviewOrder,
  parseSessionCap,
  parseWholeGroups,
  SESSION_CAP_KEY,
  SESSION_ORDER_KEY,
  SESSION_WHOLE_GROUPS_KEY,
  type SessionPrefs,
} from './sessionPrefs';
import { applySessionCap, bucketNeedsMore } from './sessionSelect';

export interface ReviewableLoad {
  /** Chronological (oldest-first) reviewable photos, at most cap + one group. */
  reviewable: LoadedPhoto[];
  /** Photos in range already converged (to_edit / done / trashed). */
  handled: number;
  /** True when more reviewable photos remain beyond the cap. */
  capped: boolean;
}

/** The m0.5 session settings, resolved from the settings table. */
export async function getSessionPrefs(db: SQLiteDatabase): Promise<SessionPrefs> {
  const [cap, whole, order] = await Promise.all([
    getSetting(db, SESSION_CAP_KEY),
    getSetting(db, SESSION_WHOLE_GROUPS_KEY),
    getSetting(db, SESSION_ORDER_KEY),
  ]);
  return {
    cap: parseSessionCap(cap),
    wholeGroups: parseWholeGroups(whole),
    order: parseReviewOrder(order),
  };
}

const tsOf = (p: LoadedPhoto) => p.item.timestamp;

/**
 * Load the photos in [startMs, endMs] still needing review, selected per
 * `prefs` (draw order + cap + group-boundary softening). `albumIds`
 * null = all folders; otherwise one paged pass per bucket. Converged
 * states stay converged; interim states (unreviewed / kept / culled from
 * an abandoned session) are re-included, matching the m0.2
 * reconciliation rule.
 */
export async function loadReviewablePhotos(
  db: SQLiteDatabase,
  startMs: number,
  endMs: number,
  albumIds: readonly string[] | null,
  prefs: SessionPrefs,
): Promise<ReviewableLoad> {
  const { cap, wholeGroups, order } = prefs;
  const descending = order === 'newest';
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const merged: LoadedPhoto[] = [];
  let handled = 0;
  let earlyStopped = false;

  for (const album of buckets) {
    const bucketReviewable: LoadedPhoto[] = [];
    await pagePhotosInRange(
      startMs,
      endMs,
      album,
      async (page) => {
        if (page.length === 0) return true;
        const states = await getStatesForAssets(
          db,
          page.map((p) => p.item.id),
        );
        for (const photo of page) {
          const state = states.get(photo.item.id);
          if (state === 'to_edit' || state === 'done' || state === 'trashed') handled++;
          else bucketReviewable.push(photo);
        }
        if (!bucketNeedsMore(bucketReviewable, tsOf, cap, wholeGroups, MOMENTS_GAP_MS)) {
          earlyStopped = true;
          return false;
        }
        return true;
      },
      descending,
    );
    merged.push(...bucketReviewable);
  }

  // Draw order: the direction the cap consumes the merged stream in.
  merged.sort((a, b) => (descending ? tsOf(b) - tsOf(a) : tsOf(a) - tsOf(b)));
  const { selected, capped } = applySessionCap(merged, tsOf, cap, wholeGroups, MOMENTS_GAP_MS);
  // Review presentation is always chronological.
  if (descending) selected.reverse();
  return { reviewable: selected, handled, capped: earlyStopped || capped };
}
