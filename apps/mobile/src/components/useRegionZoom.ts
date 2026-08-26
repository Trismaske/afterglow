/**
 * The F22 region-zoom pipeline's impure half (m0.8.8, G3 + D1–D9): one
 * hook per zoom surface photo slot, owning decoder handles, decode
 * timers, and SharedRef lifetimes. The geometry and policy are pure in
 * lib/regionZoom.ts; the native decodes live in
 * modules/media-store-actions (RegionZoom.kt).
 *
 * Lifecycle per current photo:
 * - DWELL (D3): ~400 ms after the photo settles as current, open its
 *   region decoder and decode the base (retention cache hit skips the
 *   decode; the decoder still opens — patches need it). For HEIC the
 *   base decode IS the warm-up. Rapid swiping never reaches the timer.
 * - SETTLE: the hook POLLS the surface's shared values from the JS
 *   side (~SETTLE_QUIET_MS cadence) — never runOnJS: any UI→JS host
 *   function call is this build's segfault class (worklets 0.10.2 pin,
 *   DeckScreen's bridge comment), while JS-side reads of shared values
 *   are the safe direction. Two identical consecutive reads = quiesced
 *   (covers pinch settle and withDecay's glide end alike); a quiesced
 *   zoomed viewport plans a patch (D4+D5) and decodes it —
 *   single-flight, newest plan supersedes.
 * - COVERAGE EXIT (D5): mid-pan, a visible rect leaving the current
 *   patch's coverage triggers the decode immediately (margins make
 *   this rare); the stale patch stays mounted until its replacement
 *   lands — never a blank, never a downgrade flash.
 * - STABLE VIEW TREE (S10e recording, 2026-08-25): the surfaces mount
 *   the base and TWO patch buffer slots permanently and only ever
 *   update PROPS. Mounting a patch Image mid-gesture inserts a host
 *   view under the intercepting detector, which breaks RNGH's pointer
 *   tracking (the deck's documented host-view class) — on device the
 *   pinch collapsed onto one finger and the framing leapt every swap.
 *   New patches land in the older buffer slot (z-ordered above), the
 *   previous patch retires ~250 ms later (after the new one painted —
 *   no onLoad fires for SharedRef sources). A still-occupied target
 *   slot is emptied FIRST and the patch lands two frames later
 *   (expo-image swaps bitmaps async while placement props commit sync
 *   — reusing an occupied slot in one commit flashed a frame of the
 *   old bitmap at the new rect, S10e video 16). Small patches (deep zoom)
 *   apply IMMEDIATELY even mid-gesture — their texture upload is a few
 *   ms and that is where the base is softest; big ones defer to a
 *   gesture-quiet tick so the upload hitch cannot be felt
 *   (MIDGESTURE_APPLY_MAX_BYTES).
 * - FAIL-SOFT: a failed open logs once and disables the pipeline for
 *   that photo — the overlay keeps the stage-size cached image.
 * - RETENTION (D7): visited bases live in a module-level byte-budgeted
 *   MRU shared by every surface; flushed on unit advance (the surface
 *   calls flushRetention) and on a memoryTrim signal ≥ RUNNING_LOW
 *   (D9 — loud log, current photo kept warm, quality never degraded).
 *
 * D9 log lines (console IS the diagnostics API; every line persists to
 * the on-device sink): guardrail step-downs unconditional, margin
 * clamps rate-limited (on material change), evictions aggregated per
 * flush, trim flushes loud, decode timings via [perf].
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PixelRatio } from 'react-native';
import {
  closeRegionDecoder,
  decodeRegion,
  decodeScaled,
  openRegionDecoder,
  subscribeMemoryTrim,
  type RegionBitmap,
} from '../../modules/media-store-actions';
import {
  BASE_DWELL_MS,
  BASE_RETENTION_BUDGET_BYTES,
  BaseRetention,
  MIDGESTURE_APPLY_MAX_BYTES,
  SETTLE_QUIET_MS,
  baseSample,
  displaySize,
  planPatch,
  rectCovers,
  visibleSourceRect,
  type PatchPlan,
  type Rotation,
} from '../lib/regionZoom';
import { perfLog } from '../lib/perfLog';

/** ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW — at or past this the
 * retention flushes (levels: 5 moderate, 10 low, 15 critical, 20 UI
 * hidden, 40+ background — all ≥ 10 act). */
