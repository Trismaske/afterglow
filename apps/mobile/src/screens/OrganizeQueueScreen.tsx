/**
 * Organize queue (m0.7 item E; redesigned m0.8.2, F6/F7 — share-parity).
 * The deck queues photos with NO target (its Organize chip is a toggle);
 * THIS screen assigns albums in batches over a selectable thumbnail grid
 * — the same selection language as the share queue: tap toggles,
 * long-press opens the viewer, nothing selected means "everyone".
 * "Choose album" runs the picker ONCE for the whole selection
 * (setOrganizeTargets); cells wear their album as a small amber tag
 * ("No album" until assigned; error rows badge red and retry on the next
 * move). "Move" applies TARGETED rows only — one createWriteRequest
 * consent per album per bounded batch, verified RELATIVE_PATH moves, and
 * one SQLite transaction per batch commits outcomes + post-move repair
 * (organizeStore.ts); untargeted rows are structurally unmovable and are
 * said out loud, never silently skipped.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { invalidateMountedVolumes, mountedVolumeSet } from '../lib/mountedVolumes';
import type { MainTabScreenProps } from '../navigation';
import {
  commitOrganizeOutcomes,
  getOrganizeQueue,
  ORGANIZE_BATCH_LIMIT,
  setOrganizeTargets,
  unqueueOrganize,
  type OrganizeQueueRow,
} from '../db/organizeStore';
import {
  moveMediaToRelativePath,
  queryMediaRelativePaths,
  requestMediaWriteAccess,
} from '../../modules/media-store-actions';
import { getEditableContentUri, PRIMARY_VOLUME } from '../lib/media';
import { showToast } from '../lib/toast';
import { describeOrganizeFailures, type OrganizeFailure } from '../lib/organizeFailures';
import { colors, touch, useTheme } from '../theme';
import { AlbumPicker } from '../components/AlbumPicker';
import { Chip, QueueGridCell } from '../components/QueueGrid';
import { QueueViewer } from '../components/QueueViewer';
import { QUEUE_REFRESH_FAILED, useQueueRows } from '../components/useQueueRows';
import { useReview } from '../review/ReviewContext';
import { requestRescan } from '../scan/scanRunner';

type Props = MainTabScreenProps<'OrganizeQueue'>;

/** The album a target path reads as, for the cell tag: its last segment. */
function albumLabel(path: string): string {
  const segments = path.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || path;
}

/** The rejection surface for this screen's queue writes (CompareScreen's
 * surfaceQueueWriteError family): every mutation here can reject after
 * the tap — including a SQLite commit failing AFTER native moves
 * succeeded — and an unhandled rejection would mean no error, no reload,
 * stale metadata. The caller reloads alongside, so retryable rows stay
 * visible and the screen reflects the durable rows as they stand. */
function surfaceQueueWriteError(detail: string, error: unknown): void {
  Alert.alert(
    'Change not saved',
    `${detail}\n\n${error instanceof Error ? error.message : String(error)}`,
  );
}

