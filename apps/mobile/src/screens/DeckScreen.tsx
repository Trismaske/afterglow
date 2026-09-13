import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  PixelRatio,
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
import { useIsFocused } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
/** A deck page item: the core DeckItem plus its IMAGE VERSION (phase 3
 * item 3). The version rides the item, not a ref, so a page renders its
 * key from the data it was rendered for — and it is part of the
 * `recyclingKey`: expo-image keeps a recycled view's pixels when uri and
 * recyclingKey match, so a bumped cacheKey alone left the STAGE on the
 * pre-edit picture while the strip had moved on (S23, 2026-09-08). */
/** A deck page's item: the core item plus its image version (item 3) and,
 * for a motion photo, its clip (phase 5) — on the row, so the page mounts
 * its overlay synchronously (MediaStage's no-mid-touch-mount rule). */
type DeckItem = MediaItem & { version: number; motion: MotionClipRow | null };
import type { RootStackParamList } from '../navigation';
import { useReview, type RedecideTarget } from '../review/ReviewContext';
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded, plural } from '../lib/format';
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { OsThumbnail } from '../components/OsThumbnail';
import { VideoPage } from '../components/VideoPage';
import { PhotoPage } from '../components/PhotoPage';
import type { PlaybackStage } from '../components/Playback';
import { PLAYBACK_KEYS, parsePlaybackMode, type PlaybackMode } from '../lib/playbackPrefs';
import type { SurfaceType } from 'expo-video';
import { thumbBucketPx } from '../lib/thumbnailSize';
import { imageCacheKey, versionedUri } from '../lib/imageKeys';
import { checkMediaPresence } from '../lib/media';
import { showToast } from '../lib/toast';
import { classifyPhotoState } from '../lib/progress';
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
import {
  BadgeCluster,
  DecisionBadge,
  DECISION_GLYPHS,
  StateDots,
  useBadgesHidden,
} from '../components/DecisionBadge';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected } from '../lib/favouriteState';
import { folderNameOfUri, isSdPhoto, photoBadges, type PhotoBadge } from '../lib/photoBadges';
import { badgesHidden, setBadgesHidden, subscribeBadgesHidden } from '../lib/badgePrefs';
import { useSQLiteContext } from 'expo-sqlite';
import { addToShareQueue, removeFromShareQueue } from '../db/shareStore';
import { queueOrganize, unqueueOrganize } from '../db/organizeStore';
import { useDoubleTapZoom } from '../components/useDoubleTapZoom';
import { stripScrollOffset } from '../lib/stripScroll';
import { nearestPendingIndex } from '../lib/deckAdvance';
import {
  deckListKey,
  listFromParams,
  resolveDeckListPage,
  type DeckListCursor,
  type PresenceProbe,
  type DeckListDescriptor,
  type DeckListRow,
} from '../lib/deckList';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { resolveSources } from '../lib/sourceCatalog';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { Animated as RNAnimated, BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  clearNotRelated,
  getNotRelatedCount,
  getSetting,
  motionClipOf,
  type MotionClipRow,
} from '../db/store';
import { requestTargetedRescan } from '../scan/scanRunner';
import { withUserWritePriority } from '../lib/writePriority';
import { DeckDetailsOverlay } from '../components/DeckDetailsOverlay';
import { flushRegionZoomRetention } from '../components/useRegionZoom';
import { useStageMaxScale, useStageRegionZoom } from '../components/useStageZoom';
import { MediaStageView, useMediaStage } from '../components/MediaStage';
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

/** A browse list handed over by a host (m0.9 phase 2, P2-1/P2-2):
 * the deck resolves rows itself through lib/deckList.ts. */
type DeckListEntry = { descriptor: DeckListDescriptor; anchorId: string | null };

type SharedProps = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  /** The unit to review. Replacing it advances the deck in place. */
  unit: DeckUnit;
  /** Advance to another unit without leaving the route. */
  advanceTo: (unit: DeckUnit) => void;
  /** Non-null = LIST MODE: browse `list` instead of the unit. */
  list: DeckListEntry | null;
};

const THUMB = 52;
/** OS-thumbnail request buckets (lib/thumbnailSize): the strip thumb at
 * device scale; the at-rest stage paint at 512 — the largest size the
 * store serves from cache on every device we measured, replaced by the
 * full decode as soon as it lands. */
const STRIP_THUMB_PX = thumbBucketPx(THUMB, PixelRatio.get());
const STAGE_THUMB_PX = 512;
/** The player's Android surface (M27): fixed per build for the
 * measurement — SurfaceView vs TextureView on both phones over ≥ 1 min
 * of playback. The stage's always-mounted overlays are the documented
 * SurfaceView overlap case, so the measurement starts here. */
const VIDEO_SURFACE_TYPE: SurfaceType = 'textureView';
const PICKER_THUMB_PX = thumbBucketPx(72, PixelRatio.get());
const THUMB_GAP = 6;
const THUMB_INSET = 2;
// The max zoom is DYNAMIC per photo (m0.8.8): maxScaleFor in
// lib/regionZoom.ts owns the formula, useStageMaxScale feeds it, and
// pans clamp to the photo's own edges via panBounds — rationale in
// components/useStageZoom.ts and MediaStage.tsx (m0.9 phase 1).

/** F28 (m0.8.8, G9): ONE weighted verdict row — Keep · Compare · Not
 * related · Cull — in both deck kinds, reclaiming the group deck's
 * fourth row (~68 px of stage). The verdict buttons out-weigh the
 * middle pair 1.4:1 (fat-finger separation for the writing buttons);
 * the finish button cedes 64→56 (deck-local — every other surface
 * keeps `touch.action`). All three numbers are DEVICE-PASS TUNABLES;
 * the pre-registered fallback for the ¼-width middle labels is icon +
 * short label. */
const VERDICT_ROW_MIN_HEIGHT = 50;
// 1.4 → 1.5 → 1.6 → 1.75 (S23 device pass, Tristan): 1.75 ACCEPTED.
const VERDICT_FLEX = 1.75;
const FINISH_MIN_HEIGHT = 56;

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

/**
 * Swipe-deck group review (m0.4, replacing the duel bracket): the group is
 * a horizontally swipeable deck of ALL its photos — a decided photo stays
 * in place wearing its badges, and re-tapping the active verdict clears
 * it (the badge is the undo). Cull any photo as you meet it, flag
 * needs-edit, eject a mis-grouped photo to the singles flow, or open the
 * Compare tool.
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
/** The list-mode navigation title per source (P2-2: one route, mode by
 * params; the in-page header hides in list mode, so this is the one
 * place the list names itself). */
function listTitle(descriptor: DeckListDescriptor): string {
  switch (descriptor.source) {
    case 'queue':
      return {
        edit: 'Edit queue',
        favourite: 'Favourites',
        share: 'Share queue',
        organize: 'Organize queue',
      }[descriptor.queue];
    case 'history':
      return 'History';
    case 'grid':
      return descriptor.day !== undefined
        ? labelForDayKey(descriptor.day)
        : (descriptor.month ?? 'Browse');
  }
}

export function DeckScreen({ navigation, route }: DeckProps) {
  // LIST MODE (P2-1): a valid descriptor in the params wins over the
  // unit machinery entirely; a malformed one falls back to unit params
  // (fail-closed decode in lib/deckList.ts).
  const listParam = route.params?.list;
  const listAnchor = route.params?.anchorId ?? null;
  const list = useMemo<DeckListEntry | null>(() => {
    const descriptor = listFromParams(listParam);
    return descriptor ? { descriptor, anchorId: listAnchor } : null;
  }, [listParam, listAnchor]);
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
  // itself rather than the navigator naming it once. The header's eye is
  // the badge-visibility control (m0.8.7, F19/L6): one durable setting,
  // flipping every badge surface at once through the badgePrefs
  // observable.
  const db = useSQLiteContext();
  const [hideBadges, setHideBadges] = useState(badgesHidden);
  useEffect(() => subscribeBadgesHidden(setHideBadges), []);
  useEffect(() => {
    navigation.setOptions({
      title: list
        ? listTitle(list.descriptor)
        : unit.kind === 'run'
          ? 'Singles review'
          : 'Group review',
      headerRight: () => (
        <Pressable
          onPress={() => void setBadgesHidden(db, !badgesHidden())}
          hitSlop={12}
          accessibilityLabel={hideBadges ? 'Show photo badges' : 'Hide photo badges'}
        >
          <MaterialCommunityIcons
            name={hideBadges ? 'eye-off-outline' : 'eye-outline'}
            size={22}
            color={colors.textDim}
          />
        </Pressable>
      ),
    });
  }, [navigation, unit.kind, list, db, hideBadges]);

  return <ReviewDeck navigation={navigation} unit={unit} advanceTo={advanceTo} list={list} />;
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
  /** The unit this view belongs to — it KEYS the pager, so a unit
   * change remounts the native list. That is the structural fix for
   * every cross-unit scroll desync (grilling Q3): a reused native
   * scroll view carries offsets, momentum and in-flight animations that
   * no event reliably reports, and reconciling them bred patch after
   * patch. A fresh list is born directly on its unit's first pending
   * photo and stale physical state dies with the old list. */
  unitKey: string;
  items: DeckItem[];
  cursor: number;
  current: DeckItem;
  stateOf: Map<string, ReviewMemberRow['state']>;
  dayOf: Map<string, string | null>;
  needMs: boolean[];
  /** Group-only controls (Not related) render. */
  isGroup: boolean;
  headerTitle: string;
  headerHint: string;
  browseControls: boolean;
  keepCount: number;
  /** P2: browse-list render — hides the in-page header, strip and
   * finish button; Compare and Not related stay disabled. */
  listMode: boolean;
  /** P2-5: untracked photos (library-grid lists only — MediaStore rows
   * the scan has not ingested). Every control disables; the corner
   * says why. */
  untracked: ReadonlySet<string>;
  /** What the finish button counts (pending singles / alive members). */
  finishCount: number;
}

