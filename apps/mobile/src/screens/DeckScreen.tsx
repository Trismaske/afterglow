import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useIsFocused } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useReview, type RedecideTarget } from '../review/ReviewContext';
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';
import { labelForDayKey } from '../lib/dates';
import {
  completedDuringVisit,
  destinationAfterUnit,
  findUnitIndex,
  firstPendingUnit,
  unitDestination,
  type UnitDestination,
  type UnitRef,
} from '../lib/timeline';
import { ActionChip } from '../components/ActionChip';
import { GoalCelebration } from '../components/GoalCelebration';
import { BadgeCluster, DecisionBadge, DECISION_GLYPHS } from '../components/DecisionBadge';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected, shouldOfferFavouriteHandoff } from '../lib/favouriteState';
import { photoBadges, type PhotoBadge } from '../lib/photoBadges';
import { PhotoViewer } from '../components/PhotoViewer';
import { useSQLiteContext } from 'expo-sqlite';
import { addToShareQueue, removeFromShareQueue } from '../db/shareStore';
import { queueOrganize, unqueueOrganize } from '../db/organizeStore';
import { useDoubleTapZoom } from '../components/useDoubleTapZoom';
import { panBounds } from '../lib/zoomTarget';

type DeckProps = NativeStackScreenProps<RootStackParamList, 'Deck'>;
type SinglesProps = NativeStackScreenProps<RootStackParamList, 'Singles'>;
type SharedProps = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  explicitGroupId?: string;
  singlesMode: boolean;
  /** Singles mode (m0.8.2): the deck's day scope, always present — the
   * global singles feed deck is gone with the merged timeline. */
  day?: string;
  /** A timeline RUN's inclusive taken_at range; absent = the whole day
   * (the DayProgress CTA's deck). */
  range?: { from: number; to: number };
};

const THUMB = 52;
const MAX_SCALE = 8;

/** The write-error surface for the deck's DIRECT queue writes (codex r7:
 * toggleShare/toggleOrganize bypass the provider, so its decision alert
 * never fires for them, and run() swallows rejections assuming it did;
 * CompareScreen carries the same helper) — the durable row is unchanged,
 * so the user simply retries the tap. */
function surfaceQueueWriteError(error: unknown): void {
  Alert.alert(
    'Change not saved',
    `Afterglow could not write the change to its database. Nothing was changed — please retry the action.\n\n${error instanceof Error ? error.message : String(error)}`,
  );
}

