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
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  InterceptingGestureDetector,
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
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
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
import { PINCH_TRACKING_START, panBounds, pinchFrame } from '../lib/zoomTarget';
import { stripScrollOffset } from '../lib/stripScroll';
import {
  deckUnitKey,
  paramsForUnit,
  unitFromDestination,
  unitFromParams,
  type DeckUnit,
} from '../lib/deckUnit';

/** Which control started the in-flight write — 'finish' is the big
 * Keep-remaining button, everything else is 'other'. */
type BusyOwner = 'finish' | 'other';

type DeckProps = NativeStackScreenProps<RootStackParamList, 'Deck'>;

type SharedProps = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  /** The unit to review. Replacing it advances the deck in place. */
  unit: DeckUnit;
  /** Advance to another unit without leaving the route. */
  advanceTo: (unit: DeckUnit) => void;
};

const THUMB = 52;
const THUMB_GAP = 6;
const THUMB_INSET = 2;
// 16× (Tristan, 2026-08-04). Past 1:1 pixels by design: a 50 MP frame
// reaches one source pixel per screen pixel at ~5.7× on a 1440 px-wide
// phone, so the top of this range magnifies interpolation rather than
// revealing detail — wanted for inspecting a focus point, not for
// judging sharpness. panBounds clamps to the photo's own edges, so a
// deep zoom cannot wander off the content.
const MAX_SCALE = 16;

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
 * a horizontally swipeable deck of ALL its photos — a decided photo stays
 * in place wearing its badges, and re-tapping the active verdict clears
 * it (the badge is the undo). Cull any photo as you meet it, star one as
 * best, flag needs-edit, eject a mis-grouped photo to the singles flow,
 * or open the Compare tool.
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
 *   group's other undecided-or-kept members (straight into Compare when
 *   only two are eligible). Long-pressing a strip thumbnail stays as the
 *   shortcut.
 *
 * m0.8.2 (F10): ONE unified deck for both kinds. A unit is a group or a
 * day-scoped singles run/day, and the global singles-feed deck is gone.
 * Controls are the big three Keep / Compare / Cull plus the queue row
 * Edit·Favourite·Organize·Share (Edit is a flag toggle in live decks,
 * both kinds; browse mode routes it through the state-aware re-decide
 * path instead).
 *
 * m0.8.5 (L4, F6): ONE ROUTE, and the unit is STATE. Every advance used
 * to be `navigation.replace`, which unmounted the screen — measured on
 * the S10e as ~300 ms of blank between units, re-decoding the photo and
 * resetting the strip and zoom overlay each time. Now `advanceTo`
 * swaps the unit in place and only a destination that leaves review
 * (the cull list, a day page) still navigates. `destinationAfterUnit`
 * still decides WHERE to go; only the mechanism changed.
 *
 * Two consequences the code carries deliberately, because the unmount
 * used to hide them:
 * - Async row reads are STAMPED with `unitKey`, so a previous unit's
 *   rows can never render as this one's — nor satisfy `singlesReady`
 *   long enough to advance again.
 * - Anything that was per-visit is now keyed on the unit, not on mount:
 *   the cursor, the compare picker, and the entered-complete revisit
 *   test. A ref left holding the previous unit's answer would stop the
 *   flow dead.
 * The route params follow each advance (`paramsForUnit`), so re-entering
 * from Home or the Timeline re-seeds the deck even when it names the
 * unit the route was opened on.
 */
export function DeckScreen({ navigation, route }: DeckProps) {
  const [unit, setUnit] = useState<DeckUnit>(() => unitFromParams(route.params));
  /** The params this screen has already consumed. Its own advances write
   * here too, so the adopt-params effect below reacts to EXTERNAL
   * navigation only. */
  const consumedParamsRef = useRef(deckUnitKey(unitFromParams(route.params)));

  const advanceTo = useCallback(
    (next: DeckUnit) => {
      consumedParamsRef.current = deckUnitKey(next);
      setUnit(next);
      // Keep the route honest. Without this the params would still name
      // the unit the deck opened on, and re-entering from Home or the
      // Timeline on that same unit would be a no-op param change —
      // leaving the deck wherever it had advanced to.
      navigation.setParams(paramsForUnit(next));
    },
    [navigation],
  );

  const paramKey = deckUnitKey(unitFromParams(route.params));
  useEffect(() => {
    if (consumedParamsRef.current === paramKey) return;
    consumedParamsRef.current = paramKey;
    setUnit(unitFromParams(route.params));
  }, [paramKey, route.params]);

  // Per-unit title: one route now serves both kinds, so the screen names
  // itself rather than the navigator naming it once.
  useEffect(() => {
    navigation.setOptions({ title: unit.kind === 'run' ? 'Singles review' : 'Group review' });
  }, [navigation, unit.kind]);

  return <ReviewDeck navigation={navigation} unit={unit} advanceTo={advanceTo} />;
}

/**
 * Everything one render of the deck's body needs (L4 round 3). Captured
 * from live data on every loaded render and FROZEN while the next
 * unit's rows load, so an advance swaps data inside one mounted tree
 * instead of unmounting the chrome. Per-photo context lookups
 * (needsEdit, favouriteStatus, queuedFor, actionWeights) stay live —
 * they are stable id-keyed maps, valid for frozen ids too.
 */
interface DeckView {
  items: MediaItem[];
  cursor: number;
  current: MediaItem;
  stateOf: Map<string, ReviewMemberRow['state']>;
  dayOf: Map<string, string | null>;
  needMs: boolean[];
  bestId: string | null;
  /** Group-only controls (Best · Not related) render. */
  isGroup: boolean;
  headerTitle: string;
  headerHint: string;
  browseControls: boolean;
  keepCount: number;
  /** What the finish button counts (pending singles / alive members). */
  finishCount: number;
}

