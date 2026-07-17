import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@afterglow/core';
import { createPlaylist } from '../src/renderer/playlist';

describe('createPlaylist', () => {
  it('throws on next() when empty', () => {
    const pl = createPlaylist([], mulberry32(1));
    expect(pl.size).toBe(0);
    expect(() => pl.next()).toThrow();
  });

  it('plays every item exactly once per epoch', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const pl = createPlaylist(items, mulberry32(42));
    const epoch = Array.from({ length: items.length }, () => pl.next());
    expect([...epoch].sort()).toEqual([...items].sort());
  });

  it('is shuffled (seeded rng, differs from input order for a big list)', () => {
    const items = Array.from({ length: 50 }, (_, i) => `img-${i}`);
    const pl = createPlaylist(items, mulberry32(7));
    const epoch = Array.from({ length: items.length }, () => pl.next());
    expect(epoch).not.toEqual(items);
  });

  it('never repeats the same item across an epoch boundary', () => {
    const items = ['a', 'b', 'c'];
    for (let seed = 0; seed < 200; seed++) {
      const pl = createPlaylist(items, mulberry32(seed));
      let prev: string | null = null;
      for (let i = 0; i < 30; i++) {
        const cur = pl.next();
        expect(cur, `seed ${seed}, step ${i}`).not.toBe(prev);
        prev = cur;
      }
    }
  });

  it('handles a single-item playlist by repeating it', () => {
    const pl = createPlaylist(['only'], mulberry32(1));
    expect(pl.next()).toBe('only');
    expect(pl.next()).toBe('only');
  });
});
