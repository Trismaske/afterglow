import { describe, it, expect } from 'vitest';
import { CullSession, DeckSession, type CullGroup, type MediaItem } from '../src/index';
import { burst, item } from './helpers';

function group(id: string, items: MediaItem[]): CullGroup {
  return { id, items };
}

/** Fresh deck session: one group of `n` photos p0..p(n-1). */
function deck(n: number, groupId = 'g1') {
  return DeckSession.create({ groups: [group(groupId, burst(n, 0, 1000))] });
}

describe('DeckSession — deck basics', () => {
  it('starts with all members alive, cursor 0, group incomplete', () => {
    const s = deck(3);
    expect(s.currentGroupId()).toBe('g1');
    const info = s.groupInfo('g1');
    expect(info.memberIds).toEqual(['p0', 'p1', 'p2']);
    expect(info.aliveIds).toEqual(['p0', 'p1', 'p2']);
    expect(info.cursor).toBe(0);
    expect(info.complete).toBe(false);
    expect(info.bestId).toBeNull();
    for (const id of ['p0', 'p1', 'p2']) expect(s.getState(id)).toBe('unreviewed');
  });

  it('rejects duplicate photo and group ids', () => {
    expect(() =>
      DeckSession.create({ groups: [group('g1', [item('a', 0), item('a', 1)])] }),
    ).toThrow(/duplicate photo id/);
    expect(() =>
      DeckSession.create({
        groups: [group('g1', [item('a', 0)]), group('g1', [item('b', 1)])],
      }),
    ).toThrow(/duplicate group id/);
  });

  it('setCursor clamps to the alive range', () => {
    const s = deck(3);
    s.setCursor('g1', 2);
    expect(s.groupInfo('g1').cursor).toBe(2);
    s.setCursor('g1', 99);
    expect(s.groupInfo('g1').cursor).toBe(2);
    s.setCursor('g1', -5);
    expect(s.groupInfo('g1').cursor).toBe(0);
  });

  it('cull removes from the deck, stages the photo, keeps cursor sane', () => {
    const s = deck(4);
    s.setCursor('g1', 1);
    s.cull('p1'); // remove at cursor → cursor stays, p2 slides in
    expect(s.getState('p1')).toBe('culled');
    expect(s.groupInfo('g1').aliveIds).toEqual(['p0', 'p2', 'p3']);
    expect(s.groupInfo('g1').cursor).toBe(1);
    s.cull('p0'); // remove before cursor → cursor shifts left with the photo
    expect(s.groupInfo('g1').aliveIds).toEqual(['p2', 'p3']);
    expect(s.groupInfo('g1').cursor).toBe(0);
    expect(s.stagedCulls().map((i) => i.id).sort()).toEqual(['p0', 'p1']);
  });

  it('culling the last alive photo completes the group', () => {
    const s = deck(2);
    s.cull('p0');
    s.cull('p1');
    expect(s.isGroupComplete('g1')).toBe(true);
    expect(s.currentGroupId()).toBeNull();
    expect(s.isComplete()).toBe(true);
  });

  it('culling the last-position photo clamps the cursor', () => {
    const s = deck(3);
    s.setCursor('g1', 2);
    s.cull('p2');
    expect(s.groupInfo('g1').cursor).toBe(1);
  });

  it('keepRest keeps every alive unreviewed member and completes', () => {
    const s = deck(3);
    s.cull('p1');
    s.keepRest('g1');
    expect(s.isGroupComplete('g1')).toBe(true);
    expect(s.getState('p0')).toBe('kept');
    expect(s.getState('p2')).toBe('kept');
    expect(s.getState('p1')).toBe('culled');
    expect(() => s.keepRest('g1')).toThrow(/already complete/);
    expect(() => s.cull('p0')).toThrow(/not in any deck|already complete|expected/);
  });

  it('multiple groups review in order', () => {
    const s = DeckSession.create({
      groups: [group('g1', burst(2, 0, 1000)), group('g2', burst(2, 10_000, 1000, 'q'))],
    });
    expect(s.currentGroupId()).toBe('g1');
    s.keepRest('g1');
    expect(s.currentGroupId()).toBe('g2');
    s.keepRest('g2');
    expect(s.currentGroupId()).toBeNull();
  });
});

