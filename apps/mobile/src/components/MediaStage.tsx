/**
 * MediaStage — THE shared photo/video stage (m0.9 phase 1,
 * docs/Plan_m0.9.md). One component owns what DeckScreen,
 * PhotoViewer and CompareScreen each carried a near-copy of: the
 * measured borderless stage box, the virtual-detector arrangement, the
 * pinch/pan/double-tap drivers over the ONE `zoomTouchFrame` tracker,
 * and the always-mounted zoom overlay stack (backdrop → URI image →
 * region-zoom base → two patch buffer slots → fail-soft notice).
 *
 * CANONICALITY (Tristan, 2026-08-26): the deck stage's behavior is the
 * specification — hundreds of judged iterations tuned it. The driver
 * code below is DeckScreen's, moved verbatim; other surfaces align to
 * it except where divergence is deliberate product semantics, declared
 * through props.
 *
 * THE RULES this file inherits (full histories in the git record of
 * DeckScreen's m0.8.8 header; they bind every edit here):
 *
 * - NO GESTURE CALLBACK MAY CROSS THE WORKLETS->JS BRIDGE. runOnJS from
 *   a gesture worklet segfaults this build (SIGSEGV in AroundLock::utf8;
 *   reanimated #9776, worklets 0.10.2). Zoomed-ness lives ONLY in shared
 *   values; the overlay reacts via animated style/props.
 * - GESTURE CALLBACKS ARE WRITTEN INLINE in the config objects below.
 *   Extracted or memoized callbacks silently de-workletize into
 *   JS-thread callbacks — the crash above. Never lift them out, never
 *   accept them as props.
 * - TWO detectors, and the split matters: an enabled Pan in the same
 *   composition as a pager's native scroll crashes the worklets runtime
 *   on a horizontal drag. The stage detector is the PINCH ALONE; pan +
 *   double-tap live on the zoom overlay, which only receives touches
 *   while zoomed (animated pointerEvents).
 * - VIRTUAL detectors only (`InterceptingGestureDetector` +
 *   `VirtualGestureDetector`): the plain `GestureDetector` is a HOST
 *   component in RNGH 3, and neither a pager's native scroll nor the
 *   overlay's animated pointerEvents survives an inserted host view.
 * - The measured stage view is BORDERLESS: Yoga insets absolute
 *   children by the parent's border while onLayout reports the border
 *   box — a 2 dp seam deep zoom magnifies into a visible jump (~85 px
 *   at 24× on the S10e). Decoration belongs on the host's outer
 *   `frameStyle` view.
 * - The overlay stack is ALWAYS MOUNTED, props-only: mounting a host
 *   view under the intercepting detector mid-touch breaks RNGH pointer
 *   tracking (pinch collapses onto one finger). Patch slots position by
 *   float-exact TRANSFORM, never left/top (layout snaps to the pixel
 *   grid; a deep-zoom scale magnifies the snap into a content jump).
 * - Stream arbitration: the stage pinch must ACTIVATE to claim a stream
 *   from the pager; an overlay claim (`overlayOwnsStream`) stands the
 *   stage handlers down completely; both drivers reset their anchor on
 *   `onTouchesCancel` so a stolen stream never leaves stale state.
 *
 * Playback slots (m0.9 phase 5) and the declarative chrome builder
 * (phase 7) land here — this is the one tree they must join; the
 * standalone viewer retires into the deck in phase 2 (M24), so this
 * stage is on its way to being the app's ONE photo surface.
 */

