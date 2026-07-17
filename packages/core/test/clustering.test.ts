import { describe, it, expect } from 'vitest';
import {
  clusterByGap,
  clusterMoments,
  clusterSessions,
  capCluster,
  MOMENTS_GAP_MS,
  SESSIONS_GAP_MS,
} from '../src/index';
import { burst, item } from './helpers';

const MIN = 60_000;

describe('clusterByGap', () => {
  it('returns [] for empty input', () => {
    expect(clusterByGap([], { gapMs: 1000 })).toEqual([]);
  });

  it('single item becomes a single 1-item cluster', () => {
    const [c, ...rest] = clusterByGap([item('a', 500)], { gapMs: 1000 });
    expect(rest).toEqual([]);
    expect(c.items.map((i) => i.id)).toEqual(['a']);
    expect(c.start).toBe(500);
    expect(c.end).toBe(500);
  });

  it('identical timestamps land in one cluster', () => {
    const items = [item('b', 1000), item('a', 1000), item('c', 1000)];
    const clusters = clusterByGap(items, { gapMs: 0 });
    expect(clusters).toHaveLength(1);
    // ties broken by id for determinism
    expect(clusters[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('a gap of exactly gapMs stays together; gapMs + 1 splits', () => {
    const together = clusterByGap([item('a', 0), item('b', 1000)], { gapMs: 1000 });
    expect(together).toHaveLength(1);

    const split = clusterByGap([item('a', 0), item('b', 1001)], { gapMs: 1000 });
    expect(split).toHaveLength(2);
    expect(split[0].items.map((i) => i.id)).toEqual(['a']);
    expect(split[1].items.map((i) => i.id)).toEqual(['b']);
  });

  it('sorts unsorted input and clusters chronologically', () => {
    const items = [item('c', 10_000), item('a', 0), item('b', 500)];
    const clusters = clusterByGap(items, { gapMs: 1000 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0].items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(clusters[1].items.map((i) => i.id)).toEqual(['c']);
    expect(clusters[0].start).toBe(0);
    expect(clusters[0].end).toBe(500);
  });

  it('gap is measured between consecutive items, not from cluster start', () => {
    // Chain: each 900ms apart, total span 2700ms > gap — still one cluster.
    const items = burst(4, 0, 900);
    expect(clusterByGap(items, { gapMs: 1000 })).toHaveLength(1);
  });

  it('every input item lands in exactly one cluster', () => {
    const items = [...burst(5, 0, MIN), ...burst(3, 10 * MIN, MIN, 'q')];
    const clusters = clusterByGap(items, { gapMs: 2 * MIN });
    const all = clusters.flatMap((c) => c.items.map((i) => i.id)).sort();
    expect(all).toEqual(items.map((i) => i.id).sort());
  });

  it('cluster ids are deterministic across re-clustering', () => {
    const items = burst(6, 5000, MIN);
    const a = clusterByGap(items, { gapMs: 2 * MIN });
    const b = clusterByGap([...items].reverse(), { gapMs: 2 * MIN });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it('rejects negative or non-finite gapMs', () => {
    expect(() => clusterByGap([], { gapMs: -1 })).toThrow();
    expect(() => clusterByGap([], { gapMs: NaN })).toThrow();
  });
});

describe('presets', () => {
  it('moments splits at >3 min, sessions keeps the same items together', () => {
    // Two bursts 10 minutes apart.
    const items = [...burst(4, 0, 30_000), ...burst(4, 10 * MIN, 30_000, 'q')];
    expect(clusterMoments(items)).toHaveLength(2);
    expect(clusterSessions(items)).toHaveLength(1);
  });

  it('exports sensible default gaps', () => {
    expect(MOMENTS_GAP_MS).toBe(3 * MIN);
    expect(SESSIONS_GAP_MS).toBe(30 * MIN);
  });
});

describe('capCluster', () => {
  const cluster = () => clusterByGap(burst(10, 0, 1000), { gapMs: 5000 })[0];

  it('returns the cluster unchanged when within cap', () => {
    const c = cluster();
    expect(capCluster(c, 10)).toBe(c);
    expect(capCluster(c, 20)).toBe(c);
  });

  it('samples evenly when over cap, keeping first and last, order preserved', () => {
    const c = capCluster(cluster(), 4);
    expect(c.items).toHaveLength(4);
    expect(c.items[0].id).toBe('p0');
    expect(c.items[3].id).toBe('p9');
    const stamps = c.items.map((i) => i.timestamp);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    // Even spread: 0, 3, 6, 9
    expect(c.items.map((i) => i.id)).toEqual(['p0', 'p3', 'p6', 'p9']);
  });

  it('never duplicates items when sampling', () => {
    for (let cap = 1; cap <= 10; cap++) {
      const ids = capCluster(cluster(), cap).items.map((i) => i.id);
      expect(new Set(ids).size).toBe(Math.min(cap, 10));
    }
  });

  it('cap of 1 picks a middle item', () => {
    const c = capCluster(cluster(), 1);
    expect(c.items).toHaveLength(1);
    expect(c.items[0].id).toBe('p4');
  });

  it('rejects non-positive or fractional caps', () => {
    expect(() => capCluster(cluster(), 0)).toThrow();
    expect(() => capCluster(cluster(), -3)).toThrow();
    expect(() => capCluster(cluster(), 2.5)).toThrow();
  });

  it('does not mutate the original cluster', () => {
    const c = cluster();
    capCluster(c, 3);
    expect(c.items).toHaveLength(10);
  });
});
