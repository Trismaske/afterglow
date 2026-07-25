import { clusterByGap, MOMENTS_GAP_MS } from './clustering.js';
import { hammingDistance } from './similarity.js';
import type { MediaItem } from './types.js';

/**
 * Embedding-based cull grouping (m0.8, `docs/Plan_m0.8.md` decision 8) —
 * the grouping engine behind mobile cull groups and (later) desktop
 * organizer culling. A group is a de-duplication aid: visually similar
 * photos that could substitute for each other (PLAN.md "Cull groups —
 * purpose"). Boundary calls err inclusive — a false inclusion costs one
 * eject swipe, a false exclusion costs a navigation loop.
 *
 * Pipeline:
 *   1. Burst gate: gap-based time clustering (3 min default). Groups never
 *      span a burst boundary except through stage 3.
 *   2. Greedy centroid linkage within each burst, chronological: a photo
 *      joins the highest-similarity group whose L2-renormalized centroid
 *      clears the effective threshold for the photo's time gap to that
 *      group — base cosine 0.50, relaxed by a time-decay bonus for gaps
 *      ≤ 60 s (see {@link effectiveLinkThreshold}); otherwise it seeds a
 *      new group.
 *   3. Adjacent-burst merge: groups from different bursts ≤ 15 min apart
 *      merge when BOTH are internally tight (weakest internal pairwise
 *      cosine ≥ 0.55) and their centroids agree (≥ 0.70) — loose stage-2
 *      groups produced bad merges in the judged rounds even at centroid
 *      0.84, tight ones were 11/12 correct.
 *   4. dHash floor: within a burst, a pair at Hamming ≤ 8/64 is an
 *      exact/near duplicate — it is force-linked (byte-identical
 *      duplicates are the grouping floor) and annotated in
 *      `nearDupPairs` for the UI. This is dHash's only surviving role;
 *      never global pairwise linking (it chains into mega-groups).
 *
 * Embeddings are MediaPipe MobileNetV3-large float32, L2-normalized
 * (`apps/mobile/modules/image-embedder`), injected as a lookup like
 * `hashOf` — core never touches image bytes. Cosine similarity is the
 * plain dot product because the vectors are unit-length by contract.
 *
 * A photo with no embedding (not computed yet, or failed) cannot be
 * compared, so it attaches BY TIME to the group of its nearest-embedded
 * neighbor within the burst — the inclusive boundary policy made literal
 * (Tristan, 2026-07-25: ejecting is one tap, promoting a single into a
 * group is impossible, so err liberal), mirroring the old
 * refineClustersBySimilarity null rule. A burst with NO embedded photo
 * stays intact as one group. Every photo attached this way is reported in
 * the group's `timeAttached` so the UI can badge "auto-grouped to a
 * temporal neighbour"; the scan regroups it properly once its embedding
 * lands. The dHash floor, when it fires, is a real match — not a time
 * attachment. 1-photo groups are singles — callers decide their own
 * "counts as a group" threshold, as with clusterByGap.
 *
 * Quality is pinned by the committed regression suite
 * (`docs/grouping-study/labels-v1.json` replayed in
 * `test/grouping.test.ts`); threshold constants below were fitted against
 * it (`docs/grouping-study/fit_curve.mjs`). Changing any constant means
 * deliberately re-pinning the baseline.
 */

/** Burst gate: max silence between consecutive shots in one burst. */
export const BURST_GAP_MS = MOMENTS_GAP_MS;

/** Base cosine threshold for joining a group (decision 8). */
export const LINK_BASE_THRESHOLD = 0.5;

/** Time gap beyond which no bonus applies (violations dominate there). */
export const LINK_BONUS_WINDOW_MS = 60_000;

/**
 * Fitted required-similarity floor `f(gap) = FLOOR_FAR + (FLOOR_NEAR -
 * FLOOR_FAR) * exp(-gap / TAU)`: a smooth decay through the measured
 * 90%-link floors by gap band on labels-v1 (≤5 s → ~0.55, 5–20 s → ~0.49,
 * 20–60 s → ~0.42; exact percentiles in fit_curve.mjs). True same-group
 * shots drift apart in embedding space as seconds pass, so the required
 * similarity decays with the gap.
 */
