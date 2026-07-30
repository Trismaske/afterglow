/**
 * Per-volume scan contract math (m0.8.3 phase 2) — one describe per plan
 * §4 invariant the pure layer carries. Volume names follow the real
 * devices: 'external_primary' and the S10e's SD UUID '0a91-e18d'.
 */
import { describe, expect, it } from 'vitest';
import {
  filterGenerationsToVolumes,
  missingGenerationVolumes,
  mergeGenerationBaselines,
  neverSeenVolumes,
  rawVolumeOfKey,
  scopeRelevantVolumes,
  volumesDisagreeingAfterDelta,
  volumesWithUntracedLoss,
} from './volumeScan';

const PRIMARY = 'external_primary';
const SD = '0a91-e18d';
const OTHER = 'ffff-0001';

describe('scope-relevant volumes (invariants 5 + 7)', () => {
  it('All folders: every mounted volume is relevant', () => {
    expect(scopeRelevantVolumes([PRIMARY, SD], null)).toEqual([PRIMARY, SD]);
  });

  it('dirs: only volumes some root names — an out-of-scope card is ignored entirely', () => {
    const roots = [{ volume: PRIMARY, dir: 'DCIM/Camera' }];
    expect(scopeRelevantVolumes([PRIMARY, SD], roots)).toEqual([PRIMARY]);
    // Adding an SD root brings the SD volume in.
    expect(
      scopeRelevantVolumes([PRIMARY, SD], [...roots, { volume: SD, dir: 'DCIM/100MSDCF' }]),
    ).toEqual([PRIMARY, SD]);
  });

  it('an unmounted root volume is simply not there (invariant 2: skipped, not compared)', () => {
    expect(scopeRelevantVolumes([PRIMARY], [{ volume: SD, dir: 'DCIM/100MSDCF' }])).toEqual([]);
  });
});

describe('generation-key filtering (invariant 7)', () => {
  it('keeps only listed volumes, recognizing version-baked keys', () => {
    expect(rawVolumeOfKey(`${SD}|v123`)).toBe(SD);
    expect(rawVolumeOfKey(SD)).toBe(SD);
    const generations = { [`${PRIMARY}|v1`]: 10, [`${SD}|v1`]: 7, [`${OTHER}|v1`]: 99 };
    expect(filterGenerationsToVolumes(generations, new Set([PRIMARY, SD]))).toEqual({
      [`${PRIMARY}|v1`]: 10,
      [`${SD}|v1`]: 7,
    });
  });

  it('an out-of-scope volume cannot defeat the skip: its activity never enters the map', () => {
    const before = filterGenerationsToVolumes(
      { [`${PRIMARY}|v1`]: 10, [`${OTHER}|v1`]: 1 },
      new Set([PRIMARY]),
    );
    const after = filterGenerationsToVolumes(
      { [`${PRIMARY}|v1`]: 10, [`${OTHER}|v1`]: 2 },
      new Set([PRIMARY]),
    );
    expect(before).toEqual(after);
  });
});

describe('baseline merge (invariants 2 + 4)', () => {
  it('retains stored entries for volumes absent from the current pass (unmounted)', () => {
    const merged = mergeGenerationBaselines(
      { [`${PRIMARY}|v1`]: 10, [`${SD}|v1`]: 7 },
      { [`${PRIMARY}|v1`]: 12 },
    );
    // The ejected card's baseline survives untouched — remount resumes
    // its delta from generation 7 (invariant 4).
    expect(merged).toEqual({ [`${PRIMARY}|v1`]: 12, [`${SD}|v1`]: 7 });
  });

  it('replaces per RAW VOLUME, so a provider rebuild leaves no stale twin key', () => {
    const merged = mergeGenerationBaselines({ [`${PRIMARY}|v1`]: 10 }, { [`${PRIMARY}|v2`]: 3 });
    expect(merged).toEqual({ [`${PRIMARY}|v2`]: 3 });
  });

  it('handles a null stored map (first pass)', () => {
    expect(mergeGenerationBaselines(null, { [`${PRIMARY}|v1`]: 1 })).toEqual({
      [`${PRIMARY}|v1`]: 1,
    });
  });
});

describe('per-volume tripwires (invariant 1)', () => {
  it('flags only volumes holding FEWER photos than tracked, net of in-flight trash', () => {
    expect(
      volumesWithUntracedLoss({
        // Real loss on SD: 3 tracked, 2 remain, none explained by trash.
        [SD]: { media: 2, tracked: 3, trashedInFlight: 0 },
        // Primary's shortfall is fully explained by in-flight trashed rows.
        [PRIMARY]: { media: 8, tracked: 10, trashedInFlight: 2 },
      }),
    ).toEqual([SD]);
  });

  it('never flags MORE photos — not-yet-ingested additions are the delta’s normal input', () => {
    expect(
      volumesWithUntracedLoss({ [PRIMARY]: { media: 12, tracked: 10, trashedInFlight: 0 } }),
    ).toEqual([]);
  });

  it('post-delta agreement is exact per volume, both directions', () => {
    expect(
      volumesDisagreeingAfterDelta({ [PRIMARY]: 10, [SD]: 5 }, { [PRIMARY]: 10, [SD]: 4 }),
    ).toEqual([SD]);
    expect(volumesDisagreeingAfterDelta({ [PRIMARY]: 10 }, { [PRIMARY]: 11 })).toEqual([PRIMARY]);
    expect(volumesDisagreeingAfterDelta({ [PRIMARY]: 10 }, { [PRIMARY]: 10 })).toEqual([]);
  });

  it('a volume with no tracked rows yet reads as 0, not a crash', () => {
    expect(volumesDisagreeingAfterDelta({ [SD]: 0 }, {})).toEqual([]);
    expect(volumesDisagreeingAfterDelta({ [SD]: 3 }, {})).toEqual([SD]);
  });
});

describe('never-seen volumes (invariant 5)', () => {
  it('a card the baseline has never met has no delta "since" — full pass', () => {
    expect(neverSeenVolumes([`${PRIMARY}|v1`, `${SD}|v1`], { [`${PRIMARY}|v1`]: 10 })).toEqual([
      SD,
    ]);
  });

  it('known volumes pass through silently', () => {
    expect(neverSeenVolumes([`${PRIMARY}|v1`], { [`${PRIMARY}|v1`]: 10 })).toEqual([]);
  });
});

describe('missingGenerationVolumes (Q1/R2)', () => {
  it('matches versioned keys by their raw volume component', () => {
    const generations = { 'external_primary|1234': 42, '0a91-e18d|1234': 7 };
    expect(
      missingGenerationVolumes(generations, new Set(['external_primary', '0a91-e18d'])),
    ).toEqual([]);
  });

  it('reports a mounted volume the generation read never saw', () => {
    const generations = { 'external_primary|1234': 42 };
    expect(
      missingGenerationVolumes(generations, new Set(['external_primary', '0a91-e18d'])),
    ).toEqual(['0a91-e18d']);
  });

  it('an empty map (legacy / failed read) reports every relevant volume', () => {
    expect(missingGenerationVolumes({}, new Set(['external_primary']))).toEqual([
      'external_primary',
    ]);
  });
});
