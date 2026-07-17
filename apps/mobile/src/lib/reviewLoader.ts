/**
 * Session photo loading (m0.3.1) — paged, state-filtered, capped.
 *
 * Large scopes (6 months / year / all time) can hold thousands of
 * photos. This loader pages MediaStore (never materializing the full
 * range), drops already-converged photos page by page against SQLite,
 * and CAPS a session at the OLDEST `SESSION_PHOTO_CAP` reviewable photos
 * — oldest first matches the review order, so "finish, then start the
 * scope again" walks the backlog forward chunk by chunk.
 *
 * Multi-album correctness: each source bucket is paged oldest-first and
 * early-stopped at the cap, then the per-bucket survivors are merged,
 * re-sorted, and re-capped. The overall-oldest `cap` photos are always a
 * subset of the union of each bucket's oldest `cap`, so early-stopping
 * per bucket is safe and memory stays ≤ buckets × cap.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { pagePhotosInRange, type LoadedPhoto } from './media';
import { getStatesForAssets } from '../db/store';

/** Max reviewable photos per session (see module docs). */
export const SESSION_PHOTO_CAP = 500;

export interface ReviewableLoad {
  /** Oldest-first reviewable photos, at most `cap`. */
  reviewable: LoadedPhoto[];
  /** Photos in range already converged (to_edit / done / trashed). */
  handled: number;
  /** True when more reviewable photos remain beyond the cap. */
  capped: boolean;
}

/**
 * Load the oldest `cap` photos in [startMs, endMs] still needing review.
 * `albumIds` null = all folders; otherwise one paged pass per bucket.
 * Converged states stay converged; interim states (unreviewed / kept /
 * culled from an abandoned session) are re-included, matching the m0.2
 * reconciliation rule.
 */
export async function loadReviewablePhotos(
  db: SQLiteDatabase,
  startMs: number,
  endMs: number,
  albumIds: readonly string[] | null,
  cap: number = SESSION_PHOTO_CAP,
): Promise<ReviewableLoad> {
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const merged: LoadedPhoto[] = [];
  let handled = 0;
  let earlyStopped = false;

  for (const album of buckets) {
    const bucketReviewable: LoadedPhoto[] = [];
    await pagePhotosInRange(startMs, endMs, album, async (page) => {
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
      if (bucketReviewable.length >= cap) {
        earlyStopped = true;
        return false;
      }
      return true;
    });
    merged.push(...bucketReviewable);
  }

  merged.sort((a, b) => a.item.timestamp - b.item.timestamp);
  const capped = earlyStopped || merged.length > cap;
  return { reviewable: merged.slice(0, cap), handled, capped };
}
