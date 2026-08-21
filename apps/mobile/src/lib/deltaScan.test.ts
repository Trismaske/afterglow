import { describe, expect, it } from 'vitest';
import {
  coveredBy,
  describeDeltaPlan,
  deltaVerdict,
  filterChangedToSources,
  planDeltaRanges,
  rangesForTargets,
} from './deltaScan';
import type { ChangedMediaRow } from '../../modules/media-store-actions';

const GAP = 15 * 60_000;
const MIN = 60_000;
const T = 1_800_000_000_000;

function row(over: Partial<ChangedMediaRow> = {}): ChangedMediaRow {
  return {
    volumeName: 'external_primary',
    rawId: '1',
    dateTakenMs: T,
    dateModifiedSec: T / 1000,
    isTrashed: false,
    generationAdded: 10,
    generationModified: 10,
    bucketId: '100',
    ...over,
  };
}

/** Library timestamps, ascending, at minute offsets from T. */
const lib = (...minutes: number[]) => minutes.map((m) => T + m * MIN).sort((a, b) => a - b);

describe('planDeltaRanges', () => {
  it('walks the WHOLE chain, not a fixed window around the change', () => {
    // Photos every 10 minutes for two hours are ONE merge window: each
    // consecutive gap is under 15 min, and scanWindows only closes a
    // window at a real break. Expanding ±15 min around the changed photo
    // would re-page a fragment and group it in isolation — different
    // groups from a full pass, which is the bug this walk prevents.
    const timestamps = lib(0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120);
    const plan = planDeltaRanges([row({ dateTakenMs: T + 60 * MIN })], timestamps, GAP);
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T + 120 * MIN, changed: 1 }]);
  });

  it('stops at a real break on each side', () => {
    // A chain at 0..30, an hour of silence, then 90..120. Changing a
    // photo in the first chain must not drag the second one in.
    const timestamps = lib(0, 10, 20, 30, 90, 100, 110, 120);
    const plan = planDeltaRanges([row({ dateTakenMs: T + 20 * MIN })], timestamps, GAP);
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T + 30 * MIN, changed: 1 }]);
  });

  it('gives an isolated photo a zero-width range — its window is itself', () => {
    const plan = planDeltaRanges([row()], lib(0, 60, 120), GAP);
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T, changed: 1 }]);
  });

  it('places a BRAND-NEW photo that is not tracked yet', () => {
    // A new photo has no row, so it is absent from the timestamps — but
    // it still joins its neighbours' window, and the walk starts from
    // its own timestamp.
    const plan = planDeltaRanges([row({ dateTakenMs: T + 30 * MIN })], lib(0, 10, 20), GAP);
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T + 30 * MIN, changed: 1 }]);
  });

  it('collapses several changes inside ONE window into one range', () => {
    const plan = planDeltaRanges(
      [
        row({ rawId: '1', dateTakenMs: T }),
        row({ rawId: '2', dateTakenMs: T + 20 * MIN }),
        row({ rawId: '3', dateTakenMs: T + 40 * MIN }),
      ],
      lib(0, 10, 20, 30, 40),
      GAP,
    );
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T + 40 * MIN, changed: 3 }]);
  });

  it('keeps changes in different windows as separate ranges', () => {
    const plan = planDeltaRanges(
      [row({ rawId: '1', dateTakenMs: T }), row({ rawId: '2', dateTakenMs: T + 90 * MIN })],
      lib(0, 10, 90, 100),
      GAP,
    );
    expect(plan.ranges).toEqual([
      { startMs: T, endMs: T + 10 * MIN, changed: 1 },
      { startMs: T + 90 * MIN, endMs: T + 100 * MIN, changed: 1 },
    ]);
  });

  it('is order-independent', () => {
    const timestamps = lib(0, 10, 90, 100);
    const rows = [
      row({ rawId: '1', dateTakenMs: T + 90 * MIN }),
      row({ rawId: '2', dateTakenMs: T }),
    ];
    expect(planDeltaRanges(rows, timestamps, GAP)).toEqual(
      planDeltaRanges([...rows].reverse(), timestamps, GAP),
    );
  });

  it('degenerates to the whole library when it is one unbroken chain', () => {
    // Not a failure: the cost model then correctly picks the full pass.
    const timestamps = Array.from({ length: 500 }, (_, i) => T + i * 10 * MIN);
    const plan = planDeltaRanges([row({ dateTakenMs: timestamps[250] })], timestamps, GAP);
    expect(plan.ranges).toEqual([{ startMs: timestamps[0], endMs: timestamps[499], changed: 1 }]);
  });

  it('counts an MTIME-only row as undated — no range query can fetch it', () => {
    // Device-measured: WhatsApp images have datetaken=NULL, and the scan
    // GROUPS them by `creationTime || modificationTime` — but the range
    // re-page filters on DATE_TAKEN alone, so a range built from the
    // mtime fallback would claim coverage the query cannot deliver and
    // the modification would silently never be re-ingested. Unrangeable
    // rows are routed to the planner's direct per-id fetch (F27).
    const plan = planDeltaRanges(
      [row({ dateTakenMs: null, dateModifiedSec: T / 1000 })],
      lib(0),
      GAP,
    );
    expect(plan.undated).toBe(1);
    expect(plan.ranges).toEqual([]);
  });

  it('counts a row with NEITHER stamp as undated — nothing can place it', () => {
    const plan = planDeltaRanges(
      [row({ dateTakenMs: null, dateModifiedSec: null }), row({ rawId: '2' })],
      lib(0),
      GAP,
    );
    expect(plan.undated).toBe(1);
    expect(plan.ranges).toHaveLength(1);
  });

  it('prefers DATE_TAKEN over mtime when both exist, like the scan', () => {
    const plan = planDeltaRanges(
      [row({ dateTakenMs: T, dateModifiedSec: (T + 100 * GAP) / 1000 })],
      lib(0),
      GAP,
    );
    expect(plan.ranges).toEqual([{ startMs: T, endMs: T, changed: 1 }]);
  });

  it('counts TRASHED changes — the whole reason deletions are visible', () => {
    // On Android 11+ a gallery "delete" is createTrashRequest: the row
    // survives with IS_TRASHED set, so the deletion arrives as an
    // ordinary modified row rather than as an absence to be inferred.
    const plan = planDeltaRanges([row({ isTrashed: true }), row({ rawId: '2' })], lib(0), GAP);
    expect(plan.trashed).toBe(1);
    expect(plan.changed).toBe(2);
  });

  it('has nothing to do for an empty change set', () => {
    expect(planDeltaRanges([], lib(0, 10), GAP)).toEqual({
      ranges: [],
      undated: 0,
      trashed: 0,
      changed: 0,
    });
  });

  it('copes with an empty library', () => {
    expect(planDeltaRanges([row()], [], GAP).ranges).toEqual([
      { startMs: T, endMs: T, changed: 1 },
    ]);
  });
});

