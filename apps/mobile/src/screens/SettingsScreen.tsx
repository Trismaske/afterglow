/**
 * Settings (m0.4, grown in m0.5), reached from the gear on Home:
 * photo source (→ the existing picker), the m0.5 "Sessions" section
 * (max photos per session / don't-split-groups / draw order —
 * accent color
 * (accentTheme.ts + ThemeProvider, live-applied), a reset for
 * suppressed confirmation dialogs, and the app version. Values persist
 * in the m0.3.1 settings table.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import Constants from 'expo-constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { resolveSources } from '../lib/sourceCatalog';
import {
  COVERAGE_GOAL_CHOICES,
  COVERAGE_GOAL_KEY,
  COVERAGE_GOAL_LABELS,
  parseCoverageGoal,
  serializeCoverageGoal,
  type CoverageGoal,
} from '../lib/coverageGoal';
import {
  DAILY_GOAL_CHOICES,
  DAILY_GOAL_KEY,
  DEFAULT_DAILY_GOAL,
  parseCustomDailyGoal,
  parseDailyGoal,
  serializeDailyGoal,
} from '../lib/dailyGoal';
import {
  GROUPING_STRICTNESS_KEY,
  parseStrictness,
  serializeStrictness,
  STRICTNESS_STEPS,
  type StrictnessStep,
} from '../lib/groupingPrefs';
import {
  getScanStatus,
  requestRescan,
  SCAN_VERIFIED_AT_KEY,
  subscribeScanStatus,
  supersedeScan,
  type ScanStatus,
} from '../scan/scanRunner';
import { scanStatusLine } from '../lib/scanSkip';
import { countTrackedPhotos } from '../db/store';
import { applyGroupingSettingChange } from '../db/store';
import { COMPARE_AUTO_CULL_KEY, serializeCompareDuelPref } from '../lib/comparePrefs';
import { getSetting, setSetting } from '../db/store';
import { ACCENT_PRESETS } from '../lib/accentTheme';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * The two facts the Library scan row states. FAILS CLOSED, quietly: an
 * unreadable scope returns null and the row keeps what it had, rather
 * than counting the whole library and calling it the user's selection.
 */
