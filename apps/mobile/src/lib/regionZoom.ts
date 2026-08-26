/**
 * The F22 region-zoom pipeline's geometry and policy (m0.8.8, G3 +
 * D1–D7) — pure. The native half (modules/media-store-actions,
 * RegionZoom.kt) decodes exactly what this file computes; the impure
 * partner (components/useRegionZoom.ts) owns timers, handles, and
 * SharedRef lifetimes.
 *
 * Two layers, one contract:
 * - The BASE carries mid-gesture: the whole image at the largest
 *   power-of-2 sample whose long edge still reaches
 *   `max(stage long edge, 3840)` (D2 — device-adaptive, 3840 covers
 *   every mobile display shipped); a source with no such sample decodes
 *   at FULL resolution, so ordinary ≤12MP photos are pixel-perfect at
 *   every depth and the patch machinery never engages for them. A
 *   ~128 MB per-bitmap guardrail steps one sample down instead
 *   (Compare holds two bases at once); the caller logs the step-down
 *   unconditionally (D9).
 * - The PATCH carries every settled view: the visible source region
 *   plus a byte-budgeted margin (D5 — √(budget/patchBytes) per axis,
 *   capped at 2×, so coverage is widest at deep zoom where the base
 *   fallback is softest), at the largest power-of-2 sample keeping
 *   ≥1 source px per screen px (D4 — never sub-screen; the ~10 MB
 *   target is retired). Patch rects align to sample multiples so the
 *   decoded grid sits exactly on source pixels.
 *
 * The transform model matches the three zoom surfaces exactly
 * (translate → scale, both about the stage center, photo contain-fit
 * inside the stage): a screen point p maps to container point
 * c + (p − c − t)/s, and container→source is the contain-fit ratio.
 *
 * ORIENTATION: every surface displays the EXIF-rotated image while the
 * decoders work in sensor space (portrait phone shots are orientation
 * 90 landscape files). All geometry here runs in DISPLAY space; a
 * finished patch plan carries its decode rect mapped to SENSOR space
 * (aligned to sample multiples there, where the decoder's grid lives)
 * plus its display placement, and the native side rotates the decoded
 * bitmap back to display orientation.
 *
 * Retention (D7): visited bases live in an MRU list capped by BYTES
 * (~192 MB) — typically four ordinary photos, self-limiting for huge
 * ones — flushed on unit advance and on an onTrimMemory signal (D9:
 * speed degrades, never sample quality). Patches are never retained
 * across photos.
 *
 * Every constant here is a DEVICE-PASS TUNABLE with its D-decision
 * default; the pass tunes them against the D9 log lines.
 */

/** D2: the base target floor — covers every mobile display shipped
 * (2026 ceiling 3200 px; the discontinued 4K Xperias 3840). */
export const BASE_TARGET_FLOOR = 3840;
/** D2: the per-bitmap guardrail — exists for Compare's two panes. */
export const BASE_GUARDRAIL_BYTES = 128 * 1024 * 1024;
/** D5: the patch margin budget — raising it slows every patch decode
 * (decode time scales with rows covered); never raise it blind. */
export const PATCH_MARGIN_BUDGET_BYTES = 64 * 1024 * 1024;
/** D7: total bytes of retained visited bases. */
export const BASE_RETENTION_BUDGET_BYTES = 192 * 1024 * 1024;
/** D3: how long a photo must sit current before its base pre-warms. */
export const BASE_DWELL_MS = 400;
/** The quiescence window that turns gesture motion into "settled" —
 * covers pinch settle and `withDecay`'s glide end alike. */
export const SETTLE_QUIET_MS = 120;

/** The zoom range every photo gets regardless of resolution. Raised
 * from the pre-pipeline 16 (Tristan, 2026-08-25): the 12MP focus-and-
 * sharpness check always used the full range, and with downscaling off
 * the same gesture now deserves more real depth. */
export const MAX_SCALE_FLOOR = 24;
/** The absolute zoom ceiling — past this even a 200MP source is pure
 * interpolation on any stage. */