describe('coveredBy', () => {
  it('counts the photos the delta would re-page', () => {
    const ranges = [
      { startMs: T, endMs: T + 20 * MIN, changed: 1 },
      { startMs: T + 90 * MIN, endMs: T + 100 * MIN, changed: 1 },
    ];
    expect(coveredBy(lib(0, 10, 20, 90, 100), ranges)).toBe(5);
  });

  it('includes both bounds and excludes what falls between ranges', () => {
    const timestamps = lib(0, 30, 60);
    expect(coveredBy(timestamps, [{ startMs: T, endMs: T, changed: 1 }])).toBe(1);
    expect(coveredBy(timestamps, [{ startMs: T + 1, endMs: T + 29 * MIN, changed: 1 }])).toBe(0);
  });

  it('is zero without ranges', () => {
    expect(coveredBy(lib(0, 10), [])).toBe(0);
  });
});

describe('deltaVerdict', () => {
  it('runs the delta when it would touch a small slice of the library', () => {
    const verdict = deltaVerdict({ covered: 120, changed: 3, ranges: 2, corpus: 27_035 });
    expect(verdict.cost).toBe(127); // 120 + 3 + 2×2
    expect(verdict.budget).toBe(13_517.5);
    expect(verdict.worthIt).toBe(true);
  });

  it('falls back to a full pass once the ranges cover half the library', () => {
    expect(deltaVerdict({ covered: 3_000, changed: 0, ranges: 5, corpus: 5_795 }).worthIt).toBe(
      false,
    );
  });

  it('scales with the corpus instead of hard-coding one phone', () => {
    // The same change set: cheap on a big library, not worth it on a
    // small one. A constant range cap cannot express this.
    const args = { covered: 2_000, changed: 10, ranges: 40 };
    expect(deltaVerdict({ ...args, corpus: 27_035 }).worthIt).toBe(true);
    expect(deltaVerdict({ ...args, corpus: 3_000 }).worthIt).toBe(false);
  });

  it('charges for ranges, so scatter is not free', () => {
    const spread = deltaVerdict({ covered: 0, changed: 0, ranges: 3_000, corpus: 10_000 });
    expect(spread.cost).toBe(6_000);
    expect(spread.worthIt).toBe(false);
  });

  it('still runs for a deletion-only change set with no ranges at all', () => {
    // A trashed photo with no neighbours to regroup: nothing to re-page,
    // but the row still has to be marked absent.
    expect(deltaVerdict({ covered: 0, changed: 1, ranges: 0, corpus: 5_795 }).worthIt).toBe(true);
  });

  it('refuses on an empty corpus rather than dividing into nothing', () => {
    expect(deltaVerdict({ covered: 0, changed: 1, ranges: 0, corpus: 0 }).worthIt).toBe(false);
  });
});

