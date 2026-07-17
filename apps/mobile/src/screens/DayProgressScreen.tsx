import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { getDayStateCounts, type DayStateCounts } from '../db/store';
import { countPhotosInRange } from '../lib/media';
import { labelForDayKey, rangeOfDayKey } from '../lib/dates';
import { StateProgressBar } from '../components/StateProgressBar';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

interface DayBreakdown {
  /** All photos taken that day (incl. already-trashed ones). */
  total: number;
  unreviewed: number;
  inDuels: number;
  kept: number;
  toEdit: number;
  staged: number;
  /** done + trashed — both have converged. */
  done: number;
}

/**
 * Everything converges to done: photos MediaStore has for the day but the
 * DB has never tracked count as unreviewed; trashed photos are gone from
 * MediaStore, so the day's true total is MediaStore + trashed rows.
 */
function breakdown(mediaStoreTotal: number, db: DayStateCounts): DayBreakdown {
  const trackedAlive = db.tracked - db.trashed;
  const neverLoaded = Math.max(0, mediaStoreTotal - trackedAlive);
  return {
    total: mediaStoreTotal + db.trashed,
    unreviewed: neverLoaded + db.unreviewedSingle,
    inDuels: db.unreviewedGrouped,
    kept: db.kept,
    toEdit: db.toEdit,
    staged: db.staged,
    done: db.done + db.trashed,
  };
}

/** Day-scoped inbox-zero view: counts by state + a progress bar. */
export function DayProgressScreen({ route }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { day } = route.params;
  const [data, setData] = useState<DayBreakdown | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const range = rangeOfDayKey(day);
        const [msTotal, counts] = await Promise.all([
          countPhotosInRange(range.startMs, range.endMs).catch(() => 0),
          getDayStateCounts(db, day),
        ]);
        if (!cancelled) setData(breakdown(msTotal, counts));
      })();
      return () => {
        cancelled = true;
      };
    }, [db, day]),
  );

  const label = useMemo(() => labelForDayKey(day), [day]);

  if (!data) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.dim}>Loading…</Text>
      </View>
    );
  }

  const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 100;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
    >
      <Text style={styles.title}>{label}</Text>
      <Text style={styles.subtitle}>
        {data.total === 0
          ? 'No photos taken this day.'
          : data.done === data.total
            ? `Inbox zero — all ${data.total} photos done ✦`
            : `${data.done} of ${data.total} photos done · ${pct}%`}
      </Text>

      <StateProgressBar
        height={14}
        total={data.total}
        segments={[
          { count: data.done, color: colors.keep },
          { count: data.toEdit, color: colors.edit },
          { count: data.staged, color: colors.cull },
          { count: data.kept, color: colors.keepDim },
          { count: data.inDuels, color: colors.accent },
          // unreviewed = the empty track
        ]}
      />

      <View style={styles.rows}>
        <StateRow color={colors.surfaceRaised} label="Unreviewed" hint="not looked at yet" count={data.unreviewed} />
        <StateRow color={colors.accent} label="In duels" hint="waiting in a cull group bracket" count={data.inDuels} />
        <StateRow color={colors.keepDim} label="Kept" hint="reviewed; becomes done when the session finishes" count={data.kept} />
        <StateRow color={colors.edit} label="To edit" hint="keepers waiting in the edit queue" count={data.toEdit} />
        <StateRow color={colors.cull} label="Staged cull" hint="staged for deletion, not yet confirmed" count={data.staged} />
        <StateRow color={colors.keep} label="Done" hint="reviewed keepers + trashed culls" count={data.done} />
      </View>

      <Text style={styles.footnote}>
        Everything converges to done — review the unreviewed, duel out the groups, clear the
        edit queue, confirm the culls.
      </Text>
    </ScrollView>
  );
}

function StateRow({
  color,
  label,
  hint,
  count,
}: {
  color: string;
  label: string;
  hint: string;
  count: number;
}) {
  return (
    <View style={styles.stateRow}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <View style={styles.stateBody}>
        <Text style={styles.stateLabel}>{label}</Text>
        <Text style={styles.stateHint}>{hint}</Text>
      </View>
      <Text style={styles.stateCount}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 14 },
  dim: { color: colors.textDim, fontSize: 15 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 15, marginTop: -8 },
  rows: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  stateBody: { flex: 1 },
  stateLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  stateHint: { color: colors.textDim, fontSize: 12 },
  stateCount: { color: colors.text, fontSize: 18, fontWeight: '800' },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
});
