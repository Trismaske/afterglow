import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { getAllTimeReclaimedBytes, getFinishedSessionDays } from '../db/store';
import { currentStreak, dayKey } from '../lib/dates';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatBytes } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Summary'>;

/** End-of-session summary: the "done for today" moment. */
export function SummaryScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { session, label, reclaimedBytes, editFlagCount, finishSession, version } = useSession();
  const [finishing, setFinishing] = useState(false);
  const [streak, setStreak] = useState<number | null>(null);
  const [allTimeBytes, setAllTimeBytes] = useState<number | null>(null);

  // Streak + all-time reclaimed (m0.3 polish). This session isn't finished
  // yet while the summary shows, so today counts as part of the streak.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [days, bytes] = await Promise.all([
        getFinishedSessionDays(db),
        getAllTimeReclaimedBytes(db),
      ]);
      if (cancelled) return;
      const today = dayKey(Date.now());
      setStreak(currentStreak([today, ...days], today));
      setAllTimeBytes(bytes);
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const stats = useMemo(() => {
    if (!session) return null;
    const s = session.summary();
    return {
      total: s.total,
      reviewed: s.total - s.unreviewed,
      kept: s.kept,
      trashed: s.trashed,
      staged: s.culled,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, version]);

  const done = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await finishSession();
      navigation.popToTop();
    } finally {
      setFinishing(false);
    }
  }, [finishing, finishSession, navigation]);

  if (!stats) {
    return <View style={styles.root} />;
  }

  return (
    <View
      style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}
    >
      <Text style={styles.title}>Done for today ✦</Text>
      <Text style={styles.subtitle}>{label}</Text>

      <View style={styles.grid}>
        <Stat value={String(stats.reviewed)} label="photos reviewed" />
        <Stat value={String(stats.kept)} label="keepers" />
        <Stat value={String(stats.trashed)} label="culled to trash" />
        <Stat value={formatBytes(reclaimedBytes)} label="storage reclaimed*" />
        {streak !== null && (
          <Stat
            value={`${streak} day${streak === 1 ? '' : 's'}`}
            label={streak > 1 ? 'review streak ✦ keep it going' : 'review streak'}
          />
        )}
        {allTimeBytes !== null && allTimeBytes > 0 && (
          <Stat value={formatBytes(allTimeBytes)} label="reclaimed all-time*" />
        )}
      </View>
      <Text style={styles.footnote}>
        *approximate — measured before the batch went to the system trash.
      </Text>
      {editFlagCount > 0 && (
        <Text style={styles.editNote}>
          ✎ {editFlagCount} keeper{editFlagCount === 1 ? '' : 's'} added to the edit queue —
          find them on the Home screen.
        </Text>
      )}
      {stats.staged > 0 && (
        <Text style={styles.warning}>
          {stats.staged} photo{stats.staged === 1 ? '' : 's'} still staged (delete was skipped).
          They stay staged if you resume this session.
        </Text>
      )}

      <View style={styles.spacer} />
      <BigButton
        label={finishing ? 'Wrapping up…' : 'Finish'}
        color={theme.accent}
        textColor={theme.onAccent}
        disabled={finishing}
        onPress={() => void done()}
      />
    </View>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 20 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 16, marginTop: 4, marginBottom: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
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
  footnote: { color: colors.textDim, fontSize: 12, marginTop: 10 },
  editNote: { color: colors.edit, fontSize: 14, marginTop: 14, lineHeight: 20 },
  warning: { color: colors.cull, fontSize: 14, marginTop: 14, lineHeight: 20 },
  spacer: { flex: 1 },
});
