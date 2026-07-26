import { describe, expect, it } from 'vitest';
import {
  classifyPhotoState,
  computeBreakdown,
  reviewedOf,
  reviewedPct,
  editorActions,
  remainingReviewable,
  progressRemainder,
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

function counts(partial: Partial<StateCounts>): StateCounts {
  const base: StateCounts = {
    unreviewedGrouped: 0,
    unreviewedSingle: 0,
    toEdit: 0,
    staged: 0,
    trashed: 0,
    done: 0,
    tracked: 0,
  };
  const merged = { ...base, ...partial };
  if (partial.tracked === undefined) {
    merged.tracked =
      merged.unreviewedGrouped +
      merged.unreviewedSingle +
      merged.toEdit +
      merged.staged +
      merged.trashed +
      merged.done;
  }
  return merged;
}

describe('computeBreakdown', () => {
  it('counts never-tracked MediaStore photos as unreviewed', () => {
    const b = computeBreakdown(10, counts({ done: 3, toEdit: 1 }));
    expect(b.total).toBe(10);
    expect(b.unreviewed).toBe(6); // 10 alive − 4 tracked-alive
    expect(b.done).toBe(3);
    expect(b.toEdit).toBe(1);
  });

  it('adds trashed rows back into the true total (they left MediaStore)', () => {
    const b = computeBreakdown(8, counts({ trashed: 2, done: 3 }));
    expect(b.total).toBe(10);
    expect(b.done).toBe(5); // done + trashed both converged
    expect(b.unreviewed).toBe(5); // 8 alive − 3 tracked-alive
  });

  it('splits unreviewed rows into singles vs in-groups', () => {
    const b = computeBreakdown(6, counts({ unreviewedGrouped: 4, unreviewedSingle: 1 }));
    expect(b.inGroups).toBe(4);
    expect(b.unreviewed).toBe(2); // 1 tracked single + 1 never-loaded
  });

  it('clamps never-loaded at 0 when the DB briefly knows more than MediaStore', () => {
    const b = computeBreakdown(2, counts({ done: 3 }));
    expect(b.unreviewed).toBe(0);
  });
});

describe('remainingReviewable / reviewedPct', () => {
  it('remaining excludes done and to_edit (both converged/handled)', () => {
    const b = computeBreakdown(10, counts({ done: 4, toEdit: 2 }));
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

  it('reviewed counts every verdict: done + to-edit + staged', () => {
    const b = computeBreakdown(10, counts({ done: 4, toEdit: 2, staged: 1 }));
    expect(reviewedOf(b)).toBe(7);
    expect(reviewedPct(b)).toBe(70);
  });

  it('rounds the reviewed share to whole percent', () => {
    const b = computeBreakdown(3, counts({ done: 1 }));
    expect(reviewedPct(b)).toBe(33);
  });
});

describe('classifyPhotoState', () => {
  it('treats a missing row as unreviewed', () => {
    expect(classifyPhotoState(undefined)).toBe('unreviewed');
  });

  it('splits unreviewed by group membership', () => {
    expect(classifyPhotoState({ state: 'unreviewed', grouped: false })).toBe('unreviewed');
    expect(classifyPhotoState({ state: 'unreviewed', grouped: true })).toBe('in_group');
  });

  it('maps each stored state to its effective bucket', () => {
    expect(classifyPhotoState({ state: 'to_edit', grouped: false })).toBe('to_edit');
    expect(classifyPhotoState({ state: 'culled', grouped: true })).toBe('staged');
    expect(classifyPhotoState({ state: 'confirmed', grouped: false })).toBe('staged');
    expect(classifyPhotoState({ state: 'done', grouped: false })).toBe('done');
    expect(classifyPhotoState({ state: 'trashed', grouped: true })).toBe('done');
  });
});

describe('editorActions', () => {
  it('to_edit can only converge to done', () => {
    expect(editorActions('to_edit')).toEqual(['mark_done']);
  });

  it('done can be sent back to the edit queue', () => {
    expect(editorActions('done')).toEqual(['queue_edit']);
  });

  it('a staged cull can be un-culled', () => {
    expect(editorActions('culled')).toEqual(['unstage_cull']);
  });

  it('unreviewed, untracked, trashed and confirmed are read-only', () => {
    expect(editorActions('unreviewed')).toEqual([]);
    expect(editorActions(null)).toEqual([]);
    expect(editorActions('trashed')).toEqual([]);
    expect(editorActions('confirmed')).toEqual([]);
  });
});
