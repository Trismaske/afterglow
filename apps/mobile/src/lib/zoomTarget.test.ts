import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_ZOOM_SCALE,
  doubleTapZoomTarget,
  panBounds,
  PINCH_ENGAGE_DELTA,
  pinchEngaged,
  pinchGain,
} from './zoomTarget';

// A 2:1 panorama contain-fit in a 1000×800 stage renders 1000×500 — the
// numbers below are exact, so the assertions stay honest.
const W = 1000;
const H = 800;
const PANO = 2;

describe('panBounds', () => {
  it('clamps to the photo’s rendered edges, not the stage rectangle', () => {
    // 1000×500 rendered at 2× → 2000×1000 against a 1000×800 stage.
    expect(panBounds(W, H, PANO, 2)).toEqual({ maxX: 500, maxY: 100 });
  });

  it('pins an axis where the scaled photo is smaller than the stage', () => {
    // 500 px rendered height at 1.2× = 600 < 800 → vertically centred.
    expect(panBounds(W, H, PANO, 1.2)).toEqual({ maxX: 100, maxY: 0 });
  });

  it('falls back to stage-rect bounds while the aspect is unknown (0)', () => {
    expect(panBounds(W, H, 0, 2.5)).toEqual({ maxX: 750, maxY: 600 });
  });
});

describe('doubleTapZoomTarget', () => {
  it('a centre tap zooms in place', () => {
    expect(doubleTapZoomTarget(W / 2, H / 2, W, H, PANO)).toEqual({ tx: 0, ty: 0 });
  });

  it('keeps an off-centre point stationary: tx = -(x - W/2)·(s - 1)', () => {
    // 100 px right of centre at 2.5× → the stage shifts 150 px left,
    // inside the pano's maxX of (1000·2.5 − 1000)/2 = 750.
    const { tx, ty } = doubleTapZoomTarget(W / 2 + 100, H / 2, W, H, PANO);
    expect(tx).toBe(-100 * (DOUBLE_TAP_ZOOM_SCALE - 1));
    expect(ty).toBe(0);
  });

  it('clamps to the content bounds, not the stage’s', () => {
    // A top-edge tap wants ty = 400·1.5 = 600, but the pano's rendered
    // height at 2.5× (1250) only allows (1250 − 800)/2 = 225.
    const { ty } = doubleTapZoomTarget(W / 2, 0, W, H, PANO);
    expect(ty).toBe(225);
  });

  it('an explicit scale changes both the shift and its bounds', () => {
    expect(doubleTapZoomTarget(W / 2 + 100, H / 2, W, H, PANO, 2)).toEqual({ tx: -100, ty: 0 });
  });
});

describe('pinch engagement', () => {
  it('ignores the wobble of two fingers dragging a zoomed photo', () => {
    expect(pinchEngaged(1.0)).toBe(false);
    expect(pinchEngaged(0.95)).toBe(false);
    expect(pinchEngaged(1.05)).toBe(false);
  });

  it('engages once the fingers deliberately open or close', () => {
    // Just PAST the threshold on both sides, never exactly on it: 0.15
    // has no exact binary form, so an equality assertion would be
    // testing float representation rather than the rule.
    expect(pinchEngaged(1 + PINCH_ENGAGE_DELTA + 0.01)).toBe(true);
    expect(pinchEngaged(1 - PINCH_ENGAGE_DELTA - 0.01)).toBe(true);
  });

  it('measures the zoom from the anchor, so crossing does not jump', () => {
    expect(pinchGain(1.15, 1.15)).toBe(1);
    expect(pinchGain(2.3, 1.15)).toBeCloseTo(2, 10);
    expect(pinchGain(1.5, 0)).toBe(1);
  });
});
