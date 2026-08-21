import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { resolveSources } from '../lib/sourceCatalog';
import type { MainTabScreenProps } from '../navigation';
import { setNeedsEdit, getToEditPhotos, markEditDone, type ToEditRow } from '../db/store';
import { withUserWritePriority } from '../lib/writePriority';
import { useReview } from '../review/ReviewContext';
import { getEditableContentUri } from '../lib/media';
import { launchEditor, launchViewer } from '../lib/edit';
import { ACTION_EDIT, ACTION_VIEW } from '../lib/editActions';
import { describeEditLaunchFailure } from '../lib/editLaunchFailures';
import type { EditLaunchStage } from '../lib/edit';
import { probeEditLaunch, type ProbeLaunchResult } from '../../modules/media-store-actions';
import { EditDiagnosticsSheet } from '../components/EditDiagnosticsSheet';
import { QueueViewer } from '../components/QueueViewer';
import { QUEUE_REFRESH_FAILED, useQueueRows } from '../components/useQueueRows';
import { QueueRemoveChip } from '../components/QueueRemoveChip';
import { showToast } from '../lib/toast';
import { labelForDayKey } from '../lib/dates';
import { formatClock } from '../lib/format';
import { colors, touch, useTheme } from '../theme';

type Props = MainTabScreenProps<'EditQueue'>;

/**
 * The to-edit queue (PLAN.md: Android has no virtual gallery albums, so
 * the queue lives in-app). Every photo flagged "needs edit", across all
 * days. Two explicit launch buttons per row (m0.7 item A, tester
 * decision): **Edit here** fires write-request-first ACTION_EDIT (Google
 * Photos-style editors); **View only** opens the read-only viewer whose
 * own edit button has its own write powers (Samsung Gallery-style). Mark
 * done is always available manually (edit *detection* is m0.3).
 */