const LINK_FLOOR_NEAR = 0.569;
const LINK_FLOOR_FAR = 0.384;
const LINK_FLOOR_TAU_MS = 39_000;

/** Max gap between two bursts' groups for the adjacent-burst merge. */
export const ADJACENT_MERGE_MAX_GAP_MS = 15 * 60_000;

/** Both merge candidates' weakest internal pairwise cosine must clear this. */
export const ADJACENT_MERGE_MIN_INTERNAL = 0.55;

/** Merge candidates' centroid cosine must clear this. */
export const ADJACENT_MERGE_MIN_CENTROID = 0.7;

/** dHash Hamming distance (of 64) at or under which a pair is a near dup. */
export const NEAR_DUP_MAX_BITS = 8;

/** Options for {@link groupByEmbedding}; defaults are the fitted constants. */
export interface EmbedGroupingOptions {
  burstGapMs?: number;
  baseThreshold?: number;
  bonusWindowMs?: number;
  /** Required-similarity floor curve; override only from the fit harness. */
  floorNear?: number;
  floorFar?: number;
  floorTauMs?: number;
  adjacentMergeMaxGapMs?: number;
  adjacentMergeMinInternal?: number;
  adjacentMergeMinCentroid?: number;
  nearDupMaxBits?: number;
}

/** A near-duplicate pair annotation (dHash floor), `a` earlier than `b`. */
export interface NearDupPair {
  a: string;
  b: string;
  /** Hamming distance between the pair's dHashes (0 = identical hash). */
  bits: number;
}

/**
 * An embedding cull group. Same deterministic id scheme as Cluster
 * (`${timestamp}:${id}` of the first item); items chronological.
 */
export interface EmbedGroup {
  id: string;
  items: MediaItem[];
  start: number;
  end: number;
  /** Exact/near-duplicate pairs inside this group (UI badge material). */
  nearDupPairs: NearDupPair[];
  /** Members grouped by TIME because their embedding was unavailable
   * (UI badges these; the scan regroups them once embedded). */
  timeAttached: string[];
}

/**
 * Effective cosine threshold for linking a photo to a group across a time
 * gap: `min(base, f(gap))` inside the bonus window, `base` beyond it. The
 * floor `f` decays smoothly with the gap (fitted on labels-v1), so the
 * bonus `base - f(gap)` grows from 0 at near-instant gaps (where true
 * links are so similar the base threshold already keeps ≥90% of them) to
 * ~0.08 near 60 s, then cuts off — beyond a minute, lowering the bar
 * mostly links pairs humans judged apart. The bonus only ever relaxes the
 * bar, mirroring groupBySimilarity's time bonus: time proximity never
 * excludes.
 */
export function effectiveLinkThreshold(
  gapMs: number,
  options?: Pick<
    EmbedGroupingOptions,
    'baseThreshold' | 'bonusWindowMs' | 'floorNear' | 'floorFar' | 'floorTauMs'
  >,
): number {
  const base = options?.baseThreshold ?? LINK_BASE_THRESHOLD;
  const windowMs = options?.bonusWindowMs ?? LINK_BONUS_WINDOW_MS;
  const near = options?.floorNear ?? LINK_FLOOR_NEAR;
  const far = options?.floorFar ?? LINK_FLOOR_FAR;
  const tauMs = options?.floorTauMs ?? LINK_FLOOR_TAU_MS;
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new Error(`effectiveLinkThreshold: gapMs must be a non-negative number, got ${gapMs}`);
  }
  for (const [name, value] of Object.entries({ base, windowMs, near, far })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `effectiveLinkThreshold: ${name} must be a non-negative number, got ${value}`,
      );
    }
  }
  if (!Number.isFinite(tauMs) || tauMs <= 0) {
    // tau 0 would divide to NaN and silently split identical-timestamp
    // photos — a bad override must fail loudly instead.
    throw new Error(`effectiveLinkThreshold: floorTauMs must be positive, got ${tauMs}`);
  }
  if (gapMs > windowMs) return base;
  const floor = far + (near - far) * Math.exp(-gapMs / tauMs);
  return Math.min(base, floor);
}

