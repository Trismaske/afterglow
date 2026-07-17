/**
 * Endless shuffled playlist over a fixed set of URLs.
 *
 * Each epoch is a fresh Fisher–Yates shuffle (from @afterglow/core); on
 * wrap-around we make sure the new epoch doesn't open with the item that
 * just played, so a 2+ image library never shows the same photo twice in a
 * row across the boundary.
 */

import { shuffled, type Rng } from '@afterglow/core';

export interface Playlist {
  /** Number of distinct items. */
  readonly size: number;
  /** Next URL to show. Throws if the playlist is empty. */
  next(): string;
  /**
   * Moment membership for a URL (v0.5 arrow navigation): a stable cluster id
   * when the item belongs to a multi-photo moment, null for singles.
   * Absent on order modes without moments (plain shuffle).
   */
  clusterOf?(url: string): number | null;
}

export function createPlaylist(items: readonly string[], rng: Rng): Playlist {
  let order: string[] = shuffled(items, rng);
  let cursor = 0;
  let last: string | null = null;

  return {
    get size() {
      return items.length;
    },
    next(): string {
      if (items.length === 0) throw new Error('playlist is empty');
      if (cursor >= order.length) {
        order = shuffled(items, rng);
        cursor = 0;
        if (order.length > 1 && order[0] === last) {
          // avoid immediate repeat across the epoch boundary
          [order[0], order[1]] = [order[1], order[0]];
        }
      }
      const item = order[cursor];
      cursor += 1;
      last = item;
      return item;
    },
  };
}
