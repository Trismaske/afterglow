import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYERS,
  animatedKindOf,
  parseAnimatedThumbsMode,
  playingSet,
  poolSizeFor,
  sameCells,
  spotWalk,
} from './animatedCells';

const cells = (...indices: number[]) => indices.map((index) => ({ index, key: `row${index}` }));

describe('playingSet (settled ∩ visible: entering waits, leaving stops)', () => {
  it('holds only cells that are both settled and still visible', () => {
    expect(playingSet(cells(3, 4, 5, 6, 7, 8), cells(6, 7, 8, 9, 10))).toEqual(cells(6, 7, 8));
  });
  it('is empty while a scroll has taken every settled cell off screen', () => {
    expect(playingSet(cells(0, 1, 2), cells(9, 10, 11))).toEqual([]);
  });
  it('lets a cell that entered play only once it is in the settled set', () => {
    expect(playingSet(cells(0, 1, 2), cells(0, 1, 2, 3))).toEqual(cells(0, 1, 2));
    expect(playingSet(cells(0, 1, 2, 3), cells(0, 1, 2, 3))).toEqual(cells(0, 1, 2, 3));
  });
  it('caps the player cells at the ceiling, top rows first, and never counts GIFs', () => {
    const kinds = (i: number) => (i % 3 === 2 ? ('gif' as const) : ('video' as const));
    const all = cells(0, 1, 2, 3, 4, 5, 6, 7, 8);
    // Six players allowed: indices 0,1,3,4,6,7 are players; 2,5,8 GIFs.
    expect(playingSet(all, all, kinds, 4)).toEqual(cells(0, 1, 2, 3, 4, 5, 8));
    expect(playingSet(all, all, kinds, 0)).toEqual(cells(2, 5, 8));
  });
  it('treats a replacement row at a settled index as a new cell that must settle', () => {
    const settled = cells(0, 1, 2);
    const replaced = [{ index: 0, key: 'other' }, ...cells(1, 2)];
    expect(playingSet(settled, replaced)).toEqual(cells(1, 2));
  });
});

describe('poolSizeFor (the list geometry, never a constant)', () => {
  it('sizes a 3-column grid of 342 dp at 120 dp tiles for two rows plus three', () => {
    expect(poolSizeFor(3, 342, 120)).toBe(15); // the S10e probe under six control rows
  });
  it('sizes a full-height 3-column grid on the S10e', () => {
    expect(poolSizeFor(3, 620, 120)).toBe(24);
  });
  it('sizes a one-thumb-per-row list', () => {
    expect(poolSizeFor(1, 640, 64)).toBe(13);
  });
  it('never returns fewer than the columns on a degenerate height', () => {
    expect(poolSizeFor(4, 0, 90)).toBe(16); // one row assumed, plus three
    expect(poolSizeFor(4, 300, 0)).toBe(4);
  });
});

describe('spotWalk (one at a time skips GIFs)', () => {
  const kinds = new Map([
    [0, 'video' as const],
    [1, 'gif' as const],
    [2, 'motion' as const],
    [3, null],
    [4, 'video' as const],
  ]);
  it('walks the playing set in order, video and motion only', () => {
    expect(spotWalk(cells(0, 1, 2, 3, 4), (i) => kinds.get(i) ?? null)).toEqual(cells(0, 2, 4));
  });
  it('is empty when only GIFs and photos are on screen', () => {
    expect(spotWalk(cells(1, 3), (i) => kinds.get(i) ?? null)).toEqual([]);
  });
});

describe('animatedKindOf', () => {
  it('reads a video by kind, a motion photo by its clip, a GIF by MIME, a photo as nothing', () => {
    expect(animatedKindOf({ kind: 'video', mimeType: 'video/mp4', hasMotion: false })).toBe(
      'video',
    );
    expect(animatedKindOf({ kind: 'photo', mimeType: 'image/jpeg', hasMotion: true })).toBe(
      'motion',
    );
    expect(animatedKindOf({ kind: 'photo', mimeType: 'image/gif', hasMotion: false })).toBe('gif');
    expect(animatedKindOf({ kind: 'photo', mimeType: 'image/jpeg', hasMotion: false })).toBeNull();
    expect(animatedKindOf({ kind: 'photo', mimeType: null, hasMotion: false })).toBeNull();
  });
});

describe('MAX_PLAYERS', () => {
  it('is the measured ceiling, twelve', () => {
    expect(MAX_PLAYERS).toBe(12);
  });
});

describe('parseAnimatedThumbsMode', () => {
  it('accepts the three values and defaults everything else to all', () => {
    expect(parseAnimatedThumbsMode('off')).toBe('off');
    expect(parseAnimatedThumbsMode('one')).toBe('one');
    expect(parseAnimatedThumbsMode('all')).toBe('all');
    expect(parseAnimatedThumbsMode(null)).toBe('all');
    expect(parseAnimatedThumbsMode('strip')).toBe('all');
  });
});

describe('sameCells', () => {
  it('compares cell lists by index, identity and order', () => {
    expect(sameCells(cells(1, 2), cells(1, 2))).toBe(true);
    expect(sameCells(cells(1, 2), cells(2, 1))).toBe(false);
    expect(sameCells(cells(1), [{ index: 1, key: 'other' }])).toBe(false);
    expect(sameCells([], [])).toBe(true);
  });
});
