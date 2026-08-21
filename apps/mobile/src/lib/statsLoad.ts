/**
 * Stats data loading — the impure partner of the pure `stats.ts`.
 *
 * This module owns the ONE query set behind every stats surface: the
 * Stats page and the post-cull Summary both call `loadDecisionStats`,
 * so their shared numbers (today's decisions, all-time totals, goal
 * streaks) cannot drift apart. `loadLibraryStats` adds the corpus-wide
 * picture only the Stats page renders — it costs a MediaStore count and
 * per-file size stats, so the Summary deliberately does not pay it.
 *
 * THE SCOPING CONTRACT (vetted 2026-08-21), split by what a stat is
 * ABOUT. Two different questions, two different answers:
 * - "what you DID" is unscoped on both axes — achievement and habit
 *   stats: the goal ring, streaks, records, the activity chart, today's
 *   tiles, rhythm, sittings, decisiveness, the decision-pace stamps,
 *   the History feed, and the all-time totals. Neither an unmounted
 *   card nor a narrowed folder selection can rewrite the record of work
 *   you actually finished. (All-time also belongs here by its own
 *   nature: it counts trashed photos that live in no folder any more.)
 * - "the library in front of you" obeys the selection — the corpus
 *   breakdown, coverage, the forecast's base rates, decision floor and
 *   remaining pool, the backlog frontier, the forecast/finish-line
 *   pace maps, and the intake chart (BOTH its series, gap 6: a
 *   comparison must describe one population).
 * The contract's home is docs/STATS_ACCURACY.md; STATE_MODEL's two-axis
 * section states the achievement half.
 *
 * ONE LOADER PER STATS TAB (m0.8.2): `loadDecisionStats` for Activity,
 * `loadForecastStats` for Forecast, `loadHabitStats` for Habits. They are
 * separate because their COSTS are separate — the forecast's base rates
 * are an NTILE pass over every decision ever made, and no other tab
 * should wait for it. Each is called only when its tab is opened.
 *
 * FAIL-CLOSED contract, matching Home and Progress: an unavailable
 * MediaStore count THROWS out of `loadLibraryStats` (callers keep the
 * previously rendered numbers) rather than presenting an
 * authoritative-looking zero, and the caller resolves photo sources
 * before calling — a resolution failure must never silently broaden a
 * narrowed source.
 *
 * COVERAGE IS SOURCE-SCOPED OR ABSENT (m0.8.2). `getCoverageByDay` takes
 * roots; Home passed them and this loader did not, so the Home "Keeping
 * up" card and the Stats coverage chart — the SAME goal — counted
 * different photo sets whenever a source filter was active. The fix is
 * not merely to pass roots here: `coverage` is now null unless sources
 * were supplied, so a future caller that forgets gets nothing rather
 * than something quietly wrong. Summary deliberately supplies none — it
 * renders no coverage at all, and it appears straight after a cull
 * confirmation, where a source-resolution failure must not be able to
 * break the screen.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  countStagedCulls,
  getCorpusStats,
  getCoverageByDay,
  getDayReviewSummary,
  getDecisionOutcomesSince,
  getDecisionRhythm,
  getDuelSummary,
  getForecastBaseRates,
  getLifetimeStats,
  getQueueTurnaround,
  getRecentDecisionStamps,
  getRemainingPoolSize,
  getReviewedCountsByDay,
  getSetting,
  getStagedCullBytes,
  getStateCountsInScope,
  type DuelSummary,
  type ForecastBaseRates,
  type LifetimeStats,
} from '../db/store';
import { countQueues, type ActionKind } from '../db/actions';
import { composeForecast, decisionDeltas, splitSittings, type ForecastView } from './forecast';
import {
  DECISIVENESS_WINDOW_DAYS,
  decisiveness,
  personalRecords,
  queueTurnaround,
  rhythmGrid,
  summariseSittings,
  type Decisiveness,
  type PersonalRecords,
  type RhythmGrid,
  type SittingSummary,
  type Turnaround,
} from './habits';
import { DAILY_GOAL_KEY, goalStreaks, parseDailyGoal, type GoalStreaks } from './dailyGoal';
import {
  COVERAGE_GOAL_KEY,
  coverageWindow,
  parseCoverageGoal,
  type CoverageGoal,
  type CoverageWindow,
} from './coverageGoal';
import { dayKey, rangeOfDayKey, recentDayKeys } from './dates';
import { mountedVolumeSet } from './mountedVolumes';
import type { SourceRoot } from './sources';
import { fileSizeOrNull } from './hash';
import { countPhotosInRange } from './media';
import { computeBreakdown, type StateBreakdown } from './progress';

/** Days of history the streak math (and the chart's source map) covers. */
export const STREAK_WINDOW_DAYS = 120;

