/**
 * The immersive flip's geometry (m0.9.1 phase 4, pure): the photo stays
 * on screen and glides between the framed stage and the edge-to-edge
 * one. The deck commits the new layout at once and transforms the whole
 * stage so that the photo APPEARS on a path from where it was to where
 * the new layout puts it; the path's end is re-measured as layouts land,
 * so the transform is the identity the moment the flight is over.
 *
 * Every rect is in window coordinates, {x, y, w, h}. The photo's rect
 * inside a stage box is the contain fit of its aspect (w / h; 0 while
 * unknown, which fills the box). The transform is the one React Native
 * applies — translate, then scale about the view's own centre — so a
 * point p of the wrapper lands at C + s·(p − C) + t.
 *
 * Worklet-safe by construction: plain arithmetic on plain objects, no
 * closures over JS state, so `useAnimatedStyle` can call these on the
 * UI thread (the directive is on each function).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlightTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** The contain fit of `aspect` (w / h) centred in `box`; aspect 0 fills. */
export function fitRect(aspect: number, box: Rect): Rect {
  'worklet';
  if (!(aspect > 0) || box.w <= 0 || box.h <= 0) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const boxAspect = box.w / box.h;
  const w = aspect >= boxAspect ? box.w : box.h * aspect;
  const h = aspect >= boxAspect ? box.w / aspect : box.h;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  'worklet';
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/**
 * The transform on `wrapper` that shows the photo the layout placed at
 * `layout` as if it were at `visual`: a uniform scale (the two rects
 * share the photo's aspect) about the wrapper's centre, then a
 * translation that aligns the photo's centres. Identity when the layout
 * already matches, or when the layout rect is degenerate.
 */
export function flightTransform(layout: Rect, wrapper: Rect, visual: Rect): FlightTransform {
  'worklet';
  if (layout.w <= 0 || layout.h <= 0 || wrapper.w <= 0 || wrapper.h <= 0)
    return { scale: 1, tx: 0, ty: 0 };
  const scale = visual.w / layout.w;
  const cx = wrapper.x + wrapper.w / 2;
  const cy = wrapper.y + wrapper.h / 2;
  const lx = layout.x + layout.w / 2;
  const ly = layout.y + layout.h / 2;
  const vx = visual.x + visual.w / 2;
  const vy = visual.y + visual.h / 2;
  return { scale, tx: vx - cx - scale * (lx - cx), ty: vy - cy - scale * (ly - cy) };
}

/** The flight's easing: a standard ease-in-out, so the photo leaves and
 * arrives without a jolt. */
export function flightEase(t: number): number {
  'worklet';
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** How long the flight runs, both ways. */
export const FLIGHT_MS = 280;
