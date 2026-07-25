import { describe, expect, it } from 'vitest';
import { frozenPhotos, reconcileWindowGroups, type ReconcileMaps } from './regroupBoundary';

function maps(partial: Partial<ReconcileMaps>): ReconcileMaps {
  return {
    states: partial.states ?? new Map(),
    assignments: partial.assignments ?? new Map(),
    groupMembers: partial.groupMembers ?? new Map(),
  };
}

describe('frozenPhotos', () => {
  it('freezes photos whose own state left unreviewed', () => {
    const frozen = frozenPhotos(
      ['a', 'b', 'c', 'd'],
      maps({
        states: new Map([
          ['a', 'done'],
          ['b', 'culled'],
          ['c', 'unreviewed'],
        ]),
      }),
    );
    // d has no row at all — never seen, unreviewed.
    expect([...frozen].sort()).toEqual(['a', 'b']);
  });

  it('freezes unreviewed photos sitting in a group with a reviewed member', () => {
    const frozen = frozenPhotos(
      ['a', 'b'],
      maps({
        states: new Map([
          ['a', 'unreviewed'],
          ['b', 'unreviewed'],
          ['z', 'done'], // outside the window, inside a's group
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          // assigned single (scan-made) — nothing to freeze over
          ['b', { groupId: null, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'z']]]),
      }),
    );
    expect([...frozen]).toEqual(['a']);
  });

  it('freezes user-ejected singles even though their state is unreviewed', () => {
    const frozen = frozenPhotos(
      ['a', 'b'],
      maps({
        states: new Map([
          ['a', 'unreviewed'],
          ['b', 'unreviewed'],
        ]),
        assignments: new Map([
          ['a', { groupId: null, userSingle: true }],
          ['b', { groupId: null, userSingle: false }],
        ]),
      }),
    );
    expect([...frozen]).toEqual(['a']);
  });

  it('leaves all-unreviewed groups rebuildable', () => {
    const frozen = frozenPhotos(
      ['a', 'b'],
      maps({
        states: new Map([
          ['a', 'unreviewed'],
          ['b', 'unreviewed'],
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['b', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'b']]]),
      }),
    );
    expect(frozen.size).toBe(0);
  });
});

describe('reconcileWindowGroups', () => {
  const g = (members: string[], timeAttached: string[] = []) => ({ members, timeAttached });

  it('passes unfrozen groups and singles through, badges intact', () => {
    const plan = reconcileWindowGroups([g(['a', 'b'], ['b']), g(['c'])], new Set());
    expect(plan.groups).toEqual([{ members: ['a', 'b'], timeAttached: ['b'] }]);
    expect(plan.singles).toEqual(['c']);
  });

  it('removes frozen members and degrades sub-2 remainders to singles', () => {
    const plan = reconcileWindowGroups(
      [
        g(['a', 'b', 'c']), // b frozen → survives as {a, c}
        g(['d', 'e']), // e frozen → d degrades to single
        g(['f']), // frozen single → dropped entirely
      ],
      new Set(['b', 'e', 'f']),
    );
    expect(plan.groups).toEqual([{ members: ['a', 'c'], timeAttached: [] }]);
    expect(plan.singles).toEqual(['d']);
  });

  it('drops the time-attached badge from members that leave the group', () => {
    const plan = reconcileWindowGroups(
      [
        g(['a', 'b', 'c'], ['b', 'c']), // b frozen: its badge must not survive
        g(['d', 'e'], ['e']), // shrinks to single d — e's badge irrelevant
      ],
      new Set(['b', 'e']),
    );
    expect(plan.groups).toEqual([{ members: ['a', 'c'], timeAttached: ['c'] }]);
    expect(plan.singles).toEqual(['d']);
  });
});
