import { describe, expect, it } from 'vitest';
import {
  deckParamsFor,
  deckUnitKey,
  paramsForUnit,
  unitFromDestination,
  unitFromParams,
  type DeckUnit,
} from './deckUnit';

const GROUP: DeckUnit = { kind: 'group', groupId: '42' };
const LINEAR: DeckUnit = { kind: 'group', groupId: null };
const RUN: DeckUnit = { kind: 'run', day: '2026-07-30', range: { from: 100, to: 200 } };
const DAY: DeckUnit = { kind: 'run', day: '2026-07-30' };

describe('deckUnitKey', () => {
  it('separates the three kinds of unit', () => {
    const keys = [GROUP, LINEAR, RUN, DAY].map(deckUnitKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('tells a RUN apart from the whole DAY it sits in', () => {
    // The deck stamps its async row reads with this key. A run and its
    // day read different rows, so sharing a key would let one unit's
    // rows render as the other's.
    expect(deckUnitKey(RUN)).not.toBe(deckUnitKey(DAY));
  });

  it('tells two runs of the same day apart by their range', () => {
    const earlier: DeckUnit = { kind: 'run', day: '2026-07-30', range: { from: 10, to: 90 } };
    expect(deckUnitKey(earlier)).not.toBe(deckUnitKey(RUN));
  });

  it('gives equal units equal keys', () => {
    expect(deckUnitKey({ kind: 'run', day: '2026-07-30', range: { from: 100, to: 200 } })).toBe(
      deckUnitKey(RUN),
    );
  });
});

describe('the route-param round trip', () => {
  it.each([
    ['a specific group', GROUP],
    ['the linear flow', LINEAR],
    ['a timeline run', RUN],
    ['a whole day', DAY],
  ])('survives params and back: %s', (_label, unit) => {
    expect(unitFromParams(paramsForUnit(unit))).toEqual(unit);
  });

  it('reads a paramless route as the linear flow', () => {
    expect(unitFromParams(undefined)).toEqual(LINEAR);
    expect(unitFromParams({})).toEqual(LINEAR);
  });

  it('clears the other kind of field, because setParams merges', () => {
    // Advancing run → group must not leave `day` behind: the next read
    // would call a group deck a singles run.
    expect(paramsForUnit(GROUP)).toEqual({
      groupId: '42',
      day: undefined,
      from: undefined,
      to: undefined,
    });
    expect(paramsForUnit(RUN)).toEqual({
      groupId: undefined,
      day: '2026-07-30',
      from: 100,
      to: 200,
    });
  });

  it('degrades a half range to the whole day', () => {
    // Half a bound reads a different row set than the caller named.
    expect(unitFromParams({ day: '2026-07-30', from: 100 })).toEqual(DAY);
    expect(unitFromParams({ day: '2026-07-30', to: 200 })).toEqual(DAY);
  });

  it('lets day win over a stale groupId', () => {
    expect(unitFromParams({ groupId: '42', day: '2026-07-30' })).toEqual(DAY);
  });
});

describe('destinations', () => {
  it('carries a group destination through unchanged', () => {
    expect(unitFromDestination({ kind: 'group', groupId: '42' })).toEqual(GROUP);
  });

  it('carries a run destination with its full range', () => {
    expect(unitFromDestination({ kind: 'run', day: '2026-07-30', from: 100, to: 200 })).toEqual(
      RUN,
    );
  });

  it('produces params a deck reads back as the same unit', () => {
    const destination = { kind: 'run', day: '2026-07-30', from: 100, to: 200 } as const;
    expect(unitFromParams(deckParamsFor(destination))).toEqual(unitFromDestination(destination));
  });
});