import React, { useCallback, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import {
  GestureStateManager,
  InterceptingGestureDetector,
  State,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  VirtualGestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated';
import { MAX_SCALE_FLOOR } from '../lib/regionZoom';
import {
  FLICK_MIN_VELOCITY,
  ZOOM_TRACKING_START,
  clampPan,
  pairPanBounds,
  panBounds,
  zoomTouchFrame,
} from '../lib/zoomTarget';
import type { RegionZoomState } from './useRegionZoom';

/** The deck-canonical pager-negotiating driver set: stage pinch claims
 * two-finger streams from the pager by ACTIVATION; pan + double-tap on
 * the overlay drive while zoomed. (Compare's single-driver mode joins
 * in its port.) */
export function useMediaStage() {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);
  /** The dynamic per-photo zoom ceiling (useStageMaxScale) — a shared
   * value so the pinch worklet clamps without touching the bridge. */
  const maxScale = useSharedValue<number>(MAX_SCALE_FLOOR);
  // Photo width / height, set by the overlay image's onLoad (JS → shared
  // value, the safe bridge direction). Pans clamp to the photo's own
  // rendered edges via panBounds — 0 means not yet loaded.
  const imageAspect = useSharedValue(0);
  // ONE tracker for the whole pinch-pan (zoomTouchFrame, m0.8.8): scale
  // and translation share a single anchor, so they can never disagree —
  // the two-tracker design made focal anchoring depend on the PAN
  // gesture's activation state (S10e video 11).
  const zoomTracking = useSharedValue(ZOOM_TRACKING_START);
  /** The overlay's handlers own the current touch stream — the stage
   * pinch (which can receive the same stream through the shared
   * interceptor) stands down completely while this is set. */
  const overlayOwnsStream = useSharedValue(false);

  const resetZoom = useCallback(() => {
    scale.value = 1;
    savedScale.value = 1;
    tx.value = 0;
    ty.value = 0;
    savedTx.value = 0;
    savedTy.value = 0;
    // The aspect belongs to the CURRENT photo: left stale across a photo
    // change, a double tap before the new onLoad clamps pan bounds
    // against the PREVIOUS photo's edges. 0 = not loaded, where
    // panBounds falls back to stage-rect bounds (zoomTarget.ts).
    imageAspect.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The stage pinch's own handler tag, fed back JS → shared value (the
   * safe bridge direction) so the touch worklet below can force-claim
   * the stream. 0 until the first render's effect runs. */
  const stagePinchTag = useSharedValue(0);

  const stageGesture = usePinchGesture({
    // The pinch DETECTOR exists to claim two-finger touches from the
    // pager; the zoom itself is driven from the raw touch frames below
    // (zoomTouchFrame — ONE tracker for scale AND translation, so a
    // fresh pinch is focal-anchored from its first frame).
    onBegin: () => {
      // A zoomed stream belongs to the OVERLAY's handlers; the stage
      // pinch may still receive it through the shared interceptor, and
      // acting on it would fight the overlay over the one tracker
      // (S10e video 13: single-finger pans froze into identity frames
      // against the stage's per-frame re-anchor).
      if (overlayOwnsStream.value) return;
      cancelAnimation(scale);
      cancelAnimation(tx);
      cancelAnimation(ty);
      zoomTracking.value = ZOOM_TRACKING_START;
    },
    // The pager loses the stream the INSTANT a second finger lands
    // (S23 phase-1 device pass, Tristan: waiting for the pinch
    // recognizer's span threshold let the native scroll fight the
    // first centimetres of every pinch — "almost forced to double tap
    // to zoom"). Activation is STILL the claim mechanism (S10e video
    // 13: zooming before the claim is what let the pager steal a
    // stream mid-zoom) — this only stops WAITING for the span
    // threshold: two fingers down on the stage can only ever mean
    // zoom, so the pinch is activated by hand and the native scroll
    // is cancelled by RNGH's own arbitration.
    // GestureStateManager.activate is a 'worklet' (v3), so no bridge
    // crossing happens here.
    onTouchesDown: (event) => {
      if (overlayOwnsStream.value) return;
      if (event.allTouches.length >= 2 && stagePinchTag.value !== 0) {
        GestureStateManager.activate(stagePinchTag.value);
      }
    },
    onTouchesCancel: () => {
      // The pager stole the stream — drop the anchor so nothing stale
      // survives into the next touch.
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesMove: (event) => {
      if (overlayOwnsStream.value) return;
      const step = zoomTouchFrame(
        zoomTracking.value,
        event.allTouches,
        // One finger on the stage belongs to the pager — and so does
        // the stream until the pinch ACTIVATES: activation is what
        // claims it from the native scroll (forced at two-fingers-down
        // above), and zooming before the claim let the pager steal the
        // stream mid-zoom (S10e video 13's per-photo first-pinch
        // freeze).
        event.state === State.ACTIVE && event.allTouches.length >= 2,
        scale.value,
        tx.value,
        ty.value,
        1,
        maxScale.value,
        stageW.value / 2,
        stageH.value / 2,
      );
      zoomTracking.value = step.tracking;
      if (step.transform === null) return;
      scale.value = step.transform.scale;
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, step.transform.scale);
      tx.value = clampPan(step.transform.x, bounds.maxX);
      ty.value = clampPan(step.transform.y, bounds.maxY);
    },
    onDeactivate: () => {
      if (overlayOwnsStream.value) return;
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    },
    // onFinalize (unlike onDeactivate) also fires on cancellation, so a
    // broken gesture can never strand the overlay barely above scale 1,
    // covering the pager.
    onFinalize: () => {
      if (overlayOwnsStream.value) return;
      // The anchor belongs to ONE touch stream: left standing, the next
      // two fingers down would resume mid-zoom from a stale base.
      zoomTracking.value = ZOOM_TRACKING_START;
      // Follows onBegin, so it fires for plain taps too — do nothing
      // when there was never a zoom to unwind (a tap's finalize
      // otherwise races the JS double-tap zoom and snaps it back).
      if (scale.value === 1 && savedScale.value === 1) return;
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    },
  });

  // The tag write is JS-side and idempotent; the worklet reads it.
  useEffect(() => {
    stagePinchTag.value = stageGesture.handlerTag;
  }, [stageGesture, stagePinchTag]);

  /* Pan + double-tap, attached to the zoom overlay, which only receives
   * touches while zoomed (animated pointerEvents) — so the pan never
   * competes with the pager's scroll. */
  const overlayPan = usePanGesture({
    // A SECOND pinch (fingers lifted, then pinching again) lands on the
    // overlay, whose detector has no pinch of its own — without this
    // link an off-centre two-finger touch can activate the pan first
    // and cancel the ancestor pinch, freezing the zoom level (codex
    // r50). Simultaneous restores the pre-split behavior where pan and
    // pinch shared one composition.
    simultaneousWith: stageGesture,
    minPointers: 1,
    maxPointers: 2,
    // Only the release VELOCITY still reads the averaged pointer (the
    // decay below); the translation itself is touch-position anchored
    // (onTouchesMove).
    averageTouches: true,
    onBegin: () => {
      // A finger landing mid-decay claims the photo wherever the decay
      // carried it — without this the next translation would snap back
      // to the pre-decay position.
      // The decay itself must STOP here (codex device-pass round):
      // left running it keeps moving the photo under the finger, and
      // the first pan update then snaps back to this snapshot.
      cancelAnimation(tx);
      cancelAnimation(ty);
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      // A fresh touch stream: a fresh anchor, and whether it turns into
      // a pinch is decided by the frames ahead of it (tracking.zoomed).
      zoomTracking.value = ZOOM_TRACKING_START;
      // Claim the stream: the stage pinch stands down until finalize.
      overlayOwnsStream.value = true;
    },
    onTouchesCancel: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    // The whole zoomed pinch-pan runs off the raw touch frames
    // (zoomTouchFrame — m0.8.6 §10's touch-position anchoring, unified
    // with the pinch in m0.8.8): a touch-set change re-anchors (down/up
    // force it; the count check catches a same-count swap between move
    // frames), so everything stays continuous across finger changes.
    onTouchesDown: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesUp: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesMove: (event) => {
      const step = zoomTouchFrame(
        zoomTracking.value,
        event.allTouches,
        // Two fingers drive unconditionally (a pinch must be focal-
        // anchored from its FIRST frame — never gated on the pan
        // gesture's activation distance); a single finger waits for
        // activation so a tap's jitter cannot nudge the photo.
        scale.value > 1 && (event.allTouches.length >= 2 || event.state === State.ACTIVE),
        scale.value,
        tx.value,
        ty.value,
        1,
        maxScale.value,
        stageW.value / 2,
        stageH.value / 2,
      );
      zoomTracking.value = step.tracking;
      if (step.transform === null) return;
      scale.value = step.transform.scale;
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, step.transform.scale);
      tx.value = clampPan(step.transform.x, bounds.maxX);
      ty.value = clampPan(step.transform.y, bounds.maxY);
    },
    onDeactivate: (event) => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      if (scale.value <= 1) return;
      // A stream that ZOOMED ends as a pinch, not a flick — momentum
      // out of it flung the photo on every two-finger zoom (round 5).
      if (zoomTracking.value.zoomed) return;
      // The release keeps the flick's momentum (§10 check 9 round 3 —
      // the standard gallery feel), decaying inside the same pan
      // bounds the drag was clamped to. Sub-flick velocities are noise
      // (FLICK_MIN_VELOCITY): a hold-then-lift moves nothing.
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
      if (Math.abs(event.velocityX) >= FLICK_MIN_VELOCITY) {
        tx.value = withDecay(
          { velocity: event.velocityX, clamp: [-bounds.maxX, bounds.maxX] },
          () => {
            savedTx.value = tx.value;
          },
        );
      }
      if (Math.abs(event.velocityY) >= FLICK_MIN_VELOCITY) {
        ty.value = withDecay(
          { velocity: event.velocityY, clamp: [-bounds.maxY, bounds.maxY] },
          () => {
            savedTy.value = ty.value;
          },
        );
      }
    },
    // Overlay streams release their claim and unwind a barely-above-1
    // zoom themselves — the stage's finalize (which used to do it) is
    // gated off while the overlay owns the stream. onFinalize also
    // fires on cancellation, so a broken stream can never keep the
    // claim (which would dead-stick the stage pinch).
    onFinalize: () => {
      overlayOwnsStream.value = false;
      zoomTracking.value = ZOOM_TRACKING_START;
      if (scale.value === 1 && savedScale.value === 1) return;
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    },
  });
  // m0.7 (#18): double-tap resets zoom. The timing animation carries
  // scale back to exactly 1, which is what hides the overlay.
  const overlayDoubleTap = useTapGesture({
    numberOfTaps: 2,
    // A walking pan's quick dabs must never read as a double tap
    // (device pass, 2026-08-19: alternating thumbs zoomed the photo
    // out mid-shove). The reset requires the pan to FAIL: a true
    // double tap never drags past the pan's activation distance, so
    // the pan fails at finger-up and the tap proceeds — while every
    // dab of a walk activates the pan and blocks the tap outright.
    requireToFail: overlayPan,
    onDeactivate: () => {
      scale.value = withTiming(1);
      savedScale.value = 1;
      tx.value = withTiming(0);
      ty.value = withTiming(0);
      savedTx.value = 0;
      savedTy.value = 0;
    },
  });
  const zoomedGesture = useSimultaneousGestures(overlayPan, overlayDoubleTap);

  // The overlay's whole lifecycle is UI-thread-derived from `scale`: it
  // fades in the moment a pinch pushes past 1 and swallows the pager's
  // touches (pointerEvents) for exactly as long as it is visible. The
  // pager needs no scrollEnabled toggle — while zoomed it simply cannot
  // be reached.
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  const zoomOverlayStyle = useAnimatedStyle(() => ({
    opacity: scale.value > 1 ? 1 : 0,
  }));
  // importantForAccessibility (codex r50): the always-mounted overlay is
  // hidden by opacity + pointerEvents while unzoomed, but would
  // otherwise stay in the accessibility tree.
  const zoomOverlayProps = useAnimatedProps(() => ({
    pointerEvents: (scale.value > 1 ? 'auto' : 'none') as 'auto' | 'none',
    importantForAccessibility: (scale.value > 1 ? 'auto' : 'no-hide-descendants') as
      'auto' | 'no-hide-descendants',
  }));

  return {
    scale,
    savedScale,
    tx,
    ty,
    savedTx,
    savedTy,
    stageW,
    stageH,
    maxScale,
    imageAspect,
    zoomTracking,
    overlayOwnsStream,
    resetZoom,
    stageGesture,
    zoomedGesture,
    zoomStyle,
    zoomOverlayStyle,
    zoomOverlayProps,
  };
}