export const MAX_SCALE_CEILING = 48;
/** How far past 1:1 physical pixels the zoom may go — inspection
 * headroom (the pre-pipeline range was "past 1:1 by design";
 * 2 → 2.5, Tristan 2026-08-25). */
export const PAST_1TO1_HEADROOM = 2.5;

const BYTES_PER_PIXEL = 4; // ARGB_8888, always (G3)

/** Patch decode rects align to this SENSOR-space grid (a multiple of
 * every power-of-2 sample). 512 is the HEIF tile size: Android's
 * BitmapRegionDecoder snaps HEIC region origins to its internal tile
 * grid WITHOUT adjusting the output, so a non-tile-aligned rect comes
 * back with visibly displaced content (S10e recordings, 2026-08-25).
 * Aligning our rects makes the snap a no-op — and quantizes plans, so
 * sub-pixel decay creep yields byte-identical rects (no decode churn).
 * JPEG MCU boundaries (8/16) divide it too. */
export const PATCH_RECT_ALIGN = 512;

/** D5's per-axis margin cap. Was 2: at deep zoom the byte budget sat
 * ~90% unused while coverage barely exceeded the viewport, so every
 * small pan exited it and the decode→apply→retire cycle shimmered
 * sharp↔soft regions (S10e video 7, 2026-08-25). 3 gives ~9× viewport
 * area when the budget allows; decodes stay a few hundred ms. Tunable. */
export const PATCH_MARGIN_AXIS_CAP = 3;

/** Patches at or under this size APPLY MID-GESTURE (S10e video 6,
 * 2026-08-25): their texture upload is a few ms, so deep zoom — where
 * the base is softest and patches are smallest — sharpens live while
 * panning. Bigger patches defer to a gesture-quiet tick, where an
 * upload hitch cannot be felt. 24 → 12 MB after the margin-cap raise
 * made live uploads heavy enough to jutter a pan (S10e video 9).
 * Device-pass tunable. */
export const MIDGESTURE_APPLY_MAX_BYTES = 12 * 1024 * 1024;

/**
 * The per-photo max zoom (m0.8.8, Tristan): a fixed 16× stopped BEFORE
 * 1:1 on a 200MP photo (1:1 lands at ~18× on the deck stage), while
 * deep fixed maxima on a 12MP photo are pure mush. So the max derives
 * from the photo: reach 1:1 physical pixels plus PAST_1TO1_HEADROOM,
 * floored at MAX_SCALE_FLOOR, capped at MAX_SCALE_CEILING. The patch
 * pipeline keeps the range honest (≥1 source px per screen px at every
 * settled view). Stage dims arrive in dp; `density` converts to
 * physical px. All three constants are device-pass tunables.
 */
export function maxScaleFor(
  stageW: number,
  stageH: number,
  displayW: number,
  displayH: number,
  density: number,
): number {
  const view = containView(stageW, stageH, displayW, displayH);
  const oneToOne = view.srcPerPx / density;
  return Math.min(MAX_SCALE_CEILING, Math.max(MAX_SCALE_FLOOR, PAST_1TO1_HEADROOM * oneToOne));
}

