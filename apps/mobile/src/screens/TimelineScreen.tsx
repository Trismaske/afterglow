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
  appendBrowseItems,
  browseItemTime,
  EMPTY_BROWSE_ASSEMBLY,
  firstPendingUnit,
  flushBrowseTail,
  unitDestination,
  unreviewedOnly,
  type BrowseAssembly,
  type BrowseItem,
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
import { mountedVolumeSet } from '../lib/mountedVolumes';
import {
  parseTimelineFilter,
  TIMELINE_FILTER_KEY,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from '../lib/timelinePrefs';

type Props = NativeStackScreenProps<RootStackParamList, 'Timeline'>;

/** Items consumed from the merged stream per FlatList page. The stream
 * fetchers page beneath it (singles wider than groups — a sparse
 * stretch is mostly singles). */
const BROWSE_BATCH = 40;
const BROWSE_SINGLES_PAGE = 120;
const BROWSE_GROUPS_PAGE = 40;

type BrowseCursor = BrowseGroupCursor | { takenAt: number; assetId: string };

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
  const { timeline, queueCounts, version, actionWeights } = useReview();

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
  const setFilter = useCallback(
    (next: TimelineFilter) => {
      setFilterState(next);
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
  const loadingRef = useRef(false);
  const failedRef = useRef(false);

  const loadMoreBrowse = useCallback(async (gen: number) => {
    const pager = pagerRef.current;
    if (!pager || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const items = await pager.next(BROWSE_BATCH);
      if (gen !== genRef.current) return;
      setBrowse((prev) => ({
        assembly: appendBrowseItems(prev.assembly, items),
        exhausted: pager.exhausted(),
        failed: failedRef.current,
      }));
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const resetBrowse = useCallback(async () => {
    const gen = ++genRef.current;
    failedRef.current = false;
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
      ).catch((error: unknown) => {
        console.warn('[timeline] browse singles page failed:', String(error));
        failedRef.current = true;
        return [];
      });
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
      ).catch((error: unknown) => {
        console.warn('[timeline] browse groups page failed:', String(error));
        failedRef.current = true;
        return [];
      });
      const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
      return {
        items: rows.map((group) => ({ kind: 'group' as const, group })),
        nextCursor:
          rows.length < Math.max(count, BROWSE_GROUPS_PAGE) || last === undefined
            ? null
            : { anchor: last.members[0]?.taken_at ?? 0, groupId: last.groupId },
      };
    };
    // Singles at bucket 0: merged-pager ties go to the LOWER index,
    // matching buildTimeline's "ties break toward the single".
    pagerRef.current = createMergedDescendingPager<BrowseItem, BrowseCursor>(
      [singlesFetcher, groupsFetcher],
      browseItemTime,
    );
    void loadMoreBrowse(gen);
  }, [db, loadMoreBrowse]);

  // The Everything data resets whenever it is (re)selected or the
  // review version bumps — a browse surface refetches instead of
  // patching (D1). The version signal covers decisions made in decks
  // opened from this very list.
  const browseVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (filter !== 'everything') return;
    if (browseVersionRef.current === version) return;
    browseVersionRef.current = version;
    void resetBrowse();
  }, [filter, version, resetBrowse]);

  // ------------------------------------------------------------ data
  const data: readonly TimelineUnit[] = useMemo(() => {
    if (filter === 'everything') {
      return browse.exhausted ? flushBrowseTail(browse.assembly) : browse.assembly.units;
    }
    if (filter === 'unreviewed') return unreviewedOnly(timeline);
    return timeline;
  }, [filter, timeline, browse]);

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
        data={data}
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
          if (filter === 'everything' && !browse.exhausted) void loadMoreBrowse(genRef.current);
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
