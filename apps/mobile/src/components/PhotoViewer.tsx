/**
 * THE standard full-screen photo viewer (m0.8 gate 5): one component for
 * deck browse, progress grids, history rows and the queue screens.
 * Horizontal paging over the host's loaded items, pinch-zoom with
 * one-finger pan + double-tap reset (the deck's gesture language), and a
 * per-photo decision-detail panel — the home for facts the small badges
 * only hint at (state + hint, time-attached grouping, organize intents
 * with their full album paths, queued and carried share/favourite
 * facts). "Change decision"
 * opens the standard StateEditorSheet; its writes bubble up through
 * `onChanged` so hosts reload.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GestureHandlerRootView,
  InterceptingGestureDetector,
  State,
  useNativeGesture,
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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import { getPhotoFacts, type PhotoFacts } from '../db/store';
import { decodeOrganizeTarget } from '../db/actions';
import { isInShareQueue } from '../db/shareStore';
import { classifyPhotoState } from '../lib/progress';
import { dayKey, labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { formatClockSeconds, plural } from '../lib/format';
import { badgesHidden, setBadgesHidden, subscribeBadgesHidden } from '../lib/badgePrefs';
import { colors, useTheme } from '../theme';
import { VERDICT_META } from './progress/stateMeta';
import { StateEditorSheet } from './progress/StateEditorSheet';
import type { GridPhoto } from './progress/PhotoStateGrid';
import { useDoubleTapZoom } from './useDoubleTapZoom';
import { useRegionZoom } from './useRegionZoom';
import { MAX_SCALE_FLOOR, maxScaleFor } from '../lib/regionZoom';
import {
  FLICK_MIN_VELOCITY,
  ZOOM_TRACKING_START,
  panBounds,
  zoomTouchFrame,
} from '../lib/zoomTarget';

/** What a host must know about each photo it shows. */
export interface ViewerItem {
  id: string;
  uri: string;
  takenAt: number;
  /** Capture day (m0.8.6 change 5): null = tracked and honestly undated
   * — the top bar says "Unknown day" and shows no clock, because
   * `takenAt` is then the mtime fallback and rendering it would turn a
   * soft claim into a confident lie. undefined = the host has no DB
   * claim (untracked photo); the bar falls back to `takenAt`, refined by
   * the facts row once it loads. */
  day?: string | null;
}

// The max zoom is DYNAMIC per photo (m0.8.8, Tristan): enough to reach
// 1:1 physical pixels plus inspection headroom, between MAX_SCALE_FLOOR
// and MAX_SCALE_CEILING — a fixed 16 stopped BEFORE 1:1 on a 200MP
// photo, while deep fixed maxima on a 12MP photo are pure mush. `maxScaleFor` in
// lib/regionZoom.ts owns the formula; each surface carries it in a
// shared value the pinch clamp reads. panBounds clamps to the photo's
// own edges, so a deep zoom cannot wander off the content.

