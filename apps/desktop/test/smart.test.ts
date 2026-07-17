import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@afterglow/core';
import { createPlaylist } from '../src/renderer/playlist';
import { createSmartPlaylist, createSwappablePlaylist, type SmartItem } from '../src/renderer/smart';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A photo shot at `t` ms past midnight, named for readability. */
function shot(name: string, t: number): SmartItem {
  return { url: `afterglow://media/${name}`, timestampMs: t, kind: 'photo' };
}

/** An 8-shot burst 10 seconds apart, plus singles scattered hours apart. */
function library(): { items: SmartItem[]; burstUrls: string[] } {
  // Singles sit on even 2-hour marks; the burst starts 31 minutes past 12h so
  // no single falls within the 3-minute moment gap of any burst shot.
  const burst = Array.from({ length: 8 }, (_, i) => shot(`burst-${i}.jpg`, 12 * HOUR + 31 * MIN + i * 10_000));
  const singles = Array.from({ length: 30 }, (_, i) => shot(`single-${i}.jpg`, i * 2 * HOUR));
  return { items: [...singles, ...burst], burstUrls: burst.map((b) => b.url) };
}

describe('createSmartPlaylist', () => {
  it('returns null for an empty library', () => {
    expect(createSmartPlaylist([], { gapMinutes: 3, clusterCap: 8, rng: mulberry32(1) })).toBeNull();
  });

  it('reports size and finds the burst as a moment', () => {
    const { items } = library();
    const smart = createSmartPlaylist(items, { gapMinutes: 3, clusterCap: 8, rng: mulberry32(1) })!;
    expect(smart.size).toBe(items.length);
    expect(smart.clusterCount).toBe(1); // only the burst groups; singles are hours apart
  });

  /** True if `window` appears as a consecutive run anywhere in `seq`. */
  function hasRun(seq: string[], run: string[]): boolean {
    return seq.some((_, i) => run.every((u, j) => seq[i + j] === u));
  }

  it('plays a burst of 8 consecutively instead of scattered (the v0.3 bar)', () => {
    const { items, burstUrls } = library();
    const smart = createSmartPlaylist(items, { gapMinutes: 3, clusterCap: 8, rng: mulberry32(7) })!;

    // Pull enough picks that the cluster must have played at least once:
    // the full 8-shot burst must appear as one consecutive chronological run.
    const seq = Array.from({ length: 120 }, () => smart.next());
    expect(hasRun(seq, burstUrls)).toBe(true);
  });

  it('respects the cluster cap (even sampling keeps first and last)', () => {
    const { items, burstUrls } = library();
    const smart = createSmartPlaylist(items, { gapMinutes: 3, clusterCap: 4, rng: mulberry32(3) })!;
    const seq = Array.from({ length: 120 }, () => smart.next());
    // capCluster(8 → 4) samples indices round(i·7/3) = 0, 2, 5, 7.
    const capped = [burstUrls[0], burstUrls[2], burstUrls[5], burstUrls[7]];
    expect(hasRun(seq, capped)).toBe(true);
    // the uncapped 8-run never plays
    expect(hasRun(seq, burstUrls)).toBe(false);
  });

  it('mixes videos into moments exactly like photos (v0.4)', () => {
    const { items, burstUrls } = library();
    // A phone clip shot 25s into the burst joins the same moment and plays
    // in chronological position inside the run.
    const clip: SmartItem = {
      url: 'afterglow://media/clip.mp4',
      timestampMs: 12 * HOUR + 31 * MIN + 25_000,
      kind: 'video',
    };
    const smart = createSmartPlaylist([...items, clip], { gapMinutes: 3, clusterCap: 9, rng: mulberry32(5) })!;
    expect(smart.clusterCount).toBe(1);
    const seq = Array.from({ length: 130 }, () => smart.next());
    const runWithClip = [...burstUrls.slice(0, 3), clip.url, ...burstUrls.slice(3)];
    function hasRun(s: string[], run: string[]): boolean {
      return s.some((_, i) => run.every((u, j) => s[i + j] === u));
    }
    expect(hasRun(seq, runWithClip)).toBe(true);
  });

  it('splits by the configured gap: a wide gap yields no clusters', () => {
    const { items } = library();
    // 10s spacing but a 0-tolerance... minimum gap is 1 minute; shots are 10s
    // apart so they still cluster at 1 min. Push them apart instead:
    const spread = items.map((it, i) => ({ ...it, timestampMs: i * 2 * HOUR }));
    const smart = createSmartPlaylist(spread, { gapMinutes: 3, clusterCap: 8, rng: mulberry32(1) })!;
    expect(smart.clusterCount).toBe(0);
  });
});

describe('createSwappablePlaylist', () => {
  it('delegates and hot-swaps mid-stream', () => {
    const a = createPlaylist(['a1', 'a2'], mulberry32(1));
    const b = createPlaylist(['b1', 'b2', 'b3'], mulberry32(2));
    const swappable = createSwappablePlaylist(a);
    expect(swappable.size).toBe(2);
    expect(swappable.next().startsWith('a')).toBe(true);
    swappable.swap(b);
    expect(swappable.size).toBe(3);
    expect(swappable.next().startsWith('b')).toBe(true);
    expect(swappable.next().startsWith('b')).toBe(true);
  });
});
