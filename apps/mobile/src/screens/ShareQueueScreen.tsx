/**
 * Multi-pass share queue (m0.7 item E — Tristan's sharing workflow). The
 * queue is a persistent working set: share overlapping subsets to
 * different people across repeated sheet passes, then clear explicitly.
 *
 * - Nothing selected → "Share all N" (single-recipient stays one tap).
 * - Tapping a thumbnail enters selection mode (gallery convention);
 *   header chips: Select all / none / unshared.
 * - ✓ pass-count badges count only same-cycle SHARED passes (m0.8.6
 *   D10: a chosen target app, never a merely-opened sheet) — the
 *   "who still needs this?" navigation for overlapping subsets.
 * - After a confirmed dispatch: optional, fully skippable label prompt
 *   (recent-label chips) — the only honest recipient record.
 * - Clear is explicit and warns when never-shared photos remain; share
 *   events survive the clear for History.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { invalidateMountedVolumes, mountedVolumeSet } from '../lib/mountedVolumes';
import type { MainTabScreenProps } from '../navigation';
import {
  clearShareQueue,
  createShareBatch,
  failShareBatch,
  getShareQueue,
  labelShareBatch,
  markShareBatchShared,
  promoteShareBatch,
  recentShareLabels,
  removeFromShareQueue,
  SHARE_SOFT_WARN_COUNT,
  type ShareQueueRow,
} from '../db/shareStore';
import { shareMediaUris, subscribeShareTargetChosen } from '../../modules/media-store-actions';
import { getEditableContentUri } from '../lib/media';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';
import { Chip, QueueGridCell } from '../components/QueueGrid';
import { QueueViewer } from '../components/QueueViewer';
import { QUEUE_REFRESH_FAILED, useQueueRows } from '../components/useQueueRows';
import { useReview } from '../review/ReviewContext';

type Props = MainTabScreenProps<'ShareQueue'>;

export function ShareQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refreshQueuedFor } = useReview();
  const {
    rows,
    failed,
    reload: reloadRows,
  } = useQueueRows<ShareQueueRow>(
    useCallback(async () => getShareQueue(db, Date.now(), await mountedVolumeSet()), [db]),
  );
  /** Every mutation here also moves the share BADGE on review surfaces
   * (deck, Groups) — the provider's membership map is their source. */
  const reload = useCallback(async () => {
    await reloadRows();
    await refreshQueuedFor().catch(() => {});
  }, [reloadRows, refreshQueuedFor]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [labelBatchId, setLabelBatchId] = useState<number | null>(null);
  /** The batch whose label prompt WAITS for target confirmation (codex
   * r1): prompting on sheet-open dispatch meant backing out of the
   * chooser returned to a modal claiming a pass that D10's abandon
   * sweep was about to discard. The chosen-component event is the one
   * signal a share actually happened — only it opens the prompt. */
  const awaitingLabelRef = useRef<number | null>(null);
  /** A confirmation that arrived while the chooser (or the target app)
   * still covered this activity: an Android Modal presented while the
   * activity is paused is silently swallowed — even a visible=true one
   * never shows on resume (S10e, 2026-08-20). The prompt therefore
   * waits here for the next 'active' transition. */
  const confirmedAwaitingForegroundRef = useRef<number | null>(null);
  const presentLabelPrompt = useCallback(
    (batchId: number) => {
      setLabelText('');
      setLabelBatchId(batchId);
      void reload().catch(() => {});
    },
    [reload],
  );
  const presentLabelPromptRef = useRef(presentLabelPrompt);
  presentLabelPromptRef.current = presentLabelPrompt;
  useEffect(
    () =>
      subscribeShareTargetChosen(({ token, component }) => {
        if (awaitingLabelRef.current !== token) return;
        awaitingLabelRef.current = null;
        // The prompt claims History will carry the label, so it opens
        // only once the 'shared' transition is DURABLE (codex r4): the
        // app-root subscriber's write may still be in flight — or may
        // fail, leaving the batch for the sweep. This second write is
        // idempotent (state-guarded; only the transition that lands
        // stamps members), so awaiting our own settles it either way.
        void markShareBatchShared(db, token, component, Date.now())
          .then(() => {
            if (AppState.currentState === 'active') presentLabelPromptRef.current(token);
            else confirmedAwaitingForegroundRef.current = token;
          })
          .catch((error: unknown) =>
            console.warn('[share] chosen-target record failed (no prompt):', String(error)),
          );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || confirmedAwaitingForegroundRef.current === null) return;
      const batchId = confirmedAwaitingForegroundRef.current;
      confirmedAwaitingForegroundRef.current = null;
      presentLabelPromptRef.current(batchId);
    });
    return () => sub.remove();
  }, []);
  const [labelText, setLabelText] = useState('');
  const [labelChips, setLabelChips] = useState<string[]>([]);
  /** In-app full-screen viewer (gate 5) — long-press a thumbnail
   * (a plain tap toggles pass selection). */
  const [viewerId, setViewerId] = useState<string | null>(null);

  // Selection follows the queue: ids that left it (shared away, removed
  // elsewhere) must not linger invisibly selected.
  useEffect(() => {
    if (rows === null) return;
    setSelected((old) => new Set([...old].filter((id) => rows.some((r) => r.photo_id === id))));
  }, [rows]);

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
        // REVALIDATE at press time (codex r10 P1): the rendered rows can
        // be STALE — useQueueRows deliberately keeps them when a reload
        // fails — and a share must never dispatch photos a successful
        // clear/unqueue already removed. The durable queue is the truth;
        // the selection filters it. LIVE mount state (final cycle U1):
        // within the 5 s TTL a hot-ejected card's rows would otherwise
        // still ride into the dispatched batch.
        invalidateMountedVolumes();
        const freshIds = (await getShareQueue(db, Date.now(), await mountedVolumeSet())).map(
          (r) => r.photo_id,
        );
        const freshSet = new Set(freshIds);
        // INTERSECTION in both modes (final cycle T1): the fresh read may
        // only SHRINK the batch — "Share all N" covers the N rendered
        // rows, and a card remounting before the reload commits must not
        // ride extra, unseen photos into the dispatch (or around the
        // large-batch warning, which counted the rendered ids).
        const ids = shareIds.filter((id) => freshSet.has(id));
        if (ids.length === 0) {
          showToast('Nothing to share — the queue changed under this screen');
          await reload();
          return;
        }
        // C#10 at-most-once: durable `launching` row BEFORE dispatch;
        // promote immediately after the native dispatch report. A
        // REJECTED dispatch (bridge failure) fails the batch like a
        // reported error — otherwise the durable row would stay stuck in
        // `launching` until the next process restart's recovery.
        const batchId = await createShareBatch(db, ids, Date.now());
        let dispatch: Awaited<ReturnType<typeof shareMediaUris>>;
        try {
          // codex r9: URI preparation sits INSIDE the failure handling —
          // the batch is already durably `launching`, so a rejected
          // getEditableContentUri must fail the batch exactly like a
          // dispatch error, not escape the void handler and leave the
          // queue looking stuck until startup recovery.
          // The REVALIDATED ids, not the rendered ones (scoped review
          // P1): the batch above records `ids`, and dispatching a
          // different set would send removed photos and record members
          // that never went out.
          const uris = await Promise.all(ids.map(getEditableContentUri));
          // The batch id rides the chooser as the chosen-event token
          // (D10): app-root wiring resolves the batch to 'shared' when
          // the user picks a target app. ARMED BEFORE dispatch (codex
          // r2): a fast pick can beat the JS continuation, and an
          // unarmed token would silently drop the label prompt.
          awaitingLabelRef.current = batchId;
          dispatch = await shareMediaUris(uris, batchId);
        } catch (error) {
          awaitingLabelRef.current = null;
          dispatch = {
            result: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (dispatch.result === 'dispatched') {
          await promoteShareBatch(db, batchId, Date.now());
          showToast(`Sheet opened for ${ids.length} — queue kept for more sharing`);
          setSelected(new Set());
        } else {
          awaitingLabelRef.current = null;
          await failShareBatch(db, batchId);
          Alert.alert('Share failed', dispatch.message);
        }
        await reload();
      } catch (error) {
        // Bookkeeping rejections (create/promote/fail) must not escape
        // the void handler (codex r10): a promote failure after the
        // sheet opened leaves the batch at 'launching' until startup
        // recovery reconciles it to error — say so, and reload durable
        // truth.
        console.warn('[share] batch bookkeeping failed:', String(error));
        Alert.alert(
          'Share not fully recorded',
          'The sheet may have opened, but Afterglow could not record the pass — it will reconcile on the next app start.',
        );
        await reload().catch(() => {});
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
    // The warning counts the RENDERED rows — exactly the set the bounded
    // clear below may touch (final cycle U4). A fresh queue count could
    // describe rows a remount just revealed that the write will never
    // clear ("5 of 3 photos were never shared").
    const neverShared = (rows ?? []).filter((r) => r.pass_count === 0).length;
    const total = rows?.length ?? 0;
    const message =
      neverShared > 0
        ? `${neverShared} of ${total} photos were never shared. Clear anyway?`
        : `Clear all ${total} photo${total === 1 ? '' : 's'} from the share queue? Past share events are kept in History.`;
    Alert.alert('Clear share queue', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            try {
              // The dialog can sit open across a card swap (Q5/T2): the
              // write re-reads LIVE mount state so a now-unreachable
              // row's pending share survives byte-for-byte (plan §5),
              // AND it is bounded to the rows the dialog described — a
              // remount may only shrink the clear, never add unseen
              // rows to it.
              invalidateMountedVolumes();
              await clearShareQueue(
                db,
                Date.now(),
                await mountedVolumeSet(),
                (rows ?? []).map((r) => r.photo_id),
              );
              setSelected(new Set());
            } catch (error) {
              // A rejected transaction must not close the dialog into
              // silence (final cycle V4) — say so, then show what stands.
              console.warn('[share] clear failed:', String(error));
              showToast('Could not clear the queue — nothing was changed. Try again.');
            }
            void reload();
          })(),
      },
    ]);
  }, [db, rows, reload]);

  const removeSelected = useCallback(async () => {
    for (const id of selected) await removeFromShareQueue(db, id, Date.now());
    setSelected(new Set());
    await reload();
  }, [db, selected, reload]);

  const renderItem = useCallback(
    ({ item }: { item: ShareQueueRow }) => (
      <QueueGridCell
        id={item.photo_id}
        uri={item.uri}
        selected={selected.has(item.photo_id)}
        accent={theme.accent}
        onPress={() => toggle(item.photo_id)}
        onLongPress={() => setViewerId(item.photo_id)}
      >
        {item.pass_count > 0 ? (
          <View style={styles.passBadge}>
            <MaterialCommunityIcons name="check" size={12} color={colors.text} />
            {item.pass_count > 1 ? (
              <Text style={styles.passBadgeText}>{item.pass_count}</Text>
            ) : null}
          </View>
        ) : null}
      </QueueGridCell>
    ),
    [selected, theme.accent, toggle],
  );

  const count = rows?.length ?? 0;
  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.heading}>Share queue</Text>
      <Text style={styles.subtitle}>
        {rows === null
          ? // codex r9: an initial reload failure would have said
            // "Loading…" forever — the empty-state line says what happened.
            failed
            ? QUEUE_REFRESH_FAILED
            : 'Loading…'
          : count === 0
            ? 'Queue photos with Share during review, then send them in passes.'
            : selectionMode
              ? `${selected.size} selected · ✓ marks photos already shared this cycle`
              : `${count} queued · share overlapping sets to different people`}
      </Text>
      {count > 0 ? (
        <View style={styles.chips}>
          <Chip
            label="Select all"
            onPress={() => setSelected(new Set((rows ?? []).map((r) => r.photo_id)))}
          />
          <Chip label="None" onPress={() => setSelected(new Set())} />
          <Chip label="Unshared" onPress={selectUnshared} />
          {selectionMode ? <Chip label="Remove" onPress={() => void removeSelected()} /> : null}
        </View>
      ) : null}
      {failed && rows !== null ? (
        // codex r9: the reload kept the last rows on a failed read — the
        // grid may be stale, and it has to say so.
        <Text style={styles.refreshFailed}>{QUEUE_REFRESH_FAILED}</Text>
      ) : null}
      <FlatList
        data={rows ?? []}
        numColumns={4}
        keyExtractor={(r) => r.photo_id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 140, gap: 4 }}
        columnWrapperStyle={{ gap: 4 }}
      />
      <QueueViewer
        rows={rows}
        viewerId={viewerId}
        toItem={(r) => ({ id: r.photo_id, uri: r.uri, takenAt: r.taken_at, day: r.day })}
        onClose={() => setViewerId(null)}
        onChanged={() => void reload().catch(() => {})}
      />
      {count > 0 ? (
        <View style={styles.actions}>
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
          <View style={[styles.labelSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.labelTitle}>Label this share? (optional)</Text>
            <Text style={styles.labelHint}>A note for History about who this pass went to.</Text>
            {labelChips.length > 0 ? (
              <View style={styles.chips}>
                {labelChips.map((chip) => (
                  <Chip key={chip} label={chip} onPress={() => void saveLabel(chip)} />
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
              <Chip label="Skip" onPress={() => setLabelBatchId(null)} />
              <Chip label="Save" onPress={() => void saveLabel(labelText)} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 2 },
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  // codex r9: quiet stale-rows notice — dim like every read-failure line.
  refreshFailed: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 8 },
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
  actions: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    gap: 8,
  },
  shareButton: {
    minHeight: 52,
    borderRadius: touch.radius,
    // The share action's own hue, matching the deck's Share control.
    backgroundColor: colors.shareDim,
    borderWidth: 1,
    borderColor: colors.share,
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
