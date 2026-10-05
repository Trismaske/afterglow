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
 *   3. Adjacent-burst merge: groups from different bursts ≤ 60 min apart
 *      merge when BOTH are internally tight (weakest internal pairwise
 *      cosine ≥ 0.55) and their centroids agree (≥ 0.70) — loose stage-2
 *      groups produced bad merges in the judged rounds even at centroid
 *      0.84, tight ones were 11/12 correct. A SINGLE joining a group
 *      takes its own bar (≥ 0.73) with no tightness test on the group
 *      (m0.9 phase 10): the tightness rule guards two loose groups
 *      merging, not one photo joining. Beyond 15 min the FAR bar applies
 *      on top (phase 10, Tristan 2026-10-05): one member pair across the
 *      two units must reach 0.85 — the same shot again, not the same
 *      place. The judged far pairs showed no centroid bar that separates
 *      the same vantage from the same canyon; the best member pair at
 *      0.85 joined 2 of 10 wanted pairs for 1 wrong one, and the window
 *      at 60 min reaches the lighthouse shot 21 min after its pair.
 *   4. dHash floor: within a burst, a pair at Hamming ≤ 8/64 is an
 *      exact/near duplicate — it is force-linked (byte-identical
 *      duplicates are the grouping floor) and annotated in
 *      `nearDupPairs` for the UI. This is dHash's only surviving role;
 *      never global pairwise linking (it chains into mega-groups).
 *   5. Parts (m0.9 phase 10): every final group of `subgroupMinSize` or
 *      more members is re-linked WITHIN itself (chronological centroid
 *      linkage, no time bonus) at a bar relative to the group's own
 *      look — its mean pairwise cosine, floored at 0.60 — and the result
 *      is reported as `parts`. Membership is untouched: a part is
 *      presentation, the deck orders the group part by part with a
 *      divider between them. The device rounds (docs/grouping-study)
 *      showed the reviewer splits a tight group near 0.9 and a loose
 *      one near 0.6: the cut is relative to the group, not absolute. The
 *      dHash floor and cannot-link hold inside the parts as they do for
 *      groups. A group above {@link SUBGROUP_MAX_SIZE} members is one
 *      part (the pass is quadratic in the group).
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
 * Cannot-link constraints (m0.8.7, docs/Regroup_design.md §4): callers
 * may inject user judgments that two photos are NOT related
 * (`options.cannotLink`, symmetric pairs). A forbidden pair never shares
 * a final group — user judgment outranks every stage, the dHash floor
 * included. Enforcement: stage-2 linkage skips conflicting groups,
 * the dHash union refuses a union seating a forbidden pair, time
 * attachment falls back to the nearest ALLOWED embedded neighbour (or
 * leaves the photo single), the no-embedding burst collapse partitions
 * into as few conflict-free groups as the pairs allow, and the
 * adjacent-burst merge skips conflicting pairs. Ids not present in
 * `items` are ignored; a self-pair is a caller bug and throws.
 *
 * Quality is pinned by the committed regression suites
 * (`docs/grouping-study/labels-v1.json` and `device-rounds-v1.json` —
 * the judged device rounds at the group and the part level — both
 * replayed in `test/grouping.test.ts`); threshold constants below were
 * fitted against them (`docs/grouping-study/fit_curve.mjs`, the phase-10
 * device rounds).
 * Changing any constant means deliberately re-pinning the baseline.
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
export const ADJACENT_MERGE_MAX_GAP_MS = 60 * 60_000;
/** Far merge (header step 3): beyond this gap the far bar applies. */
export const FAR_MERGE_GAP_MS = 15 * 60_000;
/** Far merge: the best member pair across the two units must reach this. */
export const FAR_MERGE_MIN_BEST_PAIR = 0.85;
/** The grouping rules' version: the constants above and the parts pass.
 * The scan stores it beside its baseline and runs a full pass when it
 * changes — a rule change regroups the whole library, deliberately. */
export const GROUPING_RULES_VERSION = 'm0.9-p10';