/** Largest power of two ≤ n (n ≥ 1). */
function floorPow2(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * D2: the base decode's inSampleSize for a source, on a device whose
 * stage long edge is `stageLongPx`. Returns the sample plus whether the
 * guardrail forced a step-down (the caller diagLogs that, D9).
 */
export function baseSample(
  srcW: number,
  srcH: number,
  stageLongPx: number,
): { sample: number; guardrailApplied: boolean } {
  const target = Math.max(stageLongPx, BASE_TARGET_FLOOR);
  const longEdge = Math.max(srcW, srcH);
  // Largest power-of-2 sample whose result still reaches the target;
  // none ⇒ full resolution (sample 1).
  let sample = 1;
  while (longEdge / (sample * 2) >= target) sample *= 2;
  const bytesAt = (s: number) => Math.ceil(srcW / s) * Math.ceil(srcH / s) * BYTES_PER_PIXEL;
  if (bytesAt(sample) <= BASE_GUARDRAIL_BYTES) return { sample, guardrailApplied: false };
  return { sample: sample * 2, guardrailApplied: true };
}

/** The contain-fit of a source inside the stage: rendered size, origin,
 * and the source-per-container-pixel ratio. */
export interface ContainView {
  renderedW: number;
  renderedH: number;
  originX: number;
  originY: number;
  /** Source pixels per container pixel (≥ 0). */
  srcPerPx: number;
}

export function containView(
  stageW: number,
  stageH: number,
  srcW: number,
  srcH: number,
): ContainView {
  const aspect = srcW / srcH;
  const renderedW = Math.min(stageW, stageH * aspect);
  const renderedH = Math.min(stageH, stageW / aspect);
  return {
    renderedW,
    renderedH,
    originX: (stageW - renderedW) / 2,
    originY: (stageH - renderedH) / 2,
    srcPerPx: srcW / renderedW,
  };
}

export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/** Display dimensions of a sensor-space image under its EXIF rotation. */
export function displaySize(
  sensorW: number,
  sensorH: number,
  rotation: Rotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: sensorH, height: sensorW }
    : { width: sensorW, height: sensorH };
}

/** Map a display-space rect into sensor space (the decoder's grid).
 * `displayW`/`displayH` are the DISPLAY dimensions. */
