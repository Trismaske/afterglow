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
 * and "don't split groups" (the cap is soft by up to one TIME-gap group
 * — sessionSelect.ts, gap = core MOMENTS_GAP_MS). Known limit: gate-2
 * similarity grouping can link photos ACROSS time gaps, and the cap only
 * respects time-gap boundaries, so a similarity component may still
 * split at the cap (its tail lands in the next draw). Closing components
 * requires hashing a lookahead window — that is the m0.8 roadmap's
 * quota-driven candidate window (PLAN.md), not a loader patch.
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
import { getActiveSessionKeptIds, getSetting, getStatesForAssets } from '../db/store';
import { markPhotoRestored } from '../db/trashStore';
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
  /** Staged culls in range — carried in the durable global cull queue
   * (P4#1), not drawn. (Gate 2's candidate window re-includes them as
   * badged context; until then they are reachable via the cull list.) */
  carried: number;
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
 * The active session's kept ids for the loader's pendingBankIds param.
 * The IN-MEMORY session wins when present — it is ahead of any queued
 * decision write, so a keep made moments before "start new" is never
 * missed (the persisted snapshot could still be stale behind the FIFO
 * persistence barrier). Falls back to the persisted snapshot for a
 * session that was never resumed this process.
 */
export async function pendingBankIdsFor(
  session: { toJSON(): { states: Record<string, string> } } | null,
  db: SQLiteDatabase,
): Promise<ReadonlySet<string>> {
  if (session) {
    return new Set(
      Object.entries(session.toJSON().states)
        .filter(([, state]) => state === 'kept')
        .map(([id]) => id),
    );
  }
  return new Set(await getActiveSessionKeptIds(db));
}

/**
 * Load the photos in [startMs, endMs] still needing review, selected per
 * `prefs` (draw order + cap + group-boundary softening). `albumIds`
 * null = all folders; otherwise one paged pass per bucket. Converged
 * states stay converged; interim unreviewed/kept rows are re-included.
 * Staged culls are CARRIED (m0.7 policy change): they stay in the durable
 * global cull queue and are counted, not drawn — never reset. A
 * 'trashed'-state photo appearing in a MediaStore page was restored from
 * the system trash — it reconciles (markPhotoRestored) and re-enters
 * review.
 */
export async function loadReviewablePhotos(
  db: SQLiteDatabase,
  startMs: number,
  endMs: number,
  albumIds: readonly string[] | null,
  prefs: SessionPrefs,
  /** Active session's kept ids (getActiveSessionKeptIds): counted as
   * handled WITHOUT mutation — they bank to done only inside the atomic
   * replacement, so an aborted start leaves the old session intact. */
  pendingBankIds: ReadonlySet<string> = new Set(),
): Promise<ReviewableLoad> {
  const { cap, wholeGroups, order } = prefs;
  const descending = order === 'newest';
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const merged: LoadedPhoto[] = [];
  let handled = 0;
  let carried = 0;
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
          if (state === 'trashed') {
            // MediaStore excludes trashed rows from queries, so a
            // 'trashed'-state photo appearing in a page has provably been
            // restored from the system trash (P8#4): reconcile — presence
            // returns, the generation increments so a later verified
            // re-trash counts again — and review it like any other photo.
            await markPhotoRestored(db, photo.item.id, Date.now());
            bucketReviewable.push(photo);
          } else if (state === 'to_edit' || state === 'done' || pendingBankIds.has(photo.item.id))
            handled++;
          else if (state === 'culled') carried++;
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
  return { reviewable: selected, handled, carried, capped: earlyStopped || capped };
}