describe('DeckSession — undoCull', () => {
  it('restores the photo at its original position and points the cursor at it', () => {
    const s = deck(4);
    s.setCursor('g1', 1);
    s.cull('p1');
    s.undoCull('p1');
    expect(s.getState('p1')).toBe('unreviewed');
    expect(s.groupInfo('g1').aliveIds).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(s.groupInfo('g1').cursor).toBe(1);
  });

  it('restores order even after neighbours were culled too', () => {
    const s = deck(4);
    s.cull('p0');
    s.cull('p2');
    s.undoCull('p2');
    expect(s.groupInfo('g1').aliveIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('refuses once the group completed (unstageCull is the path then)', () => {
    const s = deck(2);
    s.cull('p0');
    s.keepRest('g1');
    expect(() => s.undoCull('p0')).toThrow(/already complete/);
    s.unstageCull('p0');
    expect(s.getState('p0')).toBe('kept');
  });
});

describe('DeckSession — markBest / makeSingle', () => {
  it('markBest stars an alive member; null clears; culling the best clears', () => {
    const s = deck(3);
    s.markBest('g1', 'p1');
    expect(s.groupInfo('g1').bestId).toBe('p1');
    expect(s.groupBest('g1')!.id).toBe('p1');
    s.markBest('g1', null);
    expect(s.groupBest('g1')).toBeNull();
    s.markBest('g1', 'p1');
    s.cull('p1');
    expect(s.groupBest('g1')).toBeNull();
    expect(() => s.markBest('g1', 'p1')).toThrow(/not an alive member/);
  });

  it('makeSingle moves the photo out of the group into the singles queue', () => {
    const s = DeckSession.create({
      groups: [group('g1', burst(3, 0, 1000))],
      singles: [item('s0', 99_000)],
    });
    s.makeSingle('p1');
    expect(s.groupInfo('g1').memberIds).toEqual(['p0', 'p2']);
    expect(s.groupInfo('g1').aliveIds).toEqual(['p0', 'p2']);
    expect(s.singles).toEqual(['s0', 'p1']);
    expect(s.getState('p1')).toBe('unreviewed');
    // reviewable via the singles flow
    s.decideSingle('s0', 'keep');
    expect(s.nextSingle()!.id).toBe('p1');
    s.decideSingle('p1', 'cull');
    expect(s.getState('p1')).toBe('culled');
  });

  it('makeSingle of the last alive member completes the group', () => {
    const s = deck(2);
    s.cull('p0');
    s.makeSingle('p1');
    expect(s.isGroupComplete('g1')).toBe(true);
    expect(s.groupInfo('g1').memberIds).toEqual(['p0']);
  });
});

describe('DeckSession — compares and reconsider hints', () => {
  it('recordCompare returns a DuelRecord-shaped record', () => {
    const s = deck(3);
    const rec = s.recordCompare('p0', 'p1', true, 123);
    expect(rec).toEqual({ groupId: 'g1', winnerId: 'p0', loserId: 'p1', keptBoth: true, at: 123 });
    expect(s.compareHistory).toEqual([rec]);
    // states untouched by a kept-both compare
    expect(s.getState('p0')).toBe('unreviewed');
    expect(s.getState('p1')).toBe('unreviewed');
  });

  it('rejects cross-group and self compares', () => {
    const s = DeckSession.create({
      groups: [group('g1', burst(2, 0, 1000)), group('g2', burst(2, 10_000, 1000, 'q'))],
    });
    expect(() => s.recordCompare('p0', 'q0', true, 1)).toThrow(/same group/);
    expect(() => s.recordCompare('p0', 'p0', true, 1)).toThrow(/winner === loser/);
  });

  it('reconsider candidates = kept compare-losers that never won, minus the best', () => {
    const s = deck(5);
    // p1 loses a compare but stays (kept-both); p2 loses and also wins one;
    // p3 loses and gets starred best; p4 is culled outright.
    s.recordCompare('p0', 'p1', true, 1);
    s.recordCompare('p2', 'p3', true, 2);
    s.recordCompare('p0', 'p2', true, 3);
    s.cull('p4');
    s.recordCompare('p0', 'p4', false, 4);
    s.markBest('g1', 'p3');
    s.keepRest('g1');
    expect(s.reconsiderCandidates('g1').map((i) => i.id)).toEqual(['p1']);
  });

  it('a group finished with zero compares yields no candidates', () => {
    const s = deck(4);
    s.cull('p3');
    s.keepRest('g1');
    expect(s.reconsiderCandidates('g1')).toEqual([]);
  });

  it('a compare loser whose cull was unstaged becomes a candidate again', () => {
    const s = deck(3);
    s.cull('p1');
    s.recordCompare('p0', 'p1', false, 1);
    s.keepRest('g1');
    expect(s.reconsiderCandidates('g1')).toEqual([]);
    s.unstageCull('p1'); // kept again, but it lost a compare
    expect(s.reconsiderCandidates('g1').map((i) => i.id)).toEqual(['p1']);
  });
});

describe('DeckSession — staging, cullKept, confirm flow', () => {
  it('unstageCull restores to kept without re-entering the deck', () => {
    const s = deck(3);
    s.cull('p0');
    s.keepRest('g1');
    s.unstageCull('p0');
    expect(s.getState('p0')).toBe('kept');
    expect(s.groupInfo('g1').aliveIds).toEqual(['p1', 'p2']);
  });

  it('cullKept stages an already-kept photo (reconsider path)', () => {
    const s = deck(2);
    s.keepRest('g1');
    s.cullKept('p1');
    expect(s.getState('p1')).toBe('culled');
    expect(() => s.cullKept('p0')).not.toThrow();
    expect(() => s.cullKept('p0')).toThrow(/expected kept/);
  });

  it('confirmAll → markTrashed walks the staged batch through the states', () => {
    const s = deck(3);
    s.cull('p0');
    s.cull('p2');
    s.keepRest('g1');
    const ids = s.confirmAll();
    expect(ids.sort()).toEqual(['p0', 'p2']);
    for (const id of ids) expect(s.getState(id)).toBe('confirmed');
    s.markTrashed(ids);
    for (const id of ids) expect(s.getState(id)).toBe('trashed');
    expect(s.summary()).toMatchObject({ total: 3, kept: 1, trashed: 2, culled: 0 });
  });
});

describe('DeckSession — serialization', () => {
  it('round-trips mid-deck state exactly', () => {
    const s = DeckSession.create({
      groups: [group('g1', burst(4, 0, 1000)), group('g2', burst(2, 60_000, 500, 'q'))],
      singles: [item('s0', 99_000)],
    });
    s.setCursor('g1', 2);
    s.cull('p1');
    s.markBest('g1', 'p0');
    s.recordCompare('p0', 'p2', true, 42);
    s.makeSingle('p3');

    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const restored = DeckSession.fromJSON(json);
    expect(restored.toJSON()).toEqual(s.toJSON());
    expect(restored.groupInfo('g1').cursor).toBe(s.groupInfo('g1').cursor);
    expect(restored.singles).toEqual(['s0', 'p3']);
    expect(restored.compareHistory).toHaveLength(1);
  });

  it('rejects bracket-era CullSession snapshots (m0.3.x sessions are discarded)', () => {
    const bracket = CullSession.create({ groups: [group('g1', burst(3, 0, 1000))] });
    expect(() => DeckSession.fromJSON(bracket.toJSON())).toThrow(/not a deck snapshot/);
  });

  it('rejects malformed input', () => {
    expect(() => DeckSession.fromJSON(null)).toThrow(/not an object/);
    expect(() => DeckSession.fromJSON({ kind: 'deck', version: 2 })).toThrow(
      /unsupported version/,
    );
    expect(() =>
      DeckSession.fromJSON({ kind: 'deck', version: 1, items: [], groups: [], singleIds: [], states: { ghost: 'kept' }, compareHistory: [] }),
    ).toThrow(/unknown id/);
  });

  it('clamps a stale cursor on restore', () => {
    const s = deck(3);
    const snap = s.toJSON();
    snap.groups[0].cursor = 99;
    expect(DeckSession.fromJSON(snap).groupInfo('g1').cursor).toBe(2);
  });
});