describe('describeDeltaPlan', () => {
  it('says nothing changed, plainly', () => {
    expect(describeDeltaPlan(planDeltaRanges([], lib(0), GAP))).toBe('delta: nothing changed');
  });

  it('reports the counts a field measurement needs', () => {
    const plan = planDeltaRanges([row({ isTrashed: true }), row({ rawId: '2' })], lib(0, 15), GAP);
    expect(describeDeltaPlan(plan)).toBe(
      'delta: 2 changed (1 trashed, 0 undated) → 1 ranges spanning 15 min',
    );
  });

  it('states the cost decision when one was taken', () => {
    const plan = planDeltaRanges([row()], lib(0), GAP);
    const line = describeDeltaPlan(
      plan,
      deltaVerdict({ covered: 40, changed: 1, ranges: 1, corpus: 5_000 }),
    );
    expect(line).toContain('cost 43 vs budget 2500 photos: DELTA wins');
  });
});

/**
 * PARITY — the property the whole delta rests on.
 *
 * A full pass groups each maximal ≤gap chain (a merge window) as a unit.
 * A delta pass only re-pages its ranges, so it can only reproduce those
 * groups if every window containing a changed photo lies ENTIRELY inside
 * one range. Checked over pseudo-random libraries rather than examples,
 * because the failure this replaces — a fixed ±gap expansion — passed
 * every example anyone would think to write, and broke on long chains.
 */
describe('delta/full parity', () => {
  /** Deterministic LCG: a regression test must not depend on the run. */
  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  /** The windows a FULL pass would build: maximal ≤gap chains. */
  function fullPassWindows(sorted: readonly number[], gapMs: number): number[][] {
    const windows: number[][] = [];
    for (const at of sorted) {
      const current = windows[windows.length - 1];
      if (current && at - current[current.length - 1] <= gapMs) current.push(at);
      else windows.push([at]);
    }
    return windows;
  }

  for (const seed of [1, 7, 42, 1234, 99_999]) {
    it(`covers every affected window whole (seed ${seed})`, () => {
      const next = rng(seed);
      // A library of bursts and silences — the shape that produces long
      // chains next to isolated photos.
      const timestamps: number[] = [];
      let cursor = T;
      while (timestamps.length < 300) {
        const burst = 1 + Math.floor(next() * 25);
        for (let i = 0; i < burst; i += 1) {
          timestamps.push(cursor);
          cursor += Math.floor(next() * GAP); // always within the gap
        }
        cursor += GAP + Math.floor(next() * 4 * GAP); // a real break
      }
      timestamps.sort((a, b) => a - b);

      const changedAts = Array.from({ length: 8 }, () => {
        return timestamps[Math.floor(next() * timestamps.length)];
      });
      const changed = changedAts.map((at, i) =>
        row({ rawId: String(i), dateTakenMs: at, dateModifiedSec: null }),
      );
      const { ranges } = planDeltaRanges(changed, timestamps, GAP);
      const windows = fullPassWindows(timestamps, GAP);

      for (const window of windows) {
        if (!window.some((at) => changedAts.includes(at))) continue;
        // Every member of an affected window must sit in ONE range —
        // grouping a fragment would produce different groups.
        const holder = ranges.find((r) => window[0] >= r.startMs && window[0] <= r.endMs);
        expect(holder, `window starting ${window[0]} has no range`).toBeDefined();
        for (const at of window) {
          expect(at).toBeGreaterThanOrEqual(holder!.startMs);
          expect(at).toBeLessThanOrEqual(holder!.endMs);
        }
      }

      // And no range may reach beyond the windows it exists for: the
      // delta must not quietly become a full pass.
      for (const range of ranges) {
        const inside = timestamps.filter((at) => at >= range.startMs && at <= range.endMs);
        expect(inside.length).toBeLessThan(timestamps.length);
      }
    });
  }

  it('re-pages nothing beyond the affected window in the simple case', () => {
    // One burst, one silence, one burst. Changing a photo in the first
    // must leave the second entirely alone.
    const timestamps = lib(0, 5, 10, 15, 200, 205, 210);
    const { ranges } = planDeltaRanges([row({ dateTakenMs: T + 5 * MIN })], timestamps, GAP);
    expect(ranges).toEqual([{ startMs: T, endMs: T + 15 * MIN, changed: 1 }]);
    expect(coveredBy(timestamps, ranges)).toBe(4);
  });
});

