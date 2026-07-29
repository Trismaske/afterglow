/**
 * Progress accounting (v18) — the three-layer model in numbers
 * (docs/STATE_MODEL.md): verdict counts, the grouped ANNOTATION counted
 * per verdict, and what the state editor may offer.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPhotoState,
  computeBreakdown,
  reviewedOf,
  reviewedPct,
  editorActions,
  isActionFilter,
  remainingReviewable,
  progressRemainder,
  groupedUnderlineRuns,
  type StateCounts,
} from './progress';

describe('progressRemainder', () => {
  it('leaves 13/14 empty for one completed photo', () => {
    expect(progressRemainder(14, [1, 0, 0])).toBe(13);
  });

  it('clamps over-counts and negative segments safely', () => {
    expect(progressRemainder(14, [10, 8])).toBe(0);
    expect(progressRemainder(14, [-3, 4])).toBe(10);
  });
});

describe('groupedUnderlineRuns', () => {
  it('marks the grouped part of each verdict and blanks the rest', () => {
    // 20 kept (10 grouped), 10 staged (0 grouped), 70 unreviewed (40).
    expect(
      groupedUnderlineRuns(100, [
        { count: 10, of: 20 },
        { count: 0, of: 10 },
        { count: 40, of: 70 },
      ]),
    ).toEqual([
      { weight: 10, marked: true },
      { weight: 10, marked: false },
      { weight: 10, marked: false },
      { weight: 40, marked: true },
      { weight: 30, marked: false },
    ]);
  });

  it('pads to the total so the underline stays under its own segment', () => {
    // 500 photos MediaStore has that the scan has not tracked yet: the
    // marked run must stay 10/1000 of the width, not 10/500.
    const runs = groupedUnderlineRuns(1000, [
      { count: 10, of: 100 },
      { count: 0, of: 400 },
    ]);
    expect(runs.reduce((sum, run) => sum + run.weight, 0)).toBe(1000);
    expect(runs[0]).toEqual({ weight: 10, marked: true });
    expect(runs[runs.length - 1]).toEqual({ weight: 500, marked: false });
  });

  it('never marks more than its segment holds, nor pads below zero', () => {
    expect(groupedUnderlineRuns(5, [{ count: 99, of: 5 }])).toEqual([{ weight: 5, marked: true }]);
    expect(groupedUnderlineRuns(1, [{ count: 4, of: 8 }])).toEqual([
      { weight: 4, marked: true },
      { weight: 4, marked: false },
    ]);
  });
});

function counts(partial: Partial<StateCounts>): StateCounts {
  const base: StateCounts = {
    unreviewed: 0,
    kept: 0,
    staged: 0,
    trashed: 0,
    tracked: 0,
    grouped: { unreviewed: 0, kept: 0, staged: 0 },
    actions: { edit: 0, favourite: 0, organize: 0, share: 0 },
  };
  const merged = { ...base, ...partial };
  if (partial.tracked === undefined) {
    merged.tracked = merged.unreviewed + merged.kept + merged.staged + merged.trashed;
  }
  return merged;
}

describe('computeBreakdown', () => {
  it('counts never-tracked MediaStore photos as unreviewed', () => {
    const b = computeBreakdown(10, counts({ kept: 4 }));
    expect(b.total).toBe(10);
    expect(b.unreviewed).toBe(6); // 10 alive − 4 tracked-alive
    expect(b.kept).toBe(4);
  });

  it('adds trashed rows back into the true total (they left MediaStore)', () => {
    const b = computeBreakdown(8, counts({ trashed: 2, kept: 3 }));
    expect(b.total).toBe(10);
    // Trashed converges with kept: the work is over either way, and a
    // fourth segment for invisible files would help nobody.
    expect(b.kept).toBe(5);
    expect(b.unreviewed).toBe(5); // 8 alive − 3 tracked-alive
  });

  it('carries grouped counts per verdict, never as a verdict', () => {
    const b = computeBreakdown(
      6,
      counts({ unreviewed: 5, kept: 1, grouped: { unreviewed: 4, kept: 1, staged: 0 } }),
    );
    expect(b.grouped).toEqual({ unreviewed: 4, kept: 1, staged: 0 });
    // Grouping does not move a photo out of its verdict.
    expect(b.unreviewed).toBe(5);
    expect(b.kept).toBe(1);
  });

  it('clamps never-loaded at 0 when the DB briefly knows more than MediaStore', () => {
    const b = computeBreakdown(2, counts({ kept: 3 }));
    expect(b.unreviewed).toBe(0);
  });
});

describe('remainingReviewable / reviewedPct', () => {
  it('remaining excludes kept photos', () => {
    const b = computeBreakdown(10, counts({ kept: 6 }));
    expect(remainingReviewable(b)).toBe(4); // 4 never-loaded
  });

  it('remaining excludes staged culls — carried, never re-drawn (P4#1)', () => {
    const b = computeBreakdown(5, counts({ staged: 5 }));
    expect(remainingReviewable(b)).toBe(0);
  });

  it('an empty scope is 100% reviewed', () => {
    const b = computeBreakdown(0, counts({}));
    expect(reviewedPct(b)).toBe(100);
    expect(remainingReviewable(b)).toBe(0);
  });

  it('reviewed counts every verdict: kept + staged', () => {
    const b = computeBreakdown(10, counts({ kept: 6, staged: 1 }));
    expect(reviewedOf(b)).toBe(7);
    expect(reviewedPct(b)).toBe(70);
  });

  it('a pending edit does NOT change the reviewed count', () => {
    // Under the old model a flagged keeper sat in its own 'to_edit'
    // state; now the edit is an action and the photo is simply kept.
    const flagged = computeBreakdown(10, counts({ kept: 6 }));
    expect(reviewedOf(flagged)).toBe(6);
  });

  it('rounds the reviewed share to whole percent', () => {
    const b = computeBreakdown(3, counts({ kept: 1 }));
    expect(reviewedPct(b)).toBe(33);
  });
});

describe('classifyPhotoState', () => {
  it('treats a missing row as unreviewed', () => {
    expect(classifyPhotoState(undefined)).toBe('unreviewed');
  });

  it('maps each stored verdict to its bucket, grouping aside', () => {
    expect(classifyPhotoState({ state: 'unreviewed' })).toBe('unreviewed');
    expect(classifyPhotoState({ state: 'culled' })).toBe('staged');
    expect(classifyPhotoState({ state: 'kept' })).toBe('kept');
    expect(classifyPhotoState({ state: 'trashed' })).toBe('kept');
  });
});

describe('isActionFilter', () => {
  it('separates the two filter vocabularies', () => {
    expect(isActionFilter('act:edit')).toBe(true);
    expect(isActionFilter('kept')).toBe(false);
    expect(isActionFilter('all')).toBe(false);
  });
});

describe('editorActions', () => {
  it('offers completing the edit when one is pending', () => {
    expect(editorActions('kept', true)).toEqual(['complete_edit']);
  });

  it('offers queuing an edit on a keeper that has none', () => {
    expect(editorActions('kept', false)).toEqual(['queue_edit']);
  });

  it('a staged cull can be un-culled, edit pending or not', () => {
    expect(editorActions('culled', false)).toEqual(['unstage_cull']);
    expect(editorActions('culled', true)).toEqual(['unstage_cull']);
  });

  it('unreviewed, untracked and trashed are read-only', () => {
    expect(editorActions('unreviewed', false)).toEqual([]);
    expect(editorActions(null, false)).toEqual([]);
    expect(editorActions('trashed', false)).toEqual([]);
  });
});
