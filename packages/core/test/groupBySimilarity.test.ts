/**
 * Grouping v2 corpus tests (m0.7 item B, R#8): similarity-first connected
 * components — time never excludes, bonus only relaxes, null hashes stay
 * singletons, and adversarial chains cannot absorb unrelated endpoints
 * without a genuinely-similar bridge.
 */
import { describe, expect, it } from 'vitest';
import { DHASH_HEX_LENGTH, groupBySimilarity, type MediaItem } from '../src/index.js';

const ZERO = '0'.repeat(DHASH_HEX_LENGTH);
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

/** A 64-bit hash with exactly the given bit indexes set (0 = MSB). */
function hashWithBits(...bits: number[]): string {
  let value = 0n;
  for (const bit of bits) value |= 1n << BigInt(63 - bit);
  return value.toString(16).padStart(DHASH_HEX_LENGTH, '0');
}

/** A hash `distance` bits away from ZERO (deterministic bit choice). */
function hashAtDistance(distance: number, offset = 0): string {
  const bits: number[] = [];
  for (let i = 0; i < distance; i++) bits.push((offset + i) % 64);
  return hashWithBits(...bits);
}

function item(id: string, timestamp: number): MediaItem {
  return { id, timestamp, uri: `file:///${id}.jpg`, kind: 'photo' };
}

function grouped(
  items: MediaItem[],
  hashes: Record<string, string | null>,
  threshold = 20,
  timeBonusMs = 0,
  timeBonusBits = 0,
): string[][] {
  return groupBySimilarity(items, (id) => hashes[id], {
    threshold,
    timeBonusMs,
    timeBonusBits,
  }).map((c) => c.items.map((i) => i.id));
}

describe('groupBySimilarity', () => {
  it('groups the same subject shot once a day for a week (#24 — time never excludes)', () => {
    const items = Array.from({ length: 7 }, (_, day) => item(`d${day}`, T0 + day * DAY));
    const hashes = Object.fromEntries(items.map((i) => [i.id, ZERO]));
    const result = grouped(items, hashes);
    expect(result).toEqual([['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']]);
  });

  it('leaves near-in-time but dissimilar photos as singles', () => {
    const items = [item('a', T0), item('b', T0 + 10_000)];
    const hashes = { a: ZERO, b: hashAtDistance(30) };
    expect(grouped(items, hashes, 20, 180_000, 6)).toEqual([['a'], ['b']]);
  });

  it('admits a borderline pair only inside the time-bonus window', () => {
    const hashes = { a: ZERO, b: hashAtDistance(24) };
    const close = [item('a', T0), item('b', T0 + 60_000)];
    const far = [item('a', T0), item('b', T0 + DAY)];
    expect(grouped(close, hashes, 20, 180_000, 6)).toEqual([['a', 'b']]);
    expect(grouped(far, hashes, 20, 180_000, 6)).toEqual([['a'], ['b']]);
  });

  it('chains a drifting burst but never absorbs an unrelated endpoint', () => {
    // A~B and B~C at 12 bits; A—C at 24 bits: the chain holds all three.
    const hashes: Record<string, string | null> = {
      a: hashAtDistance(12, 0), // bits 0-11
      b: ZERO,
      c: hashAtDistance(12, 12), // bits 12-23 → a↔c distance 24
      // d shares no structure with anything: far from all three.
      d: hashAtDistance(40, 20),
    };
    const items = [item('a', T0), item('b', T0 + 1000), item('c', T0 + 2000), item('d', T0 + 1500)];
    const result = grouped(items, hashes, 12);
    expect(result).toContainEqual(['a', 'b', 'c']);
    expect(result).toContainEqual(['d']);
  });

  it('keeps hashless photos as singletons even between identical shots', () => {
    const items = [item('a', T0), item('x', T0 + 1), item('b', T0 + 2)];
    const hashes: Record<string, string | null> = { a: ZERO, x: null, b: ZERO };
    const result = grouped(items, hashes);
    expect(result).toContainEqual(['a', 'b']);
    expect(result).toContainEqual(['x']);
  });

  it('orders components by earliest member and members chronologically, input-order-independent', () => {
    const items = [
      item('late-pair-1', T0 + 5000),
      item('early-single', T0),
      item('late-pair-2', T0 + 6000),
      item('mid-pair-1', T0 + 2000),
      item('mid-pair-2', T0 + 3000),
    ];
    const hashes: Record<string, string | null> = {
      'late-pair-1': hashAtDistance(50, 5),
      'late-pair-2': hashAtDistance(50, 5),
      'early-single': hashAtDistance(40, 20),
      'mid-pair-1': ZERO,
      'mid-pair-2': ZERO,
    };
    const shuffled = [...items].reverse();
    const a = grouped(items, hashes, 10);
    const b = grouped(shuffled, hashes, 10);
    expect(a).toEqual(b);
    expect(a).toEqual([
      ['early-single'],
      ['mid-pair-1', 'mid-pair-2'],
      ['late-pair-1', 'late-pair-2'],
    ]);
  });

  it('groups repeated common compositions (documented over-grouping tradeoff)', () => {
    // Five near-black frames across five days ARE mutually similar — the
    // tester prefers over-eager grouping (ejecting is one tap, merging is
    // impossible), so this documents rather than fights it.
    const items = Array.from({ length: 5 }, (_, day) => item(`dark${day}`, T0 + day * DAY));
    const hashes = Object.fromEntries(items.map((i, n) => [i.id, hashAtDistance(2, n)]));
    const result = grouped(items, hashes);
    expect(result).toHaveLength(1);
  });

  it('handles the 700-photo hard ceiling within bounds', () => {
    const items: MediaItem[] = [];
    const hashes: Record<string, string | null> = {};
    for (let i = 0; i < 700; i++) {
      items.push(item(`p${i}`, T0 + i * 60_000));
      // 7 clusters of 100 photos. Cluster bit-ranges are 8 bits apart so
      // in-cluster distance stays <= 4 while adjacent clusters sit at
      // distance 8 > threshold — no percolation bridge (an earlier draft
      // with overlapping ranges chained everything into one component,
      // demonstrating exactly the R#8 percolation the corpus pins).
      const cluster = i % 7;
      hashes[`p${i}`] = hashAtDistance(4, cluster * 8 + (i % 3));
    }
    const start = performance.now();
    const result = groupBySimilarity(items, (id) => hashes[id], { threshold: 6 });
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(7); // no percolation across cluster gaps
    const maxComponent = Math.max(...result.map((c) => c.items.length));
    expect(maxComponent).toBe(100);
    expect(elapsed).toBeLessThan(2000); // 244,650 pairs stays well in budget
  });

  it('rejects invalid thresholds and bonuses', () => {
    expect(() => groupBySimilarity([], () => ZERO, { threshold: NaN })).toThrow();
    expect(() => groupBySimilarity([], () => ZERO, { threshold: -1 })).toThrow();
    expect(() =>
      groupBySimilarity([], () => ZERO, { threshold: 5, timeBonusBits: Infinity }),
    ).toThrow();
  });
});
