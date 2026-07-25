import { describe, it, expect } from 'vitest';
import { CullSession, type CullGroup, type MediaItem } from '../src/index';
import { burst, item } from './helpers';

function group(id: string, items: MediaItem[]): CullGroup {
  return { id, items };
}

/** Fresh session: one group of `n` photos named p0..p(n-1). */
function groupSession(n: number, groupId = 'g1') {
  return CullSession.create({ groups: [group(groupId, burst(n, 0, 1000))] });
}

/** Drive a group to completion, always culling the second photo of each pair. */
function cullAll(session: CullSession, atStart = 1000): number {
  let duels = 0;
  let at = atStart;
  while (session.nextPair()) {
    session.decideDuel({ cull: session.nextPair()!.b.id }, at++);
    duels++;
  }
  return duels;
}

describe('CullSession — duel brackets', () => {
  it('even group (4): full cull walkthrough to a single best', () => {
    const s = groupSession(4);

    let pair = s.nextPair()!;
    expect(pair.groupId).toBe('g1');
    expect([pair.a.id, pair.b.id]).toEqual(['p0', 'p1']);
    const rec = s.decideDuel({ cull: 'p1' }, 111);
    expect(rec).toEqual({ groupId: 'g1', winnerId: 'p0', loserId: 'p1', keptBoth: false, at: 111 });

    pair = s.nextPair()!;
    expect([pair.a.id, pair.b.id]).toEqual(['p2', 'p3']);
    s.decideDuel({ cull: 'p3' }, 112);

    // Final: the two round-1 winners.
    pair = s.nextPair()!;
    expect([pair.a.id, pair.b.id]).toEqual(['p0', 'p2']);
    s.decideDuel({ cull: 'p2' }, 113);

    expect(s.nextPair()).toBeNull();
    expect(s.isGroupComplete('g1')).toBe(true);
    expect(s.groupBest('g1')!.id).toBe('p0');
    expect(s.getState('p0')).toBe('kept');
    for (const id of ['p1', 'p2', 'p3']) expect(s.getState(id)).toBe('culled');
    expect(s.duelHistory).toHaveLength(3);
    expect(
      s
        .stagedCulls()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['p1', 'p2', 'p3']);
  });

  it('odd group (5): bye advances the leftover photo, mixed decisions', () => {
    const s = groupSession(5);

    // Round 1: (p0,p1) keep both, p0 better; (p2,p3) cull p2; p4 gets a bye.
    expect(s.decideDuel({ keepBoth: true, winner: 'p0' }, 1)).toMatchObject({
      winnerId: 'p0',
      loserId: 'p1',
      keptBoth: true,
    });
    expect(s.getState('p1')).toBe('kept'); // keepBoth loser is kept immediately
    s.decideDuel({ cull: 'p2' }, 2);
    expect(s.getState('p2')).toBe('culled');

    // Round 2: [p0, p3, p4] — pair (p0, p3), then p4 byes again.
    let pair = s.nextPair()!;
    expect([pair.a.id, pair.b.id]).toEqual(['p0', 'p3']);
    s.decideDuel({ keepBoth: true, winner: 'p3' }, 3);

    // Round 3: (p3, p4).
    pair = s.nextPair()!;
    expect([pair.a.id, pair.b.id]).toEqual(['p3', 'p4']);
    s.decideDuel({ cull: 'p4' }, 4);

    expect(s.nextPair()).toBeNull();
    expect(s.groupBest('g1')!.id).toBe('p3');
    expect(s.duelHistory).toHaveLength(4); // n - 1
    expect(s.getState('p0')).toBe('kept');
    expect(s.getState('p3')).toBe('kept');
    expect(
      s
        .stagedCulls()
        .map((i) => i.id)
        .sort(),
    ).toEqual(['p2', 'p4']);
  });

  it('every n-photo group takes exactly n-1 duels, for odd and even n', () => {
    for (let n = 2; n <= 9; n++) {
      const s = groupSession(n);
      expect(cullAll(s)).toBe(n - 1);
      expect(s.isGroupComplete('g1')).toBe(true);
      expect(s.groupBest('g1')).not.toBeNull();
    }
  });

  it('keepBoth everywhere: nobody culled, one best, all kept', () => {
    const s = groupSession(4);
    while (s.nextPair()) {
      s.decideDuel({ keepBoth: true, winner: s.nextPair()!.a.id }, 5);
    }
    expect(s.stagedCulls()).toEqual([]);
    expect(s.groupBest('g1')!.id).toBe('p0');
    for (const id of ['p0', 'p1', 'p2', 'p3']) expect(s.getState(id)).toBe('kept');
  });

  it('group of 1 completes instantly: photo is best and kept, no duels', () => {
    const s = groupSession(1);
    expect(s.nextPair()).toBeNull();
    expect(s.isGroupComplete('g1')).toBe(true);
    expect(s.groupBest('g1')!.id).toBe('p0');
    expect(s.getState('p0')).toBe('kept');
    expect(s.duelHistory).toHaveLength(0);
  });

  it('group of 2 is a single duel', () => {
    const s = groupSession(2);
    s.decideDuel({ cull: 'p0' }, 1);
    expect(s.nextPair()).toBeNull();
    expect(s.groupBest('g1')!.id).toBe('p1');
  });

  it('works through multiple groups in order', () => {
    const s = CullSession.create({
      groups: [group('g1', burst(2, 0, 1000, 'a')), group('g2', burst(3, 10_000, 1000, 'b'))],
    });
    expect(s.nextPair()!.groupId).toBe('g1');
    s.decideDuel({ cull: 'a1' }, 1);
    expect(s.nextPair()!.groupId).toBe('g2');
    cullAll(s);
    expect(s.isGroupComplete('g2')).toBe(true);
    expect(s.isComplete()).toBe(true);
  });

  it('nextPair is a pure peek — repeated calls return the same pair', () => {
    const s = groupSession(4);
    const a = s.nextPair()!;
    const b = s.nextPair()!;
    expect([b.a.id, b.b.id]).toEqual([a.a.id, a.b.id]);
    expect(s.duelHistory).toHaveLength(0);
  });

  it('rejects decisions naming a photo outside the current pair', () => {
    const s = groupSession(4); // current pair is (p0, p1)
    expect(() => s.decideDuel({ cull: 'p3' }, 1)).toThrow(/not in the current pair/);
    expect(() => s.decideDuel({ keepBoth: true, winner: 'p2' }, 1)).toThrow(
      /not in the current pair/,
    );
    expect(s.duelHistory).toHaveLength(0);
  });

  it('rejects duels when everything is complete', () => {
    const s = groupSession(2);
    s.decideDuel({ cull: 'p1' }, 1);
    expect(() => s.decideDuel({ cull: 'p0' }, 2)).toThrow(/no duel pending/);
  });

  it('rejects duplicate photo ids and duplicate group ids', () => {
    const a = item('dup', 0);
    expect(() =>
      CullSession.create({ groups: [group('g1', [a, item('x', 1)]), group('g2', [a])] }),
    ).toThrow(/duplicate photo id/);
    expect(() =>
      CullSession.create({ groups: [group('g1', [item('x', 0)]), group('g1', [item('y', 1)])] }),
    ).toThrow(/duplicate group id/);
    expect(() => CullSession.create({ groups: [group('g1', [a])], singles: [a] })).toThrow(
      /duplicate photo id/,
    );
  });
});