async function readScanFacts(
  db: SQLiteDatabase,
  roots: readonly string[] | null,
): Promise<{ verifiedAt: number | null; corpus: number } | null> {
  try {
    const [rawAt, corpus] = await Promise.all([
      getSetting(db, SCAN_VERIFIED_AT_KEY),
      countTrackedPhotos(db, roots),
    ]);
    const parsed = rawAt === null ? NaN : Number(rawAt);
    return { verifiedAt: Number.isFinite(parsed) ? parsed : null, corpus };
  } catch {
    return null;
  }
}

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { refresh } = useReview();
  const theme = useTheme();
  const systemAvailable = theme.systemAccent !== null;
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<CoverageGoal | null>(null);
  const [strictness, setStrictness] = useState<StrictnessStep | null>(null);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [customGoalOpen, setCustomGoalOpen] = useState(false);
  const [customGoalText, setCustomGoalText] = useState('');
  const [customGoalError, setCustomGoalError] = useState<string | null>(null);
  // "Are my numbers current?" answered with a fact. Home already
  // re-checks on open and on foreground return, so a bare refresh button
  // would imply a staleness that is not the normal state (m0.8.2).
  const [scanFacts, setScanFacts] = useState<{ verifiedAt: number | null; corpus: number } | null>(
    null,
  );
  // Seeded from the LIVE snapshot (codex r7): subscribe-only missed an
  // already-running scan, leaving "Rescan library" enabled — pressing it
  // superseded and discarded real scan work.
  const [scanStatus, setScanStatus] = useState<ScanStatus>(getScanStatus);
  const customGoalActive =
    goal !== null && !(DAILY_GOAL_CHOICES as readonly number[]).includes(goal);

  // While a strictness change applies (setting+reset txn, refresh,
  // possibly a rollback), EVERY exit is blocked — leaving mid-apply would
  // let the cached old-threshold queue take decisions that freeze a lone
  // stale member before the refresh removes the obsolete group.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (applyingRef.current) event.preventDefault();
    });
    return unsubscribe;
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [rawGoal, rawCoverage, rawStrictness] = await Promise.all([
          getSetting(db, DAILY_GOAL_KEY),
          getSetting(db, COVERAGE_GOAL_KEY),
          getSetting(db, GROUPING_STRICTNESS_KEY),
        ]);
        if (!cancelled) {
          // FENCED against user writes (codex r9): a selection made while
          // this read was in flight must not be overwritten by the read's
          // older value — the write generations say whether the user has
          // acted since focus.
          if (goalWriteGen.current === 0) {
            const durableGoal = parseDailyGoal(rawGoal);
            durableGoalRef.current = durableGoal;
            setGoal(durableGoal);
          }
          if (coverageWriteGen.current === 0) {
            const durableCoverage = parseCoverageGoal(rawCoverage);
            durableCoverageRef.current = durableCoverage;
            setCoverage(durableCoverage);
          }
          setStrictness(parseStrictness(rawStrictness));
        }
        // Resolving sources needs MediaStore access; without permission
        // (or on failure) the row still navigates, just without a label.
        // A FAILED resolution also bypasses the facts read entirely:
        // passing null roots there means "whole library" (readScanFacts'
        // contract), which would replace the selected-source corpus count
        // with the global one. A successfully resolved all-folders
        // selection legitimately carries null roots and still reads.
        const src = await resolveSources(db).catch((error): null => {
          console.warn('[settings] source resolution failed — scan facts kept:', String(error));
          return null;
        });
        if (!cancelled) setSourceLabel(src?.label ?? null);
        if (src === null) return;
        const facts = await readScanFacts(db, src.roots);
        if (!cancelled && facts) setScanFacts(facts);
      })();
      return () => {
        cancelled = true;
      };
    }, [db]),
  );

  // The row's whole job is answering "are my numbers current?", so it
  // must not go stale itself: a pass finishing while Settings is open
  // re-reads the facts rather than leaving the line it just invalidated.
  useEffect(
    () =>
      subscribeScanStatus((next) => {
        setScanStatus(next);
        if (next.phase !== 'done') return;
        void (async () => {
          // Same guard as the focus loader: a failed resolution must not
          // widen the facts read to the whole library — keep the line.
          const src = await resolveSources(db).catch((error): null => {
            console.warn('[settings] source resolution failed — scan facts kept:', String(error));
            return null;
          });
          if (src === null) return;
          const facts = await readScanFacts(db, src.roots);
          if (facts) setScanFacts(facts);
        })();
      }),
    [db],
  );

  // Goal/coverage persists handle rejection (codex r7): fired-and-
  // forgotten, a failed write left the UI showing an unsaved value.
  // On rejection the local state reverts to the last durable value and
  // the standard "Change not saved" alert says so.
  const surfaceSettingWriteError = useCallback((error: unknown) => {
    Alert.alert(
      'Change not saved',
      `Afterglow could not write the change to its database. Nothing was changed — please retry the action.\n\n${error instanceof Error ? error.message : String(error)}`,
    );
  }, []);

  // GENERATION-FENCED rollbacks (codex r8) anchored to DURABLE state
  // (codex r9): the chips stay actionable while a write is in flight, so
  // a STALE write's rejection must not roll back a NEWER choice — and a
  // rollback must land on the last value known PERSISTED, never on an
  // earlier optimistic render that may itself have failed.
  const goalWriteGen = useRef(0);
  const durableGoalRef = useRef<number | null>(null);
  /** The write generation the durable ref reflects: a SUPERSEDED write's
   * success must still advance the baseline when it is newer than the
   * last recorded one (codex r10 — tap A, tap B: A commits after B was
   * allocated; if B then rejects, the rollback must land on A, which IS
   * durable, not on the pre-A value). */
  const durableGoalGen = useRef(0);
  const pickGoal = useCallback(
    (value: number) => {
      const gen = ++goalWriteGen.current;
      setGoal(value);
      void setSetting(db, DAILY_GOAL_KEY, serializeDailyGoal(value)).then(
        () => {
          if (gen > durableGoalGen.current) {
            durableGoalGen.current = gen;
            durableGoalRef.current = value;
          }
        },
        (error: unknown) => {
          if (gen !== goalWriteGen.current) return; // superseded — the newer write owns the state
          if (durableGoalRef.current !== null) setGoal(durableGoalRef.current);
          surfaceSettingWriteError(error);
        },
      );
    },
    [db, surfaceSettingWriteError],
  );

  const openCustomGoal = useCallback(() => {
    setCustomGoalText(String(goal));
    setCustomGoalError(null);
    setCustomGoalOpen(true);
  }, [goal]);

  const saveCustomGoal = useCallback(() => {
    const parsed = parseCustomDailyGoal(customGoalText);
    if ('error' in parsed) {
      setCustomGoalError(parsed.error);
      return;
    }
    pickGoal(parsed.goal);
    setCustomGoalOpen(false);
  }, [customGoalText, pickGoal]);

  const coverageWriteGen = useRef(0);
  const durableCoverageRef = useRef<CoverageGoal | null>(null);
  const durableCoverageGen = useRef(0);
  const pickCoverage = useCallback(
    (value: CoverageGoal) => {
      const gen = ++coverageWriteGen.current;
      setCoverage(value);
      void setSetting(db, COVERAGE_GOAL_KEY, serializeCoverageGoal(value)).then(
        () => {
          if (gen > durableCoverageGen.current) {
            durableCoverageGen.current = gen;
            durableCoverageRef.current = value;
          }
        },
        (error: unknown) => {
          if (gen !== coverageWriteGen.current) return; // superseded (codex r8/r9/r10 — see pickGoal)
          if (durableCoverageRef.current !== null) setCoverage(durableCoverageRef.current);
          surfaceSettingWriteError(error);
        },
      );
    },
    [db, surfaceSettingWriteError],
  );

  const pickStrictness = useCallback(
    (step: StrictnessStep) => {
      // The continuous scan re-derives every not-yet-reviewed group on each
      // pass, so a strictness change ALWAYS regroups them on the next scan
      // — an "only new photos" mode would need per-photo threshold
      // provenance the schema does not keep. Confirm honestly instead of
      // promising an opt-out the next launch would break.
      Alert.alert(
        'Change grouping strictness?',
        'Photos you have not reviewed yet will be regrouped under the new setting. Reviewed groups and photos you made single are never touched.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Change & regroup',
            onPress: () => {
              const previous = strictness;
              // Supersede the in-flight scan FIRST: it must stop writing
              // old-threshold groups before the reset/refresh below, or it
              // could repopulate exactly what the reset cleared.
              supersedeScan();
              setStrictness(step);
              setApplying(true);
              applyingRef.current = true;
              // Setting + assignment reset commit ATOMICALLY (process
              // death between them would strand old-threshold groups
              // under the new setting).
              void applyGroupingSettingChange(
                db,
                GROUPING_STRICTNESS_KEY,
                serializeStrictness(step),
              )
                // Refresh BEFORE the rescan: the rendered queue still
                // shows the reset groups — a decision on one of those
                // stale members would permanently lose its whole-group
                // boundary (the member freezes alone, companions
                // reassign separately).
                .then(() => refresh())
                .then(() => {
                  void requestRescan(db);
                  showToast('Regrouping in the background');
                })
                .catch(async () => {
                  // ROLL BACK: the preference may already be durable and
                  // assignments may already be deleted. Restore the
                  // setting, then REBUILD under it — a rescan is the only
                  // way back to a populated queue — and refresh. A FAILED
                  // restore must say so: the new threshold is then the
                  // durable one and the rescan rebuilds under it.
                  let restored = false;
                  if (previous) {
                    restored = await applyGroupingSettingChange(
                      db,
                      GROUPING_STRICTNESS_KEY,
                      serializeStrictness(previous),
                    ).then(
                      () => true,
                      () => false,
                    );
                    if (restored) setStrictness(previous);
                  }
                  // COMPLETE the reset-state refresh before anything else — the
                  // deleted groups must leave the rendered queue before the user
                  // can navigate back and decide one (freezing a member alone).
                  const rerendered = await refresh().then(
                    () => true,
                    () => false,
                  );
                  void requestRescan(db);
                  showToast(
                    restored && rerendered
                      ? 'Could not change strictness — restored; regrouping'
                      : restored
                        ? 'Strictness restored, but the queue could not refresh — reopen review'
                        : 'Strictness change failed midway — check Settings; regrouping',
                  );
                })
                .finally(() => {
                  setApplying(false);
                  applyingRef.current = false;
                });
            },
          },
        ],
      );
    },
    [db, refresh, strictness],
  );

  const resetConfirmations = useCallback(() => {
    // The toast only fires on a COMMITTED write; a rejection says so
    // instead of silently keeping auto-cull on (codex r7 sibling of the
    // goal/coverage persist handling).
    void setSetting(db, COMPARE_AUTO_CULL_KEY, serializeCompareDuelPref('ask')).then(
      () => showToast('Confirmation dialogs will ask again'),
      (error: unknown) => {
        console.warn('[settings] confirmation reset failed:', String(error));
        showToast('Could not save — confirmation dialogs unchanged');
      },
    );
  }, [db]);

  const version = Constants.expoConfig?.version ?? '?';

  return (
    <>
      <Modal visible={applying} transparent animationType="fade">
        {/* Full-screen touch shield while the strictness apply/rollback
            chain runs — paired with the beforeRemove navigation block. */}
        <View style={styles.applyingOverlay}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={styles.applyingText}>Applying grouping change…</Text>
        </View>
      </Modal>
      <Modal
        visible={customGoalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCustomGoalOpen(false)}
      >
        <View style={styles.dialogScrim}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Photos per day</Text>
            <TextInput
              value={customGoalText}
              onChangeText={(text) => {
                setCustomGoalText(text);
                setCustomGoalError(null);
              }}
              onSubmitEditing={saveCustomGoal}
              keyboardType="number-pad"
              returnKeyType="done"
              autoFocus
              selectTextOnFocus
              style={[styles.dialogInput, { borderColor: theme.accent }]}
              placeholder={String(DEFAULT_DAILY_GOAL)}
              placeholderTextColor={colors.textDim}
            />
            {customGoalError !== null && <Text style={styles.dialogError}>{customGoalError}</Text>}
            <View style={styles.dialogButtons}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => setCustomGoalOpen(false)}
                hitSlop={8}
              >
                <Text style={styles.dialogButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dialogButton} onPress={saveCustomGoal} hitSlop={8}>
                <Text style={[styles.dialogButtonText, { color: theme.accent }]}>Set goal</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      >
        <Text style={styles.sectionLabel}>Photos</Text>
        <Pressable style={styles.row} onPress={() => navigation.navigate('SourcePicker')}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Photo source</Text>
            <Text style={styles.rowHint} numberOfLines={1}>
              {sourceLabel ?? 'Which folders feed your reviews'}
            </Text>
          </View>
          <Text style={[styles.chevron, { color: theme.accent }]}>›</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>Daily goal</Text>
        <Text style={styles.hint}>
          A gentle target for photos reviewed per day — it drives the Home ring and streaks, and
          never blocks anything.
        </Text>
        <View style={styles.chipRow}>
          {DAILY_GOAL_CHOICES.map((value) => {
            const active = goal === value;
            return (
              <Pressable
                key={value}
                onPress={() => pickGoal(value)}
                style={[
                  styles.chip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.chipText, active && { color: theme.onAccent }]}>{value}</Text>
              </Pressable>
            );
          })}
          {/* Any goal off the chips shows its number here, so the current
              setting is never invisible. */}
          <Pressable
            onPress={openCustomGoal}
            style={[
              styles.chip,
              customGoalActive && { backgroundColor: theme.accent, borderColor: theme.accent },
            ]}
          >
            <Text style={[styles.chipText, customGoalActive && { color: theme.onAccent }]}>
              {customGoalActive ? `${goal} · Custom` : 'Custom'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.sectionLabel}>Keeping up</Text>
        <Text style={styles.hint}>
          A second, independent goal: leave nothing unreviewed from the last day or two — or aim for
          the whole library. Photos without a capture date count only under “All time”.
        </Text>
        <View style={styles.chipRow}>
          {COVERAGE_GOAL_CHOICES.map((value) => {
            const active = coverage === value;
            return (
              <Pressable
                key={value}
                onPress={() => pickCoverage(value)}
                style={[
                  styles.chip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.chipText, active && { color: theme.onAccent }]}>
                  {COVERAGE_GOAL_LABELS[value]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>Grouping</Text>
        <Text style={styles.hint}>
          How similar photos must look to land in the same group. Stricter makes smaller, tighter
          groups; looser catches more near-duplicates.
        </Text>
        <View style={styles.chipRow}>
          {STRICTNESS_STEPS.map((step) => {
            const active = strictness?.id === step.id;
            return (
              <Pressable
                key={step.id}
                onPress={() => pickStrictness(step)}
                style={[
                  styles.chip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.chipText, active && { color: theme.onAccent }]}>
                  {step.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>Appearance</Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>Accent color</Text>
          <Text style={styles.explainer}>
            Colors the buttons, chips, and highlights. System follows your phone's Material You
            palette, so it changes with your wallpaper.
          </Text>
          <View style={styles.accentWrap}>
            <Pressable
              disabled={!systemAvailable}
              onPress={() => theme.setChoice('system')}
              style={[
                styles.accentChip,
                theme.choice === 'system' && { borderColor: theme.accent },
                !systemAvailable && styles.accentChipDisabled,
              ]}
            >
              <View
                style={[
                  styles.accentSwatch,
                  { backgroundColor: theme.systemAccent ?? colors.surfaceRaised },
                ]}
              />
              <Text
                style={[styles.accentLabel, theme.choice === 'system' && styles.accentLabelActive]}
              >
                System
              </Text>
            </Pressable>
            {ACCENT_PRESETS.map((preset) => {
              const active = theme.choice === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  onPress={() => theme.setChoice(preset.id)}
                  style={[styles.accentChip, active && { borderColor: theme.accent }]}
                >
                  <View style={[styles.accentSwatch, { backgroundColor: preset.hex }]} />
                  <Text style={[styles.accentLabel, active && styles.accentLabelActive]}>
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!systemAvailable && (
            <Text style={styles.stepHint}>
              System needs Android 12 or newer — the fixed colors below still work.
            </Text>
          )}
        </View>

        <Text style={styles.sectionLabel}>Library scan</Text>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>
              {scanFacts === null && scanStatus.phase !== 'scanning'
                ? 'Checking…'
                : scanStatusLine({
                    verifiedAt: scanFacts?.verifiedAt ?? null,
                    corpus: scanFacts?.corpus ?? 0,
                    running:
                      scanStatus.phase === 'scanning'
                        ? { scanned: scanStatus.scanned, total: scanStatus.total }
                        : null,
                  })}
            </Text>
            <Text style={styles.rowHint}>
              Afterglow re-checks your library every time you open it. A full pass re-reads every
              photo — normally unnecessary, but it is the fix if these numbers look wrong.
            </Text>
          </View>
        </View>
        <Pressable
          style={[styles.row, scanStatus.phase === 'scanning' && styles.rowDisabled]}
          disabled={scanStatus.phase === 'scanning'}
          onPress={() => {
            void requestRescan(db);
            showToast('Rescanning your library…');
          }}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, { color: theme.accent }]}>
              {scanStatus.phase === 'scanning' ? 'Scan in progress' : 'Rescan library'}
            </Text>
          </View>
        </Pressable>

        <Text style={styles.sectionLabel}>Confirmations</Text>
        <Pressable style={styles.row} onPress={resetConfirmations}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Reset confirmation dialogs</Text>
            <Text style={styles.rowHint}>
              Dialogs skipped with "Don't ask again" (compare auto-cull) ask again.
            </Text>
          </View>
        </Pressable>

        <Text style={styles.sectionLabel}>About</Text>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Afterglow</Text>
            <Text style={styles.rowHint}>Version {version}</Text>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  rowDisabled: { opacity: 0.5 },
  content: { padding: 20, gap: 12 },
  hint: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginBottom: 4 },
  applyingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  applyingText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dialogScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 14,
  },
  dialogTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  dialogInput: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: touch.action,
  },
  dialogError: { color: colors.cull, fontSize: 13 },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dialogButton: { minHeight: touch.action, paddingHorizontal: 16, justifyContent: 'center' },
  dialogButtonText: { color: colors.textDim, fontSize: 15, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    minHeight: 56,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  rowHint: { color: colors.textDim, fontSize: 13 },
  chevron: { fontSize: 22, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  explainer: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  stepHint: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
  accentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  accentChip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: touch.radius,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  accentChipDisabled: { opacity: 0.4 },
  accentSwatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.35)',
  },
  accentLabel: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  accentLabelActive: { color: colors.text },
});
