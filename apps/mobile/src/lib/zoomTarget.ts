/**
 * Zoom pan-bound + double-tap target math (pure). Panning a zoomed photo
 * is clamped to the photo's OWN rendered edges (`panBounds`), not the
 * stage rectangle: an edge never crosses into the viewport while the
 * scaled photo exceeds the stage on that axis, and a photo smaller than
 * the stage on an axis stays centred there — the standard photo-viewer
 * behavior, and what keeps a deep zoom from wandering off its content.
 * A double tap zooms to DOUBLE_TAP_ZOOM_SCALE about the tapped point
 * (tx = -(x - W/2) · (s - 1)), clamped to those same bounds.
 *
 * The impure partners live in the screens: DeckScreen / PhotoViewer wire
 * this into their gesture worklets and page Pressables (the double-tap
 * Pressable arbitration is the shared hook
 * components/useDoubleTapZoom.ts) — taps stay off
 * Gesture.Tap because a gesture worklet may not cross the worklets→JS
 * bridge (see DeckScreen's bridge comment), while writing shared values
 * FROM JS (the double-tap zoom, the onLoad aspect) is the safe
 * direction.
 */

/** One double-tap window for every surface that arbitrates single vs
 * double taps in JS — matches RNGH's own default maxDelay. */
export const DOUBLE_TAP_MS = 300;

/** Where a double tap lands the zoom — deep enough to read detail, well
 * under the pinch ceiling (MAX_SCALE 16). */
export const DOUBLE_TAP_ZOOM_SCALE = 2.5;

/**
 * How far a pinch must open or close before it is allowed to change the
 * zoom at all — a fraction of the finger distance at gesture start.
 *
 * Pan and pinch are deliberately SIMULTANEOUS (you may drag a photo
 * while resizing it), and the pan takes two fingers so a zoomed photo
 * can be shoved around with both thumbs. The cost is that two thumbs
 * dragging fast never hold their separation exactly, and every wobble
 * reached the pinch as a scale change: panning a fully-zoomed photo
 * quietly zoomed it back out (Tristan, S23 pass 2026-08-04).
 *
 * So a pinch must first prove itself. Below this delta the gesture is
 * treated as pan noise and the scale is left alone; once past it, the
 * zoom follows the fingers from THAT moment (`pinchGain`), so crossing
 * the threshold does not jump the photo by the threshold's worth.
 */
export const PINCH_ENGAGE_DELTA = 0.15;

/** Has this pinch moved far enough to count as a deliberate zoom? */
export function pinchEngaged(rawScale: number): boolean {
  'worklet';
  return Math.abs(rawScale - 1) >= PINCH_ENGAGE_DELTA;
}

/** The zoom factor to apply, measured from where the pinch engaged
 * rather than from where the fingers first landed. `base` is the raw
 * gesture scale at the engaging frame. */
export function pinchGain(rawScale: number, base: number): number {
  'worklet';
  return base === 0 ? 1 : rawScale / base;
}

/** Pan bounds at `scale` for a contain-fit photo of aspect `aspect`
 * (width / height, from the image's onLoad) centred in a stage of
 * stageW × stageH. Axis bound: (rendered · scale − stage) / 2, floored
 * at 0 — a photo smaller than the stage cannot be panned on that axis.
 * Aspect 0 (not yet loaded) falls back to the stage-rectangle bounds. */
export function panBounds(
  stageW: number,
  stageH: number,
  aspect: number,
  scale: number,
): { maxX: number; maxY: number } {
  'worklet';
  if (aspect <= 0) {
    return { maxX: (stageW * (scale - 1)) / 2, maxY: (stageH * (scale - 1)) / 2 };
  }
  const renderedW = Math.min(stageW, stageH * aspect);
  const renderedH = Math.min(stageH, stageW / aspect);
  return {
    maxX: Math.max(0, (renderedW * scale - stageW) / 2),
    maxY: Math.max(0, (renderedH * scale - stageH) / 2),
  };
}

/** Translation that keeps the tapped point (x, y) stationary while the
 * stage (width × height) scales about its centre, clamped to the pan
 * bounds of the target scale.
 * Not 'worklet'-annotated: JS-only today (page Pressables) — annotate it
 * before ever calling it from a gesture worklet. */
export function doubleTapZoomTarget(
  x: number,
  y: number,
  width: number,
  height: number,
  aspect: number,
  scale: number = DOUBLE_TAP_ZOOM_SCALE,
): { tx: number; ty: number } {
  const { maxX, maxY } = panBounds(width, height, aspect, scale);
  // `+ 0` normalises the negation's -0 for a centre tap.
  const clamp = (value: number, max: number) => Math.min(max, Math.max(-max, value)) + 0;
  return {
    tx: clamp(-(x - width / 2) * (scale - 1), maxX),
    ty: clamp(-(y - height / 2) * (scale - 1), maxY),
  };
}
