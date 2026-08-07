/**
 * The deck's unit identity and its route-param round trip (m0.8.5, L4).
 *
 * Since L4 the deck holds its current unit in STATE and advances in
 * place: one `Deck` route serves both unit kinds, and the app enters it
 * once per sitting instead of remounting per unit. That makes two things
 * pure logic worth testing on their own:
 *
 * - `deckUnitKey` — one unit's identity as a string. It keys the deck's
 *   per-unit effects AND stamps its async row reads, so rows fetched for
 *   a previous unit can never be mistaken for the current one's.
 * - `unitFromParams` / `paramsForUnit` — the two directions of the route
 *   params. They are a round trip, so they change together, and the
 *   tests assert exactly that.
 *
 * The impure partner is `screens/DeckScreen.tsx`, which owns the state
 * and calls `navigation.setParams` as it advances.
 */
import type { RootStackParamList } from '../navigation';
import type { UnitDestination } from './timeline';

type DeckParams = RootStackParamList['Deck'];

/**
 * The unit a deck is currently on. `group` with a null id is the LINEAR
 * flow: follow the timeline's first pending unit.
 */
export type DeckUnit =
  | { kind: 'group'; groupId: string | null }
  | {
      kind: 'run';
      /** The deck's day scope, always present — the global singles feed
       * deck is gone with the merged timeline (m0.8.2). */
      day: string;
      /** A timeline RUN's inclusive taken_at range; absent = the whole
       * day (the DayProgress CTA's deck). */
      range?: { from: number; to: number };
    };

/** One unit's identity. Two units are the same iff their keys match. */
export function deckUnitKey(unit: DeckUnit): string {
  return unit.kind === 'run'
    ? `r:${unit.day}:${unit.range?.from ?? ''}:${unit.range?.to ?? ''}`
    : `g:${unit.groupId ?? ''}`;
}

/**
 * READ half of the Deck route's params.
 *
 * `day` decides the kind: a run always carries one, a group never does.
 * A half-range (one of from/to) is NOT a range — a deck opened on half a
 * bound would read a different set of rows than the caller named, so it
 * degrades to the whole day, which is the honest wider scope.
 */
export function unitFromParams(params: DeckParams): DeckUnit {
  if (params?.day !== undefined)
    return {
      kind: 'run',
      day: params.day,
      range:
        params.from !== undefined && params.to !== undefined
          ? { from: params.from, to: params.to }
          : undefined,
    };
  return { kind: 'group', groupId: params?.groupId ?? null };
}

/**
 * WRITE half. Every field is spelled out, `undefined` included, because
 * `setParams` MERGES: a left-over `day` from the previous unit would
 * make the next read call a group deck a singles run.
 */
export function paramsForUnit(unit: DeckUnit): DeckParams {
  return unit.kind === 'run'
    ? { groupId: undefined, day: unit.day, from: unit.range?.from, to: unit.range?.to }
    : { groupId: unit.groupId ?? undefined, day: undefined, from: undefined, to: undefined };
}

/** A timeline destination as a deck unit. */
export function unitFromDestination(
  destination: Exclude<UnitDestination, { kind: 'cullList' }>,
): DeckUnit {
  return destination.kind === 'group'
    ? { kind: 'group', groupId: destination.groupId }
    : { kind: 'run', day: destination.day, range: { from: destination.from, to: destination.to } };
}

/** Route params for a destination — what every screen that opens the
 * deck passes to `navigation.navigate('Deck', …)`. */
export function deckParamsFor(
  destination: Exclude<UnitDestination, { kind: 'cullList' }>,
): DeckParams {
  return paramsForUnit(unitFromDestination(destination));
}
