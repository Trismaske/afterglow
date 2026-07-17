import type { Cluster, MediaItem } from './types.js';

/** Options for {@link clusterByGap}. */
export interface ClusterOptions {
  /**
   * Maximum silence between consecutive shots that still counts as the same
   * cluster. A gap strictly greater than `gapMs` starts a new cluster
   * (a gap of exactly `gapMs` stays together).
   */
  gapMs: number;
}

/** "Moments" preset — bursts and near-bursts (≤ 3 minutes apart). */
export const MOMENTS_GAP_MS = 3 * 60_000;

/** "Sessions" preset — a shoot or an outing (≤ 30 minutes apart). */
export const SESSIONS_GAP_MS = 30 * 60_000;

/** Default cap applied when a cluster is played back (mix engine). */
export const DEFAULT_CLUSTER_CAP = 8;

function makeCluster(items: MediaItem[]): Cluster {
  const first = items[0];
  const last = items[items.length - 1];
  return {
    id: `${first.timestamp}:${first.id}`,
    items,
    start: first.timestamp,
    end: last.timestamp,
  };
}

/**
 * Gap-based time clustering. Items are sorted by timestamp (ties broken by
 * id for determinism); a gap > `gapMs` between consecutive items starts a
 * new cluster. Every input item lands in exactly one cluster (singletons
 * become 1-item clusters — callers decide their own "counts as a group"
 * threshold, e.g. `c.items.length >= 2`).
 */
export function clusterByGap(items: readonly MediaItem[], options: ClusterOptions): Cluster[] {
  const { gapMs } = options;
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new Error(`clusterByGap: gapMs must be a non-negative number, got ${gapMs}`);
  }
  const sorted = [...items].sort(
    (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const clusters: Cluster[] = [];
  let current: MediaItem[] = [];
  for (const item of sorted) {
    if (current.length > 0 && item.timestamp - current[current.length - 1].timestamp > gapMs) {
      clusters.push(makeCluster(current));
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) clusters.push(makeCluster(current));
  return clusters;
}

/** Moments clustering (~3 min gap) — desktop story engine, mobile cull groups. */
export function clusterMoments(
  items: readonly MediaItem[],
  gapMs: number = MOMENTS_GAP_MS,
): Cluster[] {
  return clusterByGap(items, { gapMs });
}

/** Sessions clustering (~30 min gap) — looser "take you back to that day" sequences. */
export function clusterSessions(
  items: readonly MediaItem[],
  gapMs: number = SESSIONS_GAP_MS,
): Cluster[] {
  return clusterByGap(items, { gapMs });
}

/**
 * Cap a cluster at `cap` items with even sampling: first and last items are
 * always kept, interior items are sampled evenly, chronological order is
 * preserved. Returns the cluster unchanged when it is already within the cap.
 */
export function capCluster(cluster: Cluster, cap: number): Cluster {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`capCluster: cap must be a positive integer, got ${cap}`);
  }
  const n = cluster.items.length;
  if (n <= cap) return cluster;
  let sampled: MediaItem[];
  if (cap === 1) {
    sampled = [cluster.items[Math.floor((n - 1) / 2)]];
  } else {
    sampled = [];
    for (let i = 0; i < cap; i++) {
      sampled.push(cluster.items[Math.round((i * (n - 1)) / (cap - 1))]);
    }
  }
  return { ...cluster, items: sampled };
}