/** Everything a host may read or feed: the transform shared values
 * (useDoubleTapZoom and useStageRegionZoom consume subsets), the two
 * gesture compositions the view mounts, the derived animated
 * styles/props, and resetZoom (call it on photo change). */
export type MediaStageController = ReturnType<typeof useMediaStage>;

export interface MediaStageViewProps {
  controller: MediaStageController;
  /** Decoration (border, radius, background) for the OUTER frame — the
   * measured stage itself stays borderless (the rule in the header).
   * Omit for an undecorated stage (PhotoViewer). */
  frameStyle?: StyleProp<ViewStyle>;
  /** Fired after the internal stageW/stageH shared-value writes — for
   * hosts that also need the width as React state (the deck's pageW). */
  onStageLayout?: (width: number, height: number) => void;
  /** The photo the zoom overlay shows (usually the host's CURRENT item;
   * the deck passes its frozen view's photo). Null renders an empty
   * overlay. */
  overlayFor: { id: string; uri: string } | null;
  regionZoom: RegionZoomState;
  /** Extra identity gate ANDed into the base/patch source condition —
   * the deck passes `live current === frozen view current` so a unit
   * swap while zoomed can never blend two photos. Default true. */
  identityOk?: boolean;
  /** The opaque backdrop color of the zoom overlay's UNtransformed
   * layer (deck: colors.surface; viewer: '#000'). It covers the stage
   * by construction — on the transformed layer it was one rounding
   * error away from leaking the pager photo at the edge. */
  backdropColor: string;
  /** Bottom offset of the fail-soft notice (viewer clears its facts
   * panel with 96). */
  noticeBottom?: number;
  /** Rendered INSTEAD of the transformed image stack (the viewer's
   * dead-photo placeholder) — the backdrop and notice still apply. */
  deadContent?: React.ReactNode;
  /** Host chrome rendered inside the measured stage, above the overlay
   * (the deck's position/time badges + badge cluster; Compare's pane
   * label). Phase 6 replaces these with the declarative builder. */
  chrome?: React.ReactNode;
  /** The host content under the stage gestures — the pager block. */
  children?: React.ReactNode;
}