describe('CullSession — auto-cull candidates', () => {
  it('flags kept photos that never won a duel, excluding the best', () => {
    const s = groupSession(4);
    // (p0,p1): keep both, p0 wins. (p2,p3): keep both, p2 wins. Final: p0 beats p2.
    s.decideDuel({ keepBoth: true, winner: 'p0' }, 1);
    s.decideDuel({ keepBoth: true, winner: 'p2' }, 2);
    s.decideDuel({ keepBoth: true, winner: 'p0' }, 3);

    // p1 and p3 never won; p2 won round 1; p0 is best.
    expect(
      s
        .autoCullCandidates('g1')
        .map((i) => i.id)
        .sort(),
    ).toEqual(['p1', 'p3']);
  });

  it('culled photos and duel winners are never candidates', () => {
    const s = groupSession(4);
    s.decideDuel({ keepBoth: true, winner: 'p1' }, 1); // p0 kept, no wins
    s.decideDuel({ cull: 'p3' }, 2); // p3 culled; p2 won this duel
    s.decideDuel({ keepBoth: true, winner: 'p1' }, 3); // p2 kept, lost the final
    // p3 is culled, p2 won a duel, p1 is best — only p0 is a candidate.
    expect(s.autoCullCandidates('g1').map((i) => i.id)).toEqual(['p0']);
  });

  it('a 1-photo group has no candidates (its photo is the best)', () => {
    const s = groupSession(1);
    expect(s.autoCullCandidates('g1')).toEqual([]);
  });

  it('throws for unknown groups', () => {
    expect(() => groupSession(2).autoCullCandidates('nope')).toThrow(/unknown group/);
  });
});

