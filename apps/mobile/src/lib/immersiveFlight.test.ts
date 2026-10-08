import { describe, expect, it } from 'vitest';
import { fitRect, flightEase, flightTransform, lerpRect, type Rect } from './immersiveFlight';

const box: Rect = { x: 13, y: 100, w: 334, h: 500 };

describe('fitRect (the photo inside its stage box)', () => {
  it('fits a landscape photo to the width, centred vertically', () => {
    const r = fitRect(4 / 3, box);
    expect(r.w).toBeCloseTo(334);
    expect(r.h).toBeCloseTo(250.5);
    expect(r.x).toBe(13);
    expect(r.y).toBeCloseTo(100 + (500 - 250.5) / 2);
  });
  it('fits a portrait photo to the height, centred horizontally', () => {
    // 3:4 is still wider than this 334×500 box (0.668), so it is
    // width-bound; 1:2 is taller than the box and takes the height.
    const r = fitRect(1 / 2, box);
    expect(r.h).toBe(500);
    expect(r.w).toBeCloseTo(250);
    expect(r.x).toBeCloseTo(13 + (334 - 250) / 2);
    // Wider than the box is impossible: the fit picks the limiting side.
    const tall = fitRect(1 / 3, box);
    expect(tall.w).toBeCloseTo(500 / 3);
    expect(tall.x).toBeCloseTo(13 + (334 - 500 / 3) / 2);
  });
  it('fills the box while the aspect is unknown', () => {
    expect(fitRect(0, box)).toEqual(box);
  });
});

describe('flightTransform (show the laid-out photo where the path says)', () => {
  const wrapper: Rect = { x: 0, y: 80, w: 360, h: 600 };
  it('is the identity when the visual rect is the layout rect', () => {
    const layout = fitRect(4 / 3, box);
    expect(flightTransform(layout, wrapper, layout)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
  it('maps the framed photo onto the edge-to-edge one', () => {
    const layout = fitRect(4 / 3, box); // the framed rect
    const visual = fitRect(4 / 3, { x: 0, y: 0, w: 360, h: 780 }); // immersive
    const t = flightTransform(layout, wrapper, visual);
    expect(t.scale).toBeCloseTo(360 / 334);
    // A point at the layout photo's centre lands on the visual centre.
    const cx = wrapper.x + wrapper.w / 2;
    const cy = wrapper.y + wrapper.h / 2;
    const lx = layout.x + layout.w / 2;
    const ly = layout.y + layout.h / 2;
    expect(cx + t.scale * (lx - cx) + t.tx).toBeCloseTo(visual.x + visual.w / 2);
    expect(cy + t.scale * (ly - cy) + t.ty).toBeCloseTo(visual.y + visual.h / 2);
  });
  it('is the identity on a degenerate layout (nothing measured yet)', () => {
    expect(
      flightTransform({ x: 0, y: 0, w: 0, h: 0 }, wrapper, { x: 0, y: 0, w: 10, h: 10 }),
    ).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
});

describe('lerpRect and flightEase', () => {
  it('interpolates every edge and clamps the easing', () => {
    const a: Rect = { x: 0, y: 0, w: 100, h: 50 };
    const b: Rect = { x: 10, y: 20, w: 200, h: 150 };
    expect(lerpRect(a, b, 0.5)).toEqual({ x: 5, y: 10, w: 150, h: 100 });
    expect(flightEase(0)).toBe(0);
    expect(flightEase(1)).toBe(1);
    expect(flightEase(0.5)).toBeCloseTo(0.5);
    expect(flightEase(-1)).toBe(0);
    expect(flightEase(2)).toBe(1);
  });
});
