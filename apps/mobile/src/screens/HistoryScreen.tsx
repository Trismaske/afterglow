/**
 * History (m0.7 item G, #4): a reverse-chronological, filterable
 * current-state feed of decisions on photos still present, with
 * share-sheet events interleaved. Ordered by activity_at with keyset
 * pagination (C#15); trashed/deleted photos drop out (restore brings them
 * back via reconciliation); re-deciding happens through the standard
 * decision affordances on the photo rows.
 */
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { getHistoryPage, type HistoryFilter, type HistoryRow } from '../db/store';
import { formatDayClock } from '../lib/format';
import { DecisionBadge, type DecisionKind } from '../components/DecisionBadge';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'History'>;

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'kept', label: 'Kept' },
  { key: 'culled', label: 'Staged' },
  { key: 'to_edit', label: 'To edit' },
  { key: 'favourite', label: 'Favourite' },
  { key: 'organized', label: 'Organized' },
  { key: 'shared', label: 'Sheet opened' },
];

function badgeOf(row: Extract<HistoryRow, { kind: 'photo' }>): DecisionKind | null {
  if (row.state === 'culled') return 'cull';
  if (row.state === 'to_edit') return 'edit';
  if (row.state === 'kept' || row.state === 'done') return 'keep';
  return null;
}

export function HistoryScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [next, setNext] = useState<{ activityAt: number; assetId: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(
    async (which: HistoryFilter) => {
      const page = await getHistoryPage(db, which, null);
      setRows(page.rows);
      setNext(page.next);
    },
    [db],
  );

  useFocusEffect(
    useCallback(() => {
      // C#15: the cursor resets after any mutation elsewhere — refetching
      // on focus keeps the keyset coherent.
      void reload(filter);
    }, [reload, filter]),
  );

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getHistoryPage(db, filter, next);
      setRows((old) => [...(old ?? []), ...page.rows]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  }, [db, filter, next, loadingMore]);

  const renderItem = useCallback(({ item }: { item: HistoryRow }) => {
    if (item.kind === 'share') {
      return (
        <View style={styles.shareRow}>
          <View style={styles.shareThumbs}>
            {item.thumb_uris.slice(0, 3).map((uri, i) => (
              <Image
                key={`${item.batch_id}-${i}`}
                source={{ uri }}
                style={[styles.shareThumb, { left: i * 14 }]}
                contentFit="cover"
              />
            ))}
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>
              Share sheet opened · {item.member_count} photo{item.member_count === 1 ? '' : 's'}
              {item.label ? ` · “${item.label}”` : ''}
            </Text>
            <Text style={styles.rowTime}>{formatDayClock(item.opened_at)}</Text>
          </View>
          <MaterialCommunityIcons name="share-variant" size={20} color={colors.edit} />
        </View>
      );
    }
    const badge = badgeOf(item);
    return (
      <View style={styles.row}>
        <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
        <View style={styles.rowBody}>
          <Text style={styles.rowTime}>{formatDayClock(item.activity_at)}</Text>
          <View style={styles.badges}>
            {badge && <DecisionBadge kind={badge} size={20} />}
            {(item.favourite_state === 'applied' || item.favourite_state === 'queued_apply') && (
              <DecisionBadge kind="fav" size={20} />
            )}
            {item.organize_state === 'applied' && (
              <MaterialCommunityIcons name="folder-move" size={18} color={colors.textDim} />
            )}
          </View>
        </View>
      </View>
    );
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.chip, filter === f.key && styles.chipActive]}
            onPress={() => {
              setFilter(f.key);
              setRows(null);
              void reload(f.key);
            }}
          >
            <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => (r.kind === 'share' ? `share-${r.batch_id}` : r.asset_id)}
        renderItem={renderItem}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        contentContainerStyle={{ gap: 8, paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={
          rows !== null ? (
            <Text style={styles.empty}>
              Decisions land here as you review — photos deleted outside Afterglow drop out.
            </Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 14, paddingTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 15,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.editDim, borderColor: colors.edit },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    gap: 12,
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.edit,
    padding: 10,
    gap: 12,
  },
  shareThumbs: { width: 66, height: 38 },
  shareThumb: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowTime: { color: colors.textDim, fontSize: 13 },
  badges: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
});