/** The stage tree: frame → intercepting detector → stage pinch →
 * measured borderless stage → children (pager) → overlay detector →
 * always-mounted zoom stack → chrome. Structure is DeckScreen's,
 * verbatim; the inline comments carry the load-bearing rationale. */
export function MediaStageView({
  controller,
  frameStyle,
  onStageLayout,
  overlayFor,
  regionZoom,
  identityOk = true,
  backdropColor,
  noticeBottom = 12,
  deadContent,
  chrome,
  children,
}: MediaStageViewProps) {
  const { stageW, stageH, imageAspect } = controller;
  const sourcesOk = identityOk && overlayFor !== null && regionZoom.forPhotoId === overlayFor.id;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    stageW.value = width;
    stageH.value = height;
    onStageLayout?.(width, height);
  };
  return (
    <View style={[styles.frame, frameStyle]}>
      <InterceptingGestureDetector>
        <VirtualGestureDetector gesture={controller.stageGesture}>
          <View style={styles.stage} onLayout={onLayout}>
            {children}
            {/* Always mounted; visibility + touchability are UI-thread
                animated props. The image is the same URI the pager page
                shows, so expo-image serves it from cache rather than
                decoding twice. */}
            <VirtualGestureDetector gesture={controller.zoomedGesture}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: backdropColor },
                  controller.zoomOverlayStyle,
                ]}
                animatedProps={controller.zoomOverlayProps}
              >
                {deadContent ?? (
                  <Animated.View style={[StyleSheet.absoluteFill, controller.zoomStyle]}>
                    <StagePaneLayers
                      uri={overlayFor?.uri}
                      recyclingKey={overlayFor ? `zoom-${overlayFor.id}` : undefined}
                      regionZoom={regionZoom}
                      sourcesOk={sourcesOk}
                      onSourceLoad={(width, height) => {
                        imageAspect.value = width / height;
                      }}
                    />
                  </Animated.View>
                )}
                {/* Zoom-time fail-soft notice (m0.8.8 close-out): the
                    region pipeline rejected this photo (unreadable EXIF,
                    mirrored orientation, unopenable format), so depth
                    shows cached-image quality — say why, exactly when the
                    user would wonder. On the UNtransformed layer so it
                    never scales; visible only while the overlay is
                    (zoomed). DELIBERATELY un-hideable: it is a fidelity
                    claim, not decoration (m0.9 grilling M19) — the
                    Overlay settings and the eye never govern it. */}
                {regionZoom.failed &&
                  overlayFor !== null &&
                  regionZoom.forPhotoId === overlayFor.id && (
                    <ZoomFailNotice bottom={noticeBottom} />
                  )}
              </Animated.View>
            </VirtualGestureDetector>
            {chrome}
          </View>
        </VirtualGestureDetector>
      </InterceptingGestureDetector>
    </View>
  );
}

