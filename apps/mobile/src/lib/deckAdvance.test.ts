import { describe, expect, it } from 'vitest';
import { nearestPendingIndex } from './deckAdvance';

/** P = pending, D = decided — the strip as the tester sees it. */
const flags = (s: string): boolean[] => [...s].map((c) => c === 'P');

describe('nearestPendingIndex', () => {
  it('advances to the adjacent pending photo (the ordinary swipe-through)', () => {
    expect(nearestPendingIndex(flags('DPPP'), 0)).toBe(1);
  });

  it('skips decided neighbours forward (F24 as measured: Keep@2/7 must land on 4, not the kept 3)', () => {
    // Positions (1-based) 3 and 5 kept, deciding 2: land on 4.
    expect(nearestPendingIndex(flags('PDDPDPP'), 1)).toBe(3);
  });

  it('prefers a far forward photo over a near backward one (forward first)', () => {
    expect(nearestPendingIndex(flags('PDDDP'), 2)).toBe(4);
  });

  it('goes backward to the CLOSEST pending when none remain ahead (F23 as measured: Keep@3/3 with 1 pending)', () => {
    expect(nearestPendingIndex(flags('PDD'), 2)).toBe(0);
    // Closest backward, not first-of-unit.
    expect(nearestPendingIndex(flags('PPDDD'), 4)).toBe(1);
  });

  it('stays put when nothing is pending anywhere (completion, and browse-mode re-decides)', () => {
    expect(nearestPendingIndex(flags('DDDD'), 1)).toBeNull();
    expect(nearestPendingIndex(flags('D'), 0)).toBeNull();
  });

  it('never targets the just-decided photo, even if its flag is stale-true', () => {
    // The caller decided `from` a moment ago; a stale row must not bounce
    // the cursor back onto it.
    expect(nearestPendingIndex(flags('DPD'), 1)).toBeNull();
  });

  it('tolerates an out-of-range from (defensive: a decision racing a membership change)', () => {
    expect(nearestPendingIndex(flags('PD'), 5)).toBe(0);
    expect(nearestPendingIndex(flags('DD'), -1)).toBeNull();
  });
});
