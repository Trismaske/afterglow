import type { Cluster, MediaItem, Rng } from './types.js';
import { capCluster, DEFAULT_CLUSTER_CAP } from './clustering.js';
import { shuffled } from './rng.js';

/** Relative weights for choosing what plays next when nothing is mid-cluster. */
export interface MixWeights {
  /** Weight of starting a cluster run (moments/sessions played consecutively). */
  cluster: number;
  /** Weight of showing one random single. */
  single: number;
}

export interface MixOptions {
  /** The full library pool. Random singles are drawn from here. Must be non-empty, ids unique. */
  items: readonly MediaItem[];
  /** Clusters to interleave (from {@link clusterByGap}). May overlap with `items`. */
  clusters?: readonly Cluster[];
  /**
   * Defaults to { cluster: 1, single: 1 }. A weight of 0 disables that
   * source; configurations with no usable source (both weights 0, or
   * single 0 with no non-empty clusters) are rejected.
   */
  weights?: Partial<MixWeights>;
  /**
   * No item repeats within this many consecutive picks (clamped to
   * items.length - 1 so the mix can never run dry). Default 20.
   */
  avoidRepeatWindow?: number;
  /** Max items played per cluster run (evenly sampled when over). Default 8. */
  clusterCap?: number;
  /** Injected random source — required; pass Math.random or a seeded rng. */
  rng: Rng;
}

/** Endless slideshow sequence. Deterministic under a seeded rng. */
export interface Mix {
  /** Returns the next item to display. Never runs dry. */
  next(): MediaItem;
}

/**
 * The slideshow mix engine (desktop v0.3).
 *
 * Behavior:
 * - A cluster plays consecutively, in chronological order, capped/evenly
 *   sampled at `clusterCap`.
 * - Between cluster runs, random singles from the full pool are interleaved
 *   according to `weights`.
 * - No item (cluster member or single) repeats within `avoidRepeatWindow`
 *   picks; cluster members recently shown are dropped from the run, and a
 *   fully-recent cluster is skipped for that turn.
 * - With singles disabled (weight 0), the mix never leaves the cluster
 *   source: when every cluster is fully recent, a cluster replays with the
 *   repeat window relaxed (the endless-stream guarantee wins).
 * - Cluster order is an rng-shuffled epoch, reshuffled when exhausted; the
 *   stream is endless.
 */
export function createMix(options: MixOptions): Mix {
  const {
    items,
    clusters = [],
    weights,
    avoidRepeatWindow = 20,
    clusterCap = DEFAULT_CLUSTER_CAP,
    rng,
  } = options;
  if (items.length === 0) throw new Error('createMix: items must be non-empty');
  if (typeof rng !== 'function') throw new Error('createMix: rng is required');
  if (!Number.isInteger(clusterCap) || clusterCap < 1) {
    throw new Error(`createMix: clusterCap must be a positive integer, got ${clusterCap}`);
  }
  // An explicitly-undefined property keeps its default (a bare spread
  // would overwrite it and slip past every weight check below).
  const w: MixWeights = {
    cluster: weights?.cluster ?? 1,
    single: weights?.single ?? 1,
  };
  if (!Number.isFinite(w.cluster) || !Number.isFinite(w.single)) {
    throw new Error('createMix: weights must be finite numbers');
  }
  if (w.cluster < 0 || w.single < 0) throw new Error('createMix: weights must be >= 0');
  if (w.cluster === 0 && w.single === 0) {
    throw new Error('createMix: weights.cluster and weights.single cannot both be 0');
  }

  const windowSize = Math.max(0, Math.min(avoidRepeatWindow, items.length - 1));
  const usableClusters = clusters.filter((c) => c.items.length > 0);
  if (w.single === 0 && usableClusters.length === 0) {
    throw new Error('createMix: singles are disabled but no non-empty clusters were provided');
  }

  const recent: string[] = [];
  const recentSet = new Set<string>();
  let clusterBag: Cluster[] = [];
  let playing: MediaItem[] = [];
  let playPos = 0;

  function markShown(item: MediaItem): MediaItem {
    if (windowSize > 0) {
      recent.push(item.id);
      recentSet.add(item.id);
      while (recent.length > windowSize) {
        recentSet.delete(recent.shift()!);
      }
    }
    return item;
  }

  function pickSingle(): MediaItem {
    // recentSet.size <= windowSize <= items.length - 1, so this is never empty.
    const candidates = items.filter((it) => !recentSet.has(it.id));
    return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
  }

  /** Try to start a cluster run whose items aren't all in the repeat window. */
  function tryStartCluster(): boolean {
    for (let attempts = 0; attempts < usableClusters.length; attempts++) {
      if (clusterBag.length === 0) clusterBag = shuffled(usableClusters, rng);
      const cluster = clusterBag.pop()!;
      const run = capCluster(cluster, clusterCap).items.filter((it) => !recentSet.has(it.id));
      if (run.length > 0) {
        playing = run;
        playPos = 0;
        return true;
      }
    }
    return false;
  }

  return {
    next(): MediaItem {
      if (playPos < playing.length) return markShown(playing[playPos++]);
      const canCluster = usableClusters.length > 0 && w.cluster > 0;
      const canSingle = w.single > 0;
      let useCluster: boolean;
      if (canCluster && canSingle) {
        useCluster = rng() * (w.cluster + w.single) < w.cluster;
      } else {
        useCluster = canCluster;
      }
      if (useCluster && tryStartCluster()) return markShown(playing[playPos++]);
      if (!canSingle) {
        // Singles are disabled, so the mix must stay within the cluster
        // source: replay a cluster even though all of its members sit in
        // the repeat window (the endless-stream guarantee wins).
        if (clusterBag.length === 0) clusterBag = shuffled(usableClusters, rng);
        playing = capCluster(clusterBag.pop()!, clusterCap).items;
        playPos = 0;
        return markShown(playing[playPos++]);
      }
      return markShown(pickSingle());
    },
  };
}
