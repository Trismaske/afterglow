import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { useSQLiteContext } from 'expo-sqlite';
import { getStagedCulls, type StagedCullRow } from '../db/store';
import { markBatchLaunching, prepareTrashBatch, resolveTrashBatch } from '../db/trashStore';
import { getEditableContentUri, trashAssets } from '../lib/media';
import { fileSize } from '../lib/hash';
import { isMediaTrashed } from '../../modules/media-store-actions';
import { BigButton } from '../components/BigButton';
import { ReDecideSheet } from '../components/ReDecideSheet';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'CullList'>;

/**
 * The staged cull list. Tapping a photo opens the m0.5 re-decide sheet
 * (keep / to edit / stays culled) — the last stop where any decision is
 * still reversible. The ONE confirm button below is the only path in the
 * app that deletes anything; on Android 11+ the system dialog moves the
 * batch to recoverable system trash (retention is gallery-controlled).
 */
export function CullListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, sessionId, version, reconcileTrashed } = useSession();
  const db = useSQLiteContext();
  const [busy, setBusy] = useState(false);
  const [redecideItem, setRedecideItem] = useState<MediaItem | null>(null);
  const [globalRows, setGlobalRows] = useState<StagedCullRow[]>([]);
  const systemTrashSupported = Platform.OS === 'android' && Number(Platform.Version) >= 30;

  // P4#1: the DURABLE GLOBAL cull queue is the confirmation truth — it
  // includes carried culls from replaced sessions, which the active
  // snapshot cannot see.
  useEffect(() => {
    let cancelled = false;
    void getStagedCulls(db).then((rows) => {
      if (!cancelled) setGlobalRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [db, version, busy]);

  const staged: MediaItem[] = useMemo(
    () =>
      globalRows.map((row) => ({
        id: row.asset_id,
        uri: row.uri,
        timestamp: row.taken_at,
        kind: 'photo' as const,
      })),
    [globalRows],
  );

  const runConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Durable trash lifecycle over the GLOBAL queue (P7#4/P8#3/P8#4):
      // prepare (reserve + measure) → launching → system dialog →
      // tri-state verify → outcomes; the active snapshot mirrors verified
      // members afterwards.
      const batch = await prepareTrashBatch(
        db,
        globalRows.map((row) => ({ photoId: row.asset_id, measuredBytes: fileSize(row.uri) })),
        sessionId,
        Date.now(),
      );
      if (!batch) {
        navigation.replace('Summary');
        return;
      }
      await markBatchLaunching(db, batch.batchId, Date.now());
      const ids = batch.members.map((m) => m.photoId);
      const dialog = await trashAssets(ids);
      const resolved = await resolveTrashBatch(db, {
        batchId: batch.batchId,
        verify: async (photoId) => {
          const trashed = await isMediaTrashed(await getEditableContentUri(photoId));
          if (trashed === true) return 'absent';
          if (trashed === false) return 'present';
          return 'unknown';
        },
        dialog:
          dialog.status === 'applied'
            ? 'applied'
            : dialog.status === 'cancelled'
              ? 'cancelled'
              : dialog.status === 'unsupported'
                ? 'unsupported'
                : 'failed',
        at: Date.now(),
      });
      const trashedIds = ids.filter(
        (id) =>
          resolved.outcomes[id] === 'trashed' ||
          resolved.outcomes[id] === 'absent_after_interrupted_launch',
      );
      await reconcileTrashed(trashedIds);
      const result = {
        deleted: trashedIds.length > 0,
        status: dialog.status,
        error: dialog.status === 'failed' ? dialog.error : undefined,
      };
      if (result.deleted) {
        navigation.replace('Summary');
      } else if (result.status === 'cancelled') {
        Alert.alert(
          'Nothing moved to trash',
          'The system confirmation was cancelled. Your photos are untouched and still staged.',
        );
      } else if (result.status === 'unsupported') {
        Alert.alert(
          'System trash unavailable',
          'Afterglow does not permanently delete photos. Moving culls to trash requires Android 11 or later.',
        );
      } else {
        Alert.alert(
          'Could not move photos to trash',
          result.error ??
            'Android MediaStore returned an unexpected error. Your culls remain staged.',
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy, db, globalRows, sessionId, reconcileTrashed, navigation]);

  const onConfirmPress = useCallback(() => {
    if (staged.length === 0) {
      navigation.replace('Summary');
      return;
    }
    // The app-level warning is followed by Android's MediaStore-owned
    // confirmation sheet. There is no permanent-delete fallback.
    Alert.alert(
      `Move ${staged.length} photo${staged.length === 1 ? '' : 's'} to trash?`,
      'Android will ask you to confirm. Recovery duration is controlled by your system gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Move to trash', style: 'destructive', onPress: () => void runConfirm() },
      ],
    );
  }, [staged.length, navigation, runConfirm]);

  const inSession = useCallback(
    (id: string) => {
      if (!session) return false;
      try {
        session.getState(id);
        return true;
      } catch {
        return false;
      }
    },
    [session],
  );

  const restoreCarried = useCallback(
    (item: MediaItem) => {
      Alert.alert(
        'Carried cull',
        'This photo was staged in an earlier session. Restore it to unreviewed (it will be drawn again), or keep it staged?',
        [
          { text: 'Keep staged', style: 'cancel' },
          {
            text: 'Restore to unreviewed',
            onPress: () =>
              void db
                .runAsync(
                  "UPDATE photos SET state = 'unreviewed', activity_at = ? WHERE asset_id = ? AND state = 'culled'",
                  Date.now(),
                  item.id,
                )
                .then(() => getStagedCulls(db))
                .then(setGlobalRows),
          },
        ],
      );
    },
    [db],
  );

  const onTilePress = useCallback(
    (item: MediaItem) => {
      if (inSession(item.id)) setRedecideItem(item);
      else restoreCarried(item);
    },
    [inSession, restoreCarried],
  );

  const renderItem = useCallback(
    ({ item }: { item: MediaItem }) => (
      <Pressable style={styles.tile} onPress={() => onTilePress(item)} disabled={busy}>
        <Image
          source={{ uri: item.uri }}
          style={styles.tileImage}
          contentFit="cover"
          recyclingKey={item.id}
        />
        <View style={styles.tileBadge}>
          <Text style={styles.tileBadgeText}>tap to change</Text>
        </View>
      </Pressable>
    ),
    [busy, onTilePress],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>Cull list</Text>
      <Text style={styles.subtitle}>
        {!systemTrashSupported && staged.length > 0
          ? 'System trash requires Android 11 or later. Culls remain staged and untouched.'
          : staged.length === 0
            ? 'Nothing staged for deletion.'
            : `${staged.length} staged · tap any photo to change its decision`}
      </Text>
      <FlatList
        data={staged}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        numColumns={3}
        columnWrapperStyle={staged.length > 0 ? styles.column : undefined}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Everything you reviewed is a keeper.</Text>
        }
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={
            busy
              ? 'Moving to trash…'
              : staged.length === 0
                ? 'Finish session'
                : `Trash ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          }
          color={staged.length === 0 ? colors.keep : colors.cull}
          disabled={busy || (!systemTrashSupported && staged.length > 0)}
          onPress={onConfirmPress}
        />
      </View>
      {redecideItem && (
        <ReDecideSheet item={redecideItem} current="culled" onClose={() => setRedecideItem(null)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 2, marginBottom: 10 },
  list: { gap: 6, paddingBottom: 12, flexGrow: 1 },
  column: { gap: 6 },
  tile: { flex: 1 / 3, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  tileImage: { flex: 1, backgroundColor: colors.surfaceRaised },
  tileBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 2,
    alignItems: 'center',
  },
  tileBadgeText: { color: colors.textDim, fontSize: 10 },
  emptyText: { color: colors.textDim, fontSize: 15, textAlign: 'center', marginTop: 40 },
  footer: { paddingTop: 8 },
});
