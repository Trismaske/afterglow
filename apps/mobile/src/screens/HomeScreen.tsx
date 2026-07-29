import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainTabScreenProps } from '../navigation';
import {
  dayKey,
  labelForDayKey,
  recentDayKeys,
  rangeOfDayKey,
  UNDATED_DAY_KEY,
} from '../lib/dates';
import { DAILY_GOAL_KEY, goalProgress, goalStreaks, parseDailyGoal } from '../lib/dailyGoal';
import { finishLine, type FinishLine } from '../lib/forecast';
import { forecastHeadline } from '../lib/forecastCopy';
import {
  COVERAGE_GOAL_KEY,
  COVERAGE_GOAL_LABELS,
  coverageStatus,
  coverageWindowDays,
  parseCoverageGoal,
  type CoverageGoal,
  type CoverageStatus,
} from '../lib/coverageGoal';
import { countPhotosInRange } from '../lib/media';
import { resolveSources } from '../lib/sourceCatalog';
import {
  countStagedCulls,
  getCoverageByDay,
  getDecisionTotals,
  getStagedCullBytes,
  getCorpusStats,
  getDaySummariesForDays,
  getReviewedCountsByDay,
  getUnreviewedDayRows,
  type DaySummaryRow,
  getSetting,
  markEditDone,
  unstageCullDirect,
} from '../db/store';
import { runTrashAttempt } from '../lib/trashFlow';
import { formatBytes } from '../lib/format';
import { fileSize, fileSizeOrNull } from '../lib/hash';
import { runEditDetection, type DetectedCopy } from '../lib/detect';
import {
  getScanStatus,
  startContinuousScan,
  subscribeScanStatus,
  type ScanStatus,
} from '../scan/scanRunner';
import { Ghost } from '../components/Ghost';
import { GoalRing } from '../components/GoalRing';
import { unitDestination } from '../lib/timeline';
import { useReview } from '../review/ReviewContext';
import { BigButton } from '../components/BigButton';
import { StateProgressBar } from '../components/StateProgressBar';
import { colors, touch, useTheme } from '../theme';

type Props = MainTabScreenProps<'Home'>;

/** Gate 5 recent-days layout: 3 recent calendar days + the 2 most recent
 * OLDER days still holding unreviewed photos + an expandable older-days
 * indicator (capped — an all-days browse lives in Progress). */
const RECENT_CALENDAR_DAYS = 3;
const UNREVIEWED_DAY_ROWS = 2;
const OLDER_DAY_CAP = 60;

interface DayRow {
  day: string;
  label: string;
  /** All photos taken that day (MediaStore + trashed rows). */
  total: number;
  /** Carries a verdict: kept + trashed + staged (docs/STATE_MODEL.md). */
  reviewed: number;
  /** kept + trashed (both converged keepers). */
  kept: number;
  /** Photos with an edit QUEUED — a pending action, not a verdict, so it
   * appears in the hint line and never as a bar segment. */
  toEdit: number;
  staged: number;
}