describe('filterChangedToSources (F27, m0.8.7)', () => {
  const scope = { external_primary: ['100', '200'], sdcard: ['300'] };

  it('passes All-folders (null scope) through untouched', () => {
    const rows = [row(), row({ bucketId: '999' }), row({ bucketId: null })];
    expect(filterChangedToSources(rows, null)).toEqual(rows);
  });

  it('keeps in-source rows and drops out-of-source ones (the measured WhatsApp case)', () => {
    const whatsapp = row({ rawId: '7', bucketId: '555' });
    const camera = row({ rawId: '8', bucketId: '100' });
    expect(filterChangedToSources([whatsapp, camera], scope)).toEqual([camera]);
  });

  it('keys on the row CURRENT bucket, so a move INTO a source registers', () => {
    // The photo used to live in bucket 555 (unselected); MediaStore now
    // reports it in 200 — the filter sees only "now", which is the point.
    const moved = row({ rawId: '9', bucketId: '200' });
    expect(filterChangedToSources([moved], scope)).toEqual([moved]);
  });

  it('scopes buckets per volume — the same bucket id on another volume does not match', () => {
    const wrongVolume = row({ volumeName: 'sdcard', bucketId: '100' });
    const rightVolume = row({ volumeName: 'sdcard', bucketId: '300' });
    expect(filterChangedToSources([wrongVolume, rightVolume], scope)).toEqual([rightVolume]);
  });

  it('always passes trashed rows — a deletion is id-keyed reconcile work wherever it sits', () => {
    const trashedOutOfSource = row({ rawId: '10', bucketId: '555', isTrashed: true });
    const trashedNullBucket = row({ rawId: '11', bucketId: null, isTrashed: true });
    expect(filterChangedToSources([trashedOutOfSource, trashedNullBucket], scope)).toEqual([
      trashedOutOfSource,
      trashedNullBucket,
    ]);
  });

  it('drops a null-bucket non-trashed row under a dirs scope, like the paging it mirrors', () => {
    expect(filterChangedToSources([row({ bucketId: null })], scope)).toEqual([]);
  });
});

describe('rangesForTargets (targeted window rescan, Regroup_design §5)', () => {
  it('walks the whole window around a target, like a changed photo', () => {
    const timestamps = lib(0, 10, 20, 30, 90, 100);
    expect(rangesForTargets([T + 20 * MIN], timestamps, GAP)).toEqual([
      { startMs: T, endMs: T + 30 * MIN, changed: 1 },
    ]);
  });

  it('merges targets that share a window; keeps separate windows apart', () => {
    const timestamps = lib(0, 10, 90, 100);
    expect(rangesForTargets([T + 10 * MIN, T, T + 90 * MIN], timestamps, GAP)).toEqual([
      { startMs: T, endMs: T + 10 * MIN, changed: 2 },
      { startMs: T + 90 * MIN, endMs: T + 100 * MIN, changed: 1 },
    ]);
  });
});
