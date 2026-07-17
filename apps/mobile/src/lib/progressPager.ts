/**
 * Newest-first k-way merged pager (m0.4 stage 3) — pure TypeScript,
 * unit-tested.
 *
 * The progress photo grids page MediaStore newest-first, but a photo
 * source can span several MediaStore buckets (m0.3.1) and getAssetsAsync
 * only queries one album at a time. This pager merges N per-bucket
 * cursor streams into one globally descending stream, fetching lazily:
 * each bucket buffers at most one fetched page beyond what has been
 * consumed, so memory stays O(buckets × page), never the whole scope.
 *
 * Each fetcher must yield items in DESCENDING `timeOf` order and return
 * `nextCursor: null` when exhausted. A fetcher returning zero items is
 * treated as exhausted regardless of its cursor (guards against a
 * misbehaving source causing an infinite loop). Ties across buckets go
 * to the lower bucket index — deterministic.
 */

export interface FetchedPage<T, C> {
  items: T[];
  /** Cursor for the next page; null = no more pages. */
  nextCursor: C | null;
}

/** Fetch one page: `cursor` is undefined for the first page. */
export type PageFetcher<T, C> = (
  cursor: C | undefined,
  count: number,
) => Promise<FetchedPage<T, C>>;

export interface MergedPager<T> {
  /** Up to `count` items, globally newest-first. [] once exhausted. */
  next(count: number): Promise<T[]>;
  /** True when every bucket is drained AND buffered items are consumed. */
  exhausted(): boolean;
}

interface BucketState<T, C> {
  cursor: C | undefined;
  /** The source said "no more pages" (buffer may still hold items). */
  drained: boolean;
  buffer: T[];
}

export function createMergedDescendingPager<T, C = string>(
  fetchers: readonly PageFetcher<T, C>[],
  timeOf: (item: T) => number,
): MergedPager<T> {
  const buckets: BucketState<T, C>[] = fetchers.map(() => ({
    cursor: undefined,
    drained: false,
    buffer: [],
  }));

  async function fill(index: number, count: number): Promise<void> {
    const bucket = buckets[index];
    if (bucket.drained || bucket.buffer.length > 0) return;
    const page = await fetchers[index](bucket.cursor, Math.max(1, count));
    bucket.buffer.push(...page.items);
    if (page.nextCursor === null || page.items.length === 0) bucket.drained = true;
    else bucket.cursor = page.nextCursor;
  }

  return {
    async next(count: number): Promise<T[]> {
      const out: T[] = [];
      while (out.length < count) {
        for (let i = 0; i < buckets.length; i++) await fill(i, count);
        let best = -1;
        for (let i = 0; i < buckets.length; i++) {
          const head = buckets[i].buffer[0];
          if (head === undefined) continue;
          if (best < 0 || timeOf(head) > timeOf(buckets[best].buffer[0])) best = i;
        }
        if (best < 0) break; // everything drained and consumed
        out.push(buckets[best].buffer.shift()!);
      }
      return out;
    },
    exhausted(): boolean {
      return buckets.every((b) => b.drained && b.buffer.length === 0);
    },
  };
}
