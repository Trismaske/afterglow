/**
 * Smart ordering (v0.3 story engine): @afterglow/core's moments clustering +
 * mix engine, adapted to the slideshow's Playlist interface.
 *
 * The show always starts on the plain shuffled playlist; when the background
 * EXIF index arrives (and orderMode is 'smart') the renderer hot-swaps the
 * delegate inside a SwappablePlaylist — the Slideshow never notices.
 */

import { clusterByGap, createMix, type MediaItem, type MediaKind, type Rng } from '@afterglow/core';
import type { Playlist } from './playlist';

/** A Playlist whose underlying source can be replaced mid-show. */
export interface SwappablePlaylist extends Playlist {
  swap(next: Playlist): void;
}

export function createSwappablePlaylist(initial: Playlist): SwappablePlaylist {
  let delegate = initial;
  return {
    get size() {
      return delegate.size;
    },
    next: () => delegate.next(),
    // Forwarded so arrow navigation (v0.5) sees moments once smart order is
    // in; a delegate without moments (plain shuffle) reports all-singles.
    clusterOf: (url: string) => delegate.clusterOf?.(url) ?? null,
    swap(next: Playlist) {
      delegate = next;
    },
  };
}

export interface SmartPlaylistOptions {
  /** Max silence between shots that still counts as one moment (minutes). */
  gapMinutes: number;
  /** Max photos played per cluster run (evenly sampled when over). */
  clusterCap: number;
  rng: Rng;
}

/** What the renderer needs per indexed item (mirrors shared LibraryItem). */
export interface SmartItem {
  url: string;
  timestampMs: number;
  /** 'photo' | 'video' — videos cluster and mix exactly like photos (v0.4). */
  kind: MediaKind;
}

export interface SmartPlaylist extends Playlist {
  /** Number of multi-photo moments found (for logging/diagnostics). */
  readonly clusterCount: number;
}

/**
 * Cluster the indexed library into moments and wrap core's mix engine as a
 * Playlist. Returns null for an empty library (caller keeps shuffle order).
 * Single-photo clusters are not treated as clusters — they stay in the pool
 * of random singles.
 */
export function createSmartPlaylist(
  items: readonly SmartItem[],
  options: SmartPlaylistOptions,
): SmartPlaylist | null {
  if (items.length === 0) return null;

  const mediaItems: MediaItem[] = items.map((item) => ({
    id: item.url,
    uri: item.url,
    timestamp: item.timestampMs,
    kind: item.kind,
  }));

  const clusters = clusterByGap(mediaItems, {
    gapMs: Math.max(1, options.gapMinutes) * 60_000,
  }).filter((c) => c.items.length >= 2);

  const mix = createMix({
    items: mediaItems,
    clusters,
    clusterCap: options.clusterCap,
    rng: options.rng,
  });

  // v0.5 arrow navigation: URL → cluster index, so the navigator can tell
  // where the current moment starts and ends. Singles are simply absent.
  const clusterByUrl = new Map<string, number>();
  clusters.forEach((cluster, i) => {
    for (const item of cluster.items) clusterByUrl.set(item.uri, i);
  });

  return {
    size: mediaItems.length,
    clusterCount: clusters.length,
    next: () => mix.next().uri,
    clusterOf: (url: string) => clusterByUrl.get(url) ?? null,
  };
}
