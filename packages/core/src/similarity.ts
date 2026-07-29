import type { Cluster, MediaItem } from './types.js';

/**
 * Perceptual similarity (m0.4 / desktop v0.6+): difference-hash (dHash)
 * computation over a caller-supplied grayscale grid, Hamming distance
 * between hashes, and similarity-based refinement of time clusters.
 *
 * Pure logic only — decoding an image into a luma grid is platform work
 * (the apps do it with their own image pipelines); core turns grids into
 * hashes and hashes into grouping decisions.
 */

/** Bits in a dHash. */
export const DHASH_BITS = 64;

/** Hex-string length of a dHash (64 bits → 16 nibbles). */
export const DHASH_HEX_LENGTH = DHASH_BITS / 4;

/**
 * 64-bit difference hash of a grayscale grid, as a 16-char lowercase hex
 * string (serializes to SQLite/JSON cleanly; `hammingDistance` consumes it
 * directly).
 *
 * `luma` is row-major: an array of rows, each row an array of brightness
 * values (any consistent scale — only relative order matters). Each row
 * contributes `row.length - 1` bits via adjacent comparison: bit = 1 when
 * the right pixel is strictly brighter than the left. The canonical input
 * is 8 rows × 9 columns (the classic "9×8" dHash grid); any shape whose
 * comparisons total exactly 64 is accepted (e.g. 16 rows × 5 columns).
 * Bits are emitted top-to-bottom, left-to-right, most significant first.
 */
export function dhash64(luma: readonly (readonly number[])[]): string {
  let bitCount = 0;
  for (const row of luma) {
    if (row.length < 2) {
      throw new Error('dhash64: every row needs at least 2 columns');
    }
    bitCount += row.length - 1;
  }
  if (bitCount !== DHASH_BITS) {
    throw new Error(`dhash64: grid must yield exactly ${DHASH_BITS} comparisons, got ${bitCount}`);
  }
  let hash = 0n;
  for (const row of luma) {
    for (let x = 0; x < row.length - 1; x++) {
      const left = row[x];
      const right = row[x + 1];
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        throw new Error('dhash64: luma values must be finite numbers');
      }
      hash = (hash << 1n) | (right > left ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(DHASH_HEX_LENGTH, '0');
}

const HEX_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

function nibble(hex: string, i: number, source: string): number {
  const v = parseInt(hex[i], 16);
  if (Number.isNaN(v)) {
    throw new Error(`hammingDistance: "${source}" is not a hex string`);
  }
  return v;
}

/**
 * Hamming distance between two equal-length hex-string hashes (number of
 * differing bits, 0–64 for dHashes). Case-insensitive. Throws on length
 * mismatch or non-hex input — a malformed stored hash should surface, not
 * silently count as "similar".
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hammingDistance: length mismatch (${a.length} vs ${b.length})`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += HEX_POPCOUNT[nibble(a, i, a) ^ nibble(b, i, b)];
  }
  return distance;
}

/** Same deterministic cluster-id scheme as clustering.ts. */
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
 * Split each time cluster into perceptual-similarity components.
 *
 * Within a cluster, two hashed photos are connected when
 * `hammingDistance(hashA, hashB) <= threshold`; the refined groups are the
 * CONNECTED COMPONENTS of that graph. Chain-linking is deliberate: if A~B
 * and B~C, then {A, B, C} stay together even when A and C are not directly
 * similar — a burst that drifts (pan, walking subject) is still one moment.
 *
 * Null-hash rule (conservative, exact): a photo whose `hashOf` returns
 * null/undefined cannot be compared, so it is attached to the component of
 * its nearest-by-timestamp hashed neighbor within the same time cluster
 * (ties broken toward the earlier item; equal-distance ties then by input
 * order). If NO photo in the cluster has a hash, the whole cluster is kept
 * intact. A hash failure therefore never splits a photo away from its
 * time cluster on its own.
 *
 * Determinism: components are ordered by their earliest item's position in
 * the input cluster; items inside a component keep the cluster's item
 * order. Cluster ids use the same `${timestamp}:${id}` scheme as
 * clustering.ts, so the component containing a cluster's first item keeps
 * that cluster's id.
 *
 * `threshold` 0 = only bit-identical hashes connect; >= 64 = every hashed
 * pair connects (clusters come back unchanged). Must be a non-negative
 * finite number.
 */
export function refineClustersBySimilarity(
  clusters: readonly Cluster[],
  hashOf: (id: string) => string | null | undefined,
  threshold: number,
): Cluster[] {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(
      `refineClustersBySimilarity: threshold must be a non-negative number, got ${threshold}`,
    );
  }
  const out: Cluster[] = [];
  for (const cluster of clusters) {
    for (const items of splitCluster(cluster.items, hashOf, threshold)) {
      out.push(makeCluster(items));
    }
  }
  return out;
}

function splitCluster(
  items: readonly MediaItem[],
  hashOf: (id: string) => string | null | undefined,
  threshold: number,
): MediaItem[][] {
  if (items.length <= 1) return items.length === 0 ? [] : [[...items]];

  const hashes = items.map((item) => hashOf(item.id) ?? null);
  const hashedIndexes: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (hashes[i] !== null) hashedIndexes.push(i);
  }
  // No comparable photos at all: keep the time cluster intact.
  if (hashedIndexes.length === 0) return [[...items]];

  // Union-find over item indexes.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Edges between hashed photos.
  for (let a = 0; a < hashedIndexes.length; a++) {
    for (let b = a + 1; b < hashedIndexes.length; b++) {
      const ia = hashedIndexes[a];
      const ib = hashedIndexes[b];
      if (hammingDistance(hashes[ia]!, hashes[ib]!) <= threshold) union(ia, ib);
    }
  }

  // Null-hash photos attach to the nearest-by-timestamp hashed neighbor
  // (tie → the earlier item, then input order — hashedIndexes is in input
  // order and `<` keeps the first-best).
  for (let i = 0; i < items.length; i++) {
    if (hashes[i] !== null) continue;
    let bestIdx = hashedIndexes[0];
    let bestDist = Math.abs(items[bestIdx].timestamp - items[i].timestamp);
    for (const j of hashedIndexes) {
      const d = Math.abs(items[j].timestamp - items[i].timestamp);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    union(i, bestIdx);
  }

  // Group by root, preserving input order (root of the earliest member is
  // always the smallest index in the component, so map insertion order =
  // earliest-member order).
  const components = new Map<number, MediaItem[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const bucket = components.get(root);
    if (bucket) bucket.push(items[i]);
    else components.set(root, [items[i]]);
  }
  return [...components.values()];
}
