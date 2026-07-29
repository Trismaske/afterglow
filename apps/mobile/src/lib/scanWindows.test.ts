import { describe, expect, it } from 'vitest';
import type { LoadedPhoto } from './media';
import { createWindowAccumulator } from './scanWindows';

const GAP = 15 * 60_000;

function photo(id: string, timestamp: number): LoadedPhoto {
  return {
    item: { id, timestamp, uri: `file:///dcim/${id}.jpg`, kind: 'photo' },
    rawId: id,
    volumeName: 'external_primary',
    filename: `${id}.jpg`,
    modTime: timestamp,
    width: 4000,
    height: 3000,
    undated: false,
  };
}

function ids(windows: LoadedPhoto[][]): string[][] {
  return windows.map((w) => w.map((p) => p.item.id));
}

describe('createWindowAccumulator', () => {
  it('closes a window only when the next photo is more than the gap older', () => {
    const acc = createWindowAccumulator(GAP);
    expect(acc.feed(photo('c', 100 * 60_000))).toEqual([]);
    expect(acc.feed(photo('b', 90 * 60_000))).toEqual([]); // 10 min — same window
    const closed = acc.feed(photo('a', 60 * 60_000)); // 30 min — closes {b, c}
    expect(ids(closed)).toEqual([['b', 'c']]);
    expect(ids(acc.flush())).toEqual([['a']]);
  });

  it('emits windows chronologically ascending with id tiebreaks', () => {
    const acc = createWindowAccumulator(GAP);
    acc.feed(photo('x', 5_000));
    acc.feed(photo('a', 5_000)); // same timestamp, id orders first
    acc.feed(photo('y', 1_000));
    const [window] = acc.flush();
    expect(window.map((p) => p.item.id)).toEqual(['y', 'a', 'x']);
  });

  it('measures the gap from the OLDEST member, not the newest', () => {
    const acc = createWindowAccumulator(GAP);
    acc.feed(photo('c', 100 * 60_000));
    acc.feed(photo('b', 86 * 60_000)); // 14 min after c — joins
    // 14 min after b but 28 min after c: still within gap of the oldest.
    expect(acc.feed(photo('a', 72 * 60_000))).toEqual([]);
    expect(ids(acc.flush())).toEqual([['a', 'b', 'c']]);
  });

  it('drops duplicate ids (multi-bucket overlap)', () => {
    const acc = createWindowAccumulator(GAP);
    acc.feed(photo('a', 10_000));
    acc.feed(photo('a', 10_000));
    const [window] = acc.flush();
    expect(window).toHaveLength(1);
  });

  it('tolerates same-window disorder without closing early', () => {
    const acc = createWindowAccumulator(GAP);
    acc.feed(photo('b', 10 * 60_000));
    acc.feed(photo('c', 12 * 60_000)); // newer than b — sort ties it out
    expect(ids(acc.flush())).toEqual([['b', 'c']]);
  });

  it('flush is empty when nothing was fed and resets after emitting', () => {
    const acc = createWindowAccumulator(GAP);
    expect(acc.flush()).toEqual([]);
    acc.feed(photo('a', 1_000));
    expect(acc.flush()).toHaveLength(1);
    expect(acc.flush()).toEqual([]);
  });

  it('rejects a negative gap', () => {
    expect(() => createWindowAccumulator(-1)).toThrow(/non-negative/);
  });
});