const TRIM_ACT_LEVEL = 10;

interface RetainedBase {
  ref: RegionBitmap;
  /** DISPLAY dimensions (rotation applied). */
  width: number;
  height: number;
  rotation: Rotation;
  sample: number;
  /** The source's DATE_MODIFIED at decode time (0 = unknown): an
   * in-place edit keeps the photo's id and uri, so without this a
   * revisit adopts the PRE-EDIT base and composites fresh patches over
   * it (codex round 2). A dwell-open reporting a different modTime
   * re-decodes instead of adopting. (The URI image layers have the
   * same staleness app-wide via expo-image's cache — docs/TODO.md; the
   * pipeline at least never MIXES eras within the overlay.) */
  modTime: number;
}

/** The current photo each mounted surface wants kept warm on a trim —
 * and PINNED against byte-budget eviction while on screen (Compare
 * renders two at once; releasing a displayed ref blanks its Image).
 * REF-COUNTED (review pass): the viewer opening over the deck pins the
 * same photo twice — a Set lost the pin when either surface left. */
const trimKeep = new Map<string, number>();

function pinPhoto(id: string): void {
  trimKeep.set(id, (trimKeep.get(id) ?? 0) + 1);
}

/** Refs evicted (replaced/dropped) while their photo was still PINNED —
 * i.e. possibly still rendered by a SIBLING surface whose state holds
 * the old ref (the deck under a viewer that just invalidated a stale
 * base — codex round 3: releasing on a timer detached a bitmap the
 * sibling still displayed). They release only when the photo's last
 * pin drops, when no mounted Image can be holding them. */
const parkedRefs = new Map<string, RegionBitmap[]>();

function releaseWhenUnpinned(key: string, ref: RegionBitmap): void {
  if (trimKeep.has(key)) {
    const list = parkedRefs.get(key) ?? [];
    list.push(ref);
    parkedRefs.set(key, list);
  } else {
    // Nobody displays this photo — release after any in-flight commit.
    setTimeout(() => ref.release?.(), 300);
  }
}

function unpinPhoto(id: string): void {
  const count = trimKeep.get(id) ?? 0;
  if (count <= 1) {
    trimKeep.delete(id);
    const parked = parkedRefs.get(id);
    if (parked) {
      parkedRefs.delete(id);
      setTimeout(() => parked.forEach((ref) => ref.release?.()), 300);
    }
  } else trimKeep.set(id, count - 1);
}

/** Per-photo SINGLE-FLIGHT base decodes (codex round 1): the viewer
 * opening over the deck mounts two hooks on the same photo, and each
 * independently check-then-decoded — the loser's `retention.put`
 * replaced (and released) the winner's entry while a mounted Image
 * still rendered it. One shared flight per photo: whoever arrives
 * first decodes and puts; everyone else awaits and ADOPTS the same
 * retained entry. The flight is surface-agnostic — it completes and
 * retains even if its creator's photo changed mid-decode (the MRU
 * evicts unused entries; pins protect displayed ones). KEYED BY
 * photoId AND source modTime (codex round 3): an edit landing while a
 * base decode is in flight must not hand the old bytes to a surface
 * that opened the new ones. */
const baseInflight = new Map<string, Promise<RetainedBase>>();

/** One retention pool for ALL surfaces (deck, viewer, Compare's two
 * panes share the budget — D7). */
const retention = new BaseRetention<RetainedBase>(
  BASE_RETENTION_BUDGET_BYTES,
  (base, key) => {
    evictionsSinceFlush += 1;
    // Display-safe release (codex rounds 2+3): a still-pinned photo's
    // evicted ref may be rendered by a sibling surface — park it until
    // the last pin drops; unpinned refs release after any in-flight
    // commit has painted (the patch slots' discipline).
    releaseWhenUnpinned(key, base.ref);
  },
  (key) => trimKeep.has(key),
);
let evictionsSinceFlush = 0;