/** Dot product of two same-length vectors (= cosine for unit vectors). */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Internal working group during linkage/merge. */
interface WorkGroup {
  /** Indexes into the sorted item array, chronological. */
  members: number[];
  /** Running component-wise sum of member vectors (embedded members only). */
  sum: Float64Array | null;
  /** Count of embedded members contributing to `sum`. */
  vecCount: number;
  /** Every burst this group holds photos from — the merge stage refuses
   * pairs whose burst sets overlap (stage-2 already decided those splits;
   * a merged group must not re-approach its own bursts' remnants through
   * a friendlier centroid). */
  bursts: Set<number>;
}

/** L2-renormalized centroid of a group, or null when no member has a vector. */
function centroidOf(group: WorkGroup): Float32Array | null {
  if (group.sum === null || group.vecCount === 0) return null;
  let normSq = 0;
  for (let i = 0; i < group.sum.length; i++) normSq += group.sum[i] * group.sum[i];
  const norm = Math.sqrt(normSq);
  if (norm < 1e-12) return null;
  const out = new Float32Array(group.sum.length);
  for (let i = 0; i < group.sum.length; i++) out[i] = group.sum[i] / norm;
  return out;
}

/**
 * Group photos into cull groups by embedding similarity (see the module
 * header for the pipeline and semantics).
 *
 * `vecOf` returns the photo's L2-normalized embedding (or null/undefined
 * when not embedded yet); all returned vectors must share one dimension.
 * `hashOf` optionally returns the photo's 64-bit dHash hex string for the
 * near-duplicate floor; omit it (or return null) to skip that stage.
 *
 * Determinism: input order is irrelevant — items are sorted
 * chronologically (ties by id) first. Groups come back ordered by
 * earliest member; members are chronological within each group.
 */
