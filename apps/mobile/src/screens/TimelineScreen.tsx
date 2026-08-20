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
 *   reviewed included (D1): two keyset streams (browse groups anchored
 *   on their newest visible member, ungrouped singles) merged by
 *   progressPager into one descending item stream, assembled into units
 *   incrementally (lib/timeline.ts appendBrowseItems — the tail run
 *   stays open across pages). No optimistic patches: the page resets
 *   when the review version bumps. Units render exactly as when pending
 *   (D2) — one card per unit, no collapse.
 * - UNREVIEWED ONLY — a pure display subset of the Unfinished data
 *   (D3): units with undecided work, staged-cull singles hidden.
 *
 * "Continue reviewing" anchors to the first PENDING unit whatever the
 * filter shows (L7), and the subtitle counts stay pending-only DB
 * counts on every filter — they describe work, not the view.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { BigButton } from '../components/BigButton';
import { UnitCard } from '../components/UnitCard';
import { BadgeCluster } from '../components/DecisionBadge';
import { colors, useTheme } from '../theme';
import { formatClock } from '../lib/format';
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import {
  anchorIndexIn,
  appendBrowseItems,
  browseItemTime,
  EMPTY_BROWSE_ASSEMBLY,
  firstPendingUnit,
  flushBrowseTail,
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
import { perfLog } from '../lib/perfLog';

type Props = NativeStackScreenProps<RootStackParamList, 'Timeline'>;

/** Items consumed from the merged stream per FlatList page. The stream
 * fetchers page beneath it (singles wider than groups — a sparse
 * stretch is mostly singles). */
const BROWSE_BATCH = 40;
const BROWSE_SINGLES_PAGE = 120;
const BROWSE_GROUPS_PAGE = 40;

type BrowseCursor = BrowseGroupCursor | { takenAt: number; assetId: string };

/** A reading position: the unit under the viewport top plus how far its
 * own top sits from it (≤ 0 when partially scrolled off). */
interface PlaceCapture {
  anchor: TimelineAnchor;
  delta: number;
}

/** The cell-top map's key — canonical, NOT the FlatList keyExtractor,
 * whose run shape differs per filter. Only read back within one
 * filter's data, where it is unique. */
const cellTopKey = (unit: TimelineUnit): string =>
  unit.kind === 'group' ? `g:${unit.group.groupId}` : `r:${unit.day}:${unit.from}:${unit.to}`;

/** What VirtualizedList hands a CellRendererComponent (RN 0.86 keeps no
 * public TS export for it). */
interface CellProps {
  item: TimelineUnit;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
}

interface BrowseState {
  assembly: BrowseAssembly;
  exhausted: boolean;
  /** A page read failed — the footer says so instead of claiming the
   * history simply ends here (fail-closed). */
  failed: boolean;
}

export function TimelineScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { timeline, queueCounts, version, actionWeights, hydrateBadges } = useReview();

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
  /** Live scroll offset + each mounted cell's content-y (canonical key,
   * filter-independent) — together they give the anchor unit's exact
   * on-screen position, so a jump restores the PIXEL the reader was at,
   * not just the card (device pass round 3: "not quite aligned"). */
  const scrollYRef = useRef(0);
  const cellTopsRef = useRef(new Map<string, number>());
  /** Where the reader last was in each filter, saved on every switch.
   * Restored instead of the carried anchor when the reader has not
   * DRAGGED since the last jump (round 3: peeking at a pending filter
   * from deep in Everything must not lose the deep position — but a
   * real scroll while away carries the new place across, the round-2
   * contract). place null = remembered TOP (final device pass: the
   * maintain rule engages only after scrolling). */
  const memoryRef = useRef<Partial<Record<TimelineFilter, { place: PlaceCapture | null }>>>({});
  const movedSinceJumpRef = useRef(true);
  /** Set by a filter switch, consumed once by the jump effect below.
   * place null = jump to the top (nothing was visible to anchor on). */
  const jumpRef = useRef<{ place: PlaceCapture | null } | null>(null);
  const setFilter = useCallback(
    (next: TimelineFilter) => {
      setFilterState((prev) => {
        if (prev === next || prev === null) return next;
        // AT THE TOP, the place IS the top (final device pass, Tristan):
        // the newest pending unit sits below every newer REVIEWED unit
        // in Everything, so "maintaining" a top-of-pending anchor landed
        // the reader mid-list needing to scroll up. The maintain rule
        // engages only once the reader has scrolled.
        const atTop = scrollYRef.current <= 8;
        const seen = viewableRef.current;
        const top = seen === null ? undefined : cellTopsRef.current.get(cellTopKey(seen));
        const place: PlaceCapture | null =
          atTop || seen === null
            ? null
            : {
                anchor: { ref: unitRefOf(seen), newestAt: seen.newestAt },
                delta: top === undefined ? 0 : top - scrollYRef.current,
              };
        memoryRef.current[prev] = { place };
        // The raw scroll offset means nothing in the other filter's data,
        // and momentum carried across the swap fights the re-layout (the
        // sustained jitter of the 2026-08-19 device pass). Every switch
        // involving Everything jumps to a place instead; the two pending
        // filters share one read and keep their natural position.
        if (prev === 'everything' || next === 'everything') {
          const remembered = memoryRef.current[next];
          jumpRef.current = {
            place:
              !movedSinceJumpRef.current && remembered !== undefined ? remembered.place : place,
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
  });
  const pagerRef = useRef<MergedPager<BrowseItem> | null>(null);
  const genRef = useRef(0);
  /** The generation pagerRef belongs to — a reset swaps the pager only
   * AFTER its async scope resolution, so the ref alone cannot say
   * whether it is current. */
  const pagerGenRef = useRef(0);
  const loadingRef = useRef(false);
  const failedRef = useRef(false);
  /** The loop's working copy — state is only a render mirror of this. */
  const assemblyRef = useRef<BrowseAssembly>(EMPTY_BROWSE_ASSEMBLY);

  const loadMoreBrowse = useCallback(
    async (gen: number) => {
      const pager = pagerRef.current;
      let continueRounds = false;
      if (!pager || loadingRef.current) return;
      // codex r2: during a reset's async scope resolution the ref still
      // holds the OLD generation's pager — driving it under the new
      // generation would publish previous-scope pages as fresh data.
      if (pagerGenRef.current !== gen) return;
      // A failed pager is never reused: its buffers lost items with the
      // rejection, so only a reset ("leave and reopen") may continue.
      if (failedRef.current) return;
      loadingRef.current = true;
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
          // Field tripwire (the plan's named perf gate): the browse group
          // anchors are a per-page aggregate with no stored column — this
          // line is what proves or refutes that trade on real corpora.
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
            // the retry to a reset. Gen-scoped (the round-1 race shape):
            // a stale pager's failure must not poison the replacement.
            console.warn('[timeline] browse page failed:', String(error));
            if (gen === genRef.current) {
              failedRef.current = true;
              assemblyRef.current = assembly;
              setBrowse({ assembly, exhausted: false, failed: true });
            }
            return;
          }
          perfLog(() => `timeline browse page: ${items.length} items in ${Date.now() - started}ms`);
          if (gen !== genRef.current) return;
          for (const item of items) {
            if (item.kind === 'group')
              for (const m of item.group.members) freshIds.push(m.asset_id);
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
        if (gen !== genRef.current) return;
        assemblyRef.current = assembly;
        setBrowse({
          assembly,
          exhausted: pager.exhausted(),
          failed: failedRef.current,
        });
      } finally {
        loadingRef.current = false;
        // codex r1: a reset racing this load found the flag held, bounced
        // its own first load, and nothing ever started the new pager —
        // Everything sat on "Loading…" until an incidental event. A stale
        // completion kicks the current generation itself, but only once
        // the reset has actually installed the current pager (mid-reset
        // the ref still holds the OLD pager, which must not be driven
        // under the new generation).
        if (gen !== genRef.current && pagerGenRef.current === genRef.current)
          void loadMoreBrowse(genRef.current);
        // The capped drain continues in a fresh slice (same generation,
        // flag released) — VirtualizedList will not re-fire onEndReached
        // while the unit count is unchanged, so nothing else would.
        else if (continueRounds && gen === genRef.current && !failedRef.current)
          void loadMoreBrowse(gen);
      }
    },
    [hydrateBadges],
  );

  const resetBrowse = useCallback(async () => {
    const gen = ++genRef.current;
    failedRef.current = false;
    assemblyRef.current = EMPTY_BROWSE_ASSEMBLY;
    setBrowse({ assembly: EMPTY_BROWSE_ASSEMBLY, exhausted: false, failed: false });
    // The browse read scopes like every review read: the selected
    // sources and the mounted-volume set, resolved at reset. FAIL
    // CLOSED: an unresolved source filter must not broaden to "all".
    let roots: Awaited<ReturnType<typeof resolveSources>>['roots'] | null;
    let mounted: readonly string[] | null;
    try {
      roots = (await resolveSources(db)).roots ?? null;
      mounted = await mountedVolumeSet();
    } catch (error) {
      console.warn('[timeline] browse scope resolution failed:', String(error));
      if (gen === genRef.current) {
        failedRef.current = true;
        setBrowse({ assembly: EMPTY_BROWSE_ASSEMBLY, exhausted: true, failed: true });
      }
      return;
    }
    if (gen !== genRef.current) return;
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
    pagerRef.current = createMergedDescendingPager<BrowseItem, BrowseCursor>(
      [singlesFetcher, groupsFetcher],
      browseItemTime,
    );
    pagerGenRef.current = gen;
    void loadMoreBrowse(gen);
  }, [db, loadMoreBrowse]);

  // The Everything data resets whenever it is (re)selected after an
  // invalidation or the review version bumps — a browse surface
  // refetches instead of patching (D1). The version signal covers
  // decisions made in decks opened from this very list; foreground
  // returns and volume mounts (codex r1: reviewed-only changes never
  // bump the version) invalidate through the external-refresh hook, so
  // the reset fires now if Everything is showing, else on reselection.
  // Focus alone deliberately does NOT reset: a version-silent focus
  // means nothing changed, and resetting would discard the reading
  // position the filter memory exists to keep.
  const browseVersionRef = useRef<number | null>(null);
  const [externalTick, setExternalTick] = useState(0);
  useExternalRefresh(() => {
    browseVersionRef.current = null;
    setExternalTick((t) => t + 1);
  });
  useEffect(() => {
    if (filter !== 'everything') return;
    if (browseVersionRef.current === version) return;
    browseVersionRef.current = version;
    void resetBrowse();
  }, [filter, version, resetBrowse, externalTick]);

  // ------------------------------------------------------------ data
  const data: readonly TimelineUnit[] = useMemo(() => {
    if (filter === 'everything') {
      return browse.exhausted ? flushBrowseTail(browse.assembly) : browse.assembly.units;
    }
    if (filter === 'unreviewed') return unreviewedOnly(timeline);
    return timeline;
  }, [filter, timeline, browse]);

  // -------------------------------------------- filter-switch anchor
  const listRef = useRef<FlatList<TimelineUnit>>(null);
  /** One estimate-then-retry per jump: scrollToIndex past the render
   * window fails onto onScrollToIndexFailed, whose offset estimate is
   * corrected by ONE exact re-issue once the target has been measured —
   * never a loop of them. */
  const retriedJumpRef = useRef(false);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: TimelineUnit }> }) => {
      viewableRef.current = viewableItems[0]?.item ?? null;
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  /** The in-flight jump's pixel offset, for the estimate-retry path. */
  const jumpViewOffsetRef = useRef(0);
  /** VirtualizedList's cell wrapper, extended to record each mounted
   * cell's content-y. Identity MUST be stable (useMemo) — a new
   * component type per render would remount every cell. The list's own
   * onLayout is forwarded: it is how VirtualizedList measures cells. */
  const TrackedCell = useMemo(
    () =>
      function TimelineCell({ item, children, style, onLayout, ...rest }: CellProps) {
        return (
          <View
            {...rest}
            style={style}
            onLayout={(event) => {
              cellTopsRef.current.set(cellTopKey(item), event.nativeEvent.layout.y);
              onLayout?.(event);
            }}
          >
            {children}
          </View>
        );
      },
    [],
  );
  /** The settle pass's timer, cancelled by any newer jump. */
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The estimate-retry's timer + owning jump generation, and a live
   * mirror of the list length (codex r6): the untracked 150 ms retry
   * could fire against the NEXT filter's data with a stale index —
   * out-of-range scrollToIndex throws an invariant — or override a
   * newer restoration or the reader's own drag. */
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpGenRef = useRef(0);
  const dataLenRef = useRef(0);
  /** Fires the held first-switch jump once Everything's data exists. */
  const [jumpNudge, setJumpNudge] = useState(0);
  useEffect(() => {
    const jump = jumpRef.current;
    if (jump === null) return;
    jumpRef.current = null;
    retriedJumpRef.current = false;
    movedSinceJumpRef.current = false;
    jumpGenRef.current += 1;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    // Runs post-commit: `data` is already the target filter's array. A
    // non-animated jump also kills any carried fling. The pending feeds
    // are complete reads, so an anchor older than their horizon clamps
    // to their last unit (the footer under it says why the trail ends);
    // the incremental browse read falls back to the top instead.
    // HOLD the jump while Everything cannot answer it yet (codex r1 +
    // the final device pass): the browse loads incrementally, so an
    // anchor DEEPER than the loaded frontier used to fall back to the
    // top — which made the landing depend on how deep the retained
    // assembly happened to be (Tristan's "inconsistent" repro: bottom
    // of Unfinished → top of Everything, sometimes aligned). The jump
    // now stays armed and PAGES TOWARD its anchor (70-90 ms a page on
    // the 27k device); each landed page re-enters through the nudge
    // below, until the anchor's time is inside the loaded range or the
    // stream ends.
    if (filter === 'everything' && jump.place !== null && !browse.exhausted && !browse.failed) {
      const oldestLoaded = data.length > 0 ? data[data.length - 1].newestAt : Infinity;
      if (data.length === 0 || jump.place.anchor.newestAt < oldestLoaded) {
        jumpRef.current = jump;
        void loadMoreBrowse(genRef.current);
        return;
      }
    }
    if (filter === 'everything' && data.length === 0) {
      // Exhausted or failed while still empty: nothing to land on.
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const index =
      jump.place === null ? null : anchorIndexIn(data, jump.place.anchor, filter !== 'everything');
    if (index === null || jump.place === null) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    const { delta } = jump.place;
    // The swap discarded every cell measurement, so this first jump can
    // only land on ESTIMATED offsets (device pass round 3: the restore
    // came back a few cards off). Cleared here so the settle pass below
    // reads only freshly measured tops, never the prior filter's.
    cellTopsRef.current.clear();
    // delta re-places the anchor at the exact pixel it occupied, not
    // merely at the viewport top (round 3: "not quite aligned").
    jumpViewOffsetRef.current = delta;
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: delta });
    // The settle pass: once the anchor's cell has really mounted, its
    // recorded top is MEASURED — one exact scrollToOffset erases the
    // estimate error. Not mounted yet (the estimate landed far off) →
    // re-issue the index jump with the metrics measured so far and try
    // again, bounded. A drag aborts: the reader took over.
    // Keyed off the unit LANDED ON in the target data — a run matched by
    // range overlap carries different bounds there than the anchor's ref.
    const anchorKey = cellTopKey(data[index]);
    const settle = (attempt: number) => {
      settleTimerRef.current = setTimeout(() => {
        if (movedSinceJumpRef.current) return;
        const top = cellTopsRef.current.get(anchorKey);
        if (top !== undefined) {
          const want = Math.max(0, top - delta);
          if (Math.abs(want - scrollYRef.current) > 4)
            listRef.current?.scrollToOffset({ offset: want, animated: false });
          return;
        }
        if (attempt >= 3) return;
        listRef.current?.scrollToIndex({
          index,
          animated: false,
          viewPosition: 0,
          viewOffset: delta,
        });
        settle(attempt + 1);
      }, 250);
    };
    settle(1);
    // data is deliberately not a dependency: the jump happens once per
    // switch, not on every page the browse pager lands afterwards (the
    // one exception, the held first jump, re-enters through jumpNudge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, jumpNudge]);
  useEffect(() => {
    if (jumpRef.current !== null && data.length > 0) setJumpNudge((n) => n + 1);
  }, [data]);

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
      return photoBadges({
        state,
        ...actionWeights(assetId, state),
      });
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
    ({ item: unit }: { item: TimelineUnit }) => {
      if (unit.kind === 'group') {
        const group = unit.group;
        const pending = group.members.filter((m) => m.state === 'unreviewed').length;
        // Hidden members are NAMED on the card itself (Tristan, m0.8.3
        // matrix): a mixed group showing one thumbnail must say why
        // without being opened.
        const away =
          (group.unreachableCount ?? 0) > 0
            ? ` · ${group.unreachableCount} on unmounted SD card`
            : '';
        const newest = group.members[0];
        return (
          <UnitCard
            title={`Group · ${group.members.length} shots · ${labelForDayKey(newest?.day ?? UNDATED_DAY_KEY)}${newest ? ` ${formatClock(newest.taken_at)}` : ''}`}
            status={(pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`) + away}
            statusDone={pending === 0}
            members={group.members}
            onPress={() => openUnit(unit)}
            renderOverlay={(id) => (
              <BadgeCluster badges={badgesFor(id)} size={14} style={styles.badges} />
            )}
          />
        );
      }
      const pending = unit.members.filter((m) => m.state === 'unreviewed').length;
      return (
        <UnitCard
          title={`Singles · ${unit.members.length} photo${unit.members.length === 1 ? '' : 's'} · ${labelForDayKey(unit.day)}`}
          status={pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
          statusDone={pending === 0}
          members={unit.members}
          onPress={() => openUnit(unit)}
          renderOverlay={(id) => (
            <BadgeCluster badges={badgesFor(id)} size={14} style={styles.badges} />
          )}
        />
      );
    },
    [badgesFor, openUnit],
  );

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

  if (filter === null) {
    return <View style={styles.root} />;
  }

  return (
    // The native stack header carries the title + back arrow (and eats
    // the top inset) — stack screens never re-render their own title or
    // re-pad insets.top (m0.8.1 consistency sweep).
    <View style={[styles.root, { paddingTop: 12 }]}>
      <Text style={styles.subtitle}>
        {total.toLocaleString()} photo{total === 1 ? '' : 's'} to review ·{' '}
        {queueCounts.groups.toLocaleString()} group{queueCounts.groups === 1 ? '' : 's'} ·{' '}
        {queueCounts.singles.toLocaleString()} single{queueCounts.singles === 1 ? '' : 's'}
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
        ref={listRef}
        data={data}
        // The device-pass jitter's root cause (2026-08-19, instrumented
        // on the S10e): with cards of many heights, the virtualizer's
        // window edge can land on a card whose ESTIMATED height differs
        // from its measured one — content height then flip-flops by that
        // difference on every layout pass (a measured 103 px lock-in,
        // hours if left alone), each flip feeding back through the
        // scroll offset into the next window computation. Anchoring the
        // first visible item breaks the feedback: a re-measure above the
        // viewport adjusts the offset instead of moving the content
        // under it. Reproduced deterministically (bottom of a pending
        // filter + a fling into the clamp + a mid-momentum switch) and
        // gone under the same script with this prop.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollToIndexFailed={(info) => {
          // The anchor sits past the render window: land on the estimate,
          // then re-issue the exact jump once — after measurement it
          // succeeds; if it somehow fails again, the estimate stands
          // rather than looping. The retry is generation-scoped and
          // bounds-checked (codex r6): a filter switch, a data reset, or
          // the reader's own drag in the 150 ms window disowns it.
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          if (retriedJumpRef.current) return;
          retriedJumpRef.current = true;
          const owner = jumpGenRef.current;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (owner !== jumpGenRef.current || movedSinceJumpRef.current) return;
            if (info.index >= dataLenRef.current) return;
            listRef.current?.scrollToIndex({
              index: info.index,
              animated: false,
              viewPosition: 0,
              viewOffset: jumpViewOffsetRef.current,
            });
          }, 150);
        }}
        onScroll={(e) => {
          scrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={33}
        // A finger-drag is the one signal that the reader took a NEW
        // position in this filter; programmatic jumps never fire it.
        onScrollBeginDrag={() => {
          movedSinceJumpRef.current = true;
        }}
        CellRendererComponent={TrackedCell}
        keyExtractor={(unit) =>
          unit.kind === 'group'
            ? `g:${unit.group.groupId}`
            : filter === 'everything'
              ? // Browse runs page in with stable full ranges per load
                // generation; the pending key shape (day:to) relies on
                // pending-only runs shrinking from the bottom.
                `r:${unit.day}:${unit.from}:${unit.to}`
              : `r:${unit.day}:${unit.to}`
        }
        renderItem={renderUnit}
        contentContainerStyle={styles.list}
        extraData={version}
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (filter === 'everything' && !browse.exhausted && !browse.failed)
            void loadMoreBrowse(genRef.current);
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {filter === 'everything'
              ? browse.failed
                ? 'Could not read your history just now — leave and reopen to retry.'
                : browse.exhausted
                  ? 'No photos yet.'
                  : 'Loading…'
              : 'Nothing left to review.'}
          </Text>
        }
        ListFooterComponent={
          filter === 'everything' && browse.failed && data.length > 0 ? (
            <Text style={styles.emptyText}>
              Could not read all of your history just now — leave and reopen to retry.
            </Text>
          ) : pendingTruncated && data.length > 0 ? (
            <Text style={styles.emptyText}>
              Showing the newest {shownPending.toLocaleString()} of {total.toLocaleString()} to
              review — more pages in as you review, or switch to Everything to browse it all.
            </Text>
          ) : null
        }
      />
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
  list: { gap: 12, paddingBottom: 12 },
  // Wrapping cluster inside the thumbnail — every badge stays visible.
  badges: { position: 'absolute', right: 2, bottom: 2, left: 2 },
  footer: { paddingTop: 8, gap: 8 },
});