export function EditQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refresh } = useReview();
  const { rows, failed, reload } = useQueueRows(
    useCallback(
      async () =>
        getToEditPhotos(db, await mountedVolumeSet(), (await resolveSources(db)).roots ?? null),
      [db],
    ),
    'edit',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  // Gate-0 (m0.7 item A): the editor-launch diagnostic matrix, opened from
  // the failure alert or by long-pressing Edit (proactive/emulator path).
  const [matrixAssetId, setMatrixAssetId] = useState<string | null>(null);
  /** In-app full-screen viewer (gate 5) — thumbnail tap. */
  const [viewerId, setViewerId] = useState<string | null>(null);

  const markDone = useCallback(
    async (assetId: string) => {
      await withUserWritePriority(() => markEditDone(db, assetId));
      await refresh();
      await reload();
    },
    [db, reload, refresh],
  );

  /** Confirmed clear-all (m0.8.7 shared bar): bound to the rendered rows
   * intersected with a fresh scoped read — the M5 rule; the write may
   * shrink, never widen past what the screen showed. */
  const removeAll = useCallback(async () => {
    try {
      const rendered = new Set((rows ?? []).map((r) => r.asset_id));
      const fresh = (
        await getToEditPhotos(
          db,
          await mountedVolumeSet(),
          (await resolveSources(db)).roots ?? null,
        )
      ).filter((r) => rendered.has(r.asset_id));
      for (const row of fresh) {
        await withUserWritePriority(() => setNeedsEdit(db, row.asset_id, false, Date.now()));
      }
      await refresh();
      await reload();
    } catch (error) {
      console.warn('[edit] queue clear failed:', String(error));
      Alert.alert('Could not clear the queue', 'The list below shows what actually stands.');
      await reload().catch(() => {});
    }
  }, [db, rows, refresh, reload]);

  const askMarkDone = useCallback(
    (assetId: string) => {
      // Editors rarely report a useful result code, so ask instead of
      // guessing. Auto-detection of saved edits is m0.3.
      Alert.alert('Done editing?', 'Mark this photo as done and clear it from the queue?', [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Mark done', onPress: () => void markDone(assetId) },
      ]);
    },
    [markDone],
  );

  /** The three-tier report (Errors_design §4.4/D2): after a DISPATCH
   * failure, one probeLaunch supplies the classifier's typed fact (our
   * Kotlin's verdict — 'no_handler', 'security', …); resolve and
   * write-request failures are our own stage facts and need no probe.
   * The matrix stays one tap away, exactly as before. */
  const failureAlert = useCallback(
    async (
      assetId: string,
      operation: 'edit' | 'view',
      result: { stage: EditLaunchStage; error: string; uri: string },
    ) => {
      let probe: ProbeLaunchResult['result'] | undefined;
      if (result.stage === 'dispatch') {
        try {
          probe = (
            await probeEditLaunch(
              result.uri,
              operation === 'edit' ? ACTION_EDIT : ACTION_VIEW,
              false,
            )
          ).result;
        } catch (error) {
          console.warn('[edit] post-failure probe unavailable:', String(error));
        }
      }
      const report = describeEditLaunchFailure({
        operation,
        stage: result.stage,
        probe,
        error: result.error,
      });
      Alert.alert(report.title, report.body, [
        { text: 'Close', style: 'cancel' },
        { text: 'Run permission matrix', onPress: () => setMatrixAssetId(assetId) },
      ]);
    },
    [],
  );

  const openEditor = useCallback(
    async (row: ToEditRow) => {
      if (busyId) return;
      setBusyId(row.asset_id);
      try {
        const contentUri = await getEditableContentUri(row.asset_id);
        // m0.7 item A: write-request-first EDIT (gate-0 matrix mechanism).
        const result = await launchEditor(contentUri, (writeGranted) => {
          if (!writeGranted) showToast('Editing read-only — saves become a copy');
        });
        if (result.outcome === 'failed') {
          await failureAlert(row.asset_id, 'edit', result);
          return;
        }
        if (result.outcome === 'returned') askMarkDone(row.asset_id);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, askMarkDone, failureAlert],
  );

  const openGallery = useCallback(
    async (row: ToEditRow) => {
      if (busyId) return;
      setBusyId(row.asset_id);
      try {
        const contentUri = await getEditableContentUri(row.asset_id);
        const result = await launchViewer(contentUri);
        if (result.outcome === 'failed') {
          await failureAlert(row.asset_id, 'view', result);
          return;
        }
        if (result.outcome === 'returned') askMarkDone(row.asset_id);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, askMarkDone, failureAlert],
  );

  const renderItem = useCallback(
    ({ item }: { item: ToEditRow }) => (
      <View style={styles.row}>
        <Pressable onPress={() => setViewerId(item.asset_id)}>
          <Image
            source={{ uri: item.uri }}
            style={styles.thumb}
            contentFit="cover"
            recyclingKey={item.asset_id}
          />
        </Pressable>
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
                {busyId === item.asset_id ? 'Opening…' : 'Edit here'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.rowButton, styles.galleryButton]}
              disabled={busyId !== null}
              onPress={() => void openGallery(item)}
            >
              <MaterialCommunityIcons name="image-outline" size={18} color={colors.text} />
              <Text style={styles.rowButtonText}>View only</Text>
            </Pressable>
            <Pressable
              style={[styles.rowButton, styles.doneButton, { borderColor: theme.accent }]}
              disabled={busyId !== null}
              onPress={() => void markDone(item.asset_id)}
            >
              <MaterialCommunityIcons name="check" size={18} color={theme.accent} />
              <Text style={styles.rowButtonText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [busyId, openEditor, openGallery, markDone, theme.accent],
  );

  return (
    // Tab screens render headerless — the top inset is theirs to pad.
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.heading}>Edit queue</Text>
      <Text style={styles.subtitle}>
        {rows === null
          ? // codex r9: an initial reload failure would have said
            // "Loading…" forever — the empty-state line says what happened.
            failed
            ? QUEUE_REFRESH_FAILED
            : 'Loading…'
          : rows.length === 0
            ? 'Nothing queued to edit.'
            : `${rows.length} queued · “Edit here” opens an editor that can save over the original; “View only” opens the photo read-only (use its own edit button to pick an editor)`}
      </Text>
      {rows !== null && rows.length > 0 ? (
        <View style={styles.chips}>
          {/* The shared removal affordance (m0.8.7): this queue had none. */}
          <QueueRemoveChip
            queueLabel="edit"
            count={rows.length}
            selectedCount={0}
            onRemove={() => void removeAll()}
          />
        </View>
      ) : null}
      {failed && rows !== null ? (
        // codex r9: the reload kept the last rows on a failed read — the
        // list may be stale, and it has to say so.
        <Text style={styles.refreshFailed}>{QUEUE_REFRESH_FAILED}</Text>
      ) : null}
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.asset_id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: 16 }]}
        ListEmptyComponent={
          rows !== null && rows.length === 0 ? (
            <Text style={styles.emptyText}>
              Flag keepers with “needs edit” during review and they show up here.
            </Text>
          ) : null
        }
      />
      <QueueViewer
        rows={rows}
        viewerId={viewerId}
        toItem={(r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at, day: r.day })}
        onClose={() => setViewerId(null)}
        onChanged={() =>
          void reload()
            .then(refresh)
            .catch(() => {})
        }
      />
      {matrixAssetId !== null ? (
        <EditDiagnosticsSheet assetId={matrixAssetId} onClose={() => setMatrixAssetId(null)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 2 },
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 10 },
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
  galleryButton: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Completing an edit is NOT the keep verdict, so it does not wear
  // keep-green (rule 2) — it is a confirm, and confirms take the accent.
  doneButton: { backgroundColor: colors.surfaceRaised, borderWidth: 1 },
  rowButtonText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  emptyText: { color: colors.textDim, fontSize: 15, textAlign: 'center', marginTop: 40 },
  // codex r9: quiet stale-rows notice — dim like every read-failure line.
  refreshFailed: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 8 },
});
