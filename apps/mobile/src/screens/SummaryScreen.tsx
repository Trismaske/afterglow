import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch } from '../theme';
import { formatBytes } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Summary'>;

/** End-of-session summary: the "done for today" moment. */
export function SummaryScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, label, reclaimedBytes, editFlagCount, finishSession, version } = useSession();
  const [finishing, setFinishing] = useState(false);

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
        color={colors.accent}
        textColor="#1a1205"
        disabled={finishing}
        onPress={() => void done()}
      />
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
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
  statValue: { color: colors.accent, fontSize: 30, fontWeight: '800' },
  statLabel: { color: colors.textDim, fontSize: 13 },
  footnote: { color: colors.textDim, fontSize: 12, marginTop: 10 },
  editNote: { color: colors.edit, fontSize: 14, marginTop: 14, lineHeight: 20 },
  warning: { color: colors.cull, fontSize: 14, marginTop: 14, lineHeight: 20 },
  spacer: { flex: 1 },
});
