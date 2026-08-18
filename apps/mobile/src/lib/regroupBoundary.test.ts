import { describe, expect, it } from 'vitest';
import {
  frozenPhotos,
  reconcileWindowGroups,
  windowFreeze,
  type ReconcileMaps,
} from './regroupBoundary';

function maps(partial: Partial<ReconcileMaps>): ReconcileMaps {
  return {
    states: partial.states ?? new Map(),
    assignments: partial.assignments ?? new Map(),
    groupMembers: partial.groupMembers ?? new Map(),
    metadataGroups: partial.metadataGroups ?? new Set(),
    ...(partial.reachable ? { reachable: partial.reachable } : {}),
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

  it('a group with ANY unreviewed member is rebuildable whole — decided members included (D4)', () => {
    // Group 7 = [a, z]: z decided, a unreviewed. The old contagion froze
    // a (and z); m0.8.6 D4 reverses it — one undecided member makes the
    // whole group the scan's to reshape. b is a scan-made single, free.
    const frozen = frozenPhotos(
      ['a', 'b', 'z'],
      maps({
        states: new Map([
          ['a', 'unreviewed'],
          ['b', 'unreviewed'],
          ['z', 'done'],
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['b', { groupId: null, userSingle: false }],
          ['z', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'z']]]),
      }),
    );
    expect(frozen.size).toBe(0);
  });

  it('a FINISHED group (every member decided) is settled and frozen whole', () => {
    const frozen = frozenPhotos(
      ['a', 'z'],
      maps({
        states: new Map([
          ['a', 'kept'],
          ['z', 'culled'],
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['z', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'z']]]),
      }),
    );
    expect([...frozen].sort()).toEqual(['a', 'z']);
  });

  it('un-reviewing one member of a finished group frees it whole (the F9 regroup use case)', () => {
    // Same group as above after the state editor set z back to
    // unreviewed: both members return to the scan's reach.
    const frozen = frozenPhotos(
      ['a', 'z'],
      maps({
        states: new Map([
          ['a', 'kept'],
          ['z', 'unreviewed'],
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['z', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'z']]]),
      }),
    );
    expect(frozen.size).toBe(0);
  });

  it('a metadata group with an unreviewed member STAYS frozen — a deck undo cannot dissolve Compare work (D5)', () => {
    const frozen = frozenPhotos(
      ['a', 'z'],
      maps({
        states: new Map([
          ['a', 'kept'],
          ['z', 'unreviewed'],
        ]),
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['z', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'z']]]),
        metadataGroups: new Set([7]),
      }),
    );
    expect([...frozen].sort()).toEqual(['a', 'z']);
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

describe('frozenPhotos (group-level metadata)', () => {
  it('freezes an all-unreviewed group that carries a best star or duels', () => {
    const frozen = frozenPhotos(
      ['a', 'b', 'c'],
      maps({
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['b', { groupId: 7, userSingle: false }],
          ['c', { groupId: 8, userSingle: false }],
        ]),
        groupMembers: new Map([
          [7, ['a', 'b']],
          [8, ['c']],
        ]),
        metadataGroups: new Set([7]),
      }),
    );
    expect([...frozen].sort()).toEqual(['a', 'b']);
  });
});

describe('frozenPhotos (unreachable members, m0.8.3)', () => {
  it('freezes a group whole while any member is unreachable — rebuilding a half-seen group strands the other half', () => {
    // Group 7 spans volumes: 'a','b' on primary, 'sd1' on an ejected SD
    // card. The pass sees only a,b; rebuilding around them would leave
    // sd1 in a rump group the <2-present repair dissolves, changing an
    // unreachable photo's assignment (plan §5 forbids).
    const frozen = frozenPhotos(
      ['a', 'b'],
      maps({
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['b', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'b', 'sd1']]]),
        reachable: (id) => id !== 'sd1',
      }),
    );
    expect([...frozen].sort()).toEqual(['a', 'b']);
  });

  it('unfreezes the moment every member is reachable again', () => {
    const frozen = frozenPhotos(
      ['a', 'b'],
      maps({
        assignments: new Map([
          ['a', { groupId: 7, userSingle: false }],
          ['b', { groupId: 7, userSingle: false }],
        ]),
        groupMembers: new Map([[7, ['a', 'b', 'sd1']]]),
        reachable: () => true,
      }),
    );
    expect(frozen.size).toBe(0);
  });

  it('an absent predicate freezes nothing extra (pre-reachability callers)', () => {
    const frozen = frozenPhotos(
      ['a'],
      maps({
        assignments: new Map([['a', { groupId: 7, userSingle: false }]]),
        groupMembers: new Map([[7, ['a', 'sd1']]]),
      }),
    );
    expect(frozen.size).toBe(0);
  });
});