/** One pane's image stack: the at-rest URI image, the dwell-warmed
 * region-zoom BASE, and the two double-buffered PATCH slots. ALWAYS
 * MOUNTED, props-only updates — mounting a view here mid-gesture breaks
 * RNGH's pointer tracking (useRegionZoom header). `sourcesOk` is the
 * identity gate (host live-vs-frozen AND `forPhotoId === id`): sources
 * go undefined on any mismatch, so no frame can blend two photos.
 * Rendered inside the caller's transformed layer (MediaStageView's
 * overlay; Compare's stacked pair uses it once per pane). */
export function StagePaneLayers({
  uri,
  recyclingKey,
  regionZoom,
  sourcesOk,
  onSourceLoad,
}: {
  uri: string | undefined;
  recyclingKey: string | undefined;
  regionZoom: RegionZoomState;
  sourcesOk: boolean;
  /** JS → shared-value aspect feed (the safe bridge direction); omit on
   * surfaces that clamp to the stage rect (Compare). */
  onSourceLoad?: (width: number, height: number) => void;
}) {
  return (
    <>
      <Image
        source={uri ? { uri } : undefined}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        recyclingKey={recyclingKey}
        onLoad={
          onSourceLoad
            ? (event) => {
                const { width, height } = event.source;
                if (width > 0 && height > 0) onSourceLoad(width, height);
              }
            : undefined
        }
      />
      <Image
        source={sourcesOk ? (regionZoom.baseSource ?? undefined) : undefined}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={0}
        allowDownscaling={false}
      />
      {regionZoom.patchSlots.map((slot, slotIndex) => (
        <Image
          key={slotIndex}
          source={sourcesOk ? (slot?.source ?? undefined) : undefined}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: slot?.width ?? 1,
            height: slot?.height ?? 1,
            // Transform, not left/top: layout snaps to the pixel grid,
            // and a deep-zoom scale magnified that snap into a visible
            // content jump on every apply (S10e video 6).
            transform: [{ translateX: slot?.left ?? 0 }, { translateY: slot?.top ?? 0 }],
            zIndex: slot?.z ?? 0,
            opacity: slot ? 1 : 0,
          }}
          contentFit="fill"
          transition={0}
          allowDownscaling={false}
        />
      ))}
    </>
  );
}

