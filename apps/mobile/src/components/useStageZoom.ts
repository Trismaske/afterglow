/**
 * The shared stage↔region-zoom wiring (m0.9 phase 1 consolidation —
 * docs/MediaStage_design.md). Every zoom surface carried a verbatim
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

import { useCallback, useEffect } from 'react';
import { PixelRatio } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { MAX_SCALE_FLOOR, maxScaleFor } from '../lib/regionZoom';
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
  return useRegionZoom(photoId, uri, enabled, regionStageSize, regionViewport, patchesEnabled);
}

/** Keeps `maxScale` at the ceiling of the sharpest mounted pane. */
export function useStageMaxScale(
  maxScale: SharedValue<number>,
  stageW: SharedValue<number>,
  stageH: SharedValue<number>,
  sizeA: { width: number; height: number } | null,
  sizeB: { width: number; height: number } | null = null,
): void {
  useEffect(() => {
    const ceiling = (size: { width: number; height: number } | null) =>
      size
        ? maxScaleFor(stageW.value, stageH.value, size.width, size.height, PixelRatio.get())
        : MAX_SCALE_FLOOR;
    maxScale.value = Math.max(ceiling(sizeA), ceiling(sizeB));
  }, [maxScale, stageW, stageH, sizeA, sizeB]);
}
