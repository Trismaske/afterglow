/**
 * The shared stage↔region-zoom wiring (m0.9 phase 1 consolidation —
 * PLAN.md's m0.9 entry). Every zoom surface carried a verbatim
 * copy of two things this file now owns once:
 *
 * 1. `useStageRegionZoom` — the JS-side callback pair feeding
 *    `useRegionZoom` (the hook POLLS these; never runOnJS — the bridge
 *    rule in the deck's header) plus the hook call itself. The
 *    `stageSize` contract is inherited unchanged: the measured view
 *    MUST be borderless (see useRegionZoom's parameter doc).
 * 2. `useStageMaxScale` — the photo's real resolution sets its zoom
 *    ceiling via `maxScaleFor`; unknown (pre-dwell, failed open) keeps
 *    the classic floor. Compare passes both panes and gets the MAX of
 *    the pair (m0.8.8 appendix 5: you zoom for the detailed one); the
 *    single-pane surfaces omit `sizeB`, and because `maxScaleFor`
 *    clamps every real ceiling to ≥ MAX_SCALE_FLOOR, the absent pane's
 *    floor term can never win the max — one rule, no branches.
 */

import { useCallback } from 'react';
import { PixelRatio } from 'react-native';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { MAX_SCALE_CEILING, MAX_SCALE_FLOOR, PAST_1TO1_HEADROOM } from '../lib/regionZoom';
import { useRegionZoom, type RegionZoomState } from './useRegionZoom';

/** The transform shared values every zoom surface owns; the stage box
 * values MUST measure a borderless view (the useRegionZoom contract). */
export interface StageZoomValues {
  stageW: SharedValue<number>;
  stageH: SharedValue<number>;
  scale: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
}

/** One pane's region-zoom pipeline over the surface's shared transform. */
export function useStageRegionZoom(
  values: StageZoomValues,
  photoId: string | null,
  uri: string | null,
  version: number,
  enabled: boolean,
  /** Compare's hidden-pane patch gate (useRegionZoom's parameter doc). */
  patchesEnabled: boolean = true,
): RegionZoomState {
  const { stageW, stageH, scale, tx, ty } = values;
  const regionStageSize = useCallback(
    () => ({ width: stageW.value, height: stageH.value }),
    [stageW, stageH],
  );
  const regionViewport = useCallback(
    () => ({ scale: scale.value, tx: tx.value, ty: ty.value }),
    [scale, tx, ty],
  );
  return useRegionZoom(
    photoId,
    uri,
    version,
    enabled,
    regionStageSize,
    regionViewport,
    patchesEnabled,
  );
}

/** Keeps `maxScale` at the ceiling of the sharpest mounted pane — and
 * at the CURRENT stage box: a reaction on the stage's shared size, not an
 * effect over the shared-value objects, so the immersive flip (a layout
 * change with the same source and the same mount) re-derives the 1:1
 * ceiling too (m0.9 close-out codex). */
export function useStageMaxScale(
  maxScale: SharedValue<number>,
  stageW: SharedValue<number>,
  stageH: SharedValue<number>,
  sizeA: { width: number; height: number } | null,
  sizeB: { width: number; height: number } | null = null,
): void {
  const density = PixelRatio.get();
  // The worklet inlines maxScaleFor (lib/regionZoom.ts, its contract and
  // constants): a module function is not reachable from the UI runtime
  // (the S10e crashed on the first frame with "undefined is not a
  // function"), so the arithmetic lives here with the constants captured.
  const floor = MAX_SCALE_FLOOR;
  const cap = MAX_SCALE_CEILING;
  const headroom = PAST_1TO1_HEADROOM;
  useAnimatedReaction(
    () => ({ w: stageW.value, h: stageH.value }),
    (stage) => {
      'worklet';
      const ceiling = (size: { width: number; height: number } | null): number => {
        if (!size || stage.w <= 0 || stage.h <= 0) return floor;
        const aspect = size.width / size.height;
        const renderedW = Math.min(stage.w, stage.h * aspect);
        const oneToOne = size.width / renderedW / density;
        return Math.min(cap, Math.max(floor, headroom * oneToOne));
      };
      maxScale.value = Math.max(ceiling(sizeA), ceiling(sizeB));
    },
    [sizeA, sizeB, density, floor, cap, headroom],
  );
}
