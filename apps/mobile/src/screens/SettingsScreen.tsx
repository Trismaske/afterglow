/**
 * Settings (m0.4), reached from the gear on Home. Small by design:
 * photo source (→ the existing picker), similarity threshold for group
 * refinement (stepped control over Hamming distance, similarityPrefs.ts),
 * accent color (System = Material You via the local native module, or a
 * fixed preset — accentTheme.ts + ThemeProvider, live-applied), and the
 * app version. Values persist in the m0.3.1 settings table.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import Constants from 'expo-constants';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { resolveSources } from '../lib/sourceCatalog';
import {
  nearestStep,
  parseSimilarityThreshold,
  serializeSimilarityThreshold,
  SIMILARITY_STEPS,
  SIMILARITY_THRESHOLD_KEY,
} from '../lib/similarityPrefs';
import { getSetting, setSetting } from '../db/store';
import { ACCENT_PRESETS } from '../lib/accentTheme';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const theme = useTheme();
  const systemAvailable = theme.systemAccent !== null;
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const stored = parseSimilarityThreshold(
          await getSetting(db, SIMILARITY_THRESHOLD_KEY),
        );
        if (cancelled) return;
        setThreshold(stored);
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

  const activeStep = threshold === null ? null : nearestStep(threshold);
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

      <Text style={styles.sectionLabel}>Grouping</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Similarity for groups</Text>
        <Text style={styles.explainer}>
          Shots taken within minutes of each other are only reviewed as one group when they
          also look alike. Loose groups more photos together; Strict splits groups apart
          more readily. Takes effect from the next session.
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
        {activeStep && <Text style={styles.stepHint}>{activeStep.hint}</Text>}
      </View>

      <Text style={styles.sectionLabel}>Appearance</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Accent color</Text>
        <Text style={styles.explainer}>
          Colors the buttons, chips, and highlights. System follows your phone's Material
          You palette, so it changes with your wallpaper.
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
            <Text style={[styles.accentLabel, theme.choice === 'system' && styles.accentLabelActive]}>
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