export function OrganizeQueueScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refresh: refreshReview, refreshQueuedFor } = useReview();
  const {
    rows,
    failed,
    reload: reloadRows,
  } = useQueueRows<OrganizeQueueRow>(
    useCallback(async () => getOrganizeQueue(db, await mountedVolumeSet()), [db]),
  );
  /** Every mutation here also moves the organize BADGE on review
   * surfaces (deck, Groups) — the provider's membership map is their
   * source. */
  const reload = useCallback(async () => {
    await reloadRows();
    await refreshQueuedFor().catch(() => {});
  }, [reloadRows, refreshQueuedFor]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Synchronous apply lock: async continuations (picker choice) must
  // observe the CURRENT applying state, not a stale render.
  const busyRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** In-app full-screen viewer (gate 5) — long-press a thumbnail. */
  const [viewerId, setViewerId] = useState<string | null>(null);

  // Selection follows the queue: ids that left it (moved away, removed
  // elsewhere) must not linger invisibly selected.
  useEffect(() => {
    if (rows === null) return;
    setSelected((old) => new Set([...old].filter((id) => rows.some((r) => r.photo_id === id))));
  }, [rows]);

  const selectionMode = selected.size > 0;
  /** Who "Choose album" / "Remove" acts on: the selection, else everyone
   * (the share queue's convention). */
  const targetIds = useMemo(
    () => (selectionMode ? [...selected] : (rows ?? []).map((r) => r.photo_id)),
    [selectionMode, selected, rows],
  );
  const targeted = useMemo(() => (rows ?? []).filter((r) => r.organize_path !== null), [rows]);
  const untargetedCount = (rows?.length ?? 0) - targeted.length;

  const toggle = useCallback((id: string) => {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectUntargeted = useCallback(() => {
    setSelected(
      new Set((rows ?? []).filter((r) => r.organize_path === null).map((r) => r.photo_id)),
    );
  }, [rows]);

  const chooseAlbum = useCallback(
    async (relativePath: string) => {
      if (busyRef.current || targetIds.length === 0) return;
      try {
        const error = await setOrganizeTargets(
          db,
          targetIds,
          { volumeName: PRIMARY_VOLUME, relativePath },
          Date.now(),
        );
        setPickerOpen(false);
        if (error) {
          Alert.alert('Cannot use that album', error);
          return;
        }
        setSelected(new Set());
        await reload();
      } catch (error) {
        setPickerOpen(false);
        surfaceQueueWriteError(
          'Afterglow could not finish saving that album assignment. The tags below show what actually stands — please retry.',
          error,
        );
        // The alert already carries the failure; a second rejection here
        // has nothing further to say (the focus effect re-reads anyway).
        await reload().catch(() => {});
      }
    },
    [db, targetIds, reload],
  );

  /** Remove from the queue: the selection, else EVERYONE — the same
   * no-selection-means-everyone convention Choose album follows, with
   * the blast radius said in the chip's copy ("Remove all N"). */
  const removeQueued = useCallback(async () => {
    try {
      // The M5 rule (Tristan, grilling Q2): an EXPLICIT selection acts
      // on its targets regardless of mount state — the user asked for
      // exactly those rows and would have gotten the same result before
      // the eject. Only the untargeted "Remove all" binds to the fresh
      // reachable queue (T7): it must not delete/demote the pending
      // organize of photos the bulk sweep never showed as its scope.
      let bounded: readonly string[] = targetIds;
      if (selected.size === 0) {
        invalidateMountedVolumes(); // LIVE mount state for a bulk write (V3)
        const fresh = new Set(
          (await getOrganizeQueue(db, await mountedVolumeSet())).map((r) => r.photo_id),
        );
        bounded = targetIds.filter((id) => fresh.has(id));
      }
      for (const id of bounded) {
        await unqueueOrganize(db, id, Date.now());
      }
      setSelected(new Set());
      await reload();
    } catch (error) {
      surfaceQueueWriteError(
        'Afterglow could not finish removing those photos from the queue. The grid below shows what actually stands — please retry.',
        error,
      );
      await reload().catch(() => {});
    }
  }, [db, targetIds, selected.size, reload]);

  const applyAll = useCallback(async () => {
    if (busy || busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    try {
      // Revalidate the DURABLE intents at apply time — the rendered rows
      // may predate a just-tapped assignment/removal whose write is still
      // landing (same-connection FIFO makes this read see it). Only
      // TARGETED rows can move; the rest are reported, not skipped
      // silently. BOUNDED to the rendered rows (final cycle U3): "Move
      // N" authorizes the N rows on screen — the fresh read may shrink
      // that set, never physically move photos queued elsewhere that
      // this screen never showed.
      const rendered = new Set((rows ?? []).map((r) => r.photo_id));
      invalidateMountedVolumes(); // LIVE mount state for a bulk write (V3)
      const freshQueue = (await getOrganizeQueue(db, await mountedVolumeSet())).filter((r) =>
        rendered.has(r.photo_id),
      );
      const freshRows = freshQueue.filter(
        (row): row is OrganizeQueueRow & { organize_path: string; organize_volume: string } =>
          row.organize_path !== null && row.organize_volume !== null,
      );
      // Untargeted rows are REPORTED from the same fresh read the apply
      // uses — the rendered count can predate an assignment still
      // landing, and a report from a different snapshot than the apply
      // would mislabel what actually stayed.
      const freshUntargeted = freshQueue.length - freshRows.length;
      if (freshRows.length === 0) {
        // The button was enabled off rendered rows the durable intents no
        // longer back — say so rather than returning silently.
        showToast('Nothing to move — no queued photo has an album yet');
        await reload();
        return;
      }
      // Group queued photos by target path; apply per target in bounded
      // batches (each batch = one consent + one verified move set).
      const byTarget = new Map<string, (typeof freshRows)[number][]>();
      for (const row of freshRows) {
        const list = byTarget.get(row.organize_path) ?? [];
        list.push(row);
        byTarget.set(row.organize_path, list);
      }
      let moved = 0;
      /** Every failed row of this run, with the two facts the dialog
       * needs: the photo's own uri (which is how we diagnose without
       * reading Android's error text) and whatever came back with it. */
      const failures: OrganizeFailure[] = [];
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
          // Carry the failures OUT of the batch loop (m0.8.4): the row's
          // uri and the outcome's message are the whole input to the
          // explanation below, and nothing durable holds either —
          // photo_actions has no message column, and adding one is a
          // schema reset for a string the retry regenerates on demand
          // (docs/TODO.md). So the dialog is raised while we still have
          // them, from the run that produced them.
          for (const outcome of outcomes) {
            if (outcome.status !== 'error' && outcome.status !== 'unsupported') continue;
            const row = batch.find((m) => m.photo_id === outcome.photoId);
            failures.push({
              uri: row?.uri ?? '',
              status: outcome.status,
              message: outcome.message,
            });
          }
        }
      }
      const failed = failures.length;
      // Field diagnostic, on in every build until v1 like the [scan] and
      // [perf] lines: the one place a failed move's cause is recoverable
      // after the dialog is dismissed.
      for (const f of failures) console.warn('[organize] move failed:', f.status, f.message, f.uri);
      const skipped = freshUntargeted > 0 ? ` · ${freshUntargeted} without an album stayed` : '';
      const report = describeOrganizeFailures(failures);
      if (report) {
        // A failure gets the DIALOG, not the toast: a toast that says
        // "3 failed" and vanishes is exactly the dead end this replaces,
        // and two notifications for one run is noise. The toast keeps
        // the clean and declined paths, which have nothing to explain.
        Alert.alert(
          report.title,
          `${moved > 0 ? `Moved ${moved}.\n\n` : ''}${report.body}${skipped}`,
        );
      } else {
        showToast(
          declined
            ? `Moved ${moved} — the rest stay queued`
            : `Moved ${moved} photo${moved === 1 ? '' : 's'}${skipped}`,
        );
      }
      await reload();
      if (moved > 0) {
        // Moves changed photos.uri (and possibly their source folder):
        // the cached review queue would keep dead pre-move URIs — and a
        // rescan re-derives windows under the fresh paths.
        await refreshReview().catch(() => {});
        void requestRescan(db);
      }
    } catch (error) {
      // A native move can succeed and its SQLite commit still fail —
      // without this surface that was an unhandled rejection: no error,
      // no reload, stale tags. Everything still queued is retryable, and
      // an already-moved photo is repaired (read-only precheck →
      // 'already') on the next Move.
      surfaceQueueWriteError(
        'Afterglow could not finish recording the move. Some photos may already have moved — everything still queued below is picked up again on the next Move.',
        error,
      );
      await reload().catch(() => {});
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [busy, db, rows, reload, refreshReview]);

  const renderItem = useCallback(
    ({ item }: { item: OrganizeQueueRow }) => (
      <QueueGridCell
        id={item.photo_id}
        uri={item.uri}
        selected={selected.has(item.photo_id)}
        accent={theme.accent}
        onPress={() => toggle(item.photo_id)}
        onLongPress={() => setViewerId(item.photo_id)}
      >
        <View style={[styles.targetTag, item.organize_path === null && styles.targetTagEmpty]}>
          <MaterialCommunityIcons
            name={item.organize_path === null ? 'folder-question-outline' : 'folder-move'}
            size={11}
            color={item.organize_path === null ? colors.textDim : colors.organize}
          />
          <Text style={styles.targetTagText} numberOfLines={1}>
            {item.organize_path === null ? 'No album' : albumLabel(item.organize_path)}
          </Text>
        </View>
        {item.state === 'error' ? (
          <MaterialCommunityIcons
            name="alert-circle"
            size={16}
            color={colors.cull}
            style={styles.errorBadge}
          />
        ) : null}
      </QueueGridCell>
    ),
    [selected, theme.accent, toggle],
  );

  const count = rows?.length ?? 0;
  const errorCount = (rows ?? []).filter((r) => r.state === 'error').length;
  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.heading}>Organize queue</Text>
      <Text style={styles.subtitle}>
        {rows === null
          ? // codex r9: an initial reload failure would have said
            // "Loading…" forever — the empty-state line says what happened.
            failed
            ? QUEUE_REFRESH_FAILED
            : 'Loading…'
          : count === 0
            ? 'Queue photos with Organize during review, then assign albums here.'
            : selectionMode
              ? `${selected.size} selected · choose their album, or remove them`
              : `${count} queued${untargetedCount > 0 ? ` · ${untargetedCount} need an album` : ''}${errorCount > 0 ? ` · ${errorCount} failed, retried on the next move` : ''}`}
      </Text>
      {count > 0 ? (
        <View style={styles.chips}>
          <Chip
            label="Select all"
            onPress={() => setSelected(new Set((rows ?? []).map((r) => r.photo_id)))}
          />
          <Chip label="None" onPress={() => setSelected(new Set())} />
          {untargetedCount > 0 ? <Chip label="No album" onPress={selectUntargeted} /> : null}
          <Chip
            label={selectionMode ? 'Remove' : `Remove all ${count}`}
            onPress={() => void removeQueued()}
          />
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
        contentContainerStyle={{ paddingBottom: 150, gap: 4 }}
        columnWrapperStyle={{ gap: 4 }}
      />
      <QueueViewer
        rows={rows}
        viewerId={viewerId}
        toItem={(r) => ({ id: r.photo_id, uri: r.uri, takenAt: r.taken_at })}
        onClose={() => setViewerId(null)}
        onChanged={() => void reload().catch(() => {})}
      />
      {count > 0 ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.assignButton, busy && styles.disabled]}
            disabled={busy}
            onPress={() => setPickerOpen(true)}
          >
            <MaterialCommunityIcons name="folder-image" size={20} color={colors.text} />
            <Text style={styles.assignText}>
              {selectionMode
                ? `Choose album for ${selected.size}`
                : `Choose album for all ${count}`}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.applyButton, (busy || targeted.length === 0) && styles.disabled]}
            disabled={busy || targeted.length === 0}
            onPress={() => void applyAll()}
          >
            <MaterialCommunityIcons name="folder-move" size={20} color={colors.text} />
            <Text style={styles.applyText}>
              {busy ? 'Moving…' : `Move ${targeted.length} to albums`}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <AlbumPicker
        visible={pickerOpen}
        onChoose={(path) => void chooseAlbum(path)}
        onClose={() => setPickerOpen(false)}
      />
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
  // The cell's album tag: the organize hue marks an assigned target
  // (rule 2 — the hue identifies the kind); "No album" stays neutral.
  targetTag: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.organizeDim,
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  targetTagEmpty: { backgroundColor: colors.surfaceRaised },
  targetTagText: { color: colors.text, fontSize: 10, fontWeight: '600', flexShrink: 1 },
  errorBadge: { position: 'absolute', top: 4, right: 4 },
  actions: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    gap: 8,
  },
  assignButton: {
    minHeight: 44,
    borderRadius: touch.radius,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  assignText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  applyButton: {
    minHeight: 52,
    borderRadius: touch.radius,
    // The organize action's own hue, matching the deck's Organize
    // control (rule 2).
    backgroundColor: colors.organizeDim,
    borderWidth: 1,
    borderColor: colors.organize,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  applyText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
