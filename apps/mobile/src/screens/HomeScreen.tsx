import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainTabScreenProps } from '../navigation';
import { countShareQueue } from '../db/shareStore';
import { countOrganizeQueue } from '../db/organizeStore';
import { dayKey, labelForDayKey, recentDayKeys, rangeOfDayKey } from '../lib/dates';
import { DAILY_GOAL_KEY, goalProgress, goalStreaks, parseDailyGoal } from '../lib/dailyGoal';
import { countPhotosByDayInRange, countPhotosInRange } from '../lib/media';
import { resolveSources } from '../lib/sourceCatalog';
import {
  countFavouriteQueue,
  countStagedCulls,
  getStagedCulls,
  countToEdit,
  getCorpusStats,
  getDaySummariesForDays,
  getReviewedCountsByDay,
  getUnreviewedDayRows,
  type DaySummaryRow,
  getSetting,
  markEditDone,
  setGroupBest,
  unstageCullDirect,
} from '../db/store';
import { runTrashAttempt } from '../lib/trashFlow';
import { formatBytes } from '../lib/format';
import { fileSize } from '../lib/hash';
import { runEditDetection, type DetectedCopy } from '../lib/detect';
import { getScanStatus, startContinuousScan, subscribeScanStatus } from '../scan/scanRunner';
import { GoalRing } from '../components/GoalRing';
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
  /** Every verdict: done + trashed + to-edit + staged (gate 5 audit). */
  reviewed: number;
  /** done + trashed. */
  done: number;
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

  const [editCount, setEditCount] = useState(0);
  const [scan, setScan] = useState(getScanStatus());
  const [goal, setGoal] = useState(50);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [streaks, setStreaks] = useState({ current: 0, longest: 0 });
  const [corpus, setCorpus] = useState<{
    total: number;
    groupsFound: number;
    reviewed: number;
  } | null>(null);
  const [stagedCullCount, setStagedCullCount] = useState(0);
  /** Estimated bytes the staged culls would free (gate 4 corpus stats;
   * synchronous stat per staged file, capped — 0 hides the figure). */
  const [reclaimableBytes, setReclaimableBytes] = useState(0);
  const [shareCount, setShareCount] = useState(0);
  const [organizeCount, setOrganizeCount] = useState(0);
  const [favouriteCount, setFavouriteCount] = useState(0);
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
  useEffect(() => {
    if (!permission?.granted) return;
    void startContinuousScan(db);
  }, [db, permission?.granted]);

  useEffect(() => subscribeScanStatus(setScan), []);

  // Scan-driven refresh key, COARSENED: every 250 grouped windows and on
  // phase changes. Per-window refreshes (4,913 windows on a 27k corpus)
  // would issue thousands of redundant source resolutions, SQLite reads
  // and MediaStore counts while Home stays focused.
  const scanRefreshKey = `${scan.phase}:${Math.floor(scan.windowsGrouped / 250)}`;

  // Daily goal + streaks + live corpus stats (gate 4): refresh on focus,
  // on review mutations, and as scan windows land.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const today = dayKey(Date.now());
        const since = recentDayKeys(120)[119] ?? today;
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
        const [rawGoal, reviewedByDay, stats, total] = await Promise.all([
          getSetting(db, DAILY_GOAL_KEY),
          getReviewedCountsByDay(db, since),
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
        setGoal(currentGoal);
        setReviewedToday(reviewedByDay.get(today) ?? 0);
        const keys = [...recentDayKeys(120)].reverse();
        setStreaks(goalStreaks(reviewedByDay, keys, currentGoal));
        if (stats && total !== null)
          setCorpus({ total, groupsFound: stats.groupsFound, reviewed: stats.reviewed });
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
          'The copy is marked done. What about the original?',
        [
          { text: 'Decide later', style: 'cancel', onPress: next },
          {
            text: 'Cull original',
            style: 'destructive',
            onPress: () =>
              void (async () => {
                // The same durable trash lifecycle as staged culls (item
                // H): stage+reserve in ONE transaction → system dialog →
                // verify → C#7 cleanup — a crash anywhere leaves either
                // the untouched to_edit row or a recoverable attempt
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
                  await unstageCullDirect(db, head.originalAssetId, Date.now(), false);
                  for (const star of attempt.clearedStars) {
                    if (star.photoId !== head.originalAssetId) continue;
                    // Best-effort: the group may have changed meanwhile —
                    // setGroupBest validates and rejects stale writes.
                    await setGroupBest(db, star.groupId, star.photoId).catch(() => {});
                  }
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
        const [toEdit, favouriteQueue, shareQueue, organizeQueue, stagedCulls] = await Promise.all([
          countToEdit(db),
          countFavouriteQueue(db),
          countShareQueue(db),
          countOrganizeQueue(db),
          countStagedCulls(db),
        ]);
        if (cancelled) return;
        setEditCount(toEdit);
        setFavouriteCount(favouriteQueue);
        setShareCount(shareQueue);
        setOrganizeCount(organizeQueue);
        setStagedCullCount(stagedCulls);
        if (stagedCulls > 0 && stagedCulls <= 500) {
          const staged = await getStagedCulls(db);
          if (cancelled) return;
          setReclaimableBytes(staged.reduce((sum, row) => sum + fileSize(row.uri), 0));
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
          const done = dbRow?.done ?? 0;
          const toEdit = dbRow?.toEdit ?? 0;
          const staged = dbRow?.staged ?? 0;
          return {
            day,
            label: labelForDayKey(day),
            total,
            reviewed: Math.min(total, done + toEdit + staged),
            done,
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
          const rows: DayRow[] = [];
          for (const day of days) {
            const range = rangeOfDayKey(day);
            const msTotal = permission?.granted
              ? await countPhotosByDayInRange(
                  range.startMs,
                  range.endMs,
                  src?.albumIds ?? null,
                ).then((m) => m.get(day) ?? 0)
              : 0;
            const row = toRow(day, summaries.get(day), msTotal);
            if (row.total > 0) rows.push(row);
          }
          return rows;
        };
        try {
          const recentKeys = recentDayKeys(RECENT_CALENDAR_DAYS);
          const unreviewedDays = permission?.granted
            ? await getUnreviewedDayRows(db, src?.roots ?? null)
            : [];
          const olderUnreviewed = unreviewedDays
            .map((u) => u.day)
            .filter((day) => !recentKeys.includes(day));
          const [recentRows, unreviewedRows] = await Promise.all([
            buildRows(recentKeys),
            buildRows(olderUnreviewed.slice(0, UNREVIEWED_DAY_ROWS)),
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
    setOlderRows(await build(olderDays));
  }, [olderDays]);

  const openProgress = useCallback(() => {
    navigation.navigate('Progress', {
      label: 'All photos',
      startMs: 0,
      // Open-ended: undated photos count too (media.ts bound contract).
      endMs: Number.POSITIVE_INFINITY,
    });
  }, [navigation]);

  const queueTotal = review.queueCounts.grouped + review.queueCounts.singles;

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
            { count: row.done, color: colors.keep },
            { count: row.toEdit, color: colors.edit },
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
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Afterglow</Text>
        <View style={styles.titleActions}>
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

      {!permission?.granted && (
        <View style={styles.card}>
          <Text style={styles.cardText}>
            Afterglow needs access to your photos to review them. Nothing is ever deleted without
            your explicit confirmation.
          </Text>
          <BigButton
            label={
              permission?.canAskAgain === false
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
              progress={goalProgress(reviewedToday, goal)}
              color={reviewedToday >= goal ? colors.keep : theme.accent}
              centerTitle={`${reviewedToday}`}
              centerSubtitle={`of ${goal} today`}
            />
            <View style={styles.goalBody}>
              <Text style={styles.cardTitle}>
                {reviewedToday >= goal ? 'Daily goal reached 🎉' : 'Daily goal'}
              </Text>
              <Text style={styles.cardText}>
                {queueTotal === 0
                  ? 'Everything reviewed — new photos join the queue as they are found.'
                  : `${queueTotal} photo${queueTotal === 1 ? '' : 's'} waiting · ` +
                    `${review.queueCounts.grouped} in groups · ${review.queueCounts.singles} singles`}
              </Text>
              {streaks.current > 0 && (
                <Text style={styles.streakText}>
                  🔥 {streaks.current}-day streak
                  {streaks.longest > streaks.current ? ` · longest ${streaks.longest}` : ''}
                </Text>
              )}
            </View>
          </View>
          <BigButton
            label={queueTotal === 0 ? 'All reviewed' : 'Continue reviewing'}
            color={colors.keep}
            disabled={queueTotal === 0}
            onPress={() => navigation.navigate('Groups')}
          />
          <Text style={styles.scanStatus}>
            {scan.phase === 'scanning'
              ? `Scanning photos… ${scan.scanned} seen · ${scan.embedded} analyzed · ${scan.windowsGrouped} groups formed`
              : scan.phase === 'error'
                ? 'Photo scan hit a problem — it will retry on next launch.'
                : corpus
                  ? `${corpus.total} photos · ${corpus.groupsFound} groups found · ` +
                    `${corpus.total > 0 ? Math.min(100, Math.round((corpus.reviewed / corpus.total) * 100)) : 0}% reviewed` +
                    (reclaimableBytes > 0 ? ` · ~${formatBytes(reclaimableBytes)} reclaimable` : '')
                  : 'Preparing scan…'}
          </Text>
        </View>
      )}

      <Pressable
        style={styles.editQueueRow}
        onPress={() => navigation.navigate('Main', { screen: 'EditQueue' })}
      >
        <MaterialCommunityIcons name="pencil" size={22} color={colors.edit} />
        <View style={styles.editQueueBody}>
          <Text style={styles.editQueueTitle}>Edit queue</Text>
          <Text style={styles.editQueueHint}>
            {editCount === 0
              ? 'No keepers waiting for edits'
              : `${editCount} keeper${editCount === 1 ? '' : 's'} waiting for edits`}
          </Text>
        </View>
        {editCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{editCount}</Text>
          </View>
        )}
      </Pressable>

      {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
        <Pressable
          style={styles.editQueueRow}
          onPress={() => navigation.navigate('Main', { screen: 'FavouritesQueue' })}
        >
          <MaterialCommunityIcons name="heart" size={22} color={colors.fav} />
          <View style={styles.editQueueBody}>
            <Text style={styles.editQueueTitle}>Favourite queue</Text>
            <Text style={styles.editQueueHint}>
              {favouriteCount === 0
                ? 'No favourite changes waiting'
                : `${favouriteCount} change${favouriteCount === 1 ? '' : 's'} waiting for gallery confirmation`}
            </Text>
          </View>
          {favouriteCount > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.favDim }]}>
              <Text style={[styles.badgeText, { color: colors.fav }]}>{favouriteCount}</Text>
            </View>
          )}
        </Pressable>
      )}

      <Pressable
        style={styles.editQueueRow}
        onPress={() => navigation.navigate('Main', { screen: 'ShareQueue' })}
      >
        <MaterialCommunityIcons name="share-variant" size={22} color={colors.edit} />
        <View style={styles.editQueueBody}>
          <Text style={styles.editQueueTitle}>Share queue</Text>
          <Text style={styles.editQueueHint}>
            {shareCount === 0
              ? 'Queue photos to share in passes'
              : `${shareCount} photo${shareCount === 1 ? '' : 's'} ready to share`}
          </Text>
        </View>
        {shareCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{shareCount}</Text>
          </View>
        )}
      </Pressable>

      {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
        <Pressable
          style={styles.editQueueRow}
          onPress={() => navigation.navigate('Main', { screen: 'OrganizeQueue' })}
        >
          <MaterialCommunityIcons name="folder-move" size={22} color={colors.textDim} />
          <View style={styles.editQueueBody}>
            <Text style={styles.editQueueTitle}>Organize queue</Text>
            <Text style={styles.editQueueHint}>
              {organizeCount === 0
                ? 'Queue photos to move into albums'
                : `${organizeCount} photo${organizeCount === 1 ? '' : 's'} waiting to move`}
            </Text>
          </View>
          {organizeCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{organizeCount}</Text>
            </View>
          )}
        </Pressable>
      )}

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
            <Text style={styles.editQueueHint}>
              {`${stagedCullCount} photo${stagedCullCount === 1 ? '' : 's'} staged for deletion`}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: colors.cullDim }]}>
            <Text style={[styles.badgeText, { color: colors.cull }]}>{stagedCullCount}</Text>
          </View>
        </Pressable>
      )}

      {permission?.granted && (
        <Pressable style={styles.progressRow} onPress={openProgress}>
          <Text style={styles.progressIcon}>◔</Text>
          <View style={styles.progressBody}>
            <Text style={styles.progressTitle}>Progress</Text>
            <Text style={styles.progressHint}>All photos · state browsing</Text>
          </View>
          <Text style={[styles.progressChevron, { color: theme.accent }]}>›</Text>
        </Pressable>
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
  gearIcon: { color: colors.textDim, fontSize: 22 },
  subtitle: { color: colors.textDim, fontSize: 16, marginBottom: 8 },
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
  scopeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scopeChip: {
    minHeight: 44,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scopeChipDisabled: { opacity: 0.4 },
  scopeChipText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
  scopeChipTextDisabled: { color: colors.textDim },
  gateHint: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: -8 },
  headline: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: -6 },
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
  customRow: { flexDirection: 'row', gap: 10 },
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
  saveScopeButton: {
    minHeight: 48,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saveScopeText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
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
    backgroundColor: colors.edit,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { color: '#0d1524', fontSize: 14, fontWeight: '800' },
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
