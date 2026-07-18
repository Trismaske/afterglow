/**
 * Settings (m0.4, grown in m0.5), reached from the gear on Home:
 * photo source (→ the existing picker), the m0.5 "Sessions" section
 * (max photos per session / don't-split-groups / draw order —
 * sessionPrefs.ts, consumed by reviewLoader), similarity threshold for
 * group refinement (chips + m0.5 fine-tune slider, similarityPrefs.ts),
 * the m0.5 review-scope manager (scopeStore.ts), accent color
 * (accentTheme.ts + ThemeProvider, live-applied), a reset for
 * suppressed confirmation dialogs, and the app version. Values persist
 * in the m0.3.1 settings table.
 */
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import Constants from 'expo-constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { resolveSources } from '../lib/sourceCatalog';
import {
  exactStep,
  MAX_SIMILARITY_THRESHOLD,
  parseSimilarityThreshold,
  serializeSimilarityThreshold,
  SIMILARITY_STEPS,
  SIMILARITY_THRESHOLD_KEY,
  thresholdLabel,
} from '../lib/similarityPrefs';
import {
  parseReviewOrder,
  parseSessionCap,
  parseWholeGroups,
  serializeReviewOrder,
  serializeSessionCap,
  serializeWholeGroups,
  SESSION_CAP_CHOICES,
  SESSION_CAP_KEY,
  SESSION_ORDER_KEY,
  SESSION_WHOLE_GROUPS_KEY,
  type ReviewOrder,
} from '../lib/sessionPrefs';
import {
  parseScopeConfig,
  removeScope,
  resetScopeConfig,
  REVIEW_SCOPES_KEY,
  serializeScopeConfig,
  setScopeEnabled,
  type ScopeConfig,
  type StoredScope,
} from '../lib/scopeStore';
import { COMPARE_AUTO_CULL_KEY, serializeCompareAutoCull } from '../lib/comparePrefs';
import { getSetting, setSetting } from '../db/store';
import { ACCENT_PRESETS } from '../lib/accentTheme';
import { formatDay } from '../lib/dates';
import { showToast } from '../lib/toast';
import { FineSlider } from '../components/FineSlider';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