export interface DecisionStats {
  /** Local day the numbers were computed for ("YYYY-MM-DD"). */
  day: string;
  /** Photos whose FIRST review stamp fell today, by current state. */
  today: { reviewed: number; kept: number; staged: number; trashed: number };
  lifetime: LifetimeStats;
  goal: number;
  streaks: GoalStreaks;
  /** Decision-day counts per local day — ALL TIME since m0.8.2 (F13
   * needs the personal best); the charts and streaks keep reading only
   * their own window's keys out of it. */
  reviewedByDay: Map<string, number>;
  /** The intake chart's decided series — reach+source scoped (gap 6). */
  intakeReviewedByDay: Map<string, number>;
  /** All-time bests (m0.8.2, F13): the Activity header's reference to
   * beat, computed over the same map. */
  records: PersonalRecords;
  /** The window's calendar keys, oldest FIRST, ending at `day`. */
  dayKeys: string[];
  /** The SECOND goal (m0.8.1 round 8) — 'off' hides its chart. */
  coverageGoal: CoverageGoal;
  /** Per-day cleared/not markers over the same keys the activity chart
   * plots, so the two charts line up column for column. NULL when the
   * caller supplied no sources: unscoped coverage would silently
   * disagree with every other corpus number on the page. */
  coverage: CoverageWindow | null;
}

/** The photo sources a scoped read must honour (resolved by the caller). */
export interface StatsSources {
  roots: readonly SourceRoot[] | null;
  albumIds: readonly string[] | null;
}

/** Today + all-time decision numbers (Stats page and Summary). */
export async function loadDecisionStats(
  db: SQLiteDatabase,
  sources: StatsSources | null = null,
  at: number = Date.now(),
): Promise<DecisionStats> {
  const today = dayKey(at);
  const newestFirst = recentDayKeys(STREAK_WINDOW_DAYS, new Date(at));
  // One mounted-set read per burst (m0.8.3 §5): coverage and pool
  // numbers exclude unreachable photos; decision HISTORY stays whole.
  const mounted = await mountedVolumeSet();
  const [
    rawGoal,
    rawCoverage,
    reviewedByDay,
    intakeReviewedByDay,
    lifetime,
    todaySummary,
    coverageRows,
  ] = await Promise.all([
    getSetting(db, DAILY_GOAL_KEY),
    getSetting(db, COVERAGE_GOAL_KEY),
    // UNBOUNDED since m0.8.2 (F13): the personal records need every
    // decision day, and the grouped read over all of them is one
    // indexed aggregate; windowed consumers keep reading their own
    // keys out of the map. UNSCOPED on both axes (vetted 2026-08-21):
    // achievement stats — ring, streaks, records, the activity chart —
    // describe what you DID, and neither an unmounted card nor a
    // narrowed folder selection can rewrite that.
    getReviewedCountsByDay(db, 0),
    // The INTAKE chart's decided series (m0.8.7, gap 6): reach+source
    // scoped like its captured partner — a comparison must describe
    // one population. Scoped decided reads exist ONLY for planning
    // (this one and the forecast pace maps); every achievement/habit
    // read is unscoped on both axes (STATE_MODEL).
    getReviewedCountsByDay(db, 0, sources?.roots ?? null, mounted),
    // All-time totals deliberately ignore the source (see the header).
    getLifetimeStats(db),
    // Decision-day summary: older photos reviewed today count too.
    // Unscoped like the ring it sits beside.
    getDayReviewSummary(db, today),
    // Capture-day coverage over the SAME window the charts plot, in the
    // SAME source scope as every other corpus number (m0.8.2 fix).
    sources === null
      ? Promise.resolve(null)
      : getCoverageByDay(db, newestFirst[newestFirst.length - 1] ?? today, sources.roots, mounted),
  ]);
  const goal = parseDailyGoal(rawGoal);
  const dayKeys = [...newestFirst].reverse();
  return {
    day: today,
    today: todaySummary,
    lifetime,
    goal,
    // Streak days are GOAL-REACHED days (gate 4 definition — the same
    // math as the Home ring).
    streaks: goalStreaks(reviewedByDay, dayKeys, goal),
    reviewedByDay,
    intakeReviewedByDay,
    records: personalRecords(reviewedByDay, goal),
    dayKeys,
    coverageGoal: parseCoverageGoal(rawCoverage),
    coverage: coverageRows === null ? null : coverageWindow(coverageRows, dayKeys),
  };
}

