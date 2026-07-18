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
