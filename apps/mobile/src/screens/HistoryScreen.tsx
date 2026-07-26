/**
 * History (m0.7 item G, #4): a reverse-chronological, filterable
 * current-state feed of decisions on photos still present, with
 * share-sheet events interleaved. Ordered by activity_at with two-stream
 * keyset pagination (C#15); trashed/deleted photos drop out (restore
 * brings them back via reconciliation); tapping a photo row opens the
 * standard full-screen viewer (PhotoViewer — gate 5), whose detail panel
 * hosts the state editor.
 */
import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import {
  getHistoryPage,
  type HistoryCursor,
  type HistoryFilter,
  type HistoryRow,
} from '../db/store';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { checkMediaPresence } from '../lib/media';
import { formatDayClock } from '../lib/format';
import { DecisionBadge, type DecisionKind } from '../components/DecisionBadge';
import { PhotoViewer } from '../components/PhotoViewer';
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
  if (row.state === 'done') return 'keep';
  return null;
}

export function HistoryScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();

  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Monotonic request token: a reload invalidates every in-flight fetch
  // (an older filter's result finishing last must not win the state).
  const requestRef = useRef(0);

  // The screen contract: photos deleted or trashed OUTSIDE Afterglow drop
  // out. Only Afterglow's own trash resolution clears is_present, so each
  // fetched page is reconciled against MediaStore — fail-closed: only an
  // authoritative 'trashed'/'absent' answer converges the row (exactly
  // like a verified trash outcome, without credit); 'unknown' changes
  // nothing.
  const reconcilePage = useCallback(
    async (pageRows: HistoryRow[]): Promise<HistoryRow[]> => {
      const gone = new Set<string>();
      for (const row of pageRows) {
        if (row.kind !== 'photo') continue;
        const presence = await checkMediaPresence(row.asset_id);
        if (presence === 'trashed' || presence === 'absent') gone.add(row.asset_id);
      }
      if (gone.size === 0) return pageRows;
      await reconcileExternallyRemoved(db, [...gone], Date.now());
      return pageRows.filter((row) => row.kind !== 'photo' || !gone.has(row.asset_id));
    },
    [db],
  );

  const reload = useCallback(
    async (which: HistoryFilter) => {
      const token = ++requestRef.current;
      const page = await getHistoryPage(db, which, null);
      const rowsNow = await reconcilePage(page.rows);
      if (requestRef.current !== token) return; // superseded by a newer reload
      setRows(rowsNow);
      setNext(page.next);
    },
    [db, reconcilePage],
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
    // Extends the stream the current token owns; a reload started
    // meanwhile bumps the token and this append is discarded.
    const token = requestRef.current;
    try {
      const page = await getHistoryPage(db, filter, next);
      const rowsNow = await reconcilePage(page.rows);
      if (requestRef.current !== token) return;
      setRows((old) => [...(old ?? []), ...rowsNow]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  }, [db, filter, next, loadingMore, reconcilePage]);

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
      <Pressable style={styles.row} onPress={() => setViewerId(item.asset_id)}>
        <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
        <View style={styles.rowBody}>
          <Text style={styles.rowTime}>{formatDayClock(item.activity_at)}</Text>
          <View style={styles.badges}>
            {badge && <DecisionBadge kind={badge} size={20} />}
            {(item.favourite_state === 'applied' || item.favourite_state === 'queued_apply') && (
              <DecisionBadge kind="fav" size={20} />
            )}
            {item.organize_applied_at != null && (
              // folder-clock: organized once, but a NEWER move intent is
              // pending/erroring — the shown fact is superseded until it
              // applies (history keeps the event either way).
              <MaterialCommunityIcons
                name={
                  item.organize_state === 'queued' || item.organize_state === 'error'
                    ? 'folder-clock'
                    : 'folder-move'
                }
                size={18}
                color={colors.textDim}
              />
            )}
          </View>
        </View>
      </Pressable>
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
              setRows(null);
              if (f.key === filter) {
                // Same filter tapped again: the focus effect keys on
                // `filter` and will NOT re-run — reload explicitly.
                void reload(f.key);
              } else {
                // The focus effect re-runs on the filter change —
                // reloading here too would double the presence checks
                // and reconciliation work.
                setFilter(f.key);
              }
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
      {viewerId !== null &&
        (() => {
          const photoRows = (rows ?? []).filter(
            (r): r is Extract<HistoryRow, { kind: 'photo' }> => r.kind === 'photo',
          );
          const index = photoRows.findIndex((r) => r.asset_id === viewerId);
          if (index < 0) return null;
          return (
            <PhotoViewer
              items={photoRows.map((r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at }))}
              initialIndex={index}
              onClose={() => setViewerId(null)}
              onChanged={() => void reload(filter)}
            />
          );
        })()}
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
