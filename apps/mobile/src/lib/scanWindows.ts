/**
 * Merge-window accumulation for the continuous scan (m0.8 gate 2) — the
 * pure half of scan/scanRunner.ts.
 *
 * The scan pages MediaStore newest→oldest and groups incrementally. The
 * unit of incremental grouping is the MERGE WINDOW: a maximal run of
 * photos in which every consecutive time gap is ≤ the adjacent-merge
 * window (15 min). Core's engine (groupByEmbedding) never links photos
 * across a larger gap — bursts gate at 3 min and adjacent-burst merges
 * stop at 15 min — so grouping window-by-window produces EXACTLY the
 * groups a whole-corpus run would (the plan's "per closed burst",
 * widened to the smallest unit that preserves engine semantics; a
 * literal per-burst unit would re-implement the merge stage app-side).
 *
 * Feed order is newest→oldest; a window CLOSES when the next (older)
 * photo falls more than the merge gap before the window's oldest member,
 * because nothing scanned later can land between them. Closed windows
 * are emitted oldest-member-first-sorted ascending — the order core
 * expects. Same-timestamp disorder within MediaStore's sort is
 * tolerated: a photo only ever closes the window by being definitively
 * older; duplicates (multi-bucket overlap) are dropped by id.
 */
import type { LoadedPhoto } from './media';

export interface WindowAccumulator {
  /** Feed the next (older) photo; returns any windows that just closed. */
  feed(photo: LoadedPhoto): LoadedPhoto[][];
  /** End of the scan: the final in-progress window, if any. */
  flush(): LoadedPhoto[][];
}

/** Chronological ascending, ties by id — the core engine's item order. */
function ascending(photos: LoadedPhoto[]): LoadedPhoto[] {
  return photos.sort(
    (a, b) =>
      a.item.timestamp - b.item.timestamp ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
}

export function createWindowAccumulator(mergeGapMs: number): WindowAccumulator {
  if (!Number.isFinite(mergeGapMs) || mergeGapMs < 0) {
    throw new Error(`createWindowAccumulator: mergeGapMs must be non-negative, got ${mergeGapMs}`);
  }
  let window: LoadedPhoto[] = [];
  let oldest = Infinity;
  const seen = new Set<string>();

  return {
    feed(photo) {
      if (seen.has(photo.item.id)) return [];
      seen.add(photo.item.id);
      const closed: LoadedPhoto[][] = [];
      if (window.length > 0 && oldest - photo.item.timestamp > mergeGapMs) {
        closed.push(ascending(window));
        window = [];
        oldest = Infinity;
      }
      window.push(photo);
      oldest = Math.min(oldest, photo.item.timestamp);
      return closed;
    },
    flush() {
      if (window.length === 0) return [];
      const last = [ascending(window)];
      window = [];
      oldest = Infinity;
      return last;
    },
  };
}
