import { describe, it, expect } from 'vitest';
import { clusterByGap, createMix, mulberry32, type MediaItem } from '../src/index';
import { burst, item } from './helpers';

const MIN = 60_000;

/** A library: three bursts (clusters) plus scattered singles. */
function library() {
  const items: MediaItem[] = [
    ...burst(8, 0, 30_000, 'a'),
    ...burst(5, 60 * MIN, 30_000, 'b'),
    ...burst(12, 200 * MIN, 30_000, 'c'),
    item('s1', 500 * MIN),
    item('s2', 900 * MIN),
    item('s3', 1300 * MIN),
    item('s4', 1700 * MIN),
  ];
  const clusters = clusterByGap(items, { gapMs: 3 * MIN }).filter((c) => c.items.length >= 2);
  return { items, clusters };
}

function take(mix: { next(): MediaItem }, n: number): string[] {
  return Array.from({ length: n }, () => mix.next().id);
}

describe('createMix', () => {
  it('throws on empty items or missing rng', () => {
    expect(() => createMix({ items: [], rng: mulberry32(1) })).toThrow();
    // @ts-expect-error rng is required
    expect(() => createMix({ items: [item('a', 0)] })).toThrow();
  });

  it('is deterministic under a seeded rng', () => {
    const { items, clusters } = library();
    const opts = { items, clusters, avoidRepeatWindow: 10 };
    const first = take(createMix({ ...opts, rng: mulberry32(42) }), 200);
    const second = take(createMix({ ...opts, rng: mulberry32(42) }), 200);
    expect(second).toEqual(first);
    const other = take(createMix({ ...opts, rng: mulberry32(7) }), 200);
    expect(other).not.toEqual(first);
  });

  it('never repeats an item within avoidRepeatWindow picks (property, 500 picks)', () => {
    const { items, clusters } = library();
    const windowSize = 12;
    const mix = createMix({
      items,
      clusters,
      avoidRepeatWindow: windowSize,
      rng: mulberry32(1234),
    });
    const picks = take(mix, 500);
    for (let i = 0; i < picks.length; i++) {
      const windowIds = picks.slice(Math.max(0, i - windowSize), i);
      expect(windowIds).not.toContain(picks[i]);
    }
    // Every pick is a real library item.
    const valid = new Set(items.map((it) => it.id));
    for (const id of picks) expect(valid.has(id)).toBe(true);
  });

  it('never runs dry even when the window exceeds the pool (clamped)', () => {
    const items = burst(3, 0, MIN);
    const mix = createMix({ items, avoidRepeatWindow: 50, rng: mulberry32(9) });
    const picks = take(mix, 100);
    expect(picks).toHaveLength(100);
    // Clamped window = 2: no id may repeat within 2 picks.
    for (let i = 2; i < picks.length; i++) {
      expect(picks[i]).not.toBe(picks[i - 1]);
      expect(picks[i]).not.toBe(picks[i - 2]);
    }
  });

  it('a single-item library just repeats that item', () => {
    const mix = createMix({ items: [item('only', 0)], avoidRepeatWindow: 5, rng: mulberry32(3) });
    expect(take(mix, 5)).toEqual(['only', 'only', 'only', 'only', 'only']);
  });

  it('plays a cluster consecutively in chronological order (weights single: 0)', () => {
    const items = burst(6, 0, 30_000);
    const clusters = clusterByGap(items, { gapMs: MIN });
    expect(clusters).toHaveLength(1);
    const mix = createMix({
      items,
      clusters,
      weights: { cluster: 1, single: 0 },
      avoidRepeatWindow: 0,
      clusterCap: 10,
      rng: mulberry32(5),
    });
    expect(take(mix, 6)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('caps cluster runs at clusterCap with even sampling', () => {
    const items = burst(12, 0, 30_000);
    const clusters = clusterByGap(items, { gapMs: MIN });
    const mix = createMix({
      items,
      clusters,
      weights: { cluster: 1, single: 0 },
      avoidRepeatWindow: 0,
      clusterCap: 5,
      rng: mulberry32(5),
    });
    const run = take(mix, 5);
    expect(run[0]).toBe('p0');
    expect(run[4]).toBe('p11');
    expect(new Set(run).size).toBe(5);
  });

  it('rejects configurations with no usable source', () => {
    const { items, clusters } = library();
    expect(() =>
      createMix({ items, clusters, weights: { cluster: 0, single: 0 }, rng: mulberry32(1) }),
    ).toThrow(/cannot both be 0/);
    expect(() =>
      createMix({ items, weights: { cluster: 1, single: 0 }, rng: mulberry32(1) }),
    ).toThrow(/no non-empty clusters/);
  });

  it('explicitly-undefined weights keep their defaults; non-finite weights throw', () => {
    const { items } = library();
    const mix = createMix({ items, weights: { single: undefined }, rng: mulberry32(4) });
    const valid = new Set(items.map((it) => it.id));
    for (const id of take(mix, 30)) expect(valid.has(id)).toBe(true);
    expect(() => createMix({ items, weights: { single: NaN }, rng: mulberry32(4) })).toThrow(
      /finite/,
    );
  });

  it('with single weight 0 it never leaves the cluster source, replaying when all recent', () => {
    const { items, clusters } = library();
    // Only the 5-photo 'b' cluster: after one run every member is inside the
    // default repeat window, so the mix must replay it, not borrow singles.
    const bOnly = clusters.filter((c) => c.items.every((it) => it.id.startsWith('b')));
    expect(bOnly).toHaveLength(1);
    const mix = createMix({
      items,
      clusters: bOnly,
      weights: { cluster: 1, single: 0 },
      rng: mulberry32(9),
    });
    for (const id of take(mix, 50)) expect(id.startsWith('b')).toBe(true);
  });

  it('with cluster weight 0 it only emits singles from the pool', () => {
    const { items, clusters } = library();
    const mix = createMix({
      items,
      clusters,
      weights: { cluster: 0, single: 1 },
      avoidRepeatWindow: 5,
      rng: mulberry32(11),
    });
    const picks = take(mix, 100);
    const valid = new Set(items.map((it) => it.id));
    for (const id of picks) expect(valid.has(id)).toBe(true);
  });

  it('works with no clusters at all', () => {
    const items = burst(10, 0, MIN);
    const mix = createMix({ items, avoidRepeatWindow: 4, rng: mulberry32(2) });
    expect(take(mix, 50)).toHaveLength(50);
  });

  it('interleaves cluster runs and singles over a long stream', () => {
    const { items, clusters } = library();
    const clusterIds = new Set(clusters.flatMap((c) => c.items.map((i) => i.id)));
    const singleOnlyIds = new Set(items.map((i) => i.id).filter((id) => !clusterIds.has(id)));
    const mix = createMix({
      items,
      clusters,
      avoidRepeatWindow: 8,
      rng: mulberry32(77),
    });
    const picks = take(mix, 400);
    // Both sources appear.
    expect(picks.some((id) => clusterIds.has(id))).toBe(true);
    expect(picks.some((id) => singleOnlyIds.has(id))).toBe(true);
  });
});
