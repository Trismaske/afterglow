/**
 * Multi-pass share queue (m0.7 item E — Tristan's sharing workflow). The
 * queue is a persistent working set: share overlapping subsets to
 * different people across repeated sheet passes, then clear explicitly.
 *
 * - Nothing selected → "Share all N" (single-recipient stays one tap).
 * - Tapping a thumbnail enters selection mode (gallery convention);
 *   header chips: Select all / none / unshared.
 * - ✓ pass-count badges count only same-cycle sheet_opened passes — the
 *   "who still needs this?" navigation for overlapping subsets.
 * - After a confirmed dispatch: optional, fully skippable label prompt
 *   (recent-label chips) — the only honest recipient record.
 * - Clear is explicit and warns when never-shared photos remain; share
 *   events survive the clear for History.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainTabScreenProps } from '../navigation';
import {
  clearShareQueue,
  countNeverShared,
  createShareBatch,
  failShareBatch,
  getShareQueue,
  labelShareBatch,
  promoteShareBatch,
  recentShareLabels,
  removeFromShareQueue,
  SHARE_SOFT_WARN_COUNT,
  type ShareQueueRow,
} from '../db/shareStore';
import { shareMediaUris } from '../../modules/media-store-actions';
import { getEditableContentUri } from '../lib/media';
import { showToast } from '../lib/toast';
import { colors, touch } from '../theme';
import { PhotoViewer } from '../components/PhotoViewer';

type Props = MainTabScreenProps<'ShareQueue'>;

export function ShareQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const [rows, setRows] = useState<ShareQueueRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [labelBatchId, setLabelBatchId] = useState<number | null>(null);
  const [labelText, setLabelText] = useState('');
  const [labelChips, setLabelChips] = useState<string[]>([]);
  /** In-app full-screen viewer (gate 5) — long-press a thumbnail
   * (a plain tap toggles pass selection). */
  const [viewerId, setViewerId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const queue = await getShareQueue(db);
    setRows(queue);
    setSelected((old) => new Set([...old].filter((id) => queue.some((r) => r.photo_id === id))));
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  useEffect(() => {
    void recentShareLabels(db).then(setLabelChips);
  }, [db, labelBatchId]);

  const selectionMode = selected.size > 0;
  const shareIds = useMemo(
    () => (selectionMode ? [...selected] : (rows ?? []).map((r) => r.photo_id)),
    [selectionMode, selected, rows],
  );

  const toggle = useCallback((id: string) => {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectUnshared = useCallback(() => {
    setSelected(new Set((rows ?? []).filter((r) => r.pass_count === 0).map((r) => r.photo_id)));
  }, [rows]);

  const runShare = useCallback(async () => {
    if (busy || shareIds.length === 0) return;
    const fire = async () => {
      setBusy(true);
      try {
        // C#10 at-most-once: durable `launching` row BEFORE dispatch;
        // promote immediately after the native dispatch report. A
        // REJECTED dispatch (bridge failure) fails the batch like a
        // reported error — otherwise the durable row would stay stuck in
        // `launching` until the next process restart's recovery.
        const batchId = await createShareBatch(db, shareIds, Date.now());
        const uris = await Promise.all(shareIds.map(getEditableContentUri));
        let dispatch: Awaited<ReturnType<typeof shareMediaUris>>;
        try {
          dispatch = await shareMediaUris(uris);
        } catch (error) {
          dispatch = {
            result: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (dispatch.result === 'dispatched') {
          await promoteShareBatch(db, batchId, Date.now());
          showToast(`Sheet opened for ${shareIds.length} — queue kept for more sharing`);
          setSelected(new Set());
          setLabelText('');
          setLabelBatchId(batchId);
        } else {
          await failShareBatch(db, batchId);
          Alert.alert('Share failed', dispatch.message);
        }
        await reload();
      } finally {
        setBusy(false);
      }
    };
    if (shareIds.length > SHARE_SOFT_WARN_COUNT) {
      Alert.alert(
        `Share ${shareIds.length} photos?`,
        "Some apps can't receive this many at once.",
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Share anyway', onPress: () => void fire() },
        ],
      );
      return;
    }
    await fire();
  }, [busy, db, shareIds, reload]);

  const saveLabel = useCallback(
    async (label: string) => {
      if (labelBatchId !== null && label.trim() !== '') {
        await labelShareBatch(db, labelBatchId, label.trim());
      }
      setLabelBatchId(null);
    },
    [db, labelBatchId],
  );

  const runClear = useCallback(async () => {
    const neverShared = await countNeverShared(db);
    const total = rows?.length ?? 0;
    const message =
      neverShared > 0
        ? `${neverShared} of ${total} photos were never shared. Clear anyway?`
        : `Clear all ${total} photos from the share queue? Past share events are kept in History.`;
    Alert.alert('Clear share queue', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () =>
          void clearShareQueue(db, Date.now()).then(() => {
            setSelected(new Set());
            void reload();
          }),
      },
    ]);
  }, [db, rows, reload]);

  const removeSelected = useCallback(async () => {
    for (const id of selected) await removeFromShareQueue(db, id, Date.now());
    setSelected(new Set());
    await reload();
  }, [db, selected, reload]);

  const renderItem = useCallback(
    ({ item }: { item: ShareQueueRow }) => {
      const isSelected = selected.has(item.photo_id);
      return (
        <Pressable
          style={styles.cell}
          onPress={() => toggle(item.photo_id)}
          onLongPress={() => setViewerId(item.photo_id)}
        >
          <Image
            source={{ uri: item.uri }}
            style={[styles.thumb, isSelected && styles.thumbSelected]}
            contentFit="cover"
            recyclingKey={item.photo_id}
          />
          {item.pass_count > 0 ? (
            <View style={styles.passBadge}>
              <MaterialCommunityIcons name="check" size={12} color={colors.text} />
              {item.pass_count > 1 ? (
                <Text style={styles.passBadgeText}>{item.pass_count}</Text>
              ) : null}
            </View>
          ) : null}
          {isSelected ? (
            <View style={styles.selectBadge}>
              <MaterialCommunityIcons name="check-circle" size={20} color={colors.edit} />
            </View>
          ) : null}
        </Pressable>
      );
    },
    [selected, toggle],
  );

  const viewerIndex =
    viewerId !== null && rows ? rows.findIndex((r) => r.photo_id === viewerId) : -1;

  const count = rows?.length ?? 0;
  return (
    <View style={styles.root}>
      <Text style={styles.subtitle}>
        {rows === null
          ? 'Loading…'
          : count === 0
            ? 'Queue photos with Share during review, then send them in passes.'
            : selectionMode
              ? `${selected.size} selected · ✓ marks photos already shared this cycle`
              : `${count} photo${count === 1 ? '' : 's'} · share overlapping sets to different people`}
      </Text>
      {count > 0 ? (
        <View style={styles.chips}>
          <Pressable
            style={styles.chip}
            onPress={() => setSelected(new Set((rows ?? []).map((r) => r.photo_id)))}
          >
            <Text style={styles.chipText}>Select all</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setSelected(new Set())}>
            <Text style={styles.chipText}>None</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={selectUnshared}>
            <Text style={styles.chipText}>Unshared</Text>
          </Pressable>
          {selectionMode ? (
            <Pressable style={styles.chip} onPress={() => void removeSelected()}>
              <Text style={styles.chipText}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        data={rows ?? []}
        numColumns={4}
        keyExtractor={(r) => r.photo_id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: insets.bottom + 140, gap: 4 }}
        columnWrapperStyle={{ gap: 4 }}
      />
      {viewerIndex >= 0 && rows ? (
        <PhotoViewer
          items={rows.map((r) => ({ id: r.photo_id, uri: r.uri, takenAt: r.taken_at }))}
          initialIndex={viewerIndex}
          onClose={() => setViewerId(null)}
          onChanged={() => void reload().catch(() => {})}
        />
      ) : null}
      {count > 0 ? (
        <View style={[styles.actions, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            style={[styles.shareButton, busy && styles.disabled]}
            disabled={busy}
            onPress={() => void runShare()}
          >
            <MaterialCommunityIcons name="share-variant" size={20} color={colors.text} />
            <Text style={styles.shareText}>
              {selectionMode ? `Share ${selected.size} selected` : `Share all ${count}`}
            </Text>
          </Pressable>
          <Pressable style={styles.clearButton} onPress={() => void runClear()}>
            <Text style={styles.clearText}>Clear queue</Text>
          </Pressable>
        </View>
      ) : null}
      <Modal
        visible={labelBatchId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLabelBatchId(null)}
      >
        <View style={styles.labelBackdrop}>
          <View style={styles.labelSheet}>
            <Text style={styles.labelTitle}>Label this share? (optional)</Text>
            <Text style={styles.labelHint}>A note for History about who this pass went to.</Text>
            {labelChips.length > 0 ? (
              <View style={styles.chips}>
                {labelChips.map((chip) => (
                  <Pressable key={chip} style={styles.chip} onPress={() => void saveLabel(chip)}>
                    <Text style={styles.chipText}>{chip}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <TextInput
              style={styles.labelInput}
              placeholder="e.g. Mum"
              placeholderTextColor={colors.textDim}
              value={labelText}
              onChangeText={setLabelText}
              onSubmitEditing={() => void saveLabel(labelText)}
            />
            <View style={styles.labelActions}>
              <Pressable style={styles.chip} onPress={() => setLabelBatchId(null)}>
                <Text style={styles.chipText}>Skip</Text>
              </Pressable>
              <Pressable
                style={[styles.chip, styles.chipPrimary]}
                onPress={() => void saveLabel(labelText)}
              >
                <Text style={styles.chipText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12, paddingTop: 12 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipPrimary: { backgroundColor: colors.editDim, borderColor: colors.edit },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  cell: { flex: 1 / 4, aspectRatio: 1 },
  thumb: { flex: 1, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  thumbSelected: { opacity: 0.55 },
  passBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.keepDim,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: colors.keep,
  },
  passBadgeText: { color: colors.text, fontSize: 10, fontWeight: '700' },
  selectBadge: { position: 'absolute', bottom: 4, right: 4 },
  actions: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    gap: 8,
  },
  shareButton: {
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
  shareText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  clearButton: {
    minHeight: 40,
    borderRadius: touch.radius,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  labelBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  labelSheet: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  labelTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  labelHint: { color: colors.textDim, fontSize: 13 },
  labelInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  labelActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
