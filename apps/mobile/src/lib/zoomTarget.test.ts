import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_ZOOM_SCALE,
  ZOOM_TRACKING_START,
  doubleTapZoomTarget,
  panBounds,
  touchFocal,
  touchSpan,
  zoomTouchFrame,
  type PanTouch,
  type ZoomTracking,
} from './zoomTarget';

const at = (x: number, y: number): PanTouch => ({ x, y });

// The panBounds/double-tap fixtures: a 1000×800 stage showing a 2:1
// panorama (1000×500 rendered).
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

describe('touchFocal', () => {
  it('one touch is its own focal', () => {
    expect(touchFocal([at(120, 340)])).toEqual({ x: 120, y: 340 });
  });

  it('two touches average', () => {
    expect(touchFocal([at(100, 200), at(300, 100)])).toEqual({ x: 200, y: 150 });
  });

  it('an empty list returns the origin (never translated from)', () => {
    expect(touchFocal([])).toEqual({ x: 0, y: 0 });
  });
});

describe('touchSpan', () => {
  it('is the first-pair distance with two-plus fingers, 0 otherwise', () => {
    expect(touchSpan([])).toBe(0);
    expect(touchSpan([at(10, 10)])).toBe(0);
    expect(touchSpan([at(0, 0), at(300, 400)])).toBe(500);
  });
});

describe('zoomTouchFrame (the ONE pinch-pan tracker, m0.8.8)', () => {
  const CX = 540;
  const CY = 1140;
  const MIN = 1;
  const MAX = 48;

  /** Feed frames through, carrying tracking + transform like the
   * worklet does. `active` defaults to true. */
  function play(
    frames: { touches: PanTouch[]; active?: boolean }[],
    start = { scale: 1, tx: 0, ty: 0 },
  ) {
    let tracking: ZoomTracking = ZOOM_TRACKING_START;
    let { scale, tx, ty } = start;
    const moved: boolean[] = [];
    for (const frame of frames) {
      const step = zoomTouchFrame(
        tracking,
        frame.touches,
        frame.active ?? true,
        scale,
        tx,
        ty,
        MIN,
        MAX,
        CX,
        CY,
      );
      tracking = step.tracking;
      moved.push(step.transform !== null);
      if (step.transform !== null) {
        scale = step.transform.scale;
        tx = step.transform.x;
        ty = step.transform.y;
      }
    }
    return { scale, tx, ty, tracking, moved };
  }

  it('the first frame anchors and moves nothing, wherever the photo is', () => {
    const r = play([{ touches: [at(400, 300)] }], { scale: 3, tx: 42, ty: -7 });
    expect(r.moved).toEqual([false]);
    expect(r.scale).toBe(3);
    expect(r.tx).toBe(42);
  });

  it('a single-finger drag translates by the focal delta and never scales', () => {
    const r = play([{ touches: [at(400, 300)] }, { touches: [at(430, 280)] }], {
      scale: 4,
      tx: 0,
      ty: 0,
    });
    expect(r.scale).toBe(4); // quick-scale immunity by construction
    expect(r.tx).toBeCloseTo(30, 6);
    expect(r.ty).toBeCloseTo(-20, 6);
  });

  it('a symmetric spread scales about the pinch focal — content under it locked', () => {
    // Two fingers centred on F=(640,1000), spread 200 → 400.
    const r = play(
      [{ touches: [at(540, 1000), at(740, 1000)] }, { touches: [at(440, 1000), at(840, 1000)] }],
      { scale: 2, tx: 100, ty: -50 },
    );
    expect(r.scale).toBeCloseTo(4, 6);
    // t' = F − c − (s'/s)(F − c − t): the content point under the focal
    // is identical before and after.
    const pBefore = (640 - CX - 100) / 2;
    const pAfter = (640 - CX - r.tx) / 4;
    expect(pAfter).toBeCloseTo(pBefore, 6);
  });

  it('zoom out then in without lifting returns exactly to the start', () => {
    const r = play(
      [
        { touches: [at(440, 1000), at(840, 1000)] }, // anchor, span 400
        { touches: [at(540, 1000), at(740, 1000)] }, // span 200: out to 6
        { touches: [at(440, 1000), at(840, 1000)] }, // span 400: back in
      ],
      { scale: 12, tx: 300, ty: 200 },
    );
    expect(r.scale).toBeCloseTo(12, 6);
    expect(r.tx).toBeCloseTo(300, 6);
    expect(r.ty).toBeCloseTo(200, 6);
  });

  it('a finger landing re-anchors: the same focal+span holds everything still', () => {
    const r = play([
      { touches: [at(400, 300)] },
      { touches: [at(450, 300)] }, // tx 50
      { touches: [at(450, 300), at(550, 300)] }, // lands: re-anchor
      { touches: [at(450, 300), at(550, 300)] }, // held: identity
    ]);
    expect(r.moved).toEqual([false, true, false, true]);
    expect(r.tx).toBeCloseTo(50, 6);
    expect(r.scale).toBe(1);
  });

  it('a whole alternating-thumb walk stays continuous', () => {
    // Land A, drag; land B (re-anchor); both drag; lift A (re-anchor);
    // B drags on. Translation accumulates smoothly: 40 + 30 + 25.
    const r = play(
      [
        { touches: [at(400, 300)] },
        { touches: [at(440, 300)] }, // +40
        { touches: [at(440, 300), at(540, 300)] }, // land: re-anchor
        { touches: [at(470, 300), at(570, 300)] }, // both +30
        { touches: [at(570, 300)] }, // lift: re-anchor
        { touches: [at(595, 300)] }, // +25
      ],
      { scale: 5, tx: 0, ty: 0 },
    );
    expect(r.tx).toBeCloseTo(95, 4);
    expect(r.scale).toBeCloseTo(5, 2); // parallel drag: span constant
  });

  it('clamps the scale and anchors the translation to the CLAMPED value', () => {
    const r = play(
      [
        { touches: [at(530, 1140), at(550, 1140)] }, // span 20
        { touches: [at(340, 1140), at(740, 1140)] }, // span 400: ×20 → clamp 48
      ],
      { scale: 40, tx: 0, ty: 0 },
    );
    expect(r.scale).toBe(48);
    // stretch uses 48/40, not the raw ratio — the focal stays coherent.
    expect(r.tx).toBeCloseTo(540 - CX - (48 / 40) * (540 - CX - 0), 6);
  });

  it('marks the stream zoomed only on material scale change', () => {
    const steady = play(
      [
        { touches: [at(500, 1000), at(700, 1000)] },
        { touches: [at(501, 1000), at(701, 1000)] }, // span ~constant
      ],
      { scale: 4, tx: 0, ty: 0 },
    );
    expect(steady.tracking.zoomed).toBe(false);
    const pinched = play(
      [
        { touches: [at(500, 1000), at(700, 1000)] },
        { touches: [at(450, 1000), at(750, 1000)] }, // span 200 → 300
      ],
      { scale: 4, tx: 0, ty: 0 },
    );
    expect(pinched.tracking.zoomed).toBe(true);
  });

  it('inactive frames re-anchor continuously and never move', () => {
    const r = play(
      [
        { touches: [at(400, 300)], active: false },
        { touches: [at(500, 350)], active: false },
        { touches: [at(500, 350)] }, // becomes active: anchors HERE
        { touches: [at(520, 350)] }, // +20 from the fresh anchor
      ],
      { scale: 3, tx: 10, ty: 0 },
    );
    expect(r.tx).toBeCloseTo(30, 6);
  });
});
