import { describe, expect, it } from 'vitest';
import {
  BaseRetention,
  baseSample,
  containView,
  displaySize,
  maxScaleFor,
  patchSampleFor,
  planPatch,
  rectCovers,
  toDisplayRect,
  toSensorRect,
  visibleSourceRect,
} from './regionZoom';

// The real tiers the spike measured (S23 camera output, S10e stage).
const STAGE_W = 1080;
const STAGE_H = 2280;

describe('baseSample (D2)', () => {
  it('gives ordinary 12MP photos their full-resolution base — patches never engage', () => {
    // 4000/2 = 2000 < 3840, so no sample reaches the target: full res.
    expect(baseSample(4000, 3000, STAGE_H)).toEqual({ sample: 1, guardrailApplied: false });
  });

  it('lands 50MP-mode and 200MP-mode sources on ~4080', () => {
    expect(baseSample(8160, 4592, STAGE_H)).toEqual({ sample: 2, guardrailApplied: false }); // 4080
    expect(baseSample(16320, 9180, STAGE_H)).toEqual({ sample: 4, guardrailApplied: false }); // 4080
  });

  it('decodes the awkward 24MP bucket full-res — 96 MB passes the guardrail', () => {
    expect(baseSample(6000, 4000, STAGE_H)).toEqual({ sample: 1, guardrailApplied: false });
  });

  it('steps down once when full-res would breach the 128 MB guardrail', () => {
    // 7000×5250×4 = 147 MB > 128 MB; halves (3500) sit under the target.
    expect(baseSample(7000, 5250, STAGE_H)).toEqual({ sample: 2, guardrailApplied: true });
  });

  it('is device-adaptive: a >3840 px stage raises the target', () => {
    // Stage 4100: 8160/2 = 4080 < 4100, so full res — but 150 MB trips
    // the guardrail and steps down to 4080.
    expect(baseSample(8160, 4592, 4100)).toEqual({ sample: 2, guardrailApplied: true });
  });
});

describe('containView', () => {
  it('fits a landscape photo width-wise on a portrait stage, centred vertically', () => {
    const view = containView(STAGE_W, STAGE_H, 8160, 4592);
    expect(view.renderedW).toBe(STAGE_W);
    expect(view.originX).toBe(0);
    expect(view.renderedH).toBeCloseTo(1080 / (8160 / 4592), 3); // 607.6
    expect(view.originY).toBeCloseTo((STAGE_H - view.renderedH) / 2, 6);
    expect(view.srcPerPx).toBeCloseTo(8160 / 1080, 6); // 7.556 src px per stage px
  });
});

describe('visibleSourceRect', () => {
  it('sees the whole source at scale 1', () => {
    const rect = visibleSourceRect(STAGE_W, STAGE_H, 8160, 4592, 1, 0, 0)!;
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(8160);
    expect(rect.height).toBe(4592);
  });

  it('sees the central half-width at 2× untranslated', () => {
    const rect = visibleSourceRect(STAGE_W, STAGE_H, 8160, 4592, 2, 0, 0)!;
    // Stage width 1080 covers 540 container px → 540 · 7.556 = 4080 src.
    expect(rect.width).toBeCloseTo(4080, 3);
    expect(rect.x).toBeCloseTo((8160 - 4080) / 2, 3);
    // Vertically the photo (608 container px) exceeds the 2×-viewport's
    // 1140-px window? No — 1140 > 608, so the full height is visible.
    expect(rect.height).toBe(4592);
  });

  it('follows a pan: translating right reveals the LEFT of the source', () => {
    const centred = visibleSourceRect(STAGE_W, STAGE_H, 8160, 4592, 4, 0, 0)!;
    const panned = visibleSourceRect(STAGE_W, STAGE_H, 8160, 4592, 4, 400, 0)!;
    expect(panned.x).toBeLessThan(centred.x);
    expect(panned.width).toBeCloseTo(centred.width, 3);
  });
});