describe('CullSession — singles review', () => {
  const makeSingles = () =>
    CullSession.create({
      groups: [],
      singles: [item('s1', 10), item('s2', 20), item('s3', 30)],
    });

  it('iterates pending singles in order and applies keep/cull', () => {
    const s = makeSingles();
    expect(s.nextSingle()!.id).toBe('s1');
    s.decideSingle('s1', 'keep');
    expect(s.getState('s1')).toBe('kept');
    expect(s.nextSingle()!.id).toBe('s2');
    s.decideSingle('s2', 'cull');
    expect(s.getState('s2')).toBe('culled');
    s.decideSingle('s3', 'keep');
    expect(s.nextSingle()).toBeNull();
    expect(s.isComplete()).toBe(true);
    expect(s.stagedCulls().map((i) => i.id)).toEqual(['s2']);
  });

  it('singles can be decided out of order', () => {
    const s = makeSingles();
    s.decideSingle('s3', 'cull');
    expect(s.nextSingle()!.id).toBe('s1');
  });

  it('rejects double decisions, unknown ids, and non-single ids', () => {
    const s = CullSession.create({
      groups: [group('g1', burst(2, 0, 1000))],
      singles: [item('s1', 10)],
    });
    s.decideSingle('s1', 'keep');
    expect(() => s.decideSingle('s1', 'cull')).toThrow(/already reviewed/);
    expect(() => s.decideSingle('nope', 'keep')).toThrow(/not a single/);
    expect(() => s.decideSingle('p0', 'keep')).toThrow(/not a single/);
  });
});

