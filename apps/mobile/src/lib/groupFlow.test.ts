import { describe, expect, it } from 'vitest';
import { completedDuringVisit, destinationAfterGroup } from './groupFlow';

const groups = (states: Array<[string, boolean]>) =>
  states.map(([id, complete]) => ({ id, complete }));

describe('destinationAfterGroup', () => {
  it('advances to the next unfinished group', () => {
    expect(
      destinationAfterGroup(
        groups([
          ['g1', true],
          ['g2', false],
          ['g3', false],
        ]),
        'g1',
        true,
      ),
    ).toEqual({ screen: 'Deck', groupId: 'g2' });
  });

  it('wraps to an earlier unfinished group after out-of-order review', () => {
    expect(
      destinationAfterGroup(
        groups([
          ['g1', false],
          ['g2', true],
          ['g3', true],
        ]),
        'g3',
        false,
      ),
    ).toEqual({ screen: 'Deck', groupId: 'g1' });
  });

  it('continues to singles when all groups are complete', () => {
    expect(
      destinationAfterGroup(
        groups([
          ['g1', true],
          ['g2', true],
        ]),
        'g2',
        true,
      ),
    ).toEqual({ screen: 'Singles' });
  });

  it('continues to the cull list when no group or single remains', () => {
    expect(destinationAfterGroup(groups([['g1', true]]), 'g1', false)).toEqual({
      screen: 'CullList',
    });
  });

  it('a dissolved middle group advances from its FORMER position, not the top', () => {
    // g2 dissolved (pair broken by "Not related") — it held index 1, so
    // the successor is the group now at that index (g3), not g1.
    expect(
      destinationAfterGroup(
        groups([
          ['g1', false],
          ['g3', false],
        ]),
        'g2',
        false,
        1,
      ),
    ).toEqual({ screen: 'Deck', groupId: 'g3' });
    // Without the former index the scan starts at the top (the old bug).
    // A dissolved FIRST group (index 0) starts at the new index 0.
    expect(destinationAfterGroup(groups([['g4', false]]), 'gX', true, 0)).toEqual({
      screen: 'Deck',
      groupId: 'g4',
    });
  });
});

describe('completedDuringVisit', () => {
  it('advances only on an incomplete-to-complete transition in the active group', () => {
    expect(completedDuringVisit({ groupId: 'g1', complete: false }, 'g1', true, true)).toBe(true);
    expect(completedDuringVisit({ groupId: 'g1', complete: true }, 'g1', true, true)).toBe(false);
    expect(completedDuringVisit({ groupId: 'g1', complete: false }, 'g2', true, true)).toBe(false);
  });

  it('defers the transition while another screen is focused', () => {
    expect(completedDuringVisit({ groupId: 'g1', complete: false }, 'g1', true, false)).toBe(false);
  });
});
