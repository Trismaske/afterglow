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
 * The whole pinch-pan is ONE tracker (`zoomTouchFrame`, m0.8.8): scale
 * from the raw finger span, translation from the raw focal, both off a
 * single anchor taken at every touch-set change — the standard
 * one-anchor model (react-native-zoom-toolkit's pinchTransform; the
 * library itself cannot mount under this app's detector and worklet
 * constraints, so its algebra lives here). Its header carries the
 * rationale and the formulas.
 *
 * The impure partners live in the screens: DeckScreen / PhotoViewer /
 * CompareScreen wire this into their gesture worklets and page
 * Pressables (the double-tap Pressable arbitration is the shared hook
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
 * under every photo's dynamic pinch ceiling (lib/regionZoom.ts). */
export const DOUBLE_TAP_ZOOM_SCALE = 2.5;

/** Release velocities (dp/s) below this start NO decay glide: a
 * hold-then-lift must leave the photo exactly where the finger left it
 * (S10e video 16's "little nudge on release" — RNGH's averaged-pointer
 * velocity tracker emits noise at lift-off, and a few dp/s of it reads
 * as the photo moving on its own). Real flicks measure hundreds to
 * thousands of dp/s, so the dead-band never eats one. Per-axis, so a
 * clean horizontal flick keeps its momentum even with a noisy Y. */
export const FLICK_MIN_VELOCITY = 150;

/** The slice of RNGH's TouchData the gesture math reads. VIEW-LOCAL
 * x/y deliberately (S10e video 12): the anchor formula subtracts the
 * stage centre from the focal, so both MUST share an origin — window
 * coordinates put the stage's window offset into the translation,
 * scaled by (stretch − 1): pans were perfect (r = 1 cancels it) while
 * every zoom-in drifted the photo downward by the header's height
 * worth of error. View-local is safe here because every zoom gesture
 * attaches to an UNTRANSFORMED view (the stage, or the overlay's
 * untransformed backdrop — the photo transforms INSIDE them), so the
 * coordinates are stable under a motionless finger. Never attach these
 * gestures to the transformed layer: there view-local x/y move with
 * the photo they drive — a feedback loop. */
export type PanTouch = { x: number; y: number };

/** The mean touch position (view-local) — the gesture's focal point.
 * One touch is its own focal. An empty list returns the origin; callers
 * never act on it (`zoomTouchFrame` re-anchors on a zero-touch frame). */
export function touchFocal(touches: readonly PanTouch[]): { x: number; y: number } {
  'worklet';
  if (touches.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const touch of touches) {
    x += touch.x;
    y += touch.y;
  }
  return { x: x / touches.length, y: y / touches.length };
}

/** The distance between the first two touches — the pinch span. Fewer
 * than two fingers have no span (0): scale holds, which is what makes
 * the platform quick-scale ratchet (single-finger scale reports)
 * impossible by construction. */
export function touchSpan(touches: readonly PanTouch[]): number {
  'worklet';
  if (touches.length < 2) return 0;
  const dx = touches[0].x - touches[1].x;
  const dy = touches[0].y - touches[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * ONE tracker for the whole pinch-pan (m0.8.8 — the unification).
 *
 * The previous design ran TWO trackers: a pinch tracker owning scale
 * and a pan tracker owning translation, each with its own anchors,
 * activation state, and reset rules that had to agree. They did not:
 * whether a pinch was focal-anchored depended on whether the PAN
 * gesture had happened to activate (S10e video 11 — "sometimes it
 * zooms to my fingers, sometimes it strays"). This is the standard
 * one-anchor model instead (react-native-zoom-toolkit's pinchTransform
 * — the library itself cannot mount under this app's detector and
 * worklet constraints, so its algebra lives here):
 *
 *   r = span / anchorSpan          (1 with fewer than two fingers)
 *   s = clamp(anchorScale · r)
 *   t = F − c − (s / anchorScale) · (F_a − c − anchorT)
 *
 * — every frame, from raw touches. Scale and translation can never
 * disagree because they share one anchor, taken at every touch-set
 * change (that re-anchor is also what keeps a two-thumb walking pan
 * continuous, and why a finger landing or lifting can never jump the
 * photo: at the re-anchor instant the formula is the identity).
 *
 * The old engagement gate (PINCH_ENGAGE_DELTA) is gone: it existed
 * because span wobble during a two-thumb shove drifted the zoom, but
 * with a shared anchor the content under the fingers stays LOCKED
 * whatever the span does — wobble breathes the scale a percent or two
 * without displacing anything. The device pass judges the breathing.
 */
export type ZoomTracking = {
  /** Touch count at the anchor; 0 = no anchor yet, the next frame
   * re-anchors (what onTouchesDown/onTouchesUp force). */
  pointers: number;
  /** The focal position (window coordinates) at the anchor. */
  focalX: number;
  focalY: number;
  /** The finger span at the anchor (0 = un-pinched anchor). */
  span: number;
  /** The transform when the anchor was taken. */
  baseScale: number;
  baseTx: number;
  baseTy: number;
  /** The stream materially changed the scale — its release is a pinch
   * end, never a flick (the deck's no-fling-after-zoom rule). */
  zoomed: boolean;
};

export const ZOOM_TRACKING_START: ZoomTracking = {
  pointers: 0,
  focalX: 0,
  focalY: 0,
  span: 0,
  baseScale: 1,
  baseTx: 0,
  baseTy: 0,
  zoomed: false,
};

/**
 * One touch frame in, the tracking to carry and the transform to show
 * out. `transform: null` = leave everything exactly where it is (a
 * re-anchor frame, or not active). The returned translation is
 * UNCLAMPED — the caller clamps to `panBounds` of the returned scale.
 * `cx`/`cy` are the stage centre; `minScale`/`maxScale` clamp the
 * scale before the translation is derived from it, so a clamped zoom
 * still anchors correctly.
 */
export function zoomTouchFrame(
  tracking: ZoomTracking,
  touches: readonly PanTouch[],
  active: boolean,
  scale: number,
  tx: number,
  ty: number,
  minScale: number,
  maxScale: number,
  cx: number,
  cy: number,
): { tracking: ZoomTracking; transform: { scale: number; x: number; y: number } | null } {
  'worklet';
  const focal = touchFocal(touches);
  const span = touchSpan(touches);
  const pointers = touches.length;
  if (!active || pointers === 0 || pointers !== tracking.pointers) {
    // Re-anchor: measure everything after from HERE, moving nothing now.
    return {
      tracking: {
        pointers,
        focalX: focal.x,
        focalY: focal.y,
        span,
        baseScale: scale,
        baseTx: tx,
        baseTy: ty,
        zoomed: tracking.zoomed,
      },
      transform: null,
    };
  }
  const ratio = tracking.span > 0 && span > 0 ? span / tracking.span : 1;
  const nextScale = Math.min(maxScale, Math.max(minScale, tracking.baseScale * ratio));
  const stretch = nextScale / tracking.baseScale;
  return {
    tracking:
      tracking.zoomed || Math.abs(nextScale - tracking.baseScale) > 0.02 * tracking.baseScale
        ? { ...tracking, zoomed: true }
        : tracking,
    transform: {
      scale: nextScale,
      x: focal.x - cx - stretch * (tracking.focalX - cx - tracking.baseTx),
      y: focal.y - cy - stretch * (tracking.focalY - cy - tracking.baseTy),
    },
  };
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
