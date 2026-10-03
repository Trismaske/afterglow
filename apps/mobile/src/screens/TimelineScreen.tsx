/**
 * The Timeline (m0.8.6, F2 — GroupsScreen renamed): every group and
 * singles run, newest-first, with filters that peel back to today's
 * pending view.
 *
 * Three filters (L7: the last choice is remembered; first launch opens
 * Unfinished):
 * - UNFINISHED — the pending review feed exactly as before: the
 *   provider's timeline, optimistic patches, horizon truncation and
 *   all. This filter touches none of that machinery (D1).
 * - EVERYTHING — a separate DB-paged keyset read over ALL units,
 *   reviewed included (D1): two keyset streams (browse groups walked
 *   by their stored anchor, ungrouped singles) merged by progressPager
 *   into one descending item stream, assembled into units incrementally
 *   (lib/timeline.ts appendBrowseItems — the tail run stays open across
 *   pages). Units render exactly as when pending (D2) — one card per
 *   unit, no collapse. Two signals keep it current (m0.9 phase 8):
 *   VERDICTS patch the rendered rows in place (the provider's
 *   verdictPatch — a decision never changes the set or order of units),
 *   and only a MEMBERSHIP change (db/membershipSignal.ts: a scan window
 *   that landed something, an eject, a trash confirmation, a removal, a
 *   forgotten card) re-walks the stream — to the depth on screen, with
 *   the old stream rendered until the fresh one reaches it, and a
 *   refresh asked for while a page is in flight waits for that page
 *   (coalesced: one refresh however many asked). A finished read is
 *   never discarded.
 * - UNREVIEWED — a pure display subset of the Unfinished data
 *   (D3): units with undecided work, staged-cull singles hidden.
 *
 * "Continue reviewing" anchors to the first PENDING unit whatever the
 * filter shows (L7), and the subtitle counts stay pending-only DB
 * counts on every filter — they describe work, not the view.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { useMembershipVersion } from '../components/useMembershipVersion';
import type { VerdictChange } from '../lib/reviewPatch';
import { BigButton } from '../components/BigButton';
import { UNIT_CARD_HEIGHT, UnitCard, cardThumbRows } from '../components/UnitCard';
import { useAnimatedCells, useAnimatedThumbsMode } from '../components/useAnimatedCells';
import { StateDots } from '../components/DecisionBadge';
import { colors, useTheme } from '../theme';
import { formatClock, plural } from '../lib/format';
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { classifyPhotoState } from '../lib/progress';
import {
  anchorIndexIn,
  appendBrowseItems,
  browseItemTime,
  EMPTY_BROWSE_ASSEMBLY,
  firstPendingUnit,
  flushBrowseTail,
  findUnitIndex,
  needsDeeperPages,
  patchBrowseVerdicts,
  unitDestination,
  unitRefOf,
  unreviewedOnly,
  type BrowseAssembly,
  type BrowseItem,
  type TimelineAnchor,
  type TimelineUnit,
} from '../lib/timeline';
import { deckParamsFor } from '../lib/deckUnit';
import { photoBadges, type PhotoBadge } from '../lib/photoBadges';
import {
  createMergedDescendingPager,
  type MergedPager,
  type PageFetcher,
} from '../lib/progressPager';
import {
  collapseReach,
  fetchBrowseGroupsPage,
  fetchBrowseSinglesPage,
  getSetting,
  setSetting,
  type BrowseGroupCursor,
} from '../db/store';
import { resolveSources } from '../lib/sourceCatalog';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import {
  parseTimelineFilter,
  TIMELINE_FILTER_KEY,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from '../lib/timelinePrefs';
import { perfAggregate } from '../lib/perfLog';
import { requestLibraryCheck } from '../scan/scanRunner';

type Props = NativeStackScreenProps<RootStackParamList, 'Timeline'>;

/** Items consumed from the merged stream per FlatList page. The stream
 * fetchers page beneath it (singles wider than groups — a sparse
 * stretch is mostly singles). */
const BROWSE_BATCH = 40;
/** Every row = one uniform card + the row gap. getItemLayout's exactness
 * rests on UNIT_CARD_HEIGHT being style-pinned. */
const ROW_GAP = 12;
const ROW_H = UNIT_CARD_HEIGHT + ROW_GAP;

/** A unit's list key — and its identity to the animated controller.
 * Browse runs page in with stable full ranges per load generation; the
 * pending key shape (day:to) relies on pending-only runs shrinking from
 * the bottom. */
function unitKeyOf(unit: TimelineUnit, filter: string | null): string {
  if (unit.kind === 'group') return `g:${unit.group.groupId}`;
  return filter === 'everything'
    ? `r:${unit.day}:${unit.from}:${unit.to}`
    : `r:${unit.day}:${unit.to}`;
}
const membersOf = (unit: TimelineUnit) =>
  unit.kind === 'group' ? unit.group.members : unit.members;
/** Depth past which the back-to-top disc shows — and below which a
 * landing hides it (~a dozen cards: flinging back is a chore). */
const DEEP_PX = 1600;
/** The rest of the scrollable geometry, pinned so the landing mirror's
 * clamp is EXACT (codex r9): the list's own bottom padding, and a
 * fixed-height slot for the one footer note (truncation / failed read)
 * — a content-sized footer would put the physical maximum offset
 * outside what the mirror can compute. */
