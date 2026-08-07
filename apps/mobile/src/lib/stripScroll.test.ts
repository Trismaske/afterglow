import { describe, expect, it } from 'vitest';
import { stripScrollOffset, type StripGeometry } from './stripScroll';

/** The deck's real strip: 52 px thumbs, 6 px gaps, 2 px leading inset,
 * on a 1080 px-wide phone at 3× density (360 dp of viewport). */
const THUMB = 52;
const PITCH = THUMB + 6;
const geometryFor = (count: number, viewport = 360): StripGeometry => ({
  pitch: PITCH,
  size: THUMB,
  leadingInset: 2,
  viewport,
  content: 2 + count * PITCH + 2,
});

describe('stripScrollOffset', () => {
  it('leaves a comfortably visible item alone — which leaves a manual scroll alone', () => {
    const geometry = geometryFor(40);
    // Item 4 spans 234..286 in a 360-wide viewport, a full pitch clear of
    // the right edge, so the strip stays exactly where the user left it.
    expect(stripScrollOffset(4, 0, geometry)).toBeNull();
  });

  it('scrolls before the current item reaches the edge, not after', () => {
    const geometry = geometryFor(40);
    // Item 5 spans 292..344 and IS still fully visible at offset 0 — but
    // only 16 px of the next thumbnail would show, less than the
    // one-item lead, so the strip moves now rather than one swipe later.
    expect(stripScrollOffset(5, 0, geometry)).not.toBeNull();
    // Item 6 spans 350..402: past the edge, and beyond argument.
    expect(stripScrollOffset(6, 0, geometry)).not.toBeNull();
  });

  it('moves the MINIMUM needed, keeping the item at the edge it entered from', () => {
    const geometry = geometryFor(40);
    // Coming forward: item 6 ends at 402, so the smallest offset showing
    // it with a 58 px lead is 402 + 58 - 360.
    expect(stripScrollOffset(6, 0, geometry)).toBe(402 + PITCH - 360);
    // Coming backward from far right: item 6 starts at 350, so the
    // largest such offset is 350 - 58.
    expect(stripScrollOffset(6, 600, geometry)).toBe(350 - PITCH);
  });

  it('reaches the last item — the F7 report, at the end of a long run', () => {
    const geometry = geometryFor(40);
    const maxOffset = geometry.content - geometry.viewport;
    const target = stripScrollOffset(39, 0, geometry);
    expect(target).toBe(maxOffset);
    // And once there, it stays: the strip must not fight its own bound.
    expect(stripScrollOffset(39, maxOffset, geometry)).toBeNull();
  });

  it('reaches the first item without scrolling past zero', () => {
    const geometry = geometryFor(40);
    expect(stripScrollOffset(0, 600, geometry)).toBe(0);
    expect(stripScrollOffset(0, 0, geometry)).toBeNull();
  });

  it('centres the item when the viewport cannot hold a lead on both sides', () => {
    // A viewport barely wider than one thumbnail: the two bounds meet
    // rather than fight, which is what the lead clamp buys.
    const narrow = geometryFor(40, THUMB + 20);
    const target = stripScrollOffset(6, 0, narrow);
    const start = 2 + 6 * PITCH;
    expect(target).toBe(start + THUMB / 2 - narrow.viewport / 2);
  });

  it('does nothing when the whole strip fits, or before it is measured', () => {
    expect(stripScrollOffset(2, 0, geometryFor(3))).toBeNull();
    expect(stripScrollOffset(2, 0, { ...geometryFor(40), viewport: 0 })).toBeNull();
    expect(stripScrollOffset(-1, 0, geometryFor(40))).toBeNull();
  });
});
