import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADJACENT_MERGE_MAX_GAP_MS,
  BURST_GAP_MS,
  FAR_MERGE_GAP_MS,
  LINK_BASE_THRESHOLD,
  LINK_BONUS_WINDOW_MS,
  SUBGROUP_MAX_SIZE,
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

  it('merges internally tight groups across adjacent bursts (≤ 60 min)', () => {
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

  it('a long chain of look-alike bursts merges in well under a second (far-pair cache)', () => {
    // 358 identical photos four minutes apart: every one its own burst,
    // every pair beyond the far gap once the chain grows — the far pair
    // is computed once per group pair and carried through merges.
    // Real-sized vectors: the cost that matters is the 1280-d dot.
    const v1 = new Float32Array(1280);
    v1[0] = 1;
    const items = Array.from({ length: 358 }, (_, i) => item(`p${i}`, i * 4 * 60_000));
    const started = performance.now();
    const groups = groupByEmbedding(items, () => v1);
    expect(groups).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('beyond 15 min the far bar asks for the same shot again (phase 10)', () => {
    // c at 20 min: its best pair against the group is 0.8 — the same
    // place, not the same shot — so it stays apart although its centroid
    // cosine clears the single's bar; d at 20 min matches a at 0.9.
    const vecs = { a: v(1, 0), b: v(1, 0), c: v(0.8, 0.6), d: v(0.9, 0.4359) };
    const place = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', FAR_MERGE_GAP_MS + 5 * 60_000)],
      lookup(vecs),
    );
    expect(memberIds(place)).toEqual([['a', 'b'], ['c']]);
    const shot = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('d', FAR_MERGE_GAP_MS + 5 * 60_000)],
      lookup(vecs),
    );
    expect(memberIds(shot)).toEqual([['a', 'b', 'd']]);
    // Within 15 min the standing bars alone decide (c joins at 10 min above).
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

  it('refuses adjacent merges between GROUPS when one is internally loose', () => {
    // a~b linked only via the 45 s bonus (cos 0.47 < tight bar 0.55), so
    // their group must not merge with the adjacent PAIR c~d even though
    // the centroids agree well beyond 0.70 (the pair is tight; the loose
    // side alone refuses).
    const centroidish = v(0.8578, 0.514); // ≈ normalize(a + b)
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 45_000), item('c', 10 * 60_000), item('d', 10 * 60_000 + 2_000)],
      lookup({ a: v(1, 0), b: v(0.47, 0.8829), c: centroidish, d: centroidish }),
    );
    expect(memberIds(groups)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('lets a SINGLE join an adjacent loose group on its own bar (phase 10 re-pin)', () => {
    // The same loose pair, and one photo ten minutes later: a single has
    // no internal pairs to be tight about, so it joins on centroid
    // agreement alone — at 0.73 (the device round's judged edge), not
    // below it.
    const centroidish = v(0.8578, 0.514);
    const joins = groupByEmbedding(
      [item('a', 0), item('b', 45_000), item('c', 10 * 60_000)],
      lookup({ a: v(1, 0), b: v(0.47, 0.8829), c: centroidish }),
    );
    expect(memberIds(joins)).toEqual([['a', 'b', 'c']]);
    // A vector at ≈0.675 to that centroid stays apart.
    const apart = groupByEmbedding(
      [item('a', 0), item('b', 45_000), item('c', 10 * 60_000)],
      lookup({ a: v(1, 0), b: v(0.47, 0.8829), c: v(0.2, 0.9798) }), // cos to centroidish ≈ 0.675
    );
    expect(memberIds(apart)).toEqual([['a', 'b'], ['c']]);
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

describe('phase-10 parts (m0.9)', () => {
  it('rejects a malformed parts option, and a NaN single bar', () => {
    const items = [item('a', 0), item('b', 5_000)];
    const vecs = lookup({ a: v(1, 0), b: v(1, 0) });
    expect(() => groupByEmbedding(items, vecs, undefined, { subgroupMinSize: 1 })).toThrow(
      /integer ≥ 2/,
    );
    expect(() =>
      groupByEmbedding(items, vecs, undefined, { subgroupThreshold: Number.NaN }),
    ).toThrow(/subgroupThreshold/);
    expect(() =>
      groupByEmbedding(items, vecs, undefined, { adjacentMergeSingleMinCentroid: Number.NaN }),
    ).toThrow(/singleMinCentroid/);
  });

  it('cuts a group into parts at its own mean cosine without touching membership', () => {
    // One burst, two looks: a~b near-identical, c~d near-identical, the
    // looks 0.8 apart (all four link at the 0.5 base). The group's mean
    // pairwise cosine sits between the within-look and the across-look
    // similarities, so the relative bar cuts exactly between the looks.
    const items = [item('a', 0), item('b', 2_000), item('c', 4_000), item('d', 6_000)];
    const vecs = lookup({
      a: v(1, 0),
      b: v(0.995, 0.0998),
      c: v(0.8, 0.6),
      d: v(0.7071, 0.7071),
    });
    const groups = groupByEmbedding(items, vecs);
    expect(memberIds(groups)).toEqual([['a', 'b', 'c', 'd']]);
    expect(groups[0].parts).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    // Below the size floor a group is one part.
    const pair = groupByEmbedding(items.slice(0, 2), vecs);
    expect(pair[0].parts).toEqual([['a', 'b']]);
    // An absolute bar is the replay harness's override.
    const absolute = groupByEmbedding(items, vecs, undefined, { subgroupThreshold: 0.5 });
    expect(absolute[0].parts).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('a group above the size cap is one part; at the cap it is cut', () => {
    // Two alternating looks a second apart: cut into two parts at the
    // cap, left whole one member above it.
    const build = (count: number) => {
      const items = Array.from({ length: count }, (_, i) => item(`p${i}`, i * 1_000));
      const vecs = (id: string) => (Number(id.slice(1)) % 2 === 0 ? v(1, 0) : v(0.6, 0.8));
      return groupByEmbedding(items, vecs, undefined, { burstGapMs: 1_000_000_000 });
    };
    const atCap = build(SUBGROUP_MAX_SIZE);
    expect(atCap).toHaveLength(1);
    expect(atCap[0].parts).toHaveLength(2);
    const aboveCap = build(SUBGROUP_MAX_SIZE + 1);
    expect(aboveCap).toHaveLength(1);
    expect(aboveCap[0].parts).toHaveLength(1);
  });

  it('the parts pass keeps a near-duplicate pair together whatever the embeddings say', () => {
    // Four photos in one burst: a~b and c~d are two looks; c and d carry
    // identical hashes with disagreeing embeddings. A cut at 0.9 would
    // put c and d in different parts on embeddings alone; the floor holds.
    const items = [item('a', 0), item('b', 2_000), item('c', 4_000), item('d', 6_000)];
    const vecs = lookup({ a: v(1, 0), b: v(0.99, 0.141), c: v(0.7071, 0.7071), d: v(0, 1) });
    const hashes = (id: string) =>
      id === 'c' || id === 'd'
        ? '0000000000000000'
        : id === 'a'
          ? 'ffffffffffffffff'
          : 'ff00ff00ff00ff00';
    const groups = groupByEmbedding(items, vecs, hashes, { subgroupThreshold: 0.9 });
    expect(memberIds(groups)).toEqual([['a', 'b', 'c', 'd']]);
    expect(groups[0].parts).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('cannot-link constraints (docs/Regroup_design.md §4)', () => {
  /** No final group may seat a forbidden pair — the design's invariant. */
  function assertInvariant(groups: EmbedGroup[], pairs: ReadonlyArray<readonly [string, string]>) {
    for (const g of groups) {
      const ids = new Set(g.items.map((i) => i.id));
      for (const [a, b] of pairs) {
        expect(ids.has(a) && ids.has(b), `pair [${a}, ${b}] shares a group`).toBe(false);
      }
    }
  }

  it('keeps a forbidden pair apart despite identical embeddings', () => {
    const pairs = [['a', 'b']] as const;
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000)],
      lookup({ a: v(1, 0), b: v(1, 0) }),
      undefined,
      { cannotLink: pairs },
    );
    expect(memberIds(groups)).toEqual([['a'], ['b']]);
    assertInvariant(groups, pairs);
  });

  it('joins the best ALLOWED group when the best match is forbidden', () => {
    // c matches b (0.8) over a (0.6); the (c,b) pair redirects it to a.
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({ a: v(1, 0), b: v(0, 1), c: v(0.6, 0.8) }),
      undefined,
      { cannotLink: [['c', 'b']] },
    );
    expect(memberIds(groups)).toEqual([['a', 'c'], ['b']]);
  });

  it('outranks the dHash near-duplicate floor', () => {
    // Identical hashes force-link by the floor; the pair forbids it, and
    // neither lone single is badged time-attached by the burst collapse.
    const pairs = [['a', 'b']] as const;
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000)],
      lookup({}),
      () => 'ffffffffffffffff',
      { cannotLink: pairs },
    );
    expect(memberIds(groups)).toEqual([['a'], ['b']]);
    expect(groups.flatMap((g) => g.timeAttached)).toEqual([]);
  });

  it('refuses a dHash union that would seat a forbidden pair transitively', () => {
    // a~b and b~c are near dups; (a,c) forbidden. The union may join a+b
    // but must stop before c joins them.
    const pairs = [['a', 'c']] as const;
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000), item('c', 10_000)],
      lookup({}),
      () => '0000000000000000',
      { cannotLink: pairs },
    );
    assertInvariant(groups, pairs);
    const together = memberIds(groups).find((g) => g.includes('a'))!;
    expect(together).toContain('b');
    expect(together).not.toContain('c');
  });

  it('time-attaches an unembedded photo to the nearest ALLOWED group, else leaves it single', () => {
    const vecs = { e1: v(1, 0), e2: v(0, 1) };
    const items = [item('e1', 0), item('u', 5_000), item('e2', 20_000)];
    const redirected = groupByEmbedding(items, lookup(vecs), undefined, {
      cannotLink: [['u', 'e1']],
    });
    expect(memberIds(redirected)).toEqual([['e1'], ['u', 'e2']]);
    expect(redirected.flatMap((g) => g.timeAttached)).toEqual(['u']);
    const stranded = groupByEmbedding(items, lookup(vecs), undefined, {
      cannotLink: [
        ['u', 'e1'],
        ['u', 'e2'],
      ],
    });
    expect(memberIds(stranded)).toEqual([['e1'], ['u'], ['e2']]);
    expect(stranded.flatMap((g) => g.timeAttached)).toEqual([]);
  });

  it('refuses an adjacent-burst merge across a forbidden pair', () => {
    const vecs = { a1: v(1, 0), a2: v(1, 0), b1: v(1, 0), b2: v(1, 0) };
    const items = [
      item('a1', 0),
      item('a2', 5_000),
      item('b1', 10 * 60_000),
      item('b2', 10 * 60_000 + 5_000),
    ];
    const merged = groupByEmbedding(items, lookup(vecs));
    expect(memberIds(merged)).toEqual([['a1', 'a2', 'b1', 'b2']]);
    const pairs = [['a1', 'b2']] as const;
    const split = groupByEmbedding(items, lookup(vecs), undefined, { cannotLink: pairs });
    expect(memberIds(split)).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  it('replays the A→B double-ejection scenario: dissolved pairs may reunite elsewhere', () => {
    // P1 and P2 were ejected from cluster A ({p3,p4,p5}); the dissolution
    // rule removed the (P1,P2) pair, so both may land in cluster B. Their
    // surviving pairs still fence them off A's coherent core.
    const pairs = [
      ['P1', 'p3'],
      ['P1', 'p4'],
      ['P1', 'p5'],
      ['P2', 'p3'],
      ['P2', 'p4'],
      ['P2', 'p5'],
    ] as const;
    const groups = groupByEmbedding(
      [
        item('p3', 0),
        item('p4', 5_000),
        item('p5', 10_000),
        item('b1', 30_000),
        item('b2', 35_000),
        item('P1', 40_000),
        item('P2', 45_000),
      ],
      lookup({
        p3: v(1, 0),
        p4: v(1, 0),
        p5: v(1, 0),
        b1: v(0, 1),
        b2: v(0, 1),
        P1: v(0, 1),
        P2: v(0, 1),
      }),
      undefined,
      { cannotLink: pairs },
    );
    assertInvariant(groups, pairs);
    const bGroup = memberIds(groups).find((g) => g.includes('b1'))!;
    expect(bGroup).toContain('P1');
    expect(bGroup).toContain('P2');
    expect(memberIds(groups).find((g) => g.includes('p3'))).toEqual(['p3', 'p4', 'p5']);
  });

  it('ignores pairs naming absent photos and rejects self-pairs', () => {
    const groups = groupByEmbedding(
      [item('a', 0), item('b', 5_000)],
      lookup({ a: v(1, 0), b: v(1, 0) }),
      undefined,
      { cannotLink: [['zz', 'yy']] },
    );
    expect(memberIds(groups)).toEqual([['a', 'b']]);
    expect(() =>
      groupByEmbedding([item('a', 0)], lookup({}), undefined, { cannotLink: [['a', 'a']] }),
    ).toThrow(/invalid cannotLink pair/);
  });

  it('an empty pair list changes nothing', () => {
    const items = [item('a', 0), item('b', 5_000), item('c', 10_000)];
    const vecs = { a: v(1, 0), b: v(0.96, 0.28), c: v(0, 1) };
    const bare = groupByEmbedding(items, lookup(vecs));
    const withEmpty = groupByEmbedding(items, lookup(vecs), undefined, { cannotLink: [] });
    expect(memberIds(withEmpty)).toEqual(memberIds(bare));
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

/**
 * Device regression suite (m0.9 phase 10): replays the engine at shipped
 * defaults over the frozen device-rounds-v1 fixture — every photo inside
 * the judged S10e cards' merge windows, with the DEVICE vectors, and
 * Tristan's verdicts from rounds 1, 2, 3a and 3b as pairwise constraints
 * — and pins the baseline at two levels: GROUP (membership) and PART
 * (the unit the deck shows contiguous). Round 1 judged groups, round 2
 * and 3b judged partitions, round 3a judged far pairs. Quality can never
 * silently drop; improving on a pin means re-pinning deliberately with
 * `docs/grouping-study/make_device_fixture.mjs`'s printed score.
 */
describe('device-rounds-v1 regression', () => {
  const dir = fileURLToPath(new URL('../../../docs/grouping-study/', import.meta.url));
  const fixture = JSON.parse(readFileSync(`${dir}device-rounds-v1.json`, 'utf8')) as {
    version: string;
    mergeGapMs: number;
    photos: { id: string; ts: number; hash: string | null; vec: string }[];
    cards: {
      round: string;
      card: number;
      kind: string;
      verdict: string;
      members: string[];
      must: [string, string][];
      cannot: [string, string][];
    }[];
  };
  // Pinned at the shipped rules' measured score (2026-10-05): cards the
  // engine satisfies exactly, per round, kind and verdict, at the level
  // the round judged. Exact counts are floors; the parts' corrected
  // classes hold their mean pair agreement (floored to the hundredth).
  const PINNED_EXACT: Record<string, number> = {
    'group r1 group/ok': 44, // of 44
    'group r1 excluded/join': 8, // of 8
    'group r1 excluded/ok': 2, // of 2
    'group r3a far-pair/join': 2, // of 10 — the far bar's reach within the hour
    'group r3a far-pair/apart': 56, // of 57
    'part r2 split-card/ok': 8, // of 12
    'part r2 large-group/ok': 3, // of 7
    'part r3b split-card/ok': 11, // of 11
    'part r3b large-group/ok': 6, // of 6
    'part r3b ok-group/ok': 17, // of 17
  };
  const PINNED_AGREEMENT: Record<string, number> = {
    'part r3b split-card/edited': 0.82,
    'part r3b large-group/edited': 0.74,
    'part r3b ok-group/edited': 0.78,
  };

  it('fixture is internally consistent', () => {
    expect(fixture.version).toBe('device-rounds-v1');
    expect(fixture.mergeGapMs).toBe(ADJACENT_MERGE_MAX_GAP_MS);
    expect(fixture.photos).toHaveLength(2297);
    expect(fixture.cards).toHaveLength(233);
    const ids = new Set(fixture.photos.map((p) => p.id));
    for (const c of fixture.cards) {
      for (const id of c.members) expect(ids.has(id), `${c.round}#${c.card} ${id}`).toBe(true);
    }
    for (const p of fixture.photos) expect(Buffer.from(p.vec, 'base64').byteLength).toBe(1280 * 4);
  });

  it('holds the pinned device baseline at shipped defaults', () => {
    const byId = new Map(
      fixture.photos.map((p) => {
        const raw = Uint8Array.prototype.slice.call(Buffer.from(p.vec, 'base64'));
        return [p.id, { ...p, vec: new Float32Array(raw.buffer) }];
      }),
    );
    // The device's merge windows re-form over the fixture (its header).
    const groupOf = new Map<string, number>();
    const partOf = new Map<string, string>();
    let window: typeof fixture.photos = [];
    let gi = 0;
    const flush = (): void => {
      if (window.length === 0) return;
      const groups = groupByEmbedding(
        window.map((p) => item(p.id, p.ts)),
        (id) => byId.get(id)?.vec ?? null,
        (id) => byId.get(id)?.hash ?? null,
      );
      for (const g of groups) {
        const key = gi++;
        g.items.forEach((it) => groupOf.set(it.id, key));
        g.parts.forEach((part, pi) => part.forEach((id) => partOf.set(id, `${key}/${pi}`)));
      }
      window = [];
    };
    for (const p of fixture.photos) {
      if (window.length > 0 && p.ts - window[window.length - 1].ts > fixture.mergeGapMs) flush();
      window.push(p);
    }
    flush();
    const tally: Record<string, { n: number; exact: number; agree: number }> = {};
    for (const c of fixture.cards) {
      for (const level of ['group', 'part'] as const) {
        const unit: Map<string, number | string> = level === 'group' ? groupOf : partOf;
        const same = (a: string, b: string): boolean => unit.get(a) === unit.get(b);
        const agreed =
          c.must.filter(([a, b]) => same(a, b)).length +
          c.cannot.filter(([a, b]) => !same(a, b)).length;
        const pairs = c.must.length + c.cannot.length;
        const k = `${level} r${c.round} ${c.kind}/${c.verdict}`;
        tally[k] ??= { n: 0, exact: 0, agree: 0 };
        tally[k].n++;
        if (agreed === pairs) tally[k].exact++;
        tally[k].agree += pairs ? agreed / pairs : 1;
      }
    }
    for (const [k, floor] of Object.entries(PINNED_EXACT)) {
      expect(tally[k]?.exact ?? 0, k).toBeGreaterThanOrEqual(floor);
    }
    for (const [k, floor] of Object.entries(PINNED_AGREEMENT)) {
      expect(tally[k].agree / tally[k].n, k).toBeGreaterThanOrEqual(floor);
    }
  });
});