function clampPan(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

export function PhotoViewer({
  items,
  initialIndex,
  onClose,
  onChanged,
}: {
  items: ViewerItem[];
  initialIndex: number;
  onClose: () => void;
  /** A state edit was written from the detail panel — reload the host. */
  onChanged?: () => void;
}) {
  const db = useSQLiteContext();
  // Viewer edits write SQLite directly (StateEditorSheet) — the review
  // queue must observe them even when the host only reloads local rows.
  const { refresh: refreshReview } = useReview();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [cursor, setCursor] = useState(Math.min(initialIndex, Math.max(0, items.length - 1)));
  // undefined = loading, null = never tracked.
  const [facts, setFacts] = useState<PhotoFacts | null | undefined>(undefined);
  const [factsFailed, setFactsFailed] = useState(false);
  const [shareQueued, setShareQueued] = useState(false);
  const [editing, setEditing] = useState<GridPhoto | null>(null);
  const [factsTick, setFactsTick] = useState(0);
  // The Deck header's eye, mirrored (vetted 2026-08-21): the viewer is
  // the other surface where badges visually compete with the photo, so
  // it carries a second access point to the SAME durable toggle.
  const [hideBadges, setHideBadges] = useState(badgesHidden);
  useEffect(() => subscribeBadgesHidden(setHideBadges), []);
  const listRef = useRef<FlatList<ViewerItem>>(null);

  const current: ViewerItem | null = items[cursor] ?? null;
  const currentId = current?.id ?? null;

  // The viewer is anchored to a PHOTO, not a position: a host reload can
  // reorder items (History reorders on activity_at), and the numeric
  // cursor would silently switch photos. The anchor updates ONLY on
  // user-driven navigation (mount, swipe) — a render must never re-derive
  // it from an already-reordered list, or the effect below compares the
  // wrong id and keeps the wrong position.
  const anchorIdRef = useRef<string | null>(items[initialIndex]?.id ?? null);
  useEffect(() => {
    const anchored = anchorIdRef.current;
    if (anchored === null) return;
    const index = items.findIndex((i) => i.id === anchored);
    setCursor((previous) => {
      const next = index >= 0 ? index : Math.min(previous, Math.max(0, items.length - 1));
      if (index < 0) anchorIdRef.current = items[next]?.id ?? null; // photo left — re-anchor
      if (next !== previous) {
        listRef.current?.scrollToOffset({ offset: next * width, animated: false });
      }
      return next;
    });
    // Only item-set changes re-anchor; swipes drive the cursor directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ------------------------------------------------------ pinch zoom
  // NO GESTURE CALLBACK MAY CROSS THE WORKLETS->JS BRIDGE — runOnJS from
  // a gesture worklet segfaults this build (SIGSEGV in AroundLock::utf8;
  // reanimated #9776, worklets 0.10.2 — see DeckScreen's bridge
  // comment). So "is the viewer zoomed?" lives ONLY in shared values,
  // and the overlay/panel react to `scale` via animated props.
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);
  /** Dynamic per-photo zoom ceiling (maxScaleFor) — shared value so the
   * pinch worklet clamps without touching the bridge. */
  const maxScale = useSharedValue<number>(MAX_SCALE_FLOOR);
  // Photo width / height, set by the overlay image's onLoad (JS → shared
  // value, the safe bridge direction). Pans clamp to the photo's own
  // rendered edges via panBounds — 0 means not yet loaded.
  const imageAspect = useSharedValue(0);
  // ONE tracker for the whole pinch-pan (zoomTouchFrame, m0.8.8 —
  // DeckScreen carries the rationale).
  const zoomTracking = useSharedValue(ZOOM_TRACKING_START);
  /** The overlay's handlers own the current touch stream — the stage
   * pinch (which can receive the same stream through the shared
   * interceptor) stands down completely while this is set. */
  const overlayOwnsStream = useSharedValue(false);
  const pagerGesture = useNativeGesture();

  // F22 (m0.8.8): the region-zoom pipeline for the current page — the
  // hook polls the shared values from JS (never runOnJS; see the bridge
  // comment above). The viewer is dwell-by-nature, so bases warm almost
  // immediately after a page settles.
  const regionStageSize = useCallback(
    () => ({ width: stageW.value, height: stageH.value }),
    [stageW, stageH],
  );
  const regionViewport = useCallback(
    () => ({ scale: scale.value, tx: tx.value, ty: ty.value }),
    [scale, tx, ty],
  );
  const regionZoom = useRegionZoom(
    currentId,
    current?.uri ?? null,
    current !== null,
    regionStageSize,
    regionViewport,
  );

  // The photo's real resolution sets its zoom ceiling; unknown keeps
  // the classic floor.
  useEffect(() => {
    maxScale.value = regionZoom.sourceSize
      ? maxScaleFor(
          stageW.value,
          stageH.value,
          regionZoom.sourceSize.width,
          regionZoom.sourceSize.height,
          PixelRatio.get(),
        )
      : MAX_SCALE_FLOOR;
  }, [regionZoom.sourceSize, maxScale, stageW, stageH]);

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

  // The stage detector is the PINCH ALONE. Pan + double-tap live on the
  // zoom overlay, which only receives touches while zoomed: DeckScreen's
  // two-detector split. The gesture hook keeps one stable gesture across
  // renders, which is what the old useMemo was buying by hand — a
  // gesture rebuilt while a touch is in flight is its own crash.
  const zoomGesture = usePinchGesture({
    simultaneousWith: pagerGesture,
    // The pinch DETECTOR exists to claim two-finger touches from the
    // pager; the zoom itself is driven from the raw touch frames below
    // (zoomTouchFrame — ONE tracker, DeckScreen carries the rationale).
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
        // claims it from the native scroll, and zooming before the
        // claim let the pager steal the stream mid-zoom (S10e video
        // 13's per-photo first-pinch freeze).
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
    // onFinalize also fires on cancellation — a broken gesture can never
    // strand the overlay barely above scale 1, covering the pager.
    onFinalize: () => {
      if (overlayOwnsStream.value) return;
      // The anchor belongs to ONE touch stream: left standing, the next
      // two fingers down would resume mid-zoom from a stale base.
      zoomTracking.value = ZOOM_TRACKING_START;
      // Follows onBegin, so it fires for plain taps too — do nothing
      // when there was never a zoom to unwind (DeckScreen's guard): a
      // tap's finalize otherwise races the JS double-tap zoom
      // (useDoubleTapZoom's withTiming from ~1) and snaps it back.
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

  /* Pan + double-tap on the zoom overlay — touchable only while zoomed
   * (animated pointerEvents), so the pan never competes with the pager. */
  const overlayPan = usePanGesture({
    // A SECOND pinch lands on the overlay, which has no pinch of its
    // own — without this link the pan can out-race and cancel the
    // ancestor pinch, freezing the zoom level (codex r50; DeckScreen
    // carries the same link).
    simultaneousWith: zoomGesture,
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
      // Claim the stream: the stage pinch stands down until finalize.
      overlayOwnsStream.value = true;
    },
    onTouchesCancel: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    // The whole zoomed pinch-pan runs off the raw touch frames
    // (zoomTouchFrame — m0.8.6 §10's touch-position anchoring, unified
    // with the pinch in m0.8.8; DeckScreen carries the rationale): a
    // touch-set change re-anchors (down/up force it; the count check
    // catches a same-count swap between move frames), so everything
    // stays continuous across finger changes.
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
        // anchored from its FIRST frame); a single finger waits for
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
      // The release keeps the flick's momentum — the standard gallery
      // feel (m0.8.5 §10 check 9 round 3), inside the same pan bounds.
      // Sub-flick velocities are lift-off noise (FLICK_MIN_VELOCITY): a
      // hold-then-lift moves nothing.
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
  // Double-tap resets zoom; the timing animation carries scale back to
  // exactly 1, which is what hides the overlay and unfreezes paging.
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

  // Zoomed-ness is derived from `scale` on the UI thread: the overlay
  // fades in past 1 and swallows the pager's touches for exactly as long
  // as it is visible; the facts panel does the inverse.
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  const zoomOverlayStyle = useAnimatedStyle(() => ({
    opacity: scale.value > 1 ? 1 : 0,
  }));
  // importantForAccessibility mirrors the facts panel below (codex r50):
  // the always-mounted overlay is hidden by opacity + pointerEvents while
  // unzoomed, but would otherwise stay in the accessibility tree.
  const zoomOverlayProps = useAnimatedProps(() => ({
    pointerEvents: (scale.value > 1 ? 'auto' : 'none') as 'auto' | 'none',
    importantForAccessibility: (scale.value > 1 ? 'auto' : 'no-hide-descendants') as
      'auto' | 'no-hide-descendants',
  }));
  const panelStyle = useAnimatedStyle(() => ({
    opacity: scale.value > 1 ? 0 : 1,
  }));
  // importantForAccessibility too: opacity 0 hides the panel from eyes
  // and pointerEvents from touch, but its "Change decision" Pressable
  // would otherwise stay focusable to TalkBack while invisible over the
  // zoomed photo (codex r50).
  const panelProps = useAnimatedProps(() => ({
    pointerEvents: (scale.value > 1 ? 'none' : 'auto') as 'auto' | 'none',
    importantForAccessibility: (scale.value > 1 ? 'no-hide-descendants' : 'auto') as
      'no-hide-descendants' | 'auto',
  }));

  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // ------------------------------------------------------ facts panel
  // F30 (m0.8.7): a RE-READ of the same photo keeps the previous facts
  // rendered, dimmed (`factsStale` on the panel) — clearing them here
  // unmounted the panel to "Loading…" and it visibly collapsed and
  // returned on every state-editor write. Only a photo CHANGE clears.
  const lastFactsIdRef = useRef<string | null>(null);
  const [factsStale, setFactsStale] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (currentId !== lastFactsIdRef.current) {
      lastFactsIdRef.current = currentId;
      setFacts(undefined);
      setShareQueued(false);
    }
    setFactsFailed(false);
    if (currentId) {
      setFactsStale(true);
      void Promise.all([getPhotoFacts(db, currentId), isInShareQueue(db, currentId)]).then(
        ([f, queued]) => {
          if (cancelled) return;
          setFacts(f);
          setShareQueued(queued);
          setFactsStale(false);
        },
        (error: unknown) => {
          // FAIL CLOSED with a retry (codex r10): an unhandled rejection
          // left the panel on "Loading…" forever with "Change decision"
          // unreachable. Tapping the failure line retries via factsTick.
          console.warn('[viewer] facts read failed:', String(error));
          if (!cancelled) {
            setFactsFailed(true);
            setFactsStale(false);
          }
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [db, currentId, factsTick]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!width) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / width);
      if (index !== cursor) {
        const clamped = Math.min(Math.max(0, index), items.length - 1);
        anchorIdRef.current = items[clamped]?.id ?? null; // user navigation moves the anchor
        setCursor(clamped);
      }
    },
    [width, cursor, items],
  );

  // Double-tap zooms to the tapped point — a Pressable press on the JS
  // thread, exactly like the deck's (the bridge comment above); there is
  // no single-tap action here. currentId scopes the tap window to one
  // photo (the hook serves every pager page).
  const onPagePress = useDoubleTapZoom(
    { scale, savedScale, tx, ty, savedTx, savedTy, stageW, stageH, imageAspect },
    undefined,
    currentId,
  );
  /** Photos whose load FAILED — a black stage says nothing, and the
   * one real way here is a file deleted outside Afterglow that no
   * reconcile has met yet (device pass, 2026-08-20). Named in place. */
  const [deadIds, setDeadIds] = useState<ReadonlySet<string>>(new Set());
  const renderPage = useCallback(
    ({ item }: { item: ViewerItem }) => (
      <Pressable style={{ width, height: '100%' }} onPress={onPagePress}>
        {deadIds.has(item.id) ? (
          <View style={styles.deadPage}>
            <MaterialCommunityIcons name="image-off-outline" size={44} color={colors.textDim} />
            <Text style={styles.deadText}>
              This photo can't be shown — it may have been deleted outside Afterglow.
            </Text>
          </View>
        ) : (
          <Image
            source={{ uri: item.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            recyclingKey={item.id}
            transition={40}
            onError={() => setDeadIds((old) => new Set(old).add(item.id))}
          />
        )}
      </Pressable>
    ),
    [width, onPagePress, deadIds],
  );

  const meta = facts ? VERDICT_META[classifyPhotoState({ state: facts.state })] : null;
  const organizeSuperseded = facts?.organize_applied_at != null && facts.organize_queued === 1;
  const factLines: {
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    text: string;
  }[] = [];
  if (facts) {
    // SUSPENDED (codex r6): a staged cull or trashed photo keeps its
    // action rows, but it is in no queue (STATE_MODEL.md — the badges
    // demote to carried for the same reason). The lines describe the
    // retained intent instead of claiming live queue membership; every
    // queue claim below routes through these.
    const suspended = facts.state === 'culled' || facts.state === 'trashed';
    const queued = (liveText: string, retainedText: string) =>
      suspended ? retainedText : liveText;
    // Favourite is DIRECTIONAL (STATE_MODEL.md): the queued row wins the
    // line while one waits — including a queued removal, under which the
    // carried heart must not show — else the resolved apply carries it
    // (FAVOURITE_HELD's resolved half), like the edit pair below.
    if (facts.favourite_queued === 1)
      factLines.push({
        icon: 'heart-outline',
        text: queued(
          'Favourite queued for gallery confirmation.',
          'Favourite request rides along — resumes if the photo is un-staged.',
        ),
      });
    else if (facts.favourite_queued === 0)
      factLines.push({
        icon: 'heart-off-outline',
        text: queued(
          'Favourite removal queued.',
          'Favourite removal rides along — resumes if the photo is un-staged.',
        ),
      });
    else if (facts.favourite_applied === 1)
      factLines.push({ icon: 'heart', text: 'Favourited in your gallery.' });
    if (facts.needs_edit === 1)
      // Edit stays IN its queue on a staged cull (m0.8.7, F21 point 1).
      factLines.push({ icon: 'pencil-outline', text: 'In the edit queue.' });
    if (facts.edit_completed_at != null)
      factLines.push({ icon: 'pencil', text: 'Was edited via the edit queue.' });
    if (shareQueued)
      // Share stays IN its queue on a staged cull (m0.8.7, F21 point 1).
      factLines.push({ icon: 'share-variant', text: 'In the share queue.' });
    // Carried share (codex r7): mirrors the edit pair above — the queued
    // line while the queue holds it, the resolved fact once it let go.
    else if (facts.share_carried === 1)
      factLines.push({ icon: 'share-variant', text: 'Was shared from the share queue.' });
    // The organize lines carry the FULL album path (codex r7): the
    // decision appendix promises it lives one long-press away, here. A
    // target-less queue row (m0.8.2 F6) keeps the pathless copy.
    const pendingAlbum = decodeOrganizeTarget(facts.organize_target)?.path ?? null;
    const appliedAlbum = decodeOrganizeTarget(facts.organize_applied_target)?.path ?? null;
    if (facts.organize_applied_at != null) {
      const movedOnce = appliedAlbum ? `Moved to ${appliedAlbum} once` : 'Moved to an album once';
      const newerMove = pendingAlbum ? `a newer move to ${pendingAlbum}` : 'a newer move';
      factLines.push({
        icon: organizeSuperseded ? 'folder-clock' : 'folder-move',
        text: organizeSuperseded
          ? // codex r7: the superseded branch bypassed the suspended
            // wording, claiming a live pending move on a staged cull.
            queued(
              `${movedOnce}, but ${newerMove} is still pending — the shown album is superseded until it applies.`,
              `${movedOnce}, and ${newerMove} rides along — back in the queue if the photo is un-staged.`,
            )
          : appliedAlbum
            ? `Moved to ${appliedAlbum}.`
            : 'Moved to an album.',
      });
    } else if (facts.organize_queued === 1)
      factLines.push({
        icon: 'folder-clock',
        text: pendingAlbum
          ? queued(
              `Album move queued → ${pendingAlbum}`,
              `Album move to ${pendingAlbum} rides along — back in the queue if the photo is un-staged.`,
            )
          : queued(
              'Album move queued.',
              'Album move rides along — back in the queue if the photo is un-staged.',
            ),
      });
    // time_attached is deliberately NOT surfaced (m0.8.2): internal scan
    // quality the user cannot act on; the scan rewrites it once
    // embeddings land (docs/STATE_MODEL.md).
    if (facts.not_related_count > 0)
      factLines.push({
        icon: 'image-move',
        text: `You marked it not related to ${plural(facts.not_related_count, 'photo')} — it never groups with them.`,
      });
  }

  if (!current) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A native Modal is its own root — RNGH gestures inside it need
          their own GestureHandlerRootView on Android. */}
      <GestureHandlerRootView style={styles.root}>
        {/* VIRTUAL detectors under one intercepting host — see
            DeckScreen for why: v3's plain GestureDetector is a HOST
            component, and neither the pager's native scroll nor the
            always-mounted overlay's ANIMATED pointerEvents survives one
            sitting above them. */}
        <InterceptingGestureDetector>
          <VirtualGestureDetector gesture={zoomGesture}>
            <View
              style={styles.stage}
              onLayout={(event) => {
                stageW.value = event.nativeEvent.layout.width;
                stageH.value = event.nativeEvent.layout.height;
              }}
            >
              <VirtualGestureDetector gesture={pagerGesture}>
                <FlatList
                  ref={listRef}
                  data={items}
                  keyExtractor={(i) => i.id}
                  renderItem={renderPage}
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  initialScrollIndex={cursor}
                  getItemLayout={(_data, index) => ({
                    length: width,
                    offset: width * index,
                    index,
                  })}
                  onMomentumScrollEnd={onMomentumEnd}
                />
              </VirtualGestureDetector>
              {/* Always mounted; visibility + touchability are UI-thread
                animated props. Same URI as the pager page underneath, so
                expo-image serves it from cache. */}
              <VirtualGestureDetector gesture={zoomedGesture}>
                {/* The opaque backdrop lives on this UNtransformed layer —
                  on the transformed one it was one rounding error away
                  from letting the pager's photo peek out at the edge
                  when the clamp sits exactly at the coverage bound (see
                  DeckScreen). The photo transforms INSIDE it. */}
                <Animated.View
                  style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, zoomOverlayStyle]}
                  animatedProps={zoomOverlayProps}
                >
                  {deadIds.has(current.id) ? (
                    // A dead page double-tapped into zoom must keep its
                    // explanation (codex r7): the overlay's plain black
                    // stage over the same failed URI recreated exactly
                    // what the placeholder exists to prevent. Rendered
                    // on the UNtransformed layer so it stays legible.
                    <View style={styles.deadPage}>
                      <MaterialCommunityIcons
                        name="image-off-outline"
                        size={44}
                        color={colors.textDim}
                      />
                      <Text style={styles.deadText}>
                        This photo can't be shown — it may have been deleted outside Afterglow.
                      </Text>
                    </View>
                  ) : (
                    <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>
                      <Image
                        source={{ uri: current.uri }}
                        style={StyleSheet.absoluteFill}
                        contentFit="contain"
                        recyclingKey={`zoom-${current.id}`}
                        onLoad={(event) => {
                          const { width, height } = event.source;
                          if (width > 0 && height > 0) imageAspect.value = width / height;
                        }}
                      />
                      {/* F22: dwell-warmed base + double-buffered patch
                          slots — ALWAYS MOUNTED, props-only updates
                          (useRegionZoom header: a mid-gesture mount
                          breaks RNGH pointer tracking). forPhotoId gate
                          (codex round 2): a host reload can reorder the
                          live item array while zoomed, swapping
                          `current` one commit before the hook's effect
                          clears the old photo's sources — the gate
                          blanks that frame instead of blending photos
                          (DeckScreen carries the same gate). */}
                      <Image
                        source={
                          regionZoom.forPhotoId === current.id
                            ? (regionZoom.baseSource ?? undefined)
                            : undefined
                        }
                        style={StyleSheet.absoluteFill}
                        contentFit="contain"
                        transition={0}
                        allowDownscaling={false}
                      />
                      {regionZoom.patchSlots.map((slot, slotIndex) => (
                        <Image
                          key={slotIndex}
                          source={
                            regionZoom.forPhotoId === current.id
                              ? (slot?.source ?? undefined)
                              : undefined
                          }
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            width: slot?.width ?? 1,
                            height: slot?.height ?? 1,
                            // Transform, not left/top: layout snaps to the pixel
                            // grid, and a deep-zoom scale magnified that snap into
                            // a visible content jump on every apply (S10e video 6).
                            transform: [
                              { translateX: slot?.left ?? 0 },
                              { translateY: slot?.top ?? 0 },
                            ],
                            zIndex: slot?.z ?? 0,
                            opacity: slot ? 1 : 0,
                          }}
                          contentFit="fill"
                          transition={0}
                          allowDownscaling={false}
                        />
                      ))}
                    </Animated.View>
                  )}
                  {/* Zoom-time fail-soft notice (DeckScreen's zoomNotice
                      comment): the region pipeline rejected this photo —
                      depth is cached-image quality; say why. m0.9
                      metadata-corner redesign reviews it. */}
                  {regionZoom.failed && regionZoom.forPhotoId === current.id && (
                    <View style={styles.zoomNotice} pointerEvents="none">
                      <Text style={styles.zoomNoticeText}>
                        Full detail unavailable — image file can't be fully read
                      </Text>
                    </View>
                  )}
                </Animated.View>
              </VirtualGestureDetector>
            </View>
          </VirtualGestureDetector>
        </InterceptingGestureDetector>

        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.closeButton} hitSlop={8} onPress={onClose}>
            <MaterialCommunityIcons name="close" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.topTitle}>
            {(() => {
              // Date honesty (m0.8.6 change 5): the facts row is the
              // authority once loaded (it self-heals a rescued photo the
              // host mislabeled); while loading — or when no row exists
              // (untracked) — the host's own day claim. A NULL day =
              // honestly undated — name the unknown and print NO clock
              // (takenAt is the mtime fallback there).
              const day = facts != null ? facts.day : current.day;
              if (day === null) return labelForDayKey(UNDATED_DAY_KEY);
              // taken_at self-heals from the facts row too: a host that
              // mislabeled a rescued photo with its mtime is corrected
              // the moment the row loads.
              const at = facts != null ? facts.taken_at : current.takenAt;
              return `${labelForDayKey(day ?? dayKey(at))} · ${formatClockSeconds(at)}`;
            })()}
          </Text>
          <Pressable
            style={styles.closeButton}
            hitSlop={8}
            onPress={() => void setBadgesHidden(db, !badgesHidden())}
            accessibilityLabel={hideBadges ? 'Show photo badges' : 'Hide photo badges'}
          >
            <MaterialCommunityIcons
              name={hideBadges ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color={colors.textDim}
            />
          </Pressable>
          <Text style={styles.topIndex}>
            {cursor + 1}/{items.length}
          </Text>
        </View>

        <Animated.View
          style={[styles.panel, { paddingBottom: insets.bottom + 12 }, panelStyle]}
          animatedProps={panelProps}
        >
          {meta && facts ? (
            // F30: dimmed while a re-read is in flight — the previous
            // facts stay mounted instead of collapsing to "Loading…".
            // A FAILED re-read keeps them too, but visibly stale and
            // non-interactive (codex m0.8.7 r1): editing against facts
            // the read could not confirm would write on stale truth.
            <View style={factsStale || factsFailed ? styles.factsStale : null}>
              <View style={styles.stateLine}>
                <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                <Text style={styles.stateLabel}>{meta.label}</Text>
              </View>
              {factLines.map((line) => (
                <View key={line.icon + line.text} style={styles.factLine}>
                  <MaterialCommunityIcons name={line.icon} size={16} color={colors.textDim} />
                  <Text style={styles.factText}>{line.text}</Text>
                </View>
              ))}
              {factsFailed ? (
                <Pressable onPress={() => setFactsTick((t) => t + 1)}>
                  <Text style={styles.factText}>
                    Could not refresh this photo's details — shown as last read. Tap to retry.
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.editState}
                  onPress={() =>
                    setEditing({
                      id: facts.asset_id,
                      uri: facts.uri,
                      takenAt: facts.taken_at,
                      day: facts.day,
                      effective: classifyPhotoState({ state: facts.state }),
                      dbState: facts.state,
                    })
                  }
                >
                  <MaterialCommunityIcons name="pencil-outline" size={18} color={theme.accent} />
                  <Text style={[styles.editStateText, { color: theme.accent }]}>
                    Change decision
                  </Text>
                </Pressable>
              )}
            </View>
          ) : factsFailed ? (
            <Pressable onPress={() => setFactsTick((t) => t + 1)}>
              <Text style={styles.factText}>
                Could not read this photo's details just now — tap to retry.
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.factText}>
              {facts === null
                ? 'Not tracked yet — it enters review when the scan reaches it.'
                : 'Loading…'}
            </Text>
          )}
        </Animated.View>

        <StateEditorSheet
          photo={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setFactsTick((t) => t + 1);
            void refreshReview().catch(() => {});
            onChanged?.();
          }}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  deadPage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  deadText: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  /** The zoom-time fail-soft notice (DeckScreen's zoomNotice). */
  zoomNotice: {
    position: 'absolute',
    bottom: 96,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  zoomNoticeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  root: { flex: 1, backgroundColor: '#000' },
  stage: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  topIndex: { color: colors.textDim, fontSize: 13, fontVariant: ['tabular-nums'] },
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  stateLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  swatch: { width: 12, height: 12, borderRadius: 4 },
  stateLabel: { color: colors.text, fontSize: 15, fontWeight: '800' },
  stateHint: { color: colors.textDim, fontSize: 12, flexShrink: 1 },
  factLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  factText: { color: colors.textDim, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  factsStale: { opacity: 0.5 },
  editState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
  },
  editStateText: { fontSize: 14, fontWeight: '700' },
});