describe('patchSampleFor (D4 — never sub-screen)', () => {
  it('is exact at or past 1:1', () => {
    expect(patchSampleFor(1)).toBe(1);
    expect(patchSampleFor(2.5)).toBe(1);
  });
  it('rounds the supersample DOWN (quality) on power-of-2 boundaries', () => {
    expect(patchSampleFor(0.6)).toBe(1); // 1.67× supersampled
    expect(patchSampleFor(0.5)).toBe(2); // exactly 1 src px per screen px
    expect(patchSampleFor(0.26)).toBe(2); // 1.9× supersampled at sample 2
    expect(patchSampleFor(0.24)).toBe(4);
  });
});

describe('planPatch (D4 + D5)', () => {
  const SRC_W = 8160;
  const SRC_H = 4592; // 50MP-mode, base sample 2

  it('does not engage while the base is at least as sharp (and never for full-res bases)', () => {
    // At 2×, spp = 2/7.556 = 0.26 → sample 2 = the base: not engaged.
    expect(planPatch(STAGE_W, STAGE_H, SRC_W, SRC_H, 2, 0, 0, 2)).toBeNull();
    // A full-res base (12MP photos) never yields a sharper patch.
    expect(planPatch(STAGE_W, STAGE_H, 4000, 3000, 16, 0, 0, 1)).toBeNull();
  });

  it('engages past the base and decodes at sample 1 with a margin', () => {
    const plan = planPatch(STAGE_W, STAGE_H, SRC_W, SRC_H, 8, 0, 0, 2)!;
    expect(plan.sample).toBe(1); // spp = 1.06 ≥ 1
    // Visible source ≈ 1020×2153 (8.4 MB): √(64/8.4) ≈ 2.76 per axis —
    // under the 3× cap, spending the budget on pan coverage.
    expect(plan.marginFactor).toBeGreaterThan(2.5);
    expect(plan.marginFactor).toBeLessThanOrEqual(3);
    expect(plan.rect.width).toBeGreaterThan(2000);
    // Budget-sized, plus bounded tile-alignment slack.
    expect(plan.bytes).toBeLessThan(96 * 1024 * 1024);
    // The rect is tile-aligned (PATCH_RECT_ALIGN) and inside the source.
    expect(plan.rect.x % 512).toBe(0);
    expect(plan.rect.y % 512).toBe(0);
    expect(plan.rect.x).toBeGreaterThanOrEqual(0);
    expect(plan.rect.x + plan.rect.width).toBeLessThanOrEqual(SRC_W);
  });

  it('shrinks the margin factor as the patch grows (mid-zoom)', () => {
    // 200MP-mode at 8×: sample 1, visible ≈ 2040×4306 (34 MB) → factor
    // √(64/34) ≈ 1.37.
    const plan = planPatch(STAGE_W, STAGE_H, 16320, 9180, 8, 0, 0, 4)!;
    expect(plan.sample).toBe(1);
    expect(plan.marginFactor).toBeGreaterThan(1.2);
    expect(plan.marginFactor).toBeLessThan(1.6);
    // The 512 tile alignment can add up to 511 px per edge past the
    // margin budget — bounded, and the D9 log reports real bytes.
    expect(plan.bytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  });

  it('never shrinks below the visible region when it alone exceeds the budget', () => {
    // Force visibleBytes > budget with a tiny margin budget: the factor
    // must floor at 1 (full visible coverage — D4 outranks D5), never
    // √(budget/bytes) < 1 carving a soft band inside the viewport.
    const plan = planPatch(STAGE_W, STAGE_H, SRC_W, SRC_H, 8, 0, 0, 2, 0, 1, 1024 * 1024)!;
    expect(plan.marginFactor).toBe(1);
    const visible = visibleSourceRect(STAGE_W, STAGE_H, SRC_W, SRC_H, 8, 0, 0)!;
    expect(rectCovers(plan.displayRect, visible)).toBe(true);
  });

  it('places the patch where the source rect renders in the stage container', () => {
    const plan = planPatch(STAGE_W, STAGE_H, SRC_W, SRC_H, 8, 0, 0, 2)!;
    const view = containView(STAGE_W, STAGE_H, SRC_W, SRC_H);
    expect(plan.placement.left).toBeCloseTo(view.originX + plan.rect.x / view.srcPerPx, 4);
    expect(plan.placement.width).toBeCloseTo(plan.rect.width / view.srcPerPx, 4);
  });
});

describe('orientation mapping (sensor ↔ display)', () => {
  const cases = [0, 90, 180, 270] as const;

  it('round-trips every rotation', () => {
    // Sensor 8160×4592 (the real orientation=90 portrait shots).
    const sensorW = 8160;
    const sensorH = 4592;
    for (const rotation of cases) {
      const display = displaySize(sensorW, sensorH, rotation);
      const rect = { x: 100, y: 200, width: 300, height: 400 };
      const sensor = toSensorRect(rect, rotation, display.width, display.height);
      expect(toDisplayRect(sensor, rotation, sensorW, sensorH)).toEqual(rect);
      // The mapped rect stays inside the sensor.
      expect(sensor.x).toBeGreaterThanOrEqual(0);
      expect(sensor.y).toBeGreaterThanOrEqual(0);
      expect(sensor.x + sensor.width).toBeLessThanOrEqual(sensorW);
      expect(sensor.y + sensor.height).toBeLessThanOrEqual(sensorH);
    }
  });

  it('maps a 90° display rect to the hand-derived sensor rect', () => {
    // Display (portrait 4592×8160): the top-left display corner shows
    // the sensor's TOP-RIGHT corner after a 90° CW rotation.
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(toSensorRect(rect, 90, 4592, 8160)).toEqual({
      x: 0,
      y: 4592 - 100,
      width: 50,
      height: 100,
    });
  });

  it('plans a rotated patch whose sensor rect is tile-aligned and whose placement is display-true', () => {
    // The real case: sensor 8160×4592 at orientation 90 → display
    // 4592×8160 (portrait), base sample 2, zoomed deep.
    const plan = planPatch(STAGE_W, STAGE_H, 4592, 8160, 12, 0, 0, 2, 90)!;
    expect(plan.sample).toBe(1);
    expect(plan.rect.x + plan.rect.width).toBeLessThanOrEqual(8160); // sensor W
    expect(plan.rect.y + plan.rect.height).toBeLessThanOrEqual(4592); // sensor H
    // Round-trip: the display rect maps back onto the sensor rect.
    expect(toSensorRect(plan.displayRect, 90, 4592, 8160)).toEqual(plan.rect);
    // Placement sits inside the stage-fit photo (portrait fills height).
    const view = containView(STAGE_W, STAGE_H, 4592, 8160);
    expect(plan.placement.left).toBeGreaterThanOrEqual(view.originX - 1e-6);
    expect(plan.placement.top).toBeGreaterThanOrEqual(view.originY - 1e-6);
  });
});

describe('rectCovers (the mid-pan coverage-exit trigger)', () => {
  it('covers while the visible rect stays inside the plan', () => {
    const plan = { x: 0, y: 0, width: 4000, height: 3000 };
    expect(rectCovers(plan, { x: 100, y: 100, width: 1000, height: 1000 })).toBe(true);
    expect(rectCovers(plan, { x: 3500, y: 0, width: 1000, height: 1000 })).toBe(false);
  });
});

describe('BaseRetention (D7)', () => {
  const MB = 1024 * 1024;

  it('drop() removes a stale entry pins notwithstanding, exactly once', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(
      100 * MB,
      (_v, k) => evicted.push(k),
      () => true,
    );
    cache.put('a', 'A', 10 * MB);
    cache.drop('a');
    expect(evicted).toEqual(['a']);
    expect(cache.get('a')).toBeNull();
    cache.drop('a'); // idempotent
    expect(evicted).toEqual(['a']);
  });

  it('evicts least-recently-used entries over the byte budget', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(100 * MB, (_v, k) => evicted.push(k));
    cache.put('a', 'A', 45 * MB);
    cache.put('b', 'B', 45 * MB);
    cache.put('c', 'C', 45 * MB); // 135 MB → evict 'a'
    expect(evicted).toEqual(['a']);
    expect(cache.size()).toBe(2);
  });

  it('get() refreshes recency — a flip-back survives the next admit', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(100 * MB, (_v, k) => evicted.push(k));
    cache.put('a', 'A', 45 * MB);
    cache.put('b', 'B', 45 * MB);
    expect(cache.get('a')).toBe('A'); // a is now most recent
    cache.put('c', 'C', 45 * MB); // evicts b, not a
    expect(evicted).toEqual(['b']);
    expect(cache.get('a')).toBe('A');
  });

  it('always admits the newest entry, even alone over budget (guardrail pair)', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(100 * MB, (_v, k) => evicted.push(k));
    cache.put('huge', 'H', 190 * MB);
    expect(cache.size()).toBe(1);
    expect(evicted).toEqual([]);
  });

  it('flush(except) keeps the current photo warm (trim + unit advance)', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(200 * MB, (_v, k) => evicted.push(k));
    cache.put('a', 'A', 45 * MB);
    cache.put('b', 'B', 45 * MB);
    cache.flush('b');
    expect(evicted).toEqual(['a']);
    expect(cache.get('b')).toBe('B');
  });

  it('never evicts a pinned (on-screen) base, whatever its recency', () => {
    const pinned = new Set(['a']);
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(
      100 * MB,
      (_v, k) => evicted.push(k),
      (k) => pinned.has(k),
    );
    cache.put('a', 'A', 45 * MB); // oldest but pinned (Compare's other pane)
    cache.put('b', 'B', 45 * MB);
    cache.put('c', 'C', 45 * MB); // over budget → evict b, not a
    expect(evicted).toEqual(['b']);
    cache.flush('c');
    expect(evicted).toEqual(['b']); // flush also respects the pin
    expect(cache.get('a')).toBe('A');
  });

  it('re-putting a key releases the replaced value exactly once', () => {
    const evicted: string[] = [];
    const cache = new BaseRetention<string>(200 * MB, (v) => evicted.push(v));
    cache.put('a', 'A1', 45 * MB);
    cache.put('a', 'A2', 45 * MB);
    expect(evicted).toEqual(['A1']);
    expect(cache.get('a')).toBe('A2');
    expect(cache.totalBytes()).toBe(45 * MB);
  });
});