let trimSubscribers = 0;
let unsubscribeTrim: (() => void) | null = null;

function ensureTrimSubscription(): void {
  if (unsubscribeTrim) return;
  unsubscribeTrim = subscribeMemoryTrim(({ level }) => {
    if (level < TRIM_ACT_LEVEL) return;
    const kept = [...trimKeep.keys()];
    const before = retention.size();
    // Keep at most the single most useful base: the first registered
    // current photo (flush(except) takes one key; surfaces re-warm via
    // dwell anyway — speed degrades, never quality).
    retention.flush(kept[0]);
    console.log(
      `[zoom] memory trim level ${level}: flushed ${before - retention.size()} retained bases` +
        (kept[0] ? ' (current kept)' : ''),
    );
  });
}

/** Unit advance / surface teardown: drop every retained base except the
 * (optional) current photo, and log the eviction aggregate (D9). */
export function flushRegionZoomRetention(exceptPhotoId?: string): void {
  retention.flush(exceptPhotoId);
  if (evictionsSinceFlush > 0) {
    console.log(`[zoom] retention: ${evictionsSinceFlush} evictions since last flush`);
    evictionsSinceFlush = 0;
  }
}

export interface RegionPatchSlot {
  source: RegionBitmap;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Stacking order — newer patches draw over retiring ones. */
  z: number;
}

export interface RegionZoomState {
  /** The photo the returned sources belong to. On an in-place photo
   * advance the surface re-renders with the NEW id one commit before
   * this hook's effect clears the OLD photo's sources — a gate on
   * `forPhotoId === <displayed id>` blanks that frame instead of
   * painting the previous photo's bitmaps under the new identity
   * (codex round 1; only the deck can advance while zoomed). */
  forPhotoId: string | null;
  /** The pipeline is FAIL-SOFT for this photo (unreadable EXIF,
   * mirrored orientation, unopenable format, or three straight patch
   * failures): the overlay stays on the cached stage image, and the
   * surfaces show a small zoom-time notice saying so (Tristan,
   * close-out grilling — flagged for the m0.9 metadata-corner
   * redesign, F31/F33/F34). */
  failed: boolean;
  /** The base for the CURRENT photo — the overlay renders it instead of
   * the stage-size cached image once it lands. */
  baseSource: RegionBitmap | null;
  /** Source dimensions once known (the decoder's report). */
  sourceSize: { width: number; height: number } | null;
  /** TWO fixed buffer slots (stable view tree — header): the surfaces
   * mount one Image per slot permanently and feed these as props. */
  patchSlots: readonly [RegionPatchSlot | null, RegionPatchSlot | null];
}