describe('grow-only (m0.8.3 grilling): unreachable-frozen groups accept new members', () => {
  /** Group 7 = {a, sd} where sd's card is out; b is a fresh photo the
   * engine clustered with a. */
  function unreachableMaps(extra: Partial<ReconcileMaps> = {}): ReconcileMaps {
    return maps({
      states: new Map([
        ['a', 'unreviewed'],
        ['sd', 'unreviewed'],
        ['b', 'unreviewed'],
      ]),
      assignments: new Map([['a', { groupId: 7, userSingle: false }]]),
      groupMembers: new Map([[7, ['a', 'sd']]]),
      reachable: (id) => id !== 'sd',
      ...extra,
    });
  }

  it('marks unreachable-only-frozen photos growable; review freezes are not', () => {
    const freeze = windowFreeze(['a', 'b'], unreachableMaps());
    expect([...freeze.frozen]).toEqual(['a']);
    expect(freeze.growable.get('a')).toBe(7);
    // Same shape but the group carries a star: frozen, NOT growable.
    const starred = windowFreeze(['a', 'b'], unreachableMaps({ metadataGroups: new Set([7]) }));
    expect([...starred.frozen]).toEqual(['a']);
    expect(starred.growable.size).toBe(0);
  });

  it('appends the unfrozen cluster-mates to the growable group', () => {
    const freeze = windowFreeze(['a', 'b'], unreachableMaps());
    const plan = reconcileWindowGroups(
      [{ members: ['a', 'b'], timeAttached: ['b'] }],
      freeze.frozen,
      freeze.growable,
    );
    expect(plan.groups).toEqual([]);
    expect(plan.singles).toEqual([]);
    expect(plan.appends).toEqual([{ groupId: 7, members: ['b'], timeAttached: ['b'] }]);
  });

  it('without a growable target the pre-grow shapes stand', () => {
    const freeze = windowFreeze(['a', 'b'], unreachableMaps({ metadataGroups: new Set([7]) }));
    const plan = reconcileWindowGroups(
      [{ members: ['a', 'b'], timeAttached: [] }],
      freeze.frozen,
      freeze.growable,
    );
    expect(plan.appends).toEqual([]);
    expect(plan.singles).toEqual(['b']); // lone unfrozen remainder
  });

  it('largest member overlap wins the append target; ties break low', () => {
    const growable = new Map([
      ['a1', 7],
      ['a2', 7],
      ['c1', 3],
    ]);
    const frozen = new Set(['a1', 'a2', 'c1']);
    const plan = reconcileWindowGroups(
      [{ members: ['a1', 'a2', 'c1', 'new'], timeAttached: [] }],
      frozen,
      growable,
    );
    expect(plan.appends).toEqual([{ groupId: 7, members: ['new'], timeAttached: [] }]);
    const tie = reconcileWindowGroups(
      [{ members: ['a1', 'c1', 'new'], timeAttached: [] }],
      new Set(['a1', 'c1']),
      new Map([
        ['a1', 7],
        ['c1', 3],
      ]),
    );
    expect(tie.appends).toEqual([{ groupId: 3, members: ['new'], timeAttached: [] }]);
  });
});

describe('D4: an unfinished mixed group with an unreachable member', () => {
  it('freezes (half-seen groups never rebuild) and stays growable (its composition is unsettled)', () => {
    const freeze = windowFreeze(['a', 'b'], {
      states: new Map([
        ['a', 'kept'],
        ['b', 'unreviewed'],
      ]),
      assignments: new Map([
        ['a', { groupId: 7, userSingle: false }],
        ['b', { groupId: 7, userSingle: false }],
      ]),
      groupMembers: new Map([[7, ['a', 'b', 'sd1']]]),
      metadataGroups: new Set<number>(),
      reachable: (id) => id !== 'sd1',
    });
    expect([...freeze.frozen].sort()).toEqual(['a', 'b']);
    expect(freeze.growable.get('a')).toBe(7);
    expect(freeze.growable.get('b')).toBe(7);
  });
});