/**
 * The forecast's own inputs (m0.8.2): everything `lib/forecast.ts` needs
 * that the decision and library stats do not already carry.
 *
 * Deliberately separate from `loadDecisionStats`: Summary shares that
 * loader and must not pay for aggregates it never renders.
 */
export interface ForecastInputs {
  baseRates: ForecastBaseRates;
  /** Recent decision stamps, newest first, for the timing median. */
  stamps: number[];
  /** Mean size of the photos still to review — the pool a projected cull
   * would actually free. */
  pool: { sized: number; meanBytes: number };
}

export async function loadForecastInputs(
  db: SQLiteDatabase,
  sources: StatsSources,
  /** The caller's snapshot (codex m0.8.7 r3): a live mount change
   * between two reads would hand the forecast two different populations
   * — exactly the mix the r2 fix removed. Omit only when no outer
   * snapshot exists. */
  mountedSnapshot?: readonly string[] | null,
): Promise<ForecastInputs> {
  const mounted = mountedSnapshot !== undefined ? mountedSnapshot : await mountedVolumeSet();
  const [baseRates, stamps, pool] = await Promise.all([
    // Both axes (codex m0.8.7 r2): an ejected card's decisions leave the
    // floor and rates together with its remaining pool.
    getForecastBaseRates(db, sources.roots, mounted),
    // Pace is a HABIT fact (vetted 2026-08-21): your reviewing rhythm
    // does not change when you narrow the selection, and Habits'
    // sittings read the same unscoped stamps so the two can never
    // describe different sittings.
    getRecentDecisionStamps(db),
    getRemainingPoolSize(db, sources.roots, mounted),
  ]);
  return { baseRates, stamps, pool };
}

/**
 * Everything the Forecast tab renders, composed once (D5's contract: Home
 * and this tab must not answer the same question differently).
 *
 * It resolves its own `remaining` rather than borrowing the library
 * card's: the tabs load independently, and a forecast that silently
 * renders nothing because a different tab was never opened is worse than
 * one extra MediaStore count. The count FAILS CLOSED like every other —
 * a null total throws, so the caller keeps what is on screen.
 */
export interface ForecastStats {
  view: ForecastView;
  /** Lifetime decisions behind the projections (the basis line). */
  decisions: number;
  goal: number;
}

