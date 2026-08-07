/**
 * Keeping a horizontal strip on its current item (m0.8.5, F7) — pure.
 *
 * The deck's thumbnail strip stopped tracking after roughly the seventh
 * photo of a run: the pager scrolled to the cursor, the strip did not,
 * so the thumbnail for the photo you were looking at sat off-screen.
 *
 * The rule is deliberately the one F8 arrived at for the Progress
 * histogram, stated once: **move the minimum needed to keep the current
 * item visible**, rather than choosing between "follow the cursor" and
 * "leave the user's scroll alone". A guard that suppressed scrolling
 * whenever a selection existed is what stranded the histogram at offset
 * 0, and this must not repeat the trick.
 *
 * That one rule also settles the manual-scroll conflict with no timer
 * and no "user is scrolling" flag: while the current item is comfortably
 * in view this returns null, so a scroll the user made by hand stays
 * exactly where they put it. It intervenes only when the item you are
 * actually on has reached the edge.
 *
 * The impure partner is the strip in `screens/DeckScreen.tsx`, which
 * records the live offset and calls `scrollTo`.
 */

export interface StripGeometry {
  /** Distance from one item's left edge to the next: item + gap. */
  pitch: number;
  /** The item's own width. */
  size: number;
  /** Padding before the first item. */
  leadingInset: number;
  /** Visible width of the strip. */
  viewport: number;
  /** Total scrollable content width. */
  content: number;
}

/**
 * How much of a neighbour stays visible past the current item: a whole
 * item's worth.
 *
 * This is what makes the strip move BEFORE the current thumbnail would
 * leave the viewport rather than after — the next thumbnail is already
 * on screen when you swipe onto it, so the strip never lurches at the
 * moment you need to read it.
 */
export const STRIP_LEAD = 1;

/**
 * The offset the strip should scroll to so item `index` is visible with
 * a lead — or **null** when no scroll is needed, which is the case that
 * leaves a manual scroll alone.
 *
 * Degenerate geometry (an unmeasured strip, content that fits) returns
 * null: there is nothing to scroll, and guessing an offset from a zero
 * viewport would jump the strip on first layout.
 */
export function stripScrollOffset(
  index: number,
  offset: number,
  geometry: StripGeometry,
): number | null {
  const { pitch, size, leadingInset, viewport, content } = geometry;
  if (index < 0 || pitch <= 0 || viewport <= 0) return null;
  if (content <= viewport) return null;

  const maxOffset = content - viewport;
  const start = leadingInset + index * pitch;
  const end = start + size;
  // Clamped to what the viewport can actually hold: on a strip barely
  // wider than one thumbnail a full lead at both ends would exceed the
  // viewport, and the two bounds would then fight every frame. At this
  // ceiling the bounds meet exactly, which centres the item.
  const lead = Math.min(STRIP_LEAD * pitch, Math.max(0, (viewport - size) / 2));

  // The window of offsets that show the item with its lead. `low <= high`
  // always holds: the gap between them is viewport - size - 2 * lead,
  // and the clamp above is exactly what keeps that non-negative.
  const low = clamp(end + lead - viewport, 0, maxOffset);
  const high = clamp(start - lead, 0, maxOffset);

  const target = clamp(offset, low, high);
  // A sub-pixel difference is not a scroll; it is a re-render loop.
  return Math.abs(target - offset) < 1 ? null : target;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
