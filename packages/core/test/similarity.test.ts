import { describe, expect, it } from 'vitest';
import {
  DHASH_BITS,
  DHASH_HEX_LENGTH,
  dhash64,
  hammingDistance,
  refineClustersBySimilarity,
  clusterByGap,
  type Cluster,
} from '../src/index';
import { item } from './helpers';

/** An 8×9 grid (the canonical dHash input) filled by f(row, col). */
function grid(f: (row: number, col: number) => number): number[][] {
  return Array.from({ length: 8 }, (_, r) => Array.from({ length: 9 }, (_, c) => f(r, c)));
}

describe('dhash64', () => {
  it('all-ascending rows produce all-ones; flat rows all-zeros', () => {
    expect(dhash64(grid((_, c) => c))).toBe('f'.repeat(DHASH_HEX_LENGTH));
    expect(dhash64(grid(() => 42))).toBe('0'.repeat(DHASH_HEX_LENGTH));
    // Descending is also all-zeros: bit = 1 only when right is brighter.
    expect(dhash64(grid((_, c) => -c))).toBe('0'.repeat(DHASH_HEX_LENGTH));
  });

  it('emits bits row-major, most significant first', () => {
    // Only the very first comparison (row 0, cols 0→1) is ascending.
    const g = grid(() => 0);
    g[0][1] = 10; // 0→10 ascending, 10→0 descending, rest flat
    // bit pattern: 10000000 0000... → hex 8000000000000000
    expect(dhash64(g)).toBe('8000000000000000');

    // Only the very last comparison ascending → ...0001.
    const g2 = grid(() => 0);
    g2[7][8] = 10;
    expect(dhash64(g2)).toBe('0000000000000001');
  });

  it('is stable: equal grids hash equal, tiny brightness shifts do not flip order', () => {
    const a = dhash64(grid((r, c) => Math.sin(r * 9 + c) * 100));
    const b = dhash64(grid((r, c) => Math.sin(r * 9 + c) * 100 + 5)); // uniform shift
    expect(a).toBe(b);
  });

  it('accepts any shape totalling 64 comparisons', () => {
    // 16 rows × 5 cols → 16 × 4 = 64 comparisons.
    const tall = Array.from({ length: 16 }, () => [0, 1, 2, 3, 4]);
    expect(dhash64(tall)).toBe('f'.repeat(DHASH_HEX_LENGTH));
  });

  it('rejects grids that do not yield exactly 64 bits', () => {
    expect(() => dhash64(grid(() => 0).slice(0, 7))).toThrow(/64/);
    expect(() => dhash64([[1, 2]])).toThrow(/64/);
    expect(() => dhash64([])).toThrow(/64/);
  });

  it('rejects rows shorter than 2 and non-finite values', () => {
    expect(() => dhash64([[1], ...grid(() => 0)])).toThrow(/2 columns/);
    const g = grid(() => 0);
    g[3][4] = NaN;
    expect(() => dhash64(g)).toThrow(/finite/);
  });

  it('always returns a 16-char lowercase hex string', () => {
    const h = dhash64(grid((r, c) => ((r * 31 + c * 17) % 7) - 3));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toHaveLength(DHASH_HEX_LENGTH);
  });
});

