/**
 * Shared progress page body (m0.4 stage 3): state summary (tappable
 * filters) + filtered photo grid + per-photo state editor sheet. Used by
 * the Day progress screen (one local day, plus a "Review this day" CTA)
 * and the library-wide Progress screen — same accounting, same
 * components.
 *
 * m0.8.2: callers pass ONE `target`, not a heading plus a DB scope plus
 * a MediaStore range. The old quartet had to be kept consistent by hand
 * at every call site (a day's label, its `{day}` scope and its ms range
 * are three views of one fact), and the library caller passed the whole
 * library in all three — the range was a parameter nothing varied.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import {
  computeBreakdown,
  reviewedOf,
  reviewedPct,
  type EffectiveState,
  type ProgressFilter,
  type StateBreakdown,
} from '../../lib/progress';
import {
  getBacklogFrontier,
  getBurstStats,
  getCaptureHistogram,
  getStateCountsInScope,
  getStorageBreakdown,
  scopeKeyOf,
  type BacklogFrontier,
  type BurstStats,
  type MonthBucket,
  type PhotoScope,
  type StorageBreakdown,
} from '../../db/store';
import {
  buildHistogram,
  frontierLine,
  HISTOGRAM_COLUMN_W,
  HISTOGRAM_PAD,
  HISTOGRAM_UNDATED_GAP,
  histogramScrollX,
  keepsPerGroup,
  rangeOfMonth,
  redundantFrames,
  type Histogram,
} from '../../lib/libraryInsights';
import { formatBytes } from '../../lib/format';
import { labelForDayKey, rangeOfDayKey, UNDATED_DAY_KEY } from '../../lib/dates';
import { countPhotosInRange } from '../../lib/media';
import { resolveSources } from '../../lib/sourceCatalog';
import { mountedVolumeSet, sameVolumeSet } from '../../lib/mountedVolumes';
import { subscribeScanStatus } from '../../scan/scanRunner';
import type { SourceRoot } from '../../lib/sources';
import { StateProgressBar } from '../StateProgressBar';
import { colors, touch, useTheme } from '../../theme';
import {
  ACTION_META,
  ACTION_ORDER,
  actionFilterOf,
  filterLabel,
  VERDICT_META,
  VERDICT_ORDER,
} from './stateMeta';
import { PhotoStateGrid, type GridPhoto } from './PhotoStateGrid';
import { useExternalRefresh } from '../useExternalRefresh';
import { perfLog } from '../../lib/perfLog';
import { PhotoViewer, type ViewerItem } from '../PhotoViewer';

interface ResolvedSrc {
  roots: SourceRoot[] | null;
  albumIds: string[] | null;
}

function countOf(b: StateBreakdown, state: EffectiveState): number {
  switch (state) {
    case 'unreviewed':
      return b.unreviewed;
    case 'kept':
      return b.kept;
    case 'staged':
      return b.staged;
  }
}

/**
 * What this page is looking at (m0.8.2). One discriminated target
 * replaces the old heading + scope + startMs + endMs quartet: those four
 * had to be kept mutually consistent by every caller, and the global one
 * always passed the whole library anyway.
 */
export type ProgressTarget = { kind: 'library' } | { kind: 'day'; day: string };

/** The three one-line insights under the histogram, already worded.
 * Each is null when there is nothing true to say. */
interface LibraryInsightLines {
  histogram: Histogram;
  frontier: string | null;
  storage: string | null;
  burst: string | null;
}