export function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const theme = useTheme();
  const review = useReview();
  // Stable across queue refreshes — the detection focus effect must not
  // recreate (and cancel mid-run) every time a scan-driven refresh mints
  // a new context object.
  const reviewRefresh = review.refresh;
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo'],
  });

  const [scan, setScan] = useState(getScanStatus());
  const [goal, setGoal] = useState(50);
  /** The goal/streak/corpus loader has committed once — before that the
   * ring shows a placeholder, not a hardcoded "0 of 50" (F2). */
  const [goalLoaded, setGoalLoaded] = useState(false);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [streaks, setStreaks] = useState({ current: 0, longest: 0 });
  const [coverage, setCoverage] = useState<CoverageGoal>('off');
  const [coverageState, setCoverageStatus] = useState<CoverageStatus | null>(null);
  /** m0.8.2: the finish line, on the Progress row. Every input is already
   * on this screen's load path — pace from the streak counts, intake from
   * the coverage rows, remaining from the corpus stats — so the headline
   * costs no extra query. */
  const [finish, setFinish] = useState<FinishLine | null>(null);
  const [corpus, setCorpus] = useState<{
    total: number;
    groupsFound: number;
    reviewed: number;
  } | null>(null);
  const [stagedCullCount, setStagedCullCount] = useState(0);
  /** EXACT bytes the staged culls would free (vetted): a SUM over
   * scan-recorded sizes, plus transient per-file stats for rows the v14
   * scan has not sized yet. */
  const [reclaimableBytes, setReclaimableBytes] = useState(0);
  const [dayRows, setDayRows] = useState<DayRow[] | null>(null);
  /** Gate 5: older days that still hold unreviewed photos. */
  const [unreviewedDayRowsState, setUnreviewedDayRowsState] = useState<DayRow[]>([]);
  const [olderDays, setOlderDays] = useState<string[]>([]);
  const [olderRows, setOlderRows] = useState<DayRow[] | null>(null);
  const buildOlderRowsRef = useRef<((days: readonly string[]) => Promise<DayRow[]>) | null>(null);
  const [detectionNotice, setDetectionNotice] = useState<string | null>(null);
  /** Bumped after detection changes states, to re-run the focus loaders. */
  const [refreshTick, setRefreshTick] = useState(0);
  const lastDetectionRef = useRef(0);

  // m0.8 gate 2: kick the continuous scan once media permission is in.
  // Fire-and-forget — the runner is single-flight, per-photo persistent,
  // and reports through its own status store (gate 4 puts it on Home).
  // m0.8.1: kick AFTER the first queue read completes (review.loaded) — the
  // cold-start scan burst starved the first read for 20-30 s on a 27k
  // corpus, leaving Home on "Loading your queue…". The timer is the
  // fail-open: a skipped first refresh (source resolution down) must
  // never block scanning.
  const queueLoaded = review.loaded;
  useEffect(() => {
    if (!permission?.granted) return;
    if (queueLoaded) {
      void startContinuousScan(db);
      return;
    }
    const fallback = setTimeout(() => void startContinuousScan(db), 8000);
    return () => clearTimeout(fallback);
  }, [db, permission?.granted, queueLoaded]);

  // THROTTLED scan status (m0.8.1): the scan patches its status many
  // times per second; re-rendering the card per event burns work on a
  // counter nobody reads at that rate and starves accessibility idle
  // (uiautomator dumps — the UI gate — never complete on a never-idle
  // screen; its idle detector needs ≥500 ms of quiet). Phase changes
  // apply immediately; counters trail ≤ 1.5 s.
  useEffect(() => {
    let lastApplied = 0;
    let lastPhase = getScanStatus().phase;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ScanStatus | null = null;
    const apply = (status: ScanStatus) => {
      lastApplied = Date.now();
      lastPhase = status.phase;
      pending = null;
      setScan(status);
    };
    const unsubscribe = subscribeScanStatus((status) => {
      const elapsed = Date.now() - lastApplied;
      if (status.phase !== lastPhase || elapsed >= 1500) {
        apply(status);
        return;
      }
      pending = status;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) apply(pending);
        }, 1500 - elapsed);
      }
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Scan-driven refresh key, COARSENED: every 250 grouped windows and on
  // phase changes. Per-window refreshes (4,913 windows on a 27k corpus)
  // would issue thousands of redundant source resolutions, SQLite reads
  // and MediaStore counts while Home stays focused.
  // Derived from its OWN unthrottled subscription (m0.8.2, F4 rider):
  // reading the throttled `scan` state made even the coarse 250-window
  // boundary observed up to 1.5 s late. Same-value sets skip the
  // re-render, so this costs nothing between boundaries.
  const [scanRefreshKey, setScanRefreshKey] = useState(() => {
    const s = getScanStatus();
    return `${s.phase}:${Math.floor(s.windowsGrouped / 250)}`;
  });
  useEffect(
    () =>
      subscribeScanStatus((s) => {
        const key = `${s.phase}:${Math.floor(s.windowsGrouped / 250)}`;
        setScanRefreshKey((old) => (old === key ? old : key));
      }),
    [],
  );

  // Home regaining focus means the review stack unwound — release the
  // browsed-unit ids a deck installed for its overlay reads (loadGroup /
  // loadDeckSingles), so a stale group's ids stop riding every refresh
  // (m0.8.2 rider). Anchored HERE, not on deck unmount: a deck→deck
  // replace runs the new deck's load before the old deck's cleanup, and
  // an unmount-time clear would wipe the freshly installed ids.
  useFocusEffect(
    useCallback(() => {
      review.releaseBrowseIds();
    }, [review]),
  );

  // Daily goal + streaks + live corpus stats (gate 4): refresh on focus,
  // on review mutations, and as scan windows land.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const today = dayKey(Date.now());
        const since = recentDayKeys(120)[119] ?? today;
        // decided_at bound in epoch ms (see getReviewedCountsByDay).
        const sinceMs = rangeOfDayKey(since).startMs;
        // Corpus stats share the queue's source scope: the MediaStore
        // denominator and the verdict/group numerators must count the
        // same photos. FAIL CLOSED: a resolution error keeps the last
        // rendered stats instead of broadening to all folders.
        let src: { roots: string[] | null; albumIds: string[] | null } | null = null;
        if (permission?.granted) {
          try {
            const resolved = await resolveSources(db);
            src = { roots: resolved.roots ?? null, albumIds: resolved.albumIds ?? null };
          } catch (error) {
            console.warn('[home] source resolution failed — corpus stats skipped:', String(error));
          }
        }
        const [rawGoal, rawCoverage, reviewedByDay, totals, stats, total] = await Promise.all([
          getSetting(db, DAILY_GOAL_KEY),
          getSetting(db, COVERAGE_GOAL_KEY),
          // Source-scoped like everything else about the current library
          // (statsLoad.ts header). `src` is null only with no permission
          // or a failed resolution; the ring then counts everything,
          // which is what it did before scoping and is visible beside
          // the source label on this same screen.
          getReviewedCountsByDay(db, sinceMs, src?.roots ?? null),
          // m0.8.2: the forecast's decision floor and pace denominator —
          // one indexed aggregate, not the full base-rate pass.
          getDecisionTotals(db, src?.roots ?? null),
          permission?.granted && src ? getCorpusStats(db, src.roots) : null,
          // null = the MediaStore count FAILED — keep the last rendered
          // stats rather than presenting an authoritative-looking zero.
          permission?.granted && src
            ? countPhotosInRange(0, Number.POSITIVE_INFINITY, src.albumIds).catch((error): null => {
                console.warn('[home] corpus count failed — stats kept:', String(error));
                return null;
              })
            : 0,
        ]);
        if (cancelled) return;
        const currentGoal = parseDailyGoal(rawGoal);
        const keys = [...recentDayKeys(120)].reverse();
        // The second, independent goal (m0.8.1 round 8). One grouped
        // query over the same 120-day horizon as the count streaks: the
        // goal's window bounds the headline, but the clear streak reads
        // back across every key, and an unloaded day would masquerade as
        // a day with no photos. All time is unbounded.
        const coverageGoal = parseCoverageGoal(rawCoverage);
        // m0.8.2: the rows load whenever photo access allows, not only
        // when the coverage goal is on — they are also the forecast's
        // INTAKE, and a user with the goal off still deserves a finish
        // line. 'all time' alone needs the unbounded read.
        // `undefined` = KEEP what is on screen (the fail-closed cases).
        let nextCoverageStatus: CoverageStatus | null | undefined;
        let nextFinish: FinishLine | null | undefined;
        if (!permission?.granted) {
          nextCoverageStatus = null;
          nextFinish = null;
        } else if (src === null) {
          // FAIL CLOSED. `src` is null only because source resolution
          // FAILED (the catch above), and every read below is
          // corpus-scoped: passing `null` roots means ALL FOLDERS, which
          // would quietly replace a correctly narrowed coverage figure
          // and finish line with an unscoped one. Keep what is on screen.
          console.warn('[home] sources unresolved — coverage and forecast kept');
        } else {
          const sinceDay = coverageWindowDays(coverageGoal) === null ? null : keys[0];
          const rows = await getCoverageByDay(db, sinceDay, src.roots);
          if (cancelled) return;
          nextCoverageStatus =
            coverageGoal === 'off' ? null : coverageStatus(rows, coverageGoal, keys);
          // Remaining reconciles exactly with Progress's remainingReviewable:
          // both reduce to MediaStore total minus photos carrying a verdict.
          const remaining = stats && total !== null ? Math.max(0, total - stats.reviewed) : null;
          const captured = new Map<string, number>();
          for (const row of rows) if (row.day !== null) captured.set(row.day, row.total);
          nextFinish =
            remaining === null
              ? null
              : finishLine({
                  remaining,
                  reviewedByDay,
                  capturedByDay: captured,
                  dayKeys: keys,
                  decisions: totals.decisions,
                  firstDecisionDay:
                    totals.firstDecidedAt === null ? null : dayKey(totals.firstDecidedAt),
                  goal: currentGoal,
                });
        }
        // ONE commit (F2): every setter lands in the same task, so React
        // batches them into a single render — the ring number, streaks,
        // coverage card and corpus line stop arriving as separate
        // repaints. (This effect used to commit twice, split by the
        // coverage await above.)
        setGoal(currentGoal);
        setReviewedToday(reviewedByDay.get(today) ?? 0);
        setStreaks(goalStreaks(reviewedByDay, keys, currentGoal));
        setCoverage(coverageGoal);
        if (nextCoverageStatus !== undefined) setCoverageStatus(nextCoverageStatus);
        if (nextFinish !== undefined) setFinish(nextFinish);
        if (stats && total !== null)
          setCorpus({ total, groupsFound: stats.groupsFound, reviewed: stats.reviewed });
        setGoalLoaded(true);
      })();
      return () => {
        cancelled = true;
      };
      // review.version / scanRefreshKey / refreshTick are deliberate
      // refresh triggers, not values the loader reads.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, permission?.granted, review.version, scanRefreshKey, refreshTick]),
  );

  /** Keep-or-cull prompts for detected edited copies, one at a time. */
  const promptForCopies = useCallback(
    (copies: readonly DetectedCopy[]) => {
      const [head, ...rest] = copies;
      if (!head) {
        setRefreshTick((t) => t + 1);
        return;
      }
      const next = () => promptForCopies(rest);
      Alert.alert(
        'Edited copy detected',
        `“${head.copyFilename}” looks like an edited copy of “${head.originalFilename}”. ` +
          'The copy has joined your review queue. What about the original?',
        [
          { text: 'Decide later', style: 'cancel', onPress: next },
          {
            text: 'Cull original',
            style: 'destructive',
            onPress: () =>
              void (async () => {
                // (The original's edit is resolved inside the staging
                // transaction — prepareTrashBatch's stageToEditMembers —
                // because the guard there needs it still queued.)
                // The same durable trash lifecycle as staged culls (item
                // H): stage+reserve in ONE transaction → system dialog →
                // verify → C#7 cleanup — a crash anywhere leaves either
                // the untouched queued edit or a recoverable attempt
                // (whose photo lands visibly in the cull list, the
                // vetted fallback), never a stranded state.
                const photo = await db.getFirstAsync<{ uri: string }>(
                  'SELECT uri FROM photos WHERE asset_id = ?',
                  head.originalAssetId,
                );
                const attempt = await runTrashAttempt(
                  db,
                  [{ photoId: head.originalAssetId, measuredBytes: fileSize(photo?.uri ?? '') }],
                  { stageToEditMembers: true },
                );
                if (attempt.trashedIds.includes(head.originalAssetId)) {
                  // The verified removal already resolved the durable
                  // match (applyRemovalCleanup, C#12); durable rows are
                  // the display truth — screens re-read on focus.
                  await reviewRefresh().catch(() => {});
                } else if (attempt.status === 'applied' || attempt.unknownIds.length > 0) {
                  // Verification inconclusive (applied dialog, or a
                  // failed attempt whose fallback release couldn't
                  // verify) — the photo MAY be in system trash, so it
                  // conservatively stays staged in the durable cull list
                  // (the vetted fallback); the next confirm re-verifies.
                  // The original already moved to_edit → culled (star
                  // cleared) — the cached queue must observe it.
                  await reviewRefresh().catch(() => {});
                  Alert.alert(
                    'Could not verify the move',
                    'The photo stays staged in the cull list until the move can be verified.',
                  );
                } else {
                  // Definitively NOT applied (cancel/failure/unsupported):
                  // back to the edit queue — a true no-op from the
                  // user's view, so the copy prompt's question stays
                  // open (pending match kept) and the star the staging
                  // cleared comes back.
                  await unstageCullDirect(
                    db,
                    head.originalAssetId,
                    Date.now(),
                    false,
                    // One transaction with the un-staging: a crash between
                    // separate writes would lose the star forever
                    // (clearedStars lives only in memory).
                    attempt.clearedStars.filter((star) => star.photoId === head.originalAssetId),
                  );
                  await reviewRefresh().catch(() => {});
                  if (attempt.status === 'unsupported') {
                    Alert.alert(
                      'System trash unavailable',
                      'Afterglow does not permanently delete photos. This action requires Android 11 or later.',
                    );
                  } else if (attempt.status === 'failed') {
                    Alert.alert(
                      'Could not move photo to trash',
                      attempt.error ?? 'Unknown MediaStore error.',
                    );
                  }
                }
                next();
              })(),
          },
          {
            text: 'Keep original',
            onPress: () =>
              void (async () => {
                // markEditDone converges the original AND resolves its
                // live match in one transaction (C#12).
                await markEditDone(db, head.originalAssetId);
                await reviewRefresh().catch(() => {});
                next();
              })(),
          },
        ],
      );
    },
    [db, reviewRefresh],
  );

  // m0.3 edit detection — app open / return to Home, throttled.
  useFocusEffect(
    useCallback(() => {
      if (!permission?.granted) return;
      const now = Date.now();
      if (now - lastDetectionRef.current < 60_000) return;
      lastDetectionRef.current = now;
      let cancelled = false;
      (async () => {
        const result = await runEditDetection(db).catch(() => null);
        if (!result) return;
        if (result.autoDoneIds.length > 0 || result.copies.length > 0 || result.reconciled > 0) {
          // Detection wrote states directly — the cached review queue
          // must observe them (a stale unreviewed copy left actionable
          // in the deck could overwrite the durable done later).
          void reviewRefresh().catch(() => {});
        }
        if (result.autoDoneIds.length > 0) {
          setDetectionNotice(
            result.autoDoneIds.length === 1
              ? '1 edited photo detected — marked done'
              : `${result.autoDoneIds.length} edited photos detected — marked done`,
          );
          setRefreshTick((t) => t + 1);
        }
        // Unlike the cosmetic notice, the copy prompt drives destructive
        // decisions through this closure's sessionCtx — never raise it
        // from a superseded effect run (blur, version bump). Pending
        // matches re-emit on later detection runs, so this only defers.
        if (cancelled) return;
        if (result.copies.length > 0) promptForCopies(result.copies);
      })();
      return () => {
        cancelled = true;
      };
    }, [db, permission?.granted, promptForCopies, reviewRefresh]),
  );

  // Edit-queue badge + recent-days progress, refreshed on focus. Both
  // respect the photo-source filter (m0.3.1).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const stagedCulls = await countStagedCulls(db);
        if (cancelled) return;
        setStagedCullCount(stagedCulls);
        if (stagedCulls > 0) {
          const staged = await getStagedCullBytes(db);
          if (cancelled) return;
          // Scan-recorded sizes SUM in SQL; only rows the scan never
          // sized get a (blocking) stat, bounded by the query's LIMIT.
          // Home's line is an estimate ("~") — the trash flow measures
          // exact bytes per photo at attempt time for the credit.
          const statted = staged.unsized.reduce((sum, uri) => sum + (fileSizeOrNull(uri) ?? 0), 0);
          setReclaimableBytes(staged.scanned + statted);
        } else {
          setReclaimableBytes(0);
        }

        // FAIL CLOSED: a source-resolution error keeps the previous day
        // rows — null's store meaning is "all folders", and the
        // still-to-review discovery below must never silently broaden a
        // narrowed source.
        let src: { roots: string[] | null; albumIds: string[] | null } | null = null;
        if (permission?.granted) {
          try {
            const resolved = await resolveSources(db);
            src = { roots: resolved.roots ?? null, albumIds: resolved.albumIds ?? null };
          } catch (error) {
            console.warn('[home] source resolution failed — day rows kept:', String(error));
            return;
          }
        }
        if (cancelled) return;
        const toRow = (day: string, dbRow: DaySummaryRow | undefined, msTotal: number): DayRow => {
          // Trashed photos are gone from MediaStore, so the day's true
          // total is MediaStore + trashed rows (DB `done` includes them).
          const total = msTotal + (dbRow?.trashed ?? 0);
          const kept = dbRow?.done ?? 0;
          const toEdit = dbRow?.toEdit ?? 0;
          const staged = dbRow?.staged ?? 0;
          return {
            day,
            label: labelForDayKey(day),
            total,
            // Reviewed = has a VERDICT (docs/STATE_MODEL.md). A queued
            // edit is a pending action on an already-kept photo, so
            // adding it here counted those photos twice.
            reviewed: Math.min(total, kept + staged),
            kept,
            toEdit,
            staged,
          };
        };
        // A failed MediaStore count THROWS out of the loader (caught
        // below, keeping the previous rows) — an unavailable count is not
        // zero photos.
        const buildRows = async (days: readonly string[]): Promise<DayRow[]> => {
          if (days.length === 0) return [];
          const summaries = await getDaySummariesForDays(db, days, src?.roots ?? null);
          // Per-day MediaStore counts run CONCURRENTLY and via the cheap
          // totalCount path (m0.8.1): this used to PAGE every asset of
          // every day (200 at a time) sequentially just to tally one
          // number per day — the day list's dominant cost. A day's range
          // bounds already select exactly that day, so totalCount IS the
          // day's count.
          const msTotals = await Promise.all(
            days.map(async (day) => {
              if (day === UNDATED_DAY_KEY || !permission?.granted) return 0;
              const range = rangeOfDayKey(day);
              return countPhotosInRange(range.startMs, range.endMs, src?.albumIds ?? null);
            }),
          );
          const rows: DayRow[] = [];
          days.forEach((day, index) => {
            if (day === UNDATED_DAY_KEY) {
              // No MediaStore count exists for undated photos — the
              // tracked rows are the population (alive = tracked-trashed;
              // toRow adds trashed back for the true total).
              const summary = summaries.get(day);
              const alive = (summary?.tracked ?? 0) - (summary?.trashed ?? 0);
              const row = toRow(day, summary, alive);
              if (row.total > 0) rows.push(row);
              return;
            }
            const row = toRow(day, summaries.get(day), msTotals[index]);
            if (row.total > 0) rows.push(row);
          });
          return rows;
        };
        try {
          const recentKeys = recentDayKeys(RECENT_CALENDAR_DAYS);
          const unreviewedDays = permission?.granted
            ? await getUnreviewedDayRows(db, src?.roots ?? null)
            : [];
          const undatedPending = unreviewedDays.some((u) => u.day === UNDATED_DAY_KEY);
          const olderUnreviewed = unreviewedDays
            .map((u) => u.day)
            .filter((day) => !recentKeys.includes(day) && day !== UNDATED_DAY_KEY);
          const [recentRows, unreviewedRows] = await Promise.all([
            buildRows(recentKeys),
            // The Unknown-day row is not one of the "2 older days" — it
            // always shows while undated photos await review.
            buildRows([
              ...olderUnreviewed.slice(0, UNREVIEWED_DAY_ROWS),
              ...(undatedPending ? [UNDATED_DAY_KEY] : []),
            ]),
          ]);
          if (cancelled) return;
          setDayRows(recentRows);
          setUnreviewedDayRowsState(unreviewedRows);
          setOlderDays(olderUnreviewed.slice(UNREVIEWED_DAY_ROWS, OLDER_DAY_CAP));
          setOlderRows(null);
          buildOlderRowsRef.current = buildRows;
        } catch (error) {
          // Keep the previous rows — an unavailable MediaStore count must
          // not make days disappear or show understated totals.
          console.warn('[home] day-row refresh failed — previous rows kept:', String(error));
        }
      })();
      return () => {
        cancelled = true;
      };
      // refreshTick re-runs this after edit detection changes states;
      // scanRefreshKey re-runs it coarsely as the newest→oldest scan
      // lands older days (and once on completion) — otherwise the
      // still-to-review rows stay stale until a refocus.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, permission?.granted, refreshTick, scanRefreshKey]),
  );

  const expandOlderDays = useCallback(async () => {
    const build = buildOlderRowsRef.current;
    if (!build || olderDays.length === 0) return;
    try {
      setOlderRows(await build(olderDays));
    } catch (error) {
      // Same contract as the day-row loader: an unavailable count keeps
      // the collapsed state instead of leaking an unhandled rejection.
      console.warn('[home] older-day expansion failed — kept collapsed:', String(error));
    }
  }, [olderDays]);

  const openProgress = useCallback(() => navigation.navigate('Progress'), [navigation]);

  const queueTotal = review.queueCounts.grouped + review.queueCounts.singles;
  /** The one library-size number this screen shows (F4): the running
   * scan's own snapshot while it scans, the focus loader's count idle. */
  const libraryTotal =
    scan.phase === 'scanning' && scan.corpusTotal !== null
      ? scan.corpusTotal
      : (corpus?.total ?? null);

  // One card per day (gate 5 audit: the headline count is REVIEWED —
  // every verdict — not just converged "done").
  const renderDayRow = (row: DayRow) => {
    const pct = row.total > 0 ? Math.round((row.reviewed / row.total) * 100) : 0;
    const pending = Math.max(0, row.total - row.reviewed);
    return (
      <Pressable
        key={row.day}
        style={styles.dayRow}
        onPress={() => navigation.navigate('DayProgress', { day: row.day })}
      >
        <View style={styles.dayRowHeader}>
          <Text style={styles.dayRowTitle}>{row.label}</Text>
          <Text style={styles.dayRowPct}>
            {row.reviewed === row.total
              ? 'reviewed'
              : `${row.reviewed}/${row.total} reviewed · ${pct}%`}
          </Text>
        </View>
        <StateProgressBar
          total={row.total}
          segments={[
            { count: row.kept, color: colors.keep },
            { count: row.staged, color: colors.cull },
          ]}
        />
        {(pending > 0 || row.toEdit > 0 || row.staged > 0) && (
          <Text style={styles.dayRowHint}>
            {[
              pending > 0 ? `${pending} to review` : null,
              row.toEdit > 0 ? `${row.toEdit} to edit` : null,
              row.staged > 0 ? `${row.staged} staged cull` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: 24 }]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Afterglow</Text>
        <View style={styles.titleActions}>
          <Pressable
            style={styles.gearButton}
            hitSlop={8}
            accessibilityLabel="Stats"
            onPress={() => navigation.navigate('Stats')}
          >
            <MaterialCommunityIcons name="chart-box-outline" size={24} color={colors.textDim} />
          </Pressable>
          <Pressable
            style={styles.gearButton}
            hitSlop={8}
            accessibilityLabel="History"
            onPress={() => navigation.navigate('History')}
          >
            <MaterialCommunityIcons name="history" size={24} color={colors.textDim} />
          </Pressable>
          <Pressable
            style={styles.gearButton}
            hitSlop={8}
            accessibilityLabel="Settings"
            onPress={() => navigation.navigate('Settings')}
          >
            {/* m0.6: Material gear — the m0.5 emoji read as out of place. */}
            <MaterialCommunityIcons name="cog-outline" size={24} color={colors.textDim} />
          </Pressable>
        </View>
      </View>

      {detectionNotice && (
        <Pressable style={styles.notice} onPress={() => setDetectionNotice(null)}>
          <Text style={styles.noticeText}>{detectionNotice}</Text>
          <Text style={styles.noticeDismiss}>dismiss</Text>
        </Pressable>
      )}

      {/* Permission is TRI-state (F2): null = still resolving — ghosts
          hold the page's shape; the ask card renders only on a RESOLVED
          denial. Before this, every cold start flashed "Allow photo
          access" at long-granted users while the hook resolved. */}
      {permission === null && (
        <>
          <Ghost height={208} />
          <Ghost height={64} />
          <Ghost height={92} />
          <Ghost height={92} />
        </>
      )}

      {permission !== null && !permission.granted && (
        <View style={styles.card}>
          <Text style={styles.cardText}>
            Afterglow needs access to your photos to review them. Nothing is ever deleted without
            your explicit confirmation.
          </Text>
          <BigButton
            label={
              permission.canAskAgain === false
                ? 'Enable photo access in Settings'
                : 'Allow photo access'
            }
            color={theme.accent}
            textColor={theme.onAccent}
            onPress={() => void requestPermission()}
          />
        </View>
      )}

      {permission?.granted && (
        <View style={styles.card}>
          <View style={styles.goalRow}>
            <GoalRing
              size={132}
              strokeWidth={12}
              progress={goalLoaded ? goalProgress(reviewedToday, goal) : 0}
              color={goalLoaded && reviewedToday >= goal ? colors.keep : theme.accent}
              // Placeholder until the loader's single commit (F2): a
              // hardcoded "0 of 50" is a wrong number, not a loading one.
              centerTitle={goalLoaded ? `${reviewedToday}` : '–'}
              centerSubtitle={goalLoaded ? `of ${goal} today` : 'today'}
            />
            <View style={styles.goalBody}>
              <Text style={styles.cardTitle}>
                {reviewedToday >= goal ? 'Daily goal reached 🎉' : 'Daily goal'}
              </Text>
              {/* version 0 = no queue read has COMMITTED yet (cold
                  start) — the empty-queue copy would falsely announce
                  "everything reviewed" under a scan line reporting a
                  full library (tester-observed). */}
              {!review.loaded ? (
                <Text style={styles.cardText}>Loading your queue…</Text>
              ) : (
                <>
                  {/* The library headline (tester ask, round 4): total
                      first, then what is left and how it is shaped.
                      While a scan runs the card reads the SCAN'S OWN
                      library snapshot (m0.8.2, F4), so this line and the
                      scan line's "of N photos" are one number by
                      construction; idle, it is the focus loader's count.
                      Null (either source) drops the line rather than
                      showing a wrong total. */}
                  {libraryTotal !== null && (
                    <Text style={styles.cardText}>
                      {`${libraryTotal.toLocaleString()} picture${libraryTotal === 1 ? '' : 's'} total`}
                    </Text>
                  )}
                  {queueTotal === 0 ? (
                    <Text style={styles.cardText}>
                      Everything reviewed — new photos join the queue as they are found.
                    </Text>
                  ) : (
                    // The breakdown IS the door to the timeline overview
                    // (m0.8.2, F8): the CTA below goes straight into the
                    // next unit, so browsing the queue lives here — the
                    // information scent is the numbers themselves.
                    <Pressable
                      style={styles.queueLink}
                      onPress={() => navigation.navigate('Groups')}
                    >
                      <View style={styles.queueLinkBody}>
                        <Text style={styles.cardText}>{`${queueTotal} to review`}</Text>
                        {review.queueCounts.grouped > 0 && (
                          <Text style={styles.queueBreakdown}>
                            {`${review.queueCounts.grouped} in ${review.queueCounts.groups} group${
                              review.queueCounts.groups === 1 ? '' : 's'
                            }`}
                          </Text>
                        )}
                        {review.queueCounts.singles > 0 && (
                          <Text style={styles.queueBreakdown}>
                            {`${review.queueCounts.singles} single${
                              review.queueCounts.singles === 1 ? '' : 's'
                            }`}
                          </Text>
                        )}
                      </View>
                      <MaterialCommunityIcons
                        name="chevron-right"
                        size={20}
                        color={colors.textDim}
                      />
                    </Pressable>
                  )}
                </>
              )}
              {streaks.current > 0 && (
                <Text style={styles.streakText}>
                  🔥 {streaks.current}-day streak
                  {streaks.longest > streaks.current ? ` · longest ${streaks.longest}` : ''}
                </Text>
              )}
            </View>
          </View>
          <BigButton
            label={
              !review.loaded ? 'Loading…' : queueTotal === 0 ? 'All reviewed' : 'Continue reviewing'
            }
            color={colors.keep}
            disabled={queueTotal === 0}
            // STRAIGHT into the next timeline unit (m0.8.2, F8) — the
            // overview hop was a redundant tap; it stays reachable via
            // the queue-breakdown link above. Every input is already
            // loaded here, so there is no empty-deck flash. An empty
            // page with a nonzero DB count (all pending beyond the
            // horizon) falls back to the overview.
            onPress={() => {
              const first = review.timeline[0];
              if (!first) {
                navigation.navigate('Groups');
                return;
              }
              const destination = unitDestination(first);
              if (destination.screen === 'Deck')
                navigation.navigate('Deck', { groupId: destination.groupId });
              else if (destination.screen === 'Singles')
                navigation.navigate('Singles', {
                  day: destination.day,
                  from: destination.from,
                  to: destination.to,
                });
              else navigation.navigate('CullList', { fromHome: true });
            }}
          />
          {/* Only a RUNNING scan (or a failed one) talks below the CTA
              (tester ask, round 4): an idle line repeated numbers the
              card above already states. The line speaks ONLY about the
              scan (m0.8.2, F4): "groups found" is gone — the card above
              carries the one truthful group count, and a second,
              differently-scoped number on the same screen could never
              agree with it. A full pass shows the percent (F3); a delta
              has no meaningful denominator and shows plain counts. */}
          {(scan.phase === 'scanning' || scan.phase === 'error') && (
            <Text style={styles.scanStatus}>
              {scan.phase === 'error'
                ? 'Photo scan hit a problem — it will retry on next launch.'
                : scan.total !== null && scan.total > 0
                  ? `Scanning ${Math.min(100, Math.round((scan.scanned / scan.total) * 100))}% · ` +
                    `${Math.min(scan.scanned, scan.total).toLocaleString()} of ${scan.total.toLocaleString()} photos`
                  : `Scanning photos… ${scan.scanned.toLocaleString()} seen · ${scan.embedded.toLocaleString()} analyzed`}
            </Text>
          )}
        </View>
      )}

      {/* The edit/favourite/share/organize queues live on the bottom tab
          bar (count-badged there) — Home keeps only the rows without a
          tab: the cull list and Progress. */}
      {stagedCullCount > 0 && (
        // The durable global cull queue must stay reachable even with no
        // active session (carried culls, edited-copy culls) — the
        // session flow is not the only route to confirmation.
        <Pressable
          style={styles.editQueueRow}
          onPress={() => navigation.navigate('CullList', { fromHome: true })}
        >
          <MaterialCommunityIcons name="delete-outline" size={22} color={colors.cull} />
          <View style={styles.editQueueBody}>
            <Text style={styles.editQueueTitle}>Cull list</Text>
            {/* The reclaimable estimate belongs to the deletion it
                describes (tester ask, round 4) — it used to trail the
                scan line, where it read as a scan statistic. */}
            <Text style={styles.editQueueHint}>
              {`${stagedCullCount} photo${stagedCullCount === 1 ? '' : 's'} staged to cull` +
                (reclaimableBytes > 0 ? ` · ~${formatBytes(reclaimableBytes)} reclaimable` : '')}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: colors.cullDim }]}>
            <Text style={[styles.badgeText, { color: colors.cull }]}>{stagedCullCount}</Text>
          </View>
        </Pressable>
      )}

      {/* The COVERAGE goal (m0.8.1 round 8): its own card because it has
          its own progress AND its own streak — and keeping it separate
          leaves the count-goal card above untouched. */}
      {permission?.granted && coverage !== 'off' && coverageState !== null && (
        <View style={styles.coverageCard}>
          <View style={styles.coverageHeader}>
            <Text style={styles.coverageTitle}>Keeping up</Text>
            <Text style={styles.coverageScope}>{COVERAGE_GOAL_LABELS[coverage]}</Text>
          </View>
          {/* An EMPTY window is neither a win nor a failure (m0.8.2, D15):
              the ratio is vacuously 1, which used to paint a full green
              bar over "nothing captured yet". The Stats chart already
              draws empty days as gaps and the streak already passes over
              them — this makes the third surface agree. */}
          <View style={styles.coverageBarTrack}>
            {coverageState.total > 0 && (
              <View
                style={[
                  styles.coverageBarFill,
                  {
                    width: `${Math.round(coverageState.ratio * 100)}%`,
                    backgroundColor: coverageState.pending === 0 ? colors.keep : theme.accent,
                  },
                ]}
              />
            )}
          </View>
          <Text style={styles.coverageText}>
            {coverageState.total === 0
              ? 'Nothing captured in this window yet.'
              : coverageState.pending === 0
                ? coverage === 'all'
                  ? 'Everything reviewed — the whole library is clear. 🎉'
                  : `All clear — nothing left from ${COVERAGE_GOAL_LABELS[coverage].toLowerCase()}. 🎉`
                : coverage === 'all'
                  ? `${Math.round(coverageState.ratio * 100)}% of your library reviewed · ${coverageState.pending} to go`
                  : `${coverageState.pending} left from ${COVERAGE_GOAL_LABELS[coverage].toLowerCase()}`}
          </Text>
          {coverageState.streak !== null && coverageState.streak > 0 && (
            <Text style={styles.streakText}>🔥 {coverageState.streak}-day clear streak</Text>
          )}
        </View>
      )}

      {permission?.granted && (
        <Pressable style={styles.progressRow} onPress={openProgress}>
          <Text style={styles.progressIcon}>◔</Text>
          <View style={styles.progressBody}>
            <Text style={styles.progressTitle}>Progress</Text>
            {/* m0.8.2: the row's subtitle was pure navigation boilerplate;
                the finish line costs no height and no query, and falls
                back to that boilerplate when there is not enough history
                to say anything true. */}
            <Text style={styles.progressHint}>
              {finish === null
                ? 'All photos · state browsing'
                : forecastHeadline(finish, Date.now())}
            </Text>
          </View>
          <Text style={[styles.progressChevron, { color: theme.accent }]}>›</Text>
        </Pressable>
      )}

      {/* Day rows GHOST until their (multi-query) load lands, so the
          bottom sections fill in place instead of materialising (F2). An
          empty result (fresh install) simply clears the ghosts. */}
      {permission?.granted && dayRows === null && (
        <>
          <Text style={styles.sectionLabel}>Recent days</Text>
          <Ghost height={92} />
          <Ghost height={92} />
        </>
      )}
      {permission?.granted && dayRows && dayRows.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Recent days</Text>
          {dayRows.map(renderDayRow)}
        </>
      )}

      {permission?.granted && (unreviewedDayRowsState.length > 0 || olderDays.length > 0) && (
        <>
          <Text style={styles.sectionLabel}>Still to review</Text>
          {unreviewedDayRowsState.map(renderDayRow)}
          {olderRows !== null ? (
            olderRows.map(renderDayRow)
          ) : olderDays.length > 0 ? (
            <Pressable style={styles.olderRow} onPress={() => void expandOlderDays()}>
              <MaterialCommunityIcons name="calendar-clock" size={20} color={colors.textDim} />
              <Text style={styles.olderRowText}>
                {olderDays.length} older day{olderDays.length === 1 ? '' : 's'} with photos to
                review
              </Text>
              <Text style={[styles.progressChevron, { color: theme.accent }]}>›</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, gap: 16 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', flexShrink: 1 },
  titleActions: { flexDirection: 'row', gap: 8 },
  gearButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  goalBody: { flex: 1, gap: 4 },
  streakText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  scanStatus: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  olderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  olderRowText: { color: colors.textDim, fontSize: 14, flex: 1 },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  cardText: { color: colors.textDim, fontSize: 15, lineHeight: 21 },
  coverageCard: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  coverageHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  coverageTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  coverageScope: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  coverageBarTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  coverageBarFill: { height: '100%', borderRadius: 5 },
  coverageText: { color: colors.textDim, fontSize: 14, lineHeight: 19 },
  queueBreakdown: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  queueLink: { flexDirection: 'row', alignItems: 'center' },
  queueLinkBody: { flex: 1 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  progressIcon: { color: colors.keep, fontSize: 22, fontWeight: '700' },
  progressBody: { flex: 1 },
  progressTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  progressHint: { color: colors.textDim, fontSize: 13 },
  progressChevron: { fontSize: 22, fontWeight: '600' },
  dateField: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  dateFieldLabel: { color: colors.textDim, fontSize: 12 },
  dateFieldValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
  nameField: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 14,
    minHeight: 48,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: colors.keepDim,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.keep,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  noticeText: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  noticeDismiss: { color: colors.textDim, fontSize: 12 },
  editQueueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  editQueueBody: { flex: 1 },
  editQueueTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  editQueueHint: { color: colors.textDim, fontSize: 13 },
  badge: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    // Neutral by default: a generic badge carries no action (rule 2).
    // Its one caller overrides this with the cull hue.
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { color: colors.background, fontSize: 14, fontWeight: '800' },
  dayRow: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  dayRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayRowTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dayRowPct: { color: colors.textDim, fontSize: 13 },
  dayRowHint: { color: colors.textDim, fontSize: 12 },
});
