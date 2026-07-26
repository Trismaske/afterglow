/**
 * Settings (m0.4, grown in m0.5), reached from the gear on Home:
 * photo source (→ the existing picker), the m0.5 "Sessions" section
 * (max photos per session / don't-split-groups / draw order —
 * accent color
 * (accentTheme.ts + ThemeProvider, live-applied), a reset for
 * suppressed confirmation dialogs, and the app version. Values persist
 * in the m0.3.1 settings table.
 */
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import Constants from 'expo-constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { resolveSources } from '../lib/sourceCatalog';
import {
  DAILY_GOAL_CHOICES,
  DAILY_GOAL_KEY,
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
import { requestRescan, supersedeScan } from '../scan/scanRunner';
import { resetUnreviewedGroups } from '../db/store';
import { COMPARE_AUTO_CULL_KEY, serializeCompareAutoCull } from '../lib/comparePrefs';
import { getSetting, setSetting } from '../db/store';
import { ACCENT_PRESETS } from '../lib/accentTheme';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { refresh } = useReview();
  const theme = useTheme();
  const systemAvailable = theme.systemAccent !== null;
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [strictness, setStrictness] = useState<StrictnessStep | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [rawGoal, rawStrictness] = await Promise.all([
          getSetting(db, DAILY_GOAL_KEY),
          getSetting(db, GROUPING_STRICTNESS_KEY),
        ]);
        if (!cancelled) {
          setGoal(parseDailyGoal(rawGoal));
          setStrictness(parseStrictness(rawStrictness));
        }
        // Resolving sources needs MediaStore access; without permission
        // (or on failure) the row still navigates, just without a label.
        const src = await resolveSources(db).catch(() => null);
        if (!cancelled) setSourceLabel(src?.label ?? null);
      })();
      return () => {
        cancelled = true;
      };
    }, [db]),
  );

  const pickGoal = useCallback(
    (value: number) => {
      setGoal(value);
      void setSetting(db, DAILY_GOAL_KEY, serializeDailyGoal(value));
    },
    [db],
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
              void setSetting(db, GROUPING_STRICTNESS_KEY, serializeStrictness(step))
                .then(() => resetUnreviewedGroups(db))
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
                    restored = await setSetting(
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
                });
            },
          },
        ],
      );
    },
    [db, refresh, strictness],
  );

  const resetConfirmations = useCallback(() => {
    void setSetting(db, COMPARE_AUTO_CULL_KEY, serializeCompareAutoCull(false)).then(() =>
      showToast('Confirmation dialogs will ask again'),
    );
  }, [db]);

  const version = Constants.expoConfig?.version ?? '?';

  return (
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
        A gentle target for photos reviewed per day — it drives the Home ring and streaks, and never
        blocks anything.
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
          <Text style={styles.rowTitle}>Afterglow Companion</Text>
          <Text style={styles.rowHint}>Version {version}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 12 },
  hint: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginBottom: 4 },
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
  stepWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepChip: {
    minHeight: 44,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepChipText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  stepHint: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
  },
  sliderLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sliderValueLabel: { fontSize: 13, fontWeight: '700' },
  resetRow: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  resetText: { fontSize: 14, fontWeight: '700' },
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