function scopeSubtitle(scope: StoredScope): string {
  switch (scope.kind) {
    case 'rolling':
      return scope.days === 1 ? 'Rolling · last 24 hours' : `Rolling · last ${scope.days} days`;
    case 'all':
      return 'Everything, once the last year is clear';
    case 'range':
      return `${formatDay(scope.startMs)} – ${formatDay(scope.endMs)}`;
  }
}

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const theme = useTheme();
  const systemAvailable = theme.systemAccent !== null;
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [sessionCap, setSessionCap] = useState<number | null>(null);
  const [wholeGroups, setWholeGroups] = useState<boolean>(true);
  const [reviewOrder, setReviewOrder] = useState<ReviewOrder>('oldest');
  const [scopeConfig, setScopeConfig] = useState<ScopeConfig | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [rawThreshold, rawCap, rawWhole, rawOrder, rawScopes] = await Promise.all([
          getSetting(db, SIMILARITY_THRESHOLD_KEY),
          getSetting(db, SESSION_CAP_KEY),
          getSetting(db, SESSION_WHOLE_GROUPS_KEY),
          getSetting(db, SESSION_ORDER_KEY),
          getSetting(db, REVIEW_SCOPES_KEY),
        ]);
        if (cancelled) return;
        setThreshold(parseSimilarityThreshold(rawThreshold));
        setSessionCap(parseSessionCap(rawCap));
        setWholeGroups(parseWholeGroups(rawWhole));
        setReviewOrder(parseReviewOrder(rawOrder));
        setScopeConfig(parseScopeConfig(rawScopes));
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

  const pickThreshold = useCallback(
    (value: number) => {
      setThreshold(value);
      void setSetting(db, SIMILARITY_THRESHOLD_KEY, serializeSimilarityThreshold(value));
    },
    [db],
  );

  const pickSessionCap = useCallback(
    (value: number) => {
      setSessionCap(value);
      void setSetting(db, SESSION_CAP_KEY, serializeSessionCap(value));
    },
    [db],
  );

  const pickWholeGroups = useCallback(
    (value: boolean) => {
      setWholeGroups(value);
      void setSetting(db, SESSION_WHOLE_GROUPS_KEY, serializeWholeGroups(value));
    },
    [db],
  );

  const pickReviewOrder = useCallback(
    (value: ReviewOrder) => {
      setReviewOrder(value);
      void setSetting(db, SESSION_ORDER_KEY, serializeReviewOrder(value));
    },
    [db],
  );

  const saveScopes = useCallback(
    (next: ScopeConfig) => {
      setScopeConfig(next);
      void setSetting(db, REVIEW_SCOPES_KEY, serializeScopeConfig(next));
    },
    [db],
  );

  const deleteScope = useCallback(
    (scope: StoredScope) => {
      if (!scopeConfig) return;
      Alert.alert(`Delete “${scope.label}”?`, 'Only the scope goes away — no photos are touched.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => saveScopes(removeScope(scopeConfig, scope.id)),
        },
      ]);
    },
    [scopeConfig, saveScopes],
  );

  const resetConfirmations = useCallback(() => {
    void setSetting(db, COMPARE_AUTO_CULL_KEY, serializeCompareAutoCull(false)).then(() =>
      showToast('Confirmation dialogs will ask again'),
    );
  }, [db]);

  const activeStep = threshold === null ? null : exactStep(threshold);
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

      <Text style={styles.sectionLabel}>Sessions</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Max photos per session</Text>
        <Text style={styles.explainer}>
          A session stops here so progress stays bankable — the rest of the scope waits for the next
          session.
        </Text>
        <View style={styles.stepWrap}>
          {SESSION_CAP_CHOICES.map((cap) => {
            const active = sessionCap === cap;
            return (
              <Pressable
                key={cap}
                onPress={() => pickSessionCap(cap)}
                style={[
                  styles.stepChip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.stepChipText, active && { color: theme.onAccent }]}>
                  {cap}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {sessionCap !== null && !SESSION_CAP_CHOICES.includes(sessionCap) && (
          <Text style={styles.stepHint}>Currently {sessionCap} photos.</Text>
        )}
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Don't split groups</Text>
            <Text style={styles.rowHint}>
              If the limit lands mid-group, the whole group joins the session.
            </Text>
          </View>
          <Switch
            value={wholeGroups}
            onValueChange={pickWholeGroups}
            trackColor={{ false: colors.surfaceRaised, true: theme.accentMuted }}
            thumbColor={wholeGroups ? theme.accent : colors.textDim}
          />
        </View>
        <Text style={styles.rowTitle}>Session draws</Text>
        <View style={styles.stepWrap}>
          {(
            [
              { value: 'oldest', label: 'Oldest first' },
              { value: 'newest', label: 'Newest first' },
            ] as const
          ).map((opt) => {
            const active = reviewOrder === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => pickReviewOrder(opt.value)}
                style={[
                  styles.stepChip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.stepChipText, active && { color: theme.onAccent }]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.stepHint}>
          {reviewOrder === 'oldest'
            ? 'Works through the backlog from the oldest photos forward.'
            : 'Reviews the newest photos first; the backlog waits.'}
        </Text>
      </View>

      <Text style={styles.sectionLabel}>Grouping</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Similarity for groups</Text>
        <Text style={styles.explainer}>
          Shots taken within minutes of each other are only reviewed as one group when they also
          look alike. Takes effect from the next session.
        </Text>
        <View style={styles.stepWrap}>
          {SIMILARITY_STEPS.map((step) => {
            const active = activeStep?.value === step.value;
            return (
              <Pressable
                key={step.value}
                onPress={() => pickThreshold(step.value)}
                style={[
                  styles.stepChip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.stepChipText, active && { color: theme.onAccent }]}>
                  {step.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {threshold !== null && (
          <>
            <View style={styles.sliderLabelRow}>
              <Text style={styles.rowHint}>Fine-tune</Text>
              <Text style={[styles.sliderValueLabel, { color: theme.accent }]}>
                {thresholdLabel(threshold)}
              </Text>
            </View>
            <FineSlider
              value={threshold}
              max={MAX_SIMILARITY_THRESHOLD}
              accent={theme.accent}
              onCommit={pickThreshold}
            />
            <Text style={styles.stepHint}>
              How many of the 64 fingerprint bits two photos may differ by and still group; 64 =
              grouping by time alone.
            </Text>
          </>
        )}
        {activeStep && <Text style={styles.stepHint}>{activeStep.hint}</Text>}
      </View>

      <Text style={styles.sectionLabel}>Review scopes</Text>
      <View style={styles.card}>
        <Text style={styles.explainer}>
          The scope chips offered on the Home screen. Create named scopes from Home's Custom range;
          the Custom chip itself is always available.
        </Text>
        {scopeConfig?.scopes.map((scope) => (
          <View key={scope.id} style={styles.switchRow}>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {scope.label}
              </Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {scopeSubtitle(scope)}
              </Text>
            </View>
            {!scope.builtin && (
              <Pressable hitSlop={8} onPress={() => deleteScope(scope)}>
                <MaterialCommunityIcons name="close" size={22} color={colors.cull} />
              </Pressable>
            )}
            <Switch
              value={scope.enabled}
              onValueChange={(enabled) =>
                scopeConfig && saveScopes(setScopeEnabled(scopeConfig, scope.id, enabled))
              }
              trackColor={{ false: colors.surfaceRaised, true: theme.accentMuted }}
              thumbColor={scope.enabled ? theme.accent : colors.textDim}
            />
          </View>
        ))}
        <Pressable
          style={styles.resetRow}
          onPress={() => scopeConfig && saveScopes(resetScopeConfig(scopeConfig))}
        >
          <Text style={[styles.resetText, { color: theme.accent }]}>Reset to defaults</Text>
        </Pressable>
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
