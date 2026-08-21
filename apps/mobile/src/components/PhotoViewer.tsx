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
import { formatClockSeconds } from '../lib/format';
import { colors, useTheme } from '../theme';
import { VERDICT_META } from './progress/stateMeta';
import { StateEditorSheet } from './progress/StateEditorSheet';
import type { GridPhoto } from './progress/PhotoStateGrid';
import { useDoubleTapZoom } from './useDoubleTapZoom';
import {
  PAN_TRACKING_START,
  PINCH_TRACKING_START,
  panBounds,
  panFrame,
  pinchFrame,
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

// 16× (Tristan, 2026-08-04). Past 1:1 pixels by design: a 50 MP frame
// reaches one source pixel per screen pixel at ~5.7× on a 1440 px-wide
// phone, so the top of this range magnifies interpolation rather than
// revealing detail — wanted for inspecting a focus point, not for
// judging sharpness. panBounds clamps to the photo's own edges, so a
// deep zoom cannot wander off the content.
const MAX_SCALE = 16;

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
  // Photo width / height, set by the overlay image's onLoad (JS → shared
  // value, the safe bridge direction). Pans clamp to the photo's own
  // rendered edges via panBounds — 0 means not yet loaded.
  const imageAspect = useSharedValue(0);
  // A pinch must prove itself before it may change the zoom (see
  // lib/zoomTarget PINCH_ENGAGE_DELTA): these carry that decision, and
  // the raw scale it was made at, across the gesture's frames.
  const pinchTracking = useSharedValue(PINCH_TRACKING_START);
  /** This touch stream actually CHANGED the zoom — its release is a
   * pinch ending, not a flick, so the pan decay stays out of it
   * (DeckScreen carries the same rule). */
  const pinchZoomed = useSharedValue(false);
  // The touch-position pan's anchor + base (m0.8.6 §10, lib/zoomTarget
  // panFrame): translation is derived from the fingers' absolute focal
  // position against these, re-anchored on every touch-set change, so
  // panning stays continuous while two thumbs walk across the photo.
  const panTracking = useSharedValue(PAN_TRACKING_START);
  const pagerGesture = useNativeGesture();

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
    onUpdate: (event) => {
      // pinchFrame carries engagement AND finger-change re-anchoring
      // (§10 check 9): a finger landing or lifting mid-gesture holds
      // the zoom instead of leaping with the new finger distance.
      const step = pinchFrame(
        pinchTracking.value,
        event.scale,
        event.numberOfPointers,
        scale.value,
      );
      pinchTracking.value = step.tracking;
      if (step.scale === null) return;
      pinchZoomed.value = true;
      scale.value = Math.min(MAX_SCALE, Math.max(1, step.scale));
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
      tx.value = clampPan(tx.value, bounds.maxX);
      ty.value = clampPan(ty.value, bounds.maxY);
    },
    onDeactivate: () => {
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    },
    // onFinalize also fires on cancellation — a broken gesture can never
    // strand the overlay barely above scale 1, covering the pager.
    onFinalize: () => {
      // The engagement decision belongs to ONE pinch: left standing, the
      // next two fingers down would resume mid-zoom from a stale base.
      pinchTracking.value = PINCH_TRACKING_START;
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
      // A fresh touch stream: whether it turns into a pinch is decided
      // by the frames ahead of it.
      pinchZoomed.value = false;
    },
    // The zoomed pan is TOUCH-POSITION anchored (m0.8.6 §10, the
    // react-native-zoom-toolkit port — DeckScreen carries the full
    // rationale): translation comes from the fingers' absolute focal
    // position each frame (panFrame), not from the start-relative
    // translationX/Y whose averaged origin jumps at every finger land
    // or lift. A touch-set change re-anchors instead (down/up force
    // it; panFrame's count check catches a same-count swap between
    // move frames), keeping the translation continuous.
    onTouchesDown: () => {
      panTracking.value = PAN_TRACKING_START;
    },
    onTouchesUp: () => {
      panTracking.value = PAN_TRACKING_START;
    },
    onTouchesMove: (event) => {
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
      const step = panFrame(
        panTracking.value,
        event.allTouches,
        // Not yet active (or not zoomed) re-anchors continuously, so
        // the pan's activation threshold cannot jump the photo either.
        event.state === State.ACTIVE && scale.value > 1,
        tx.value,
        ty.value,
        bounds.maxX,
        bounds.maxY,
      );
      panTracking.value = step.tracking;
      if (step.translation === null) return;
      tx.value = step.translation.x;
      ty.value = step.translation.y;
    },
    onDeactivate: (event) => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      if (scale.value <= 1) return;
      // A stream that ZOOMED ends as a pinch, not a flick — momentum
      // out of it flung the photo on every two-finger zoom (round 5).
      if (pinchZoomed.value) return;
      // The release keeps the flick's momentum — the standard gallery
      // feel (m0.8.5 §10 check 9 round 3), inside the same pan bounds.
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
      tx.value = withDecay(
        { velocity: event.velocityX, clamp: [-bounds.maxX, bounds.maxX] },
        () => {
          savedTx.value = tx.value;
        },
      );
      ty.value = withDecay(
        { velocity: event.velocityY, clamp: [-bounds.maxY, bounds.maxY] },
        () => {
          savedTy.value = ty.value;
        },
      );
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
        text: `You marked it not related to ${facts.not_related_count} photo${
          facts.not_related_count === 1 ? '' : 's'
        } — it never groups with them.`,
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
                    </Animated.View>
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
            <View style={factsStale ? styles.factsStale : null}>
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
                <Text style={[styles.editStateText, { color: theme.accent }]}>Change decision</Text>
              </Pressable>
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
