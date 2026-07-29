import { describe, expect, it } from 'vitest';
import {
  baseName,
  classifyInPlace,
  CREATION_TOLERANCE_MS,
  filenamesRelated,
  matchEditedCopies,
  mergeSiblingWindows,
} from './editDetection';

describe('classifyInPlace', () => {
  it('is unchanged without a baseline mod time', () => {
    expect(classifyInPlace(null, 2000, false)).toBe('unchanged');
    expect(classifyInPlace(null, 2000, true)).toBe('unchanged');
  });

  it('is unchanged when the mod time has not moved forward', () => {
    expect(classifyInPlace(2000, 2000, false)).toBe('unchanged');
    expect(classifyInPlace(2000, 1500, false)).toBe('unchanged');
  });

  it('is unchanged when the current mod time is missing/zero', () => {
    expect(classifyInPlace(2000, 0, false)).toBe('unchanged');
  });

  it('is edited when the mod time moved and no hash baseline exists', () => {
    expect(classifyInPlace(2000, 2001, false)).toBe('edited');
  });

  it('defers to the hash when a baseline hash exists', () => {
    expect(classifyInPlace(2000, 2001, true)).toBe('check-hash');
  });
});

describe('baseName', () => {
  it('strips the final extension', () => {
    expect(baseName('IMG_123.jpg')).toBe('IMG_123');
    expect(baseName('archive.tar.gz')).toBe('archive.tar');
  });

  it('keeps extensionless and dot-leading names intact', () => {
    expect(baseName('IMG_123')).toBe('IMG_123');
    expect(baseName('.nomedia')).toBe('.nomedia');
  });
});

describe('filenamesRelated', () => {
  it('matches classic edit suffixes', () => {
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123-edit.jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123-edited.jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123~2.jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123_1.jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123 (1).jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123(1).jpg')).toBe(true);
  });

  it('matches edit prefixes', () => {
    expect(filenamesRelated('IMG_123.jpg', 'edited-IMG_123.jpg')).toBe(true);
    expect(filenamesRelated('IMG_123.jpg', 'Copy of IMG_123.jpg')).toBe(true);
  });

  it('matches the same base with a different extension', () => {
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123.png')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(filenamesRelated('IMG_123.JPG', 'img_123-Edit.jpg')).toBe(true);
  });

  it('requires a separator — a longer digit run is a different photo', () => {
    expect(filenamesRelated('IMG_123.jpg', 'IMG_1234.jpg')).toBe(false);
    expect(filenamesRelated('IMG_123.jpg', 'IMG_123a.jpg')).toBe(false);
    expect(filenamesRelated('IMG_123.jpg', 'xIMG_123.jpg')).toBe(false);
  });

  it('rejects unrelated names', () => {
    expect(filenamesRelated('IMG_123.jpg', 'PXL_9999.jpg')).toBe(false);
  });

  it('refuses affix matching on very short bases', () => {
    expect(filenamesRelated('1.jpg', '1-edit.jpg')).toBe(false);
    // …but exact base equality still counts.
    expect(filenamesRelated('1.jpg', '1.png')).toBe(true);
  });
});

describe('matchEditedCopies', () => {
  const original = {
    assetId: 'orig',
    filename: 'IMG_123.jpg',
    takenAt: 1_000_000,
    toEditAt: 2_000_000,
  };
  const candidate = (over: Partial<Parameters<typeof matchEditedCopies>[1][number]>) => ({
    id: 'c1',
    filename: 'IMG_123-edit.jpg',
    creationTime: 2_500_000,
    modificationTime: 2_500_000,
    ...over,
  });

  it('matches a filename-related copy written after flagging', () => {
    expect(matchEditedCopies(original, [candidate({})])).toHaveLength(1);
  });

  it('never matches the original itself', () => {
    expect(matchEditedCopies(original, [candidate({ id: 'orig' })])).toHaveLength(0);
  });

  it('rejects files written before the photo was flagged', () => {
    expect(matchEditedCopies(original, [candidate({ modificationTime: 1_999_999 })])).toHaveLength(
      0,
    );
    expect(matchEditedCopies(original, [candidate({ modificationTime: 0 })])).toHaveLength(0);
  });

  it('matches an unrelated filename when creationTime clones the original', () => {
    expect(
      matchEditedCopies(original, [
        candidate({
          filename: 'export_0001.jpg',
          creationTime: original.takenAt + CREATION_TOLERANCE_MS,
        }),
      ]),
    ).toHaveLength(1);
  });

  it('rejects an unrelated filename outside the creation-time window', () => {
    expect(
      matchEditedCopies(original, [
        candidate({
          filename: 'export_0001.jpg',
          creationTime: original.takenAt + CREATION_TOLERANCE_MS + 1,
        }),
      ]),
    ).toHaveLength(0);
  });

  it('can return multiple copies', () => {
    const matches = matchEditedCopies(original, [
      candidate({ id: 'c1' }),
      candidate({ id: 'c2', filename: 'IMG_123~2.jpg' }),
      candidate({ id: 'c3', filename: 'PXL_9999.jpg', creationTime: 99 }),
    ]);
    expect(matches.map((m) => m.id)).toEqual(['c1', 'c2']);
  });
});

describe('mergeSiblingWindows', () => {
  const T = 1_800_000_000_000;

  it('gives an isolated photo its own window at single budget', () => {
    expect(mergeSiblingWindows([T])).toEqual([
      { startMs: T - CREATION_TOLERANCE_MS, endMs: T + CREATION_TOLERANCE_MS, merged: 1 },
    ]);
  });

  it('collapses an overlapping burst into ONE window that keeps every budget', () => {
    // Three photos 1 s apart: their ±2 s windows all overlap.
    const merged = mergeSiblingWindows([T, T + 1000, T + 2000]);
    expect(merged).toEqual([
      { startMs: T - CREATION_TOLERANCE_MS, endMs: T + 2000 + CREATION_TOLERANCE_MS, merged: 3 },
    ]);
    // The point of `merged`: the collapsed scan must carry the budget the
    // three separate scans would have had, or merging quietly narrows
    // coverage instead of just being faster.
    expect(merged[0].merged).toBe(3);
  });

  it('keeps windows separate when the gap exceeds twice the tolerance', () => {
    const merged = mergeSiblingWindows([T, T + 5 * CREATION_TOLERANCE_MS]);
    expect(merged).toHaveLength(2);
    expect(merged.every((w) => w.merged === 1)).toBe(true);
  });

  it('touches at the boundary and still merges', () => {
    // Exactly 2 * tolerance apart: the windows share one edge.
    const merged = mergeSiblingWindows([T, T + 2 * CREATION_TOLERANCE_MS]);
    expect(merged).toHaveLength(1);
    expect(merged[0].merged).toBe(2);
  });

  it('does not care about input order', () => {
    expect(mergeSiblingWindows([T + 2000, T, T + 1000])).toEqual(
      mergeSiblingWindows([T, T + 1000, T + 2000]),
    );
  });

  it('returns nothing for no photos', () => {
    expect(mergeSiblingWindows([])).toEqual([]);
  });
});
