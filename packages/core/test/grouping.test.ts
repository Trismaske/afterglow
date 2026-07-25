import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADJACENT_MERGE_MAX_GAP_MS,
  BURST_GAP_MS,
  LINK_BASE_THRESHOLD,
  LINK_BONUS_WINDOW_MS,
  effectiveLinkThreshold,
  groupByEmbedding,
  type EmbedGroup,
  type MediaItem,
} from '../src/index';
import { item } from './helpers';

/** Unit 3-vector (callers pass components of an already-unit vector). */
function v(x: number, y: number, z = 0): Float32Array {
  return Float32Array.from([x, y, z]);
}

/** vecOf lookup from an id → vector record. */
function lookup(vecs: Record<string, Float32Array | null>) {
  return (id: string): Float32Array | null => vecs[id] ?? null;
}

function memberIds(groups: EmbedGroup[]): string[][] {
  return groups.map((g) => g.items.map((i) => i.id));
}

describe('effectiveLinkThreshold', () => {
  it('is the base threshold beyond the bonus window', () => {
    expect(effectiveLinkThreshold(LINK_BONUS_WINDOW_MS + 1)).toBe(LINK_BASE_THRESHOLD);
    expect(effectiveLinkThreshold(10 * 60_000)).toBe(LINK_BASE_THRESHOLD);
  });

  it('never exceeds the base threshold (the bonus only ever relaxes)', () => {
    for (const gapMs of [0, 1_000, 5_000, 20_000, 45_000, 60_000]) {
      expect(effectiveLinkThreshold(gapMs)).toBeLessThanOrEqual(LINK_BASE_THRESHOLD);
    }
  });

  it('decays monotonically across the window and matches the fitted floors', () => {
    let prev = effectiveLinkThreshold(0);
    for (let gapMs = 1_000; gapMs <= LINK_BONUS_WINDOW_MS; gapMs += 1_000) {
      const t = effectiveLinkThreshold(gapMs);
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
    // The fitted curve reproduces the measured 90%-link floors by gap band
    // (docs/grouping-study/fit_curve.mjs): ~0.49 at 20 s, ~0.42 at 60 s.
    expect(effectiveLinkThreshold(20_000)).toBeCloseTo(0.495, 2);
    expect(effectiveLinkThreshold(60_000)).toBeCloseTo(0.424, 2);
  });

  it('rejects negative or non-finite gaps', () => {
    expect(() => effectiveLinkThreshold(-1)).toThrow(/non-negative/);
    expect(() => effectiveLinkThreshold(Number.NaN)).toThrow(/non-negative/);
  });

  it('rejects invalid curve overrides instead of silently degrading', () => {
    expect(() => effectiveLinkThreshold(0, { floorTauMs: 0 })).toThrow(/positive/);
    expect(() => effectiveLinkThreshold(0, { baseThreshold: Number.NaN })).toThrow(/non-negative/);
    expect(() => effectiveLinkThreshold(0, { floorNear: -1 })).toThrow(/non-negative/);
  });
});

describe('groupByEmbedding', () => {
  it('groups similar photos within a burst; dissimilar photos stay apart', () => {
    const items = [item('a', 0), item('b', 5_000), item('c', 10_000)];
    const groups = groupByEmbedding(items, lookup({ a: v(1, 0), b: v(0.96, 0.28), c: v(0, 1) }));
    expect(memberIds(groups)).toEqual([['a', 'b'], ['c']]);
  });

  it('applies the time-decay bonus inside 60 s but not beyond', () => {
    // cos = 0.47: below the base 0.50, above the ~0.44 floor at 45 s.
    const vecs = { a: v(1, 0), b: v(0.47, 0.8829) };
    const at45s = groupByEmbedding([item('a', 0), item('b', 45_000)], lookup(vecs));
    expect(memberIds(at45s)).toEqual([['a', 'b']]);
    const at90s = groupByEmbedding([item('a', 0), item('b', 90_000)], lookup(vecs));
    expect(memberIds(at90s)).toEqual([['a'], ['b']]);
  });

  it('joins the highest-similarity eligible group, not just the first', () => {
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: v(1, 0), b: v(0, 1), c: v(0.6, 0.7, 0.3873) }),
    );
    // c is eligible for both seeds (0.6 and 0.7 ≥ 0.5) and joins the closer b.
    expect(memberIds(groups)).toEqual([['a'], ['b', 'c']]);
  });

  it('never links across a burst boundary through stage-2 linkage alone', () => {
    // Similar but not merge-tight pair across bursts: cos 0.6 < merge
    // centroid bar 0.7, so neither linkage (different bursts) nor the
    // adjacent merge unites them.
    const groups = groupByEmbedding(
      [item('a', 0), item('b', BURST_GAP_MS + 60_000)],
      lookup({ a: v(1, 0), b: v(0.6, 0.8) }),
    );
    expect(memberIds(groups)).toEqual([['a'], ['b']]);
  });

  it('merges internally tight groups across adjacent bursts (≤ 15 min)', () => {
    const vecs = { a: v(1, 0), b: v(1, 0), c: v(0.8, 0.6) };
    const near = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10 * 60_000)],
      lookup(vecs),
    );
    expect(memberIds(near)).toEqual([['a', 'b', 'c']]);
    const far = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', ADJACENT_MERGE_MAX_GAP_MS + 6_000)],
      lookup(vecs),
    );
    expect(memberIds(far)).toEqual([['a', 'b'], ['c']]);
  });

  it('a merged group never re-merges with its own bursts remnants', () => {
    // Burst 0: three identical shots. Burst 1 (13 min later): c seeds
    // alone, then b (90 s after c, cos(b,c)=.49 < 0.50) seeds separately —
    // stage 2 deliberately split them. The merge joins the a-cluster with
    // c (centroid ≈ .88); the merged group now spans bursts {0,1}, so a
    // second merge with b (same burst as c, centroid ≈ .74 ≥ .70) must be
    // refused — otherwise b and c reunite through the friendlier centroid.
    const groups = groupByEmbedding(
      [
        item('a1', 0),
        item('a2', 5_000),
        item('a3', 10_000),
        item('c', 13 * 60_000),
        item('b', 13 * 60_000 + 90_000),
      ],
      lookup({
        a1: v(1, 0),
        a2: v(1, 0),
        a3: v(1, 0),
        c: v(0.88, -0.2, 0.43081),
        b: v(0.8, 0.55, -0.23979),
      }),
    );
    expect(memberIds(groups)).toEqual([['a1', 'a2', 'a3', 'c'], ['b']]);
  });

  it('refuses adjacent merges when a group is internally loose', () => {
    // a~b linked only via the 45 s bonus (cos 0.47 < tight bar 0.55), so
    // their group must not merge with the adjacent singleton even though
    // the centroids agree well beyond 0.70.
    const centroidish = v(0.8578, 0.514); // ≈ normalize(a + b)
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 45_000), item('c', 10 * 60_000)],
      lookup({ a: v(1, 0), b: v(0.47, 0.8829), c: centroidish }),
    );
    expect(memberIds(groups)).toEqual([['a', 'b'], ['c']]);
  });

  it('force-links near-duplicate dHash pairs within a burst and annotates them', () => {
    // Embeddings disagree completely, but the hashes differ by 8 bits.
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 30_000)],
      lookup({ a: v(1, 0), b: v(0, 1) }),
      (id) => (id === 'a' ? '0000000000000000' : '00000000000000ff'),
    );
    expect(memberIds(groups)).toEqual([['a', 'b']]);
    expect(groups[0].nearDupPairs).toEqual([{ a: 'a', b: 'b', bits: 8 }]);
  });

  it('dHash floor unites groups even when embeddings already placed the photo', () => {
    // Vectors put c with a (cos 1.0); c's hash is identical to b's. The
    // floor must unite ALL of them, not leave {a, c} and {b} split.
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: v(1, 0), b: v(0, 1), c: v(1, 0) }),
      (id) => (id === 'a' ? '0000000000000000' : 'ffffffffffffffff'),
    );
    expect(memberIds(groups)).toEqual([['a', 'b', 'c']]);
    expect(groups[0].nearDupPairs).toEqual([{ a: 'b', b: 'c', bits: 0 }]);
  });

  it('ignores dHash pairs beyond the near-dup bar and across bursts', () => {
    const nineBits = groupByEmbedding(
      [item('a', 0), item('b', 30_000)],
      lookup({ a: v(1, 0), b: v(0, 1) }),
      (id) => (id === 'a' ? '0000000000000000' : '00000000000001ff'),
    );
    expect(memberIds(nineBits)).toEqual([['a'], ['b']]);
    // Identical hashes but different bursts and disagreeing centroids:
    // the floor is time-gated, so they stay apart.
    const crossBurst = groupByEmbedding(
      [item('a', 0), item('b', BURST_GAP_MS + 60_000)],
      lookup({ a: v(1, 0), b: v(0, 1) }),
      () => '0000000000000000',
    );
    expect(memberIds(crossBurst)).toEqual([['a'], ['b']]);
  });

  it('time-attaches unembedded photos to the nearest embedded neighbour, badged', () => {
    // c has no embedding: it joins b's group (b at 3 s is its nearest
    // embedded photo; the dissimilar d is 52 s away) and is badged.
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 8_000), item('d', 60_000)],
      lookup({ a: v(1, 0), b: v(1, 0), c: null, d: v(0, 1) }),
    );
    expect(memberIds(groups)).toEqual([['a', 'b', 'c'], ['d']]);
    expect(groups[0].timeAttached).toEqual(['c']);
    expect(groups[1].timeAttached).toEqual([]);
  });

  it('a dHash-floor link is a real match, not a time attachment', () => {
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: v(1, 0), b: v(1, 0), c: null }),
      (id) => (id === 'c' || id === 'b' ? 'ffffffffffffffff' : '0000000000000000'),
    );
    expect(memberIds(groups)).toEqual([['a', 'b', 'c']]);
    expect(groups[0].timeAttached).toEqual([]);
  });

  it('a burst with no embedded photo stays intact as one badged group', () => {
    const intact = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: null, b: null, c: null }),
    );
    expect(memberIds(intact)).toEqual([['a', 'b', 'c']]);
    expect(intact[0].timeAttached).toEqual(['a', 'b', 'c']);
    // A dHash-linked pair inside the collapse keeps its real-match status:
    // only the time-joined singleton is badged.
    const withPair = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: null, b: null, c: null }),
      (id) => (id === 'c' ? 'ffffffffffffffff' : '0000000000000000'),
    );
    expect(memberIds(withPair)).toEqual([['a', 'b', 'c']]);
    expect(withPair[0].timeAttached).toEqual(['c']);
    // A lone unembedded photo is a plain single — nothing was attached.
    const single = groupByEmbedding([item('a', 0)], lookup({ a: null }));
    expect(memberIds(single)).toEqual([['a']]);
    expect(single[0].timeAttached).toEqual([]);
  });

  it('never time-attaches across bursts', () => {
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', BURST_GAP_MS + 60_000)],
      lookup({ a: v(1, 0), b: v(1, 0), c: null }),
    );
    expect(memberIds(groups)).toEqual([['a', 'b'], ['c']]);
  });

  it('is deterministic regardless of input order', () => {
    const items = [item('a', 0), item('b', 5_000), item('c', 45_000), item('d', 10 * 60_000)];
    const vecs = lookup({ a: v(1, 0), b: v(0.96, 0.28), c: v(0, 1), d: v(1, 0) });
    const forward = groupByEmbedding(items, vecs);
    const backward = groupByEmbedding([...items].reverse(), vecs);
    expect(memberIds(backward)).toEqual(memberIds(forward));
    expect(backward.map((g) => g.id)).toEqual(forward.map((g) => g.id));
  });

  it('uses the Cluster id scheme and chronological members', () => {
    const groups = groupByEmbedding(
      [item('b', 5_000), item('a', 0)],
      lookup({ a: v(1, 0), b: v(1, 0) }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('0:a');
    expect(groups[0].start).toBe(0);
    expect(groups[0].end).toBe(5_000);
  });

  it('rejects mismatched embedding dimensions and bad options', () => {
    expect(() =>
      groupByEmbedding([item('a', 0), item('b', 1_000)], (id) =>
        id === 'a' ? v(1, 0) : Float32Array.from([1, 0, 0, 0]),
      ),
    ).toThrow(/dimension mismatch/);
    expect(() => groupByEmbedding([], lookup({}), undefined, { burstGapMs: -1 })).toThrow(
      /non-negative/,
    );
  });
});