describe('maxScaleFor (dynamic per-photo max zoom)', () => {
  // The measured deck stage (336×305 dp at 3×) and the real photo tiers.
  const DECK_W = 336;
  const DECK_H = 305;
  const DENSITY = 3;

  it('raises the max well past the floor for a 200MP-mode photo — 16 stopped before 1:1', () => {
    // Portrait display 9180×16320: 1:1 at ~17.8×, headroom 2.5× → ~44.6.
    const max = maxScaleFor(DECK_W, DECK_H, 9180, 16320, DENSITY);
    expect(max).toBeGreaterThan(40);
    expect(max).toBeLessThanOrEqual(48);
  });

  it('gives ordinary 12MP photos the raised 24 floor (the focus-check depth)', () => {
    // 1:1 at ~4.4×, headroom 2.5× → ~11: the floor carries it to 24.
    expect(maxScaleFor(DECK_W, DECK_H, 3000, 4000, DENSITY)).toBe(24);
  });

  it('caps pathological sources at the ceiling', () => {
    expect(maxScaleFor(DECK_W, DECK_H, 60000, 4000, DENSITY)).toBe(48);
  });

  it('shrinks on a bigger stage — the fullscreen viewer needs less scale to reach 1:1', () => {
    const deck = maxScaleFor(DECK_W, DECK_H, 9180, 16320, DENSITY);
    // Viewer stage 360×772: 1:1 at ~8.5×, headroom 2.5× → ~21 — under
    // the floor, so even the 200MP photo rides the floor there.
    const viewer = maxScaleFor(360, 772, 9180, 16320, DENSITY);
    expect(viewer).toBeLessThan(deck);
    expect(viewer).toBe(24);
  });
});
