import { describe, it, expect } from 'vitest';
import {
  createFlagQueue,
  addFlag,
  removeFlag,
  listFlags,
  flagQueueToJSON,
  flagQueueFromJSON,
} from '../src/index';

describe('flag queue', () => {
  const base = () => {
    let q = createFlagQueue();
    q = addFlag(q, { path: '/pics/a.jpg', flagType: 'delete', at: 100 });
    q = addFlag(q, { path: '/pics/b.jpg', flagType: 'edit', at: 200, note: 'crooked horizon' });
    q = addFlag(q, { path: '/pics/a.jpg', flagType: 'review', at: 300 });
    return q;
  };

  it('adds flags and lists them oldest first', () => {
    const q = base();
    expect(listFlags(q).map((e) => [e.path, e.flagType])).toEqual([
      ['/pics/a.jpg', 'delete'],
      ['/pics/b.jpg', 'edit'],
      ['/pics/a.jpg', 'review'],
    ]);
  });

  it('dedupes by (path, flagType), keeping the original entry', () => {
    const q = base();
    const q2 = addFlag(q, { path: '/pics/a.jpg', flagType: 'delete', at: 999 });
    expect(q2).toBe(q); // unchanged state returned as-is
    expect(listFlags(q2)[0].at).toBe(100);
  });

  it('allows the same path under different flag types', () => {
    const q = base();
    expect(listFlags(q).filter((e) => e.path === '/pics/a.jpg')).toHaveLength(2);
  });

  it('filters by flag type', () => {
    const q = base();
    expect(listFlags(q, 'edit').map((e) => e.path)).toEqual(['/pics/b.jpg']);
    expect(listFlags(q, 'move')).toEqual([]);
  });

  it('accepts the v0.5 rename and date flag types, round-tripping through JSON', () => {
    let q = createFlagQueue();
    q = addFlag(q, { path: '/pics/c.jpg', flagType: 'rename', at: 400 });
    q = addFlag(q, { path: '/pics/c.jpg', flagType: 'date', at: 500 });
    const restored = flagQueueFromJSON(JSON.parse(JSON.stringify(flagQueueToJSON(q))));
    expect(listFlags(restored).map((e) => e.flagType)).toEqual(['rename', 'date']);
  });

  it('removes exactly one (path, flagType) pair; no-op when absent', () => {
    const q = base();
    const q2 = removeFlag(q, '/pics/a.jpg', 'delete');
    expect(listFlags(q2).map((e) => [e.path, e.flagType])).toEqual([
      ['/pics/b.jpg', 'edit'],
      ['/pics/a.jpg', 'review'],
    ]);
    expect(removeFlag(q2, '/pics/zzz.jpg', 'delete')).toBe(q2);
  });

  it('is immutable — operations never mutate the input state', () => {
    const q = base();
    const before = listFlags(q);
    addFlag(q, { path: '/pics/new.jpg', flagType: 'move', at: 400 });
    removeFlag(q, '/pics/a.jpg', 'delete');
    expect(listFlags(q)).toEqual(before);
  });

  it('rejects unknown flag types at runtime', () => {
    expect(() =>
      addFlag(createFlagQueue(), {
        path: '/x.jpg',
        // @ts-expect-error deliberately invalid
        flagType: 'star',
        at: 1,
      }),
    ).toThrow();
  });

  it('survives a JSON round trip (via actual stringify/parse)', () => {
    const q = base();
    const restored = flagQueueFromJSON(JSON.parse(JSON.stringify(flagQueueToJSON(q))));
    expect(listFlags(restored)).toEqual(listFlags(q));
  });

  it('fromJSON drops malformed entries but keeps good ones', () => {
    const restored = flagQueueFromJSON({
      version: 1,
      entries: [
        { path: '/ok.jpg', flagType: 'delete', at: 5 },
        { path: 42, flagType: 'delete', at: 5 },
        { path: '/bad-type.jpg', flagType: 'nope', at: 5 },
        { path: '/no-at.jpg', flagType: 'edit' },
        null,
        { path: '/ok.jpg', flagType: 'delete', at: 999 }, // duplicate → deduped
      ],
    });
    expect(listFlags(restored)).toEqual([{ path: '/ok.jpg', flagType: 'delete', at: 5 }]);
  });

  it('fromJSON rejects wrong versions and non-objects', () => {
    expect(() => flagQueueFromJSON(null)).toThrow();
    expect(() => flagQueueFromJSON('[]')).toThrow();
    expect(() => flagQueueFromJSON({ version: 2, entries: [] })).toThrow();
    expect(() => flagQueueFromJSON({ version: 1, entries: 'x' })).toThrow();
  });
});
