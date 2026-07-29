/**
 * JS-side double-tap arbitration for a stage Pressable (the impure
 * partner of lib/zoomTarget.ts): the first press arms a DOUBLE_TAP_MS
 * timer that fires the single-tap action (if any); a second press inside
 * the window zooms to the tapped point instead. Taps stay off
 * Gesture.Tap because gesture worklets may not cross the worklets→JS
 * bridge (see DeckScreen's bridge comment); the zoom writes shared
 * values FROM JS with withTiming — the safe direction.
 *
 * Only reachable while unzoomed: once scale > 1 the zoom overlay's
 * animated pointerEvents swallows stage touches, so the overlay's own
 * double-tap (reset) takes over.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { withTiming, type SharedValue } from 'react-native-reanimated';
import { DOUBLE_TAP_MS, DOUBLE_TAP_ZOOM_SCALE, doubleTapZoomTarget } from '../lib/zoomTarget';

export interface ZoomSharedValues {
  scale: SharedValue<number>;
  savedScale: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  savedTx: SharedValue<number>;
  savedTy: SharedValue<number>;
  stageW: SharedValue<number>;
  stageH: SharedValue<number>;
  /** Photo width / height from the overlay image's onLoad (0 = not yet
   * loaded) — pans clamp to the photo's rendered edges, not the stage. */
  imageAspect: SharedValue<number>;
}

/** Returns the Pressable onPress handler. `resetKey` (the current photo
 * id) scopes the tap window to ONE page: the hook instance serves every
 * pager page, so without it tap A → swipe → tap B inside DOUBLE_TAP_MS
 * reads as a double tap on B. */
export function useDoubleTapZoom(
  zoom: ZoomSharedValues,
  onSingleTap?: () => void,
  resetKey?: unknown,
) {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A key change cancels an armed window WITHOUT firing its single-tap
  // action — that tap belonged to a page no longer shown.
  useEffect(() => {
    if (pending.current) {
      clearTimeout(pending.current);
      pending.current = null;
    }
  }, [resetKey]);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  return useCallback(
    (event: GestureResponderEvent) => {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
        const { locationX, locationY } = event.nativeEvent;
        const target = doubleTapZoomTarget(
          locationX,
          locationY,
          zoom.stageW.value,
          zoom.stageH.value,
          zoom.imageAspect.value,
        );
        zoom.scale.value = withTiming(DOUBLE_TAP_ZOOM_SCALE);
        zoom.savedScale.value = DOUBLE_TAP_ZOOM_SCALE;
        zoom.tx.value = withTiming(target.tx);
        zoom.ty.value = withTiming(target.ty);
        zoom.savedTx.value = target.tx;
        zoom.savedTy.value = target.ty;
        return;
      }
      pending.current = setTimeout(() => {
        pending.current = null;
        onSingleTap?.();
      }, DOUBLE_TAP_MS);
    },
    // The zoom shared values are stable refs from useSharedValue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSingleTap],
  );
}
