/**
 * Session photo selection (m0.5) — pure cap/group-boundary logic,
 * unit-tested; lib/reviewLoader.ts feeds it the paged MediaStore stream.
 *
 * Photos arrive in DRAW order (oldest-first or newest-first per the
 * session prefs). The cap cuts the stream; with "don't split groups" ON
 * the cut is pushed past the cap while consecutive photos stay within
 * the cull-group time gap (core MOMENTS_GAP_MS) — the same boundary the
 * session's clusterByGap will find, so a group never straddles the cap.
 * Similarity refinement only ever SPLITS time clusters, never merges
 * across them, so extending to the time-gap boundary is sufficient.
 *
 * The extension is bounded (MAX_GROUP_EXTENSION) so a pathological
 * no-gap stream can't unbound the session; a group that huge is clipped
 * at the bound and its tail is simply reviewed next session.
 */

/** Hard bound on how far past the cap one group may stretch the session. */
export const MAX_GROUP_EXTENSION = 200;

export interface CapResult<T> {
  selected: T[];
  /** True when reviewable photos beyond the selection remain. */
  capped: boolean;
}

/**
 * Cut `photos` (in draw order) at `cap`, optionally extending to the next
 * time-gap boundary. `timestampOf` extracts ms timestamps; gaps compare
 * as absolute differences so the same logic serves both draw orders.
 */
export function applySessionCap<T>(
  photos: readonly T[],
  timestampOf: (photo: T) => number,
  cap: number,
  wholeGroups: boolean,
  gapMs: number,
  maxExtension: number = MAX_GROUP_EXTENSION,
): CapResult<T> {
  if (photos.length <= cap) return { selected: [...photos], capped: false };
  let cut = cap;
  if (wholeGroups) {
    while (
      cut < photos.length &&
      cut - cap < maxExtension &&
      Math.abs(timestampOf(photos[cut]) - timestampOf(photos[cut - 1])) <= gapMs
    ) {
      cut++;
    }
  }
  return { selected: photos.slice(0, cut), capped: cut < photos.length };
}

/**
 * Per-bucket early-stop rule for the pager: stop paging once the bucket
 * holds `cap` photos AND (splitting allowed, or the group at the cut has
 * closed, or the extension bound is hit). Mirrors applySessionCap so a
 * bucket never stops before every photo the final cut could need.
 */
export function bucketNeedsMore<T>(
  photos: readonly T[],
  timestampOf: (photo: T) => number,
  cap: number,
  wholeGroups: boolean,
  gapMs: number,
  maxExtension: number = MAX_GROUP_EXTENSION,
): boolean {
  if (photos.length < cap) return true;
  if (!wholeGroups) return false;
  if (photos.length - cap >= maxExtension) return false;
  // Keep paging while the last loaded photo still chains to its
  // predecessor within the gap — the group might extend into the next
  // page. A closed gap after the cap means the cut point is known.
  for (let i = cap; i < photos.length; i++) {
    if (Math.abs(timestampOf(photos[i]) - timestampOf(photos[i - 1])) > gapMs) return false;
  }
  return true;
}
