/**
 * Stats — the whole-picture numbers page, reached from the Home title
 * row (left of History).
 *
 * THREE TABS, opening on Activity (m0.8.2 D14):
 * - Activity — today against the daily goal, the 30-day decision chart,
 *   the coverage goal, and intake vs review on the same day columns.
 * - Forecast — when the backlog ends, what is in it, what it costs in
 *   tapping. Every sentence comes from `lib/forecastCopy.ts`, refusals
 *   included, so a UI that would rather show something cannot.
 * - Habits — when you review, in what bursts, what happens to the work
 *   you queue, and whether your standards are moving.
 *
 * EACH TAB LOADS ITS OWN QUERY SET ON FIRST OPEN, so one tab's cost never
 * lands on another's path — the Forecast tab's base-rate pass is an NTILE
 * over every decision ever made, and Activity must not pay for it. A
 * review mutation (`review.version`) invalidates every loaded tab at once,
 * matching the refresh trigger the rest of the app uses.
 *
 * The library breakdown deliberately does NOT live here (D7): Progress
 * renders the same numbers from the same `computeBreakdown`, and two
 * screens showing one fact is how they drift apart.
 *
 * Live-corpus numbers respect the photo-source filter and FAIL CLOSED
 * (m0.3.1): a source-resolution or MediaStore failure keeps the last
 * rendered card rather than showing an authoritative-looking zero.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { useSQLiteContext } from 'expo-sqlite';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { goalProgress } from '../lib/dailyGoal';
import { labelForDayKey } from '../lib/dates';
import { formatBytes } from '../lib/format';
import { resolveSources } from '../lib/sourceCatalog';
import {
  activityWindow,
  intakeWindow,
  ACTIVITY_WINDOW_DAYS,
  type ActivityWindow,
  type IntakeWindow,
} from '../lib/stats';
import { lastCoverageDays, type CoverageWindow } from '../lib/coverageGoal';
import {
  forecastHeadline,
  goalLine,
  projectionBasis,
  projectionLine,
  timeLine,
} from '../lib/forecastCopy';
import type { ProjectedRange } from '../lib/forecast';
import { milestone, type RhythmGrid } from '../lib/habits';
import {
  decisivenessLine,
  milestoneLine,
  milestoneProgress,
  rhythmLine,
  sittingLine,
  turnaroundLine,
} from '../lib/habitsCopy';
import {
  loadDecisionStats,
  loadForecastStats,
  loadHabitStats,
  loadLibraryStats,
  type DecisionStats,
  type ForecastStats,
  type HabitStats,
  type LibraryStats,
  type StatsSources,
} from '../lib/statsLoad';
import { perfLog } from '../lib/perfLog';
import { GoalRing } from '../components/GoalRing';
import { useReview } from '../review/ReviewContext';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Stats'>;

/** Chart plot height (px); bars and the goal line scale into it. */
const PLOT_HEIGHT = 104;

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'forecast', label: 'Forecast' },
  { key: 'habits', label: 'Habits' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function StatsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const theme = useTheme();
  const review = useReview();
  const [permission] = MediaLibrary.usePermissions({ granularPermissions: ['photo'] });

  // D14: Activity is both the default and the leftmost tab, so returning
  // to the page lands where it left off in the reader's mental model.
  const [tab, setTab] = useState<TabKey>('activity');
  const [decisions, setDecisions] = useState<DecisionStats | null>(null);
  const [library, setLibrary] = useState<LibraryStats | null>(null);
  const [forecast, setForecast] = useState<ForecastStats | null>(null);
  const [habits, setHabits] = useState<HabitStats | null>(null);

  // A review mutation invalidates every loaded tab at once; each tab
  // re-loads only when it is the one on screen.
  const version = review.version;
  const [loadedAt, setLoadedAt] = useState<Record<TabKey, number>>({
    activity: -1,
    forecast: -1,
    habits: -1,
  });
  // Foreground return invalidates every loaded tab (final cycle P4): a
  // card swap moves mounted-scoped figures without bumping `version`
  // when the review queue itself did not change.
  useExternalRefresh(() => setLoadedAt({ activity: -1, forecast: -1, habits: -1 }));
  const markLoaded = useCallback((key: TabKey, at: number) => {
    setLoadedAt((prev) => (prev[key] === at ? prev : { ...prev, [key]: at }));
  }, []);

  /** Resolved sources, or null when they could not be resolved — never
   * silently unscoped (m0.3.1). */
  const sourcesOrNull = useCallback(async (): Promise<StatsSources | null> => {
    try {
      const resolved = await resolveSources(db);
      return { roots: resolved.roots ?? null, albumIds: resolved.albumIds ?? null };
    } catch (error) {
      console.warn('[stats] source resolution failed:', String(error));
      return null;
    }
  }, [db]);

  // ---- Activity: today, the 30-day chart, coverage, intake vs review.
  useFocusEffect(
    useCallback(() => {
      if (tab !== 'activity' || loadedAt.activity === version) return;
      let cancelled = false;
      const started = Date.now();
      void (async () => {
        try {
          // Null = resolution FAILED (a resolved all-folders selection is
          // a non-null StatsSources with null roots): loading anyway would
          // pass an all-folders scope and replace scoped stats with global
          // ones. Skip the load — prior contents (or the loading state)
          // stay, and the unmarked `loadedAt` lets a re-focus recover.
          const sources = await sourcesOrNull();
          if (sources === null) return;
          const stats = await loadDecisionStats(db, sources);
          if (cancelled) return;
          setDecisions(stats);
          markLoaded('activity', version);
          perfLog(() => `stats tab activity: ${Date.now() - started}ms`);
        } catch (error) {
          // Fail closed: keep whatever is on screen rather than blank it.
          console.warn('[stats] activity unavailable — previous kept:', String(error));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [db, tab, version, loadedAt.activity, sourcesOrNull, markLoaded]),
  );

  // ---- Forecast: the base-rate pass, only when the tab is opened.
  useFocusEffect(
    useCallback(() => {
      if (tab !== 'forecast' || !permission?.granted || loadedAt.forecast === version) return;
      let cancelled = false;
      const started = Date.now();
      void (async () => {
        try {
          const sources = await sourcesOrNull();
          if (sources === null) return;
          const stats = await loadForecastStats(db, sources);
          if (cancelled) return;
          setForecast(stats);
          markLoaded('forecast', version);
          perfLog(() => `stats tab forecast: ${Date.now() - started}ms`);
        } catch (error) {
          // Fail closed: keep whatever is on screen rather than render a
          // finish line over a count that never arrived.
          console.warn('[stats] forecast unavailable — previous kept:', String(error));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [db, tab, version, permission?.granted, loadedAt.forecast, sourcesOrNull, markLoaded]),
  );

  // ---- Habits: rhythm, sittings, queue turnaround, milestones.
  useFocusEffect(
    useCallback(() => {
      if (tab !== 'habits' || !permission?.granted || loadedAt.habits === version) return;
      let cancelled = false;
      const started = Date.now();
      void (async () => {
        try {
          const sources = await sourcesOrNull();
          if (sources === null) return;
          // Loaded INDEPENDENTLY: only the cull-list row needs a
          // MediaStore count, and letting that failure take the rhythm,
          // sittings and turnaround down with it would blank a tab whose
          // numbers all come from SQLite. The count still fails closed —
          // its row simply does not render.
          const [habitStats, libraryStats] = await Promise.all([
            loadHabitStats(db, sources),
            loadLibraryStats(db, sources).catch((error): null => {
              console.warn('[stats] library counts unavailable — cull row hidden:', String(error));
              return null;
            }),
          ]);
          if (cancelled) return;
          setHabits(habitStats);
          if (libraryStats !== null) setLibrary(libraryStats);
          markLoaded('habits', version);
          perfLog(() => `stats tab habits: ${Date.now() - started}ms`);
        } catch (error) {
          console.warn('[stats] habits unavailable — previous kept:', String(error));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [db, tab, version, permission?.granted, loadedAt.habits, sourcesOrNull, markLoaded]),
  );

  return (
    // The native header ("Stats", back arrow) owns the top inset.
    <View style={styles.root}>
      <View style={styles.tabBar}>
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <Pressable
              key={item.key}
              style={[styles.tab, active && { borderBottomColor: theme.accent }]}
              onPress={() => setTab(item.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabLabel, active && { color: theme.accent }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      >
        {tab === 'activity' && <ActivityTab decisions={decisions} accent={theme.accent} />}
        {tab === 'forecast' && (
          <ForecastTab
            forecast={forecast}
            granted={permission?.granted === true}
            accent={theme.accent}
          />
        )}
        {tab === 'habits' && (
          <HabitsTab
            habits={habits}
            library={library}
            granted={permission?.granted === true}
            accent={theme.accent}
            navigation={navigation}
          />
        )}
      </ScrollView>
    </View>
  );
}

// ------------------------------------------------------------- Activity

function ActivityTab({ decisions, accent }: { decisions: DecisionStats | null; accent: string }) {
  if (!decisions) return <Text style={styles.loading}>Loading stats…</Text>;

  const reviewedToday = decisions.reviewedByDay.get(decisions.day) ?? 0;
  const plottedDays = decisions.dayKeys.slice(-ACTIVITY_WINDOW_DAYS);
  const activity = activityWindow(decisions.reviewedByDay, plottedDays, decisions.goal);
  // The loader computes coverage over the full streak window; the chart
  // shows the same slice the activity chart plots, totals included. Null
  // means the sources could not be resolved — the chart is dropped rather
  // than drawn over an unscoped count (m0.8.2).
  const coverageChart =
    decisions.coverage === null ? null : lastCoverageDays(decisions.coverage, ACTIVITY_WINDOW_DAYS);
  const captured = new Map(
    (coverageChart?.markers ?? []).map((marker) => [marker.day, marker.total]),
  );
  const intake =
    coverageChart === null ? null : intakeWindow(captured, decisions.reviewedByDay, plottedDays);

  return (
    <>
      <View style={styles.card}>
        <View style={styles.todayRow}>
          <GoalRing
            size={116}
            strokeWidth={11}
            progress={goalProgress(reviewedToday, decisions.goal)}
            color={reviewedToday >= decisions.goal ? colors.keep : accent}
            centerTitle={`${reviewedToday}`}
            centerSubtitle={`of ${decisions.goal} today`}
          />
          <View style={styles.todayBody}>
            <Text style={styles.cardTitle}>
              {reviewedToday >= decisions.goal ? 'Daily goal reached 🎉' : 'Today'}
            </Text>
            <Text style={styles.cardText}>
              {reviewedToday === 0
                ? 'No photos decided yet today.'
                : `${reviewedToday} photo${reviewedToday === 1 ? '' : 's'} decided today` +
                  (reviewedToday >= decisions.goal
                    ? ''
                    : ` · ${decisions.goal - reviewedToday} to go`)}
            </Text>
            {decisions.streaks.current > 0 && (
              <Text style={styles.streakText}>
                🔥 {decisions.streaks.current}-day streak
                {decisions.records.longestStreak > decisions.streaks.current
                  ? ` · longest ${decisions.records.longestStreak}`
                  : ''}
              </Text>
            )}
            {/* The all-time reference to beat (m0.8.2, F13). */}
            {decisions.records.bestDay && decisions.records.bestDay.count > reviewedToday && (
              <Text style={styles.cardHint}>
                Personal best · {decisions.records.bestDay.count} in one day
              </Text>
            )}
            {decisions.records.bestDay &&
              decisions.records.bestDay.day === decisions.day &&
              reviewedToday >= decisions.records.bestDay.count && (
                <Text style={styles.cardHint}>New personal best — most ever in one day 🎉</Text>
              )}
          </View>
        </View>
        <View style={styles.tiles}>
          <Tile value={decisions.today.reviewed} label="reviewed today" />
          <Tile value={decisions.today.kept} label="keepers" />
          <Tile value={decisions.today.staged} label="staged to cull" />
          <Tile value={decisions.today.trashed} label="culled to trash" />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Last {ACTIVITY_WINDOW_DAYS} days</Text>
        <ActivityChart activity={activity} accent={accent} />
        <View style={styles.chartAxis}>
          <Text style={styles.axisLabel}>
            {labelForDayKey(activity.bars[0]?.day ?? decisions.day)}
          </Text>
          <Text style={styles.axisLabel}>Today</Text>
        </View>
        <Text style={styles.cardText}>
          {activity.total === 0
            ? `No decisions in the last ${ACTIVITY_WINDOW_DAYS} days.`
            : `${activity.total} decided · ${activity.activeDays} active day${
                activity.activeDays === 1 ? '' : 's'
              } · best day ${activity.best}`}
        </Text>
        <Text style={styles.cardHint}>
          {`Grey line: the ${decisions.goal}/day goal · ${activity.goalDays} day${
            activity.goalDays === 1 ? '' : 's'
          } reached it`}
        </Text>
      </View>

      {/* The SECOND goal's chart (m0.8.1 round 8): one marker per day —
          did that day's photos end up fully reviewed? Same keys as the
          activity chart above, so the columns line up. */}
      {decisions.coverageGoal !== 'off' && coverageChart !== null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Keeping up</Text>
          <CoverageChart coverage={coverageChart} accent={accent} />
          <View style={styles.chartAxis}>
            <Text style={styles.axisLabel}>
              {labelForDayKey(coverageChart.markers[0]?.day ?? decisions.day)}
            </Text>
            <Text style={styles.axisLabel}>Today</Text>
          </View>
          <Text style={styles.cardText}>
            {coverageChart.daysWithPhotos === 0
              ? `No photos captured in the last ${ACTIVITY_WINDOW_DAYS} days.`
              : // One family of words with Home's coverage streak (F1):
                // both count DAYS WITH PHOTOS, and both say so.
                `${coverageChart.clearedDays} of ${coverageChart.daysWithPhotos} day${
                  coverageChart.daysWithPhotos === 1 ? '' : 's'
                } with photos fully reviewed` +
                (coverageChart.pending > 0 ? ` · ${coverageChart.pending} left over` : '')}
          </Text>
          <Text style={styles.cardText}>
            One block per day it was taken: green is reviewed, the rest is still to review.
          </Text>
        </View>
      )}

      {intake !== null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Shooting vs reviewing</Text>
          <IntakeChart intake={intake} />
          <View style={styles.chartAxis}>
            <Text style={styles.axisLabel}>
              {labelForDayKey(intake.pairs[0]?.day ?? decisions.day)}
            </Text>
            <Text style={styles.axisLabel}>Today</Text>
          </View>
          <Text style={styles.cardText}>
            {`${intake.captured.toLocaleString()} shot · ${intake.reviewed.toLocaleString()} decided` +
              (intake.net === 0
                ? ' — dead even over this window'
                : intake.net > 0
                  ? ` — ${intake.net.toLocaleString()} ahead over this window`
                  : ` — ${Math.abs(intake.net).toLocaleString()} behind over this window`)}
          </Text>
          <View style={styles.legend}>
            <Legend color={colors.text} label="Photos shot that day" value={intake.captured} />
            <Legend color={colors.keep} label="Photos decided that day" value={intake.reviewed} />
          </View>
        </View>
      )}
    </>
  );
}

// ------------------------------------------------------------- Forecast

function ForecastTab({
  forecast,
  granted,
  accent,
}: {
  forecast: ForecastStats | null;
  granted: boolean;
  accent: string;
}) {
  if (!granted) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Forecast</Text>
        <Text style={styles.cardText}>
          Photo access is off, so the size of what is left is unknown. Grant it on Home to see the
          forecast.
        </Text>
      </View>
    );
  }
  if (!forecast) return <Text style={styles.loading}>Working out where this ends…</Text>;

  const { view } = forecast;
  const at = Date.now();
  const second = goalLine(view.finish, forecast.goal, at);
  const time = timeLine(view);
  const insufficient = view.finish.kind === 'insufficient_history';

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Finish line</Text>
        {insufficient ? (
          <>
            <Text style={styles.headline}>Not enough history yet</Text>
            <Text style={styles.cardText}>
              {`A finish line needs a pace, and a pace needs decisions. ` +
                `${view.finish.kind === 'insufficient_history' ? view.finish.decisions.toLocaleString() : 0} so far — ` +
                `keep reviewing and this fills in.`}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.headline}>{forecastHeadline(view.finish, at)}</Text>
            {second !== null && <Text style={styles.cardText}>{second}</Text>}
            {view.finish.kind === 'growing' && (
              <Text style={styles.cardHint}>
                {`You decide ~${Math.round(view.finish.pace)}/day and shoot ~${Math.round(
                  view.finish.intake,
                )}/day. No date is shown because at this pace there is not one.`}
              </Text>
            )}
            {view.finish.kind === 'finishing' && (
              <Text style={styles.cardHint}>
                {`~${Math.round(view.finish.pace)}/day decided against ~${Math.round(
                  view.finish.intake,
                )}/day shot — a net ${Math.round(view.finish.net)}/day off the backlog.`}
              </Text>
            )}
          </>
        )}
        {time !== null && <Text style={styles.timeLine}>{time}</Text>}
      </View>

      {view.projections !== null && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>What is probably in there</Text>
          <ProjectionRow
            color={colors.cull}
            icon="delete-outline"
            range={view.projections.culled}
            noun="culls"
            bytes={view.projections.reclaimableBytes}
          />
          <ProjectionRow
            color={colors.edit}
            icon="pencil-outline"
            range={view.projections.toEdit}
            noun="to edit"
          />
          <ProjectionRow
            color={colors.fav}
            icon="heart-outline"
            range={view.projections.favourited}
            noun="favourites"
          />
          <ProjectionRow
            color={colors.share}
            icon="share-variant-outline"
            range={view.projections.shared}
            noun="shares"
          />
          <ProjectionRow
            color={colors.organize}
            icon="folder-move-outline"
            range={view.projections.organized}
            noun="album moves"
          />
          <Text style={styles.cardHint}>
            {`${projectionBasis(forecast.decisions)} The range is the spread between your most and ` +
              `least aggressive stretches — a wide one means your standards moved.`}
          </Text>
        </View>
      )}

      {view.projections === null && !insufficient && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>What is probably in there</Text>
          <Text style={styles.cardText}>Nothing left to project — the backlog is empty.</Text>
        </View>
      )}

      {view.time.kind === 'unknown' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Time cost</Text>
          <Text style={styles.cardText}>
            {view.time.reason === 'too_few'
              ? 'Not enough consecutive decisions yet to time your reviewing.'
              : 'Your pace per photo is still moving too much to put a number on it.'}
          </Text>
          <Text style={[styles.cardHint, { color: accent }]}>
            This appears once two halves of your history agree within a quarter.
          </Text>
        </View>
      )}
    </>
  );
}

/**
 * One projected outcome, or nothing at all when the projection is zero.
 *
 * A row reading "≈ 0 shares" is not a projection, it is a blank pretending
 * to be one — the honest rendering of "we expect none of these" is to say
 * nothing about them.
 */
function ProjectionRow({
  color,
  icon,
  range,
  noun,
  bytes,
}: {
  color: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  range: ProjectedRange;
  noun: string;
  bytes?: ProjectedRange;
}) {
  // A zero projection keeps its ROW and says why (m0.8.2): dropping it
  // left the card silently changing shape, and an absent row reads as a
  // bug rather than as "you have never done this".
  const empty = range.high <= 0;
  return (
    <View style={styles.projectionRow}>
      <MaterialCommunityIcons name={icon} size={20} color={empty ? colors.textDim : color} />
      <Text style={[styles.projectionText, empty && styles.projectionTextEmpty]}>
        {projectionLine(range.low, range.high, noun, bytes)}
      </Text>
    </View>
  );
}

// --------------------------------------------------------------- Habits

const QUEUE_META = [
  {
    kind: 'edit',
    icon: 'pencil-outline',
    color: colors.edit,
    label: 'Edit queue',
    noun: 'edits',
    route: 'EditQueue',
  },
  {
    kind: 'favourite',
    icon: 'heart-outline',
    color: colors.fav,
    label: 'Favourite queue',
    noun: 'favourites',
    route: 'FavouritesQueue',
  },
  {
    kind: 'organize',
    icon: 'folder-move-outline',
    color: colors.organize,
    label: 'Organize queue',
    noun: 'moves',
    route: 'OrganizeQueue',
  },
  {
    kind: 'share',
    icon: 'share-variant-outline',
    color: colors.share,
    label: 'Share queue',
    noun: 'shares',
    route: 'ShareQueue',
  },
] as const;

function HabitsTab({
  habits,
  library,
  granted,
  accent,
  navigation,
}: {
  habits: HabitStats | null;
  library: LibraryStats | null;
  granted: boolean;
  accent: string;
  navigation: Props['navigation'];
}) {
  if (!granted) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Habits</Text>
        <Text style={styles.cardText}>
          Photo access is off, so queue and library numbers are unavailable. Grant it on Home to see
          them.
        </Text>
      </View>
    );
  }
  if (!habits) return <Text style={styles.loading}>Reading your history…</Text>;

  const rhythm = rhythmLine(habits.rhythm);
  const sittings = sittingLine(habits.sittings);
  const trend = decisivenessLine(habits.decisiveness);
  const milestones = [
    milestone('photos reviewed', habits.lifetime.reviewed),
    milestone('culled', habits.lifetime.culled),
    milestone('edits completed', habits.lifetime.editsCompleted),
  ];

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Rhythm</Text>
        <RhythmHeatmap grid={habits.rhythm} />
        <Text style={styles.cardText}>
          {rhythm ?? 'Once you have reviewed a few hundred photos, your pattern shows up here.'}
        </Text>
        {sittings !== null && <Text style={styles.cardHint}>{sittings}</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Queues</Text>
        {library !== null && (
          <QueueRow
            icon="delete-outline"
            color={colors.cull}
            label="Cull list"
            hint={
              library.queues.cull === 0
                ? 'nothing queued'
                : library.reclaimableBytes > 0
                  ? `${library.queues.cull} staged · ~${formatBytes(library.reclaimableBytes)} reclaimable`
                  : `${library.queues.cull} staged to cull`
            }
            count={library.queues.cull}
            onPress={() => navigation.navigate('CullList', { fromHome: true })}
          />
        )}
        {QUEUE_META.map((meta) => (
          <QueueRow
            key={meta.kind}
            icon={meta.icon}
            color={meta.color}
            label={meta.label}
            // The row earns its place by carrying what the tab badge
            // cannot: not just how much is waiting, but what usually
            // happens to it (m0.8.1's no-duplicated-queue-rows rule).
            hint={turnaroundLine(habits.turnaround[meta.kind], meta.noun)}
            count={habits.turnaround[meta.kind].waiting}
            onPress={() => navigation.navigate('Main', { screen: meta.route })}
          />
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Decisiveness</Text>
        <Text style={styles.cardText}>
          {trend ?? 'Your culling rate appears here once you have a month of decisions behind you.'}
        </Text>
        {habits.duels.duels > 0 && (
          <Text style={styles.cardHint}>
            {`${habits.duels.duels.toLocaleString()} head-to-head compare${
              habits.duels.duels === 1 ? '' : 's'
            }` +
              // The percentage reads over DIALOG outcomes only: a triage
              // duel (3+ alive) decides nothing, and counting it as a
              // keep-both inflated the figure (v19).
              (habits.duels.verdictDuels > 0
                ? ` · you kept both ${Math.round(
                    (habits.duels.keptBoth / habits.duels.verdictDuels) * 100,
                  )}% of the time`
                : '')}
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.lifetimeTitleRow}>
          <MaterialCommunityIcons name="chart-box-outline" size={21} color={accent} />
          <Text style={styles.cardTitle}>Milestones</Text>
        </View>
        {milestones.map((item) => (
          <View key={item.label} style={styles.milestone}>
            <Text style={styles.milestoneLabel}>{milestoneLine(item)}</Text>
            <View style={styles.milestoneTrack}>
              <View
                style={[
                  styles.milestoneFill,
                  {
                    width: `${Math.round(milestoneProgress(item) * 100)}%`,
                    backgroundColor: accent,
                  },
                ]}
              />
            </View>
          </View>
        ))}
        {/* All-time personal records (m0.8.2, F13) — descriptive, like
            everything else on this tab; there is deliberately no
            days-since-goal guilt counter. */}
        {habits.records.longestStreak > 0 && (
          <Text style={styles.cardText}>
            Longest goal streak · {habits.records.longestStreak} day
            {habits.records.longestStreak === 1 ? '' : 's'}
            {habits.records.bestDay
              ? ` · most in one day · ${habits.records.bestDay.count.toLocaleString()}`
              : ''}
          </Text>
        )}
        <Text style={styles.cardHint}>
          {formatBytes(habits.lifetime.reclaimedBytes)} reclaimed all-time ·{' '}
          {habits.lifetime.favouritesApplied.toLocaleString()} favourites applied
        </Text>
      </View>
    </>
  );
}

/**
 * Weekday × hour heat grid. Cells shade by share of the busiest cell, so
 * the grid reads as a shape rather than as absolute counts — the question
 * is "when", not "how many".
 */
function RhythmHeatmap({ grid }: { grid: RhythmGrid }) {
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return (
    <View style={styles.heatmap}>
      {grid.cells.map((row, weekday) => (
        <View key={weekday} style={styles.heatRow}>
          <Text style={styles.heatDay}>{days[weekday]}</Text>
          {row.map((count, hour) => (
            <View
              key={hour}
              style={[
                styles.heatCell,
                count > 0 && {
                  // Keep-green, NOT the accent: heat is a quantity, and
                  // rule 3 reserves the user-chosen accent for
                  // interaction. Reviewing is the thing being counted,
                  // so it borrows reviewing's hue.
                  backgroundColor: colors.keep,
                  // A floor of 0.18 keeps a single decision visible; the
                  // alternative is a cell so faint it reads as empty.
                  opacity: grid.peak === 0 ? 0 : 0.18 + 0.82 * (count / grid.peak),
                },
              ]}
            />
          ))}
        </View>
      ))}
      <View style={styles.heatAxis}>
        <Text style={styles.axisLabel}>midnight</Text>
        <Text style={styles.axisLabel}>midday</Text>
        <Text style={styles.axisLabel}>11 pm</Text>
      </View>
    </View>
  );
}

// --------------------------------------------------------------- charts

/** Bar chart of daily decisions with the goal line across the plot. */
function ActivityChart({ activity, accent }: { activity: ActivityWindow; accent: string }) {
  return (
    <View style={[styles.plot, { height: PLOT_HEIGHT }]}>
      {activity.goalLine > 0 && (
        <View style={[styles.goalLine, { bottom: activity.goalLine * PLOT_HEIGHT }]} />
      )}
      <View style={styles.bars}>
        {activity.bars.map((bar) => (
          <View key={bar.day} style={styles.barColumn}>
            <View
              style={[
                styles.bar,
                {
                  // A zero day keeps a 2 px stub so the axis reads as a
                  // calendar, not as a chart that lost its days.
                  height: Math.max(2, Math.round(bar.height * PLOT_HEIGHT)),
                  backgroundColor:
                    bar.count === 0 ? colors.surfaceRaised : bar.goalReached ? colors.keep : accent,
                },
              ]}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Two series on one scale: photos shot that day against decisions made
 * that day. Fixed hues, not the accent — these are quantities that mean
 * something, and the accent is interaction only.
 */
function IntakeChart({ intake }: { intake: IntakeWindow }) {
  return (
    <View style={[styles.plot, { height: PLOT_HEIGHT }]}>
      <View style={styles.bars}>
        {intake.pairs.map((pair) => (
          <View key={pair.day} style={styles.pairColumn}>
            <View
              style={[
                styles.pairBar,
                {
                  height: Math.max(pair.captured > 0 ? 2 : 1, pair.capturedHeight * PLOT_HEIGHT),
                  // Photos ARRIVING are not an action you took, so this
                  // series takes no action hue (rule 2) and cannot take
                  // the user-chosen accent either — the other series is
                  // fixed keep-green, and a green accent would collapse
                  // the comparison. Near-white is the one strong colour
                  // that means nothing else.
                  backgroundColor: pair.captured > 0 ? colors.text : colors.surfaceRaised,
                },
              ]}
            />
            <View
              style={[
                styles.pairBar,
                {
                  height: Math.max(pair.reviewed > 0 ? 2 : 1, pair.reviewedHeight * PLOT_HEIGHT),
                  backgroundColor: pair.reviewed > 0 ? colors.keep : colors.surfaceRaised,
                },
              ]}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * One marker per day, on the SAME day columns as the activity chart above
 * so the two read as one timeline: a full-height block when the day is
 * cleared, a part-filled one showing how much of it is still unreviewed,
 * and a thin centred stub for a day nothing was shot.
 */
function CoverageChart({ coverage, accent }: { coverage: CoverageWindow; accent: string }) {
  return (
    <View style={styles.coverageRow}>
      {coverage.markers.map((marker) => {
        if (marker.empty) {
          return (
            <View key={marker.day} style={styles.coverageColumn}>
              <View style={styles.coverageEmpty} />
            </View>
          );
        }
        const doneFraction = (marker.total - marker.pending) / marker.total;
        return (
          <View key={marker.day} style={styles.coverageColumn}>
            <View style={[styles.coverageMarker, { backgroundColor: accent }]}>
              <View
                style={[
                  styles.coverageMarkerDone,
                  { backgroundColor: colors.keep, height: `${Math.round(doneFraction * 100)}%` },
                ]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ----------------------------------------------------------- primitives

function Tile({ value, label }: { value: number; label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, { color: theme.accent }]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{value.toLocaleString()}</Text>
    </View>
  );
}

function QueueRow({
  icon,
  color,
  label,
  hint,
  count,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  label: string;
  hint: string;
  count: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.queueRow} onPress={onPress}>
      <MaterialCommunityIcons name={icon} size={22} color={color} />
      <View style={styles.queueBody}>
        <Text style={styles.queueLabel}>{label}</Text>
        <Text style={styles.queueHint}>{hint}</Text>
      </View>
      <Text style={[styles.queueCount, count > 0 && { color }]}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    // The underline is always there, transparent until selected, so
    // switching tabs cannot shift the row by a pixel.
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: { color: colors.textDim, fontSize: 15, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 16 },
  loading: { color: colors.textDim, fontSize: 15, padding: 20 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 12,
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  cardText: { color: colors.textDim, fontSize: 15, lineHeight: 21 },
  cardHint: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  headline: { color: colors.text, fontSize: 20, fontWeight: '700', lineHeight: 27 },
  timeLine: { color: colors.text, fontSize: 15, fontWeight: '600' },
  todayRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  todayBody: { flex: 1, gap: 4 },
  streakText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: touch.radius,
    padding: 12,
    gap: 2,
  },
  tileValue: { fontSize: 24, fontWeight: '800' },
  tileLabel: { color: colors.textDim, fontSize: 12 },
  plot: { justifyContent: 'flex-end' },
  goalLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.border,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: '100%' },
  barColumn: { flex: 1, justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 2 },
  pairColumn: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  pairBar: { flex: 1, borderRadius: 1 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between' },
  coverageRow: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 30 },
  coverageColumn: { flex: 1, height: '100%', justifyContent: 'center' },
  coverageMarker: { width: '100%', height: '100%', borderRadius: 3, justifyContent: 'flex-end' },
  coverageMarkerDone: { width: '100%', borderRadius: 3 },
  coverageEmpty: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceRaised,
  },
  axisLabel: { color: colors.textDim, fontSize: 12 },
  heatmap: { gap: 3 },
  heatRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  heatDay: { color: colors.textDim, fontSize: 10, width: 12 },
  heatCell: { flex: 1, height: 12, borderRadius: 2, backgroundColor: colors.surfaceRaised },
  heatAxis: { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 14 },
  legend: { gap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  legendLabel: { color: colors.text, fontSize: 14, flex: 1 },
  legendValue: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  projectionRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  projectionText: { color: colors.text, fontSize: 15, flex: 1 },
  // An empty projection is a fact about your history, not a number —
  // it recedes rather than competing with the real ones.
  projectionTextEmpty: { color: colors.textDim },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  queueBody: { flex: 1 },
  queueLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  queueHint: { color: colors.textDim, fontSize: 12 },
  queueCount: { color: colors.textDim, fontSize: 18, fontWeight: '800' },
  lifetimeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  milestone: { gap: 6 },
  milestoneLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  milestoneTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  milestoneFill: { height: '100%', borderRadius: 3 },
});
