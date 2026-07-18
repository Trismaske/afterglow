/**
 * Show navigator (v0.5): the pure history/seek brain behind the arrow keys.
 *
 * Keeps a back-buffer of what was actually *shown* (successful loads only,
 * capacity ~200) with a cursor at the on-screen item. The Slideshow drives
 * it in candidate/commit steps so unloadable files never enter (or silently
 * fall out of) history:
 *
 *   1. ask for a candidate — next()/prev()/momentStart()/momentSkip()
 *   2. try to load it
 *   3. report shown(candidate) on success, failed(candidate) otherwise
 *
 * Semantics:
 * - next(): replay forward history first (after ←, → and the auto-advance
 *   walk back up the same trail), then pull fresh items from the playlist.
 * - Showing a fresh item while the cursor is behind truncates the forward
 *   tail (browser-history model) — the trail never forks.
 * - momentStart(): earliest entry of the contiguous same-cluster run ending
 *   at the cursor; null when the current item has no cluster or already is
 *   the run's first entry (the caller restarts the timer instead).
 * - momentSkip(): pulls from the live playlist until the cluster changes;
 *   null when the current item has no cluster (the caller falls back to
 *   next()). Skipped items are consumed, not recorded.
 *
 * Pure over an injected Playlist (no DOM, no timers) — unit-tested.
 */

import type { Playlist } from './playlist';

/** History depth: roughly 25 minutes of show at the default 8 s/slide. */
export const HISTORY_CAPACITY = 200;

/** A URL to try showing; `index` is its history position, null = live pull. */
export interface NavCandidate {
  url: string;
  index: number | null;
}

export interface Navigator {
  /** URL of the on-screen item, or null before the first slide. */
  readonly current: string | null;
  next(): NavCandidate;
  prev(): NavCandidate | null;
  momentStart(): NavCandidate | null;
  momentSkip(): NavCandidate | null;
  /** The candidate loaded and is now on screen. */
  shown(candidate: NavCandidate): void;
  /** The candidate failed to load; history candidates are forgotten. */
  failed(candidate: NavCandidate): void;
}

export function createNavigator(
  playlist: Playlist,
  capacity: number = HISTORY_CAPACITY,
): Navigator {
  /** Shown URLs, oldest first; entries[cursor] is on screen. */
  const entries: string[] = [];
  let cursor = -1;

  const clusterOf = (url: string): number | null => playlist.clusterOf?.(url) ?? null;

  return {
    get current(): string | null {
      return cursor >= 0 ? entries[cursor] : null;
    },

    next(): NavCandidate {
      if (cursor >= 0 && cursor < entries.length - 1) {
        return { url: entries[cursor + 1], index: cursor + 1 };
      }
      return { url: playlist.next(), index: null };
    },

    prev(): NavCandidate | null {
      if (cursor <= 0) return null;
      return { url: entries[cursor - 1], index: cursor - 1 };
    },

    momentStart(): NavCandidate | null {
      if (cursor < 0) return null;
      const cluster = clusterOf(entries[cursor]);
      if (cluster === null) return null;
      let start = cursor;
      while (start > 0 && clusterOf(entries[start - 1]) === cluster) start -= 1;
      if (start === cursor) return null; // already at the moment's first shown item
      return { url: entries[start], index: start };
    },

    momentSkip(): NavCandidate | null {
      if (cursor < 0) return null;
      const cluster = clusterOf(entries[cursor]);
      if (cluster === null) return null;
      // The remainder of a cluster run is at most the cluster cap; the size
      // bound only guards a degenerate everything-is-one-moment library.
      const attempts = Math.max(1, playlist.size);
      for (let i = 0; i < attempts; i++) {
        const url = playlist.next();
        if (clusterOf(url) !== cluster) return { url, index: null };
      }
      return null;
    },

    shown(candidate: NavCandidate): void {
      if (candidate.index !== null) {
        cursor = candidate.index;
        return;
      }
      entries.splice(cursor + 1); // a fresh item truncates any forward tail
      entries.push(candidate.url);
      cursor = entries.length - 1;
      while (entries.length > capacity) {
        entries.shift();
        cursor -= 1;
      }
    },

    failed(candidate: NavCandidate): void {
      if (candidate.index === null) return; // live pulls were never recorded
      entries.splice(candidate.index, 1);
      if (candidate.index < cursor) cursor -= 1;
    },
  };
}