const LIST_PAD_BOTTOM = 12;
const FOOTER_H = 76;
const BROWSE_SINGLES_PAGE = 120;
const BROWSE_GROUPS_PAGE = 40;

type BrowseCursor = BrowseGroupCursor | { takenAt: number; assetId: string };

interface BrowseState {
  assembly: BrowseAssembly;
  exhausted: boolean;
  /** A page read failed — the footer says so instead of claiming the
   * history simply ends here (fail-closed). */
  failed: boolean;
  /** The generation that published this state. A refresh bumps genRef
   * SYNCHRONOUSLY and publishes its fresh stream once it reaches the
   * rendered depth — in between, the rendered state is the OLD stream
   * (kept on screen on purpose), and the jump effect waits for the
   * fresh one rather than land on rows about to be replaced. */
  gen: number;
}

export function TimelineScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { timeline, queueCounts, version, actionWeights, hydrateBadges, verdictPatch } =
    useReview();
  /** Pull-to-refresh (phase 9): the explicit library check. What it
   * lands reaches this list through the membership signal, as any
   * scan's windows do; the spinner covers only the check itself. */
  const [refreshing, setRefreshing] = useState(false);
  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await requestLibraryCheck(db);
    } finally {
      setRefreshing(false);
    }
  }, [db]);

  // ---------------------------------------------------------- filter
  // null until the remembered choice loads — rendering a default first
  // would flash the wrong filter and clobber the stored one on switch.
  const [filter, setFilterState] = useState<TimelineFilter | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSetting(db, TIMELINE_FILTER_KEY).then(
      (raw) => {
        if (!cancelled) setFilterState(parseTimelineFilter(raw));
      },
      () => {
        if (!cancelled) setFilterState('unfinished');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db]);
  /** First visible unit, tracked for the filter-switch anchor. */
  const viewableRef = useRef<TimelineUnit | null>(null);
  /** Live scroll offset — the at-top test and the back-to-top disc. */
  const scrollYRef = useRef(0);
  /** ONE switch rule (Tristan, final device pass — the simplification):
   * at the top of any filter, a switch lands at the top of the target;
   * otherwise the unit at the top of the viewport becomes the top of
   * the target. When Everything's top unit has no pending counterpart,
   * the pending feeds clamp to their bottom — and clampReturnRef (the
   * ONE slot of memory) lets the return trip restore the Everything
   * unit that clamp came from, as long as the reader still sits on the
   * clamped landing. Nothing else is remembered. */
  const jumpRef = useRef<{ target: 'top' | { anchor: TimelineAnchor }; held?: boolean } | null>(
    null,
  );
  const clampReturnRef = useRef<{ cameFrom: TimelineAnchor } | null>(null);
  /** Exact-geometry mirrors (rows are uniform): the clamp-return test is
   * "does the reader still sit at the pending bottom", judged from
   * scrollY + viewport against ROW_H × length. */
  const viewportHRef = useRef(0);
  const dataLenRef = useRef(0);
  /** Render mirror of "a footer note is rendered" — part of the exact
   * content geometry the landing clamp needs (codex r9). */
  const footerNoteRef = useRef(false);
  /** A drag DURING a page-toward hold abandons it — the reader took
   * over. Reset when a hold begins; meaningless outside one. */
  const holdDragRef = useRef(false);
  const setFilter = useCallback(
    (next: TimelineFilter) => {
      setFilterState((prev) => {
        if (prev === next || prev === null) return next;
        const seen = viewableRef.current;
        // Unit-scale tolerance: mVCP's post-swap adjustments drift the
        // offset a few px, and anything inside the first card still
        // READS as the top — the fat threshold replaces the flag
        // machinery that used to track this.
        const atTop = scrollYRef.current <= 100 || seen === null;
        // Still at the clamped bottom? (exact: uniform rows) — within a
        // row of the end counts; scrolling away spends the slot.
        const atBottom =
          scrollYRef.current + viewportHRef.current >= ROW_H * dataLenRef.current - ROW_H;
        const slot = clampReturnRef.current;
        clampReturnRef.current = null;
        if (atTop) {
          jumpRef.current = { target: 'top' };
        } else if (next === 'everything' && slot !== null && atBottom) {
          // The reader still sits on the clamped landing: the return
          // trip restores the Everything unit the clamp came from.
          jumpRef.current = { target: { anchor: slot.cameFrom } };
        } else {
          jumpRef.current = {
            target: { anchor: { ref: unitRefOf(seen), newestAt: seen.newestAt } },
          };
        }
        return next;
      });
      // The pref write is best-effort: a failure costs only the memory
      // of the choice, said out loud once.
      void setSetting(db, TIMELINE_FILTER_KEY, next).catch((error: unknown) =>
        console.warn('[timeline] filter preference not saved:', String(error)),
      );
    },
    [db],
  );

  // ---------------------------------------------------- browse pager
  const [browse, setBrowse] = useState<BrowseState>({
    assembly: EMPTY_BROWSE_ASSEMBLY,
    exhausted: false,
    failed: false,
    // gen 0 predates every refresh (the first mints gen 1), so the
    // initial state can never masquerade as a live stream's.
    gen: 0,
  });
  const pagerRef = useRef<MergedPager<BrowseItem> | null>(null);
  const genRef = useRef(0);
  /** ONE flight at a time over the browse — a page load or a refresh
   * walk. A refresh asked for while the flag is held queues behind the
   * flight instead of discarding it (prong 3). */
  const loadingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  /** onEndReached asked for a page while a flight held the flag: React
   * Native fires it once per content length, and a refresh republishes
   * the same length, so the request is kept and served after (codex r1). */
  const loadQueuedRef = useRef(false);
  const failedRef = useRef(false);
  /** Mirrors of the published stream — the refresh depth counts the
   * flushed tail an exhausted stream renders as one more card. */
  const assemblyRef = useRef<BrowseAssembly>(EMPTY_BROWSE_ASSEMBLY);
  const exhaustedRef = useRef(false);
  /** Every verdict landed since the current pager was built, latest per
   * photo — applied at every publish: the pager BUFFERS rows beyond what
   * it hands out (120 singles, 40 groups per fetch against 40 merged
   * items), so a row decided before it is assembled would otherwise
   * render its pre-decision state for good (codex r1). A refresh reads
   * everything afresh and starts an empty overlay. */
  const verdictOverlayRef = useRef<Map<string, VerdictChange>>(new Map());
  const withVerdicts = (assembly: BrowseAssembly): BrowseAssembly =>
    patchBrowseVerdicts(assembly, [...verdictOverlayRef.current.values()]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const loadMoreBrowse = useCallback(async () => {
    const pager = pagerRef.current;
    let continueRounds = false;
    if (!pager) return;
    if (loadingRef.current) {
      loadQueuedRef.current = true;
      return;
    }
    // A failed pager is never reused: its buffers lost items with the
    // rejection, so only a refresh ("leave and reopen") may continue.
    if (failedRef.current) return;
    loadingRef.current = true;
    loadQueuedRef.current = false;
    const gen = genRef.current;
    try {
      // Progress is measured in RENDERED UNITS, not fetched items
      // (self-review finding 1): the list shows closed units only, so a
      // batch that closes none — a long same-day singles stretch —
      // changes nothing on screen, and VirtualizedList then never
      // re-fires onEndReached (its content length is unchanged). Loop
      // until at least one unit closes or the stream exhausts; each
      // round is one bounded fetch, so exhaustion bounds the loop.
      let assembly = assemblyRef.current;
      const before = assembly.units.length;
      const freshIds: string[] = [];
      // Bounded per call (codex r4): a huge same-day singles stretch
      // extends the open tail without closing a unit, and an unbounded
      // close-a-unit loop would drain every one of its pages — and
      // hold the JS thread — before publishing anything. The finally
      // block schedules a continuation instead, so the drain proceeds
      // in slices that yield between fetch rounds.
      let rounds = 0;
      do {
        const started = Date.now();
        let items: readonly BrowseItem[];
        try {
          items = await pager.next(BROWSE_BATCH);
        } catch (error) {
          // codex r2: the fetchers used to convert a rejected page into
          // a fake EMPTY page — the merged pager then drained that
          // stream for good and assembled units across unknown rows
          // (same-day singles joined across an unfetched group). The
          // failure now stops this pager outright: publish the safe
          // prefix already assembled, say the read failed, and leave
          // the retry to a refresh.
          console.warn('[timeline] browse page failed:', String(error));
          failedRef.current = true;
          assemblyRef.current = withVerdicts(assembly);
          exhaustedRef.current = false;
          setBrowse({ assembly: assemblyRef.current, exhausted: false, failed: true, gen });
          return;
        }
        // Aggregated (m0.8.7): one line per scroll page flooded the
        // diagnostics sink — the session summary carries the same data.
        perfAggregate('timeline browse pages', Date.now() - started, items.length);
        for (const item of items) {
          if (item.kind === 'group') for (const m of item.group.members) freshIds.push(m.asset_id);
          else freshIds.push(item.member.asset_id);
        }
        assembly = appendBrowseItems(assembly, items);
      } while (assembly.units.length === before && !pager.exhausted() && ++rounds < 8);
      continueRounds = assembly.units.length === before && !pager.exhausted();
      // Deep browse rows sit outside the bounded pending snapshot, so
      // their ACTION badges rendered empty until hydrated (codex r1) —
      // the same pre-publication hydration DayProgress runs. Fail-soft:
      // a failed hydration degrades badges, never the list.
      if (freshIds.length > 0)
        await hydrateBadges(freshIds).catch((error: unknown) =>
          console.warn('[timeline] browse badge hydration failed:', String(error)),
        );
      assemblyRef.current = withVerdicts(assembly);
      exhaustedRef.current = pager.exhausted();
      setBrowse({
        assembly: assemblyRef.current,
        exhausted: pager.exhausted(),
        failed: failedRef.current,
        gen,
      });
    } finally {
      loadingRef.current = false;
      // A refresh that arrived mid-flight runs now, once — after this
      // page rendered (prong 3). Otherwise the capped drain continues
      // in a fresh slice (or a page asked for meanwhile is served):
      // VirtualizedList will not re-fire onEndReached while the unit
      // count is unchanged, so nothing else would.
      if (refreshQueuedRef.current) void refreshRef.current();
      else if ((continueRounds || loadQueuedRef.current) && !failedRef.current)
        void loadMoreBrowse();
    }
  }, [hydrateBadges]);

  /**
   * (Re)walk the browse stream from the top (the first load, a
   * membership change, a foreground return or a volume mount): a new
   * pager under a new generation, driven to the depth currently on
   * screen — or until exhaustion — and published WHOLE. Until then the
   * old stream stays rendered: rows are uniform, so replacing the data
   * keeps the reader's offset, and a stream that grew or shrank above
   * the viewport shifts the cards by that much and no more.
   */
  const refreshBrowse = useCallback(async () => {
    if (loadingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshQueuedRef.current = false;
    loadingRef.current = true;
    const gen = ++genRef.current;
    failedRef.current = false;
    // Everything the walk reads is at least as fresh as this moment;
    // only verdicts landing from here on need the overlay.
    verdictOverlayRef.current = new Map();
    try {
      // The browse read scopes like every review read: the selected
      // sources and the mounted-volume set, resolved now. FAIL CLOSED:
      // an unresolved source filter must not broaden to "all".
      let roots: Awaited<ReturnType<typeof resolveSources>>['roots'] | null;
      let mounted: readonly string[] | null;
      try {
        roots = (await resolveSources(db)).roots ?? null;
        // A fully-mounted set is no filter: the group stream then walks
        // the stored anchors instead of aggregating per group.
        mounted = await collapseReach(db, await mountedVolumeSet());
      } catch (error) {
        // The last-good stream stays rendered under the new generation
        // (codex r3): a transient failure must not collapse a deep read;
        // the footer says the read failed, and the next refresh retries.
        // A first load has nothing to keep and shows the failure copy.
        console.warn('[timeline] browse scope resolution failed:', String(error));
        failedRef.current = true;
        setBrowse({
          assembly: assemblyRef.current,
          exhausted: exhaustedRef.current,
          failed: true,
          gen,
        });
        return;
      }
      const singlesFetcher: PageFetcher<BrowseItem, BrowseCursor> = async (cursor, count) => {
        const rows = await fetchBrowseSinglesPage(
          db,
          roots,
          mounted,
          cursor as { takenAt: number; assetId: string } | undefined,
          Math.max(count, BROWSE_SINGLES_PAGE),
        );
        const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
        return {
          items: rows.map((member) => ({ kind: 'single' as const, member })),
          nextCursor:
            rows.length < Math.max(count, BROWSE_SINGLES_PAGE) || last === undefined
              ? null
              : { takenAt: last.taken_at, assetId: last.asset_id },
        };
      };
      const groupsFetcher: PageFetcher<BrowseItem, BrowseCursor> = async (cursor, count) => {
        const rows = await fetchBrowseGroupsPage(
          db,
          roots,
          mounted,
          cursor as BrowseGroupCursor | undefined,
          Math.max(count, BROWSE_GROUPS_PAGE),
        );
        const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
        return {
          items: rows.map((group) => ({ kind: 'group' as const, group })),
          // The cursor's anchor is MINTED BY THE QUERY that owns the
          // ordering key (self-review finding 2; codex r5 made the two
          // coincide — the anchor now spans the whole reachable group,
          // exactly what the projection renders).
          nextCursor:
            rows.length < Math.max(count, BROWSE_GROUPS_PAGE) || last === undefined
              ? null
              : { anchor: last.anchor ?? last.members[0]?.taken_at ?? 0, groupId: last.groupId },
        };
      };
      // Singles at bucket 0: merged-pager ties go to the LOWER index,
      // matching buildTimeline's "ties break toward the single".
      const pager = createMergedDescendingPager<BrowseItem, BrowseCursor>(
        [singlesFetcher, groupsFetcher],
        browseItemTime,
      );
      // Installed only once the walk succeeds: a failed walk leaves the
      // last-good pager and stream in place.
      // The depth to re-walk to: what is on screen — an exhausted
      // stream renders its open tail as one more card (flushBrowseTail)
      // — and at least one unit on a first load, so an empty list shows
      // something as soon as a unit closes. Each round is one native
      // round trip, so the walk yields between pages by construction.
      const rendered =
        assemblyRef.current.units.length +
        (exhaustedRef.current && assemblyRef.current.openRun.length > 0 ? 1 : 0);
      const target = Math.max(1, rendered);
      let assembly: BrowseAssembly = EMPTY_BROWSE_ASSEMBLY;
      do {
        const started = Date.now();
        let items: readonly BrowseItem[];
        try {
          items = await pager.next(BROWSE_BATCH);
        } catch (error) {
          console.warn('[timeline] browse page failed:', String(error));
          failedRef.current = true;
          setBrowse({
            assembly: assemblyRef.current,
            exhausted: exhaustedRef.current,
            failed: true,
            gen,
          });
          return;
        }
        perfAggregate('timeline browse pages', Date.now() - started, items.length);
        const freshIds: string[] = [];
        for (const item of items) {
          if (item.kind === 'group') for (const m of item.group.members) freshIds.push(m.asset_id);
          else freshIds.push(item.member.asset_id);
        }
        if (freshIds.length > 0)
          await hydrateBadges(freshIds).catch((error: unknown) =>
            console.warn('[timeline] browse badge hydration failed:', String(error)),
          );
        assembly = appendBrowseItems(assembly, items);
      } while (assembly.units.length < target && !pager.exhausted());
      pagerRef.current = pager;
      assemblyRef.current = withVerdicts(assembly);
      exhaustedRef.current = pager.exhausted();
      setBrowse({
        assembly: assemblyRef.current,
        exhausted: pager.exhausted(),
        failed: false,
        gen,
      });
    } finally {
      loadingRef.current = false;
      // Refresh requests that arrived during this walk fold into one
      // more; otherwise a page the reader asked for meanwhile loads.
      if (refreshQueuedRef.current) void refreshRef.current();
      else if (loadQueuedRef.current && !failedRef.current) void loadMoreBrowse();
    }
  }, [db, hydrateBadges, loadMoreBrowse]);
  refreshRef.current = refreshBrowse;

  // Verdicts land in place (prong 2): the rendered rows take the new
  // state now; a flight in progress applies them at its publish.
  useEffect(() => {
    if (verdictPatch.seq === 0) return;
    for (const change of verdictPatch.changes)
      verdictOverlayRef.current.set(change.assetId, change);
    if (loadingRef.current) return;
    const patched = withVerdicts(assemblyRef.current);
    if (patched === assemblyRef.current) return;
    assemblyRef.current = patched;
    setBrowse((prev) => ({ ...prev, assembly: patched }));
  }, [verdictPatch]);

  // The Everything stream refreshes when the browse STRUCTURE changed
  // since it was loaded — a membership writer published (throttled to a
  // few refreshes a second under a landing scan), a foreground return
  // or a volume mount (the external-refresh hook: reviewed-only changes
  // and reach never bump any version) — now if Everything is showing,
  // else on reselection. Decisions never refresh it (they patch rows).
  // Focus alone deliberately does NOT refresh: nothing changed, and a
  // refresh would move the reading position the filter memory keeps.
  // Focus-gated and throttled to one refresh per two seconds (the S10e
  // profile under a full pass: an unfocused Timeline re-walked 1 700
  // pages behind a deck at the 750 ms cadence, JS-thread time the scan
  // and the reader were paying for); a change while unfocused refreshes
  // on the return.
  const membershipVer = useMembershipVersion(2000);
  const focused = useIsFocused();
  const [externalTick, setExternalTick] = useState(0);
  useExternalRefresh(() => setExternalTick((t) => t + 1));
  const loadedStructureRef = useRef<{ membership: number; external: number } | null>(null);
  useEffect(() => {
    if (filter !== 'everything' || !focused) return;
    const loaded = loadedStructureRef.current;
    if (loaded !== null && loaded.membership === membershipVer && loaded.external === externalTick)
      return;
    loadedStructureRef.current = { membership: membershipVer, external: externalTick };
    void refreshBrowse();
  }, [filter, focused, membershipVer, externalTick, refreshBrowse]);

  // ------------------------------------------------------------ data
  const data: readonly TimelineUnit[] = useMemo(() => {
    if (filter === 'everything') {
      return browse.exhausted ? flushBrowseTail(browse.assembly) : browse.assembly.units;
    }
    if (filter === 'unreviewed') return unreviewedOnly(timeline);
    return timeline;
  }, [filter, timeline, browse]);

  // ------------------------------------ animated thumbnails (phase 6)
  // A card's thumbnails play their clips while the card is on screen:
  // the controller's item is the CARD, its sub-cells the shown thumbs.
  const animatedMode = useAnimatedThumbsMode();
  const dataRef = useRef(data);
  dataRef.current = data;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const kindsAt = useCallback((index: number) => {
    const unit = dataRef.current[index];
    return unit ? cardThumbRows(membersOf(unit)).map((row) => row.animated) : [];
  }, []);
  const cellOf = useCallback(
    (token: ViewToken) => ({
      index: token.index ?? -1,
      key: unitKeyOf(token.item as TimelineUnit, filterRef.current),
    }),
    [],
  );
  const cells = useAnimatedCells({
    mode: animatedMode,
    columns: 5,
    tileDp: ROW_H,
    kindsAt,
    rows: data,
    cellOf,
  });

  // -------------------------------------------- filter-switch anchor
  const listRef = useRef<FlatList<TimelineUnit>>(null);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: TimelineUnit }> }) => {
      // Same stale window as onScroll (codex r9): this handler is one
      // stable ref shared across the keyed list instances, and a late
      // viewability update from the keyed-out list — or the fresh
      // mount's initial pass racing the jump — would overwrite the
      // landing's hand-set unit mirror.
      if (Date.now() - jumpAtRef.current < 400) return;
      viewableRef.current = viewableItems[0]?.item ?? null;
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  // TWO viewability pairs on the one list (fixed at mount, as React
  // Native requires): the anchor mirror above, and the animated
  // controller's any-part rule.
  const viewabilityPairs = useRef([
    {
      viewabilityConfig,
      onViewableItemsChanged: onViewableItemsChanged as (info: {
        viewableItems: ViewToken[];
      }) => void,
    },
    {
      viewabilityConfig: cells.listProps.viewabilityConfig,
      onViewableItemsChanged: cells.listProps.onViewableItemsChanged,
    },
  ]).current;
  /** Fires a held jump once Everything's data has grown. */
  const [jumpNudge, setJumpNudge] = useState(0);
  /** The back-to-top control shows once the reader is deep enough that
   * flinging back is a chore. Landing at 0 IS the top — the next
   * switch's at-top test reads scrollY directly. */
  const [showBackToTop, setShowBackToTop] = useState(false);
  /** Instant jumps fire no onScroll, but a LATE event minted before the
   * jump — on the disc's own list, or queued by a keyed-out list that
   * outlives its unmount — can land after the mirrors were set by hand
   * and overwrite them with the old offset (device pass; codex r8).
   * Every programmatic jump arms this window; a real finger disarms it
   * (onScrollBeginDrag precedes its own scroll events). */
  const jumpAtRef = useRef(0);
  const backToTop = useCallback(() => {
    clampReturnRef.current = null;
    // An authoritative top landing abandons any held page-toward jump
    // (codex r7): without this, the next page nudge would resume the
    // hold and pull the reader back deep after they chose the top.
    jumpRef.current = null;
    scrollYRef.current = 0;
    jumpAtRef.current = Date.now();
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setShowBackToTop(false);
  }, []);
  useEffect(() => {
    const jump = jumpRef.current;
    if (jump === null) return;
    jumpRef.current = null;
    // A drag during a HOLD abandons the jump — the page-toward must
    // never fight a live finger.
    if (jump.held === true && holdDragRef.current) return;
    // JUMP-SCOPED from here: only a drag AFTER this jump begins vetoes
    // its retry or its hold — never the scrolling that preceded the
    // switch (the inherited-flag class, third instance).
    holdDragRef.current = false;
    // Landings keep BOTH scroll mirrors honest: programmatic scrolls
    // emit no onScroll on Android (the histogram lesson), and the disc
    // state survives the keyed remount, so each must be set by hand.
    // Mirror the ACHIEVABLE offset, not the ask (codex r8): the native
    // list clamps a near-end request to its physical max, and a false-
    // deep mirror fails the next switch's top rule (restoring a deep
    // anchor over a visibly-top list) and shows the disc over a short
    // one. Landing also ARMS the stale-event window (codex r8): a
    // queued event from the keyed-out list can outlive its unmount and
    // would overwrite these fresh mirrors.
    const landAt = (offset: number) => {
      const contentH =
        ROW_H * data.length + LIST_PAD_BOTTOM + (footerNoteRef.current ? FOOTER_H : 0);
      const max = Math.max(0, contentH - viewportHRef.current);
      const y = Math.max(0, Math.min(offset, max));
      scrollYRef.current = y;
      // The viewport-top UNIT mirror too (codex r9): viewability is
      // recomputed from scroll events, and this landing emits none — a
      // consecutive switch would otherwise anchor on the fresh mount's
      // initial top instead of what the landing shows. Exact, since
      // rows are.
      viewableRef.current =
        data.length === 0 ? null : data[Math.min(Math.floor(y / ROW_H), data.length - 1)];
      jumpAtRef.current = Date.now();
      setShowBackToTop(y > DEEP_PX);
    };
    // Runs post-commit: `data` is already the target filter's array,
    // and a non-animated jump also kills any carried fling.
    if (jump.target === 'top') {
      landAt(0);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const anchor = jump.target.anchor;
    // A refresh in this SAME flush already superseded the assembly this
    // effect closed over (the refresh effect is declared first, and it
    // bumps genRef synchronously) — or one is queued behind a page in
    // flight and will: consuming the anchor against the old stream
    // would land on rows the fresh stream replaces one render later
    // (codex r7 P1). This wait IS a hold — same first-hold
    // treatment (show the top, arm the drag baseline, a drag during it
    // abandons), minus the pager kick: the refresh owns its own walk,
    // and its publish re-enters through jumpNudge.
    if (filter === 'everything' && (browse.gen !== genRef.current || refreshQueuedRef.current)) {
      if (jump.held !== true) {
        landAt(0);
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
      jumpRef.current = { ...jump, held: true };
      return;
    }
    // HOLD while Everything cannot answer yet: the browse loads
    // incrementally, so an anchor DEEPER than the loaded frontier —
    // or TYING it without its unit loaded (equal capture times split
    // across a page boundary, codex r7) — pages toward it (70-90 ms a
    // page on the 27k device) instead of giving up to the top; each
    // landed page re-enters through the nudge.
    if (
      filter === 'everything' &&
      !browse.exhausted &&
      !browse.failed &&
      needsDeeperPages(data, anchor)
    ) {
      // FIRST hold: show the top while pages stream (a deep raw
      // offset over a near-empty list reads as a black screen), and
      // reset the drag baseline — only a drag AFTER the hold began
      // abandons it, never the scrolling that preceded the switch.
      if (jump.held !== true) {
        landAt(0);
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }
      jumpRef.current = { ...jump, held: true };
      void loadMoreBrowse();
      return;
    }
    if (data.length === 0) {
      // Exhausted or failed while still empty: nothing to land on.
      landAt(0);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const clampToEnd = filter !== 'everything';
    const index = anchorIndexIn(data, anchor, clampToEnd);
    if (index === null) {
      landAt(0);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    // A pending CLAMP (the anchor has no counterpart and lands on the
    // last unit) charges the one memory slot: the return trip to
    // Everything restores the unit this clamp came from.
    if (clampToEnd && index === data.length - 1 && findUnitIndex(data, anchor.ref) < 0)
      clampReturnRef.current = { cameFrom: anchor };
    landAt(ROW_H * index);
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    // data is deliberately not a dependency: the jump happens once per
    // switch, not on every page the browse pager lands afterwards (the
    // one exception, the held jump, re-enters through jumpNudge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, jumpNudge]);
  // A held jump re-enters on every COMPLETED publish — new data, and
  // ALSO a new generation or a failure that republished the last-good
  // stream under the same array (codex r5: a refresh queued behind a
  // page that then failed changes no data), and a refresh that proved
  // the scope EMPTY (codex r6: an exhausted or failed empty stream must
  // land the hold at the top and consume it, not keep an old-scope
  // anchor for whatever populates later). Only an empty stream still
  // loading its first page waits for the next publish.
  useEffect(() => {
    if (jumpRef.current === null) return;
    if (data.length > 0 || browse.exhausted || browse.failed) setJumpNudge((n) => n + 1);
  }, [data, browse.gen, browse.failed, browse.exhausted]);

  dataLenRef.current = data.length;
  const stateOf = useMemo(() => {
    const map = new Map<string, PhotoState>();
    for (const unit of data) {
      const members = unit.kind === 'group' ? unit.group.members : unit.members;
      for (const m of members) map.set(m.asset_id, m.state);
    }
    return map;
  }, [data]);
  /** Same badge set as the deck (m0.8.1 round 4): verdict plus every
   * action, none hiding another, each at its own weight (m0.8.2). The
   * verdict rides into actionWeights so a staged cull's retained actions
   * badge quiet — they left the queues with it. */
  const badgesFor = useCallback(
    (assetId: string): PhotoBadge[] => {
      const state = stateOf.get(assetId) ?? 'unreviewed';
      return photoBadges({ state, ...actionWeights(assetId, state) });
    },
    [actionWeights, stateOf],
  );

  const openUnit = useCallback(
    (unit: TimelineUnit) => {
      const destination = unitDestination(unit);
      if (destination.kind === 'cullList') navigation.navigate('CullList');
      else navigation.navigate('Deck', deckParamsFor(destination));
    },
    [navigation],
  );

  const renderUnit = useCallback(
    ({ item: unit, index }: { item: TimelineUnit; index: number }) => {
      const card = renderUnitCard(unit, index);
      return <View style={styles.row}>{card}</View>;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [badgesFor, openUnit, cells, filter],
  );
  const renderUnitCard = (unit: TimelineUnit, index: number) => {
    const animated = { cells, index, cellKey: unitKeyOf(unit, filter) };
    if (unit.kind === 'group') {
      const group = unit.group;
      const pending = group.members.filter((m) => m.state === 'unreviewed').length;
      // Hidden members are NAMED on the card itself (Tristan, m0.8.3
      // matrix): a mixed group showing one thumbnail must say why
      // without being opened. The disclosure outranks the tap hint on
      // the single status line (codex r7: the uniform header clips
      // instead of wrapping, and the suffix is the load-bearing half).
      const away =
        (group.unreachableCount ?? 0) > 0
          ? ` · ${group.unreachableCount} on unmounted SD card`
          : '';
      const done = away === '' ? 'Reviewed · tap to revisit' : 'Reviewed';
      const newest = group.members[0];
      return (
        <UnitCard
          title={`Group · ${group.members.length} shots · ${labelForDayKey(newest?.day ?? UNDATED_DAY_KEY)}${newest ? ` ${formatClock(newest.taken_at)}` : ''}`}
          status={(pending === 0 ? done : `${pending} pending`) + away}
          statusDone={pending === 0}
          members={group.members}
          animated={animated}
          onPress={() => openUnit(unit)}
          renderOverlay={(id) => (
            <StateDots
              effective={classifyPhotoState({
                state: group.members.find((m) => m.asset_id === id)?.state ?? 'unreviewed',
              })}
              badges={badgesFor(id)}
              style={styles.badges}
            />
          )}
        />
      );
    }
    const pending = unit.members.filter((m) => m.state === 'unreviewed').length;
    return (
      <UnitCard
        title={`Singles · ${plural(unit.members.length, 'item')} · ${labelForDayKey(unit.day)}`}
        status={pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
        statusDone={pending === 0}
        members={unit.members}
        animated={animated}
        onPress={() => openUnit(unit)}
        renderOverlay={(id) => (
          <StateDots
            effective={classifyPhotoState({
              state: unit.members.find((m) => m.asset_id === id)?.state ?? 'unreviewed',
            })}
            badges={badgesFor(id)}
            style={styles.badges}
          />
        )}
      />
    );
  };

  // First PENDING unit: a cull-only run stays a browseable card, but
  // the CTA must open review work — anchored to the PENDING feed
  // whatever the filter shows (L7).
  const first = firstPendingUnit(timeline);
  const total = queueCounts.grouped + queueCounts.singles;
  // The pending feed is BOUNDED (two pages + the horizon truncation),
  // so on a large backlog Unfinished and Unreviewed-only end long
  // before the corpus does — which reads as a bug beside Everything's
  // endless scroll (device pass, 2026-08-19: the list bounced at
  // 09 May with 27k to review). Say the truncation out loud instead:
  // the footer names how much is shown and that the tail pages in as
  // review proceeds, exactly the m0.8.2 design's contract.
  const shownPending = useMemo(() => {
    if (filter === 'everything') return 0;
    return data.reduce((n, unit) => {
      const members = unit.kind === 'group' ? unit.group.members : unit.members;
      return n + members.filter((m) => m.state === 'unreviewed').length;
    }, 0);
  }, [filter, data]);
  const pendingTruncated = filter !== 'everything' && shownPending < total;
  // The ONE home for "is a footer note rendered" — the JSX and the
  // landing mirror's geometry both read it (codex r9: a condition
  // duplicated between them would drift).
  const footerNote =
    filter === 'everything' && browse.failed && data.length > 0
      ? 'Could not read all of your history just now — leave and reopen to retry.'
      : pendingTruncated && data.length > 0
        ? `Showing the newest ${shownPending.toLocaleString()} of ${total.toLocaleString()} to review — more pages in as you review, or switch to Everything to browse it all.`
        : null;
  footerNoteRef.current = footerNote !== null;

  if (filter === null) {
    return <View style={styles.root} />;
  }

  return (
    // The native stack header carries the title + back arrow (and eats
    // the top inset) — stack screens never re-render their own title or
    // re-pad insets.top (m0.8.1 consistency sweep).
    <View style={[styles.root, { paddingTop: 12 }]}>
      <Text style={styles.subtitle}>
        {plural(total, 'item')} to review · {plural(queueCounts.groups, 'group')} ·{' '}
        {plural(queueCounts.singles, 'single')}
      </Text>
      <View style={styles.filterRow}>
        {TIMELINE_FILTERS.map(({ value, label }) => {
          const active = filter === value;
          return (
            <Pressable
              key={value}
              style={[
                styles.filterChip,
                active && [styles.filterChipActive, { borderColor: theme.accent }],
              ]}
              onPress={() => setFilter(value)}
              accessibilityLabel={`Filter: ${label}`}
            >
              <Text style={[styles.filterLabel, active && styles.filterLabelActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <FlatList
        // ONE LIST PER FILTER (the simplification's keystone): a switch
        // is a fresh mount at offset 0 plus one jump — no scroll state
        // ever bridges filters.
        key={filter}
        ref={listRef}
        data={data}
        // EXACT virtualization (uniform cards): every landing is
        // deterministic on a cold list, the estimated-height machinery
        // (mVCP, scroll retries) is gone, and the 103px re-measure
        // oscillation class is impossible — estimates ARE measurements.
        getItemLayout={(_items, index) => ({
          length: ROW_H,
          offset: ROW_H * index,
          index,
        })}
        viewabilityConfigCallbackPairs={viewabilityPairs}
        onLayout={(e) => {
          viewportHRef.current = e.nativeEvent.layout.height;
          cells.listProps.onLayout(e);
        }}
        onScroll={(e) => {
          // ANY event inside the post-jump window is a straggler from
          // before the jump (programmatic scrolls emit none): believing
          // it would poison the mirror and the disc in either direction
          // (codex r8). A real drag disarms the window first.
          if (Date.now() - jumpAtRef.current < 400) return;
          const y = e.nativeEvent.contentOffset.y;
          scrollYRef.current = y;
          const deep = y > DEEP_PX;
          if (deep !== showBackToTop) setShowBackToTop(deep);
        }}
        scrollEventThrottle={33}
        // A finger-drag during a page-toward hold abandons it;
        // programmatic jumps never fire this. A new drag also ends the
        // post-disc stale-event window (codex r7): the finger's own
        // events are fresh by definition.
        onScrollBeginDrag={() => {
          holdDragRef.current = true;
          jumpAtRef.current = 0;
        }}
        keyExtractor={(unit) => unitKeyOf(unit, filter)}
        renderItem={renderUnit}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onPullRefresh()}
            tintColor={colors.textDim}
            colors={[theme.accent]}
            progressBackgroundColor={colors.surface}
          />
        }
        extraData={version}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (filter === 'everything' && !browse.exhausted && !browse.failed) void loadMoreBrowse();
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {filter === 'everything'
              ? browse.failed
                ? 'Could not read your history just now — leave and reopen to retry.'
                : browse.exhausted
                  ? 'No items yet.'
                  : 'Loading…'
              : 'Nothing left to review.'}
          </Text>
        }
        ListFooterComponent={
          footerNote !== null ? (
            // Pinned height (codex r9): a content-sized footer would put
            // the list's physical maximum offset outside the exact
            // geometry the landing mirror computes from.
            <View style={styles.footerNote}>
              <Text style={styles.footerNoteText} numberOfLines={3}>
                {footerNote}
              </Text>
            </View>
          ) : null
        }
      />
      {showBackToTop && (
        <Pressable
          style={[styles.topFab, { bottom: insets.bottom + 96, borderColor: theme.accent }]}
          onPress={backToTop}
          accessibilityLabel="Back to top"
        >
          <MaterialCommunityIcons name="chevron-up" size={26} color={theme.accent} />
        </Pressable>
      )}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={first ? 'Continue reviewing' : 'Review cull list'}
          color={theme.accent}
          textColor={theme.onAccent}
          onPress={() => (first ? openUnit(first) : navigation.navigate('CullList'))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  emptyText: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  filterRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  // Accent outline over a neutral lift — the app's one selection
  // language (docs/STATE_MODEL.md rule 4), matching History's chips.
  filterChip: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: { backgroundColor: colors.surfaceRaised },
  filterLabel: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  filterLabelActive: { color: colors.text },
  list: { paddingBottom: LIST_PAD_BOTTOM },
  /** Height-pinned like the cards (FOOTER_H is part of the landing
   * mirror's exact geometry); extreme font scales ellipsize. */
  footerNote: { height: FOOTER_H, justifyContent: 'center' },
  footerNoteText: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  /** The row owns the gap (padding, not margin): getItemLayout's ROW_H
   * must equal the cell's true laid-out height. */
  row: { height: ROW_H, paddingBottom: ROW_GAP },
  // Wrapping cluster inside the thumbnail — every badge stays visible.
  badges: { position: 'absolute', right: 2, bottom: 2, left: 2 },
  footer: { paddingTop: 8, gap: 8 },
  // Accent outline + accent chevron (device pass: the neutral disc
  // vanished into the background); the raised surface keeps it from
  // competing with the solid-accent CTA below.
  topFab: {
    position: 'absolute',
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
