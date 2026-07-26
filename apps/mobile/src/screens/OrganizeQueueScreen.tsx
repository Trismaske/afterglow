/**
 * Organize queue (m0.7 item E — "move to a different album"). Queue rows
 * carry durable validated targets; Apply obtains one createWriteRequest
 * consent per bounded batch, moves via verified RELATIVE_PATH updates, and
 * commits outcomes + post-move repair in one SQLite transaction
 * (organizeStore.ts). The album picker is the native volume-aware catalog
 * (C#2) filtered to primary storage, plus "New album" → Pictures/<name>.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainTabScreenProps } from '../navigation';
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
  queryMediaRelativePaths,
  requestMediaWriteAccess,
  type VolumeAlbum,
} from '../../modules/media-store-actions';
import { getEditableContentUri, PRIMARY_VOLUME } from '../lib/media';

import { showToast } from '../lib/toast';
import { labelForDayKey } from '../lib/dates';
import { formatClock } from '../lib/format';
import { colors, touch } from '../theme';

type Props = MainTabScreenProps<'OrganizeQueue'>;

export function OrganizeQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const [rows, setRows] = useState<OrganizeQueueRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous apply lock: async continuations (picker load, intent
  // taps) must observe the CURRENT applying state, not a stale render.
  const busyRef = useRef(false);
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
    if (busyRef.current) return;
    // Fail-closed (C#8): a catalog error never widens choices — the picker
    // simply shows what the native query proved, primary volume only.
    const catalog = await listImageAlbums();
    // Apply may have started while the catalog loaded — opening the
    // picker now could change a durable target mid-batch.
    if (busyRef.current) return;
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
      if (!pickerFor || busyRef.current) return;
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
    if (busy || busyRef.current || !rows || rows.length === 0) return;
    setBusy(true);
    busyRef.current = true;
    try {
      // Revalidate the DURABLE intents at apply time — the rendered rows
      // may predate a just-tapped Remove/Change whose write is still
      // landing (same-connection FIFO makes this read see it).
      const freshRows = await getOrganizeQueue(db);
      if (freshRows.length === 0) return;
      // Group queued photos by target path; apply per target in bounded
      // batches (each batch = one consent + one verified move set).
      const byTarget = new Map<string, OrganizeQueueRow[]>();
      for (const row of freshRows) {
        const list = byTarget.get(row.organize_path) ?? [];
        list.push(row);
        byTarget.set(row.organize_path, list);
      }
      let moved = 0;
      let failed = 0;
      let declined = false;
      for (const [targetPath, members] of byTarget) {
        if (declined) break;
        for (let i = 0; i < members.length; i += ORGANIZE_BATCH_LIMIT) {
          const batch = members.slice(i, i + ORGANIZE_BATCH_LIMIT);
          const uris = await Promise.all(batch.map((m) => getEditableContentUri(m.photo_id)));
          // Crash-retry repair first (N#8): a move MediaStore completed
          // whose SQLite commit was lost is detected with a READ-ONLY
          // path lookup — never the mutating move call, which a lingering
          // write grant could let succeed BEFORE consent — and committed
          // as 'already' before any consent request, so a cancelled
          // consent can never strand an already-moved photo in the queue.
          const trimmed = (path: string) => path.replace(/\/+$/, '');
          const precheck = await queryMediaRelativePaths(uris);
          const repaired = batch
            .map((m, index) => ({ member: m, info: precheck[index] }))
            .filter(
              (p) =>
                p.info &&
                p.info.relativePath != null &&
                trimmed(p.info.relativePath) === trimmed(targetPath) &&
                !!p.info.data,
            );
          if (repaired.length > 0) {
            await commitOrganizeOutcomes(
              db,
              repaired.map((p) => ({
                photoId: p.member.photo_id,
                status: 'already' as const,
                message: 'already at target',
                newData: p.info!.data!,
                volumeName: p.member.organize_volume,
                relativePath: p.member.organize_path,
              })),
              Date.now(),
            );
            moved += repaired.length;
          }
          const repairedIds = new Set(repaired.map((p) => p.member.photo_id));
          const pendingIdx = batch
            .map((_, index) => index)
            .filter((index) => !repairedIds.has(batch[index].photo_id));
          if (pendingIdx.length === 0) continue;
          const pending = pendingIdx.map((index) => batch[index]);
          const pendingUris = pendingIdx.map((index) => uris[index]);
          let consentApplied = false;
          try {
            consentApplied = (await requestMediaWriteAccess(pendingUris)).status === 'applied';
          } catch {
            // Rejected request (no activity / bridge failure) — same as a
            // declined consent: the rows stay queued and retryable.
          }
          if (!consentApplied) {
            // A declined/failed consent stops the whole run — presenting
            // the next batch's dialog right after a cancel would nag
            // (P5#4). Everything unattempted stays queued and retryable,
            // like the other bounded queue flows.
            declined = true;
            break;
          }
          const results = await moveMediaToRelativePath(pendingUris, targetPath);
          const outcomes = pending.map((m, index) => ({
            photoId: m.photo_id,
            status: results[index]?.status ?? ('error' as const),
            message: results[index]?.message ?? 'no result',
            newData: results[index]?.newData,
            volumeName: m.organize_volume,
            relativePath: m.organize_path,
          }));
          await commitOrganizeOutcomes(db, outcomes, Date.now());
          moved += outcomes.filter((o) => o.status === 'moved' || o.status === 'already').length;
          failed += outcomes.filter(
            (o) => o.status === 'error' || o.status === 'unsupported',
          ).length;
        }
      }
      showToast(
        declined
          ? `Moved ${moved} — the rest stay queued`
          : failed === 0
            ? `Moved ${moved} photo${moved === 1 ? '' : 's'}`
            : `Moved ${moved}, ${failed} failed (kept queued)`,
      );
      await reload();
    } finally {
      setBusy(false);
      busyRef.current = false;
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
            {/* Intents FREEZE while a batch applies: a mid-apply change
                would move to the old target while commit records the new
                columns as applied (or clears a removed row). */}
            <Pressable
              style={styles.smallButton}
              disabled={busy}
              onPress={() => void openPicker(item.photo_id)}
            >
              <Text style={styles.smallButtonText}>Change album</Text>
            </Pressable>
            <Pressable
              style={styles.smallButton}
              disabled={busy}
              onPress={() => void unqueueOrganize(db, item.photo_id, Date.now()).then(reload)}
            >
              <Text style={styles.smallButtonText}>Remove</Text>
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [db, openPicker, reload, busy],
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
