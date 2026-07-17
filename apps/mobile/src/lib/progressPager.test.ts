import { describe, expect, it } from 'vitest';
import { createMergedDescendingPager, type PageFetcher } from './progressPager';

interface Item {
  id: string;
  t: number;
}

/** A fetcher over a fixed descending array, paging by index cursor. */
function arrayFetcher(items: Item[]): { fetcher: PageFetcher<Item, number>; calls: number[] } {
  const calls: number[] = [];
  const fetcher: PageFetcher<Item, number> = async (cursor, count) => {
    const start = cursor ?? 0;
    calls.push(count);
    const page = items.slice(start, start + count);
    const nextStart = start + page.length;
    return { items: page, nextCursor: nextStart < items.length ? nextStart : null };
  };
  return { fetcher, calls };
}

const item = (id: string, t: number): Item => ({ id, t });

describe('createMergedDescendingPager', () => {
  it('preserves order for a single bucket across batch boundaries', async () => {
    const { fetcher } = arrayFetcher([item('a', 50), item('b', 40), item('c', 30), item('d', 20)]);
    const pager = createMergedDescendingPager([fetcher], (i) => i.t);
    expect((await pager.next(3)).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(pager.exhausted()).toBe(false);
    expect((await pager.next(3)).map((i) => i.id)).toEqual(['d']);
    expect(pager.exhausted()).toBe(true);
    expect(await pager.next(3)).toEqual([]);
  });

  it('merges two buckets globally newest-first', async () => {
    const a = arrayFetcher([item('a1', 90), item('a2', 60), item('a3', 10)]);
    const b = arrayFetcher([item('b1', 80), item('b2', 70), item('b3', 20)]);
    const pager = createMergedDescendingPager([a.fetcher, b.fetcher], (i) => i.t);
    const all = await pager.next(10);
    expect(all.map((i) => i.id)).toEqual(['a1', 'b1', 'b2', 'a2', 'b3', 'a3']);
    expect(pager.exhausted()).toBe(true);
  });

  it('merges correctly when consumed in small batches', async () => {
    const a = arrayFetcher([item('a1', 9), item('a2', 5), item('a3', 1)]);
    const b = arrayFetcher([item('b1', 8), item('b2', 4)]);
    const pager = createMergedDescendingPager([a.fetcher, b.fetcher], (i) => i.t);
    const out: string[] = [];
    for (;;) {
      const batch = await pager.next(2);
      if (batch.length === 0) break;
      out.push(...batch.map((i) => i.id));
    }
    expect(out).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('ties go to the lower bucket index (deterministic)', async () => {
    const a = arrayFetcher([item('a1', 5)]);
    const b = arrayFetcher([item('b1', 5)]);
    const pager = createMergedDescendingPager([a.fetcher, b.fetcher], (i) => i.t);
    expect((await pager.next(2)).map((i) => i.id)).toEqual(['a1', 'b1']);
  });

  it('handles an empty bucket without stalling', async () => {
    const a = arrayFetcher([]);
    const b = arrayFetcher([item('b1', 3), item('b2', 2)]);
    const pager = createMergedDescendingPager([a.fetcher, b.fetcher], (i) => i.t);
    expect((await pager.next(5)).map((i) => i.id)).toEqual(['b1', 'b2']);
    expect(pager.exhausted()).toBe(true);
  });

  it('treats a zero-item page as exhausted even with a non-null cursor', async () => {
    const fetcher: PageFetcher<Item, number> = async () => ({ items: [], nextCursor: 7 });
    const pager = createMergedDescendingPager([fetcher], (i) => i.t);
    expect(await pager.next(3)).toEqual([]);
    expect(pager.exhausted()).toBe(true);
  });

  it('fetches lazily — no more than one buffered page per bucket', async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`x${i}`, 100 - i));
    const { fetcher, calls } = arrayFetcher(items);
    const pager = createMergedDescendingPager([fetcher], (i) => i.t);
    await pager.next(2);
    expect(calls).toEqual([2]); // one fetch of the requested size
    await pager.next(2);
    expect(calls).toEqual([2, 2]); // refilled only when the buffer drained
  });
});