export function groupByEmbedding(
  items: readonly MediaItem[],
  vecOf: (id: string) => Float32Array | null | undefined,
  hashOf?: (id: string) => string | null | undefined,
  options?: EmbedGroupingOptions,
): EmbedGroup[] {
  const burstGapMs = options?.burstGapMs ?? BURST_GAP_MS;
  const mergeMaxGapMs = options?.adjacentMergeMaxGapMs ?? ADJACENT_MERGE_MAX_GAP_MS;
  const mergeMinInternal = options?.adjacentMergeMinInternal ?? ADJACENT_MERGE_MIN_INTERNAL;
  const mergeMinCentroid = options?.adjacentMergeMinCentroid ?? ADJACENT_MERGE_MIN_CENTROID;
  const nearDupMaxBits = options?.nearDupMaxBits ?? NEAR_DUP_MAX_BITS;
  for (const [name, value] of Object.entries({
    burstGapMs,
    mergeMaxGapMs,
    mergeMinInternal,
    mergeMinCentroid,
    nearDupMaxBits,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`groupByEmbedding: ${name} must be a non-negative number, got ${value}`);
    }
  }

  const sorted = [...items].sort(
    (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let dim = -1;
  const vecs: (Float32Array | null)[] = sorted.map((item) => {
    const vec = vecOf(item.id) ?? null;
    if (vec === null) return null;
    if (dim === -1) dim = vec.length;
    if (vec.length !== dim || dim === 0) {
      throw new Error(
        `groupByEmbedding: embedding dimension mismatch for "${item.id}" (${vec.length} vs ${dim})`,
      );
    }
    return vec;
  });
  const hashes: (string | null)[] = sorted.map((item) => hashOf?.(item.id) ?? null);

  // Stage 1 — burst gate. clusterByGap re-sorts identically, so cluster
  // items map back to `sorted` indexes by identity.
  const indexOf = new Map(sorted.map((item, i) => [item, i]));
  const bursts = clusterByGap(sorted, { gapMs: burstGapMs }).map((c) =>
    c.items.map((item) => indexOf.get(item)!),
  );

  // Stage 2 — greedy centroid linkage within each burst, plus the dHash
  // near-dup floor (union of both edge sets, floor edges recorded).
  const groups: WorkGroup[] = [];
  const timeAttachedIdx = new Set<number>();
  for (let burst = 0; burst < bursts.length; burst++) {
    const burstGroups: WorkGroup[] = [];
    for (const idx of bursts[burst]) {
      const vec = vecs[idx];
      let joined: WorkGroup | null = null;
      if (vec !== null) {
        let bestSim = -Infinity;
        for (const g of burstGroups) {
          const centroid = centroidOf(g);
          if (centroid === null) continue;
          const sim = dot(vec, centroid);
          // Gap to the group's temporally nearest member — the last one,
          // since members are chronological and idx comes after all of them.
          const gapMs = sorted[idx].timestamp - sorted[g.members[g.members.length - 1]].timestamp;
          if (sim >= effectiveLinkThreshold(gapMs, options) && sim > bestSim) {
            bestSim = sim;
            joined = g;
          }
        }
      }
      if (joined === null) {
        // dHash floor: an exact/near duplicate of an earlier photo in this
        // burst joins that photo's group even when embeddings disagree or
        // are missing (byte-identical duplicates are the grouping floor).
        const hash = hashes[idx];
        if (hash !== null) {
          outer: for (const g of burstGroups) {
            for (const m of g.members) {
              const other = hashes[m];
              if (other !== null && hammingDistance(hash, other) <= nearDupMaxBits) {
                joined = g;
                break outer;
              }
            }
          }
        }
      }
      if (joined === null) {
        joined = { members: [], sum: null, vecCount: 0, bursts: new Set([burst]) };
        burstGroups.push(joined);
      }
      joined.members.push(idx);
      if (vec !== null) {
        if (joined.sum === null) joined.sum = new Float64Array(dim);
        for (let i = 0; i < dim; i++) joined.sum[i] += vec[i];
        joined.vecCount++;
      }
    }
    // dHash floor as a UNION over the whole burst: the greedy pass above
    // only consults hashes for photos no group claimed, so a photo that
    // centroid-joined group A while being a near duplicate of a member of
    // group B would leave A and B split — the floor promises they unite.
    // Union-find over burst groups connected by any near-dup pair.
    if (burstGroups.length > 1) {
      const groupOfIdx = new Map<number, number>();
      burstGroups.forEach((g, gi) => g.members.forEach((m) => groupOfIdx.set(m, gi)));
      const parent = burstGroups.map((_, gi) => gi);
      const find = (i: number): number => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      const hashedIdx = bursts[burst].filter((i) => hashes[i] !== null);
      for (let a = 0; a < hashedIdx.length; a++) {
        for (let b = a + 1; b < hashedIdx.length; b++) {
          const ia = hashedIdx[a];
          const ib = hashedIdx[b];
          if (hammingDistance(hashes[ia]!, hashes[ib]!) > nearDupMaxBits) continue;
          const ra = find(groupOfIdx.get(ia)!);
          const rb = find(groupOfIdx.get(ib)!);
          if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
      for (let gi = burstGroups.length - 1; gi >= 0; gi--) {
        const root = find(gi);
        if (root === gi) continue;
        const target = burstGroups[root];
        const source = burstGroups[gi];
        target.members.push(...source.members);
        target.members.sort((a, b) => a - b);
        if (source.sum !== null) {
          if (target.sum === null) target.sum = new Float64Array(dim);
          for (let i = 0; i < dim; i++) target.sum[i] += source.sum[i];
        }
        target.vecCount += source.vecCount;
        burstGroups.splice(gi, 1);
      }
    }

    // Time attachment (inclusive policy): an unembedded, un-dHash-linked
    // singleton joins the group of its nearest-by-timestamp EMBEDDED
    // photo in the burst (tie → the earlier photo); a burst with no
    // embedded photo at all collapses into one intact group. Both mirror
    // refineClustersBySimilarity's null rule.
    const burstIdx = bursts[burst];
    const embeddedIdx = burstIdx.filter((i) => vecs[i] !== null);
    if (embeddedIdx.length === 0) {
      if (burstGroups.length > 1) {
        // Badge only the photos whose GROUPING here is time-evidence-only:
        // members of dHash-linked multi-photo groups have a real match and
        // stay unbadged even as the burst collapses around them.
        for (const g of burstGroups) {
          if (g.members.length === 1) timeAttachedIdx.add(g.members[0]);
        }
        const [first, ...rest] = burstGroups;
        for (const g of rest) first.members.push(...g.members);
        first.members.sort((a, b) => a - b);
        burstGroups.length = 1;
      }
    } else {
      for (const g of [...burstGroups]) {
        if (g.members.length !== 1 || vecs[g.members[0]] !== null) continue;
        const idx = g.members[0];
        let best = embeddedIdx[0];
        let bestDist = Math.abs(sorted[best].timestamp - sorted[idx].timestamp);
        for (const j of embeddedIdx) {
          const d = Math.abs(sorted[j].timestamp - sorted[idx].timestamp);
          if (d < bestDist || (d === bestDist && j < best)) {
            bestDist = d;
            best = j;
          }
        }
        const target = burstGroups.find((bg) => bg.members.includes(best))!;
        target.members.push(idx);
        target.members.sort((a, b) => a - b);
        timeAttachedIdx.add(idx);
        burstGroups.splice(burstGroups.indexOf(g), 1);
      }
    }
    groups.push(...burstGroups);
  }

  // Stage 3 — adjacent-burst merge, greedy best-first: repeatedly merge
  // the qualifying pair with the highest centroid similarity. Tightness is
  // re-checked after every merge, so a chain only continues while the
  // grown group stays internally tight. Groups without embeddings never
  // merge (no centroid to agree on).
  const weakestInternal = (g: WorkGroup): number => {
    let weakest = Infinity;
    for (let x = 0; x < g.members.length; x++) {
      const a = vecs[g.members[x]];
      if (a === null) continue;
      for (let y = x + 1; y < g.members.length; y++) {
        const b = vecs[g.members[y]];
        if (b === null) continue;
        const sim = dot(a, b);
        if (sim < weakest) weakest = sim;
      }
    }
    return weakest; // Infinity when < 2 embedded members (vacuously tight).
  };
  const startOf = (g: WorkGroup): number => sorted[g.members[0]].timestamp;
  const endOf = (g: WorkGroup): number => sorted[g.members[g.members.length - 1]].timestamp;
  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let bestSim = -Infinity;
    for (let a = 0; a < groups.length; a++) {
      const ga = groups[a];
      if (weakestInternal(ga) < mergeMinInternal) continue;
      const ca = centroidOf(ga);
      if (ca === null) continue;
      for (let b = a + 1; b < groups.length; b++) {
        const gb = groups[b];
        if ([...gb.bursts].some((x) => ga.bursts.has(x))) continue;
        const gap = Math.max(startOf(ga), startOf(gb)) - Math.min(endOf(ga), endOf(gb));
        if (gap > mergeMaxGapMs) continue;
        if (weakestInternal(gb) < mergeMinInternal) continue;
        const cb = centroidOf(gb);
        if (cb === null) continue;
        const sim = dot(ca, cb);
        if (sim >= mergeMinCentroid && sim > bestSim) {
          bestSim = sim;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA === -1) break;
    const ga = groups[bestA];
    const gb = groups[bestB];
    ga.members = [...ga.members, ...gb.members].sort((x, y) => x - y);
    for (let i = 0; i < dim; i++) ga.sum![i] += gb.sum![i];
    ga.vecCount += gb.vecCount;
    // The merged group now represents BOTH burst sets — further merges
    // must not overlap either (stage-2 already split those remnants).
    for (const x of gb.bursts) ga.bursts.add(x);
    groups.splice(bestB, 1);
  }

  // Assemble output: near-dup annotation over final members (time-gated by
  // the burst, which every same-burst pair inside a group satisfies; a
  // cross-burst merged pair is annotated too when hashes match — it is
  // still a near duplicate to the user).
  groups.sort((a, b) => a.members[0] - b.members[0]);
  return groups.map((g) => {
    const nearDupPairs: NearDupPair[] = [];
    for (let x = 0; x < g.members.length; x++) {
      const ha = hashes[g.members[x]];
      if (ha === null) continue;
      for (let y = x + 1; y < g.members.length; y++) {
        const hb = hashes[g.members[y]];
        if (hb === null) continue;
        const bits = hammingDistance(ha, hb);
        if (bits <= nearDupMaxBits) {
          nearDupPairs.push({ a: sorted[g.members[x]].id, b: sorted[g.members[y]].id, bits });
        }
      }
    }
    const members = g.members.map((i) => sorted[i]);
    const first = members[0];
    const last = members[members.length - 1];
    return {
      id: `${first.timestamp}:${first.id}`,
      items: members,
      start: first.timestamp,
      end: last.timestamp,
      nearDupPairs,
      timeAttached: g.members.filter((i) => timeAttachedIdx.has(i)).map((i) => sorted[i].id),
    };
  });
}