/**
 * Grouping regression suite (Plan_m0.8.md): replays the engine at shipped
 * defaults over the frozen labels-v1 fixtures and pins the baseline.
 * Quality can never silently drop — an algorithm or threshold change that
 * degrades any pinned number fails here; improving on it means
 * deliberately updating the pins (a re-pin, with fit_curve.mjs evidence).
 */
describe('labels-v1 regression', () => {
  // Pinned baseline, established by docs/grouping-study/fit_curve.mjs at
  // the Gate-1 fit (2026-07-25): fitted time-decay curve + adjacent merge
  // 0.55/0.70. The 19 deliberate_nontransitive_apart pairs are exempt —
  // they sit inside link-connected components, so NO partition can keep
  // them apart; counting them would add constant noise to the signal.
  const PINNED_MUST_LINK_KEPT = 412; // of 503 hard link pairs
  const PINNED_VIOLATIONS = 37; // of 176 enforceable hard apart pairs
  const PINNED_LARGEST_GROUP = 12;

  const dir = fileURLToPath(new URL('../../../docs/grouping-study/', import.meta.url));
  const labels = JSON.parse(readFileSync(`${dir}labels-v1.json`, 'utf8'));
  const embeddings = JSON.parse(readFileSync(`${dir}embeddings-labeled-v1.json`, 'utf8'));

  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  it('fixtures are internally consistent', () => {
    expect(labels.version).toBe('labels-v1');
    expect(embeddings.version).toBe('labels-v1');
    expect(embeddings.model_sha256).toBe(labels.model.sha256);
    expect(embeddings.dim).toBe(1280);
    expect(labels.hard).toHaveLength(698);
    expect(labels.hard.filter((p: { rel: string }) => p.rel === 'link')).toHaveLength(503);
    expect(labels.soft).toHaveLength(81);
    expect(labels.deliberate_nontransitive_apart).toHaveLength(19);
    // Every labeled photo has a timestamp and a 1280-dim vector.
    const photos = new Set(
      [...labels.hard, ...labels.soft].flatMap((p: { a: string; b: string }) => [p.a, p.b]),
    );
    for (const name of photos) {
      const entry = embeddings.photos[name];
      expect(entry?.ts, name).toBeTypeOf('number');
      expect(Buffer.from(entry.vec, 'base64').byteLength).toBe(1280 * 4);
    }
    // Deliberate non-transitive pairs are all hard apart pairs.
    const apartKeys = new Set(
      labels.hard
        .filter((p: { rel: string }) => p.rel === 'apart')
        .map((p: { a: string; b: string }) => key(p.a, p.b)),
    );
    for (const p of labels.deliberate_nontransitive_apart) {
      expect(apartKeys.has(key(p.a, p.b)), `${p.a}~${p.b}`).toBe(true);
    }
  });

  it('holds the pinned grouping baseline at shipped defaults', () => {
    const vecs = new Map<string, Float32Array>();
    const items: MediaItem[] = [];
    for (const [name, entry] of Object.entries(embeddings.photos) as [
      string,
      { ts: number; vec: string },
    ][]) {
      // True copy (Uint8Array slice, not Buffer's view-returning slice) so
      // the Float32Array view starts 4-byte aligned at offset 0.
      const raw = Uint8Array.prototype.slice.call(Buffer.from(entry.vec, 'base64'));
      vecs.set(name, new Float32Array(raw.buffer));
      items.push({ id: name, timestamp: entry.ts, uri: name, kind: 'photo' });
    }

    const groups = groupByEmbedding(items, (id) => vecs.get(id) ?? null);
    const groupOf = new Map<string, number>();
    groups.forEach((g, i) => g.items.forEach((member) => groupOf.set(member.id, i)));
    const together = (p: { a: string; b: string }): boolean =>
      groupOf.get(p.a) !== undefined && groupOf.get(p.a) === groupOf.get(p.b);

    const deliberate = new Set(
      labels.deliberate_nontransitive_apart.map((p: { a: string; b: string }) => key(p.a, p.b)),
    );
    const links = labels.hard.filter((p: { rel: string }) => p.rel === 'link');
    const aparts = labels.hard.filter(
      (p: { rel: string; a: string; b: string }) =>
        p.rel === 'apart' && !deliberate.has(key(p.a, p.b)),
    );
    expect(aparts).toHaveLength(176);

    const kept = links.filter(together).length;
    const violations = aparts.filter(together).length;
    const largest = Math.max(...groups.map((g) => g.items.length));
    expect(kept).toBeGreaterThanOrEqual(PINNED_MUST_LINK_KEPT);
    expect(violations).toBeLessThanOrEqual(PINNED_VIOLATIONS);
    expect(largest).toBeLessThanOrEqual(PINNED_LARGEST_GROUP);
  });
});
