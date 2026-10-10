/**
 * The deck header's fold (m0.9.1, Tristan's screenshot review 2026-10-11):
 * at large text the title, the hint, the strip and the chip rows grow
 * while the stage takes what is left — 12 % of the window at 2.0 on the
 * S10e, nothing at all at 2.0 on a 320 dp phone. The header FOLDS: the
 * title on one line, the hint gone, a chevron at the title's end to
 * unfold it; still short after that, the thumbnail strip folds too. Two
 * inputs, one control:
 *
 *   - The DEFAULT is measured: the stage's share of the window in the
 *     EXPANDED layout (measured once per font scale and width, never
 *     from a folded layout — folding grows the stage, and a decision
 *     read from its own result would unfold again) sorts the deck into
 *     "roomy" or "tight"; tight folds by default.
 *   - The CHEVRON is always there, at every scale, pointing down when
 *     folded ("there is more here") and up when expanded. A tap flips
 *     the fold, remembered DURABLY per room: a fold made at 1.0 to lose
 *     the hint persists there, and the large-text default stays folded
 *     until that user unfolds it — one choice does not carry across the
 *     two situations (Tristan's pick over one durable choice or a
 *     session memory).
 *
 * Pure: the share rule, the choices' round trip through the settings
 * row, and the fold read from them. The screen measures and persists
 * (lib/deckHeaderPrefs.ts).
 */

/** The stage's share of the window, in the expanded layout, below which
 * the deck is TIGHT and folds by default. A first guess for the grilling:
 * the S10e at 1.0 gives the stage 31 % and at 1.3 28 % (both roomy, the
 * deck as designed), at 2.0 12 %; a 320 dp phone gives 14 % at 1.3. */
export const STAGE_MIN_SHARE = 0.25;

export type HeaderRoom = 'roomy' | 'tight';

export function roomFor(stageDp: number, windowDp: number): HeaderRoom {
  return windowDp > 0 && stageDp >= windowDp * STAGE_MIN_SHARE ? 'roomy' : 'tight';
}

/** The remembered fold per room; null is "never chosen" (the default). */
export interface FoldChoices {
  roomy: boolean | null;
  tight: boolean | null;
}

export const NO_FOLD_CHOICES: FoldChoices = { roomy: null, tight: null };

/** The settings row: `roomy=<0|1|->,tight=<0|1|->`; anything else reads as
 * no choices (a corrupt row is a default, never a crash). */
export const DECK_HEADER_FOLD_KEY = 'deck_header_fold';

export function parseFoldChoices(raw: string | null | undefined): FoldChoices {
  if (!raw) return NO_FOLD_CHOICES;
  const m = /^roomy=([01-]),tight=([01-])$/.exec(raw.trim());
  if (!m) return NO_FOLD_CHOICES;
  const bit = (c: string) => (c === '-' ? null : c === '1');
  return { roomy: bit(m[1]!), tight: bit(m[2]!) };
}

export function serializeFoldChoices(choices: FoldChoices): string {
  const bit = (v: boolean | null) => (v === null ? '-' : v ? '1' : '0');
  return `roomy=${bit(choices.roomy)},tight=${bit(choices.tight)}`;
}

/** Folded now: the room's remembered choice, else the measured default. */
export function headerFolded(choices: FoldChoices, room: HeaderRoom): boolean {
  const chosen = choices[room];
  return chosen === null ? room === 'tight' : chosen;
}

/** The choices after a chevron tap in `room`, from the fold shown. */
export function foldAfterTap(choices: FoldChoices, room: HeaderRoom, folded: boolean): FoldChoices {
  return { ...choices, [room]: !folded };
}