export async function loadForecastStats(
  db: SQLiteDatabase,
  sources: StatsSources,
  at: number = Date.now(),
): Promise<ForecastStats> {
  const today = dayKey(at);
  const newestFirst = recentDayKeys(STREAK_WINDOW_DAYS, new Date(at));
  const oldest = newestFirst[newestFirst.length - 1] ?? today;
  const sinceMs = rangeOfDayKey(oldest).startMs;
  const mounted = await mountedVolumeSet();
  const [rawGoal, reviewedByDay, inputs, coverageRows, corpus, total] = await Promise.all([
    getSetting(db, DAILY_GOAL_KEY),
    // The forecast's PACE map is a PLANNING input (codex m0.8.7 r2): it
    // must describe the same selected, mounted population as the intake,
    // backlog, floor and base rates beside it — the unscoped achievement
    // map belongs to the ring/streaks, not to an ETA over this library.
    getReviewedCountsByDay(db, sinceMs, sources.roots, mounted),
    loadForecastInputs(db, sources, mounted),
    // The SAME rows the coverage chart plots — so the intake behind the
    // ETA and the intake drawn on the Activity tab cannot disagree.
    getCoverageByDay(db, oldest, sources.roots, mounted),
    getCorpusStats(db, sources.roots, mounted),
    countPhotosInRange(0, Number.POSITIVE_INFINITY, sources.albumIds),
  ]);
  const capturedByDay = new Map<string, number>();
  for (const row of coverageRows) if (row.day !== null) capturedByDay.set(row.day, row.total);
  const dayKeys = [...newestFirst].reverse();
  const goal = parseDailyGoal(rawGoal);
  return {
    goal,
    decisions: inputs.baseRates.decisions,
    view: composeForecast({
      // Reconciles exactly with Home and Progress: MediaStore total minus
      // photos carrying a verdict, on every surface.
      remaining: Math.max(0, total - corpus.reviewed),
      reviewedByDay,
      capturedByDay,
      dayKeys,
      decisions: inputs.baseRates.decisions,
      firstDecisionDay:
        inputs.baseRates.firstDecidedAt === null ? null : dayKey(inputs.baseRates.firstDecidedAt),
      goal,
      stamps: inputs.stamps,
      chunks: inputs.baseRates.chunks,
      meanRemainingBytes: inputs.pool.meanBytes,
    }),
  };
}

/**
 * The Habits tab's query set: when you review, in what bursts, what
 * happens to the work you queue, and whether your standards are moving.
 *
 * Every number here is DESCRIPTIVE — nothing on this tab predicts, which
 * is why none of it carries the forecast's decision floor.
 */
export interface HabitStats {
  rhythm: RhythmGrid;
  sittings: SittingSummary;
  turnaround: Record<ActionKind, Turnaround>;
  decisiveness: Decisiveness;
  duels: DuelSummary;
  lifetime: LifetimeStats;
  /** All-time bests (m0.8.2, F13) — the Milestones card's streak line.
   * Computed here too (not shared with Activity's copy): one loader per
   * tab, so one tab's cost never lands on another's path. */
  records: PersonalRecords;
}

