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
 * this into their gesture worklets and page Pressables — taps stay off
 * Gesture.Tap because a gesture worklet may not cross the worklets→JS
 * bridge (see DeckScreen's bridge comment), while writing shared values
 * FROM JS (the double-tap zoom, the onLoad aspect) is the safe
 * direction.
 */

/** One double-tap window for every surface that arbitrates single vs
 * double taps in JS — matches RNGH's own default maxDelay. */
export const DOUBLE_TAP_MS = 300;

/** Where a double tap lands the zoom — deep enough to read detail, well
 * under the pinch ceiling (MAX_SCALE 8). */
export const DOUBLE_TAP_ZOOM_SCALE = 2.5;

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
 * bounds of the target scale. */
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