export function useRegionZoom(
  photoId: string | null,
  uri: string | null,
  enabled: boolean,
  /** MUST be the exact box the overlay Images render in — measure a
   * BORDERLESS view (a border insets absoluteFill children while
   * onLayout reports the border box; the 2 dp disagreement magnifies
   * by scale × density into a visible jump on every patch apply —
   * DeckScreen's stageFrame comment, S10e 2026-08-25). */
  stageSize: () => { width: number; height: number },
  /** JS-side reads of the surface's shared transform values. */
  readViewport: () => { scale: number; tx: number; ty: number },
): RegionZoomState {
  const [baseSource, setBaseSource] = useState<RegionBitmap | null>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [forPhotoId, setForPhotoId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [patchSlots, setPatchSlots] = useState<
    readonly [RegionPatchSlot | null, RegionPatchSlot | null]
  >([null, null]);

  /** Mutable per-photo pipeline state — never triggers renders.
   * srcW/srcH are DISPLAY dimensions (rotation applied). */
  const pipeline = useRef<{
    photoId: string | null;
    handle: number | null;
    srcW: number;
    srcH: number;
    rotation: Rotation;
    baseSample: number;
    /** The base decode is in flight — patch decodes wait (they contend
     * for the same file's entropy stream; measured doubling both). */
    baseDecoding: boolean;
    failed: boolean;
    decoding: boolean;
    plan: PatchPlan | null;
    pendingPlan: boolean;
    patchFailures: number;
    lastViewport: { scale: number; tx: number; ty: number };
    lastMarginLogged: number;
    /** The last poll tick saw movement — buffer application waits. */
    lastTickMoved: boolean;
    /** A decoded patch awaiting a gesture-quiet tick to apply. */
    pendingApply: { plan: PatchPlan; ref: RegionBitmap } | null;
  }>({
    photoId: null,
    handle: null,
    srcW: 0,
    srcH: 0,
    rotation: 0,
    baseSample: 1,
    baseDecoding: false,
    failed: false,
    decoding: false,
    plan: null,
    pendingPlan: false,
    patchFailures: 0,
    lastViewport: { scale: 1, tx: 0, ty: 0 },
    lastMarginLogged: 2,
    lastTickMoved: false,
    pendingApply: null,
  });
  const slotsRef = useRef<[RegionPatchSlot | null, RegionPatchSlot | null]>([null, null]);
  // True-unmount cleanup: photo CHANGES clear buffers via the per-photo
  // effect; unmounting the surface must release them too. `alive` also
  // gates the empty-first deferred land (applyPatch) — a land firing
  // after this cleanup would leak its bitmap past the release sweep.
  const clearPatchesRef = useRef<() => void>(() => {});
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
      clearPatchesRef.current();
    },
    [],
  );
  const zRef = useRef(0);
  /** Apply GENERATION (codex round 1): bumped by every landed patch and
   * every clearPatches. The empty-first deferred land only fires while
   * its captured generation still stands — a newer patch landing inside
   * the 32 ms window (warm HEIC decodes in ~10 ms), or a zoom-out
   * clearing the buffers, releases the deferred ref instead of letting
   * a stale plan land above the newer state. */
  const applyGenRef = useRef(0);
  const retireTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitSlots = useCallback(() => {
    setPatchSlots([slotsRef.current[0], slotsRef.current[1]]);
  }, []);

  /** Drop both buffers and any pending apply (zoom-out, photo change,
   * unmount). Slots empty via PROPS — the Images stay mounted. */
  const clearPatches = useCallback(() => {
    const p = pipeline.current;
    applyGenRef.current += 1;
    if (retireTimer.current) {
      clearTimeout(retireTimer.current);
      retireTimer.current = null;
    }
    for (const i of [0, 1] as const) {
      const old = slotsRef.current[i];
      if (old) {
        slotsRef.current[i] = null;
        // Release after the emptied props have committed a frame.
        setTimeout(() => old.source.release?.(), 150);
      }
    }
    if (p.pendingApply) {
      p.pendingApply.ref.release?.();
      p.pendingApply = null;
    }
    commitSlots();
  }, [commitSlots]);

  clearPatchesRef.current = clearPatches;

  /** Mount a decoded patch in the older buffer slot, above the current
   * one; retire the previous patch once the new one has painted. */
  const applyPatchRef = useRef<(plan: PatchPlan, ref: RegionBitmap) => void>(() => {});
  const applyPatch = useCallback(
    (plan: PatchPlan, ref: RegionBitmap) => {
      const slots = slotsRef.current;
      const idx = (slots[0]?.z ?? 0) <= (slots[1]?.z ?? 0) ? 0 : 1;
      const evicted = slots[idx];
      if (evicted) {
        // EMPTY-FIRST (S10e video 16): expo-image swaps a slot's bitmap
        // ASYNCHRONOUSLY while its placement props commit synchronously,
        // so reusing an occupied slot flashed one frame of the OLD
        // bitmap stretched into the NEW rect — a full-screen burst of
        // wrong content. It only happens when applies outpace the
        // retire timer (fast pans decode ~every 200-300 ms). Empty the
        // slot's props this frame; land the patch two frames later —
        // the other slot and the base cover the gap.
        const photoAtDefer = pipeline.current.photoId;
        const genAtDefer = applyGenRef.current;
        slots[idx] = null;
        commitSlots();
        setTimeout(() => evicted.source.release?.(), 300);
        setTimeout(() => {
          if (
            aliveRef.current &&
            pipeline.current.photoId === photoAtDefer &&
            applyGenRef.current === genAtDefer
          )
            applyPatchRef.current(plan, ref);
          else ref.release?.();
        }, 32);
        return;
      }
      applyGenRef.current += 1;
      zRef.current += 1;
      slots[idx] = { source: ref, ...plan.placement, z: zRef.current };
      pipeline.current.plan = plan;
      commitSlots();
      const otherIdx = idx === 0 ? 1 : 0;
      const previous = slots[otherIdx];
      if (retireTimer.current) clearTimeout(retireTimer.current);
      if (previous) {
        retireTimer.current = setTimeout(() => {
          if (slotsRef.current[otherIdx] === previous) {
            slotsRef.current[otherIdx] = null;
            commitSlots();
            setTimeout(() => previous.source.release?.(), 150);
          }
        }, 250);
      }
    },
    [commitSlots],
  );
  applyPatchRef.current = applyPatch;

  /** Decode the freshest plan; single-flight, newest supersedes. */
  const decodePlannedPatch = useCallback(async () => {
    const p = pipeline.current;
    if (p.handle === null || p.failed || p.decoding || p.baseDecoding) {
      p.pendingPlan = p.decoding ? true : p.pendingPlan;
      return;
    }
    const stage = stageSize();
    const { scale, tx, ty } = p.lastViewport;
    if (scale <= 1.02) {
      if (p.plan !== null || slotsRef.current[0] !== null || slotsRef.current[1] !== null) {
        p.plan = null;
        clearPatches();
      }
      return;
    }
    const plan = planPatch(
      stage.width,
      stage.height,
      p.srcW,
      p.srcH,
      scale,
      tx,
      ty,
      p.baseSample,
      p.rotation,
      PixelRatio.get(),
    );
    if (plan === null) {
      // Idempotent: the settle poll re-plans every quiet tick — only a
      // patch actually mounted needs clearing.
      if (p.plan !== null || slotsRef.current[0] !== null || slotsRef.current[1] !== null) {
        p.plan = null;
        clearPatches();
      }
      return;
    }
    // COVERAGE-based dedup (S10e sink, 2026-08-25): withDecay creeps
    // sub-pixel for seconds after a glide, and an exact-rect compare
    // re-decoded ~4×/s at rest. A plan is redundant when an existing
    // one (applied or awaiting a quiet tick) is equally sharp and still
    // covers the visible region — only coverage loss or a sharper
    // sample warrants a decode.
    const visibleNow = visibleSourceRect(stage.width, stage.height, p.srcW, p.srcH, scale, tx, ty);
    const covers = (a: PatchPlan | null) =>
      a !== null &&
      a.sample <= plan.sample &&
      visibleNow !== null &&
      rectCovers(a.displayRect, visibleNow);
    if (covers(p.plan) || covers(p.pendingApply?.plan ?? null)) return;
    // A big (mid-zoom) patch mid-gesture would hold the single-flight
    // decoder for seconds and arrive stale (measured 5.5 s on the 150MP
    // tier) — it decodes at the quiet tick instead; the base carries
    // the gesture there.
    if (p.lastTickMoved && plan.bytes > MIDGESTURE_APPLY_MAX_BYTES) return;
    // Margin clamp log, rate-limited on material change (D9).
    if (plan.marginFactor < 2 && Math.abs(plan.marginFactor - p.lastMarginLogged) > 0.2) {
      p.lastMarginLogged = plan.marginFactor;
      console.log(`[zoom] margin clamped to ${plan.marginFactor.toFixed(2)}× by the byte budget`);
    }
    p.decoding = true;
    const photoAtStart = p.photoId;
    const started = Date.now();
    try {
      const ref = await decodeRegion(
        p.handle,
        plan.rect.x,
        plan.rect.y,
        plan.rect.width,
        plan.rect.height,
        plan.sample,
        p.rotation,
      );
      if (!aliveRef.current || pipeline.current.photoId !== photoAtStart) {
        // The photo changed — or the surface UNMOUNTED (codex round 1:
        // photoId survives unmount, so the identity check alone let a
        // late decode apply into an orphaned slot past the release
        // sweep) — mid-decode.
        ref.release?.();
        return;
      }
      p.patchFailures = 0;
      perfLog(
        () =>
          `zoom patch ${plan.rect.width}x${plan.rect.height} s${plan.sample} ` +
          `${Math.round(plan.bytes / (1024 * 1024))}MB ${Date.now() - started}ms`,
      );
      // Small patches apply IMMEDIATELY — even mid-gesture: with the
      // stable view tree an apply is a prop update (gestures untouched)
      // and a small texture uploads in a few ms, so deep zoom sharpens
      // live while panning. Big patches wait for a quiet tick, where an
      // upload hitch cannot be felt.
      if (!p.lastTickMoved || plan.bytes <= MIDGESTURE_APPLY_MAX_BYTES) {
        p.pendingApply?.ref.release?.();
        p.pendingApply = null;
        applyPatch(plan, ref);
      } else {
        p.pendingApply?.ref.release?.();
        p.pendingApply = { plan, ref };
      }
    } catch (error) {
      // A decode racing a close loses cleanly. Persistent failures must
      // not retry every settle tick (review pass): three in a row
      // fail-softs the photo — the base keeps carrying the zoom.
      if (pipeline.current.photoId === photoAtStart) {
        p.patchFailures += 1;
        if (p.patchFailures >= 3) {
          p.failed = true;
          setFailed(true);
          console.warn('[zoom] patch decodes failing — disabled for this photo:', String(error));
        } else {
          console.warn('[zoom] patch decode failed:', String(error));
        }
      }
    } finally {
      // Identity-fenced like baseDecoding (codex round 3): the pipeline
      // object is shared across photos, and an abandoned decode's
      // completion must not clobber the NEW photo's bookkeeping — the
      // photo-change effect already reset the flag for it.
      if (pipeline.current.photoId === photoAtStart) {
        p.decoding = false;
        if (p.pendingPlan) {
          p.pendingPlan = false;
          void decodePlannedPatch();
        }
      }
    }
  }, [stageSize, clearPatches, applyPatch]);

  // The JS-side viewport poll (header: never runOnJS on this build).
  useEffect(() => {
    if (!enabled || photoId === null) return;
    const interval = setInterval(() => {
      const p = pipeline.current;
      const now = readViewport();
      const last = p.lastViewport;
      const moved =
        Math.abs(now.scale - last.scale) > 1e-3 ||
        Math.abs(now.tx - last.tx) > 0.5 ||
        Math.abs(now.ty - last.ty) > 0.5;
      p.lastViewport = now;
      if (now.scale <= 1.02) {
        // Zoomed out: release the patches once, then idle.
        p.lastTickMoved = false;
        if (p.plan !== null || p.pendingApply !== null) {
          p.plan = null;
          clearPatches();
        }
        return;
      }
      if (moved) {
        p.lastTickMoved = true;
        // SPECULATIVE decode during the gesture (S10e video 3): don't
        // wait for quiescence to start warming — chain single-flight
        // decodes for the moving viewport (each stashes for the quiet
        // tick; the newest supersedes). decodePlannedPatch's coverage
        // dedup keeps this from spinning when the current patch still
        // covers the view at equal sharpness.
        if (p.handle !== null && !p.decoding) void decodePlannedPatch();
        return;
      }
      // Two identical consecutive reads: quiesced. Apply any patch that
      // finished decoding mid-gesture FIRST (its plan then satisfies the
      // dedup), then plan for the current view.
      p.lastTickMoved = false;
      if (p.pendingApply) {
        const ready = p.pendingApply;
        p.pendingApply = null;
        applyPatch(ready.plan, ready.ref);
      }
      void decodePlannedPatch();
    }, SETTLE_QUIET_MS);
    return () => clearInterval(interval);
  }, [enabled, photoId, readViewport, stageSize, decodePlannedPatch, clearPatches, applyPatch]);

  // The per-photo lifecycle: dwell → open + base; close on leave.
  useEffect(() => {
    trimSubscribers += 1;
    ensureTrimSubscription();
    return () => {
      trimSubscribers -= 1;
      if (trimSubscribers === 0) {
        if (unsubscribeTrim) {
          unsubscribeTrim();
          unsubscribeTrim = null;
        }
        // No zoom surface remains: up to the whole retention budget of
        // native bitmaps would otherwise sit with NO trim listener able
        // to reclaim them (codex round 3). Flush now — the next surface
        // re-warms through its dwell (D9: speed degrades, never
        // quality). Nothing is pinned with every surface gone.
        flushRegionZoomRetention();
      }
    };
  }, []);

  // Foreground revalidation (codex round 3): an external editor can
  // overwrite the CURRENT photo's bytes and return to the exact same
  // photoId and uri, which re-runs nothing — the old decoder handle,
  // base, and patches would stay authoritative indefinitely. A tick on
  // every return to the foreground re-runs the per-photo lifecycle:
  // one decoder re-open (~20 ms) plus the modTime check; the base
  // re-decodes only if the source actually changed.
  const [foregroundTick, setForegroundTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegroundTick((tick) => tick + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const p = pipeline.current;
    // Leaving the previous photo: close its decoder, drop its patch.
    const previousHandle = p.handle;
    p.photoId = photoId;
    p.handle = null;
    p.failed = false;
    p.plan = null;
    p.pendingPlan = false;
    p.patchFailures = 0;
    p.baseDecoding = false;
    // An abandoned decode on the OLD photo must not queue the new
    // photo's patches behind it (codex round 3) — its completion is
    // identity-fenced in decodePlannedPatch's finally, so clearing here
    // is safe and immediately unblocks the new photo.
    p.decoding = false;
    p.lastTickMoved = false;
    setBaseSource(null);
    setSourceSize(null);
    setForPhotoId(photoId);
    setFailed(false);
    clearPatches();
    if (previousHandle !== null) void closeRegionDecoder(previousHandle);
    if (!enabled || photoId === null || uri === null) return;
    if (photoId) pinPhoto(photoId);

    // A retained base shows instantly; the decoder still opens on dwell
    // (patches need it), but the user sees full base sharpness at once.
    const retained = retention.get(photoId);
    if (retained) {
      setBaseSource(retained.ref);
      setSourceSize({ width: retained.width, height: retained.height });
      p.srcW = retained.width;
      p.srcH = retained.height;
      p.rotation = retained.rotation;
      p.baseSample = retained.sample;
    }

    let cancelled = false;
    const dwell = setTimeout(() => {
      void (async () => {
        try {
          const opened = await openRegionDecoder(uri);
          if (cancelled || pipeline.current.photoId !== photoId) {
            void closeRegionDecoder(opened.handle);
            return;
          }
          const rotation = (
            opened.rotation === 90 || opened.rotation === 180 || opened.rotation === 270
              ? opened.rotation
              : 0
          ) as Rotation;
          const display = displaySize(opened.width, opened.height, rotation);
          p.handle = opened.handle;
          p.srcW = display.width;
          p.srcH = display.height;
          p.rotation = rotation;
          const stage = stageSize();
          // The D2 target wants PHYSICAL pixels; onLayout reports dp.
          const chosen = baseSample(
            opened.width,
            opened.height,
            Math.max(stage.width, stage.height) * PixelRatio.get(),
          );
          p.baseSample = chosen.sample;
          if (chosen.guardrailApplied)
            console.log(
              `[zoom] guardrail: ${opened.width}x${opened.height} base stepped down to sample ${chosen.sample}`,
            );
          // Retention first (another surface may have landed this base
          // since the effect's initial check — ADOPT it rather than
          // discarding the hit); otherwise join or create the source
          // VERSION's single flight (header of `baseInflight`). A
          // retained entry whose modTime disagrees with the freshly
          // opened source is STALE (in-place edit — RetainedBase
          // .modTime), and an UNVERIFIABLE stamp (0 on either side) is
          // treated the same (codex round 3: "cannot compare" must not
          // be permission to reuse): the stale entry leaves the screen
          // and retention BEFORE the re-decode, so a failed replacement
          // fail-softs to the URI image instead of pixels proven to be
          // the old bytes.
          let entry = retention.get(photoId);
          if (
            entry &&
            (entry.modTime === 0 || opened.modTime === 0 || entry.modTime !== opened.modTime)
          ) {
            console.log('[zoom] retained base stale or unverifiable — re-decoding');
            setBaseSource(null);
            setSourceSize(null);
            retention.drop(photoId);
            entry = null;
          }
          if (!entry) {
            p.baseDecoding = true;
            try {
              const flightKey = `${photoId}@${opened.modTime}`;
              let flight = baseInflight.get(flightKey);
              if (!flight) {
                flight = (async () => {
                  const started = Date.now();
                  const ref = await decodeScaled(uri, chosen.sample, rotation);
                  const bytes =
                    Math.ceil(opened.width / chosen.sample) *
                    Math.ceil(opened.height / chosen.sample) *
                    4;
                  perfLog(
                    () =>
                      `zoom base ${opened.width}x${opened.height} s${chosen.sample} ` +
                      `${Math.round(bytes / (1024 * 1024))}MB ${Date.now() - started}ms`,
                  );
                  const made: RetainedBase = {
                    ref,
                    width: display.width,
                    height: display.height,
                    rotation,
                    sample: chosen.sample,
                    modTime: opened.modTime,
                  };
                  retention.put(photoId, made, bytes);
                  return made;
                })();
                baseInflight.set(flightKey, flight);
                void flight.catch(() => {}).finally(() => baseInflight.delete(flightKey));
              }
              entry = await flight;
            } finally {
              // The pipeline object is SHARED across photos: only this
              // closure's own photo may clear the gate — an old decode
              // completing after a swap must not unblock the NEW
              // photo's patch decodes mid-base (codex round 1).
              if (pipeline.current.photoId === photoId) p.baseDecoding = false;
            }
          }
          if (cancelled || pipeline.current.photoId !== photoId) return; // retention owns the ref
          setBaseSource(entry.ref);
          setSourceSize({ width: entry.width, height: entry.height });
          // A zoom may already be waiting on the decoder (zoomed before
          // dwell completed) — serve it.
          if (p.lastViewport.scale > 1.02) void decodePlannedPatch();
        } catch (error) {
          if (pipeline.current.photoId === photoId) p.baseDecoding = false;
          if (cancelled || pipeline.current.photoId !== photoId) return;
          p.failed = true;
          setFailed(true);
          // Fail-soft, said once: the overlay keeps the cached stage
          // image (JPEG/HEIF/DNG all open — this is the exotic-format,
          // unreadable-EXIF, mirrored-orientation, and transient-IO
          // path), and the surfaces show the zoom-time notice.
          console.warn(`[zoom] region pipeline unavailable for this photo: ${String(error)}`);
        }
      })();
    }, BASE_DWELL_MS);

    // The pipeline ref object itself is stable for the component's
    // lifetime — captured here so the cleanup closes the handle the
    // effect's own run opened.
    const owned = pipeline.current;
    return () => {
      cancelled = true;
      clearTimeout(dwell);
      if (photoId) unpinPhoto(photoId);
      const handle = owned.handle;
      if (handle !== null) {
        owned.handle = null;
        void closeRegionDecoder(handle);
      }
    };
    // clearPatches/decodePlannedPatch/stageSize are stable useCallbacks.
    // foregroundTick re-runs the lifecycle on every return to the
    // foreground (same photo included — the in-place-edit case above).
  }, [photoId, uri, enabled, stageSize, clearPatches, decodePlannedPatch, foregroundTick]);

  return { forPhotoId, failed, baseSource, sourceSize, patchSlots };
}
