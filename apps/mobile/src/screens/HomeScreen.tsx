import React, { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { customRange, labelForDayKey, recentDayKeys, rangeOfDayKey } from '../lib/dates';
import { allTimeUnlocked, remainingToReview, rollingRange } from '../lib/scopes';
import {
  addCustomScope,
  enabledScopes,
  newCustomScopeId,
  parseScopeConfig,
  REVIEW_SCOPES_KEY,
  serializeScopeConfig,
  storedScopeRange,
  type ScopeConfig,
} from '../lib/scopeStore';
import { countPhotosInRange, deleteAssets } from '../lib/media';
import { resolveSources } from '../lib/sourceCatalog';
import { getSessionPrefs, loadReviewablePhotos } from '../lib/reviewLoader';
import { DEFAULT_SESSION_PREFS, type SessionPrefs } from '../lib/sessionPrefs';
import {
  bankActiveSessionKeepers,
  countToEdit,
  getDaySummaries,
  getSetting,
  getStateCountsInScope,
  markEditDone,
  markTrashedDirect,
  setSetting,
} from '../db/store';
import { runEditDetection, type DetectedCopy } from '../lib/detect';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { StateProgressBar } from '../components/StateProgressBar';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const RECENT_DAYS = 7;

interface DayRow {
  day: string;
  label: string;
  /** All photos taken that day (MediaStore + trashed rows). */
  total: number;
  /** done + trashed. */
  done: number;
  toEdit: number;
  staged: number;
}

/** Cheap scope counts (m0.3.1) — no asset lists, just totals. */
interface ScopeCounts {
  /** MediaStore total minus already-handled rows, clamped at 0. */
  remaining: number;
  /** DB rows in range already converged (to_edit/done, still in MediaStore). */
  handled: number;
  /** Fully done for the headline: done + trashed rows (m0.4). */
  doneTotal: number;
  /** The scope's true total: MediaStore + trashed rows (they left MediaStore). */
  grandTotal: number;
}

export function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const theme = useTheme();
  const sessionCtx = useSession();
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo'],
  });

  /** Selected scope id from the store-backed config; 'custom' = picker chip. */
  const [scope, setScope] = useState<string>('day1');
  const [scopeConfig, setScopeConfig] = useState<ScopeConfig | null>(null);
  const [sessionPrefs, setSessionPrefs] = useState<SessionPrefs>(DEFAULT_SESSION_PREFS);
  const [customFrom, setCustomFrom] = useState<Date>(new Date());
  const [customTo, setCustomTo] = useState<Date>(new Date());
  const [customName, setCustomName] = useState('');
  const [pickerFor, setPickerFor] = useState<'from' | 'to' | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [counts, setCounts] = useState<ScopeCounts | null>(null);
  /** null = not yet checked; the All-time chip stays disabled until true. */
  const [allTimeReady, setAllTimeReady] = useState<boolean | null>(null);
  const [hasResumable, setHasResumable] = useState(false);
  const [starting, setStarting] = useState(false);
  /** Perceptual-hash progress while a session is being built (m0.4). */
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  const [editCount, setEditCount] = useState(0);
  const [dayRows, setDayRows] = useState<DayRow[] | null>(null);
  const [detectionNotice, setDetectionNotice] = useState<string | null>(null);
  /** Bumped after detection changes states, to re-run the focus loaders. */
  const [refreshTick, setRefreshTick] = useState(0);
  const lastDetectionRef = useRef(0);

  /**
   * The selected scope's range, computed at call time: rolling windows
   * end at "now" (not calendar-aligned — see scopes.ts); named custom
   * scopes are fixed ranges (scopeStore.ts).
   */
  const rangeFor = useCallback(
    (id: string) => {
      const def = id === 'custom' ? undefined : scopeConfig?.scopes.find((s) => s.id === id);
      return def ? storedScopeRange(def, Date.now()) : customRange(customFrom, customTo);
    },
    [customFrom, customTo, scopeConfig],
  );

  // Store-backed scope chips + session prefs (m0.5), refreshed on focus
  // (Settings may have changed either). An invalid selection (scope
  // disabled/deleted meanwhile) falls back to the first enabled chip.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [rawScopes, prefs] = await Promise.all([
          getSetting(db, REVIEW_SCOPES_KEY),
          getSessionPrefs(db),
        ]);
        if (cancelled) return;
        const config = parseScopeConfig(rawScopes);
        setScopeConfig(config);
        setSessionPrefs(prefs);
        setScope((current) => {
          if (current === 'custom') return current;
          const stillThere = enabledScopes(config).some((s) => s.id === current);
          return stillThere ? current : (enabledScopes(config)[0]?.id ?? 'custom');
        });
      })();
      return () => {
        cancelled = true;
      };
    }, [db]),
  );

  /** Persist a named scope from the current custom range (m0.5). */
  const saveCustomScope = useCallback(() => {
    if (!scopeConfig || customName.trim() === '') return;
    const range = customRange(customFrom, customTo);
    const id = newCustomScopeId(Date.now());
    const next = addCustomScope(scopeConfig, {
      id,
      label: customName.trim(),
      startMs: range.startMs,
      endMs: range.endMs,
    });
    setScopeConfig(next);
    setCustomName('');
    setScope(id);
    void setSetting(db, REVIEW_SCOPES_KEY, serializeScopeConfig(next));
  }, [scopeConfig, customName, customFrom, customTo, db]);

  // Is there a persisted session to resume? (session may not be loaded yet)
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (sessionCtx.session) {
          setHasResumable(true);
          return;
        }
        const resumed = await sessionCtx.resumeSession();
        if (!cancelled) setHasResumable(resumed);
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionCtx.version]),
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
                // System dialog is the real gate; cancel leaves it queued.
                const deleted = await deleteAssets([head.originalAssetId]);
                if (deleted) await markTrashedDirect(db, head.originalAssetId);
                next();
              })(),
          },
          {
            text: 'Keep original',
            onPress: () =>
              void (async () => {
                await markEditDone(db, head.originalAssetId);
                next();
              })(),
          },
        ],
      );
    },
    [db],
  );

  // m0.3 edit detection — runs on app open / return to Home, throttled.
  useFocusEffect(
    useCallback(() => {
      if (!permission?.granted) return;
      const now = Date.now();
      if (now - lastDetectionRef.current < 60_000) return;
      lastDetectionRef.current = now;
      let cancelled = false;
      (async () => {
        const result = await runEditDetection(db).catch(() => null);
        if (!result || cancelled) return;
        if (result.autoDone > 0) {
          setDetectionNotice(
            result.autoDone === 1
              ? '✓ 1 edited photo detected — marked done'
              : `✓ ${result.autoDone} edited photos detected — marked done`,
          );
          setRefreshTick((t) => t + 1);
        }
        if (result.copies.length > 0) promptForCopies(result.copies);
      })();
      return () => {
        cancelled = true;
      };
    }, [db, permission?.granted, promptForCopies]),
  );

  // Edit-queue badge + recent-days progress, refreshed on focus. Both
  // respect the photo-source filter (m0.3.1).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const toEdit = await countToEdit(db);
        if (cancelled) return;
        setEditCount(toEdit);

        const src = permission?.granted ? await resolveSources(db).catch(() => null) : null;
        if (cancelled) return;
        const keys = recentDayKeys(RECENT_DAYS);
        const summaries = await getDaySummaries(db, keys[keys.length - 1], src?.roots ?? null);
        const rows: DayRow[] = [];
        for (const day of keys) {
          const dbRow = summaries.get(day);
          let msTotal = 0;
          if (permission?.granted) {
            const r = rangeOfDayKey(day);
            msTotal = await countPhotosInRange(r.startMs, r.endMs, src?.albumIds ?? null).catch(
              () => 0,
            );
          }
          // Trashed photos are gone from MediaStore, so the day's true
          // total is MediaStore + trashed rows (DB `done` includes them).
          const total = msTotal + (dbRow?.trashed ?? 0);
          if (cancelled) return;
          if (total === 0) continue;
          rows.push({
            day,
            label: labelForDayKey(day),
            total,
            done: dbRow?.done ?? 0,
            toEdit: dbRow?.toEdit ?? 0,
            staged: dbRow?.staged ?? 0,
          });
        }
        if (!cancelled) setDayRows(rows);
      })();
      return () => {
        cancelled = true;
      };
      // refreshTick re-runs this after edit detection changes states.
    }, [db, permission?.granted, refreshTick]),
  );

  // Cheap scope counts + the All-time gate, on focus and scope change.
  // No asset lists are loaded here — MediaStore totalCount queries plus
  // one DB aggregate per range (m0.3.1); the exact reviewable set is
  // paged in only when a session starts.
  useFocusEffect(
    useCallback(() => {
      if (!permission?.granted || scopeConfig === null) return;
      let cancelled = false;
      setCountsLoading(true);
      (async () => {
        try {
          const src = await resolveSources(db);
          if (cancelled) return;

          const range = rangeFor(scope);
          const [msCount, sc] = await Promise.all([
            countPhotosInRange(range.startMs, range.endMs, src.albumIds),
            getStateCountsInScope(db, { startMs: range.startMs, endMs: range.endMs }, src.roots),
          ]);
          // "Handled" = to_edit + done rows (still in MediaStore; trashed
          // rows left it, so they are excluded — m0.3.1 accounting).
          const handled = sc.toEdit + sc.done;

          // All-time gate: ranges nest, so a clear last-year means only
          // the older backlog is left — that's when All time unlocks.
          const year = rollingRange('year1', Date.now());
          const [msYear, scYear] = await Promise.all([
            countPhotosInRange(year.startMs, year.endMs, src.albumIds),
            getStateCountsInScope(db, { startMs: year.startMs, endMs: year.endMs }, src.roots),
          ]);
          if (cancelled) return;
          const unlocked = allTimeUnlocked(
            remainingToReview(msYear, scYear.toEdit + scYear.done),
          );
          setAllTimeReady(unlocked);
          if (scope === 'all' && !unlocked) {
            // New photos re-locked the gate while it was selected.
            setScope('year1');
            return; // effect re-runs with the new scope
          }
          setCounts({
            remaining: remainingToReview(msCount, handled),
            handled: Math.min(handled, msCount),
            doneTotal: sc.done + sc.trashed,
            grandTotal: msCount + sc.trashed,
          });
        } catch {
          if (!cancelled) setCounts({ remaining: 0, handled: 0, doneTotal: 0, grandTotal: 0 });
        } finally {
          if (!cancelled) setCountsLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [db, permission?.granted, scope, rangeFor, refreshTick]),
  );

  const onPickerChange = useCallback(
    (event: DateTimePickerEvent, date?: Date) => {
      const which = pickerFor;
      setPickerFor(null);
      if (event.type !== 'set' || !date || !which) return;
      if (which === 'from') setCustomFrom(date);
      else setCustomTo(date);
    },
    [pickerFor],
  );

  const startReview = useCallback(async () => {
    if (!counts || counts.remaining === 0 || starting) return;
    const begin = async () => {
      setStarting(true);
      try {
        // m0.5: bank the replaced session's keep decisions FIRST so the
        // loader below sees them as handled — decisions are never
        // silently discarded (staged culls stay staged-interim and are
        // re-earned per the m0.2 rule).
        await bankActiveSessionKeepers(db);
        // Recompute the range and load the actual photos now — paged,
        // state-filtered, capped per the Sessions settings
        // (reviewLoader.ts) so huge scopes can't blow up memory.
        const range = rangeFor(scope);
        const src = await resolveSources(db);
        const prefs = await getSessionPrefs(db);
        const { reviewable } = await loadReviewablePhotos(
          db,
          range.startMs,
          range.endMs,
          src.albumIds,
          prefs,
        );
        if (reviewable.length === 0) {
          setRefreshTick((t) => t + 1); // counts were stale — refresh them
          return;
        }
        await sessionCtx.startSession(
          range.label,
          range.startMs,
          range.endMs,
          reviewable,
          (done, total) => setAnalyzing({ done, total }),
        );
        navigation.navigate('Groups');
      } finally {
        setStarting(false);
        setAnalyzing(null);
      }
    };
    if (hasResumable) {
      // m0.5 order/roles: destructive "Start new" leftmost, Cancel in the
      // middle, "Continue existing" as the rightmost default action.
      Alert.alert(
        'Replace unfinished session?',
        'Starting a new session keeps every decision you already made — reviewed keepers ' +
          'are saved, and the unreviewed rest waits for a later session. Nothing gets deleted.',
        [
          { text: 'Start new', style: 'destructive', onPress: () => void begin() },
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Continue existing',
            isPreferred: true,
            onPress: () => navigation.navigate('Groups'),
          },
        ],
      );
    } else {
      await begin();
    }
  }, [counts, starting, hasResumable, sessionCtx, scope, rangeFor, db, navigation]);

  const openProgress = useCallback(() => {
    // Compute the rolling range at tap time — same convention as reviews.
    const range = rangeFor(scope);
    navigation.navigate('Progress', {
      label: range.label,
      startMs: range.startMs,
      endMs: range.endMs,
    });
  }, [navigation, rangeFor, scope]);

  const scopeLabel = rangeFor(scope).label;
  const capApplies = counts !== null && counts.remaining > sessionPrefs.cap;
  const drawWord = sessionPrefs.order === 'oldest' ? 'oldest' : 'newest';
  const donePctValue =
    counts && counts.grandTotal > 0
      ? Math.round((counts.doneTotal / counts.grandTotal) * 100)
      : null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>Afterglow Companion</Text>
        <Pressable
          style={styles.gearButton}
          hitSlop={8}
          accessibilityLabel="Settings"
          onPress={() => navigation.navigate('Settings')}
        >
          {/* m0.5: emoji gear — the ⚙ text glyph read as an eye/sun. */}
          <Text style={styles.gearIcon}>⚙️</Text>
        </Pressable>
      </View>
      <Text style={styles.subtitle}>Clear your photos down to the keepers.</Text>

      {detectionNotice && (
        <Pressable style={styles.notice} onPress={() => setDetectionNotice(null)}>
          <Text style={styles.noticeText}>{detectionNotice}</Text>
          <Text style={styles.noticeDismiss}>dismiss</Text>
        </Pressable>
      )}

      {!permission?.granted && (
        <View style={styles.card}>
          <Text style={styles.cardText}>
            Afterglow needs access to your photos to review them. Nothing is ever deleted
            without your explicit confirmation.
          </Text>
          <BigButton
            label={permission?.canAskAgain === false ? 'Enable photo access in Settings' : 'Allow photo access'}
            color={theme.accent}
            textColor={theme.onAccent}
            onPress={() => void requestPermission()}
          />
        </View>
      )}

      {hasResumable && sessionCtx.session && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Unfinished session — {sessionCtx.label}</Text>
          <Text style={styles.cardText}>
            {(() => {
              const s = sessionCtx.session.summary();
              return `${s.total - s.unreviewed} of ${s.total} photos reviewed`;
            })()}
          </Text>
          <BigButton
            label="Resume review"
            color={theme.accent}
            textColor={theme.onAccent}
            onPress={() => navigation.navigate('Groups')}
          />
        </View>
      )}

      <Pressable style={styles.editQueueRow} onPress={() => navigation.navigate('EditQueue')}>
        <Text style={styles.editQueueIcon}>✎</Text>
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

      <Text style={styles.sectionLabel}>Review scope</Text>
      <View style={styles.scopeWrap}>
        {[
          ...(scopeConfig ? enabledScopes(scopeConfig) : []),
          { id: 'custom', label: 'Custom', kind: 'picker' as const },
        ].map((def) => {
          const disabled = def.id === 'all' && allTimeReady !== true;
          const active = scope === def.id;
          return (
            <Pressable
              key={def.id}
              disabled={disabled}
              onPress={() => setScope(def.id)}
              style={[
                styles.scopeChip,
                active && { backgroundColor: theme.accent, borderColor: theme.accent },
                disabled && styles.scopeChipDisabled,
              ]}
            >
              <Text
                style={[
                  styles.scopeChipText,
                  active && { color: theme.onAccent },
                  disabled && styles.scopeChipTextDisabled,
                ]}
              >
                {def.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {permission?.granted && allTimeReady === false && (
        <Text style={styles.gateHint}>
          All time unlocks when nothing is left to review in the last year — finish the last
          year first.
        </Text>
      )}

      {scope === 'custom' && (
        <>
          <View style={styles.customRow}>
            <Pressable style={styles.dateField} onPress={() => setPickerFor('from')}>
              <Text style={styles.dateFieldLabel}>From</Text>
              <Text style={styles.dateFieldValue}>{customFrom.toLocaleDateString()}</Text>
            </Pressable>
            <Pressable style={styles.dateField} onPress={() => setPickerFor('to')}>
              <Text style={styles.dateFieldLabel}>To</Text>
              <Text style={styles.dateFieldValue}>{customTo.toLocaleDateString()}</Text>
            </Pressable>
          </View>
          {/* m0.5: name the range to keep it as a scope chip ("Japan"). */}
          <View style={styles.customRow}>
            <TextInput
              style={styles.nameField}
              placeholder="Name this range to keep it (e.g. Japan)"
              placeholderTextColor={colors.textDim}
              value={customName}
              onChangeText={setCustomName}
              maxLength={40}
            />
            <Pressable
              style={[
                styles.saveScopeButton,
                customName.trim() !== '' && { backgroundColor: theme.accent, borderColor: theme.accent },
              ]}
              disabled={customName.trim() === ''}
              onPress={saveCustomScope}
            >
              <Text
                style={[
                  styles.saveScopeText,
                  customName.trim() !== '' && { color: theme.onAccent },
                ]}
              >
                Save scope
              </Text>
            </Pressable>
          </View>
        </>
      )}

      {pickerFor && (
        <DateTimePicker
          value={pickerFor === 'from' ? customFrom : customTo}
          mode="date"
          onChange={onPickerChange}
        />
      )}

      {permission?.granted && counts && counts.grandTotal > 0 && donePctValue !== null && (
        <Text style={styles.headline}>
          {counts.doneTotal} of {counts.grandTotal} done · {donePctValue}%
        </Text>
      )}

      {permission?.granted && (
        <Pressable style={styles.progressRow} onPress={openProgress}>
          <Text style={styles.progressIcon}>◔</Text>
          <View style={styles.progressBody}>
            <Text style={styles.progressTitle}>Progress</Text>
            <Text style={styles.progressHint}>
              {counts === null || countsLoading
                ? `${scopeLabel} · counting…`
                : counts.grandTotal === 0
                  ? `${scopeLabel} · no photos yet`
                  : `${scopeLabel} · ${donePctValue}% done`}
            </Text>
          </View>
          <Text style={[styles.progressChevron, { color: theme.accent }]}>›</Text>
        </Pressable>
      )}

      {permission?.granted && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{scopeLabel}</Text>
          {countsLoading && <Text style={styles.cardText}>Counting photos…</Text>}
          {!countsLoading && counts && (
            <Text style={styles.cardText}>
              {counts.remaining === 0
                ? counts.handled > 0
                  ? `All ${counts.handled} photos in this range are already handled ✦`
                  : 'No photos in this range.'
                : `${counts.remaining} to review` +
                  (counts.handled > 0 ? ` · ${counts.handled} already handled` : '') +
                  (capApplies
                    ? ` · sessions take the ${drawWord} ${sessionPrefs.cap} at a time`
                    : '')}
            </Text>
          )}
          <BigButton
            label={
              starting
                ? analyzing
                  ? `Analyzing photos… ${analyzing.done}/${analyzing.total}`
                  : 'Loading photos…'
                : !counts || counts.remaining === 0
                  ? 'Start culling'
                  : capApplies
                    ? `Start culling · ${drawWord} ${sessionPrefs.cap} of ${counts.remaining}`
                    : `Start culling · ${counts.remaining} to review`
            }
            color={colors.keep}
            disabled={countsLoading || starting || !counts || counts.remaining === 0}
            onPress={() => void startReview()}
          />
        </View>
      )}

      {permission?.granted && dayRows && dayRows.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Recent days</Text>
          {dayRows.map((row) => {
            const pct = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
            return (
              <Pressable
                key={row.day}
                style={styles.dayRow}
                onPress={() => navigation.navigate('DayProgress', { day: row.day })}
              >
                <View style={styles.dayRowHeader}>
                  <Text style={styles.dayRowTitle}>{row.label}</Text>
                  <Text style={styles.dayRowPct}>
                    {row.done === row.total ? 'done ✦' : `${row.done}/${row.total} · ${pct}%`}
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
                {(row.toEdit > 0 || row.staged > 0) && (
                  <Text style={styles.dayRowHint}>
                    {[
                      row.toEdit > 0 ? `${row.toEdit} to edit` : null,
                      row.staged > 0 ? `${row.staged} staged cull` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                )}
              </Pressable>
            );
          })}
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
  sectionLabel: { color: colors.textDim, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
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
  editQueueIcon: { color: colors.edit, fontSize: 22, fontWeight: '700' },
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