/** "Nov 2024" for a "YYYY-MM" key; the undated bucket names itself. */
function monthTitle(key: string): string {
  if (key === UNDATED_DAY_KEY) return 'Undated';
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function buildInsightLines(
  buckets: MonthBucket[],
  frontier: BacklogFrontier,
  storage: StorageBreakdown,
  burst: BurstStats,
): LibraryInsightLines {
  const libraryBytes = storage.bytes.kept + storage.bytes.staged + storage.bytes.unreviewed;
  const keeps = keepsPerGroup(burst);
  const redundant = redundantFrames(burst);
  return {
    histogram: buildHistogram(buckets),
    frontier: frontierLine(frontier, monthTitle),
    storage:
      libraryBytes === 0
        ? null
        : // "your library", never "these photos": these lines stay
          // library-wide while the chips and grid above them narrow to a
          // selected month, and a demonstrative would claim otherwise.
          `${formatBytes(libraryBytes)} across your library` +
          (storage.bytes.staged > 0
            ? ` · ${formatBytes(storage.bytes.staged)} staged to free`
            : '') +
          // Sizes land with the scan, so an in-progress library would
          // otherwise present a partial total as the whole truth.
          (storage.unsized > 0 ? ` · ${storage.unsized} not yet sized` : ''),
    burst:
      burst.groups === 0
        ? null
        : `${redundant.toLocaleString()} near-duplicate frame${redundant === 1 ? '' : 's'} in ` +
          `${burst.groups.toLocaleString()} group${burst.groups === 1 ? '' : 's'}` +
          (keeps === null ? '' : ` · you keep 1 of ${keeps.toFixed(1)}`),
  };
}

/**
 * Months across the library, each bar shaded by how much of that month
 * is reviewed. Tapping one filters the grid; tapping it again clears.
 */
function CaptureHistogram({
  histogram,
  selected,
  accent,
  onSelect,
}: {
  histogram: Histogram;
  selected: string | null;
  accent: string;
  onSelect: (key: string) => void;
}) {
  const scroller = useRef<ScrollView>(null);
  // The auto-scroll rule (F8, m0.8.6): with no selection, open at the
  // RECENT end once — newest photos are where review happens, and
  // re-scrolling later would fight the user's own scrolling. With a
  // selection, scroll the MINIMUM keeping the selected bar visible —
  // a tap on an on-screen bar moves nothing (the bar was under the
  // finger), while a remount that reset the ScrollView to offset 0
  // brings the selection back into view instead of stranding it
  // off-screen right (the reported defect: the old guard suppressed
  // every scroll while a month was selected, reload included).
  const openedAtRecent = useRef(false);
  const offsetX = useRef(0);
  const viewportW = useRef(0);
  const [contentW, setContentW] = useState(0);
  useEffect(() => {
    if (selected === null || contentW === 0 || viewportW.current === 0) return;
    const index = histogram.bars.findIndex((bar) => bar.key === selected);
    if (index < 0) return;
    const x = histogramScrollX(
      index,
      offsetX.current,
      viewportW.current,
      contentW,
      histogram.bars[0]?.undated === true,
    );
    if (x !== null) {
      scroller.current?.scrollTo({ x, animated: false });
      // Programmatic non-animated scrolls do not reliably emit onScroll
      // on Android, so the tracked offset must be advanced by hand —
      // stale at 0 after the open-at-recent scroll, EVERY visible-bar
      // tap read as off-screen-right and scrolled the chart under the
      // finger (device pass, 2026-08-19).
      offsetX.current = x;
    }
  }, [selected, contentW, histogram]);
  return (
    <View style={styles.histogramBlock}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.histogramContent}
        onLayout={(e) => {
          viewportW.current = e.nativeEvent.layout.width;
        }}
        onScroll={(e) => {
          offsetX.current = e.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(w) => {
          setContentW(w);
          if (openedAtRecent.current) return;
          openedAtRecent.current = true;
          if (selected === null) {
            scroller.current?.scrollToEnd({ animated: false });
            // Same by-hand offset advance as the selection scroll: the
            // programmatic jump emits no onScroll on Android.
            offsetX.current = Math.max(0, w - viewportW.current);
          }
        }}
      >
        {histogram.bars.map((bar) => {
          const active = selected === bar.key;
          return (
            <Pressable
              key={bar.key}
              // A gap after the undated bar keeps its tick clear of the
              // first month's and shows it standing outside the timeline.
              style={[styles.histogramColumn, bar.undated && styles.histogramUndated]}
              onPress={() => onSelect(bar.key)}
              accessibilityLabel={`${bar.label}: ${bar.reviewed} of ${bar.total} reviewed`}
            >
              {/* Selection is an OUTLINE around the column, never a fill
                  (docs/STATE_MODEL.md rule 4): filling the selected bar
                  with the accent overwrote the one thing the bar is for
                  — how much of that month is reviewed. */}
              <View style={[styles.histogramPlot, active && { borderColor: accent }]}>
                <View
                  style={[
                    styles.histogramBar,
                    {
                      // An EMPTY month draws nothing: a gap-filled month
                      // with a stub would claim photos it does not have.
                      height: bar.total === 0 ? 2 : `${Math.max(4, Math.round(bar.height * 100))}%`,
                      backgroundColor: bar.total === 0 ? colors.border : colors.surfaceRaised,
                    },
                  ]}
                >
                  {bar.total > 0 && (
                    <View
                      style={[
                        styles.histogramReviewed,
                        {
                          height: `${Math.round(bar.reviewedFraction * 100)}%`,
                          backgroundColor: colors.keep,
                        },
                      ]}
                    />
                  )}
                </View>
              </View>
              {/* Two rows: quarters on top so a 3-letter month has room,
                  years beneath their January. */}
              <Text style={[styles.histogramTick, active && { color: accent }]} numberOfLines={1}>
                {bar.monthTick ?? ''}
              </Text>
              <Text style={[styles.histogramYear, active && { color: accent }]} numberOfLines={1}>
                {bar.yearTick ?? ''}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Heading, DB scope and MediaStore range are all DERIVED from the
 * target, so they cannot disagree with each other. */
function resolveTarget(target: ProgressTarget): {
  heading: string;
  scope: PhotoScope;
  startMs: number;
  endMs: number;
} {
  if (target.kind === 'library') {
    // Open-ended on purpose: undated photos count too (media.ts bound
    // contract), which is what makes this the whole library.
    return {
      heading: 'All photos',
      scope: { startMs: 0, endMs: Number.POSITIVE_INFINITY },
      startMs: 0,
      endMs: Number.POSITIVE_INFINITY,
    };
  }
  // The Unknown-day pseudo-day has no calendar range; its tracked rows
  // are its population, so the ms range stays open-ended.
  if (target.day === UNDATED_DAY_KEY) {
    return {
      heading: labelForDayKey(UNDATED_DAY_KEY),
      scope: { day: target.day },
      startMs: 0,
      endMs: Number.POSITIVE_INFINITY,
    };
  }
  const range = rangeOfDayKey(target.day);
  return {
    heading: range.label,
    scope: { day: target.day },
    // INCLUSIVE range → EXCLUSIVE MediaStore query (see the month filter
    // below): widen by 1 ms so an exact-midnight photo stays counted.
    startMs: range.startMs > 0 ? range.startMs - 1 : 0,
    endMs: range.endMs + 1,
  };
}

export function ProgressView({
  target,
  renderCta,
}: {
  target: ProgressTarget;
  /** Optional CTA (Day progress: "Review this day"). */
  renderCta?: (breakdown: StateBreakdown) => React.ReactNode;
}) {
  const base = useMemo(() => resolveTarget(target), [target]);
  /** Month filter driven by the histogram ("YYYY-MM", or the undated
   * bucket key). Null = the whole target. */
  const [month, setMonth] = useState<string | null>(null);
  // A selected month narrows BOTH sides — the counts above and the grid
  // below — so the chips always describe the photos actually shown.
  const { heading, scope, startMs, endMs } = useMemo(() => {
    if (month === null) return base;
    if (month === UNDATED_DAY_KEY)
      return {
        heading: base.heading,
        scope: { day: UNDATED_DAY_KEY } as PhotoScope,
        startMs: 0,
        endMs: Number.POSITIVE_INFINITY,
      };
    const range = rangeOfMonth(month);
    return {
      heading: base.heading,
      // The DB side keys on the indexed `day` column (m0.8.6 change 6):
      // a taken_at range would sweep undated photos into whichever month
      // their mtimes land in — the S10e over-count of exactly its five
      // undated GIFs. The ms range below feeds only the MediaStore count.
      scope: { month } as PhotoScope,
      // INCLUSIVE bounds → EXCLUSIVE MediaStore query: countPhotosInRange
      // renders `DATE_TAKEN > start AND DATE_TAKEN < end` — a photo at
      // exactly midnight on the month boundary would vanish from the
      // denominator only. Widen by 1 ms, exactly as the scan's range
      // pager does.
      startMs: range.startMs > 0 ? range.startMs - 1 : 0,
      endMs: range.endMs + 1,
    };
  }, [base, month]);
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { accent } = useTheme();
  const [src, setSrc] = useState<ResolvedSrc | null>(null);
  // The last SUCCESSFULLY loaded counts, tagged with the scopeKey that
  // produced them. The render below keeps them on screen across a scope
  // change (a histogram-month tap) while the narrowed load runs — the
  // ~150 ms full-screen "Loading…" this used to show unmounted the whole
  // header, and the histogram remounting at offset 0 was the device-pass
  // flash-and-jar (the F8 effect then "rescued" the tapped bar to the
  // right edge of a chart that had secretly jumped to its start). The tag
  // exists for the FAILURE path: a load that dies for a DIFFERENT scope
  // clears this to null, so a failed narrow count reads as loading, never
  // as the old scope's numbers over the new grid forever.
  const [data, setData] = useState<{
    scopeKey: string;
    breakdown: StateBreakdown;
    trashed: number;
    /** Fresh shots MediaStore has but the scan has not ingested yet
     * (dated day scopes only; Tristan, grilling Q8): the day page's
     * counts/grid are pure-DB (D16), so during the short ingestion
     * window Home's day total runs ahead — this names the gap instead
     * of silently mismatching. 0 = hidden. */
    analyzing: number;
  } | null>(null);
  const [filter, setFilter] = useState<ProgressFilter>('all');
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  /** The counts loader's mounted snapshot, handed to the grid so the
   * chips and the population they label page ONE world (final cycle
   * O5). `undefined` until the first load; identity kept stable across
   * reloads that observed no change, so the grid only resets on a real
   * mount change. */
  const [gridMounted, setGridMounted] = useState<readonly string[] | null | undefined>(undefined);

  // A card can be swapped while the app is backgrounded, and returning to
  // an already-open Progress screen re-fires no navigation focus — the
  // counts and the grid would keep the pre-eject world indefinitely
  // (final cycle N4/O6). Foreground return bumps the same tick the state
  // editor uses, reloading counts and resetting the grid together.
  useExternalRefresh(() => setRefreshTick((t) => t + 1));
  // A pass completing under an open page re-reads too (grilling Q8):
  // the "still being analyzed" line must clear — and the fresh photos
  // appear — without a leave-and-return.
  useEffect(
    () =>
      subscribeScanStatus((status) => {
        if (status.phase === 'done') setRefreshTick((t) => t + 1);
      }),
    [],
  );

  const scopeKey = scopeKeyOf(scope);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      /** The fail-closed exits below keep whatever is shown — except when
       * what is shown belongs to a DIFFERENT scope than the one that just
       * failed: the keep-last render has no tag check, so a cross-scope
       * failure must clear to the loading presentation instead. */
      const failCrossScope = () => {
        setData((current) => (current !== null && current.scopeKey === scopeKey ? current : null));
      };
      (async () => {
        // Respect the photo-source folder filter (m0.3.1) on both sides.
        // FAIL CLOSED: a resolution failure keeps the previously rendered
        // scope (or stays loading before any success) — null's meaning is
        // "all folders", which would silently broaden a narrowed source.
        let sources: Awaited<ReturnType<typeof resolveSources>>;
        try {
          sources = await resolveSources(db);
        } catch (error) {
          console.warn('[progress] source resolution failed — scope kept:', String(error));
          failCrossScope();
          return;
        }
        const roots = sources.roots ?? null;
        const albumIds = sources.albumIds ?? null;
        // EVERY day scope takes its denominator from the DB (m0.8.3,
        // D16 + codex phase-3): the grid and chips page SQLite for day
        // scopes, and a D15-rescued photo exists there but not in any
        // MediaStore DATE_TAKEN range — a MediaStore denominator could
        // read 0 under a grid showing a photo. `tracked - trashed` is
        // exactly the alive DB day population. Library RANGE scopes keep
        // the MediaStore total (untracked photos have no DB row yet).
        const dayScope = 'day' in scope;
        const monthScope = 'month' in scope;
        // FAIL CLOSED (m0.8.2): a failed MediaStore count used to become
        // 0, and `computeBreakdown` would then happily report "10 of 0
        // reviewed" at some impossible percentage. A count we could not
        // take is not a count of zero — keep whatever is on screen and
        // let the next focus try again.
        const mounted = await mountedVolumeSet();
        // A dated day ALSO takes a non-authoritative MediaStore count —
        // not as a denominator (D16 keeps that pure-DB) but to name the
        // not-yet-ingested gap ("N still being analyzed", grilling Q8).
        // Null on failure = no claim, no line.
        const datedDay = 'day' in scope && scope.day !== UNDATED_DAY_KEY;
        const countsStarted = Date.now();
        let msTotal: number | null;
        let counts: Awaited<ReturnType<typeof getStateCountsInScope>>;
        try {
          [msTotal, counts] = await Promise.all([
            dayScope && !datedDay
              ? null
              : countPhotosInRange(startMs, endMs, albumIds).catch((error): null => {
                  console.warn('[progress] corpus count failed — numbers kept:', String(error));
                  return null;
                }),
            getStateCountsInScope(db, scope, roots, mounted).then((result) => {
              // The LEFT JOIN rewrite's field measurement (m0.8.6 — the
              // correlated EXISTS measured 22 ms whole-corpus in m0.8.1).
              perfLog(() => `progress counts (${scopeKey}): ${Date.now() - countsStarted}ms`);
              return result;
            }),
          ]);
        } catch (error) {
          console.warn('[progress] state counts failed — numbers kept:', String(error));
          failCrossScope();
          return;
        }
        const dbAlive = counts.tracked - counts.trashed;
        // EVERY DB-paged scope — days AND months (D16 + m0.8.6 change 1)
        // — takes its denominator from the DB (codex r2): the month grid
        // pages SQLite exclusively, so a MediaStore-based total would
        // advertise photos the grid cannot render while a scan is still
        // ingesting, breaking the chip-population contract ("one month,
        // one number"). The ingestion gap gets the day scopes' honest
        // "still being analyzed" line instead. Only the open-ended
        // library scope keeps the MediaStore total (instant visibility
        // for photos the scan has not ingested yet — its grid pages
        // MediaStore too).
        const total = dayScope || monthScope ? dbAlive : msTotal;
        if (cancelled) return;
        if (total === null) {
          failCrossScope();
          return;
        }
        // MediaStore sees dated photos (ingested or not) but never
        // rescued ones; the DB's dated-ingested population is therefore
        // alive − rescued. Anything MediaStore has beyond that is still
        // on its way through the scan. Months share the formula: their
        // bounded MediaStore count is equally blind to rescued rows.
        const analyzing =
          (datedDay || monthScope) && msTotal !== null
            ? Math.max(0, msTotal - (dbAlive - counts.rescued))
            : 0;
        setGridMounted((prev) =>
          prev !== undefined && sameVolumeSet(prev, mounted) ? prev : mounted,
        );
        setSrc({ roots, albumIds });
        setData({
          scopeKey,
          breakdown: computeBreakdown(total, counts),
          trashed: counts.trashed,
          analyzing,
        });
      })();
      return () => {
        cancelled = true;
      };
      // scopeKey stands in for the scope object's identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, scopeKey, startMs, endMs, refreshTick]),
  );

  /**
   * The library insights (m0.8.2), loaded once per focus for the library
   * target only — a single day has no months to plot, no frontier to
   * report, and its storage share is noise.
   *
   * Deliberately NOT re-run per month selection: these describe the whole
   * library, and recomputing them for a filtered month would answer a
   * different question than the one the lines ask.
   */
  const [insights, setInsights] = useState<LibraryInsightLines | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (target.kind !== 'library') return;
      let cancelled = false;
      void (async () => {
        try {
          const roots = (await resolveSources(db)).roots ?? null;
          const mounted = await mountedVolumeSet();
          const [buckets, frontier, storage, burst] = await Promise.all([
            getCaptureHistogram(db, roots, mounted),
            getBacklogFrontier(db, roots, mounted),
            getStorageBreakdown(db, roots, mounted),
            getBurstStats(db, roots, mounted),
          ]);
          if (cancelled) return;
          setInsights(buildInsightLines(buckets, frontier, storage, burst));
        } catch (error) {
          // Same fail-closed rule as the counts: keep whatever is shown
          // rather than drawing insights over an unscoped library.
          console.warn('[progress] insights unavailable — previous kept:', String(error));
        }
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, target.kind, refreshTick]),
  );

  const toggleFilter = useCallback((state: EffectiveState) => {
    setFilter((current) => (current === state ? 'all' : state));
  }, []);

  const onChanged = useCallback(() => setRefreshTick((t) => t + 1), []);

  const header = useMemo(() => {
    if (data === null) return <View />;
    const b = data.breakdown;
    const reviewed = reviewedOf(b);
    const pct = reviewedPct(b);
    return (
      <View style={styles.header}>
        {/* The library page's heading used to duplicate the navigation
            title ("Progress") one line above it; only a day needs naming
            (m0.8.2). */}
        {target.kind === 'day' && <Text style={styles.title}>{heading}</Text>}
        <Text style={styles.subtitle}>
          {b.total === 0
            ? 'No photos here.'
            : reviewed === b.total
              ? `All ${b.total} photos reviewed`
              : `${reviewed} of ${b.total} photos reviewed · ${pct}%`}
        </Text>

        {/* A COMPOSITION bar, not a progress bar — the chips below carry
            its colours so the two read as one control. Before m0.8.2 the
            "in groups" segment (unreviewed, merely grouped) filled the
            accent colour directly under a line saying 0% reviewed. */}
        <StateProgressBar
          height={14}
          total={b.total}
          segments={[
            { count: b.kept, color: colors.keep },
            { count: b.staged, color: colors.cull },
            // Unreviewed is the empty track: fill means DECIDED, so the
            // coloured share always equals the percentage above (rule 1).
          ]}
          // Grouping rides UNDER the bar on its own plane, spanning every
          // verdict, so an annotation can never read as a decision (rule 5).
          grouped={[
            { count: b.grouped.kept, of: b.kept },
            { count: b.grouped.staged, of: b.staged },
            { count: b.grouped.unreviewed, of: b.unreviewed },
          ]}
        />

        <View style={styles.chips}>
          {VERDICT_ORDER.map((state) => {
            const meta = VERDICT_META[state];
            const active = filter === state;
            return (
              <Pressable
                key={state}
                style={[styles.chip, active && [styles.chipActive, { borderColor: accent }]]}
                onPress={() => toggleFilter(state)}
                accessibilityLabel={`${meta.label}: ${countOf(b, state)}`}
              >
                <View style={[styles.chipSwatch, { backgroundColor: meta.color }]} />
                <Text style={styles.chipCount}>{countOf(b, state)}</Text>
                <Text style={styles.chipLabel} numberOfLines={2}>
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* Row 2: PENDING ACTIONS. A separate row because they are a
            separate layer — a photo can be kept AND queued to share, so
            these never replace a verdict (docs/STATE_MODEL.md). */}
        <View style={styles.chips}>
          {ACTION_ORDER.map((kind) => {
            const meta = ACTION_META[kind];
            const value = actionFilterOf(kind);
            const active = filter === value;
            return (
              <Pressable
                key={kind}
                style={[styles.chip, active && [styles.chipActive, { borderColor: accent }]]}
                onPress={() => setFilter((current) => (current === value ? 'all' : value))}
                accessibilityLabel={`${meta.label} queued: ${b.actions[kind]}`}
              >
                <View style={[styles.chipSwatch, { backgroundColor: meta.color }]} />
                <Text style={styles.chipCount}>{b.actions[kind]}</Text>
                <Text style={styles.chipLabel} numberOfLines={2}>
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.footnote}>Tap a state to filter · tap a photo to change it.</Text>
        {data.analyzing > 0 && (
          <Text style={styles.insightLine}>
            {data.analyzing === 1
              ? '1 photo still being analyzed — it joins these counts when the scan finishes'
              : `${data.analyzing} photos still being analyzed — they join these counts when the scan finishes`}
          </Text>
        )}

        {/* The histogram is NAVIGATION: tapping a month filters the grid
            below, so seeing where the backlog sits and going to work on
            it are the same control. A single day has no months to plot. */}
        {target.kind === 'library' && insights !== null && insights.histogram.bars.length > 0 && (
          <CaptureHistogram
            histogram={insights.histogram}
            selected={month}
            accent={accent}
            onSelect={(key) => setMonth((current) => (current === key ? null : key))}
          />
        )}

        {target.kind === 'library' && insights !== null && (
          <>
            {insights.frontier !== null && (
              <Text style={styles.insightLine}>{insights.frontier}</Text>
            )}
            {insights.storage !== null && (
              <Text style={styles.insightLine}>{insights.storage}</Text>
            )}
            {insights.burst !== null && <Text style={styles.insightLine}>{insights.burst}</Text>}
          </>
        )}

        {renderCta?.(b)}

        <View style={styles.gridLabelRow}>
          <Text style={styles.gridLabel}>
            {filter === 'all' ? 'Photos · all states' : `Photos · ${filterLabel(filter)}`}
            {filter === 'kept' && data.trashed > 0
              ? `  (${data.trashed} trashed — files gone, not shown)`
              : ''}
          </Text>
          {/* An explicit way out of a month filter. Tapping the bar again
              also clears it, but that means finding one 14 dp column
              again in a chart that may have scrolled — not a way out a
              user should have to hunt for. */}
          {month !== null && (
            <Pressable
              style={[styles.monthPill, { borderColor: accent }]}
              onPress={() => setMonth(null)}
              accessibilityLabel={`Clear the ${monthTitle(month)} filter`}
            >
              <Text style={[styles.monthPillText, { color: accent }]}>{monthTitle(month)} ✕</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }, [data, heading, filter, toggleFilter, renderCta, accent, insights, month, target.kind]);

  // First load only. A SCOPE change (a histogram-month tap) deliberately
  // does NOT pass through here: unmounting the grid unmounts the header
  // inside it, and the remounting histogram was the device-pass jar. The
  // previous counts stay up for the ~150 ms the narrowed load takes; the
  // grid resets itself on the same scopeKey and the two swap together.
  if (data === null || src === null) {
    return (
      <View style={[styles.loadingRoot]}>
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  return (
    <>
      <PhotoStateGrid
        scope={scope}
        startMs={startMs}
        endMs={endMs}
        roots={src.roots}
        albumIds={src.albumIds}
        filter={filter}
        refreshKey={refreshTick}
        mounted={gridMounted}
        header={header}
        bottomInset={insets.bottom}
        onPhotoPress={(_photo, siblings, index) =>
          setViewer({
            items: siblings.map((g) => ({ id: g.id, uri: g.uri, takenAt: g.takenAt, day: g.day })),
            index,
          })
        }
      />
      {viewer && (
        <PhotoViewer
          items={viewer.items}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loadingRoot: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { color: colors.textDim, fontSize: 15 },
  header: { paddingHorizontal: 2, paddingTop: 16, paddingBottom: 12, gap: 14 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 15, marginTop: -8 },
  // Five columns instead of five rows (m0.8.2): the same filters and
  // counts in ~130 px instead of ~790, which is what buys the histogram
  // and insight lines their space above the grid.
  chips: { flexDirection: 'row', gap: 6, marginTop: -4 },
  chip: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: touch.radius - 4,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    // Android's minimum touch target; the stacked content clears it
    // anyway, but a filter you cannot reliably hit is not a filter.
    minHeight: 48,
  },
  chipActive: { backgroundColor: colors.surfaceRaised },
  chipSwatch: { width: 12, height: 4, borderRadius: 2 },
  chipCount: { color: colors.text, fontSize: 17, fontWeight: '800' },
  chipLabel: { color: colors.textDim, fontSize: 10, textAlign: 'center', lineHeight: 13 },
  histogramBlock: { marginHorizontal: -2 },
  histogramContent: { alignItems: 'flex-end', paddingHorizontal: HISTOGRAM_PAD },
  // FIXED width per month, not flex: the chart scrolls instead of
  // compressing, so a 20-year library stays as readable as a 1-year one
  // and every bar is a reliable tap target (at flex width they were
  // ~4 dp wide and genuinely hard to hit). The widths live in
  // libraryInsights.ts because histogramScrollX derives bar positions
  // from them (F8) — style and math must move together.
  histogramColumn: { width: HISTOGRAM_COLUMN_W, height: 112, alignItems: 'center' },
  histogramUndated: { marginRight: HISTOGRAM_UNDATED_GAP },
  // The plot area is also the selection outline (rule 4). The border is
  // always present but transparent, so selecting a month cannot shift
  // the bar's width or the column's alignment.
  histogramPlot: {
    width: HISTOGRAM_COLUMN_W,
    height: 74,
    justifyContent: 'flex-end',
    paddingHorizontal: 1,
    paddingBottom: 1,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 4,
  },
  histogramBar: { width: '100%', borderRadius: 3, justifyContent: 'flex-end', overflow: 'hidden' },
  histogramReviewed: { width: '100%' },
  // Ticks are ABSOLUTE and wider than their column, centred on the bar:
  // a 3-letter month cannot fit inside 14 dp, and letting it affect
  // layout would either clip it or stretch every column to fit a label
  // that only one bar in three actually has.
  histogramTick: {
    position: 'absolute',
    top: 78,
    width: 42,
    left: -14,
    textAlign: 'center',
    color: colors.textDim,
    fontSize: 10,
  },
  histogramYear: {
    position: 'absolute',
    top: 94,
    width: 42,
    left: -14,
    textAlign: 'center',
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  insightLine: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginTop: -6 },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: -6 },
  gridLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
  },
  gridLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    flexShrink: 1,
  },
  monthPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  monthPillText: { fontSize: 12, fontWeight: '700' },
});