function clampPan(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

/**
 * Swipe-deck group review (m0.4, replacing the duel bracket): the group is
 * a horizontally swipeable stack of its alive photos. Cull any photo as
 * you meet it (brief Undo affordance), star one as best, flag needs-edit,
 * eject a mis-grouped photo to the singles flow, or open the Compare tool.
 *
 * m0.5:
 * - `route.params.groupId` opens a SPECIFIC group (Groups screen, any
 *   order). Without it the screen drives the linear flow as before.
 * - A COMPLETED group opens in browse mode: page through every remaining
 *   member (kept and staged alike) and re-decide any of them via the
 *   keep / to-edit / cull chips — decisions stay reversible until the
 *   final cull confirmation.
 * - Pinch-zoom on the deck card: a two-finger pinch zooms the current
 *   photo in an always-mounted overlay (one-finger pan while zoomed);
 *   zooming back out restores paging. Gesture arbitration: pinch needs
 *   two pointers so one-finger swipes always reach the pager; while
 *   zoomed the overlay sits over the pager and swallows its touches.
 * - "Compare with…": the Compare button opens a thumbnail picker of the
 *   group's other alive members (straight into Compare when only two
 *   are alive). Long-pressing a strip thumbnail stays as the shortcut.
 */
export function DeckScreen({ navigation, route }: DeckProps) {
  return (
    <ReviewDeck
      navigation={navigation}
      explicitGroupId={route.params?.groupId}
      singlesMode={false}
    />
  );
}

export function SinglesDeckScreen({ navigation, route }: SinglesProps) {
  const { day, from, to } = route.params;
  return (
    <ReviewDeck
      navigation={navigation as DeckProps['navigation']}
      singlesMode
      day={day}
      range={from !== undefined && to !== undefined ? { from, to } : undefined}
    />
  );
}

function ReviewDeck({ navigation, explicitGroupId, singlesMode, day, range }: SharedProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isFocused = useIsFocused();
  const {
    groups,
    timeline,
    queueCounts,
    decide,
    clearDecision,
    keepRest,
    markBest,
    makeSingle,
    needsEdit,
    toggleNeedsEdit,
    favouriteStatus,
    toggleFavourite,
    keepAllSingles,
    version,
    loadGroup,
    loadDeckSingles,
    redecideDecided,
    refresh,
    queuedFor,
    actionWeights,
    refreshQueuedFor,
    noteDecisions,
    celebrationTick,
    consumeCelebration,
  } = useReview();
  const [busy, setBusy] = useState(false);
  const [pageW, setPageW] = useState(0);
  const [comparePicker, setComparePicker] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const listRef = useRef<FlatList<MediaItem>>(null);

  // m0.5: an explicit group (overview tap) pins the deck to it; the
  // paramless linear flow follows the timeline's FIRST unit — bound here
  // when it is a group, redirected to its run deck by the routing effect
  // when it is not (m0.8.2 merged timeline).
  const groupId = useMemo(() => {
    if (singlesMode) return null;
    if (explicitGroupId) return explicitGroupId;
    // First PENDING unit, not timeline[0]: a cull-only run (or a fully
    // browsed head card) is not review work (lib/timeline.ts).
    const first = firstPendingUnit(timeline);
    return first?.kind === 'group' ? String(first.group.groupId) : null;
  }, [explicitGroupId, timeline, singlesMode]);
  /** How THIS deck names itself against the timeline (advance flow). */
  const unitRef = useMemo<UnitRef | null>(() => {
    if (singlesMode)
      return day && range ? { kind: 'run', day, from: range.from, to: range.to } : null;
    return groupId ? { kind: 'group', groupId } : null;
  }, [singlesMode, day, range, groupId]);
  /** Send the deck where the advance flow points. */
  const goToDestination = useCallback(
    (destination: UnitDestination) => {
      if (destination.screen === 'Deck')
        navigation.replace('Deck', { groupId: destination.groupId });
      else if (destination.screen === 'Singles')
        navigation.replace('Singles', {
          day: destination.day,
          from: destination.from,
          to: destination.to,
        });
      else navigation.replace('CullList');
    },
    [navigation],
  );
  const queueGroup: ReviewGroupRow | null = useMemo(
    () => (groupId ? (groups.find((g) => String(g.groupId) === groupId) ?? null) : null),
    [groups, groupId],
  );
  // Gate 5: an explicitly opened group ABSENT from the queue is fetched
  // directly — completed groups reopen in browse/re-decide mode instead
  // of bouncing back. 'missing' = the group is genuinely gone (a pair
  // dissolved by ejection, or a stale id) — the advance effect handles
  // it. 'failed' = the READ failed and PROVES NOTHING about the group:
  // it renders the inline retry card and never feeds the advance
  // routing, which would otherwise skip the unit the user opened over a
  // transient SQLite error.
  const [loadedGroup, setLoadedGroup] = useState<ReviewGroupRow | 'loading' | 'missing' | 'failed'>(
    'loading',
  );
  // Bumped by the failure card's Retry — re-runs whichever load failed.
  const [loadTick, setLoadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (singlesMode || !explicitGroupId || queueGroup) {
      setLoadedGroup('loading');
      return;
    }
    void loadGroup(Number(explicitGroupId)).then(
      (fetched) => {
        if (!cancelled) setLoadedGroup(fetched ?? 'missing');
      },
      (error) => {
        console.warn('[deck] group load failed:', String(error));
        if (!cancelled) setLoadedGroup('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [explicitGroupId, queueGroup, loadGroup, singlesMode, version, loadTick]);
  const group: ReviewGroupRow | null =
    queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
  // m0.8.2: singles decks are day/run scoped and fetch their own rows —
  // kept photos included (group-deck parity, F10) — for the SAME reason
  // loadGroup exists above: the queue's singles feed is a bounded
  // newest-first pending page. `version` re-fetches, so a decision's
  // patch lands here too.
  const [deckSingles, setDeckSingles] = useState<ReviewMemberRow[] | 'failed' | null>(null);
  useEffect(() => {
    if (!singlesMode || !day) return;
    let cancelled = false;
    void loadDeckSingles(day, range ?? null).then(
      (rows) => {
        if (!cancelled) setDeckSingles(rows);
      },
      (error) => {
        // An unreadable scope is NOT an empty one: 'failed' renders the
        // inline retry card and keeps `singlesReady` false, so the exit
        // effect — which treats a truly empty scope as consumed and
        // advances past it — never routes on a transient read failure.
        // It must also never widen to some broader feed.
        console.warn('[deck] singles load failed:', String(error));
        if (!cancelled) setDeckSingles('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [day, range, singlesMode, loadDeckSingles, version, loadTick]);
  /** The rows this deck reviews (singles mode). */
  const singleRows = useMemo(() => (Array.isArray(deckSingles) ? deckSingles : []), [deckSingles]);
  // Derived deck info (the old core groupInfo shape, DB-backed): a group
  // absent from the queue but explicitly opened is COMPLETE (browse mode)
  // — the queue only lists groups with unreviewed members.
  const stateOf = useMemo(() => {
    const map = new Map<string, ReviewMemberRow['state']>();
    if (group) for (const m of group.members) map.set(m.asset_id, m.state);
    for (const m of singleRows) map.set(m.asset_id, m.state);
    return map;
  }, [group, singleRows]);
  const info = useMemo(() => {
    if (!group) return null;
    const aliveIds = group.members.filter((m) => m.state === 'unreviewed').map((m) => m.asset_id);
    return {
      memberIds: group.members.map((m) => m.asset_id),
      aliveIds,
      complete: aliveIds.length === 0,
      bestId: group.bestPhotoId,
      cursor: 0,
    };
  }, [group]);
  const singlesPending = singlesMode
    ? singleRows.filter((m) => m.state === 'unreviewed').length
    : 0;
  /** The deck's rows have landed (singles fetch is async). A FAILED
   * fetch is not "ready" — an unloaded deck may not judge completion. */
  const singlesReady = singlesMode ? Array.isArray(deckSingles) : true;
  // BROWSE = nothing pending in this deck (m0.8.2 unification: a
  // fully-reviewed singles run browses exactly like a completed group —
  // decided photos stay in place badged and re-decide via the chips).
  const browse = singlesMode
    ? singlesReady && singleRows.length > 0 && singlesPending === 0
    : (info?.complete ?? false);
  // `index` remembers the visited unit's TIMELINE position so a unit
  // that left the list (completed elsewhere, dissolved pair, regrouped
  // run) can still advance from its former spot.
  const completionRef = useRef<{ ref: UnitRef | null; complete: boolean | null; index: number }>({
    ref: unitRef,
    complete: explicitGroupId ? (info?.complete ?? null) : null,
    index: unitRef ? findUnitIndex(timeline, unitRef) : -1,
  });

  const toItem = (m: ReviewMemberRow): MediaItem => ({
    id: m.asset_id,
    timestamp: m.taken_at,
    uri: m.uri,
    kind: 'photo',
  });
  const aliveItems: MediaItem[] = useMemo(
    () => (group ? group.members.filter((m) => m.state === 'unreviewed').map(toItem) : []),
    [group],
  );
  // The group deck is the WHOLE group, live and browse alike (m0.8.1
  // round 4): a decided photo stays in place badged with its verdict —
  // Keep behaves exactly like Cull, and re-tapping the active verdict
  // clears it. Nothing leaves until the final delete confirmation.
  const groupItems: MediaItem[] = useMemo(() => (group ? group.members.map(toItem) : []), [group]);
  // A singles deck's rows: every non-trashed state, decided photos
  // badged in place (m0.8.2 unification — group-deck parity).
  const singlesItems: MediaItem[] = useMemo(
    () => (singlesMode ? singleRows.map(toItem) : []),
    [singleRows, singlesMode],
  );
  const deckItems = singlesMode ? singlesItems : groupItems;

  // The deck cursor is screen-local everywhere (m0.8: derived model — the
  // DB has no cursor; a decision shrinks the alive deck and the cursor
  // clamps to the next photo).
  const [browseCursor, setBrowseCursor] = useState(0);
  const cursor = Math.min(browseCursor, Math.max(0, deckItems.length - 1));
  const current: MediaItem | null = deckItems[cursor] ?? null;

  // Millisecond precision only where adjacent deck photos share a second
  // AND the timestamps carry sub-second data (m0.4).
  const needMs = useMemo(() => millisNeeded(deckItems.map((i) => i.timestamp)), [deckItems]);

  // ------------------------------------------------- pinch zoom (m0.5)
  // Two-pointer pinch zooms the current photo in an overlay; the pager
  // freezes while zoomed and resumes once the zoom springs back to 1.
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

  // NO GESTURE CALLBACK MAY CROSS THE WORKLETS->JS BRIDGE. Any runOnJS
  // call from a gesture worklet segfaults this build: SIGSEGV in
  // AroundLock::utf8, a use-after-free of the serialized host function
  // (reanimated #9776, worklets 0.10.2 — pinned by expo-modules-core).
  // Reproduced and A/B'd on the S10e in release builds twice over: a
  // single runOnJS'd tap callback killed the process on the 2nd double
  // tap; removed, 8+ were clean. Dead ends, each verified: declaring
  // worklets 0.11 over the pin ships TWO copies of a native library
  // (worse), and `.runOnJS(true)` trades the segfault for a TypeError in
  // onGestureHandlerEvent (the Babel plugin treats those callbacks
  // differently). So "is the deck zoomed?" lives ONLY in shared values:
  // the overlay is always mounted and its visibility + touchability are
  // animated props derived from `scale` on the UI thread, and the stage
  // tap is a plain Pressable on the page (RN responder path, no
  // worklets). Nothing here needs React state, so nothing needs the
  // bridge — a design worth keeping even if a future worklets release
  // fixes the crash.
  //
  // TWO detectors, and the split matters.
  //
  // An enabled Pan sitting in the same composition as the pager's scroll
  // crashes the worklets runtime on a horizontal drag (same signature —
  // reproduced and A/B'd on the S10e: pan enabled crashed on the 2nd
  // swipe, pan disabled survived 14). So the pan does not live here at
  // all. This composition is the pinch alone, built ONCE, never rebuilt
  // (a gesture rebuilt while a touch is in flight is its own crash).
  // Panning belongs to the zoom overlay, which only receives touches
  // while zoomed (see `zoomedGesture`).
  const stageGesture = useMemo(() => {
    return (
      Gesture.Pinch()
        .onUpdate((event) => {
          scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * event.scale));
          const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
          tx.value = clampPan(tx.value, bounds.maxX);
          ty.value = clampPan(ty.value, bounds.maxY);
        })
        .onEnd(() => {
          savedScale.value = scale.value;
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        })
        // onFinalize (unlike onEnd) also fires on cancellation, so a broken
        // gesture can never strand the overlay barely above scale 1,
        // covering the pager.
        .onFinalize(() => {
          // Follows onBegin, so it fires for plain taps too — do nothing
          // when there was never a zoom to unwind.
          if (scale.value === 1 && savedScale.value === 1) return;
          if (scale.value <= 1.02) {
            scale.value = withTiming(1);
            savedScale.value = 1;
            tx.value = withTiming(0);
            ty.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
          }
        })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Pan + double-tap, attached to the zoom overlay, which only receives
   * touches while zoomed (animated pointerEvents) — so the pan never
   * competes with the pager's scroll. */
  const zoomedGesture = useMemo(() => {
    const pan = Gesture.Pan()
      // A SECOND pinch (fingers lifted, then pinching again) lands on
      // the overlay, whose detector has no pinch of its own — without
      // this link an off-centre two-finger touch can activate the pan
      // first and cancel the ancestor pinch, freezing the zoom level
      // (codex r50). Simultaneous restores the pre-split behavior where
      // pan and pinch shared one composition.
      .simultaneousWithExternalGesture(stageGesture)
      .minPointers(1)
      .maxPointers(2)
      .averageTouches(true)
      .onUpdate((event) => {
        if (scale.value <= 1) return;
        const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
        tx.value = clampPan(savedTx.value + event.translationX, bounds.maxX);
        ty.value = clampPan(savedTy.value + event.translationY, bounds.maxY);
      })
      .onEnd(() => {
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      });
    // m0.7 (#18): double-tap resets zoom. The timing animation carries
    // scale back to exactly 1, which is what hides the overlay.
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      });
    return Gesture.Simultaneous(pan, doubleTap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageGesture]);

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
  // importantForAccessibility mirrors PhotoViewer's facts panel (codex
  // r50): the always-mounted overlay is hidden by opacity +
  // pointerEvents while unzoomed, but would otherwise stay in the
  // accessibility tree.
  const zoomOverlayProps = useAnimatedProps(() => ({
    pointerEvents: (scale.value > 1 ? 'auto' : 'none') as 'auto' | 'none',
    importantForAccessibility: (scale.value > 1 ? 'auto' : 'no-hide-descendants') as
      'auto' | 'no-hide-descendants',
  }));

  // Page taps — a plain Pressable press (RN responder system),
  // deliberately not a Gesture.Tap, so no worklet is involved (see the
  // bridge comment above). Double tap zooms to the tapped point; a
  // single tap (after the double-tap window) opens the standard
  // full-screen viewer in browse mode. Ref-dispatched so renderPage
  // stays stable.
  const stageTapRef = useRef<() => void>(() => {});
  stageTapRef.current = () => {
    // Reading a shared value from JS is a sync snapshot — fine here: a
    // zoomed stage keeps taps to itself anyway via pointerEvents.
    if (scale.value === 1 && browse) setViewerOpen(true);
  };
  const fireStageTap = useCallback(() => stageTapRef.current(), []);
  const currentId = current?.id ?? null;
  // currentId scopes the tap window to one photo: the hook serves every
  // pager page, so without it tap A → swipe → tap B inside the window
  // read as a double tap on B.
  const onPagePress = useDoubleTapZoom(
    { scale, savedScale, tx, ty, savedTx, savedTy, stageW, stageH, imageAspect },
    fireStageTap,
    currentId,
  );

  useEffect(() => {
    setComparePicker(false);
    setViewerOpen(false);
  }, [groupId, browse, singlesMode]);
  // A fresh unit opens on its FIRST pending photo (m0.8.2): a
  // half-finished run or group re-entered from the overview lands on the
  // work, not on a decided photo at index 0. Applied once per unit, when
  // its rows are actually there (the singles fetch is async).
  const unitKey = singlesMode
    ? `s:${day ?? ''}:${range?.from ?? ''}:${range?.to ?? ''}`
    : `g:${groupId ?? ''}`;
  const cursorAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (cursorAppliedRef.current === unitKey) return;
    if (singlesMode ? !singlesReady : !group) return;
    cursorAppliedRef.current = unitKey;
    const firstPending = deckItems.findIndex(
      (i) => (stateOf.get(i.id) ?? 'unreviewed') === 'unreviewed',
    );
    setBrowseCursor(firstPending > 0 ? firstPending : 0);
  }, [unitKey, singlesMode, singlesReady, group, deckItems, stateOf]);
  // The zoom overlay shows the CURRENT photo — leave zoom when it changes.
  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // Linear flow follows the timeline's first unit. Explicitly opening an
  // ALREADY completed group still permits browse/re-decide mode.
  useEffect(() => {
    if (singlesMode) return;
    if (explicitGroupId) {
      if (!group && loadedGroup === 'missing') {
        // A pair DISSOLVES during this visit when "Not related" ejects
        // one member (C#6) — that is a completion: advance to the next
        // timeline unit like any other finish. Only a genuinely stale id
        // (resumed navigation — never observed live) goes back.
        // Same guard as the normal completion effect: don't navigate
        // while the ejection's persist is in flight or another screen is
        // on top — the next focused, idle render performs the advance.
        if (busy || !isFocused) return;
        const previous = completionRef.current;
        if (
          previous.ref?.kind === 'group' &&
          previous.ref.groupId === explicitGroupId &&
          previous.complete !== null &&
          previous.index >= 0
        ) {
          goToDestination(destinationAfterUnit(timeline, previous.ref, previous.index));
        } else {
          // Off-page dissolution or a stale id — return to the origin.
          navigation.goBack();
        }
      }
      return;
    }
    if (groupId) return;
    // Paramless with no group at the head: the next PENDING unit is a
    // singles run (open it) or nothing reviewable (the cull list).
    const first = firstPendingUnit(timeline);
    if (first) goToDestination(unitDestination(first));
    else navigation.replace('CullList');
  }, [
    groupId,
    explicitGroupId,
    group,
    loadedGroup,
    timeline,
    goToDestination,
    navigation,
    singlesMode,
    busy,
    isFocused,
  ]);

  // The unit's live timeline position; a unit that left the list keeps
  // its FORMER index in completionRef (the successor sits there now).
  const unitIndex = useMemo(
    () => (unitRef ? findUnitIndex(timeline, unitRef) : -1),
    [timeline, unitRef],
  );
  useEffect(() => {
    if (unitIndex >= 0) completionRef.current.index = unitIndex;
  }, [unitIndex]);

  // m0.7 (#20): only advance out of a singles deck when completion
  // happened DURING this visit. A fully-reviewed run/day opened from the
  // overview is a deliberate revisit and stays in browse mode — exactly
  // like reopening a completed group.
  const singlesEnteredCompleteRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!singlesMode) {
      singlesEnteredCompleteRef.current = null;
      return;
    }
    // The deck cannot judge this until its rows have landed.
    if (!singlesReady) return;
    if (singlesEnteredCompleteRef.current === null) {
      singlesEnteredCompleteRef.current = singlesPending === 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlesMode, singlesReady]);
  useEffect(() => {
    if (!singlesMode || !singlesReady || busy || !isFocused) return;
    // A scope with GENUINELY no rows (the scan regrouped the last one
    // away) must not strand an empty deck: a RUN advances along the
    // timeline from its former spot, a DAY deck returns to its day page.
    // A failed read never reaches here — `singlesReady` stays false.
    if (singleRows.length === 0) {
      if (range && unitRef)
        goToDestination(destinationAfterUnit(timeline, unitRef, completionRef.current.index));
      else navigation.goBack();
      return;
    }
    if (singlesPending > 0) return;
    if (singlesEnteredCompleteRef.current === true) return; // deliberate revisit
    // A RUN follows the merged flow to the next timeline unit; a DAY
    // deck returns to the day page it promised.
    if (range && unitRef)
      goToDestination(destinationAfterUnit(timeline, unitRef, completionRef.current.index));
    else navigation.goBack();
  }, [
    busy,
    isFocused,
    navigation,
    goToDestination,
    timeline,
    unitRef,
    singlesMode,
    singlesPending,
    singlesReady,
    singleRows,
    range,
  ]);

  // A group that becomes complete during this visit advances immediately.
  // This covers Keep rest, culling/ejecting the final member, and completion
  // while returning from Compare. A group that was complete when opened is a
  // deliberate revisit and stays in browse mode.
  useEffect(() => {
    if (!explicitGroupId || !info || !unitRef) return;
    const previous = completionRef.current;
    if (
      !previous.ref ||
      previous.ref.kind !== 'group' ||
      previous.ref.groupId !== explicitGroupId
    ) {
      completionRef.current = { ref: unitRef, complete: info.complete, index: unitIndex };
      return;
    }
    // Do not consume the transition while its write is still in flight, or
    // while Compare/another screen is on top. The next focused, idle render
    // performs the advance.
    if (!isFocused || busy) return;
    const justCompleted = completedDuringVisit(
      { ref: previous.ref, complete: previous.complete },
      unitRef,
      info.complete,
      isFocused,
    );
    completionRef.current = {
      ref: unitRef,
      complete: info.complete,
      index: unitIndex >= 0 ? unitIndex : previous.index,
    };
    if (!justCompleted) return;

    // An OFF-PAGE group (opened from DayProgress, beyond the bounded
    // queue page — no known position) returns to its origin on
    // completion; the timeline cannot name its successor.
    if (previous.index < 0 && unitIndex < 0) {
      navigation.goBack();
      return;
    }
    // The refresh already removed the completed unit from the timeline,
    // so pass its stored former index — the successor sits there now.
    goToDestination(destinationAfterUnit(timeline, unitRef, previous.index));
  }, [
    busy,
    explicitGroupId,
    unitIndex,
    timeline,
    goToDestination,
    info,
    isFocused,
    navigation,
    unitRef,
  ]);

  // Keep the pager aligned with the cursor whenever the deck's membership
  // changes (cull/undo/make-single/re-decide) or a new group starts.
  // Swiping itself never triggers this (the key ignores the cursor).
  const deckKey = `${singlesMode ? 'singles' : (groupId ?? '')}:${browse ? 'b' : 'r'}:${deckItems.map((i) => i.id).join(',')}`;
  useEffect(() => {
    if (!pageW || deckItems.length === 0) return;
    listRef.current?.scrollToOffset({ offset: cursor * pageW, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pageW]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / pageW);
      if (index !== cursor) setBrowseCursor(index);
    },
    [pageW, cursor],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (!pageW) return;
      setBrowseCursor(index);
      listRef.current?.scrollToOffset({ offset: index * pageW, animated: true });
    },
    [pageW],
  );

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } catch {
        // The provider already surfaced the write error (alert) — the
        // rejection must not escape as unhandled.
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const isBest = !!current && !singlesMode && info?.bestId === current.id;

  // m0.7 item E queue row, m0.8.2 F5/F6: Share AND Organize are both
  // pure toggles now — organize queues with NO target ("move this
  // somewhere"; the album is assigned in the queue screen, batch-wise).
  // Both read the provider's badge maps (m0.8.1 round 4) — the same
  // membership the photo's share/organize badges show, so a per-photo
  // query here would be a second, divergent truth.
  const db = useSQLiteContext();

  const toggleShare = useCallback(async () => {
    if (!current) return;
    const id = current.id;
    try {
      if (queuedFor(id).share) await removeFromShareQueue(db, id, Date.now());
      else await addToShareQueue(db, id, Date.now());
    } catch (error) {
      // codex r7: a rejected DIRECT store write was silent — surface it
      // here (CompareScreen's pattern). The refresh below stays outside
      // the guard on purpose: by then the write landed, so a "nothing
      // was changed" alert would lie — the next refresh reconciles the
      // chip.
      surfaceQueueWriteError(error);
      return;
    }
    await refreshQueuedFor().catch(() => {});
  }, [db, current, queuedFor, refreshQueuedFor]);

  // ------------------------------------------ goal celebration (F14)
  // The counter lives in ReviewContext (a crossing can happen on the
  // Compare screen too); this surface claims and renders the pending
  // moment whenever it is the focused one.
  const [celebrating, setCelebrating] = useState(false);
  const [celebrationGoal, setCelebrationGoal] = useState(0);
  const bumpDecisions = noteDecisions;
  useEffect(() => {
    if (!isFocused) return;
    const goal = consumeCelebration();
    if (goal !== null) {
      setCelebrationGoal(goal);
      setCelebrating(true);
    }
  }, [celebrationTick, isFocused, consumeCelebration]);

  const toggleOrganize = useCallback(async () => {
    if (!current) return;
    const id = current.id;
    try {
      if (queuedFor(id).organize) await unqueueOrganize(db, id, Date.now());
      else {
        const error = await queueOrganize(db, id, Date.now());
        if (error) {
          Alert.alert('Cannot organize this photo', error);
          return;
        }
      }
    } catch (error) {
      surfaceQueueWriteError(error); // codex r7 — see toggleShare
      return;
    }
    await refreshQueuedFor().catch(() => {});
  }, [db, current, queuedFor, refreshQueuedFor]);

  const finishGroup = useCallback(() => {
    if (!group) return;
    void run(async () => {
      // Credit what the WRITE kept (codex r10): a dissolved off-page
      // group keeps nothing, and the rendered pending count would
      // advance the goal for verdicts that were never written.
      const kept = await keepRest(group.groupId);
      bumpDecisions(kept);
    });
  }, [group, run, keepRest, bumpDecisions]);

  const toggleBest = useCallback(() => {
    if (!group || !current) return;
    void run(async () => {
      await markBest(group.groupId, isBest ? null : current.id);
      // m0.7 item F (#10): the hand-off is WRITE-ONLY — never offered for
      // an already-favourited photo (toggleFavourite would UN-favourite
      // it), and "Not now" stays a strict no-op.
      const offer = shouldOfferFavouriteHandoff(favouriteStatus(current.id));
      if (!isBest && offer && Platform.OS === 'android' && Number(Platform.Version) >= 30) {
        Alert.alert('Best of this group', 'Would you also like to favourite it in your gallery?', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Favourite', onPress: () => void toggleFavourite(current.id).catch(() => {}) },
        ]);
      }
    });
  }, [current, favouriteStatus, group, isBest, markBest, run, toggleFavourite]);

  const openCompare = useCallback(
    (againstId?: string) => {
      // Compare eligibility (m0.8.2, F11): undecided OR KEPT — "compare
      // with the photo I just kept" is the point. Staged culls stay out
      // on BOTH endpoints (a compare verdict could star one — a culled
      // best); resurrecting one is the re-decide chips' job.
      const candidates = deckItems.filter((i) => {
        const state = stateOf.get(i.id) ?? 'unreviewed';
        return state === 'unreviewed' || state === 'kept';
      });
      if ((!singlesMode && !groupId) || !current || candidates.length < 2) return;
      if (!candidates.some((i) => i.id === current.id)) return;
      if (againstId !== undefined && !candidates.some((i) => i.id === againstId)) return;
      if (againstId === undefined && candidates.length > 2) {
        // m0.5: explicit opponent choice for larger groups.
        setComparePicker(true);
        return;
      }
      const other = againstId ?? candidates.find((i) => i.id !== current.id)?.id;
      if (!other || other === current.id) return;
      setComparePicker(false);
      navigation.navigate('Compare', {
        ...(groupId ? { groupId } : {}),
        ...(day ? { day } : {}),
        ...(range ? { from: range.from, to: range.to } : {}),
        singles: singlesMode,
        aId: current.id,
        bId: other,
      });
    },
    [current, day, range, deckItems, groupId, navigation, singlesMode, stateOf],
  );

  const renderPage = useCallback(
    ({ item }: { item: MediaItem }) => (
      // Pressable, not a tap gesture: presses fire on the JS thread with
      // no worklets bridge (crash class above), and a horizontal drag
      // hands over to the pager's scroll exactly like any list row.
      <Pressable style={{ width: pageW, height: '100%' }} onPress={onPagePress}>
        <Image
          source={{ uri: item.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          recyclingKey={item.id}
          transition={40}
        />
      </Pressable>
    ),
    [pageW, onPagePress],
  );

  // A failed unit read renders the inline retry INSTEAD of the empty
  // root below: the failure state routes nowhere (no effect consumes
  // 'failed'), so the unit stays open until the read succeeds or the
  // user leaves. Genuinely missing/empty units keep their routing above.
  const loadFailed = singlesMode ? deckSingles === 'failed' : !group && loadedGroup === 'failed';
  if (loadFailed) {
    return (
      <View style={[styles.root, styles.loadFailedRoot]}>
        <Text style={styles.loadFailedText}>Could not load these photos just now.</Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            if (singlesMode) setDeckSingles(null);
            else setLoadedGroup('loading');
            setLoadTick((t) => t + 1);
          }}
        >
          <Text style={[styles.retryText, { color: theme.accent }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!current || (!singlesMode && (!groupId || !info))) {
    return <View style={styles.root} />;
  }

  // Compare eligibility mirrors openCompare exactly: undecided or KEPT
  // candidates (F11), and the CURRENT photo must be one of them.
  const compareStates = ['unreviewed', 'kept'];
  const compareCandidateCount = deckItems.filter((i) =>
    compareStates.includes(stateOf.get(i.id) ?? 'unreviewed'),
  ).length;
  const compareEligible =
    compareCandidateCount >= 2 && compareStates.includes(stateOf.get(current.id) ?? 'unreviewed');

  const flagged = needsEdit(current.id);
  const favourite = isFavouriteSelected(favouriteStatus(current.id));
  const { share: shareQueued, organize: organizeQueued } = queuedFor(current.id);
  const keepCount = deckItems.length;
  const currentState = stateOf.get(current.id) ?? 'unreviewed';
  const browseState: RedecideTarget =
    currentState === 'culled' ? 'cull' : flagged ? 'to_edit' : 'keep';
  /** Every badge a deck photo wears — the verdict AND all four actions,
   * none hiding another (m0.8.1 round 4), each at its own weight: loud
   * while it waits for you, quiet once the photo carries it (m0.8.2).
   * The verdict rides into actionWeights so a staged cull's retained
   * actions badge quiet — they left the queues with it. */
  const badgesFor = (item: MediaItem): PhotoBadge[] => {
    const state = stateOf.get(item.id) ?? 'unreviewed';
    return photoBadges({
      state,
      ...actionWeights(item.id, state),
      best: !singlesMode && info?.bestId === item.id,
    });
  };

  // Re-decide: tapping the ACTIVE verdict clears back to unreviewed; a
  // A DECIDED photo changing to keep/to-edit takes the state-aware path:
  // "keep" rescues a staged cull without touching its pending actions
  // and "to edit" restarts the cycle; both resolve copy matches. An
  // UNDECIDED photo
  // takes the ordinary verdict path, where "to edit" keeps it AND queues
  // the edit in one transaction.
  const redecide = async (id: string, target: RedecideTarget) => {
    const state = stateOf.get(id) ?? 'unreviewed';
    // v18: 'to edit' is no longer a verdict, so the active target is
    // kept-vs-cull; the edit flag is read separately.
    const activeTarget: RedecideTarget | null =
      state === 'culled' ? 'cull' : state === 'kept' ? 'keep' : null;
    if (activeTarget === target) await clearDecision(id);
    else if (state !== 'unreviewed' && (target === 'keep' || target === 'to_edit'))
      await redecideDecided(id, target);
    else await decide(id, target, singlesMode ? null : (group?.groupId ?? undefined));
  };

  /** ONE decide handler for both deck kinds (m0.8.2 unification, F10):
   * every verdict leaves the photo in place badged — membership never
   * changes mid-visit — so a FRESH decision advances the pager past it,
   * while re-deciding an already-decided photo stays put (the user is
   * looking at that one). */
  const decideCurrent = async (target: RedecideTarget) => {
    const index = cursor;
    const wasUnreviewed = (stateOf.get(current.id) ?? 'unreviewed') === 'unreviewed';
    await redecide(current.id, target);
    if (wasUnreviewed) bumpDecisions(1);
    if (wasUnreviewed && index + 1 < deckItems.length) jumpTo(index + 1);
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        {/* Truthful numbers only (m0.8.2, F12): the unit's own progress
            over its FIXED membership, plus the library-wide remainder
            from the DB counts — never a page-position ordinal. */}
        <Text style={styles.headerTitle}>
          {singlesMode
            ? `${range || !day ? 'Singles' : `${labelForDayKey(day)} · singles`} · ${keepCount - singlesPending} of ${keepCount} reviewed${
                range ? ` · ${queueCounts.singles.toLocaleString()} left in library` : ''
              }`
            : browse
              ? `Group · ${keepCount} reviewed`
              : `Group · ${keepCount - aliveItems.length} of ${keepCount} reviewed · ${queueCounts.groups.toLocaleString()} groups left`}
        </Text>
        <Text style={styles.headerHint}>
          {browse
            ? singlesMode
              ? 'Reviewed singles — change any decision until the final delete confirmation.'
              : 'Reviewed group — change any decision until the final delete confirmation.'
            : singlesMode
              ? range
                ? 'Swipe through the run · decided shots stay badged (tap the same verdict to undo) · Keep remaining finishes.'
                : "This day's ungrouped shots · decided shots stay badged (tap the same verdict to undo)."
              : 'Swipe through the group · decided shots stay badged (tap the same verdict to undo) · Keep rest finishes.'}
        </Text>
      </View>

      <GestureDetector gesture={stageGesture}>
        <View
          style={styles.stage}
          onLayout={(event) => {
            setPageW(event.nativeEvent.layout.width);
            stageW.value = event.nativeEvent.layout.width;
            stageH.value = event.nativeEvent.layout.height;
          }}
        >
          {pageW > 0 && (
            <>
              <View style={styles.pager}>
                <FlatList
                  ref={listRef}
                  data={deckItems}
                  keyExtractor={(i) => i.id}
                  renderItem={renderPage}
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  initialScrollIndex={Math.min(cursor, deckItems.length - 1)}
                  getItemLayout={(_data, index) => ({
                    length: pageW,
                    offset: pageW * index,
                    index,
                  })}
                  onMomentumScrollEnd={onMomentumEnd}
                />
              </View>
            </>
          )}
          {/* Always mounted; visibility + touchability are UI-thread
              animated props (see zoomStyle/zoomOverlayProps). The image
              is the same URI the pager page shows, so expo-image serves
              it from cache rather than decoding twice. */}
          <GestureDetector gesture={zoomedGesture}>
            {/* The opaque backdrop lives on this UNtransformed layer, so
                it covers the stage by construction. On the transformed
                layer it was one rounding error away from leaking: for a
                photo that fills an axis, the content clamp is exactly
                the coverage bound, and pixel snapping let the pager's
                photo peek out in a sliver at the edge (device-observed
                on both phones). The photo transforms INSIDE it; a few-px
                edge miss now shows flat stage colour instead. */}
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.surface },
                zoomOverlayStyle,
              ]}
              animatedProps={zoomOverlayProps}
            >
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
            </Animated.View>
          </GestureDetector>
          <View style={styles.posBadge} pointerEvents="none">
            <Text style={styles.posBadgeText}>
              {cursor + 1}/{keepCount}
            </Text>
          </View>
          <View style={styles.timeBadge} pointerEvents="none">
            <Text style={styles.timeBadgeText}>
              {formatClockPrecise(current.timestamp, needMs[cursor] ?? false)}
            </Text>
          </View>
          <BadgeCluster
            badges={badgesFor(current)}
            size={24}
            accent={theme.accent}
            style={styles.flagBadge}
          />
        </View>
      </GestureDetector>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.thumbStrip}
        contentContainerStyle={styles.thumbStripContent}
      >
        {deckItems.map((item, index) => (
          <Pressable
            key={item.id}
            onPress={() => jumpTo(index)}
            onLongPress={() => {
              // Compare via long-press works in browse too (F11): two
              // KEPT members are a legitimate duel — the dialog can
              // re-decide one.
              if (item.id !== current.id) openCompare(item.id);
            }}
          >
            <Image
              source={{ uri: item.uri }}
              style={[
                styles.thumb,
                index === cursor && styles.thumbActive,
                item.id === info?.bestId && { borderColor: theme.accent },
              ]}
              contentFit="cover"
              recyclingKey={item.id}
            />
            {/* Small badges wrapping into rows: a 52 px thumbnail fits
                three per row, so a fully-flagged photo shows all of
                them stacked instead of hiding any. */}
            <BadgeCluster
              badges={badgesFor(item)}
              size={14}
              accent={theme.accent}
              style={styles.thumbBadges}
            />
          </Pressable>
        ))}
      </ScrollView>

      {browse ? (
        // BROWSE (m0.8.2 unification): a completed group and a completed
        // singles run re-decide identically — Keep/Cull chips, the
        // actions, no Compare (its verdicts reject decided photos; the
        // chips are the re-decide path).
        <>
          <View style={styles.actionRow}>
            {(
              [
                {
                  target: 'keep',
                  label: 'Keep',
                  kind: 'keep',
                  dim: colors.keepDim,
                  color: colors.keep,
                },
                {
                  target: 'cull',
                  label: 'Cull',
                  kind: 'cull',
                  dim: colors.cullDim,
                  color: colors.cull,
                },
              ] as const
            ).map(({ target, label, kind, dim, color }) => {
              const active = currentState !== 'unreviewed' && browseState === target;
              return (
                <Pressable
                  key={target}
                  style={[
                    styles.actionButton,
                    { backgroundColor: dim },
                    active && { borderWidth: 2, borderColor: color },
                  ]}
                  disabled={busy}
                  onPress={() => void run(() => decideCurrent(target))}
                >
                  <MaterialCommunityIcons name={DECISION_GLYPHS[kind]} size={20} color={color} />
                  <Text style={styles.actionText}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.secondaryRow}>
            {/* Browse Edit re-decides (kept + fresh edit cycle) — the
                state-aware path, unlike the live flag toggle below.
                All four chips DISABLE on a staged cull (same rule as
                Best below): its retained action rows are what un-staging
                restores, and a toggle here would silently destroy them —
                a photo you are about to delete is not actionable work
                (codex r3). */}
            <ActionChip
              kind="edit"
              active={flagged}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(() => decideCurrent('to_edit'))}
            />
            {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
              <ActionChip
                kind="favourite"
                active={favourite}
                disabled={busy || currentState === 'culled'}
                onPress={() => void run(() => toggleFavourite(current.id))}
              />
            )}
            <ActionChip
              kind="organize"
              active={organizeQueued}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(toggleOrganize)}
            />
            <ActionChip
              kind="share"
              active={shareQueued}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(toggleShare)}
            />
            {!singlesMode && groupId && (
              <Pressable
                style={[
                  styles.secondaryButton,
                  isBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
                ]}
                // Only a staged cull is barred from Best (cull-star
                // hygiene) — a completed group's kept members stay
                // starrable in browse mode.
                disabled={busy || currentState === 'culled'}
                onPress={toggleBest}
              >
                <MaterialCommunityIcons
                  name={isBest ? 'star' : 'star-outline'}
                  size={18}
                  color={isBest ? theme.accent : colors.textDim}
                />
                <Text style={[styles.secondaryText, isBest && { color: theme.accent }]}>Best</Text>
              </Pressable>
            )}
          </View>
        </>
      ) : (
        // LIVE (m0.8.2 unification): groups and singles runs review
        // through ONE surface — big three, the four actions, and the
        // finish button; only Best/Not related stay group-only, because
        // they are statements about group membership.
        <>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.actionButton,
                { backgroundColor: colors.keepDim },
                currentState === 'kept' && { borderWidth: 2, borderColor: colors.keep },
              ]}
              disabled={busy}
              // `redecide` (inside decideCurrent) carries the whole rule
              // set: the active verdict clears back to unreviewed, a
              // staged cull re-decided to Keep takes the state-aware
              // path (copy matches resolved), and an unreviewed card
              // takes the initial-decision verdict.
              onPress={() => void run(() => decideCurrent('keep'))}
            >
              <MaterialCommunityIcons name={DECISION_GLYPHS.keep} size={21} color={colors.keep} />
              <Text style={styles.actionText}>Keep</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.compareButton]}
              // Compare works on UNDECIDED photos only (its verdicts cull
              // a loser and star a winner) — and decided photos stay in
              // the deck, so the button must go dead on them too, not
              // just on staged culls.
              disabled={busy || !compareEligible}
              onPress={() => openCompare()}
            >
              <MaterialCommunityIcons name="compare-horizontal" size={21} color={colors.textDim} />
              <Text style={[styles.actionText, !compareEligible && styles.actionTextDisabled]}>
                Compare{compareCandidateCount > 2 ? ' with…' : ''}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionButton,
                styles.cullButton,
                currentState === 'culled' && { borderWidth: 2, borderColor: colors.cull },
              ]}
              disabled={busy}
              onPress={() => void run(() => decideCurrent('cull'))}
            >
              <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
              <Text style={styles.actionText}>Cull</Text>
            </Pressable>
          </View>

          <View style={styles.secondaryRow}>
            {/* Live Edit is a FLAG toggle (both deck kinds, m0.8.2
                unification) — the verdict layer is untouched. The live
                deck keeps decided photos in place, so a staged cull can
                be the current photo here too: all four chips disable on
                it (same rule as Best) — its retained rows are what
                un-staging restores (codex r3). */}
            <ActionChip
              kind="edit"
              active={flagged}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(() => toggleNeedsEdit(current.id))}
            />
            {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
              <ActionChip
                kind="favourite"
                active={favourite}
                disabled={busy || currentState === 'culled'}
                onPress={() => void run(() => toggleFavourite(current.id))}
              />
            )}
            <ActionChip
              kind="organize"
              active={organizeQueued}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(toggleOrganize)}
            />
            <ActionChip
              kind="share"
              active={shareQueued}
              disabled={busy || currentState === 'culled'}
              onPress={() => void run(toggleShare)}
            />
          </View>

          {!singlesMode && groupId && (
            <View style={styles.secondaryRow}>
              <Pressable
                style={[
                  styles.secondaryButton,
                  isBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
                ]}
                // A staged cull is not ALIVE — un-cull it before starring.
                disabled={busy || currentState === 'culled'}
                onPress={toggleBest}
              >
                <MaterialCommunityIcons
                  name={isBest ? 'star' : 'star-outline'}
                  size={18}
                  color={isBest ? theme.accent : colors.textDim}
                />
                <Text style={[styles.secondaryText, isBest && { color: theme.accent }]}>Best</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                disabled={busy}
                onPress={() => group && void run(() => makeSingle(current.id, group.groupId))}
              >
                <MaterialCommunityIcons name="image-move" size={18} color={colors.textDim} />
                <Text style={styles.secondaryText}>Not related</Text>
              </Pressable>
            </View>
          )}

          <BigButton
            label={
              busy
                ? 'Saving…'
                : `Keep remaining (${singlesMode ? singlesPending : aliveItems.length})`
            }
            color={colors.keep}
            disabled={busy || (singlesMode ? singlesPending === 0 : aliveItems.length === 0)}
            onPress={() =>
              singlesMode
                ? day &&
                  void run(async () => {
                    // Credit what the WRITE kept, not the rendered count:
                    // the write re-reads its scope, and a scan can have
                    // moved singles in or out mid-view (codex r8).
                    const kept = await keepAllSingles(day, range ?? null);
                    bumpDecisions(kept);
                  })
                : finishGroup()
            }
          />
        </>
      )}

      {viewerOpen && (
        <PhotoViewer
          items={deckItems.map((i) => ({ id: i.id, uri: i.uri, takenAt: i.timestamp }))}
          initialIndex={cursor}
          onClose={() => setViewerOpen(false)}
          onChanged={() => void refresh().catch(() => {})}
        />
      )}

      {/* m0.5: explicit opponent picker for the Compare tool. */}
      <Modal
        visible={comparePicker}
        transparent
        animationType="fade"
        onRequestClose={() => setComparePicker(false)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setComparePicker(false)}>
          <Pressable
            style={[styles.pickerCard, { paddingBottom: insets.bottom + 16 }]}
            onPress={() => {}}
          >
            <Text style={styles.pickerTitle}>Compare with…</Text>
            <Text style={styles.pickerHint}>Pick the photo to compare against {cursor + 1}.</Text>
            <View style={styles.pickerGrid}>
              {/* BOTH modes: candidates are the deck's undecided-or-KEPT
                  items (F11), labeled by their DECK position — a
                  filtered-subset index would disagree after a cull. A
                  kept candidate wears its keep badge, so duelling a
                  prior decision is visible before the tap. */}
              {deckItems
                .map((item, deckIndex) => ({ item, deckIndex }))
                .filter(({ item }) => compareStates.includes(stateOf.get(item.id) ?? 'unreviewed'))
                .map(({ item, deckIndex }) =>
                  item.id === current.id ? null : (
                    <Pressable key={item.id} onPress={() => openCompare(item.id)}>
                      <Image
                        source={{ uri: item.uri }}
                        style={styles.pickerThumb}
                        contentFit="cover"
                        recyclingKey={item.id}
                      />
                      <View style={styles.pickerIndex}>
                        <Text style={styles.pickerIndexText}>{deckIndex + 1}</Text>
                      </View>
                      {(stateOf.get(item.id) ?? 'unreviewed') === 'kept' && (
                        <DecisionBadge kind="keep" size={16} style={styles.pickerKeep} />
                      )}
                    </Pressable>
                  ),
                )}
            </View>
            <Pressable style={styles.pickerClose} onPress={() => setComparePicker(false)}>
              <Text style={styles.pickerCloseText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* The goal moment (F14): non-blocking overlay, fired by the
          crossing decision, self-dismissing. */}
      {celebrating && (
        <GoalCelebration
          goal={celebrationGoal}
          accent={theme.accent}
          onDone={() => setCelebrating(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    gap: 10,
    paddingTop: 8,
  },
  header: { gap: 2, paddingHorizontal: 4 },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  headerHint: { color: colors.textDim, fontSize: 12 },
  // Inline failure card (SourcePicker's quiet retry language).
  loadFailedRoot: { alignItems: 'center', justifyContent: 'center' },
  loadFailedText: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  retryText: { fontSize: 15, fontWeight: '700' },
  stage: {
    flex: 1,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  pager: { flex: 1 },
  posBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  posBadgeText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  timeBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  timeBadgeText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  flagBadge: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  flagBadgeText: { fontSize: 13, fontWeight: '700' },
  thumbStrip: { flexGrow: 0 },
  thumbStripContent: { gap: 6, paddingHorizontal: 2 },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbActive: { borderColor: colors.text },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  cullButton: { backgroundColor: colors.cullDim },
  compareButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  actionTextDisabled: { color: colors.textDim },
  secondaryRow: { flexDirection: 'row', gap: 10 },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 6,
  },
  secondaryText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  thumbBadges: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    // Bounded by the thumbnail so the cluster wraps inside it.
    maxWidth: THUMB - 6,
  },
  // Bottom sheet, matching every other modal (the Organize screen's
  // album picker, the share label prompt) — the deck's pickers were the
  // app's only centered modal cards (m0.8.1 consistency sweep).
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  pickerCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: touch.radius,
    borderTopRightRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  pickerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  pickerHint: { color: colors.textDim, fontSize: 13 },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickerThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
  },
  pickerIndex: {
    position: 'absolute',
    top: 4,
    left: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  pickerIndexText: { color: colors.text, fontSize: 11, fontWeight: '800' },
  pickerKeep: { position: 'absolute', top: 4, right: 4 },
  pickerClose: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  pickerCloseText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
