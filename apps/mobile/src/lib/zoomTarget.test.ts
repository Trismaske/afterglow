import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_ZOOM_SCALE,
  doubleTapZoomTarget,
  PAN_TRACKING_START,
  panBounds,
  panFrame,
  PINCH_ENGAGE_DELTA,
  PINCH_TRACKING_START,
  pinchEngaged,
  pinchFrame,
  pinchGain,
  touchFocal,
  type PanTouch,
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

describe('pinchFrame', () => {
  /** Feed frames through, carrying the tracking like the worklet does. */
  function play(frames: [raw: number, pointers: number][], startScale = 4) {
    let tracking = PINCH_TRACKING_START;
    let scale = startScale;
    for (const [raw, pointers] of frames) {
      const step = pinchFrame(tracking, raw, pointers, scale);
      tracking = step.tracking;
      if (step.scale !== null) scale = step.scale;
    }
    return { scale, tracking };
  }

  it('leaves the zoom alone on the first frame, whatever it reports', () => {
    // The first frame always re-anchors (tracking starts at 0 pointers),
    // so a pinch that activates mid-gesture cannot yank the photo.
    expect(play([[3.7, 2]]).scale).toBe(4);
  });

  it('holds the zoom while two fingers RUN across the photo', () => {
    // The reported defect: fingers landing and lifting alternately while
    // panning a zoomed photo. Each pointer change swings the measured
    // distance wildly with no zoom intended — here 2→1→2→1 pointers with
    // the raw scale lurching each time. The zoom must not move.
    const { scale } = play([
      [1, 2],
      [0.4, 1],
      [2.6, 2],
      [0.3, 1],
      [3.1, 2],
      [0.5, 1],
    ]);
    expect(scale).toBe(4);
  });

  it('does not jump when the pinch crosses the engage threshold', () => {
    // The engaging frame re-anchors instead of applying its own delta —
    // the PINCH_ENGAGE_DELTA no-jump rule, kept over the drafted
    // design's exact tracking (which snapped by the threshold's worth).
    const { scale, tracking } = play([
      [1, 2],
      [1.2, 2],
    ]);
    expect(scale).toBe(4);
    expect(tracking.live).toBe(true);
  });

  it('zooms when the same fingers deliberately open', () => {
    // Anchor at 4×, engage at 1.16 — just PAST the 0.15 threshold,
    // which has no exact binary form (see the engagement suite) —
    // re-anchoring at 4×; then the fingers double their engaged
    // separation and the zoom doubles.
    const { scale } = play([
      [1, 2],
      [1.16, 2],
      [2.32, 2],
    ]);
    expect(scale).toBeCloseTo(8, 10);
  });

  it('resumes zooming from where a finger change left the photo', () => {
    // Zoom to 8×, lose a finger, regain it, re-prove the pinch (each
    // stretch engages on its own), then open to double: the resumed
    // pinch builds on 8×, not on the original 4×.
    const { scale } = play([
      [1, 2],
      [1.16, 2],
      [2.32, 2],
      [1.4, 1],
      [0.9, 2],
      [1.8, 2], // 2× past the new anchor — re-engages, no jump
      [3.6, 2], // 2× past the ENGAGED anchor — now it zooms
    ]);
    expect(scale).toBeCloseTo(16, 10);
  });

  it('a finger change ENDS the engagement — the next stretch re-proves it', () => {
    // The round-3 drift: with engagement persisting, a finger-walk's
    // two-finger overlap windows still zoomed (their span genuinely
    // changes while the hand travels). Every stretch starts as pan
    // noise now.
    const { scale, tracking } = play([
      [1, 2],
      [1.16, 2],
      [2.32, 2], // proven pinch, 8×
      [1.4, 1], // finger lifts — engagement ends
      [0.9, 2], // finger relands: an overlap window opens
      [0.95, 2], // the hand travels; span wobbles under the threshold
      [0.85, 2],
    ]);
    expect(tracking.live).toBe(false);
    expect(scale).toBeCloseTo(8, 10);
  });

  it('never zooms on single-finger frames, even at a stable pointer count', () => {
    // The measured S10e ratchet (§10 check 9, round 2): the platform
    // detector's quick-scale reads walking fingers as a double tap and
    // then reports CONTINUOUS scale changes with one finger down — no
    // pointer-count change for the re-anchor rule to catch. Pointer
    // counts below two re-anchor every frame instead.
    const { scale } = play([
      [1, 2],
      [1.16, 2],
      [2.32, 2],
      [1.4, 1],
      [2.8, 1],
      [5.6, 1],
    ]);
    expect(scale).toBeCloseTo(8, 10);
  });

  it('cannot even ENGAGE from single-finger frames', () => {
    // A gesture that was never a two-finger pinch must not become one
    // through quick-scale's reported changes.
    const { scale, tracking } = play([
      [1, 1],
      [1.5, 1],
      [3, 1],
    ]);
    expect(scale).toBe(4);
    expect(tracking.live).toBe(false);
  });
});

