import { describe, expect, it } from 'vitest';
import {
  classifyPhotoState,
  computeBreakdown,
  donePct,
  editorActions,
  remainingReviewable,
  type StateCounts,
} from './progress';

function counts(partial: Partial<StateCounts>): StateCounts {
  const base: StateCounts = {
    unreviewedGrouped: 0,
    unreviewedSingle: 0,
    kept: 0,
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
      merged.kept +
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

describe('remainingReviewable / donePct', () => {
  it('remaining excludes done and to_edit (both converged/handled)', () => {
    const b = computeBreakdown(10, counts({ done: 4, toEdit: 2, kept: 1 }));
    expect(remainingReviewable(b)).toBe(4); // 1 kept + 3 never-loaded
  });

  it('an empty scope is 100% done', () => {
    const b = computeBreakdown(0, counts({}));
    expect(donePct(b)).toBe(100);
    expect(remainingReviewable(b)).toBe(0);
  });

  it('rounds the done share to whole percent', () => {
    const b = computeBreakdown(3, counts({ done: 1 }));
    expect(donePct(b)).toBe(33);
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
    expect(classifyPhotoState({ state: 'kept', grouped: true })).toBe('kept');
    expect(classifyPhotoState({ state: 'to_edit', grouped: false })).toBe('to_edit');
    expect(classifyPhotoState({ state: 'culled', grouped: true })).toBe('staged');
    expect(classifyPhotoState({ state: 'confirmed', grouped: false })).toBe('staged');
    expect(classifyPhotoState({ state: 'done', grouped: false })).toBe('done');
    expect(classifyPhotoState({ state: 'trashed', grouped: true })).toBe('done');
  });
});

describe('editorActions', () => {
  it('kept can go to done or the edit queue', () => {
    expect(editorActions('kept', false)).toEqual(['mark_done', 'queue_edit']);
  });

  it('to_edit can only converge to done', () => {
    expect(editorActions('to_edit', false)).toEqual(['mark_done']);
  });

  it('done can be sent back to the edit queue', () => {
    expect(editorActions('done', false)).toEqual(['queue_edit']);
  });

  it('a staged cull can be un-culled', () => {
    expect(editorActions('culled', false)).toEqual(['unstage_cull']);
  });

  it('unreviewed, untracked, trashed and confirmed are read-only', () => {
    expect(editorActions('unreviewed', false)).toEqual([]);
    expect(editorActions(null, false)).toEqual([]);
    expect(editorActions('trashed', false)).toEqual([]);
    expect(editorActions('confirmed', false)).toEqual([]);
  });

  it('anything in the active session is read-only', () => {
    expect(editorActions('kept', true)).toEqual([]);
    expect(editorActions('culled', true)).toEqual([]);
    expect(editorActions('to_edit', true)).toEqual([]);
  });
});