/** The zoom-time fail-soft notice (m0.8.8 close-out): the region
 * pipeline rejected this photo (unreadable EXIF, mirrored orientation,
 * unopenable format), so depth shows cached-image quality — say why,
 * exactly when the user would wonder. Rendered on an UNtransformed
 * layer so it never scales. DELIBERATELY un-hideable: it is a fidelity
 * claim, not decoration (m0.9 grilling M19) — the Overlay settings and
 * the eye never govern it. */
export function ZoomFailNotice({ bottom = 12 }: { bottom?: number }) {
  return (
    <View style={[styles.zoomNotice, { bottom }]} pointerEvents="none">
      <Text style={styles.zoomNoticeText}>
        Full detail unavailable — image file can't be fully read
      </Text>
    </View>
  );
}

/** Compare's SINGLE-DRIVER mode: no pager to protect and no zoom-only
 * overlay (the stacked pair must flip at every zoom level via the JS
 * Pressable underneath), so pinch + pan compose on the stage detector
 * and the PAN handler is the one driver for scale AND translation —
 * two fingers drive from scale 1 unconditionally. Pan bounds clamp to
 * the per-axis UNION of the two photos' rendered edges (pairPanBounds
 * — the stacked pair shares one transform, so the clamp must satisfy
 * both photos at once; equal aspects reduce to the deck's panBounds;
 * the stage rectangle survives only as the both-unknown fallback).
 *
 * The m0.9 phase-1 drift fixes are in (the deck's stream-safety rules
 * applied to this structure): both handlers reset their anchor on
 * `onTouchesCancel`; the pan's `onFinalize` owns the end-of-stream
 * anchor reset and the ≤1.02 unwind (it follows onBegin, so it fires
 * for every stream, cancellation included — a broken stream can never
 * strand a barely-above-1 zoom); the pinch's finalize keeps its
 * PARTIAL reset (the `zoomed` marker must survive — the simultaneous
 * pan outlives the pinch and reads it for no-fling-after-zoom, codex
 * m0.8.8 r1). */