describe('CullSession — staged culls, confirm, trash', () => {
  it('un-cull restores to kept and does NOT re-enter the bracket', () => {
    const s = groupSession(4);
    s.decideDuel({ cull: 'p1' }, 1);
    const pairBefore = s.nextPair()!;
    s.unstageCull('p1');
    expect(s.getState('p1')).toBe('kept');
    expect(s.stagedCulls()).toEqual([]);
    // Bracket unaffected: same pending pair, and p1 never duels again.
    const pairAfter = s.nextPair()!;
    expect([pairAfter.a.id, pairAfter.b.id]).toEqual([pairBefore.a.id, pairBefore.b.id]);
    const remainingDuelIds: string[] = [];
    while (s.nextPair()) {
      const p = s.nextPair()!;
      remainingDuelIds.push(p.a.id, p.b.id);
      s.decideDuel({ cull: p.b.id }, 2);
    }
    expect(remainingDuelIds).not.toContain('p1');
    // The duel that removed p1 stands in history.
    expect(s.duelHistory[0]).toMatchObject({ loserId: 'p1', keptBoth: false });
  });

  it('confirmAll: culled → confirmed across groups and singles, then trashed', () => {
    const s = CullSession.create({
      groups: [group('g1', burst(3, 0, 1000))],
      singles: [item('s1', 10), item('s2', 20)],
    });
    cullAll(s); // culls p1 then loser of final
    s.decideSingle('s1', 'cull');
    s.decideSingle('s2', 'keep');

    const staged = s.stagedCulls().map((i) => i.id);
    expect(staged).toHaveLength(3);

    const confirmed = s.confirmAll();
    expect(confirmed.sort()).toEqual([...staged].sort());
    for (const id of confirmed) expect(s.getState(id)).toBe('confirmed');
    expect(s.stagedCulls()).toEqual([]);
    expect(s.confirmAll()).toEqual([]); // idempotent when nothing is staged

    // App deletes two of three and reports back.
    s.markTrashed(confirmed.slice(0, 2));
    expect(s.getState(confirmed[0])).toBe('trashed');
    expect(s.getState(confirmed[1])).toBe('trashed');
    expect(s.getState(confirmed[2])).toBe('confirmed');
    expect(s.summary()).toMatchObject({ total: 5, trashed: 2, confirmed: 1, kept: 2 });
  });

  it('guards state transitions', () => {
    const s = CullSession.create({ groups: [], singles: [item('s1', 10)] });
    expect(() => s.unstageCull('s1')).toThrow(/is unreviewed, expected culled/);
    s.decideSingle('s1', 'cull');
    expect(() => s.markTrashed(['s1'])).toThrow(/is culled, expected confirmed/);
    s.confirmAll();
    expect(() => s.unstageCull('s1')).toThrow(/expected culled/);
    expect(() => s.markTrashed(['ghost'])).toThrow(/unknown photo id/);
    // Failed markTrashed batches are atomic: s1 untouched by the ghost batch.
    expect(() => s.markTrashed(['s1', 'ghost'])).toThrow();
    expect(s.getState('s1')).toBe('confirmed');
  });
});