describe('hammingDistance', () => {
  it('identical hashes are 0 apart; complements are 64 apart', () => {
    expect(hammingDistance('0123456789abcdef', '0123456789abcdef')).toBe(0);
    expect(hammingDistance('0'.repeat(16), 'f'.repeat(16))).toBe(DHASH_BITS);
  });

  it('counts single-bit differences anywhere in the hash', () => {
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1);
    expect(hammingDistance('00000000000000ff', '0000000000000000')).toBe(8);
  });

  it('is case-insensitive and symmetric', () => {
    expect(hammingDistance('ABCDEF0000000000', 'abcdef0000000000')).toBe(0);
    const a = 'deadbeefdeadbeef';
    const b = '0123456789abcdef';
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it('throws on length mismatch and non-hex input', () => {
    expect(() => hammingDistance('abc', 'abcd')).toThrow(/length/);
    expect(() => hammingDistance('zzzzzzzzzzzzzzzz', '0'.repeat(16))).toThrow(/hex/);
  });
});

// ---------------------------------------------------------------- refine

/** Hashes that differ from '0000000000000000' by exactly n bits. */
function hashWithBits(n: number): string {
  let h = 0n;
  for (let i = 0; i < n; i++) h |= 1n << BigInt(i);
  return h.toString(16).padStart(16, '0');
}

function cluster(ids: string[], startTs = 0, stepMs = 1000): Cluster {
  const items = ids.map((id, i) => item(id, startTs + i * stepMs));
  return {
    id: `${items[0].timestamp}:${items[0].id}`,
    items,
    start: items[0].timestamp,
    end: items[items.length - 1].timestamp,
  };
}

function lookup(map: Record<string, string | null>): (id: string) => string | null {
  return (id) => map[id] ?? null;
}

describe('refineClustersBySimilarity', () => {
  const ZERO = '0'.repeat(16);

  it('keeps a fully similar cluster together (ids preserved)', () => {
    const c = cluster(['a', 'b', 'c']);
    const refined = refineClustersBySimilarity(
      [c],
      lookup({ a: ZERO, b: hashWithBits(3), c: hashWithBits(5) }),
      10,
    );
    expect(refined).toHaveLength(1);
    expect(refined[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(refined[0].id).toBe(c.id);
    expect(refined[0].start).toBe(c.start);
    expect(refined[0].end).toBe(c.end);
  });

  it('splits visually unrelated photos out of a time cluster', () => {
    const c = cluster(['a', 'b', 'x']);
    const refined = refineClustersBySimilarity(
      [c],
      lookup({ a: ZERO, b: hashWithBits(2), x: hashWithBits(40) }),
      10,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([['a', 'b'], ['x']]);
    // First component keeps the original cluster id; the split gets its own.
    expect(refined[0].id).toBe(c.id);
    expect(refined[1].id).toBe(`${c.items[2].timestamp}:x`);
    expect(refined[1].start).toBe(c.items[2].timestamp);
    expect(refined[1].end).toBe(c.items[2].timestamp);
  });

  it('chain-links via connected components: A~B~C stays together though A!~C', () => {
    // a↔b = 6 bits, b↔c = 6 bits, a↔c = 12 bits. Threshold 8: no direct
    // a–c edge, but b bridges them — one component, deliberately.
    const refined = refineClustersBySimilarity(
      [cluster(['a', 'b', 'c'])],
      lookup({ a: ZERO, b: hashWithBits(6), c: hashWithBits(12) }),
      8,
    );
    expect(refined).toHaveLength(1);
    expect(refined[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('threshold 0: only bit-identical hashes connect', () => {
    const refined = refineClustersBySimilarity(
      [cluster(['a', 'b', 'c'])],
      lookup({ a: ZERO, b: ZERO, c: hashWithBits(1) }),
      0,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('threshold 64: everything stays together no matter the hashes', () => {
    const refined = refineClustersBySimilarity(
      [cluster(['a', 'b', 'c'])],
      lookup({ a: ZERO, b: hashWithBits(64), c: hashWithBits(32) }),
      64,
    );
    expect(refined).toHaveLength(1);
    expect(refined[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('boundary: distance == threshold connects, threshold + 1 apart splits', () => {
    const together = refineClustersBySimilarity(
      [cluster(['a', 'b'])],
      lookup({ a: ZERO, b: hashWithBits(10) }),
      10,
    );
    expect(together).toHaveLength(1);

    const apart = refineClustersBySimilarity(
      [cluster(['a', 'b'])],
      lookup({ a: ZERO, b: hashWithBits(11) }),
      10,
    );
    expect(apart).toHaveLength(2);
  });

  it('null-hash photo attaches to its nearest-by-time hashed neighbor', () => {
    // a(t=0) and b(t=1000) split apart; n(t=900) has no hash and is
    // nearest to b → lands in b's component.
    const c = cluster(['a', 'n', 'b']);
    c.items[0].timestamp = 0;
    c.items[1].timestamp = 900;
    c.items[2].timestamp = 1000;
    const refined = refineClustersBySimilarity(
      [c],
      lookup({ a: ZERO, n: null, b: hashWithBits(40) }),
      10,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([['a'], ['n', 'b']]);
  });

  it('null-hash tie breaks toward the earlier item', () => {
    const c = cluster(['a', 'n', 'b']); // n exactly between a and b
    c.items[0].timestamp = 0;
    c.items[1].timestamp = 500;
    c.items[2].timestamp = 1000;
    const refined = refineClustersBySimilarity(
      [c],
      lookup({ a: ZERO, n: null, b: hashWithBits(40) }),
      10,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([['a', 'n'], ['b']]);
  });

  it('cluster with no hashes at all stays intact (conservative)', () => {
    const c = cluster(['a', 'b', 'c']);
    const refined = refineClustersBySimilarity([c], () => null, 0);
    expect(refined).toHaveLength(1);
    expect(refined[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(refined[0].id).toBe(c.id);
  });

  it('a null hash never splits a photo into a singleton by itself', () => {
    // Every hashed photo similar; the null one must join them.
    const refined = refineClustersBySimilarity(
      [cluster(['a', 'n', 'b'])],
      lookup({ a: ZERO, n: null, b: hashWithBits(1) }),
      10,
    );
    expect(refined).toHaveLength(1);
  });

  it('handles empty input, empty clusters and singleton clusters', () => {
    expect(refineClustersBySimilarity([], () => null, 10)).toEqual([]);
    const single = cluster(['only']);
    const refined = refineClustersBySimilarity([single], () => null, 10);
    expect(refined).toHaveLength(1);
    expect(refined[0].items.map((i) => i.id)).toEqual(['only']);
    const empty: Cluster = { id: 'e', items: [], start: 0, end: 0 };
    expect(refineClustersBySimilarity([empty], () => null, 10)).toEqual([]);
  });

  it('is deterministic: components ordered by earliest member, items keep order', () => {
    // Interleaved similarity: a,c similar; b,d similar.
    const c = cluster(['a', 'b', 'c', 'd']);
    const refined = refineClustersBySimilarity(
      [c],
      lookup({ a: ZERO, b: hashWithBits(30), c: hashWithBits(1), d: hashWithBits(31) }),
      5,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
  });

  it('composes with clusterByGap output', () => {
    const items = [item('a', 0), item('b', 1000), item('z', 60_000), item('y', 61_000)];
    const timeClusters = clusterByGap(items, { gapMs: 5000 });
    expect(timeClusters).toHaveLength(2);
    const refined = refineClustersBySimilarity(
      timeClusters,
      lookup({ a: ZERO, b: hashWithBits(2), z: ZERO, y: hashWithBits(50) }),
      10,
    );
    expect(refined.map((r) => r.items.map((i) => i.id))).toEqual([['a', 'b'], ['z'], ['y']]);
  });

  it('rejects invalid thresholds', () => {
    expect(() => refineClustersBySimilarity([], () => null, -1)).toThrow(/non-negative/);
    expect(() => refineClustersBySimilarity([], () => null, NaN)).toThrow(/non-negative/);
  });
});