/** Both merge candidates' weakest internal pairwise cosine must clear this. */
export const ADJACENT_MERGE_MIN_INTERNAL = 0.55;

/** Merge candidates' centroid cosine must clear this. */
export const ADJACENT_MERGE_MIN_CENTROID = 0.7;
/**
 * A SINGLE joining an adjacent-burst group takes this bar on its own
 * (m0.9 phase 10, re-pinned 2026-10-05 on the device round): the
 * tightness rule above guards two loose groups merging, not one photo
 * joining — a 33-shot afternoon fails the tightness test forever, and
 * its stragglers three to nine minutes away at 0.73–0.82 were judged
 * "should join" 5 of 5; the two judged "correctly apart" sat at
 * 0.70–0.72. Replayed over the device vectors: five joins gained,
 * nothing lost, the library's group count unchanged.
 */
export const ADJACENT_MERGE_SINGLE_MIN_CENTROID = 0.73;

/** dHash Hamming distance (of 64) at or under which a pair is a near dup. */
export const NEAR_DUP_MAX_BITS = 8;

/** Parts: smallest group that is cut into parts (smaller groups are one part). */
export const SUBGROUP_MIN_SIZE = 3;
/** Parts: largest group that is cut — above it a group is ONE part. The
 * pass holds an n² cosine table and, in its worst case (every cluster
 * pointing at one root), re-derives O(n) partners per merge, so a
 * timelapse-sized group would stall the scan's synchronous path.
 * Measured on the workstation (identical vectors, the worst case /
 * random 1280-d): 200 members 28 / 65 ms, 400 members 146 / 239 ms — a
 * 2019 phone runs this JS five to ten times slower, so 200 keeps the
 * stall under a second. Callers may log a group that hits this. */
