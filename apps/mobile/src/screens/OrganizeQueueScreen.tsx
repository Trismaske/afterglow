/**
 * Organize queue (m0.7 item E — "move to a different album"). Queue rows
 * carry durable validated targets; Apply obtains one createWriteRequest
 * consent per bounded batch, moves via verified RELATIVE_PATH updates, and
 * commits outcomes + post-move repair in one SQLite transaction
 * (organizeStore.ts). The album picker is the native volume-aware catalog
 * (C#2) filtered to primary storage, plus "New album" → Pictures/<name>.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import {
  commitOrganizeOutcomes,
  getOrganizeQueue,
  newAlbumPath,
  ORGANIZE_BATCH_LIMIT,
  queueOrganize,
  unqueueOrganize,
  type OrganizeQueueRow,
} from '../db/organizeStore';
import {
  listImageAlbums,
  moveMediaToRelativePath,
  requestMediaWriteAccess,
  type VolumeAlbum,
} from '../../modules/media-store-actions';
import { getEditableContentUri, PRIMARY_VOLUME } from '../lib/media';
import { showToast } from '../lib/toast';
import { labelForDayKey } from '../lib/dates';
import { formatClock } from '../lib/format';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'OrganizeQueue'>;

export function OrganizeQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const [rows, setRows] = useState<OrganizeQueueRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [albums, setAlbums] = useState<VolumeAlbum[]>([]);
  const [newName, setNewName] = useState('');

  const reload = useCallback(async () => {
    setRows(await getOrganizeQueue(db));
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const openPicker = useCallback(async (photoId: string) => {
    // Fail-closed (C#8): a catalog error never widens choices — the picker
    // simply shows what the native query proved, primary volume only.
    const catalog = await listImageAlbums();
    setAlbums(
      catalog
        .filter((a) => a.volumeName === PRIMARY_VOLUME)
        .sort((a, b) => b.photoCount - a.photoCount),
    );
    setNewName('');
    setPickerFor(photoId);
  }, []);

  const chooseTarget = useCallback(
    async (relativePath: string) => {
      if (!pickerFor) return;
      const error = await queueOrganize(
        db,
        pickerFor,
        { volumeName: PRIMARY_VOLUME, relativePath },
        Date.now(),
      );
      if (error) Alert.alert('Cannot use that album', error);
      setPickerFor(null);
      await reload();
    },
    [db, pickerFor, reload],
  );

  const applyAll = useCallback(async () => {
    if (busy || !rows || rows.length === 0) return;
    setBusy(true);
    try {
      // Group queued photos by target path; apply per target in bounded
      // batches (each batch = one consent + one verified move set).
      const byTarget = new Map<string, OrganizeQueueRow[]>();
      for (const row of rows) {
        const list = byTarget.get(row.organize_path) ?? [];
        list.push(row);
        byTarget.set(row.organize_path, list);
      }
      let moved = 0;
      let failed = 0;
      for (const [targetPath, members] of byTarget) {
        for (let i = 0; i < members.length; i += ORGANIZE_BATCH_LIMIT) {
          const batch = members.slice(i, i + ORGANIZE_BATCH_LIMIT);
          const uris = await Promise.all(batch.map((m) => getEditableContentUri(m.photo_id)));
          const consent = await requestMediaWriteAccess(uris);
          if (consent.status !== 'applied') {
            failed += batch.length;
            continue; // cancelled batches stay queued (P5#4)
          }
          const results = await moveMediaToRelativePath(uris, targetPath);
          const outcomes = batch.map((m, index) => ({
            photoId: m.photo_id,
            status: results[index]?.status ?? ('error' as const),
            message: results[index]?.message ?? 'no result',
            newData: results[index]?.newData,
          }));
          await commitOrganizeOutcomes(db, outcomes, Date.now());
          moved += outcomes.filter((o) => o.status === 'moved' || o.status === 'already').length;
          failed += outcomes.filter(
            (o) => o.status === 'error' || o.status === 'unsupported',
          ).length;
        }
      }
      showToast(
        failed === 0
          ? `Moved ${moved} photo${moved === 1 ? '' : 's'}`
          : `Moved ${moved}, ${failed} failed (kept queued)`,
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }, [busy, db, rows, reload]);

  const renderItem = useCallback(
    ({ item }: { item: OrganizeQueueRow }) => (
      <View style={styles.row}>
        <Image
          source={{ uri: item.uri }}
          style={styles.thumb}
          contentFit="cover"
          recyclingKey={item.photo_id}
        />
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>
            {item.day ? labelForDayKey(item.day) : 'Unknown day'} · {formatClock(item.taken_at)}
          </Text>
          <Text style={styles.rowTarget} numberOfLines={1}>
            → {item.organize_path}
          </Text>
          <View style={styles.rowActions}>
            <Pressable style={styles.smallButton} onPress={() => void openPicker(item.photo_id)}>
              <Text style={styles.smallButtonText}>Change album</Text>
            </Pressable>
            <Pressable
              style={styles.smallButton}
              onPress={() => void unqueueOrganize(db, item.photo_id, Date.now()).then(reload)}
            >
              <Text style={styles.smallButtonText}>Remove</Text>
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [db, openPicker, reload],
  );

  const count = rows?.length ?? 0;
  const newPath = useMemo(() => newAlbumPath(newName), [newName]);
  return (
    <View style={styles.root}>
      <Text style={styles.subtitle}>
        {rows === null
          ? 'Loading…'
          : count === 0
            ? 'Queue photos with Organize during review to move them into albums.'
            : `${count} photo${count === 1 ? '' : 's'} queued · one confirm per batch moves them`}
      </Text>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.photo_id}
        renderItem={renderItem}
        contentContainerStyle={{ gap: 10, paddingBottom: insets.bottom + 90 }}
      />
      {count > 0 ? (
        <View style={[styles.actions, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            style={[styles.applyButton, busy && styles.disabled]}
            disabled={busy}
            onPress={() => void applyAll()}
          >
            <MaterialCommunityIcons name="folder-move" size={20} color={colors.text} />
            <Text style={styles.applyText}>{busy ? 'Moving…' : `Move ${count} to albums`}</Text>
          </Pressable>
        </View>
      ) : null}
      <Modal
        visible={pickerFor !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerFor(null)}
      >
        <View style={styles.pickerBackdrop}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>Move to album</Text>
            <FlatList
              data={albums}
              keyExtractor={(a) => `${a.volumeName}:${a.bucketId}`}
              style={{ flexGrow: 0, maxHeight: 320 }}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.albumRow}
                  onPress={() => void chooseTarget(item.relativePath)}
                >
                  <MaterialCommunityIcons name="folder-image" size={20} color={colors.textDim} />
                  <Text style={styles.albumName}>{item.displayName}</Text>
                  <Text style={styles.albumCount}>{item.photoCount}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.albumEmpty}>
                  No albums found on primary storage — create one below.
                </Text>
              }
            />
            <View style={styles.newRow}>
              <TextInput
                style={styles.newInput}
                placeholder="New album name"
                placeholderTextColor={colors.textDim}
                value={newName}
                onChangeText={setNewName}
              />
              <Pressable
                style={[styles.smallButton, !newPath && styles.disabled]}
                disabled={!newPath}
                onPress={() => newPath && void chooseTarget(newPath)}
              >
                <Text style={styles.smallButtonText}>Create</Text>
              </Pressable>
            </View>
            <Pressable style={styles.smallButton} onPress={() => setPickerFor(null)}>
              <Text style={styles.smallButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16, paddingTop: 12 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 12,
  },
  thumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowTarget: { color: colors.textDim, fontSize: 13 },
  rowActions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  smallButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  smallButtonText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  actions: { position: 'absolute', left: 16, right: 16, bottom: 0 },
  applyButton: {
    minHeight: 52,
    borderRadius: touch.radius,
    backgroundColor: colors.editDim,
    borderWidth: 1,
    borderColor: colors.edit,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  applyText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: touch.radius,
    borderTopRightRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  pickerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  albumName: { color: colors.text, fontSize: 15, flex: 1 },
  albumCount: { color: colors.textDim, fontSize: 13 },
  albumEmpty: { color: colors.textDim, fontSize: 14, paddingVertical: 12 },
  newRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  newInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
});