function ReviewDeck({ navigation, unit, advanceTo }: SharedProps) {
  const singlesMode = unit.kind === 'run';
  const day = unit.kind === 'run' ? unit.day : undefined;
  // Referentially stable: `unit` is state, replaced only by an advance,
  // so this object identity is safe in the loaders' dependency arrays.
  const range = unit.kind === 'run' ? unit.range : undefined;
  const explicitGroupId = unit.kind === 'group' ? (unit.groupId ?? undefined) : undefined;
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
    registerCelebrationHost,
    celebrationSettling,
    celebrationPending,
    consumeCelebration,
  } = useReview();
  const [busy, setBusy] = useState(false);
  /** Which control owns the in-flight write (see `run`). */
  const [busyOwner, setBusyOwner] = useState<BusyOwner | null>(null);
  /**
   * A finish is under way and this unit is on its way out (F6).
   *
   * Completing a unit flips `browse`, which swaps the whole live control
   * block for the browse one. Before L4 nobody saw it — the
   * `navigation.replace` had already blanked the screen. Now the advance
   * is a state change, so that swap would paint for a frame and read as
   * the layout "reflowing" under your thumb.
   *
   * Cleared by the unit change the finish causes, or — if the write left
   * the unit incomplete after all, e.g. a scan added rows mid-write — by
   * the deck settling back out of browse.
   */
  const [finishing, setFinishing] = useState(false);
  /** The finish write has run long enough to EARN the "Saving…" label
   * (§10 check 2): a fast write advances before this fires, so the
   * label never flashes for the normal case; a genuinely slow write —
   * the scan-stall probe's territory — still says what is happening. */
  const [finishSlow, setFinishSlow] = useState(false);
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
  /**
   * The RESOLVED unit's identity — the linear flow's group is bound
   * above, so this changes when the deck lands on a real group.
   *
   * It does two jobs, and both matter more since L4 kept the screen
   * mounted across units: it keys the per-unit effects (cursor, picker,
   * revisit), and it STAMPS the async row state below, so rows read for
   * a previous unit can never be mistaken for this one's.
   */
  const unitKey = singlesMode
    ? `r:${day ?? ''}:${range?.from ?? ''}:${range?.to ?? ''}`
    : `g:${groupId ?? ''}`;
  /** How THIS deck names itself against the timeline (advance flow). */
  const unitRef = useMemo<UnitRef | null>(() => {
    if (singlesMode)
      return day && range ? { kind: 'run', day, from: range.from, to: range.to } : null;
    return groupId ? { kind: 'group', groupId } : null;
  }, [singlesMode, day, range, groupId]);
  /**
   * Send the deck where the advance flow points (m0.8.5, L4).
   *
   * A destination that is still a UNIT is a state change: the screen
   * stays mounted, and the photo, strip and controls swap in place. Only
   * a destination that leaves review entirely still navigates.
   *
   * Before L4 every advance was `navigation.replace`, which unmounted
   * the screen and left ~300 ms of blank between units (F6, measured).
   */
  const goToDestination = useCallback(
    (destination: UnitDestination) => {
      if (destination.kind === 'cullList') navigation.replace('CullList');
      else advanceTo(unitFromDestination(destination));
    },
    [navigation, advanceTo],
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
  // STAMPED with the unit it was read for. The deck no longer remounts
  // between units (L4), so an unstamped result would keep rendering the
  // previous unit's rows until the new read lands.
  const [groupLoad, setGroupLoad] = useState<{
    unit: string;
    value: ReviewGroupRow | 'loading' | 'missing' | 'failed';
  }>({ unit: unitKey, value: 'loading' });
  const loadedGroup = groupLoad.unit === unitKey ? groupLoad.value : 'loading';
  // Bumped by the failure card's Retry — re-runs whichever load failed.
  const [loadTick, setLoadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (singlesMode || !explicitGroupId || queueGroup) {
      setGroupLoad({ unit: unitKey, value: 'loading' });
      return;
    }
    void loadGroup(Number(explicitGroupId)).then(
      (fetched) => {
        if (!cancelled) setGroupLoad({ unit: unitKey, value: fetched ?? 'missing' });
      },
      (error) => {
        console.warn('[deck] group load failed:', String(error));
        if (!cancelled) setGroupLoad({ unit: unitKey, value: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [explicitGroupId, queueGroup, loadGroup, singlesMode, version, loadTick, unitKey]);
  const group: ReviewGroupRow | null =
    queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
  // m0.8.3 §5 (D9): a group straddling volumes shows only reachable
  // members while a card is out — the header NAMES the rest, so the
  // deck never silently presents a partial group as whole.
  const unreachableSuffix =
    (group?.unreachableCount ?? 0) > 0 ? ` · ${group!.unreachableCount} on unmounted SD card` : '';
  // m0.8.2: singles decks are day/run scoped and fetch their own rows —
  // kept photos included (group-deck parity, F10) — for the SAME reason
  // loadGroup exists above: the queue's singles feed is a bounded
  // newest-first pending page. `version` re-fetches, so a decision's
  // patch lands here too.
  // Stamped for the same reason as the group load above — and here the
  // stale case is worse: unstamped rows from the previous run would
  // satisfy `singlesReady`, and a run whose rows were all decided would
  // read as complete and advance again immediately.
  const [singlesLoad, setSinglesLoad] = useState<{
    unit: string;
    rows: ReviewMemberRow[] | 'failed' | null;
  }>({ unit: unitKey, rows: null });
  const deckSingles = singlesLoad.unit === unitKey ? singlesLoad.rows : null;
  useEffect(() => {
    if (!singlesMode || !day) return;
    let cancelled = false;
    void loadDeckSingles(day, range ?? null).then(
      (rows) => {
        if (!cancelled) setSinglesLoad({ unit: unitKey, rows });
      },
      (error) => {
        // An unreadable scope is NOT an empty one: 'failed' renders the
        // inline retry card and keeps `singlesReady` false, so the exit
        // effect — which treats a truly empty scope as consumed and
        // advances past it — never routes on a transient read failure.
        // It must also never widen to some broader feed.
        console.warn('[deck] singles load failed:', String(error));
        if (!cancelled) setSinglesLoad({ unit: unitKey, rows: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [day, range, singlesMode, loadDeckSingles, version, loadTick, unitKey]);
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
  /**
   * Each photo's CAPTURE DAY, for the time badge (m0.8.5, F17).
   *
   * `photos.day` is the honest field: for an undated photo `taken_at` is
   * the mtime fallback, so printing a date from it would turn a soft
   * claim into a confident one. The deck already carries `day` on its
   * member rows, so the badge needs no new plumbing — and a null day
   * renders through `labelForDayKey`, which is where the timeline's own
   * "Unknown day" wording comes from.
   */
  const dayOf = useMemo(() => {
    const map = new Map<string, string | null>();
    if (group) for (const m of group.members) map.set(m.asset_id, m.day);
    for (const m of singleRows) map.set(m.asset_id, m.day);
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
  /** The unit whose first-pending cursor has been applied (the effect
   * below the strip refs). STATE, not a ref (codex round 2): `holding`
   * reads it — rows landing do not end the hold until the successor's
   * OWN cursor is in place, or one committed render would show the
   * successor at the OUTGOING unit's cursor before snapping to
   * first-pending. State also guarantees the unhold render even when
   * the cursor value itself does not change. */
  const [cursorAppliedFor, setCursorAppliedFor] = useState<string | null>(null);
  const cursor = Math.min(browseCursor, Math.max(0, deckItems.length - 1));
  const current: MediaItem | null = deckItems[cursor] ?? null;
  /**
   * The unit's rows are not here yet (an in-place advance changes the
   * unit before its async read lands). The render FREEZES the previous
   * unit's view instead of unmounting anything (L4 round 3, §10 checks
   * 1/3/10): the early holding frame used to drop the header, strip and
   * every control for the gap, which read as the whole deck flickering
   * on each advance — and as a header-less "fullscreen photo" while the
   * goal barrier held. Logic below this line must keep reading the LIVE
   * stamped values; only the render reads the frozen view.
   */
  const holding = !current || (!singlesMode && (!groupId || !info)) || cursorAppliedFor !== unitKey;

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
  // A pinch must prove itself before it may change the zoom (see
  // lib/zoomTarget PINCH_ENGAGE_DELTA): these carry that decision, and
  // the raw scale it was made at, across the gesture's frames.
  const pinchTracking = useSharedValue(PINCH_TRACKING_START);
  /** This touch stream actually CHANGED the zoom — its release is a
   * pinch ending, not a flick, so the pan decay stays out of it (round
   * 5: a pinch release inherited the pan's velocity and flung the
   * photo). Cleared when the next touch stream begins. */
  const pinchZoomed = useSharedValue(false);

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
  // (worse), and asking for the JS thread outright (`runOnJS: true` in
  // a gesture config) trades the segfault for a TypeError in
  // onGestureHandlerEvent (the Babel plugin treats those callbacks
  // differently).
  //
  // Gesture Handler 3 makes this a WRITING rule, not just a design one:
  // the worklets Babel plugin only workletizes callbacks written INLINE
  // in a gesture's config object. Extract one to a named function — or
  // wrap it in useCallback/useMemo — and it silently becomes a JS-thread
  // callback, which is the crash above. Every callback below is inline
  // for that reason.
  //
  // So "is the deck zoomed?" lives ONLY in shared values:
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
  const stageGesture = usePinchGesture({
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
    // onFinalize (unlike onDeactivate) also fires on cancellation, so a
    // broken gesture can never strand the overlay barely above scale 1,
    // covering the pager.
    onFinalize: () => {
      // The engagement decision belongs to ONE pinch: left standing, the
      // next two fingers down would resume mid-zoom from a stale base.
      pinchTracking.value = PINCH_TRACKING_START;
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
    },
  });

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
      // A fresh touch stream: whether it turns into a pinch is decided
      // by the frames ahead of it.
      pinchZoomed.value = false;
    },
    onUpdate: (event) => {
      if (scale.value <= 1) return;
      const bounds = panBounds(stageW.value, stageH.value, imageAspect.value, scale.value);
      tx.value = clampPan(savedTx.value + event.translationX, bounds.maxX);
      ty.value = clampPan(savedTy.value + event.translationY, bounds.maxY);
    },
    onDeactivate: (event) => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      if (scale.value <= 1) return;
      // A stream that ZOOMED ends as a pinch, not a flick — momentum
      // out of it flung the photo on every two-finger zoom (round 5).
      if (pinchZoomed.value) return;
      // The release keeps the flick's momentum (§10 check 9 round 3 —
      // the standard gallery feel), decaying inside the same pan
      // bounds the drag was clamped to.
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
  // m0.7 (#18): double-tap resets zoom. The timing animation carries
  // scale back to exactly 1, which is what hides the overlay.
  const overlayDoubleTap = useTapGesture({
    numberOfTaps: 2,
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
  // deliberately not a tap gesture (`useTapGesture`), so no worklet is
  // involved (see the bridge comment above). Double tap zooms to the
  // tapped point; a
  // single tap (after the double-tap window) opens the standard
  // full-screen viewer in browse mode. Ref-dispatched so renderPage
  // stays stable.
  const stageTapRef = useRef<() => void>(() => {});
  stageTapRef.current = () => {
    // Reading a shared value from JS is a sync snapshot — fine here: a
    // zoomed stage keeps taps to itself anyway via pointerEvents.
    // A FROZEN deck (rows loading) opens nothing: `browse` already
    // belongs to the incoming unit while the stage still shows the
    // outgoing one.
    if (scale.value === 1 && browse && !holding) setViewerOpen(true);
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
  }, [unitKey, browse]);
  useEffect(() => {
    setFinishing(false);
  }, [unitKey]);
  useEffect(() => {
    if (finishing && !busy && !browse) setFinishing(false);
  }, [finishing, busy, browse]);
  useEffect(() => {
    if (busyOwner !== 'finish') {
      setFinishSlow(false);
      return;
    }
    const timer = setTimeout(() => setFinishSlow(true), 400);
    return () => clearTimeout(timer);
  }, [busyOwner]);
  /** What the CONTROLS render as. Held on the live block through a
   * finish so the advance, not a swap, is what ends the unit. */
  const browseControls = browse && !finishing;
  // A fresh unit opens on its FIRST pending photo (m0.8.2): a
  // half-finished run or group re-entered from the overview lands on the
  // work, not on a decided photo at index 0. Applied once per unit, when
  // its rows are actually there (the singles fetch is async).
  useEffect(() => {
    if (cursorAppliedFor === unitKey) return;
    if (singlesMode ? !singlesReady : !group) return;
    const firstPending = deckItems.findIndex(
      (i) => (stateOf.get(i.id) ?? 'unreviewed') === 'unreviewed',
    );
    setBrowseCursor(firstPending > 0 ? firstPending : 0);
    setCursorAppliedFor(unitKey);
  }, [unitKey, cursorAppliedFor, singlesMode, singlesReady, group, deckItems, stateOf]);
  // The thumbnail strip's live geometry. Refs, not state: these change
  // on every scroll frame and nothing renders from them.
  const stripRef = useRef<ScrollView>(null);
  const stripOffsetRef = useRef(0);
  const stripViewportRef = useRef(0);
  const stripContentRef = useRef(0);
  /** Bumped when layout or content width lands. Without it the follow
   * effect runs once against a zero viewport — or the previous unit's
   * content width — and returns null, leaving a half-reviewed unit open
   * with its current thumbnail off-screen (codex r3). */
  const [stripMeasured, setStripMeasured] = useState(0);
  /**
   * The page the native pager currently SHOWS (F7 round 2, §10 check
   * 8): `cursor` settles only at momentum end, so the strip highlight
   * trailed every swipe by the settle. This index follows the live
   * scroll offset — the highlight and the follow-scroll move as the
   * page crossing happens. `cursor` stays the deck's one source of
   * truth for everything that ACTS (controls, badges, effects); this is
   * display-only.
   */
  const [pagerIndex, setPagerIndex] = useState(0);
  useEffect(() => {
    // Programmatic moves (unit reset, jumpTo, clamp after a cull) land
    // here; live swipes land via onPagerScroll below.
    setPagerIndex(cursor);
  }, [cursor]);
  useEffect(() => {
    // While holding, the strip shows the FROZEN unit — its own cursor
    // is the only meaningful focus, and it is already in place.
    if (holding) return;
    const target = stripScrollOffset(pagerIndex, stripOffsetRef.current, {
      pitch: THUMB + THUMB_GAP,
      size: THUMB,
      leadingInset: THUMB_INSET,
      viewport: stripViewportRef.current,
      content: stripContentRef.current,
    });
    if (target === null) return; // already visible — do not fight a manual scroll
    stripOffsetRef.current = target;
    stripRef.current?.scrollTo({ x: target, animated: true });
    // deckItems is a dependency because a cull or an undo changes the
    // content width under a cursor that did not move.
  }, [pagerIndex, holding, deckItems, stripMeasured]);
  /**
   * Which PAGE Images have painted (their own onLoad — the zoom
   * overlay's would not do: it is a separate Image instance, and hiding
   * the underlay on ITS load left dark frames while the page was still
   * painting, measured on the emulator probe). The underlay shows the
   * previous photo until the current page's own paint has landed
   * (§10 check 3). A set, not a single id: neighbor pages preload, and
   * a page already painted must not re-summon the underlay when swiped
   * back to. `decodedTick` re-renders the frame where the CURRENT page
   * lands, and re-runs the lastPhotoRef capture below.
   */
  const loadedPagesRef = useRef<Set<string>>(new Set());
  const [decodedTick, setDecodedTick] = useState(0);
  const currentIdRef = useRef<string | null>(null);
  /** The photo the stage last actually PAINTED. It backs the pager's
   * underlay: while a freshly-swapped page's Image still decodes, the
   * previous photo shows through instead of a blank stage (§10 check 3
   * — decode latency was visible on the S10e even with the chrome
   * mounted). Only PAINTED uris are captured (codex device-pass round):
   * capturing live `current` advanced the underlay to the incoming,
   * still-decoding uri whenever an unrelated render landed mid-decode,
   * reopening the blank window this exists to close. */
  const lastPhotoRef = useRef<string | null>(null);
  useEffect(() => {
    if (current && loadedPagesRef.current.has(current.id)) lastPhotoRef.current = current.uri;
  }, [current, decodedTick]);
  /** The last LOADED render's view — what the body draws while the next
   * unit's rows load (see `holding`). */
  const heldViewRef = useRef<DeckView | null>(null);
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

  // ------------------------------------------ goal celebration (F14)
  // The counter lives in ReviewContext (a crossing can happen on the
  // Compare screen too); this surface claims and renders the pending
  // moment whenever it is the focused one.
  const [celebrating, setCelebrating] = useState(false);
  const [celebrationGoal, setCelebrationGoal] = useState(0);
  useEffect(() => {
    if (!isFocused || celebrationPending === null) return;
    const goal = consumeCelebration();
    if (goal !== null) {
      setCelebrationGoal(goal);
      setCelebrating(true);
    }
  }, [celebrationPending, isFocused, consumeCelebration]);
  // Host the moment while MOUNTED, not merely while focused (m0.8.5,
  // A4, codex r1). Opening Compare unfocuses this screen without
  // removing the surface that will draw the moment — and the last host
  // to leave surfaces any unclaimed moment as a toast, so a
  // focus-scoped registration would fire that toast every time a duel
  // opened. Consuming is still focus-scoped, just above: hosting says
  // "someone can draw this", consuming says "I am the visible one".
  useEffect(() => registerCelebrationHost(), [registerCelebrationHost]);

  // m0.7 (#20): only advance out of a singles deck when completion
  // happened DURING this visit. A fully-reviewed run/day opened from the
  // overview is a deliberate revisit and stays in browse mode — exactly
  // like reopening a completed group.
  // Keyed on the UNIT, not on mount: since L4 a run→run advance keeps
  // this component mounted, and a ref left holding the previous run's
  // answer would make a genuinely-completed-here run read as a revisit
  // and stop the flow dead.
  const singlesEnteredCompleteRef = useRef<{ unit: string; complete: boolean } | null>(null);
  useEffect(() => {
    if (!singlesMode) {
      singlesEnteredCompleteRef.current = null;
      return;
    }
    // The deck cannot judge this until its rows have landed.
    if (!singlesReady) return;
    if (singlesEnteredCompleteRef.current?.unit !== unitKey) {
      singlesEnteredCompleteRef.current = { unit: unitKey, complete: singlesPending === 0 };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlesMode, singlesReady, unitKey]);
  useEffect(() => {
    if (!singlesMode || !singlesReady || busy || !isFocused) return;
    // Hold for the goal moment (m0.8.5, F4/A1). The celebration is drawn
    // ON this screen, so advancing while it plays tears it down mid-way
    // — which is exactly what the replace used to do. `celebrating`
    // clears on the overlay's own onDone and this effect re-runs.
    // Three gates, one per stage of the hand-off (codex r1, r2):
    // `celebrationSettling` while the write's goal evaluation is still
    // running — the write commits first, so without it the crossing
    // decision advances before anyone knows it WAS the crossing;
    // `celebrationPending` once a moment is claimed but not yet drawn —
    // arming and lowering the barrier land in one batched render, so the
    // consume effect has not set `celebrating` when these effects run in
    // that same flush; and `celebrating` while it plays.
    if (celebrating || celebrationSettling || celebrationPending !== null) return;
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
    const entered = singlesEnteredCompleteRef.current;
    if (entered?.unit === unitKey && entered.complete) return; // deliberate revisit
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
    unitKey,
    celebrating,
    celebrationSettling,
    celebrationPending,
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
    // Do not consume the transition while its write is still in flight,
    // while Compare/another screen is on top, or while the goal moment is
    // playing (m0.8.5, F4/A1). The next focused, idle, quiet render
    // performs the advance — completionRef is deliberately left untouched
    // until then, exactly as it is for an in-flight write.
    if (!isFocused || busy || celebrating || celebrationSettling || celebrationPending !== null)
      return;
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
    celebrating,
    celebrationSettling,
    celebrationPending,
  ]);

  /** The offset the pager was last told to show. `jumpTo` animates there
   * itself, and the alignment effect below runs on every cursor change —
   * without this it would re-issue the same scroll unanimated and snap
   * the motion jumpTo had just started. */
  const pagerTargetRef = useRef(-1);
  /** The unit the pager was last aligned FOR (grilling Q3, S10e). A new
   * unit's first alignment is UNCONDITIONAL: the offset dedup below
   * cannot be trusted across a unit boundary, because a swipe whose
   * momentum a quick finish tap cut short moves the native list without
   * any event ever updating the bookkeeping — the successor then opened
   * showing the swiped-to page while every control pointed at its first
   * pending photo. Within a unit the dedup stays (it is what keeps this
   * effect from snapping jumpTo's animation). */
  const alignedUnitRef = useRef<string | null>(null);
  // Keep the pager aligned with the cursor whenever the deck's membership
  // changes (cull/undo/make-single/re-decide) or a new unit starts.
  //
  // `cursor` is a dependency (codex r1/r2/r3): an in-place advance sets
  // the new unit's first-pending cursor in a LATER render than the one
  // that changed deckKey, so keying on membership alone left the native
  // list showing the previous unit's page while every control pointed at
  // the new unit's first photo — a tap would then decide a photo other
  // than the one on screen. A swipe also lands here now, where the
  // scroll target is the offset the list already settled on, so it is a
  // no-op rather than a fight. `holding` is one too: while the view is
  // frozen the list still shows the PREVIOUS unit, so aligning it to the
  // successor's cursor would visibly scroll the frozen photo — the
  // unhold render re-runs this with the swapped data.
  const deckKey = `${singlesMode ? 'singles' : (groupId ?? '')}:${browse ? 'b' : 'r'}:${deckItems.map((i) => i.id).join(',')}`;
  useEffect(() => {
    if (!pageW || deckItems.length === 0 || holding) return;
    const offset = cursor * pageW;
    const unitChanged = alignedUnitRef.current !== unitKey;
    if (!unitChanged && pagerTargetRef.current === offset) return;
    alignedUnitRef.current = unitKey;
    pagerTargetRef.current = offset;
    listRef.current?.scrollToOffset({ offset, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pageW, cursor, holding, unitKey]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW) return;
      // A swipe on the FROZEN deck (rows still loading) must not write
      // the new unit's cursor from the old unit's pages.
      if (holding) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / pageW);
      // The ref mirrors where the list PHYSICALLY is, swipes included —
      // it held only COMMANDED offsets, so a manual swipe before a
      // finish left it stale, the alignment effect then skipped its
      // correcting scroll for a successor whose cursor offset matched
      // the stale value, and the new unit opened showing its second
      // photo while every control pointed at its first (Tristan, S10e
      // 2026-08-11 — the frozen-swipe desync's live-swipe twin).
      pagerTargetRef.current = index * pageW;
      if (index !== cursor) setBrowseCursor(index);
    },
    [pageW, cursor, holding],
  );

  /** A jumpTo's animated scroll is in flight. While set, the live
   * pager index ignores scroll events: jumpTo already pointed the
   * highlight at its destination, and the animation's intermediate
   * offsets would round back to the OLD page first — on device the
   * highlight visibly flip-flopped on every decide-advance (§10 check
   * 8, round 2). Cleared on arrival, or the moment a finger interrupts
   * the animation (the drag is live user intent again). */
  const pagerAnimatingRef = useRef(false);
  /** Display-only live index for the strip (see `pagerIndex`). */
  const onPagerScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW || holding) return;
      const offset = event.nativeEvent.contentOffset.x;
      if (pagerAnimatingRef.current) {
        if (Math.abs(offset - pagerTargetRef.current) >= 1) return; // still travelling
        pagerAnimatingRef.current = false;
      }
      const index = Math.round(offset / pageW);
      setPagerIndex((previous) => (previous === index ? previous : index));
    },
    [pageW, holding],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (!pageW) return;
      setBrowseCursor(index);
      setPagerIndex(index);
      pagerAnimatingRef.current = true;
      pagerTargetRef.current = index * pageW;
      listRef.current?.scrollToOffset({ offset: index * pageW, animated: true });
    },
    [pageW],
  );

  const run = useCallback(
    /** `owner` names the control that started the write, so a control can
     * show ITS OWN progress instead of borrowing the screen's. Without
     * it the big Keep-remaining button flashed on every chip press —
     * label swapping to "Saving…" and the button fading to 40% for a
     * write it had nothing to do with (Tristan, S23 pass 2026-08-04). */
    async (action: () => Promise<void>, owner: BusyOwner = 'other') => {
      if (busy) return;
      setBusy(true);
      setBusyOwner(owner);
      if (owner === 'finish') setFinishing(true);
      try {
        await action();
      } catch {
        // The provider already surfaced the write error (alert) — the
        // rejection must not escape as unhandled.
      } finally {
        setBusy(false);
        setBusyOwner(null);
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
    // The goal is credited by the WRITE (m0.8.5, A3), which is what
    // makes a dissolved off-page group that keeps nothing count nothing.
    void run(() => keepRest(group.groupId).then(() => {}), 'finish');
  }, [group, run, keepRest]);

  const toggleBest = useCallback(() => {
    if (!group || !current) return;
    void run(async () => {
      await markBest(group.groupId, isBest ? null : current.id);
      // m0.7 item F (#10): the hand-off is WRITE-ONLY — never offered for
      // an already-favourited photo (toggleFavourite would UN-favourite
      // it), and "Not now" stays a strict no-op.
      const offer = shouldOfferFavouriteHandoff(favouriteStatus(current.id));
      if (!isBest && offer) {
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
          onLoad={() => {
            // This page has painted — the decode underlay may drop for
            // it. Re-render only when it is the CURRENT page: that is
            // the one the underlay is covering.
            if (loadedPagesRef.current.has(item.id)) return;
            loadedPagesRef.current.add(item.id);
            if (item.id === currentIdRef.current) setDecodedTick((t) => t + 1);
          }}
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
            if (singlesMode) setSinglesLoad({ unit: unitKey, rows: null });
            else setGroupLoad({ unit: unitKey, value: 'loading' });
            setLoadTick((t) => t + 1);
          }}
        >
          <Text style={[styles.retryText, { color: theme.accent }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  /**
   * The view the body renders (L4 round 3, §10 checks 1/3/10). Loaded
   * renders capture it; while the next unit's rows load (`holding`) the
   * PREVIOUS capture renders instead, with every control inert — so an
   * advance never unmounts the header, strip or buttons, and the goal
   * moment can play over the completed unit it belongs to. Only the
   * navigation title is the incoming unit's (the vetted hand-off
   * behavior); the body swaps whole when the rows land.
   */
  const liveView: DeckView | null =
    holding || current === null
      ? null
      : {
          items: deckItems,
          cursor,
          current,
          stateOf,
          dayOf,
          needMs,
          bestId: singlesMode ? null : (info?.bestId ?? null),
          isGroup: !singlesMode && !!groupId,
          headerTitle: singlesMode
            ? `${range || !day ? 'Singles' : `${labelForDayKey(day)} · singles`} · ${deckItems.length - singlesPending} of ${deckItems.length} reviewed${
                range ? ` · ${queueCounts.singles.toLocaleString()} left in library` : ''
              }`
            : browse
              ? `Group · ${deckItems.length} reviewed${unreachableSuffix}`
              : `Group · ${deckItems.length - aliveItems.length} of ${deckItems.length} reviewed · ${queueCounts.groups.toLocaleString()} groups left${unreachableSuffix}`,
          headerHint: browse
            ? singlesMode
              ? 'Reviewed singles — change any decision until the final delete confirmation.'
              : 'Reviewed group — change any decision until the final delete confirmation.'
            : singlesMode
              ? range
                ? 'Swipe through the run · decided shots stay badged (tap the same verdict to undo) · Keep remaining finishes.'
                : "This day's ungrouped shots · decided shots stay badged (tap the same verdict to undo)."
              : 'Swipe through the group · decided shots stay badged (tap the same verdict to undo) · Keep rest finishes.',
          browseControls,
          keepCount: deckItems.length,
          finishCount: singlesMode ? singlesPending : aliveItems.length,
        };
  if (liveView) heldViewRef.current = liveView;
  const view = liveView ?? heldViewRef.current;
  /** Frozen view: LOOK normal, DO nothing. */
  const inert = liveView === null;
  // What the stage is SHOWING this render — the id whose page paint the
  // underlay waits for (render-time, so the swap frame reads the new id).
  currentIdRef.current = view?.current.id ?? null;
  if (view === null) {
    // Nothing to freeze — the session's very first deck is still
    // reading its rows. The outgoing-photo stage (or a blank breath on
    // a cold open) is all there is to show.
    return (
      <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
        {lastPhotoRef.current !== null && (
          <View style={styles.stage}>
            <Image
              source={{ uri: lastPhotoRef.current }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              transition={0}
            />
          </View>
        )}
      </View>
    );
  }

  // Compare eligibility mirrors openCompare exactly: undecided or KEPT
  // candidates (F11), and the CURRENT photo must be one of them.
  const compareStates = ['unreviewed', 'kept'];
  const compareCandidateCount = view.items.filter((i) =>
    compareStates.includes(view.stateOf.get(i.id) ?? 'unreviewed'),
  ).length;
  const compareEligible =
    compareCandidateCount >= 2 &&
    compareStates.includes(view.stateOf.get(view.current.id) ?? 'unreviewed');

  const flagged = needsEdit(view.current.id);
  const favourite = isFavouriteSelected(favouriteStatus(view.current.id));
  const { share: shareQueued, organize: organizeQueued } = queuedFor(view.current.id);
  const currentState = view.stateOf.get(view.current.id) ?? 'unreviewed';
  const browseState: RedecideTarget =
    currentState === 'culled' ? 'cull' : flagged ? 'to_edit' : 'keep';
  const viewIsBest = view.isGroup && view.bestId !== null && view.bestId === view.current.id;
  /** Every badge a deck photo wears — the verdict AND all four actions,
   * none hiding another (m0.8.1 round 4), each at its own weight: loud
   * while it waits for you, quiet once the photo carries it (m0.8.2).
   * The verdict rides into actionWeights so a staged cull's retained
   * actions badge quiet — they left the queues with it. */
  const badgesFor = (item: MediaItem): PhotoBadge[] => {
    const state = view.stateOf.get(item.id) ?? 'unreviewed';
    return photoBadges({
      state,
      ...actionWeights(item.id, state),
      best: view.bestId !== null && view.bestId === item.id,
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
   * looking at that one). Unreachable while `inert`: every control
   * that calls it is disabled on a frozen view. */
  const decideCurrent = async (target: RedecideTarget) => {
    if (inert || current === null) return;
    const index = cursor;
    // Still read here, but only to decide whether the PAGER advances —
    // the goal credit comes from the write itself (m0.8.5, A3).
    const wasUnreviewed = (stateOf.get(current.id) ?? 'unreviewed') === 'unreviewed';
    await redecide(current.id, target);
    if (wasUnreviewed && index + 1 < deckItems.length) jumpTo(index + 1);
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        {/* Truthful numbers only (m0.8.2, F12): the unit's own progress
            over its FIXED membership, plus the library-wide remainder
            from the DB counts — never a page-position ordinal. */}
        <Text style={styles.headerTitle}>{view.headerTitle}</Text>
        <Text style={styles.headerHint}>{view.headerHint}</Text>
      </View>

      {/* VIRTUAL detectors under ONE intercepting host (Gesture Handler
          3). The plain `GestureDetector` is now a HOST component, and
          two things in this tree cannot survive one: the pager's native
          scroll (a host detector above it swallows the horizontal drag —
          the deck could not be swiped at all, caught by the UI gate),
          and the always-mounted zoom overlay, whose touchability is an
          ANIMATED pointerEvents prop on the Animated.View — a host
          detector wrapped around it is not covered by that prop, so it
          would eat every stage touch while unzoomed. `VirtualGestureDetector`
          is the RNGH2-shaped detector: it attaches gestures to the child
          it already has instead of inserting a view, so the hierarchy —
          and both behaviours above — stay exactly as they were. */}
      <InterceptingGestureDetector>
        <VirtualGestureDetector gesture={stageGesture}>
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
                  {/* Decode underlay: the page Image a data swap mounts
                      starts transparent until its decode lands, and on
                      the S10e that gap was a visible blank (§10 check
                      3). The previous photo sits under the pager for
                      exactly those frames. ALWAYS MOUNTED, visibility by
                      opacity: mounting it on demand reproduced the blank
                      (a freshly-mounted Image paints a frame late even
                      from cache — emulator probe), while left visible it
                      would ghost through every contained page's
                      letterbox margins. */}
                  {lastPhotoRef.current !== null && (
                    <Image
                      source={{ uri: lastPhotoRef.current }}
                      style={[
                        StyleSheet.absoluteFill,
                        { opacity: inert || !loadedPagesRef.current.has(view.current.id) ? 1 : 0 },
                      ]}
                      contentFit="contain"
                      transition={0}
                    />
                  )}
                  <FlatList
                    ref={listRef}
                    data={view.items}
                    keyExtractor={(i) => i.id}
                    renderItem={renderPage}
                    horizontal
                    pagingEnabled
                    // A FROZEN deck is fully inert (codex device-pass
                    // round): a swipe would move the native offset while
                    // every guard ignores it, and the alignment effect
                    // can then skip its correcting scroll (equal cached
                    // target) — controls acting on a photo that is not
                    // the one on screen.
                    scrollEnabled={!inert}
                    showsHorizontalScrollIndicator={false}
                    initialScrollIndex={Math.min(view.cursor, view.items.length - 1)}
                    getItemLayout={(_data, index) => ({
                      length: pageW,
                      offset: pageW * index,
                      index,
                    })}
                    onScroll={onPagerScroll}
                    scrollEventThrottle={32}
                    onScrollBeginDrag={() => {
                      pagerAnimatingRef.current = false;
                    }}
                    onMomentumScrollEnd={onMomentumEnd}
                  />
                </View>
              </>
            )}
            {/* Always mounted; visibility + touchability are UI-thread
                animated props (see zoomStyle/zoomOverlayProps). The image
                is the same URI the pager page shows, so expo-image serves
                it from cache rather than decoding twice. */}
            <VirtualGestureDetector gesture={zoomedGesture}>
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
                    source={{ uri: view.current.uri }}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    recyclingKey={`zoom-${view.current.id}`}
                    onLoad={(event) => {
                      const { width, height } = event.source;
                      if (width > 0 && height > 0) imageAspect.value = width / height;
                    }}
                  />
                </Animated.View>
              </Animated.View>
            </VirtualGestureDetector>
            <View style={styles.posBadge} pointerEvents="none">
              <Text style={styles.posBadgeText}>
                {view.cursor + 1}/{view.keepCount}
              </Text>
            </View>
            <View style={styles.timeBadge} pointerEvents="none">
              {/* Day AND time (F17): a time with no date says nothing
                  about WHEN in a library you are reviewing out of order.
                  Rendered from `day`, NEVER from taken_at. */}
              <Text style={styles.timeBadgeText}>
                {`${labelForDayKey(view.dayOf.get(view.current.id) ?? UNDATED_DAY_KEY)} · ${formatClockPrecise(
                  view.current.timestamp,
                  view.needMs[view.cursor] ?? false,
                )}`}
              </Text>
            </View>
            <BadgeCluster
              badges={badgesFor(view.current)}
              size={24}
              accent={theme.accent}
              style={styles.flagBadge}
            />
          </View>
        </VirtualGestureDetector>
      </InterceptingGestureDetector>

      {/* The strip FOLLOWS the current photo (m0.8.5, F7). It used to be
          a plain ScrollView with no ref, so past roughly the seventh
          photo of a run the thumbnail you were on sat off-screen while
          the pager tracked the cursor perfectly. Geometry in, offset out
          — the rule and its edge cases live in lib/stripScroll.ts. */}
      <ScrollView
        ref={stripRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.thumbStrip}
        contentContainerStyle={styles.thumbStripContent}
        scrollEventThrottle={16}
        onScroll={(event) => {
          stripOffsetRef.current = event.nativeEvent.contentOffset.x;
        }}
        onLayout={(event) => {
          if (stripViewportRef.current === event.nativeEvent.layout.width) return;
          stripViewportRef.current = event.nativeEvent.layout.width;
          setStripMeasured((n) => n + 1);
        }}
        onContentSizeChange={(width) => {
          if (stripContentRef.current === width) return;
          stripContentRef.current = width;
          setStripMeasured((n) => n + 1);
        }}
      >
        {view.items.map((item, index) => (
          <Pressable
            key={item.id}
            onPress={() => {
              if (!inert) jumpTo(index);
            }}
            onLongPress={() => {
              // Compare via long-press works in browse too (F11): two
              // KEPT members are a legitimate duel — the dialog can
              // re-decide one.
              if (!inert && item.id !== view.current.id) openCompare(item.id);
            }}
          >
            <Image
              source={{ uri: item.uri }}
              style={[
                styles.thumb,
                // The LIVE pager index (§10 check 8): the highlight moves
                // with the page crossing, not at momentum end. A frozen
                // deck keeps its own settled cursor.
                index === (inert ? view.cursor : pagerIndex) && styles.thumbActive,
                view.bestId !== null && item.id === view.bestId && { borderColor: theme.accent },
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

      {view.browseControls ? (
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
                  disabled={busy || inert}
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
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(() => decideCurrent('to_edit'))}
            />
            <ActionChip
              kind="favourite"
              active={favourite}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(() => toggleFavourite(current.id))}
            />
            <ActionChip
              kind="organize"
              active={organizeQueued}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(toggleOrganize)}
            />
            <ActionChip
              kind="share"
              active={shareQueued}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(toggleShare)}
            />
            {view.isGroup && (
              <Pressable
                style={[
                  styles.secondaryButton,
                  viewIsBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
                  // Same staged-cull rule as the chips (§10 check 19),
                  // same look; busy stays out of the visual on purpose.
                  currentState === 'culled' && styles.controlDimmed,
                ]}
                // Only a staged cull is barred from Best (cull-star
                // hygiene) — a completed group's kept members stay
                // starrable in browse mode.
                disabled={busy || inert || currentState === 'culled'}
                onPress={toggleBest}
              >
                <MaterialCommunityIcons
                  name={viewIsBest ? 'star' : 'star-outline'}
                  size={18}
                  color={viewIsBest ? theme.accent : colors.textDim}
                />
                <Text style={[styles.secondaryText, viewIsBest && { color: theme.accent }]}>
                  Best
                </Text>
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
              disabled={busy || inert}
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
              disabled={busy || inert || !compareEligible}
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
              disabled={busy || inert}
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
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(() => toggleNeedsEdit(current.id))}
            />
            <ActionChip
              kind="favourite"
              active={favourite}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(() => toggleFavourite(current.id))}
            />
            <ActionChip
              kind="organize"
              active={organizeQueued}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(toggleOrganize)}
            />
            <ActionChip
              kind="share"
              active={shareQueued}
              disabled={busy || inert || currentState === 'culled'}
              dimmed={currentState === 'culled'}
              onPress={() => void run(toggleShare)}
            />
          </View>

          {view.isGroup && (
            <View style={styles.secondaryRow}>
              <Pressable
                style={[
                  styles.secondaryButton,
                  viewIsBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
                  // Same staged-cull rule as the chips (§10 check 19),
                  // same look; busy stays out of the visual on purpose.
                  currentState === 'culled' && styles.controlDimmed,
                ]}
                // A staged cull is not ALIVE — un-cull it before starring.
                disabled={busy || inert || currentState === 'culled'}
                onPress={toggleBest}
              >
                <MaterialCommunityIcons
                  name={viewIsBest ? 'star' : 'star-outline'}
                  size={18}
                  color={viewIsBest ? theme.accent : colors.textDim}
                />
                <Text style={[styles.secondaryText, viewIsBest && { color: theme.accent }]}>
                  Best
                </Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                disabled={busy || inert}
                onPress={() => group && void run(() => makeSingle(current.id, group.groupId))}
              >
                <MaterialCommunityIcons name="image-move" size={18} color={colors.textDim} />
                <Text style={styles.secondaryText}>Not related</Text>
              </Pressable>
            </View>
          )}

          <BigButton
            // "Saving…" only once the write has actually run long (§10
            // check 2): a fast finish advances before the timer fires,
            // so the label no longer flashes through two texts on every
            // normal finish. The button still disables instantly — the
            // press must land exactly once either way.
            label={finishSlow ? 'Saving…' : `Keep remaining (${view.finishCount})`}
            color={colors.keep}
            // `busy` included (codex r3): the label already said "Saving…"
            // while the control stayed pressable, so the disabled look and
            // the disabled behaviour disagreed for the whole write.
            disabled={busy || inert || view.finishCount === 0}
            onPress={() =>
              singlesMode
                ? day && void run(() => keepAllSingles(day, range ?? null).then(() => {}), 'finish')
                : finishGroup()
            }
          />
        </>
      )}

      {viewerOpen && (
        <PhotoViewer
          items={view.items.map((i) => ({ id: i.id, uri: i.uri, takenAt: i.timestamp }))}
          initialIndex={view.cursor}
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
            <Text style={styles.pickerHint}>
              Pick the photo to compare against {view.cursor + 1}.
            </Text>
            <View style={styles.pickerGrid}>
              {/* BOTH modes: candidates are the deck's undecided-or-KEPT
                  items (F11), labeled by their DECK position — a
                  filtered-subset index would disagree after a cull. A
                  kept candidate wears its keep badge, so duelling a
                  prior decision is visible before the tap. */}
              {view.items
                .map((item, deckIndex) => ({ item, deckIndex }))
                .filter(({ item }) =>
                  compareStates.includes(view.stateOf.get(item.id) ?? 'unreviewed'),
                )
                .map(({ item, deckIndex }) =>
                  item.id === view.current.id ? null : (
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
                      {(view.stateOf.get(item.id) ?? 'unreviewed') === 'kept' && (
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
  // Both numbers feed lib/stripScroll's geometry as well as this style,
  // so the follow effect and the layout can never drift apart (F7).
  thumbStripContent: { gap: THUMB_GAP, paddingHorizontal: THUMB_INSET },
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
  // ActionChip's chipDimmed, for the deck-owned Best control.
  controlDimmed: { opacity: 0.4 },
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
