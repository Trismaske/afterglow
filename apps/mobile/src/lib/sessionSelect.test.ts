import { describe, expect, it } from 'vitest';
import { applySessionCap, bucketNeedsMore, MAX_GROUP_EXTENSION } from './sessionSelect';

const GAP = 3 * 60_000; // core MOMENTS_GAP_MS

/** Timestamps: n photos `stepMs` apart starting at `start`. */
function burst(start: number, n: number, stepMs = 1000): number[] {
  return Array.from({ length: n }, (_, i) => start + i * stepMs);
}

const id = (t: number) => t;

describe('applySessionCap', () => {
  it('returns everything untouched when under the cap', () => {
    const photos = burst(0, 5);
    expect(applySessionCap(photos, id, 10, true, GAP)).toEqual({
      selected: photos,
      capped: false,
    });
  });

  it('cuts exactly at the cap when splitting is allowed', () => {
    const photos = burst(0, 20);
    const r = applySessionCap(photos, id, 8, false, GAP);
    expect(r.selected).toEqual(photos.slice(0, 8));
    expect(r.capped).toBe(true);
  });

  it('cuts at the cap when it happens to land on a group boundary', () => {
    // Two groups of 5, far apart; cap = 5 lands exactly between them.
    const photos = [...burst(0, 5), ...burst(10 * GAP, 5)];
    const r = applySessionCap(photos, id, 5, true, GAP);
    expect(r.selected).toEqual(burst(0, 5));
    expect(r.capped).toBe(true);
  });

  it('extends past a mid-group cap to the whole group (soft cap)', () => {
    // Group of 8 then a far-away group; cap = 5 lands mid-first-group.
    const photos = [...burst(0, 8), ...burst(10 * GAP, 4)];
    const r = applySessionCap(photos, id, 5, true, GAP);
    expect(r.selected).toEqual(burst(0, 8));
    expect(r.capped).toBe(true);
  });

  it('a gap of exactly gapMs still chains (matches clusterByGap)', () => {
    const photos = [0, GAP, 2 * GAP, 2 * GAP + GAP + 1];
    const r = applySessionCap(photos, id, 2, true, GAP);
    expect(r.selected).toEqual([0, GAP, 2 * GAP]);
    expect(r.capped).toBe(true);
  });

  it('is not capped when the group extension consumes the whole stream', () => {
    const photos = burst(0, 10);
    const r = applySessionCap(photos, id, 5, true, GAP);
    expect(r.selected).toEqual(photos);
    expect(r.capped).toBe(false);
  });

  it('works on newest-first (descending) streams via absolute gaps', () => {
    const photos = [...burst(10 * GAP, 6).reverse(), ...burst(0, 4).reverse()];
    const r = applySessionCap(photos, id, 8, true, GAP);
    // Cap lands mid the older group → extend to its (older) end.
    expect(r.selected).toEqual(photos);
    expect(r.capped).toBe(false);
  });

  it('newest-first: extends only to the group boundary, not further', () => {
    const newestGroup = burst(10 * GAP, 5).reverse();
    const olderGroup = burst(0, 5).reverse();
    const photos = [...newestGroup, ...olderGroup];
    const r = applySessionCap(photos, id, 3, true, GAP);
    expect(r.selected).toEqual(newestGroup);
    expect(r.capped).toBe(true);
  });

  it('bounds the extension for pathological gap-free streams', () => {
    const photos = burst(0, 1000);
    const r = applySessionCap(photos, id, 50, true, GAP);
    expect(r.selected.length).toBe(50 + MAX_GROUP_EXTENSION);
    expect(r.capped).toBe(true);
  });
});

describe('bucketNeedsMore', () => {
  it('needs more while under the cap', () => {
    expect(bucketNeedsMore(burst(0, 3), id, 5, true, GAP)).toBe(true);
    expect(bucketNeedsMore(burst(0, 3), id, 5, false, GAP)).toBe(true);
  });

  it('stops at the cap when splitting is allowed', () => {
    expect(bucketNeedsMore(burst(0, 5), id, 5, false, GAP)).toBe(false);
  });

  it('keeps paging while the group at the cut is still open', () => {
    expect(bucketNeedsMore(burst(0, 5), id, 5, true, GAP)).toBe(true); // next photo unknown
    expect(bucketNeedsMore(burst(0, 7), id, 5, true, GAP)).toBe(true); // still chaining
  });

  it('stops once a gap closes the group past the cap', () => {
    const photos = [...burst(0, 6), 100 * GAP];
    expect(bucketNeedsMore(photos, id, 5, true, GAP)).toBe(false);
  });

  it('stops at the extension bound even without a gap', () => {
    const photos = burst(0, 5 + MAX_GROUP_EXTENSION);
    expect(bucketNeedsMore(photos, id, 5, true, GAP)).toBe(false);
  });
});