/** Shorthand: a touch at (x, y) in window coordinates. */
function at(x: number, y: number): PanTouch {
  return { absoluteX: x, absoluteY: y };
}

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

describe('panFrame (the touch-position walking pan, m0.8.6 §10)', () => {
  const MAX = { x: 500, y: 100 };

  /** Feed touch frames through, carrying tracking + translation like
   * the worklet does. `panning` defaults to true. */
  function play(frames: { touches: PanTouch[]; panning?: boolean }[], start = { tx: 0, ty: 0 }) {
    let tracking = PAN_TRACKING_START;
    let tx = start.tx;
    let ty = start.ty;
    const moved: boolean[] = [];
    for (const frame of frames) {
      const step = panFrame(tracking, frame.touches, frame.panning ?? true, tx, ty, MAX.x, MAX.y);
      tracking = step.tracking;
      moved.push(step.translation !== null);
      if (step.translation !== null) {
        tx = step.translation.x;
        ty = step.translation.y;
      }
    }
    return { tx, ty, tracking, moved };
  }

  it('the first frame anchors and moves nothing, wherever the photo is', () => {
    const { tx, ty, moved } = play([{ touches: [at(400, 300)] }], { tx: 42, ty: -7 });
    expect(moved).toEqual([false]);
    expect(tx).toBe(42);
    expect(ty).toBe(-7);
  });

  it('a single-finger drag translates by the focal delta', () => {
    const { tx, ty } = play([{ touches: [at(400, 300)] }, { touches: [at(430, 280)] }]);
    expect(tx).toBe(30);
    expect(ty).toBe(-20);
  });

  it('clamps to the pan bounds', () => {
    const { tx, ty } = play([{ touches: [at(0, 0)] }, { touches: [at(900, 250)] }]);
    expect(tx).toBe(MAX.x);
    expect(ty).toBe(MAX.y);
  });

  it('re-anchors on a finger LANDING: the same focal yields the same tx', () => {
    // The walking-pan defect's first half. Drag one finger 50 right,
    // then a second lands — the focal leaps from (450,300) to the pair's
    // mean (500,300). The re-anchor frame must not move the photo, and
    // holding that new focal must hold the translation.
    const { tx, moved } = play([
      { touches: [at(400, 300)] },
      { touches: [at(450, 300)] }, // tx 50
      { touches: [at(450, 300), at(550, 300)] }, // lands: re-anchor, no move
      { touches: [at(450, 300), at(550, 300)] }, // same focal → same tx
    ]);
    expect(moved).toEqual([false, true, false, true]);
    expect(tx).toBe(50);
  });

  it('re-anchors on a finger LIFTING, then continues from the new anchor', () => {
    // The other half: two fingers drag together, one lifts (the focal
    // leaps to the survivor), and the survivor keeps dragging. The
    // translation carries straight through 60 → 60 → 90.
    const { tx, moved } = play([
      { touches: [at(400, 300), at(500, 300)] },
      { touches: [at(460, 300), at(560, 300)] }, // tx 60
      { touches: [at(560, 300)] }, // lifts: re-anchor, no move
      { touches: [at(590, 300)] }, // survivor drags on: 60 + 30
    ]);
    expect(moved).toEqual([false, true, false, true]);
    expect(tx).toBe(90);
  });

  it('a whole alternating-thumb walk stays continuous', () => {
    // The reported defect end to end: thumbs alternately landing and
    // lifting while the photo pans left. Every set change re-anchors,
    // every stable frame adds its own focal delta — the sum, never a
    // jump from the averaged point moving.
    const { tx } = play([
      { touches: [at(600, 300)] },
      { touches: [at(560, 300)] }, // -40
      { touches: [at(560, 300), at(700, 320)] }, // lands
      { touches: [at(520, 300), at(660, 320)] }, // -40
      { touches: [at(660, 320)] }, // lifts
      { touches: [at(640, 320)] }, // -20
    ]);
    expect(tx).toBe(-100);
  });

  it('frames before the pan activates re-anchor continuously — no jump at activation', () => {
    // While `panning` is false (gesture not yet ACTIVE, or not zoomed)
    // the anchor follows the fingers, so the first panning frame
    // measures from the previous frame's focal, not from touch-down.
    const { tx, moved } = play([
      { touches: [at(400, 300)], panning: false },
      { touches: [at(470, 300)], panning: false }, // drifts un-anchored
      { touches: [at(480, 300)] }, // activates: only its own delta
    ]);
    expect(moved).toEqual([false, false, true]);
    expect(tx).toBe(10);
  });

  it('a zero-touch frame re-anchors instead of averaging nothing', () => {
    const { tx, tracking } = play([
      { touches: [at(400, 300)] },
      { touches: [at(450, 300)] },
      { touches: [] },
    ]);
    expect(tx).toBe(50);
    expect(tracking.pointers).toBe(0);
  });
});
