import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import {
  getDayReviewSummary,
  getLifetimeStats,
  getReviewedCountsByDay,
  getSetting,
  type LifetimeStats,
} from '../db/store';
import { dayKey, recentDayKeys } from '../lib/dates';
import { DAILY_GOAL_KEY, goalStreaks, parseDailyGoal } from '../lib/dailyGoal';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatBytes } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Summary'>;

/** Daily summary: the "done for today" moment (m0.8: day-based —
 * decisions complete as you swipe; the gate-4 daily goal builds on it). */
export function SummaryScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const [lifetime, setLifetime] = useState<
    (LifetimeStats & { currentStreak: number; longestStreak: number }) | null
  >(null);
  const [today, setToday] = useState<{
    reviewed: number;
    done: number;
    staged: number;
    trashed: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const todayKey = dayKey(Date.now());
      const keys = recentDayKeys(120);
      const [reviewedByDay, rawGoal, totals, todaySummary] = await Promise.all([
        getReviewedCountsByDay(db, keys[keys.length - 1] ?? todayKey),
        getSetting(db, DAILY_GOAL_KEY),
        getLifetimeStats(db),
        // Decision-day summary: older photos reviewed today count too.
        getDayReviewSummary(db, todayKey),
      ]);
      if (cancelled) return;
      // Streak days are GOAL-REACHED days (gate 4 definition — same math
      // as the Home ring).
      const streaks = goalStreaks(reviewedByDay, [...keys].reverse(), parseDailyGoal(rawGoal));
      setLifetime({
        ...totals,
        currentStreak: streaks.current,
        longestStreak: streaks.longest,
      });
      setToday(todaySummary);
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const stats = today;
  const done = useCallback(() => {
    navigation.popToTop();
  }, [navigation]);

  if (!stats) {
    return <View style={styles.root} />;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }}
    >
      <View style={styles.titleRow}>
        <MaterialCommunityIcons name="weather-sunset" size={30} color={theme.accent} />
        <Text style={styles.title}>Done for today</Text>
      </View>
      <Text style={styles.subtitle}>{dayKey(Date.now())}</Text>

      <View style={styles.grid}>
        <Stat value={String(stats.reviewed)} label="reviewed today" />
        <Stat value={String(stats.done)} label="keepers" />
        <Stat value={String(stats.staged)} label="staged to cull" />
        <Stat value={String(stats.trashed)} label="culled to trash" />
      </View>
      {lifetime && (
        <View style={styles.lifetimeCard}>
          <View style={styles.lifetimeTitleRow}>
            <MaterialCommunityIcons name="chart-box-outline" size={21} color={theme.accent} />
            <Text style={styles.lifetimeTitle}>All-time</Text>
          </View>
          <View style={styles.lifetimeGrid}>
            <LifetimeStat value={lifetime.reviewed} label="reviewed" />
            <LifetimeStat value={lifetime.culled} label="culled" />
            <LifetimeStat value={lifetime.editsCompleted} label="edits completed" />
            <LifetimeStat value={lifetime.favouritesApplied} label="favourites applied" />
            <LifetimeStat value={lifetime.currentStreak} label="goal streak (days)" />
            <LifetimeStat value={lifetime.longestStreak} label="longest goal streak" />
          </View>
          <Text style={styles.reclaimedAllTime}>
            {formatBytes(lifetime.reclaimedBytes)} reclaimed all-time*
          </Text>
        </View>
      )}
      {stats.staged > 0 && (
        <Text style={styles.warning}>
          {stats.staged} photo{stats.staged === 1 ? '' : 's'} still staged (delete was skipped) —
          they stay in the cull list until you confirm.
        </Text>
      )}

      <BigButton
        label="Done"
        color={theme.accent}
        textColor={theme.onAccent}
        onPress={done}
        style={styles.finishButton}
      />
    </ScrollView>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: theme.accent }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function LifetimeStat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.lifetimeStat}>
      <Text style={styles.lifetimeValue}>{value}</Text>
      <Text style={styles.lifetimeLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: {
    color: colors.textDim,
    fontSize: 16,
    marginTop: 4,
    marginBottom: 20,
    paddingHorizontal: 20,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 20 },
  stat: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 4,
  },
  statValue: { fontSize: 30, fontWeight: '800' },
  statLabel: { color: colors.textDim, fontSize: 13 },
  footnote: { color: colors.textDim, fontSize: 12, marginTop: 10, paddingHorizontal: 20 },
  lifetimeCard: {
    marginHorizontal: 20,
    marginTop: 18,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 12,
  },
  lifetimeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lifetimeTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  lifetimeGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  lifetimeStat: { flexBasis: '33.33%', minWidth: 95 },
  lifetimeValue: { color: colors.text, fontSize: 21, fontWeight: '800' },
  lifetimeLabel: { color: colors.textDim, fontSize: 11, lineHeight: 15 },
  reclaimedAllTime: { color: colors.textDim, fontSize: 13 },
  editNote: {
    color: colors.edit,
    fontSize: 14,
    marginTop: 14,
    lineHeight: 20,
    marginHorizontal: 20,
  },
  warning: {
    color: colors.cull,
    fontSize: 14,
    marginTop: 14,
    lineHeight: 20,
    marginHorizontal: 20,
  },
  finishButton: { marginHorizontal: 20, marginTop: 24 },
});