describe('CullSession — serialization', () => {
  function midBracketSession() {
    const s = CullSession.create({
      groups: [group('g1', burst(5, 0, 1000)), group('g2', burst(4, 60_000, 1000, 'q'))],
      singles: [item('s1', 10), item('s2', 20)],
    });
    s.decideDuel({ keepBoth: true, winner: 'p0' }, 1);
    s.decideDuel({ cull: 'p2' }, 2);
    s.decideSingle('s1', 'cull');
    return s;
  }

  it('round-trips through real JSON mid-bracket, preserving everything', () => {
    const original = midBracketSession();
    const restored = CullSession.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));

    expect(restored.duelHistory).toEqual(original.duelHistory);
    const op = original.nextPair()!;
    const rp = restored.nextPair()!;
    expect([rp.groupId, rp.a.id, rp.b.id]).toEqual([op.groupId, op.a.id, op.b.id]);
    for (const id of ['p0', 'p1', 'p2', 's1', 's2']) {
      expect(restored.getState(id)).toBe(original.getState(id));
    }
    expect(restored.stagedCulls().map((i) => i.id)).toEqual(
      original.stagedCulls().map((i) => i.id),
    );
  });

  it('restored session behaves identically under the same subsequent decisions', () => {
    const a = midBracketSession();
    const b = CullSession.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    const drive = (s: CullSession) => {
      while (s.nextPair()) s.decideDuel({ cull: s.nextPair()!.b.id }, 9);
      s.decideSingle('s2', 'keep');
      s.confirmAll();
    };
    drive(a);
    drive(b);
    expect(b.toJSON()).toEqual(a.toJSON());
    expect(b.isComplete()).toBe(true);
    expect(b.groupBest('g1')!.id).toBe(a.groupBest('g1')!.id);
  });

  it('a snapshot taken after restore equals the original snapshot', () => {
    const s = midBracketSession();
    const snap = JSON.parse(JSON.stringify(s.toJSON()));
    expect(JSON.parse(JSON.stringify(CullSession.fromJSON(snap).toJSON()))).toEqual(snap);
  });

  it('rejects malformed snapshots', () => {
    expect(() => CullSession.fromJSON(null)).toThrow();
    expect(() => CullSession.fromJSON('{}')).toThrow();
    expect(() => CullSession.fromJSON({ version: 2 })).toThrow(/unsupported version/);
    expect(() =>
      CullSession.fromJSON({
        version: 1,
        items: [],
        brackets: [],
        singleIds: [],
        duelHistory: [],
        states: { ghost: 'kept' },
      }),
    ).toThrow(/unknown id/);
  });

  it('rejects structurally inconsistent snapshots', () => {
    const snap = () => JSON.parse(JSON.stringify(midBracketSession().toJSON()));

    const dupItem = snap();
    dupItem.items.push({ ...dupItem.items[0] });
    expect(() => CullSession.fromJSON(dupItem)).toThrow(/duplicate photo id/);

    const missingState = snap();
    delete missingState.states.p0;
    expect(() => CullSession.fromJSON(missingState)).toThrow(/missing state/);

    const badState = snap();
    badState.states.p0 = 'zombie';
    expect(() => CullSession.fromJSON(badState)).toThrow(/invalid state/);

    const ghostRound = snap();
    ghostRound.brackets[0].currentRound.push('s2'); // a single, not a member
    expect(() => CullSession.fromJSON(ghostRound)).toThrow(/non-member/);

    const culledAlive = snap();
    culledAlive.brackets[0].currentRound.push('p2'); // p2 was culled mid-bracket
    expect(() => CullSession.fromJSON(culledAlive)).toThrow(/still in a round/);

    const staleBest = snap();
    staleBest.brackets[0].bestId = 'p0'; // bracket is still incomplete
    expect(() => CullSession.fromJSON(staleBest)).toThrow(/has a best photo/);

    const unassigned = snap();
    unassigned.singleIds.pop(); // s2 no longer belongs anywhere
    expect(() => CullSession.fromJSON(unassigned)).toThrow(/not assigned/);

    const ghostDuel = snap();
    ghostDuel.duelHistory.push({
      groupId: 'g1',
      winnerId: 'p0',
      loserId: 'q1',
      keptBoth: true,
      at: 3,
    });
    expect(() => CullSession.fromJSON(ghostDuel)).toThrow(/not in their group/);

    const done = groupSession(2);
    cullAll(done);
    const bestMismatch = JSON.parse(JSON.stringify(done.toJSON()));
    bestMismatch.brackets[0].bestId = 'p1'; // the culled photo, not the survivor
    expect(() => CullSession.fromJSON(bestMismatch)).toThrow(/best photo mismatch/);

    const noSurvivor = snap();
    // All members kept, rounds emptied, no best: impossible for a real
    // bracket (duels always leave exactly one standing photo).
    const b = noSurvivor.brackets[0];
    b.currentRound = [];
    b.nextRound = [];
    b.bestId = null;
    b.complete = true;
    for (const id of b.photoIds) noSurvivor.states[id] = 'kept';
    expect(() => CullSession.fromJSON(noSurvivor)).toThrow(/exactly one standing photo/);

    const emptyBracket = snap();
    emptyBracket.brackets.push({
      groupId: 'g3',
      photoIds: [],
      currentRound: [],
      nextRound: [],
      bestId: null,
      complete: true,
    });
    expect(() => CullSession.fromJSON(emptyBracket)).toThrow(/empty bracket/);
  });
});

describe('CullSession — summary and completeness', () => {
  it('tracks counts through a full session lifecycle', () => {
    const s = CullSession.create({
      groups: [group('g1', burst(4, 0, 1000))],
      singles: [item('s1', 10)],
    });
    expect(s.summary()).toEqual({
      total: 5,
      unreviewed: 5,
      kept: 0,
      culled: 0,
      confirmed: 0,
      trashed: 0,
    });
    expect(s.isComplete()).toBe(false);

    cullAll(s);
    s.decideSingle('s1', 'keep');
    expect(s.isComplete()).toBe(true);
    expect(s.summary()).toEqual({
      total: 5,
      unreviewed: 0,
      kept: 2,
      culled: 3,
      confirmed: 0,
      trashed: 0,
    });

    const ids = s.confirmAll();
    s.markTrashed(ids);
    expect(s.summary()).toEqual({
      total: 5,
      unreviewed: 0,
      kept: 2,
      culled: 0,
      confirmed: 0,
      trashed: 3,
    });
  });
});
