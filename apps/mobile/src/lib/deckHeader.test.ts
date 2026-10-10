import { describe, expect, it } from 'vitest';
import {
  NO_FOLD_CHOICES,
  STAGE_MIN_SHARE,
  foldAfterTap,
  headerFolded,
  parseFoldChoices,
  roomFor,
  serializeFoldChoices,
} from './deckHeader';

describe('deckHeader', () => {
  it('sorts the deck by the stage share of the window in the expanded layout', () => {
    // The S10e's measured shares (window 760 dp): 31 % at 1.0, 28 % at
    // 1.3, 12 % at 2.0; the 320 dp emulator's 14 % at 1.3.
    expect(roomFor(236, 760)).toBe('roomy');
    expect(roomFor(214, 760)).toBe('roomy');
    expect(roomFor(94, 760)).toBe('tight');
    expect(roomFor(60, 427)).toBe('tight');
    expect(roomFor(760 * STAGE_MIN_SHARE, 760)).toBe('roomy');
    expect(roomFor(100, 0)).toBe('tight');
  });

  it('folds tight by default and leaves roomy expanded', () => {
    expect(headerFolded(NO_FOLD_CHOICES, 'tight')).toBe(true);
    expect(headerFolded(NO_FOLD_CHOICES, 'roomy')).toBe(false);
  });

  it('remembers a tap per room, so a fold at 1.0 does not unfold large text', () => {
    const foldedAtRoomy = foldAfterTap(NO_FOLD_CHOICES, 'roomy', false);
    expect(headerFolded(foldedAtRoomy, 'roomy')).toBe(true);
    expect(headerFolded(foldedAtRoomy, 'tight')).toBe(true);
    const unfoldedAtTight = foldAfterTap(foldedAtRoomy, 'tight', true);
    expect(headerFolded(unfoldedAtTight, 'tight')).toBe(false);
    expect(headerFolded(unfoldedAtTight, 'roomy')).toBe(true);
  });

  it('round-trips the choices through the settings row and defaults on junk', () => {
    const choices = { roomy: true, tight: null };
    expect(serializeFoldChoices(choices)).toBe('roomy=1,tight=-');
    expect(parseFoldChoices(serializeFoldChoices(choices))).toEqual(choices);
    expect(parseFoldChoices(serializeFoldChoices(NO_FOLD_CHOICES))).toEqual(NO_FOLD_CHOICES);
    expect(parseFoldChoices('roomy=0,tight=0')).toEqual({ roomy: false, tight: false });
    expect(parseFoldChoices(null)).toEqual(NO_FOLD_CHOICES);
    expect(parseFoldChoices('')).toEqual(NO_FOLD_CHOICES);
    expect(parseFoldChoices('folded')).toEqual(NO_FOLD_CHOICES);
    expect(parseFoldChoices('roomy=2,tight=1')).toEqual(NO_FOLD_CHOICES);
  });
});