export async function loadHabitStats(
  db: SQLiteDatabase,
  /** For the queue turnarounds' WAITING half only — it mirrors the tab
   * badges, which live on both scope axes (codex m0.8.7 r1). Everything
   * else here is decision history and reads unscoped. */
  sources: StatsSources,
  at: number = Date.now(),
): Promise<HabitStats> {
  const sinceMs = at - DECISIVENESS_WINDOW_DAYS * 86_400_000;
  // Habit stats read decision history UNSCOPED on both axes (vetted
  // 2026-08-21): when you review, in what bursts, and how your standards
  // move are facts about YOU, not about the currently selected folders.
  const [cells, stamps, queues, duels, recent, baseRates, lifetime, rawGoal, reviewedByDay] =
    await Promise.all([
      getDecisionRhythm(db),
      getRecentDecisionStamps(db),
      getQueueTurnaround(db, await mountedVolumeSet(), sources.roots),
      getDuelSummary(db),
      getDecisionOutcomesSince(db, sinceMs),
      // Unscoped too: decisiveness compares the recent rate with the
      // all-time one, and both arms must count the same population.
      getForecastBaseRates(db, null),
      getLifetimeStats(db),
      getSetting(db, DAILY_GOAL_KEY),
      // Unbounded — the records need every decision day (F13).
      getReviewedCountsByDay(db, 0),
    ]);
  // The all-time cull rate rides on the base rates already computed for
  // the projections — one definition of "culled", two readers.
  const allTime = baseRates.chunks.reduce(
    (sum, chunk) => ({ decided: sum.decided + chunk.total, culled: sum.culled + chunk.culled }),
    { decided: 0, culled: 0 },
  );
  const turnaround = {} as Record<ActionKind, Turnaround>;
  for (const queue of queues) turnaround[queue.kind] = queueTurnaround(queue, at);
  return {
    rhythm: rhythmGrid(cells),
    // The SAME sitting boundary the time estimate uses, over the same
    // stamps: two stats describing different sittings would be a bug the
    // user could see. ONE recorded decision has no deltas but IS one
    // one-photo sitting — the splitter only sees deltas and cannot tell
    // one stamp from none (codex r4).
    sittings: summariseSittings(
      stamps.length === 1 ? [{ deltas: [] }] : splitSittings(decisionDeltas(stamps)),
    ),
    turnaround,
    decisiveness: decisiveness(recent, allTime),
    duels,
    lifetime,
    records: personalRecords(reviewedByDay, parseDailyGoal(rawGoal)),
  };
}

export interface LibraryStats {
  /** Whole-corpus state breakdown (MediaStore total + tracked rows). */
  breakdown: StateBreakdown;
  /** Photos already gone to system trash (a subset of `breakdown.done`). */
  trashed: number;
  /** EXACT bytes the staged culls would free (live stats, recorded size
   * only where a file can no longer be stat'ed — Home's contract). */
  reclaimableBytes: number;
  /** Work waiting in each durable queue. */
  queues: { cull: number; toEdit: number; favourite: number; share: number; organize: number };
}

/** Corpus-wide stats for the photo sources the review queue uses. */
export async function loadLibraryStats(
  db: SQLiteDatabase,
  sources: { roots: readonly SourceRoot[] | null; albumIds: readonly string[] | null },
): Promise<LibraryStats> {
  const mounted = await mountedVolumeSet();
  const [total, counts, corpus, cull, queues] = await Promise.all([
    // The same open-ended scope the "All photos" Progress page uses on
    // both sides, so Stats and Progress can never disagree: MediaStore
    // unbounded, and the DB by `taken_at` (NOT NULL — undated photos
    // carry the mtime fallback, so they count here too).
    countPhotosInRange(0, Number.POSITIVE_INFINITY, sources.albumIds),
    getStateCountsInScope(
      db,
      { startMs: 0, endMs: Number.POSITIVE_INFINITY },
      sources.roots,
      mounted,
    ),
    getCorpusStats(db, sources.roots, mounted),
    countStagedCulls(db, mounted, sources.roots),
    // v18: one grouped query instead of four bespoke count functions.
    // Both scope axes (m0.8.7, F18) — Stats' queue rows must equal the
    // tab badges and the screens they describe.
    countQueues(db, mounted, sources.roots),
  ]);
  const staged =
    cull > 0 ? await getStagedCullBytes(db, mounted, sources.roots) : { scanned: 0, unsized: [] };
  return {
    breakdown: computeBreakdown(total, counts),
    trashed: counts.trashed,
    // Scan-recorded sizes are summed in SQL; only rows the scan never
    // sized cost a (blocking) stat, bounded by the query's LIMIT.
    reclaimableBytes:
      staged.scanned + staged.unsized.reduce((sum, uri) => sum + (fileSizeOrNull(uri) ?? 0), 0),
    queues: {
      cull,
      toEdit: queues.edit,
      favourite: queues.favourite,
      share: queues.share,
      organize: queues.organize,
    },
  };
}