export function useMediaStageSingleDriver() {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);
  /** The dynamic zoom ceiling (useStageMaxScale; Compare feeds both
   * panes and gets the MAX of the pair). */
  const maxScale = useSharedValue<number>(MAX_SCALE_FLOOR);
  /** The two panes' photo aspects (width/height, from each pane's
   * at-rest image onLoad — JS → shared value, the safe direction).
   * 0 = not loaded. Pans clamp to the per-axis UNION of the two
   * photos' rendered edges (pairPanBounds; the S23 pass showed the
   * old stage-rect clamp panning a letterboxed photo fully into the
   * background). */
  const aspectA = useSharedValue(0);
  const aspectB = useSharedValue(0);
  // ONE tracker for the whole pinch-pan (zoomTouchFrame, m0.8.8).
  const zoomTracking = useSharedValue(ZOOM_TRACKING_START);

  const pinchGesture = usePinchGesture({
    // The pinch DETECTOR keeps the two-finger arbitration; the zoom
    // itself is driven from the PAN handler's raw touch frames below.
    onBegin: () => {
      cancelAnimation(scale);
      cancelAnimation(tx);
      cancelAnimation(ty);
    },
    onTouchesCancel: () => {
      // A stolen stream must not leave a stale anchor (the deck's
      // rule); the ZOOMED marker survives for the pan's fling check.
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    // onFinalize also fires when a pinch is CANCELLED, which onDeactivate
    // does not — the anchor has to clear either way. The ZOOMED marker
    // survives (codex m0.8.8 r1): the simultaneous pan outlives the
    // pinch (it deactivates on the LAST finger, the pinch finalizes
    // earlier), and its no-fling-after-zoom check reads this flag — a
    // full reset here let a scale-changing stream end as a flick. The
    // pan's own onBegin starts the next stream's tracking fresh.
    onFinalize: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    // Save-only (the deck's shape): the end-of-stream ≤1.02 unwind
    // belongs to the pan's onFinalize below, which fires for every
    // stream — cancelled ones included, which this never did.
    onDeactivate: () => {
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    },
  });

  const panGesture = usePanGesture({
    minPointers: 1,
    maxPointers: 2,
    // Only the release VELOCITY still reads the averaged pointer (the
    // decay below); the translation itself is touch-position anchored
    // (onTouchesMove).
    averageTouches: true,
    onBegin: () => {
      // A finger landing mid-decay claims the photo wherever the decay
      // carried it (DeckScreen carries the same rule).
      // The decay itself must STOP here (codex device-pass round):
      // left running it keeps moving the photo under the finger, and
      // the first pan update then snaps back to this snapshot.
      cancelAnimation(tx);
      cancelAnimation(ty);
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      // A fresh touch stream: a fresh anchor, and whether it turns into
      // a pinch is decided by the frames ahead of it (tracking.zoomed).
      zoomTracking.value = ZOOM_TRACKING_START;
    },
    onTouchesCancel: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    // The whole pinch-pan runs off the raw touch frames (zoomTouchFrame
    // — m0.8.6 §10's touch-position anchoring, unified with the pinch
    // in m0.8.8): a touch-set change re-anchors (down/up force it; the
    // count check catches a same-count swap between move frames), so
    // everything stays continuous across finger changes.
    onTouchesDown: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesUp: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesMove: (event) => {
      const step = zoomTouchFrame(
        zoomTracking.value,
        event.allTouches,
        // Two fingers drive unconditionally — the initial pinch from
        // scale 1 included (no pager to protect); a single finger needs
        // the zoom AND activation, so a flip-tap's jitter cannot nudge
        // the photo.
        event.allTouches.length >= 2 || (scale.value > 1 && event.state === State.ACTIVE),
        scale.value,
        tx.value,
        ty.value,
        1,
        maxScale.value,
        stageW.value / 2,
        stageH.value / 2,
      );
      zoomTracking.value = step.tracking;
      if (step.transform === null) return;
      scale.value = step.transform.scale;
      // Union-of-pair clamp (see the hook header and pairPanBounds).
      const bounds = pairPanBounds(
        stageW.value,
        stageH.value,
        aspectA.value,
        aspectB.value,
        step.transform.scale,
      );
      tx.value = clampPan(step.transform.x, bounds.maxX);
      ty.value = clampPan(step.transform.y, bounds.maxY);
    },
    onDeactivate: (event) => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      if (scale.value <= 1) return;
      // A stream that ZOOMED ends as a pinch, not a flick — momentum
      // out of it flung the photo on every two-finger zoom (round 5).
      if (zoomTracking.value.zoomed) return;
      // The release keeps the flick's momentum — the standard gallery
      // feel (m0.8.5 §10 check 9 round 3), inside the same bounds the
      // drag was clamped to. Sub-flick velocities are lift-off noise
      // (FLICK_MIN_VELOCITY): a hold-then-lift moves nothing.
      const bounds = pairPanBounds(
        stageW.value,
        stageH.value,
        aspectA.value,
        aspectB.value,
        scale.value,
      );
      if (Math.abs(event.velocityX) >= FLICK_MIN_VELOCITY) {
        tx.value = withDecay(
          { velocity: event.velocityX, clamp: [-bounds.maxX, bounds.maxX] },
          () => {
            savedTx.value = tx.value;
          },
        );
      }
      if (Math.abs(event.velocityY) >= FLICK_MIN_VELOCITY) {
        ty.value = withDecay(
          { velocity: event.velocityY, clamp: [-bounds.maxY, bounds.maxY] },
          () => {
            savedTy.value = ty.value;
          },
        );
      }
    },
    // The pan follows every stream (minPointers 1), so ITS finalize is
    // the true end-of-stream hook: clear the anchor, and unwind a
    // barely-above-1 zoom — onFinalize fires on cancellation too, so a
    // broken stream can never strand the stage. The never-zoomed
    // early-out keeps a plain tap's finalize from racing a JS-driven
    // withTiming reset (the deck's guard).
    onFinalize: () => {
      zoomTracking.value = ZOOM_TRACKING_START;
      if (scale.value === 1 && savedScale.value === 1) return;
      if (scale.value <= 1.02) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    },
  });

  const composedGesture = useSimultaneousGestures(pinchGesture, panGesture);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return {
    scale,
    savedScale,
    tx,
    ty,
    savedTx,
    savedTy,
    stageW,
    stageH,
    maxScale,
    aspectA,
    aspectB,
    zoomTracking,
    composedGesture,
    zoomStyle,
  };
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  stage: { flex: 1 },
  /** The zoom-time fail-soft notice (see the overlay render comment). */
  zoomNotice: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  zoomNoticeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
});