export const SUBGROUP_MAX_SIZE = 200;
/** Parts: the relative bar never drops below this cosine. */
export const SUBGROUP_FLOOR = 0.6;

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
  /** User "not related" judgments: symmetric photo-id pairs that must
   * never share a group (module header, "Cannot-link constraints"). */
  cannotLink?: ReadonlyArray<readonly [string, string]>;
  /**
   * Phase-10 candidates (m0.9, docs/grouping-study/replay_device.mjs);
   * the ones still OFF by default leave the frozen labels-v1 baseline
   * untouched until a judged round re-pins them:
   * - `consolidateSingles`: after a burst's greedy linkage, every
   *   single with a vector is re-tested against the burst's FINISHED
   *   group centroids at the base threshold (no time bonus) and joins
   *   the best — the chronological pass strands a photo whose look-alike
   *   arrives later (device round 1: a 0.85 pair 8 s apart left as two).
   * - `adjacentMergeSingleMinCentroid` (ON by default, see the
   *   constant): a single (no internal pairs) may join an adjacent-burst
   *   group whose centroid clears this bar even when that group fails
   *   the tightness test; override only from the replay harness.
   * - `subgroupMinSize` / `subgroupThreshold`: the parts pass (header
   *   step 5). `'relative'` (the default) cuts each group at its own
   *   mean pairwise cosine floored at {@link SUBGROUP_FLOOR}; a number is
   *   an absolute bar for the replay harness.
   */
  consolidateSingles?: boolean;
  adjacentMergeSingleMinCentroid?: number;
  /** The far bar (header step 3): beyond `farMergeGapMs` an adjacent
   * merge ALSO needs one member pair across the two units at or above
   * `farMergeMinBestPair`; override only from the replay harness. */
  farMergeMinBestPair?: number;
  farMergeGapMs?: number;
  subgroupMinSize?: number;
  subgroupThreshold?: number | 'relative';
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
  /** The group's parts (header step 5): every member id in exactly one
   * part, parts in order of their first member, members chronological
   * inside a part. A group below `subgroupMinSize` is one part. */
  parts: string[][];
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
  const singleMinCentroid =
    options?.adjacentMergeSingleMinCentroid ?? ADJACENT_MERGE_SINGLE_MIN_CENTROID;
  const farMinBestPair = options?.farMergeMinBestPair ?? FAR_MERGE_MIN_BEST_PAIR;
  const farGapMs = options?.farMergeGapMs ?? FAR_MERGE_GAP_MS;
  for (const [name, value] of Object.entries({
    burstGapMs,
    mergeMaxGapMs,
    mergeMinInternal,
    mergeMinCentroid,
    nearDupMaxBits,
    singleMinCentroid,
    farMinBestPair,
    farGapMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`groupByEmbedding: ${name} must be a non-negative number, got ${value}`);
    }
  }
  const subMin = options?.subgroupMinSize ?? SUBGROUP_MIN_SIZE;
  const subThreshold = options?.subgroupThreshold ?? 'relative';
  if (!Number.isInteger(subMin) || subMin < 2) {
    throw new Error(`groupByEmbedding: subgroupMinSize must be an integer ≥ 2, got ${subMin}`);
  }
  if (subThreshold !== 'relative' && (!Number.isFinite(subThreshold) || subThreshold < 0)) {
    throw new Error(
      `groupByEmbedding: subgroupThreshold must be 'relative' or a non-negative number, got ${String(subThreshold)}`,
    );
  }

  // Symmetric cannot-link lookup. Empty map = every check short-circuits,
  // so the labels-v1 baseline path pays nothing.
  const forbidden = new Map<string, Set<string>>();
  for (const pair of options?.cannotLink ?? []) {
    const [a, b] = pair;
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) {
      throw new Error(`groupByEmbedding: invalid cannotLink pair [${String(a)}, ${String(b)}]`);
    }
    let setA = forbidden.get(a);
    if (setA === undefined) forbidden.set(a, (setA = new Set()));
    setA.add(b);
    let setB = forbidden.get(b);
    if (setB === undefined) forbidden.set(b, (setB = new Set()));
    setB.add(a);
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

  /** Would adding `idx` to `g` seat a forbidden pair? */
  const conflictsWith = (g: WorkGroup, idx: number): boolean => {
    if (forbidden.size === 0) return false;
    const set = forbidden.get(sorted[idx].id);
    if (set === undefined) return false;
    return g.members.some((m) => set.has(sorted[m].id));
  };
  /** Would merging `ga` and `gb` seat a forbidden pair? */
  const groupsConflict = (ga: WorkGroup, gb: WorkGroup): boolean => {
    if (forbidden.size === 0) return false;
    return ga.members.some((m) => {
      const set = forbidden.get(sorted[m].id);
      return set !== undefined && gb.members.some((n) => set.has(sorted[n].id));
    });
  };

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
          if (conflictsWith(g, idx)) continue;
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
            // Cannot-link outranks the dHash floor (user judgment wins).
            if (conflictsWith(g, idx)) continue;
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
      // Accumulated member-id sets per union root, so a union that would
      // seat a forbidden pair can be refused with the sets in hand
      // (cannot-link outranks the dHash floor).
      const rootIds: Set<string>[] = burstGroups.map(
        (g) => new Set(g.members.map((m) => sorted[m].id)),
      );
      const rootsConflict = (ra: number, rb: number): boolean => {
        if (forbidden.size === 0) return false;
        for (const id of rootIds[ra]) {
          const set = forbidden.get(id);
          if (set === undefined) continue;
          for (const other of rootIds[rb]) if (set.has(other)) return true;
        }
        return false;
      };
      const hashedIdx = bursts[burst].filter((i) => hashes[i] !== null);
      for (let a = 0; a < hashedIdx.length; a++) {
        for (let b = a + 1; b < hashedIdx.length; b++) {
          const ia = hashedIdx[a];
          const ib = hashedIdx[b];
          if (hammingDistance(hashes[ia]!, hashes[ib]!) > nearDupMaxBits) continue;
          const ra = find(groupOfIdx.get(ia)!);
          const rb = find(groupOfIdx.get(ib)!);
          if (ra === rb || rootsConflict(ra, rb)) continue;
          const lo = Math.min(ra, rb);
          const hi = Math.max(ra, rb);
          parent[hi] = lo;
          for (const id of rootIds[hi]) rootIds[lo].add(id);
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
        // Collapse into as FEW groups as the cannot-link pairs allow,
        // greedy in group order (deterministic; one bucket when no pairs
        // apply — the original whole-burst collapse). Badge only photos
        // whose grouping here is time-evidence-only: singleton sources
        // that actually merged with something; dHash-linked multi-photo
        // groups have a real match and stay unbadged, and a singleton the
        // constraints keep alone stays a real single.
        const buckets: { g: WorkGroup; singles: number[]; sources: number }[] = [];
        for (const g of burstGroups) {
          const single = g.members.length === 1 ? g.members[0] : null;
          const target = buckets.find((b) => !groupsConflict(b.g, g));
          if (target === undefined) {
            buckets.push({ g, singles: single !== null ? [single] : [], sources: 1 });
          } else {
            target.g.members.push(...g.members);
            if (single !== null) target.singles.push(single);
            target.sources++;
          }
        }
        for (const b of buckets) {
          b.g.members.sort((x, y) => x - y);
          if (b.sources > 1) for (const s of b.singles) timeAttachedIdx.add(s);
        }
        burstGroups.length = 0;
        burstGroups.push(...buckets.map((b) => b.g));
      }
    } else {
      for (const g of [...burstGroups]) {
        if (g.members.length !== 1 || vecs[g.members[0]] !== null) continue;
        const idx = g.members[0];
        // Embedded neighbours by time distance (tie → earlier photo); the
        // photo attaches to the nearest one whose group the cannot-link
        // pairs allow, and stays a real single when none do.
        const ranked = [...embeddedIdx].sort((a, b) => {
          const da = Math.abs(sorted[a].timestamp - sorted[idx].timestamp);
          const db = Math.abs(sorted[b].timestamp - sorted[idx].timestamp);
          return da - db || a - b;
        });
        let target: WorkGroup | null = null;
        for (const j of ranked) {
          const candidate = burstGroups.find((bg) => bg.members.includes(j))!;
          if (conflictsWith(candidate, idx)) continue;
          target = candidate;
          break;
        }
        if (target === null) continue;
        target.members.push(idx);
        target.members.sort((a, b) => a - b);
        timeAttachedIdx.add(idx);
        burstGroups.splice(burstGroups.indexOf(g), 1);
      }
    }
    // Phase-10 option: singles re-tested against the burst's finished
    // centroids at the base threshold (no time bonus).
    if (options?.consolidateSingles && burstGroups.length > 1) {
      const base = options.baseThreshold ?? LINK_BASE_THRESHOLD;
      for (const g of [...burstGroups]) {
        if (g.members.length !== 1) continue;
        const idx = g.members[0];
        const vec = vecs[idx];
        if (vec === null) continue;
        let best: WorkGroup | null = null;
        let bestSim = -Infinity;
        for (const other of burstGroups) {
          if (other === g || other.members.length < 2 || conflictsWith(other, idx)) continue;
          const centroid = centroidOf(other);
          if (centroid === null) continue;
          const sim = dot(vec, centroid);
          if (sim >= base && sim > bestSim) {
            bestSim = sim;
            best = other;
          }
        }
        if (best === null) continue;
        best.members.push(idx);
        best.members.sort((a, b) => a - b);
        if (best.sum === null) best.sum = new Float64Array(dim);
        for (let i = 0; i < dim; i++) best.sum[i] += vec[i];
        best.vecCount++;
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
  /** The best and the weakest member pair across two groups (-Infinity /
   * Infinity when no embedded pair exists). */
  const pairsAcross = (ga: WorkGroup, gb: WorkGroup): { max: number; min: number } => {
    let max = -Infinity;
    let min = Infinity;
    for (const x of ga.members) {
      const a = vecs[x];
      if (a === null) continue;
      for (const y of gb.members) {
        const b = vecs[y];
        if (b === null) continue;
        const sim = dot(a, b);
        if (sim > max) max = sim;
        if (sim < min) min = sim;
      }
    }
    return { max, min };
  };
  // The weakest internal pair, cached per group and carried through
  // merges (codex): the merged group's weakest is the min of both sides'
  // and of the weakest pair across them. Recomputing it per group per
  // best-first iteration was quadratic in the grown group every time.
  const weakestCache = new Map<WorkGroup, number>();
  const weakestOf = (g: WorkGroup): number => {
    let w = weakestCache.get(g);
    if (w === undefined) weakestCache.set(g, (w = weakestInternal(g)));
    return w;
  };
  // The far pair, cached per pair of groups and carried through merges
  // (codex): the best-first loop re-examines every candidate pair after
  // each merge, and a window of several hundred groups beyond the 15 min
  // bar would otherwise recompute every member-pair cosine each time
  // (358 separately burst-gated look-alikes: 15.8 s → see the test). A
  // merged group's row is the max of the two rows where both were
  // computed, and lazily recomputed where either was not.
  const farBest = new Map<WorkGroup, Map<WorkGroup, number>>();
  const farRow = (g: WorkGroup): Map<WorkGroup, number> => {
    let row = farBest.get(g);
    if (row === undefined) farBest.set(g, (row = new Map()));
    return row;
  };
  const farPair = (ga: WorkGroup, gb: WorkGroup): number => {
    const hit = farBest.get(ga)?.get(gb);
    if (hit !== undefined) return hit;
    const value = pairsAcross(ga, gb).max;
    farRow(ga).set(gb, value);
    farRow(gb).set(ga, value);
    return value;
  };
  // The centroid and the centroid cosine per pair, cached the same way
  // (codex): the best-first loop compared every pair's centroids again
  // after each merge — the cubic term that remained once the far pair
  // and the tightness were carried (358 look-alike bursts: 4.9 s → the
  // test's bound). A merged group's centroid and its row are dropped
  // and recomputed lazily; every other pair keeps its cosine.
  const centroidCache = new Map<WorkGroup, Float32Array | null>();
  const centroidCached = (g: WorkGroup): Float32Array | null => {
    let c = centroidCache.get(g);
    if (c === undefined) centroidCache.set(g, (c = centroidOf(g)));
    return c;
  };
  const centSim = new Map<WorkGroup, Map<WorkGroup, number>>();
  const centSimOf = (ga: WorkGroup, ca: Float32Array, gb: WorkGroup, cb: Float32Array): number => {
    const hit = centSim.get(ga)?.get(gb);
    if (hit !== undefined) return hit;
    const value = dot(ca, cb);
    let rowA = centSim.get(ga);
    if (rowA === undefined) centSim.set(ga, (rowA = new Map()));
    rowA.set(gb, value);
    let rowB = centSim.get(gb);
    if (rowB === undefined) centSim.set(gb, (rowB = new Map()));
    rowB.set(ga, value);
    return value;
  };
  /** Carry every cache through the merge of gb into ga. */
  const merged = (ga: WorkGroup, gb: WorkGroup): void => {
    const across = pairsAcross(ga, gb);
    weakestCache.set(ga, Math.min(weakestOf(ga), weakestOf(gb), across.min));
    weakestCache.delete(gb);
    centroidCache.delete(ga);
    centroidCache.delete(gb);
    centSim.delete(ga);
    centSim.delete(gb);
    for (const c of groups) {
      const row = centSim.get(c);
      row?.delete(ga);
      row?.delete(gb);
    }
    const rowA = farRow(ga);
    const rowB = farBest.get(gb);
    for (const c of groups) {
      if (c === ga || c === gb) continue;
      const a = rowA.get(c);
      const b = rowB?.get(c);
      const rowC = farBest.get(c);
      rowC?.delete(gb);
      if (a !== undefined && b !== undefined) {
        const max = Math.max(a, b);
        rowA.set(c, max);
        rowC?.set(ga, max);
      } else {
        rowA.delete(c);
        rowC?.delete(ga);
      }
    }
    rowA.delete(gb);
    farBest.delete(gb);
  };
  const startOf = (g: WorkGroup): number => sorted[g.members[0]].timestamp;
  const endOf = (g: WorkGroup): number => sorted[g.members[g.members.length - 1]].timestamp;
  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let bestSim = -Infinity;
    for (let a = 0; a < groups.length; a++) {
      const ga = groups[a];
      const ca = centroidCached(ga);
      if (ca === null) continue;
      const tightA = weakestOf(ga) >= mergeMinInternal;
      for (let b = a + 1; b < groups.length; b++) {
        const gb = groups[b];
        if ([...gb.bursts].some((x) => ga.bursts.has(x))) continue;
        if (groupsConflict(ga, gb)) continue;
        const gap = Math.max(startOf(ga), startOf(gb)) - Math.min(endOf(ga), endOf(gb));
        if (gap > mergeMaxGapMs) continue;
        const cb = centroidCached(gb);
        if (cb === null) continue;
        const tightB = weakestOf(gb) >= mergeMinInternal;
        const sim = centSimOf(ga, ca, gb, cb);
        // Phase-10 option: one side a single joining a group takes its
        // own bar with no tightness test on the group; otherwise both
        // must be tight and the standing centroid bar applies.
        const singleSide =
          (ga.members.length === 1 && ga.vecCount === 1) ||
          (gb.members.length === 1 && gb.vecCount === 1);
        const bar = singleSide ? singleMinCentroid : mergeMinCentroid;
        if (!singleSide && !(tightA && tightB)) continue;
        if (gap > farGapMs && farPair(ga, gb) < farMinBestPair) continue;
        if (sim >= bar && sim > bestSim) {
          bestSim = sim;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA === -1) break;
    const ga = groups[bestA];
    const gb = groups[bestB];
    merged(ga, gb);
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
  // Step 5, parts: a group of subMin or more is re-linked within itself
  // at its own bar and the partition is reported as `parts`; membership
  // is untouched.
  const partsOf = new Map<WorkGroup, number[][]>();
  for (const g of groups) {
    const n = g.members.length;
    if (n < subMin || n > SUBGROUP_MAX_SIZE) {
      partsOf.set(g, [g.members]);
      continue;
    }
    // One cosine table for the whole pass: the relative bar's mean and
    // the linkage both read it (a vectorless member reads 0 and is
    // never averaged in).
    const embedded = g.members.map((m) => vecs[m] !== null);
    const sims: number[][] = g.members.map(() => new Array<number>(n).fill(0));
    let total = 0;
    let pairs = 0;
    for (let x = 0; x < n; x++) {
      const a = vecs[g.members[x]];
      if (a === null) continue;
      for (let y = x + 1; y < n; y++) {
        const b = vecs[g.members[y]];
        if (b === null) continue;
        const sim = dot(a, b);
        sims[x][y] = sim;
        sims[y][x] = sim;
        total += sim;
        pairs++;
      }
    }
    if (pairs === 0) {
      partsOf.set(g, [g.members]);
      continue;
    }
    const mean = total / pairs;
    const bar = subThreshold === 'relative' ? Math.max(SUBGROUP_FLOOR, mean) : subThreshold;
    // Average-linkage agglomeration over the group's own members: the
    // two parts whose members are on average most alike merge first,
    // until no pair of parts averages the bar. Chronological greedy
    // linkage (stage 2's method) was measured against the reviewer's
    // corrected partitions and lost to average linkage by a wide margin
    // (device round 2: 47 % vs 80 % pair agreement on the corrected
    // cards) — inside one group the order of capture carries nothing.
    // No cannot-link checks here: a final group never seats a forbidden
    // pair (module invariant), so no part can either.
    const clusterOf = g.members.map((_, i) => i);
    const alive = new Set<number>(g.members.map((_, i) => i));
    const members: number[][] = g.members.map((_, i) => [i]);
    const vecCount = embedded.map((e) => (e ? 1 : 0));
    // sumSim[a][b]: the sum of pairwise cosines between a's and b's
    // embedded members; the average is that over vecCount[a] * vecCount[b].
    const sumSim: number[][] = sims.map((row) => row.slice());
    const merge = (a: number, b: number): void => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (const m of members[hi]) clusterOf[m] = lo;
      members[lo].push(...members[hi]);
      members[lo].sort((x, y) => x - y);
      members[hi] = [];
      vecCount[lo] += vecCount[hi];
      for (const c of alive) {
        if (c === lo || c === hi) continue;
        sumSim[lo][c] += sumSim[hi][c];
        sumSim[c][lo] = sumSim[lo][c];
      }
      alive.delete(hi);
    };
    // The dHash floor survives the cut: a near-duplicate pair shares a
    // part whatever the embeddings say, exactly as stage 2 united them.
    for (let x = 0; x < n; x++) {
      const ha = hashes[g.members[x]];
      if (ha === null) continue;
      for (let y = x + 1; y < n; y++) {
        const hb = hashes[g.members[y]];
        if (hb === null || clusterOf[x] === clusterOf[y]) continue;
        if (hammingDistance(ha, hb) <= nearDupMaxBits) merge(clusterOf[x], clusterOf[y]);
      }
    }
    // Each live cluster remembers its best partner at or above the bar;
    // a merge re-derives the merged cluster's partner and the partners of
    // the clusters that pointed at either side — O(k) per affected
    // cluster instead of a full k² rescan per merge.
    const bestOf = new Map<number, { partner: number; sim: number } | null>();
    const findBest = (a: number): { partner: number; sim: number } | null => {
      if (vecCount[a] === 0) return null;
      let best: { partner: number; sim: number } | null = null;
      for (const b of alive) {
        if (b === a || vecCount[b] === 0) continue;
        const sim = sumSim[a][b] / (vecCount[a] * vecCount[b]);
        if (sim >= bar && (best === null || sim > best.sim)) best = { partner: b, sim };
      }
      return best;
    };
    for (const a of alive) bestOf.set(a, findBest(a));
    for (;;) {
      let bestA = -1;
      let bestSim = -Infinity;
      for (const [a, best] of bestOf) {
        if (best !== null && best.sim > bestSim) {
          bestSim = best.sim;
          bestA = a;
        }
      }
      if (bestA === -1) break;
      const bestB = bestOf.get(bestA)!.partner;
      const lo = Math.min(bestA, bestB);
      const hi = Math.max(bestA, bestB);
      merge(lo, hi);
      bestOf.delete(hi);
      bestOf.set(lo, findBest(lo));
      for (const [c, best] of bestOf) {
        if (c !== lo && best !== null && (best.partner === lo || best.partner === hi)) {
          bestOf.set(c, findBest(c));
        }
      }
    }
    // A part without any embedded member (a vectorless photo the burst
    // attached by time) joins the part of its nearest embedded neighbour
    // in capture order — the time attachment, kept. Such a part is
    // always ONE photo: a hash-united vectorless pair is its own
    // two-member group (stage 2 attaches only lone vectorless photos),
    // so it never shares a group with an embedded member.
    for (const c of [...alive]) {
      if (vecCount[c] > 0) continue;
      const i = members[c][0];
      let nearest = -1;
      for (let d = 1; d < n && nearest === -1; d++) {
        if (i - d >= 0 && embedded[i - d]) nearest = i - d;
        else if (i + d < n && embedded[i + d]) nearest = i + d;
      }
      if (nearest !== -1) merge(c, clusterOf[nearest]);
    }
    partsOf.set(
      g,
      [...alive].map((c) => members[c].map((i) => g.members[i])).sort((x, y) => x[0] - y[0]),
    );
  }
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
      parts: partsOf.get(g)!.map((part) => part.map((i) => sorted[i].id)),
    };
  });
}