export function toSensorRect(
  rect: SourceRect,
  rotation: Rotation,
  displayW: number,
  displayH: number,
): SourceRect {
  switch (rotation) {
    case 0:
      return { ...rect };
    case 90:
      // Display = sensor rotated 90° CW; sensorH = displayW.
      return {
        x: rect.y,
        y: displayW - rect.x - rect.width,
        width: rect.height,
        height: rect.width,
      };
    case 180:
      return {
        x: displayW - rect.x - rect.width,
        y: displayH - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    case 270:
      // Display = sensor rotated 270° CW; sensorW = displayH.
      return {
        x: displayH - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width,
      };
  }
}

/** The inverse of toSensorRect: where a sensor-space rect lands in the
 * display. `sensorW`/`sensorH` are the SENSOR dimensions. */
export function toDisplayRect(
  rect: SourceRect,
  rotation: Rotation,
  sensorW: number,
  sensorH: number,
): SourceRect {
  switch (rotation) {
    case 0:
      return { ...rect };
    case 90:
      return {
        x: sensorH - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width,
      };
    case 180:
      return {
        x: sensorW - rect.x - rect.width,
        y: sensorH - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    case 270:
      return {
        x: rect.y,
        y: sensorW - rect.x - rect.width,
        width: rect.height,
        height: rect.width,
      };
  }
}

/**
 * The source region visible in the stage viewport under the surfaces'
 * transform (translate tx/ty then scale s, both about the stage
 * center), clamped to the source bounds. Null when the transform shows
 * no source pixel (fully panned out — clamps upstream make this rare).
 */
export function visibleSourceRect(
  stageW: number,
  stageH: number,
  srcW: number,
  srcH: number,
  scale: number,
  tx: number,
  ty: number,
): SourceRect | null {
  const view = containView(stageW, stageH, srcW, srcH);
  const cx = stageW / 2;
  const cy = stageH / 2;
  // Stage viewport corners → container coordinates.
  const cLeft = cx + (0 - cx - tx) / scale;
  const cRight = cx + (stageW - cx - tx) / scale;
  const cTop = cy + (0 - cy - ty) / scale;
  const cBottom = cy + (stageH - cy - ty) / scale;
  // Container → source, clamped.
  const sx0 = Math.max(0, (cLeft - view.originX) * view.srcPerPx);
  const sx1 = Math.min(srcW, (cRight - view.originX) * view.srcPerPx);
  const sy0 = Math.max(0, (cTop - view.originY) * view.srcPerPx);
  const sy1 = Math.min(srcH, (cBottom - view.originY) * view.srcPerPx);
  if (sx1 <= sx0 || sy1 <= sy0) return null;
  return { x: sx0, y: sy0, width: sx1 - sx0, height: sy1 - sy0 };
}

/** D4: the patch sample at the current magnification. `spp` is screen
 * pixels per source pixel (scale ÷ srcPerPx); ≥ 1 means at-or-past 1:1,
 * where sample 1 is exact. */
export function patchSampleFor(spp: number): number {
  if (spp >= 1) return 1;
  return floorPow2(1 / spp);
}

/** Where the patch Image sits inside the (untransformed) stage
 * container — the transform then carries it with the photo. */
export interface PatchPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PatchPlan {
  /** The decode rect in SENSOR space, aligned to the decoder's tile
   * grid (integer coordinates). */
  rect: SourceRect;
  /** The same region in DISPLAY space — the coverage-exit check
   * compares it against the visible rect. */
  displayRect: SourceRect;
  sample: number;
  /** Decoded bitmap bytes (ARGB), post-margin. */
  bytes: number;
  /** The margin factor actually applied per axis (1 = none, ≤ 2). */
  marginFactor: number;
  placement: PatchPlacement;
}

/**
 * The full patch decision for a settled viewport (D4 + D5): null when
 * the base already supplies ≥1 source px per screen px (patch not
 * engaged) or when nothing is visible.
 */
export function planPatch(
  stageW: number,
  stageH: number,
  srcW: number,
  srcH: number,
  scale: number,
  tx: number,
  ty: number,
  baseSampleSize: number,
  rotation: Rotation = 0,
  /** PHYSICAL pixels per layout unit (PixelRatio.get()): every stage/
   * transform number arrives in dp, but "≥1 source px per SCREEN px"
   * (D4) is a physical-pixel promise — omitting the density made every
   * patch look unnecessary on a 3× phone (measured, S10e). */
  density: number = 1,
  marginBudgetBytes: number = PATCH_MARGIN_BUDGET_BYTES,
): PatchPlan | null {
  // srcW/srcH are DISPLAY dimensions; sensor dims swap under 90/270.
  const sensorW = rotation === 90 || rotation === 270 ? srcH : srcW;
  const sensorH = rotation === 90 || rotation === 270 ? srcW : srcH;
  const view = containView(stageW, stageH, srcW, srcH);
  const spp = (scale * density) / view.srcPerPx;
  const sample = patchSampleFor(spp);
  // The base is at least as sharp as the patch would be — not engaged.
  if (sample >= baseSampleSize) return null;
  const visible = visibleSourceRect(stageW, stageH, srcW, srcH, scale, tx, ty);
  if (visible === null) return null;

  // D5: margin factor from the byte budget, capped per axis — and
  // FLOORED at 1 (codex round 1): when the visible region alone
  // exceeds the budget (reachable on 4K-class stages near a sample
  // boundary), √(budget/bytes) < 1 would shrink the patch BELOW the
  // viewport, leaving a soft base band inside the settled view and a
  // rectCovers miss re-decoding forever. The budget limits MARGINS,
  // never visible coverage (D4 outranks D5).
  const visibleBytes =
    Math.ceil(visible.width / sample) * Math.ceil(visible.height / sample) * BYTES_PER_PIXEL;
  const marginFactor = Math.max(
    1,
    Math.min(PATCH_MARGIN_AXIS_CAP, Math.sqrt(marginBudgetBytes / visibleBytes)),
  );
  const expandedW = visible.width * marginFactor;
  const expandedH = visible.height * marginFactor;
  const centerX = visible.x + visible.width / 2;
  const centerY = visible.y + visible.height / 2;
  const expanded = {
    x: centerX - expandedW / 2,
    y: centerY - expandedH / 2,
    width: expandedW,
    height: expandedH,
  };

  // Align on the DECODER's grid: map to sensor space first, then snap
  // OUTWARD to PATCH_RECT_ALIGN boundaries and clamp (the grid starts at
  // the sensor origin, not the display origin). See PATCH_RECT_ALIGN:
  // this defeats the HEIF tile snap and quantizes plans against creep.
  const sensorFloat = toSensorRect(expanded, rotation, srcW, srcH);
  const A = PATCH_RECT_ALIGN;
  const x0 = Math.max(0, Math.floor(sensorFloat.x / A) * A);
  const y0 = Math.max(0, Math.floor(sensorFloat.y / A) * A);
  const x1 = Math.min(sensorW, Math.ceil((sensorFloat.x + sensorFloat.width) / A) * A);
  const y1 = Math.min(sensorH, Math.ceil((sensorFloat.y + sensorFloat.height) / A) * A);
  if (x1 <= x0 || y1 <= y0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const displayRect = toDisplayRect(rect, rotation, sensorW, sensorH);

  return {
    rect,
    displayRect,
    sample,
    bytes: Math.ceil(rect.width / sample) * Math.ceil(rect.height / sample) * BYTES_PER_PIXEL,
    marginFactor,
    placement: {
      left: view.originX + displayRect.x / view.srcPerPx,
      top: view.originY + displayRect.y / view.srcPerPx,
      width: displayRect.width / view.srcPerPx,
      height: displayRect.height / view.srcPerPx,
    },
  };
}

/** Does `plan`'s rect still cover the currently visible region? The
 * mid-pan coverage-exit trigger (D5) re-decodes only on a false. */
export function rectCovers(plan: SourceRect, visible: SourceRect): boolean {
  return (
    visible.x >= plan.x &&
    visible.y >= plan.y &&
    visible.x + visible.width <= plan.x + plan.width &&
    visible.y + visible.height <= plan.y + plan.height
  );
}

/**
 * D7: the byte-budgeted MRU of retained bases. Pure bookkeeping — the
 * caller owns the actual SharedRef release in `onEvict`. The CURRENT
 * photo's base always fits (a single base above the budget is still
 * admitted; the budget bounds the tail, not the head).
 */
export class BaseRetention<T> {
  private entries = new Map<string, { value: T; bytes: number }>();

  constructor(
    private readonly budgetBytes: number,
    private readonly onEvict: (value: T, key: string) => void,
    /** Keys currently ON SCREEN (Compare renders two at once) — never
     * evicted by the byte budget, whatever their recency: releasing a
     * displayed ref would blank a mounted Image. */
    private readonly isPinned: (key: string) => boolean = () => false,
  ) {}

  /** Admit (or refresh) a base; evicts least-recent entries over budget. */
  put(key: string, value: T, bytes: number): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      if (existing.value !== value) this.onEvict(existing.value, key);
    }
    this.entries.set(key, { value, bytes });
    this.evictOverBudget();
  }

  /** Fetch and mark most-recent. */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Targeted removal of a PROVEN-STALE entry (the source's bytes
   * changed under the same key — the caller re-decodes). Runs
   * `onEvict` pins notwithstanding: the eviction callback owns
   * display-safe release (the impure half parks refs of still-pinned
   * photos until their last pin drops). */
  drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.onEvict(entry.value, key);
  }

  /** D9's trim flush (and the unit-advance flush): drop everything but
   * `except` and the pinned (on-screen) keys. */
  flush(except?: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (key === except || this.isPinned(key)) continue;
      this.entries.delete(key);
      this.onEvict(entry.value, key);
    }
  }

  totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  size(): number {
    return this.entries.size;
  }

  private evictOverBudget(): void {
    // Insertion order is recency order (get/put re-insert); evict from
    // the oldest end, never the newest entry (the current photo) and
    // never a pinned (on-screen) one.
    while (this.totalBytes() > this.budgetBytes && this.entries.size > 1) {
      const keys = [...this.entries.keys()];
      const victim = keys.slice(0, -1).find((key) => !this.isPinned(key));
      if (victim === undefined) return; // everything remaining is on screen
      const entry = this.entries.get(victim)!;
      this.entries.delete(victim);
      this.onEvict(entry.value, victim);
    }
  }
}