function ReviewDeck({ navigation, unit, advanceTo, list }: SharedProps) {
  const db = useSQLiteContext();
  const listMode = list !== null;
  const listKey = listMode ? deckListKey(list.descriptor) : null;
  const singlesMode = !listMode && unit.kind === 'run';
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
    hydrateBadges,
    queuesChanged,
  } = useReview();
  const [busy, setBusy] = useState(false);
  /** Which control owns the in-flight write (see `run`). */
  const [busyOwner, setBusyOwner] = useState<BusyOwner | null>(null);
  /**
   * A finish is under way and this unit is on its way out (F6).
   *
   * Completing a unit flips `browse`. Since the m0.8.6 §9 unify the
   * control block is ONE stable layout for both modes — a mode change
   * moves only per-control state, so nothing can visibly swap — but
   * `finishing` still holds the LIVE control semantics through the
   * finish gap: the singles refetch is async, and browse deriving from
   * stale pre-write rows must not re-route the Edit chip (the block's
   * one per-mode behaviour fork) mid-advance.
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
  /** P2-6: the details overlay — the metadata corner's tap target. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** The F19 eye, as the stage sees it: everything on the stage goes. */
  const stageHidden = useBadgesHidden();
  /** P2-7: fullscreen immersive — a single stage tap collapses every
   * sibling chrome row IN PLACE (flex reflow; contain-fit grows the
   * photo into the freed, edge-to-edge black screen; the dip-to-black
   * in `immersiveFlip` masks the reflow). Never a navigate: no
   * remount, no zoom-pipeline re-warm. */
  const [immersive, setImmersive] = useState(false);
  const listRef = useRef<FlatList<DeckItem>>(null);

  // m0.5: an explicit group (overview tap) pins the deck to it; the
  // paramless linear flow follows the timeline's FIRST unit — bound here
  // when it is a group, redirected to its run deck by the routing effect
  // when it is not (m0.8.2 merged timeline).
  const groupId = useMemo(() => {
    if (listMode || singlesMode) return null;
    if (explicitGroupId) return explicitGroupId;
    // First PENDING unit, not timeline[0]: a cull-only run (or a fully
    // browsed head card) is not review work (lib/timeline.ts).
    const first = firstPendingUnit(timeline);
    return first?.kind === 'group' ? String(first.group.groupId) : null;
  }, [explicitGroupId, timeline, singlesMode, listMode]);
  /**
   * The RESOLVED unit's identity — the linear flow's group is bound
   * above, so this changes when the deck lands on a real group.
   *
   * It does two jobs, and both matter more since L4 kept the screen
   * mounted across units: it keys the per-unit effects (cursor, picker,
   * revisit), and it STAMPS the async row state below, so rows read for
   * a previous unit can never be mistaken for this one's.
   */
  const unitKey = listMode
    ? listKey!
    : singlesMode
      ? `r:${day ?? ''}:${range?.from ?? ''}:${range?.to ?? ''}`
      : `g:${groupId ?? ''}`;
  /** How THIS deck names itself against the timeline (advance flow). */
  const unitRef = useMemo<UnitRef | null>(() => {
    if (listMode) return null;
    if (singlesMode)
      return day && range ? { kind: 'run', day, from: range.from, to: range.to } : null;
    return groupId ? { kind: 'group', groupId } : null;
  }, [singlesMode, day, range, groupId, listMode]);
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
    if (listMode || singlesMode || !explicitGroupId || queueGroup) {
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
  }, [explicitGroupId, queueGroup, loadGroup, singlesMode, listMode, version, loadTick, unitKey]);
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
    if (listMode || !singlesMode || !day) return;
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
  }, [day, range, singlesMode, listMode, loadDeckSingles, version, loadTick, unitKey]);
  /** The rows this deck reviews (singles mode). */
  const singleRows = useMemo(() => (Array.isArray(deckSingles) ? deckSingles : []), [deckSingles]);
  // -------------------------------------------------- list mode (P2)
  /** LIST rows, resolved through lib/deckList.ts (P2-1) and stamped
   * exactly like the unit loads. Liveness is the source's own truth
   * (P2-3): version bumps and external refresh re-resolve, and the
   * photo-anchored cursor bridges every change. The loader reloads to
   * the user's paged depth so the anchor's photo stays in the set. */
  const [listLoad, setListLoad] = useState<{
    unit: string;
    rows: DeckListRow[] | 'failed' | null;
    next: DeckListCursor | null;
    /** The page count this row set was resolved FOR — the order-stable
     * projection appends unseen rows only when it grows (see
     * stableListRows), and only the load itself knows which resolve
     * answered which request. */
    pages: number;
    /** The write generation this load STARTED at (see listWriteGenRef):
     * an optimistic verdict override yields only to a load that began
     * after its write — a pre-tap read landing late must not clear the
     * just-written truth back to stale rows (codex, 2026-09-01). */
    gen: number;
  }>({ unit: unitKey, rows: null, next: null, pages: 0, gen: 0 });
  const listWriteGenRef = useRef(0);
  const listPagesRef = useRef(1);
  const [listPagesWanted, setListPagesWanted] = useState(1);
  const [externalTick, setExternalTick] = useState(0);
  useExternalRefresh(() => setExternalTick((t) => t + 1));
  // The History source's native presence seam (deckList.ts,
  // PresenceProbe): the host's per-page MediaStore reconcile, now run
  // by the resolver for every page the DECK loads, not only the ones
  // the host had fetched.
  const presenceProbe = useMemo<PresenceProbe>(
    () => ({
      checkPresence: checkMediaPresence,
      now: Date.now,
      onRemoved: () => void refresh().catch(() => {}),
    }),
    [refresh],
  );
  useEffect(() => {
    if (!listMode) return;
    let cancelled = false;
    const gen = listWriteGenRef.current;
    void (async () => {
      const mounted = await mountedVolumeSet();
      const src = await resolveSources(db);
      const roots = src.roots ?? null;
      const albumIds = src.albumIds ?? null;
      const rows: DeckListRow[] = [];
      let cursor: DeckListCursor | null = null;
      let next: DeckListCursor | null = null;
      for (let page = 0; page < listPagesRef.current; page += 1) {
        const result = await resolveDeckListPage(
          db,
          list!.descriptor,
          cursor,
          mounted,
          roots,
          albumIds,
          presenceProbe,
        );
        rows.push(...result.rows);
        next = result.next;
        if (next === null) break;
        cursor = next;
      }
      // P2-4: the badge refs must know these ids BEFORE the rows are
      // actionable, or the chips render "not queued/flagged" for photos
      // that are — and the first toggle writes the wrong direction (the
      // retired state editor's lesson). Publishing first and hydrating
      // after left exactly that window open (codex, 2026-09-01); a
      // failed hydration now fails the load — wrong controls are worse
      // than no deck.
      await hydrateBadges(rows.map((r) => r.id));
      if (cancelled) return;
      setListLoad({ unit: unitKey, rows, next, pages: listPagesWanted, gen });
    })().catch((error: unknown) => {
      console.warn('[deck] list load failed:', String(error));
      if (cancelled) return;
      // A failed RE-resolve keeps the last good rows on the stage (the
      // current photo never leaves under its own action — a transient
      // read failure right after that action is no exception); only a
      // first load with nothing to show becomes the retry card. Loud
      // once, never silent.
      setListLoad((prev) => {
        if (prev.unit === unitKey && Array.isArray(prev.rows)) {
          showToast('Could not refresh this list — showing the last read');
          return prev;
        }
        return { unit: unitKey, rows: 'failed', next: null, pages: listPagesWanted, gen };
      });
    });
    return () => {
      cancelled = true;
    };
    // `list` is identity-stable per listKey (the wrapper's memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listMode, listKey, unitKey, version, loadTick, externalTick, listPagesWanted, db]);
  const listRowsLoad = listLoad.unit === unitKey ? listLoad.rows : null;
  const listLoadGen = listLoad.unit === unitKey ? listLoad.gen : -1;
  const listRows = useMemo(() => (Array.isArray(listRowsLoad) ? listRowsLoad : []), [listRowsLoad]);
  /** List-mode verdict writes land optimistically (device pass
   * 2026-08-28): unit decks get instant state through the provider's
   * patches, but list rows re-resolve ASYNC — until they land, every
   * verdict tap read the STALE row state, so taps looked dead and
   * follow-up taps computed the wrong transition. The overlay is the
   * just-written truth; fresh rows clear it. */
  const [listStateOverride, setListStateOverride] = useState<
    ReadonlyMap<string, { state: ReviewMemberRow['state']; gen: number }>
  >(new Map());
  // An override clears ONLY when the photo's own fresh row arrives — a
  // cleared decision drops the row from its feed (History), the pin
  // then renders the HELD copy whose state froze at capture time, and
  // a wholesale clear regressed stateOf to that stale verdict (caught
  // by the scripted retest: keep-after-clear read as still unreviewed).
  // ... and only to a load that STARTED after the write (the gen fence
  // — see listLoad.gen): the row must be post-write evidence.
  useEffect(() => {
    setListStateOverride((m) => {
      if (m.size === 0) return m;
      const present = new Set(listRows.map((r) => r.id));
      let changed = false;
      const next = new Map(m);
      for (const [id, entry] of [...next])
        if (present.has(id) && entry.gen <= listLoadGen) {
          next.delete(id);
          changed = true;
        }
      return changed ? next : m;
    });
  }, [listRowsLoad, listRows, listLoadGen]);
  useEffect(() => {
    setListStateOverride((m) => (m.size > 0 ? new Map() : m));
  }, [unitKey]);
  const listReady = listMode && Array.isArray(listRowsLoad);
  const listNext = listLoad.unit === unitKey ? listLoad.next : null;
  /** Pager end reached (list mode): pull the next page in. */
  const loadMoreList = useCallback(() => {
    if (!listMode || listNext === null) return;
    listPagesRef.current += 1;
    setListPagesWanted(listPagesRef.current);
  }, [listMode, listNext]);
  /** ORDER STABILITY (device pass 2026-08-28): while the deck is open,
   * row ORDER freezes at entry — membership and state stay live, but a
   * write that reorders the source (every action bumps History's
   * activity_at) must not shuffle the pager mid-view: the live follow
   * snapped the cursor across the deck and flashed a blank rebound
   * page (frame-captured). Rows that vanish drop; unseen rows append
   * (the next pagination page, or a row a reorder pushed into the
   * loaded window). The fresh order applies on re-entry. */
  const listOrderRef = useRef<{ unit: string; ids: string[]; pages: number }>({
    unit: '',
    ids: [],
    pages: 0,
  });
  const listLoadPages = listLoad.unit === unitKey ? listLoad.pages : 0;
  const stableListRows = useMemo(() => {
    if (!listMode) return listRows;
    // A load that is not rows yet (null) or failed must not touch the
    // frozen order: feeding its empty array through would keep nothing
    // and stamp the page count, so the retry — same count — appended
    // nothing and the deck stayed empty (self-review, 2026-09-01).
    if (!Array.isArray(listRowsLoad)) return [];
    if (listOrderRef.current.unit !== unitKey) {
      listOrderRef.current = {
        unit: unitKey,
        ids: listRows.map((r) => r.id),
        pages: listLoadPages,
      };
      return listRows;
    }
    const byId = new Map(listRows.map((r) => [r.id, r]));
    // Unseen rows append ONLY when a page was asked for (S23,
    // 2026-09-01): a write-triggered re-resolve refills the page
    // window — dropping a row slides the next one in — and appending
    // it then made the count climb on an undo. The row shows on the
    // next page request (its re-resolve appends every unseen id) or on
    // re-entry.
    // The REGISTRY keeps every id it has seen, present or not (codex,
    // 2026-09-01): a row that leaves and returns before you navigate
    // away (Keep-undo, then Keep again) reclaims its frozen slot instead
    // of counting as unseen — which, at the same page count, kept it
    // out until the next page request. Projection filters by presence.
    const paged = listLoadPages !== listOrderRef.current.pages;
    const seenIds = listOrderRef.current.ids;
    const seen = new Set(seenIds);
    const ids = paged
      ? [...seenIds, ...listRows.map((r) => r.id).filter((id) => !seen.has(id))]
      : seenIds;
    listOrderRef.current = { unit: unitKey, ids, pages: listLoadPages };
    return ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  }, [listMode, listRows, listRowsLoad, unitKey, listLoadPages]);
  /** The photo the cursor is ANCHORED to (the retired viewer's
   * contract): moves only on user navigation. */
  const listAnchorRef = useRef<string | null>(list?.anchorId ?? null);
  /** P2-3 (revised, device pass 2026-08-28): the CURRENT photo never
   * leaves the deck under you. Acting on a photo can remove it from its
   * own list (mark edit done in the Edit queue) — the row is HELD at
   * its old position and keeps rendering until you navigate away; the
   * next re-resolve after that drops it. Neighbours may change; the
   * photo on the stage may not. */
  const heldRowRef = useRef<{ row: DeckListRow; index: number } | null>(null);
  const [browseCursor, setBrowseCursor] = useState(0);
  /** The rows the deck actually shows: the source's rows, plus the held
   * current row spliced back in when a re-resolve dropped it (the pin
   * above). `browseCursor` is a dependency so the pin re-evaluates when
   * navigation moves the anchor off a held photo. */
  const [pinTick, setPinTick] = useState(0);
  const shownListRows = useMemo(() => {
    if (!listMode) return stableListRows;
    const anchored = listAnchorRef.current;
    const held = heldRowRef.current;
    if (anchored === null || held === null || held.row.id !== anchored) return stableListRows;
    if (stableListRows.some((r) => r.id === anchored)) return stableListRows;
    const rows = [...stableListRows];
    rows.splice(Math.min(held.index, rows.length), 0, held.row);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listMode, stableListRows, browseCursor, pinTick]);
  /** P2-5: ids the scan has not ingested (tracked=false list rows). */
  const untrackedIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of shownListRows) if (!r.tracked) set.add(r.id);
    return set;
  }, [shownListRows]);
  // Derived deck info (the old core groupInfo shape, DB-backed): a group
  // absent from the queue but explicitly opened is COMPLETE (browse mode)
  // — the queue only lists groups with unreviewed members.
  const stateOf = useMemo(() => {
    const map = new Map<string, ReviewMemberRow['state']>();
    if (group) for (const m of group.members) map.set(m.asset_id, m.state);
    for (const m of singleRows) map.set(m.asset_id, m.state);
    for (const r of shownListRows) map.set(r.id, r.state);
    if (listMode) for (const [id, entry] of listStateOverride) map.set(id, entry.state);
    return map;
  }, [group, singleRows, shownListRows, listMode, listStateOverride]);
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
    for (const r of shownListRows) map.set(r.id, r.day);
    return map;
  }, [group, singleRows, shownListRows]);
  const info = useMemo(() => {
    if (!group) return null;
    const aliveIds = group.members.filter((m) => m.state === 'unreviewed').map((m) => m.asset_id);
    return {
      memberIds: group.members.map((m) => m.asset_id),
      aliveIds,
      complete: aliveIds.length === 0,
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
  const browse = listMode
    ? listReady && listRows.length > 0
    : singlesMode
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

  const toItem = (m: ReviewMemberRow): DeckItem => ({
    id: m.asset_id,
    timestamp: m.taken_at,
    uri: m.uri,
    kind: m.kind,
    version: m.image_version,
    motion: motionClipOf(m),
  });
  const aliveItems: DeckItem[] = useMemo(
    () => (group ? group.members.filter((m) => m.state === 'unreviewed').map(toItem) : []),
    [group],
  );
  // The group deck is the WHOLE group, live and browse alike (m0.8.1
  // round 4): a decided photo stays in place badged with its verdict —
  // Keep behaves exactly like Cull, and re-tapping the active verdict
  // clears it. Nothing leaves until the final delete confirmation.
  const groupItems: DeckItem[] = useMemo(() => (group ? group.members.map(toItem) : []), [group]);
  // A singles deck's rows: every non-trashed state, decided photos
  // badged in place (m0.8.2 unification — group-deck parity).
  const singlesItems: DeckItem[] = useMemo(
    () => (singlesMode ? singleRows.map(toItem) : []),
    [singleRows, singlesMode],
  );
  const listItems: DeckItem[] = useMemo(
    () =>
      shownListRows.map((r): DeckItem => ({
        id: r.id,
        timestamp: r.takenAt,
        uri: r.uri,
        kind: r.kind,
        version: r.version,
        motion: r.motion,
      })),
    [shownListRows],
  );
  const deckItems = listMode ? listItems : singlesMode ? singlesItems : groupItems;

  // The deck cursor is screen-local everywhere (m0.8: derived model — the
  // DB has no cursor; a decision shrinks the alive deck and the cursor
  // clamps to the next photo).
  /** The unit whose first-pending cursor has been applied (the effect
   * below the strip refs). STATE, not a ref (codex round 2): `holding`
   * reads it — rows landing do not end the hold until the successor's
   * OWN cursor is in place, or one committed render would show the
   * successor at the OUTGOING unit's cursor before snapping to
   * first-pending. State also guarantees the unhold render even when
   * the cursor value itself does not change. */
  const [cursorAppliedFor, setCursorAppliedFor] = useState<string | null>(null);
  const cursor = Math.min(browseCursor, Math.max(0, deckItems.length - 1));
  // Capture the CURRENT photo's row while the list still carries it —
  // the copy the pin above renders after the row leaves. Computed from
  // the cursor, NOT read from listAnchorRef: this effect runs before
  // the anchor-stamp effect in the same commit, so the ref is one
  // navigation behind here — capturing "the anchored photo" held the
  // PREVIOUS photo after a swipe, the pin's identity check then failed
  // when the current row vanished, and a Keep-undo in a filtered
  // History list re-anchored to the neighbour (S23 regression,
  // 2026-08-28).
  useEffect(() => {
    if (!listMode) return;
    const id = deckItems[cursor]?.id ?? listAnchorRef.current;
    if (id == null) return;
    const index = stableListRows.findIndex((r) => r.id === id);
    if (index >= 0) heldRowRef.current = { row: stableListRows[index], index };
  }, [listMode, stableListRows, deckItems, cursor]);
  const current: DeckItem | null = deckItems[cursor] ?? null;
  const currentId = current?.id ?? null;
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
  const holding =
    !current || (!listMode && !singlesMode && (!groupId || !info)) || cursorAppliedFor !== unitKey;
  /**
   * A fresh unit's pager ignores swipes for its first moments (grilling
   * Q3, Tristan's rule): a newly loaded unit opens on its first pending
   * photo REGARDLESS of last-minute swipes. The keyed remount already
   * discards everything aimed at the outgoing list; this covers the one
   * remaining path — a finish-adjacent swipe landing AFTER the new list
   * is live and paging it. DERIVED, not effect-armed: an effect arms one
   * paint too late, and the emulator probe caught an in-flight gesture
   * grabbing the new list in exactly that frame. As a comparison this is
   * true on the swap render itself, so the fresh native list is CREATED
   * with its scroll disabled; the timer below only lifts it. 400 ms sits
   * under human see-then-react time, so a deliberate swipe on the new
   * unit still feels instant.
   */
  const [settledUnit, setSettledUnit] = useState<string | null>(null);
  useEffect(() => {
    if (holding || settledUnit === unitKey) return;
    const timer = setTimeout(() => setSettledUnit(unitKey), 400);
    return () => clearTimeout(timer);
  }, [holding, settledUnit, unitKey]);
  const pagerSettling = !holding && settledUnit !== unitKey;
  const pagerSettlingRef = useRef(pagerSettling);
  pagerSettlingRef.current = pagerSettling;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const currentIndexRef = useRef(0);

  // Millisecond precision only where adjacent deck photos share a second
  // AND the timestamps carry sub-second data (m0.4).
  const needMs = useMemo(() => millisNeeded(deckItems.map((i) => i.timestamp)), [deckItems]);

  // ------------------------------------------------- pinch zoom (m0.5)
  // Two-pointer pinch zooms the current photo in an overlay; the pager
  // freezes while zoomed and resumes once the zoom springs back to 1.
  // The whole driver set — shared values, the two-detector gesture
  // split, stream arbitration, and the overlay's animated styles — is
  // the deck-canonical MediaStage (m0.9 phase 1, moved VERBATIM from
  // this file; docs/Plan_m0.9.md). The bridge rule, the
  // inline-callback rule, and the detector rationale live in its
  // header and still bind everything below.
  const stage = useMediaStage();
  // Phase 5 playback: the two per-kind modes (M5), read on every focus
  // so a Settings change applies on return; the motion clips of the
  // unit's items (one indexed read per unit); the pinch goes inert on a
  // video page (M6) — JS → shared value, the safe bridge direction.
  // Null until the durable rows are READ: a page never autoplays on a
  // guessed mode (a saved Off must hold through a slow or failed read).
  const [playback, setPlayback] = useState<{ video: PlaybackMode; motion: PlaybackMode } | null>(
    null,
  );
  useEffect(() => {
    if (!isFocused) {
      // A covered deck forgets its modes: the next focus re-reads them,
      // and until that read lands nothing autoplays — a mode saved in
      // Settings meanwhile (Off, say) can never be overtaken by the
      // previous visit's value.
      setPlayback(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      getSetting(db, PLAYBACK_KEYS.video),
      getSetting(db, PLAYBACK_KEYS.motion),
    ]).then(
      ([video, motion]) => {
        if (!cancelled) {
          setPlayback({ video: parsePlaybackMode(video), motion: parsePlaybackMode(motion) });
        }
      },
      (error) => {
        // No autoplay this visit; the play controls still work by hand.
        console.warn('[deck] playback settings read failed — autoplay off:', String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, isFocused]);
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  /** The page whose playback chrome (components/Playback) is showing —
   * its id, so a page that just became current derives HIDDEN on its
   * very first render; hidden by default, toggled by the stage tap, ONE
   * page at a time. Held here so the tap rule sits beside the photo's;
   * a page change clears it so a return finds the page at rest. */
  const [playbackChrome, setPlaybackChrome] = useState<string | null>(null);
  const playbackChromeRef = useRef(playbackChrome);
  playbackChromeRef.current = playbackChrome;
  useEffect(() => {
    setPlaybackChrome(null);
  }, [currentId]);
  const setChromeFor = useCallback((id: string, visible: boolean) => {
    setPlaybackChrome((shown) => (visible ? id : shown === id ? null : shown));
  }, []);
  /** Motion photos whose clip could not be extracted: plain photos to
   * the tap rule. The overlay reports both directions — a retry (the
   * page re-entering the near window) or a new version that extracts
   * makes the page playable again. */
  const unplayableRef = useRef(new Set<string>());
  const setClipAvailability = useCallback((id: string, available: boolean) => {
    if (available) unplayableRef.current.delete(id);
    else unplayableRef.current.add(id);
  }, []);

  const {
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
    resetZoom,
  } = stage;

  /** P2-7 (revised, device pass 2026-08-28): the toggle re-lays-out the
   * whole tree at once (chrome unmounts, pageW grows to the screen
   * edge, the FlatList re-paginates) — frame-tweening that with
   * LayoutAnimation left the photo itself snapping, which read as no
   * animation at all. A DIP TO BLACK masks the reflow instead: fade a
   * black cover in, flip the layout under it, fade out. Plain RN
   * Animated with the native driver — opacity only, no worklets, no
   * layout involvement. */
  const immersiveFade = useRef(new RNAnimated.Value(0)).current;
  const immersiveFlightRef = useRef(false);
  const immersiveFlip = useCallback(
    (next: boolean) => {
      if (immersiveFlightRef.current) return;
      immersiveFlightRef.current = true;
      RNAnimated.timing(immersiveFade, {
        toValue: 1,
        duration: 130,
        useNativeDriver: true,
      }).start(() => {
        setImmersive(next);
        resetZoom();
        // HOLD at black before the reveal (device pass 2026-08-28):
        // the native header removal and the status-bar hide land
        // ASYNC, each reflowing the stage a beat after the React
        // commit — revealed immediately, the photo settled twice (the
        // "second flash"). The hold lets both native reflows land
        // under cover; the slower fade-out is the delicate reveal.
        setTimeout(() => {
          RNAnimated.timing(immersiveFade, {
            toValue: 0,
            duration: 320,
            useNativeDriver: true,
          }).start(() => {
            immersiveFlightRef.current = false;
          });
        }, 240);
      });
    },
    [immersiveFade, resetZoom],
  );
  // Page taps — a plain Pressable press (RN responder system),
  // deliberately not a tap gesture (`useTapGesture`), so no worklet is
  // involved (see the bridge comment above). Double tap zooms to the
  // tapped point; a single tap (after the double-tap window) toggles
  // fullscreen immersive (P2-7). Ref-dispatched so renderPage stays
  // stable.
  const stageTapRef = useRef<() => void>(() => {});
  stageTapRef.current = () => {
    // Reading a shared value from JS is a sync snapshot — fine here: a
    // zoomed stage keeps taps to itself anyway via pointerEvents.
    // P2-7: a single tap toggles fullscreen immersive, BOTH modes —
    // the gallery idiom (the m0.8.x viewer-open died with the viewer).
    // A FROZEN deck (rows loading) toggles nothing. A PLAYABLE page's
    // tap toggles its chrome instead (phase 5, tester 2026-09-10); its
    // expand and collapse buttons are that page's immersive flip.
    if (scale.value !== 1 || holding) return;
    if (
      current !== null &&
      (current.kind === 'video' ||
        (current.motion !== null && !unplayableRef.current.has(current.id)))
    ) {
      setChromeFor(current.id, playbackChrome !== current.id);
      return;
    }
    immersiveFlip(!immersive);
  };
  const fireStageTap = useCallback(() => stageTapRef.current(), []);
  const expandStage = useCallback(() => immersiveFlip(true), [immersiveFlip]);
  const collapseStage = useCallback(() => immersiveFlip(false), [immersiveFlip]);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  // P2-5: the dead Not-related slot INVERTS on a pair-carrying photo
  // outside group review — "Not related · n" wakes to UN-mark (the
  // retired StateEditorSheet's action, rehomed). Count read per photo;
  // cheap (one indexed COUNT).
  const [notRelatedCount, setNotRelatedCount] = useState(0);
  useEffect(() => {
    setNotRelatedCount(0);
    if (currentId === null || (!listMode && !singlesMode)) return;
    let cancelled = false;
    void getNotRelatedCount(db, currentId).then(
      (n) => {
        if (!cancelled) setNotRelatedCount(n);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [db, currentId, listMode, singlesMode, version]);
  const unmarkNotRelated = useCallback(async () => {
    if (currentId === null) return;
    const { target } = await withUserWritePriority(() => clearNotRelated(db, currentId));
    if (target) void requestTargetedRescan(db, target).catch(() => {});
    setNotRelatedCount(0);
    void refresh().catch(() => {});
  }, [db, currentId, refresh]);

  // The native stack header collapses with the rest of the chrome; back
  // exits immersive BEFORE it leaves the screen (P2-7).
  useEffect(() => {
    navigation.setOptions({ headerShown: !immersive });
  }, [navigation, immersive]);
  // One ALWAYS-MOUNTED handler (device pass 2026-08-28, the S23 frozen
  // pop): the old immersive-only subscription unmounted at the flip's
  // black midpoint, so a second back landed while the header and
  // status bar were still restoring — a pop colliding with those
  // native reflows is the prime suspect for the stuck transition.
  // Backs during the whole flight are swallowed; the pop waits for a
  // quiet screen.
  const immersiveRef = useRef(false);
  immersiveRef.current = immersive;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (immersiveFlightRef.current) return true;
      if (immersiveRef.current) {
        immersiveFlip(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [immersiveFlip]);
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
    setDetailsOpen(false);
    setImmersive(false);
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
    if (listMode ? !listReady : singlesMode ? !singlesReady : !group) return;
    if (listMode) {
      // P2-3: the list opens on the tapped photo (the anchor), not on
      // first-pending — browsing has no "work" to land on.
      const anchorIndex = listAnchorRef.current
        ? deckItems.findIndex((i) => i.id === listAnchorRef.current)
        : -1;
      // The anchor may sit beyond the loaded pages (S23, 2026-09-01: a
      // staged cull scrolled to deep in History opened photo 1 — the
      // first page had no such row and the fallback silently took
      // index 0). Page on until it turns up; only an exhausted feed
      // falls back. The row was on the host's screen, so the hunt is
      // bounded by what the host itself had paged.
      if (anchorIndex < 0 && listAnchorRef.current && listNext !== null) {
        listPagesRef.current += 1;
        setListPagesWanted(listPagesRef.current);
        return;
      }
      const start = anchorIndex >= 0 ? anchorIndex : 0;
      listAnchorRef.current = deckItems[start]?.id ?? null;
      setBrowseCursor(start);
      setCursorAppliedFor(unitKey);
      return;
    }
    const firstPending = deckItems.findIndex(
      (i) => (stateOf.get(i.id) ?? 'unreviewed') === 'unreviewed',
    );
    setBrowseCursor(firstPending > 0 ? firstPending : 0);
    setCursorAppliedFor(unitKey);
  }, [
    unitKey,
    cursorAppliedFor,
    listMode,
    listReady,
    listNext,
    singlesMode,
    singlesReady,
    group,
    deckItems,
    stateOf,
  ]);
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
  const currentIdRef = useRef<string | null>(null);
  /** The item the stage last showed. It backs the COLD-OPEN stage only:
   * the session's first deck reading its rows shows the outgoing item's
   * OS thumbnail instead of a blank (§10 check 3). Every page carries
   * its own first paint (the OS thumbnail under the full decode — the
   * poster pattern VideoPage set, extended to photo pages 2026-09-13),
   * so there is no stage-level underlay and nothing to wait for: the
   * thumbnail paints in milliseconds whatever the decode is doing. */
  const lastItemRef = useRef<DeckItem | null>(null);
  useEffect(() => {
    if (current) lastItemRef.current = current;
  }, [current]);
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
    if (listMode || singlesMode) return;
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
    listMode,
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
  /** The settle's END re-asserts the pager's position and highlight
   * exactly once — the final snap. Whatever a stale delivery or native
   * quirk did during the window (scroll was disabled, so nothing
   * legitimate could), the unit leaves its settle standing on the
   * cursor with badge, strip and stage in agreement. */
  const wasSettlingRef = useRef(false);
  /** The page width the pager's content was last measured at (the
   * onContentSizeChange re-assert below fires once per width). */
  const contentWidthRef = useRef(0);
  useEffect(() => {
    const was = wasSettlingRef.current;
    wasSettlingRef.current = pagerSettling;
    if (!was || pagerSettling || holding || !pageW) return; // fire on true → false only
    const offset = cursor * pageW;
    pagerTargetRef.current = offset;
    listRef.current?.scrollToOffset({ offset, animated: false });
    setPagerIndex(cursor);
  }, [pagerSettling, holding, pageW, cursor]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW) return;
      // A swipe on the FROZEN deck (rows still loading) must not write
      // the new unit's cursor from the old unit's pages — and neither
      // may a SETTLING one: scroll is disabled for the whole settle
      // window, so any event arriving then is a stale delivery from the
      // dying list (native → JS latency outlives the unmount; caught on
      // the S10e as a strip highlight pointing one photo ahead).
      if (holding || pagerSettling) return;
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
    [pageW, cursor, holding, pagerSettling],
  );

  /** A jumpTo's animated scroll is in flight. While set, the live
   * pager index ignores scroll events: jumpTo already pointed the
   * highlight at its destination, and the animation's intermediate
   * offsets would round back to the OLD page first — on device the
   * highlight visibly flip-flopped on every decide-advance (§10 check
   * 8, round 2). Cleared on arrival, or the moment a finger interrupts
   * the animation (the drag is live user intent again). */
  const pagerAnimatingRef = useRef(false);
  /** Display-only live index for the strip (see `pagerIndex`). Settling
   * events are stale deliveries from the dying list (see onMomentumEnd)
   * — accepted, they parked the strip highlight one photo ahead of the
   * badge and the stage (Tristan's S10e repro, caught by screenshot). */
  const onPagerScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW || holding || pagerSettling) return;
      const offset = event.nativeEvent.contentOffset.x;
      if (pagerAnimatingRef.current) {
        if (Math.abs(offset - pagerTargetRef.current) >= 1) return; // still travelling
        pagerAnimatingRef.current = false;
      }
      const index = Math.round(offset / pageW);
      setPagerIndex((previous) => (previous === index ? previous : index));
    },
    [pageW, holding, pagerSettling],
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

  // -------------------- list-mode anchor plumbing (P2-3) --------------
  // User navigation moves the anchor — and ONLY user navigation (the
  // retired viewer's contract). Guarded on a REAL cursor change: this
  // effect also fires when the rows change under a stationary cursor
  // (a share/edit write reordering History), and stamping then reads a
  // stale index and re-anchors to whatever photo slid into it — the
  // device-pass bug where acting on a photo swapped it off the stage.
  const stampedCursorRef = useRef(cursor);
  useEffect(() => {
    if (!listMode || holding) return;
    if (cursor === stampedCursorRef.current) return;
    stampedCursorRef.current = cursor;
    const at = deckItems[cursor]?.id;
    if (at === undefined) return;
    const left = listAnchorRef.current;
    listAnchorRef.current = at;
    // Leaving a PINNED photo (one the list no longer carries) drops it
    // NOW: the pin memo reads refs, so without this nudge it stayed in
    // the pager until the next unrelated recompute — the tester swiped
    // back onto a photo that should have been gone, and the count
    // updated a swipe late (2026-08-31). The reconcile below re-snaps
    // the cursor onto the photo just landed on.
    if (left !== null && left !== at && !stableListRows.some((r) => r.id === left)) {
      // The cursor moves in the SAME batch as the drop (codex,
      // 2026-09-01): dropping a row that sat BEFORE the cursor shifts
      // the destination down one slot, and letting the reconcile catch
      // up a render later staged the wrong photo — with live controls —
      // in between.
      const leftIndex = deckItems.findIndex((i) => i.id === left);
      if (leftIndex >= 0 && leftIndex < cursor) {
        stampedCursorRef.current = cursor - 1;
        setBrowseCursor(cursor - 1);
      }
      setPinTick((t) => t + 1);
    }
  }, [listMode, cursor, deckItems, holding, stableListRows]);
  // Rows changed under the cursor: follow the anchored photo — a snap,
  // not a jumpTo (the deck must not visibly fly across thirty pages
  // because a write reordered the feed; the alignment effect re-scrolls
  // unanimated). The pin above means the anchored photo is normally
  // still present; the clamped-neighbour fallback remains only for an
  // anchor the list never carried (a stale params anchorId).
  useEffect(() => {
    if (!listMode || cursorAppliedFor !== unitKey || deckItems.length === 0) return;
    const anchored = listAnchorRef.current;
    if (anchored === null) return;
    const index = deckItems.findIndex((i) => i.id === anchored);
    if (index >= 0) {
      if (index !== browseCursor) {
        stampedCursorRef.current = index;
        setBrowseCursor(index);
      }
      return;
    }
    const clamped = Math.min(browseCursor, deckItems.length - 1);
    listAnchorRef.current = deckItems[clamped]?.id ?? null;
    if (clamped !== browseCursor) {
      stampedCursorRef.current = clamped;
      setBrowseCursor(clamped);
    }
  }, [listMode, cursorAppliedFor, unitKey, deckItems, browseCursor]);
  // An emptied list quietly goes back to its host (the whole-day
  // precedent).
  // ... and only once the feed is EXHAUSTED: a History page can hold
  // nothing browsable (share events, tombstones) while the tapped photo
  // sits on a later page the anchor hunt has just requested (codex,
  // 2026-09-01).
  useEffect(() => {
    if (listMode && listReady && shownListRows.length === 0 && listNext === null)
      navigation.goBack();
  }, [listMode, listReady, shownListRows.length, listNext, navigation]);

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

  // m0.7 item E queue row, m0.8.2 F5/F6: Share AND Organize are both
  // pure toggles now — organize queues with NO target ("move this
  // somewhere"; the album is assigned in the queue screen, batch-wise).
  // Both read the provider's badge maps (m0.8.1 round 4) — the same
  // membership the photo's share/organize badges show, so a per-photo
  // query here would be a second, divergent truth (db hoisted to the
  // top of the body — the list loader needs it earlier).

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
    // P2-4: a list photo can sit outside the provider's queue pages —
    // refreshQueuedFor would never re-read it. The retired state
    // editor's funnel (hydrate the one id, signal the tab badges) is
    // the off-page-correct path; unit decks keep the scoped refresh.
    if (listMode) {
      await hydrateBadges([id]).catch(() => {});
      queuesChanged();
    } else await refreshQueuedFor().catch(() => {});
  }, [db, current, queuedFor, refreshQueuedFor, listMode, hydrateBadges, queuesChanged]);

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
    if (listMode) {
      await hydrateBadges([id]).catch(() => {});
      queuesChanged();
    } else await refreshQueuedFor().catch(() => {});
  }, [db, current, queuedFor, refreshQueuedFor, listMode, hydrateBadges, queuesChanged]);

  const finishGroup = useCallback(() => {
    if (!group) return;
    // The goal is credited by the WRITE (m0.8.5, A3), which is what
    // makes a dissolved off-page group that keeps nothing count nothing.
    void run(() => keepRest(group.groupId).then(() => {}), 'finish');
  }, [group, run, keepRest]);

  const openCompare = useCallback(
    (againstId?: string) => {
      // Compare eligibility (m0.8.2, F11): undecided OR KEPT — "compare
      // with the photo I just kept" is the point. Staged culls stay out
      // on BOTH endpoints; resurrecting one is the re-decide chips' job.
      // Photos only (M7): a video is never a Compare endpoint.
      const candidates = deckItems.filter((i) => {
        const state = stateOf.get(i.id) ?? 'unreviewed';
        return i.kind === 'photo' && (state === 'unreviewed' || state === 'kept');
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
    ({ item, index }: { item: DeckItem; index: number }) => {
      // Phase 5: which page this item is — read from refs so the
      // callback stays stable; `extraData` below re-renders the pages
      // when the current id, the modes, immersive, focus, or the pager's
      // settle change. A page is ACTIVE only while the deck is the
      // visible screen (a pushed Compare must pause it), and a player
      // exists only on the current page and its two neighbours (M26's
      // bound, enforced here rather than trusted to FlatList's window).
      const near = Math.abs(index - currentIndexRef.current) <= 1;
      const active =
        near &&
        item.id === currentIdRef.current &&
        !pagerSettlingRef.current &&
        !holdingRef.current &&
        focusedRef.current;
      const modes = playbackRef.current;
      const immersive = immersiveRef.current;
      const stage: PlaybackStage = {
        immersive,
        // Immersive is edge to edge: the chrome keeps clear of the OS
        // navigation bar (the S23's three-button bar, 2026-09-10).
        insetBottom: immersive ? insetsRef.current.bottom : 0,
        chromeVisible: active && playbackChromeRef.current === item.id,
        onChromeVisibleChange: (visible) => setChromeFor(item.id, visible),
        onExpand: expandStage,
        onCollapse: collapseStage,
      };
      if (item.kind === 'video') {
        return (
          <VideoPage
            id={item.id}
            kind="video"
            uri={item.uri}
            version={item.version}
            width={pageW}
            posterPx={STAGE_THUMB_PX}
            near={near}
            active={active}
            mode={modes?.video ?? 'off'}
            stage={stage}
            surfaceType={VIDEO_SURFACE_TYPE}
            // A plain single tap: no double-tap window (a video has no
            // zoom for one to arm), so the chrome answers at once.
            onPress={fireStageTap}
          />
        );
      }
      return (
        <PhotoPage
          id={item.id}
          uri={item.uri}
          version={item.version}
          motion={item.motion}
          width={pageW}
          posterPx={STAGE_THUMB_PX}
          near={near}
          active={active}
          mode={modes?.motion ?? 'off'}
          stage={stage}
          surfaceType={VIDEO_SURFACE_TYPE}
          zoomScale={scale}
          onClipAvailability={setClipAvailability}
          onPress={onPagePress}
        />
      );
    },
    [
      pageW,
      onPagePress,
      fireStageTap,
      scale,
      expandStage,
      collapseStage,
      setChromeFor,
      setClipAvailability,
    ],
  );

  // F22 (m0.8.8): the region-zoom pipeline for the current stage photo —
  // dwell-warmed base + settled patches over the zoom overlay. Keyed on
  // the LIVE current item, so a frozen (inert) view tears the pipeline
  // down exactly when its controls go dead. Wiring (JS-side polling
  // callbacks + the resolution-driven zoom ceiling) is shared:
  // components/useStageZoom.ts.
  // Phase 5: a VIDEO page has no region pipeline (the decoder cannot
  // open it; its pinch is inert anyway) — the hook gets no photo.
  const zoomable = isFocused && current !== null && current.kind === 'photo';
  const regionZoom = useStageRegionZoom(
    { stageW, stageH, scale, tx, ty },
    zoomable ? current.id : null,
    zoomable ? current.uri : null,
    zoomable,
  );
  // D7: retained bases die with the unit (the new current stays warm).
  useEffect(() => {
    flushRegionZoomRetention(currentIdRef.current ?? undefined);
  }, [unitKey]);
  useStageMaxScale(maxScale, stageW, stageH, regionZoom.sourceSize);

  // A failed unit read renders the inline retry INSTEAD of the empty
  // root below: the failure state routes nowhere (no effect consumes
  // 'failed'), so the unit stays open until the read succeeds or the
  // user leaves. Genuinely missing/empty units keep their routing above.
  const loadFailed = listMode
    ? listRowsLoad === 'failed'
    : singlesMode
      ? deckSingles === 'failed'
      : !group && loadedGroup === 'failed';
  if (loadFailed) {
    return (
      <View style={[styles.root, styles.loadFailedRoot]}>
        <Text style={styles.loadFailedText}>Could not load these items just now.</Text>
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
          unitKey,
          items: deckItems,
          cursor,
          current,
          stateOf,
          dayOf,
          needMs,
          isGroup: !singlesMode && !listMode && !!groupId,
          listMode,
          untracked: untrackedIds,
          headerTitle: listMode
            ? ''
            : singlesMode
              ? `${range || !day ? 'Singles' : `${labelForDayKey(day)} · singles`} · ${deckItems.length - singlesPending} of ${deckItems.length} reviewed${
                  range ? ` · ${queueCounts.singles.toLocaleString()} left in library` : ''
                }`
              : browse
                ? `Group · ${deckItems.length} reviewed${unreachableSuffix}`
                : `Group · ${deckItems.length - aliveItems.length} of ${deckItems.length} reviewed · ${queueCounts.groups.toLocaleString()} groups left${unreachableSuffix}`,
          headerHint: listMode
            ? ''
            : browse
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
  // What the stage is SHOWING this render (render-time, so the swap
  // frame reads the new id — the pages read it through the ref).
  currentIdRef.current = view?.current.id ?? null;
  currentIndexRef.current = view?.cursor ?? 0;
  // M6, armed IN THIS RENDER (not a passive effect, which would leave the
  // first committed frame of a video page with the previous page's
  // value — the one-paint-late guard class): two fingers on a video
  // page belong to the pager. JS → shared value is the safe direction.
  stage.pinchInert.value = view?.current.kind === 'video';
  if (view === null) {
    // Nothing to freeze — the session's very first deck is still
    // reading its rows. The outgoing-photo stage (or a blank breath on
    // a cold open) is all there is to show.
    return (
      <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
        {lastItemRef.current !== null && (
          <View style={styles.coldStage}>
            <OsThumbnail
              assetId={lastItemRef.current.id}
              kind={lastItemRef.current.kind}
              uri={lastItemRef.current.uri}
              version={lastItemRef.current.version}
              px={STAGE_THUMB_PX}
              contentFit="contain"
              style={StyleSheet.absoluteFill}
            />
          </View>
        )}
      </View>
    );
  }

  // Compare eligibility mirrors openCompare exactly: undecided or KEPT
  // candidates (F11), and the CURRENT photo must be one of them.
  // PHOTOS ONLY (m0.9 phase 4, M7): videos are excluded from Compare on
  // both endpoints — the button disables on a video item and the picker
  // never offers one; motion photos compare as photos.
  const compareStates = ['unreviewed', 'kept'];
  const compareCandidate = (i: DeckItem): boolean =>
    i.kind === 'photo' && compareStates.includes(view.stateOf.get(i.id) ?? 'unreviewed');
  const compareCandidateCount = view.items.filter(compareCandidate).length;
  const compareEligible =
    !view.listMode && compareCandidateCount >= 2 && compareCandidate(view.current);

  const flagged = needsEdit(view.current.id);
  const favourite = isFavouriteSelected(favouriteStatus(view.current.id));
  const { share: shareQueued, organize: organizeQueued } = queuedFor(view.current.id);
  const currentState = view.stateOf.get(view.current.id) ?? 'unreviewed';
  /** P2-5: an untracked photo offers NO writes — nothing durable to
   * address — and the corner explains why. */
  const currentUntracked = view.untracked.has(view.current.id);
  const cornerLabel = `${labelForDayKey(view.dayOf.get(view.current.id) ?? UNDATED_DAY_KEY)} · ${formatClockPrecise(
    view.current.timestamp,
    view.needMs[view.cursor] ?? false,
  )}${currentUntracked ? ' · Not analyzed yet' : ''}`;
  /** Every badge a deck photo wears — the verdict AND all four actions,
   * none hiding another (m0.8.1 round 4), each at its own weight: loud
   * while it waits for you, quiet once the photo carries it (m0.8.2).
   * The verdict rides into actionWeights so a staged cull's retained
   * actions badge quiet — they left the queues with it. */
  const badgesFor = (item: DeckItem): PhotoBadge[] => {
    const state = view.stateOf.get(item.id) ?? 'unreviewed';
    return photoBadges({
      state,
      ...actionWeights(item.id, state),
      // The annotation badges (m0.8.7): the folder pill renders only at
      // the stage cluster's size; the SD glyph everywhere.
      folder: folderNameOfUri(item.uri),
      sdCard: isSdPhoto(item.id),
    });
  };

  // Re-decide: tapping the ACTIVE verdict clears back to unreviewed; a
  // A DECIDED photo changing to keep/to-edit takes the state-aware path:
  // "keep" rescues a staged cull without touching its pending actions
  // and "to edit" restarts the cycle; both resolve copy matches. An
  // UNDECIDED photo
  // takes the ordinary verdict path, where "to edit" keeps it AND queues
  // the edit in one transaction.
  /** 'undo' = the active verdict cleared; 'applied' = a verdict landed;
   * 'noop' = the stale-row guard refused (nothing changed). The caller
   * must not paint a verdict for a no-op (codex, 2026-09-01). */
  const redecide = async (
    id: string,
    target: RedecideTarget,
  ): Promise<'undo' | 'applied' | 'noop'> => {
    const state = stateOf.get(id) ?? 'unreviewed';
    // v18: 'to edit' is no longer a verdict, so the active target is
    // kept-vs-cull; the edit flag is read separately.
    const activeTarget: RedecideTarget | null =
      state === 'culled' ? 'cull' : state === 'kept' ? 'keep' : null;
    if (activeTarget === target) {
      await clearDecision(id);
      return 'undo'; // an undo never advances
    }
    if (state !== 'unreviewed' && (target === 'keep' || target === 'to_edit')) {
      // The DURABLE result gates the advance (codex r6, D11): a row
      // gone stale between render and tap makes this a guarded no-op,
      // and the pager must not jump off an unchanged photo.
      return (await redecideDecided(id, target)) > 0 ? 'applied' : 'noop';
    }
    await decide(
      id,
      target,
      listMode ? undefined : singlesMode ? null : (group?.groupId ?? undefined),
    );
    return 'applied';
  };

  /** ONE decide handler for both deck kinds (m0.8.2 unification, F10):
   * every verdict leaves the photo in place badged — membership never
   * changes mid-visit — so a FRESH decision advances the pager to the
   * nearest PENDING photo (m0.8.8 G4, F23+F24: forward first, backward
   * at the tail, stay when none remain — `lib/deckAdvance.ts`), while
   * re-deciding an already-decided photo stays put (the user is looking
   * at that one). Unreachable while `inert`: every control that calls
   * it is disabled on a frozen view. */
  const decideCurrent = async (target: RedecideTarget) => {
    if (inert || current === null) return;
    const index = cursor;
    // Advance iff the VERDICT changed to a different decided verdict, or
    // was fresh (m0.8.6 N1, one predicate): unreviewed → decided and
    // kept ↔ culled advance; an undo (tapping the active verdict —
    // exactly `redecide`'s clear case) stays, and kept → to_edit stays
    // too — queuing work on the photo you are looking at must not yank
    // the pager off it. The state is read only to route the pager; the
    // goal credit comes from the write itself (m0.8.5, A3).
    // NEVER in list mode (S23 device pass 2026-08-29): a list deck is a
    // browse surface, so every decision acts in place — unit browse
    // only LOOKED exempt because a finished group has no pending member
    // to jump to, while History lists carry unreviewed rows, and a
    // staged-cull rescue animated a long jump to the nearest one.
    const prior = stateOf.get(current.id) ?? 'unreviewed';
    const activeTarget = prior === 'culled' ? 'cull' : prior === 'kept' ? 'keep' : null;
    const targetVerdict = target === 'cull' ? 'culled' : 'kept';
    const advances =
      !listMode && activeTarget !== target && (prior === 'unreviewed' || targetVerdict !== prior);
    const outcome = await redecide(current.id, target);
    // The optimistic overlay (see listStateOverride): the write is
    // durable by now — show it before the slow list re-resolve lands.
    // Never for a guarded no-op: nothing committed, so nothing to paint.
    // The gen advances AFTER the write, so a load started before the
    // tap can never clear this entry (the fence).
    if (listMode && outcome !== 'noop') {
      listWriteGenRef.current += 1;
      const next = outcome === 'undo' ? 'unreviewed' : targetVerdict;
      setListStateOverride((m) =>
        new Map(m).set(current.id, { state: next, gen: listWriteGenRef.current }),
      );
    }
    if (!advances || outcome !== 'applied') return;
    // Same pending predicate as unit entry; the just-decided photo is
    // `from` and never a candidate, so a state row that has not
    // refreshed yet cannot bounce the cursor back onto it.
    const jump = nearestPendingIndex(
      deckItems.map((i) => (stateOf.get(i.id) ?? 'unreviewed') === 'unreviewed'),
      index,
    );
    if (jump !== null) jumpTo(jump);
  };

  return (
    <View
      style={immersive ? styles.rootImmersive : [styles.root, { paddingBottom: insets.bottom + 8 }]}
    >
      {/* P2-7: immersive is the GALLERY look — edge-to-edge black, no
          frame, no OS status bar; the photo owns the screen. */}
      <StatusBar hidden={immersive} style="light" />
      {/* P2: list mode has no unit story to tell — the navigation title
          names the source and the stage takes the space. */}
      {!view.listMode && !immersive && (
        <View style={styles.header}>
          {/* Truthful numbers only (m0.8.2, F12): the unit's own progress
            over its FIXED membership, plus the library-wide remainder
            from the DB counts — never a page-position ordinal. */}
          <Text style={styles.headerTitle}>{view.headerTitle}</Text>
          <Text style={styles.headerHint}>{view.headerHint}</Text>
        </View>
      )}

      {/* The stage tree (detectors, measured borderless box, zoom
          overlay, fail-soft notice) is the shared MediaStageView —
          the virtual-detector and borderless-stage rationale lives in
          MediaStage.tsx's header. The pager is the host content; the
          badges ride the chrome slot until phase 6's overlay builder. */}
      <MediaStageView
        controller={stage}
        frameStyle={immersive ? styles.stageFrameImmersive : styles.stageFrame}
        onStageLayout={(width) => setPageW(width)}
        overlayFor={view.current}
        overlayUri={versionedUri(view.current.uri, view.current.version)}
        regionZoom={regionZoom}
        identityOk={current?.id === view.current.id}
        backdropColor={immersive ? '#000' : colors.surface}
        chrome={
          // Immersive is edge to edge: the corner, the badge cluster and
          // the details overlay keep clear of the OS navigation bar
          // (the S23's three-button bar hid them, 2026-09-10).
          <View
            style={[StyleSheet.absoluteFill, { bottom: immersive ? insets.bottom : 0 }]}
            pointerEvents="box-none"
          >
            {/* The eye clears the WHOLE stage (tester, 2026-08-31): the
                photo purely as it is — position, corner, and the badge
                pill all go, not just the cluster inside its pill (the
                pill's own dark backdrop had stayed behind as a mark).
                The fail-soft zoom notice alone survives: a fidelity
                claim, not decoration (M19). The details overlay stays
                mounted; with the corner gone it simply has no opener
                until the eye reopens. */}
            {!stageHidden && (
              <>
                <View style={styles.posBadge} pointerEvents="none">
                  <Text style={styles.posBadgeText}>
                    {view.cursor + 1}/{view.keepCount}
                  </Text>
                </View>
                {/* P2-6: the corner is the GLANCE; tapping it (or the
                    badge cluster) opens the details overlay with the
                    complete truth. Day AND time (F17): rendered from
                    `day`, NEVER from taken_at. */}
                <Pressable
                  style={styles.timeBadge}
                  onPress={() => setDetailsOpen(true)}
                  accessibilityLabel="Show photo details"
                >
                  <Text style={styles.timeBadgeText}>{cornerLabel}</Text>
                </Pressable>
                <Pressable
                  style={styles.flagBadge}
                  onPress={() => setDetailsOpen(true)}
                  accessibilityLabel="Show photo details"
                >
                  <BadgeCluster badges={badgesFor(view.current)} size={24} />
                </Pressable>
              </>
            )}
            <DeckDetailsOverlay
              open={detailsOpen}
              photoId={view.current.id}
              header={cornerLabel}
              onClose={() => setDetailsOpen(false)}
            />
          </View>
        }
      >
        {pageW > 0 && (
          <View style={styles.pager}>
            <FlatList
              // Keyed by the DISPLAYED unit: a unit change swaps in
              // a fresh native list at its own first pending photo
              // (initialScrollIndex), and the outgoing list's
              // offsets, momentum and in-flight animations are
              // discarded with it — see DeckView.unitKey.
              key={view.unitKey}
              ref={listRef}
              data={view.items}
              keyExtractor={(i) => i.id}
              renderItem={renderPage}
              horizontal
              pagingEnabled
              // A FROZEN deck is fully inert (codex device-pass
              // round): a swipe would move the native offset while
              // every guard ignores it. A JUST-SWAPPED deck also
              // ignores swipes for its settle window — see
              // `pagerSettling`.
              scrollEnabled={!inert && !pagerSettling}
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
              // The immersive flip re-lays every page at a new width. The
              // alignment effect's scroll to the cursor lands BEFORE the
              // native list has grown to the new extent, so on the last
              // pages the offset is clamped to the OLD extent and nothing
              // re-corrects it (S23, 2026-09-11/13: page 19 of 19 in
              // immersive showed 18 with a slice of 17; earlier pages fit
              // either extent). Re-assert the cursor's offset once the
              // content is measured at THIS width — once per width, so a
              // list-mode append never jumps a pager mid-drag.
              onContentSizeChange={() => {
                if (!pageW || holding || contentWidthRef.current === pageW) return;
                contentWidthRef.current = pageW;
                const offset = cursor * pageW;
                pagerTargetRef.current = offset;
                listRef.current?.scrollToOffset({ offset, animated: false });
              }}
              // Phase 5 (M26): one page each side of the current one —
              // at most three players alive — and the pages re-render
              // on the facts they read through refs.
              windowSize={3}
              initialNumToRender={3}
              extraData={[
                view.current.id,
                playback,
                playbackChrome,
                immersive,
                pagerSettling,
                holding,
                isFocused,
              ]}
              onEndReached={view.listMode ? loadMoreList : undefined}
              onEndReachedThreshold={2}
            />
          </View>
        )}
      </MediaStageView>

      {/* The strip FOLLOWS the current photo (m0.8.5, F7). It used to be
          a plain ScrollView with no ref, so past roughly the seventh
          photo of a run the thumbnail you were on sat off-screen while
          the pager tracked the cursor perfectly. Geometry in, offset out
          — the rule and its edge cases live in lib/stripScroll.ts. */}
      {/* P2: flat lists hide the strip — the stage grows. */}
      {!view.listMode && !immersive && (
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
              <OsThumbnail
                assetId={item.id}
                kind={item.kind}
                uri={item.uri}
                version={item.version}
                px={STRIP_THUMB_PX}
                style={[
                  styles.thumb,
                  // The LIVE pager index (§10 check 8): the highlight moves
                  // with the page crossing, not at momentum end. A frozen
                  // deck keeps its own settled cursor.
                  index === (inert ? view.cursor : pagerIndex) && styles.thumbActive,
                ]}
              />
              {/* Small badges wrapping into rows: a 52 px thumbnail fits
                  three per row, so a fully-flagged photo shows all of
                  them stacked instead of hiding any. */}
              {/* The shared inspection dots (StateDots' header) — the
                  Progress grid's language on the strip; eye-exempt by
                  that component's rule (the eye clears the STAGE). */}
              <StateDots
                effective={classifyPhotoState({
                  state: view.stateOf.get(item.id) ?? 'unreviewed',
                })}
                badges={badgesFor(item)}
                style={styles.thumbBadges}
              />
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ONE control block for BOTH modes (m0.8.6 §9, the browse-swap
          unify): the browse/live swap used to replace this whole region,
          so `finishing`'s escape clause could flash the browse row for a
          frame on a singles finish (the stale pre-write rows). With
          every slot always mounted, a mode change moves only per-control
          state — there is no swap left to flash. Browse mode (a fully
          decided unit): Compare and the finish button go dead (their
          work is done); the verdict buttons and chips ARE the re-decide
          path, exactly as the old browse branch offered. */}
      {!immersive && (
        <>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.actionButton,
                { backgroundColor: colors.keepDim },
                currentState === 'kept' && { borderWidth: 2, borderColor: colors.keep },
                // RN styles nothing for `disabled` — every dead control
                // pairs the prop with the dead look (the Compare lesson,
                // 2026-08-28; untracked caught the same way, 2026-09-01).
                currentUntracked && styles.middleButtonDead,
              ]}
              disabled={busy || inert || currentUntracked}
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
              style={[
                styles.actionButton,
                styles.middleButton,
                !compareEligible && styles.middleButtonDead,
              ]}
              // Compare works on UNDECIDED photos only (its verdicts can
              // cull a loser) — decided photos stay in the deck, so the
              // button goes dead on them, and in browse mode (all decided)
              // it is dead throughout; the strip long-press stays the F11
              // kept-duel door.
              disabled={busy || inert || !compareEligible}
              onPress={() => openCompare()}
            >
              <MaterialCommunityIcons name="compare-horizontal" size={18} color={colors.textDim} />
              <Text
                style={[styles.middleText, !compareEligible && styles.actionTextDisabled]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {/* One fixed label (S23 pass, Tristan): the count-based
                " with…" suffix read as a kind difference. Whether the
                tap opens the picker or goes straight in is still
                decided by the candidate count (openCompare). */}
                Compare
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionButton,
                styles.middleButton,
                (view.isGroup ? view.browseControls : notRelatedCount === 0) &&
                  styles.middleButtonDead,
              ]}
              // "Not related" shares the row in BOTH deck kinds (F28, G9):
              // always mounted so row geometry never shifts between kinds.
              // Group review: eject (dead in browse — a finished group's
              // membership is settled work, D4). Outside group review the
              // slot INVERTS (m0.9 P2-5): a photo CARRYING cannot-link
              // pairs wakes it as "Not related · n", and the tap UN-marks
              // (the retired state editor's action) behind a confirm.
              // Neutral styling — it writes no verdict (STATE_MODEL
              // rules 2/3).
              disabled={
                busy ||
                inert ||
                (view.isGroup ? view.browseControls : notRelatedCount === 0 || currentUntracked)
              }
              onPress={() => {
                if (view.isGroup) {
                  if (group) void run(() => makeSingle(current.id, group.groupId));
                  return;
                }
                Alert.alert(
                  'Un-mark "not related"?',
                  `This photo never groups with ${plural(notRelatedCount, 'photo')} you separated it from. Un-marking lets the scan group them again.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Un-mark', onPress: () => void run(unmarkNotRelated) },
                  ],
                );
              }}
            >
              <MaterialCommunityIcons name="image-move" size={18} color={colors.textDim} />
              <Text style={styles.middleText} numberOfLines={1} adjustsFontSizeToFit>
                {view.isGroup || notRelatedCount === 0
                  ? 'Not related'
                  : `Not related · ${notRelatedCount}`}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionButton,
                styles.cullButton,
                currentState === 'culled' && { borderWidth: 2, borderColor: colors.cull },
                currentUntracked && styles.middleButtonDead,
              ]}
              disabled={busy || inert || currentUntracked}
              onPress={() => void run(() => decideCurrent('cull'))}
            >
              <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
              <Text style={styles.actionText}>Cull</Text>
            </Pressable>
          </View>

          <View style={styles.secondaryRow}>
            {/* The Edit chip is the block's ONE per-mode behaviour fork:
            live and LIST decks FLAG-toggle (the verdict layer untouched
            — the retired state editor's edit row; the browse re-decide
            here wrote kept + a fresh cycle on every tap and could never
            toggle OFF, the device-pass History bug 2026-08-28); unit
            browse RE-DECIDES (kept + fresh edit cycle, the state-aware
            path) — EXCEPT on a staged cull, where it flag-toggles too:
            queueing the edit must not silently rescue the cull.
            Per-kind suspension (m0.8.7, F21): edit and share stay
            actionable on a staged cull — "delete it, but share it
            first" is the flow; favourite and organize stay disabled
            (decorating a photo you are deleting makes no sense). */}
            <ActionChip
              kind="edit"
              active={flagged}
              disabled={busy || inert || currentUntracked}
              dimmed={currentUntracked}
              onPress={() =>
                void run(() =>
                  !view.listMode && view.browseControls && currentState !== 'culled'
                    ? decideCurrent('to_edit')
                    : toggleNeedsEdit(current.id),
                )
              }
            />
            <ActionChip
              kind="favourite"
              active={favourite}
              disabled={busy || inert || currentState === 'culled' || currentUntracked}
              dimmed={currentState === 'culled' || currentUntracked}
              onPress={() => void run(() => toggleFavourite(current.id))}
            />
            <ActionChip
              kind="organize"
              active={organizeQueued}
              disabled={busy || inert || currentState === 'culled' || currentUntracked}
              dimmed={currentState === 'culled' || currentUntracked}
              onPress={() => void run(toggleOrganize)}
            />
            <ActionChip
              kind="share"
              active={shareQueued}
              disabled={busy || inert || currentUntracked}
              dimmed={currentUntracked}
              onPress={() => void run(toggleShare)}
            />
          </View>
        </>
      )}

      {/* P2-4: no honest "keep the rest of this list" verb exists —
          the finish button is a unit concept. */}
      {!view.listMode && !immersive && (
        <BigButton
          // "Saving…" only once the write has actually run long (§10
          // check 2): a fast finish advances before the timer fires,
          // so the label no longer flashes through two texts on every
          // normal finish. The button still disables instantly — the
          // press must land exactly once either way.
          label={finishSlow ? 'Saving…' : `Keep remaining (${view.finishCount})`}
          color={colors.keep}
          // The LOCK includes the transient `busy`; the LOOK does not
          // (m0.8.6 N2, ActionChip's dimmed split): the dim tracks durable
          // state — an empty remainder, an inert frozen deck — and the
          // button's OWN write (`finishing`), so a chip or verdict write
          // elsewhere no longer flickers it.
          disabled={busy || inert || view.finishCount === 0}
          dimmed={inert || view.finishCount === 0 || finishing}
          // F28: the deck's finish cedes 64→56 for stage space; every
          // other BigButton keeps `touch.action`.
          style={{ minHeight: FINISH_MIN_HEIGHT }}
          onPress={() =>
            singlesMode
              ? day && void run(() => keepAllSingles(day, range ?? null).then(() => {}), 'finish')
              : finishGroup()
          }
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
                .filter(({ item }) => compareCandidate(item))
                .map(({ item, deckIndex }) =>
                  item.id === view.current.id ? null : (
                    <Pressable key={item.id} onPress={() => openCompare(item.id)}>
                      <OsThumbnail
                        assetId={item.id}
                        kind={item.kind}
                        uri={item.uri}
                        version={item.version}
                        px={PICKER_THUMB_PX}
                        style={styles.pickerThumb}
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

      {/* P2-7: the immersive flip's dip-to-black cover (see
          immersiveFlip). Always mounted, opacity-driven, never
          touchable. */}
      <RNAnimated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.immersiveFadeCover, { opacity: immersiveFade }]}
      />
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
  /** Border here, NOT on the stage (see the render comment): the
   * measured stage must be exactly the box its absoluteFill children
   * render in. */
  stageFrame: {
    flex: 1,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  /** P2-7 immersive: the Gallery look — black, borderless, edge to
   * edge (the root drops its padding with it). */
  stageFrameImmersive: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  rootImmersive: { flex: 1, backgroundColor: '#000' },
  immersiveFadeCover: { backgroundColor: '#000', zIndex: 20, elevation: 20 },
  pager: { flex: 1 },
  /** The cold-open last-photo container — NOT the measured stage (that
   * lives in MediaStageView); just a frameless flex box. */
  coldStage: { flex: 1 },
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
    // The verdict buttons out-weigh the neutral middle pair (F28, G9);
    // the middle pair overrides to flex 1.
    flex: VERDICT_FLEX,
    minHeight: VERDICT_ROW_MIN_HEIGHT,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 4,
  },
  cullButton: { backgroundColor: colors.cullDim },
  middleButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  middleButtonDead: { opacity: 0.45 },
  actionText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  middleText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
  actionTextDisabled: { color: colors.textDim },
  secondaryRow: { flexDirection: 'row', gap: 10 },
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
