import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { getToEditPhotos, markEditDone, type ToEditRow } from '../db/store';
import { getEditableContentUri } from '../lib/media';
import { launchEditor } from '../lib/edit';
import { NO_EDITOR_MESSAGE, NO_EDITOR_TITLE, VIEWER_FALLBACK_TOAST } from '../lib/editFallback';
import { showToast } from '../lib/toast';
import { labelForDayKey } from '../lib/dates';
import { formatClock } from '../lib/format';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'EditQueue'>;

/**
 * The to-edit queue (PLAN.md: Android has no virtual gallery albums, so
 * the queue lives in-app). Every photo flagged "needs edit", across all
 * days. Edit fires ACTION_EDIT into the user's editor of choice; Mark done
 * is always available manually (edit *detection* is m0.3).
 */
export function EditQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const [rows, setRows] = useState<ToEditRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRows(await getToEditPhotos(db));
  }, [db]);

  // Refresh whenever the screen gains focus (queue changes elsewhere).
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const markDone = useCallback(
    async (assetId: string) => {
      await markEditDone(db, assetId);
      await reload();
    },
    [db, reload],
  );

  const openEditor = useCallback(
    async (row: ToEditRow) => {
      if (busyId) return;
      setBusyId(row.asset_id);
      try {
        const contentUri = await getEditableContentUri(row.asset_id);
        // m0.5 Samsung fallback: no ACTION_EDIT handler → open the default
        // viewer instead (its edit button is one tap away), with a toast
        // over the opening viewer. Only a double failure shows the error.
        const result = await launchEditor(contentUri, () => showToast(VIEWER_FALLBACK_TOAST));
        if (result.outcome === 'failed') {
          Alert.alert(
            NO_EDITOR_TITLE,
            `${NO_EDITOR_MESSAGE}\n\nDiagnostics\nURI: ${result.uri}\nACTION_EDIT: ${result.editError}\nACTION_VIEW: ${result.viewError}`,
          );
          return;
        }
        if (result.outcome === 'returned' || result.outcome === 'viewer') {
          // Editors rarely report a useful result code, so ask instead of
          // guessing. Auto-detection of saved edits is m0.3.
          Alert.alert('Done editing?', 'Mark this photo as done and clear it from the queue?', [
            { text: 'Not yet', style: 'cancel' },
            { text: 'Mark done', onPress: () => void markDone(row.asset_id) },
          ]);
        }
      } finally {
        setBusyId(null);
      }
    },
    [busyId, markDone],
  );

  const renderItem = useCallback(
    ({ item }: { item: ToEditRow }) => (
      <View style={styles.row}>
        <Image
          source={{ uri: item.uri }}
          style={styles.thumb}
          contentFit="cover"
          recyclingKey={item.asset_id}
        />
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>
            {item.day ? labelForDayKey(item.day) : 'Unknown day'} · {formatClock(item.taken_at)}
          </Text>
          <View style={styles.rowActions}>
            <Pressable
              style={[styles.rowButton, styles.editButton]}
              disabled={busyId !== null}
              onPress={() => void openEditor(item)}
            >
              <MaterialCommunityIcons name="pencil" size={18} color={colors.edit} />
              <Text style={styles.rowButtonText}>
                {busyId === item.asset_id ? 'Opening…' : 'Edit'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.rowButton, styles.doneButton]}
              disabled={busyId !== null}
              onPress={() => void markDone(item.asset_id)}
            >
              <MaterialCommunityIcons name="check" size={18} color={colors.keep} />
              <Text style={styles.rowButtonText}>Mark done</Text>
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [busyId, openEditor, markDone],
  );

  return (
    <View style={[styles.root, { paddingTop: 12 }]}>
      <Text style={styles.subtitle}>
        {rows === null
          ? 'Loading…'
          : rows.length === 0
            ? 'Nothing waiting to be edited.'
            : `${rows.length} photo${rows.length === 1 ? '' : 's'} waiting · edits open in your editor of choice`}
      </Text>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.asset_id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}
        ListEmptyComponent={
          rows !== null && rows.length === 0 ? (
            <Text style={styles.emptyText}>
              Flag keepers with “needs edit” during review and they show up here.
            </Text>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  list: { gap: 10, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 12,
  },
  thumb: {
    width: 84,
    height: 84,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
  },
  rowBody: { flex: 1, justifyContent: 'space-between', gap: 8 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowActions: { flexDirection: 'row', gap: 8 },
  rowButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 5,
  },
  editButton: { backgroundColor: colors.editDim, borderWidth: 1, borderColor: colors.edit },
  doneButton: { backgroundColor: colors.keepDim, borderWidth: 1, borderColor: colors.keep },
  rowButtonText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  emptyText: { color: colors.textDim, fontSize: 15, textAlign: 'center', marginTop: 40 },
});
