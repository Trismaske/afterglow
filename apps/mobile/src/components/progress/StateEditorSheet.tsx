/**
 * The state editor (m0.8.6, F9): the state model made touchable, for one
 * photo — hosted by the standard PhotoViewer's "Change decision" row on
 * every browse surface (Progress grids, History, the queues).
 *
 * One VERDICT control (unreviewed · kept · culled) and four ACTION rows,
 * each independently addable and removable (docs/STATE_MODEL.md — the
 * layers never conflate). The refusals are the honest ones and nothing
 * more: a trashed photo is the OS's, an APPLIED organize move happened
 * (the row names the album; a new move stays addable), and a resolved
 * share left the device (a new pass stays addable). An applied
 * favourite IS removable — the queued un-favourite is modelled.
 *
 * The sheet reads its own facts row (getPhotoFacts + the share-queue
 * membership) and re-reads after every write, so it can never offer a
 * transition the durable state no longer supports; a stale host hands
 * it only the header (thumb + date).
 *
 * Verdict writes route through the ReviewContext provider — the write
 * credits the goal by construction (m0.8.5 A3), carries write priority,
 * and surfaces failure through the provider's alert. Setting a grouped
 * photo back to unreviewed is D5's one deliberate lever: when the group
 * carries Compare history the confirm names the deletion, and the write
 * clears the group's duels in the same transaction, returning the group
 * to the scan's reach (D4). Action-layer writes are direct store calls
 * under user write priority, exactly like the queue screens' own.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { editorOffer, type EditorOffer } from '../../lib/progress';
import { applyReviewDecisions, getPhotoFacts, markEditDone, type PhotoFacts } from '../../db/store';
import { decodeOrganizeTarget } from '../../db/actions';
import { addToShareQueue, isInShareQueue, removeFromShareQueue } from '../../db/shareStore';
import { queueOrganize, unqueueOrganize } from '../../db/organizeStore';
import { nextFavouriteIntent, type FavouriteStatus } from '../../lib/favouriteState';
import { useReview } from '../../review/ReviewContext';
import { withUserWritePriority } from '../../lib/writePriority';
import { dayKey, labelForDayKey, UNDATED_DAY_KEY } from '../../lib/dates';
import { formatClockSeconds } from '../../lib/format';
import { colors, touch, useTheme } from '../../theme';
import { VERDICT_META } from './stateMeta';
import type { GridPhoto } from './PhotoStateGrid';

const VERDICT_TARGETS = [
  { target: 'unreviewed', label: 'Unreviewed', meta: 'unreviewed' },
  { target: 'kept', label: 'Keep', meta: 'kept' },
  { target: 'culled', label: 'Cull', meta: 'staged' },
] as const;

function favouriteStatusOf(facts: PhotoFacts): FavouriteStatus {
  if (facts.favourite_queued === 1) return { state: 'queued_apply', target: true };
  if (facts.favourite_queued === 0) return { state: 'queued_remove', target: false };
  if (facts.favourite_applied === 1) return { state: 'applied', target: true };
  return { state: 'none', target: null };
}

/** One action row's presentation: current status + what one tap does. */
interface RowSpec {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  status: string;
  buttons: { key: string; label: string; onPress: () => void }[];
}

export function StateEditorSheet({
  photo,
  onClose,
  onChanged,
}: {
  /** Null hides the sheet. The host's row supplies only the HEADER —
   * everything offerable derives from the sheet's own facts read. */
  photo: GridPhoto | null;
  onClose: () => void;
  /** A transition was written — reload counts and the grid. */
  onChanged: () => void;
}) {
  const db = useSQLiteContext();
  const { decide, unstageCull, restoreCull, clearDecision } = useReview();
  const { accent } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  // undefined = loading; null = untracked (no row).
  const [facts, setFacts] = useState<PhotoFacts | null | undefined>(undefined);
  const [shareQueued, setShareQueued] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const photoId = photo?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setFacts(undefined);
    setLoadFailed(false);
    if (photoId === null) return;
    void Promise.all([getPhotoFacts(db, photoId), isInShareQueue(db, photoId)]).then(
      ([f, queued]) => {
        if (cancelled) return;
        setFacts(f);
        setShareQueued(queued);
      },
      (error: unknown) => {
        // FAIL CLOSED: an unreadable row must not render as "untracked,
        // read-only" — that is a confident wrong answer. Say so, retry.
        console.warn('[editor] facts read failed:', String(error));
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, photoId, tick]);

  /** Every write funnels here: run, then re-read the facts and tell the
   * host — the sheet STAYS OPEN so several edits chain naturally. */
  const run = useCallback(
    async (write: () => Promise<unknown>, surfaceErrors: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        await write();
        onChanged();
        setTick((t) => t + 1);
      } catch (error) {
        // Provider verbs alert through the writeError surface already;
        // direct store calls have only this one.
        if (surfaceErrors) {
          Alert.alert('Could not save', error instanceof Error ? error.message : String(error));
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  const setVerdict = useCallback(
    (target: 'unreviewed' | 'kept' | 'culled') => {
      if (!facts || facts.state === target) return;
      const current = facts.state;
      const expectedGroup = facts.group_id;
      if (target === 'kept') {
        void run(
          () =>
            current === 'culled'
              ? unstageCull(facts.asset_id)
              : decide(facts.asset_id, 'keep', expectedGroup),
          false,
        );
        return;
      }
      if (target === 'culled') {
        void run(() => decide(facts.asset_id, 'cull', expectedGroup), false);
        return;
      }
      // → unreviewed. D5: when the group carries Compare history, the
      // confirm names the deletion the un-review implies; the deletion
      // and the verdict land in one transaction.
      const clearGroup =
        facts.group_has_duels === 1 && expectedGroup !== null ? expectedGroup : undefined;
      const write = () =>
        current === 'culled'
          ? restoreCull(facts.asset_id, clearGroup)
          : clearDecision(facts.asset_id, clearGroup);
      if (clearGroup !== undefined) {
        Alert.alert(
          'Un-review this photo?',
          "Its group's Compare history is cleared with it, so the scan may regroup these photos.",
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Un-review', style: 'destructive', onPress: () => void run(write, false) },
          ],
        );
        return;
      }
      void run(write, false);
    },
    [facts, run, decide, unstageCull, restoreCull, clearDecision],
  );

  if (!photo) return null;
  const offer: EditorOffer | null =
    facts === undefined
      ? null
      : editorOffer({
          state: facts?.state ?? null,
          editPending: facts?.needs_edit === 1,
          favouriteQueued: facts?.favourite_queued ?? null,
          favouriteApplied: facts?.favourite_applied === 1,
          shareQueued,
          organizeQueued: facts?.organize_queued === 1,
        });
  const meta = VERDICT_META[photo.effective];
  const now = () => Date.now();

  const rows: RowSpec[] = [];
  if (facts && offer && offer.readOnly === null) {
    const direct = (write: () => Promise<unknown>) => () =>
      void run(() => withUserWritePriority(write), true);
    // --- edit
    rows.push({
      icon: 'pencil-outline',
      label: 'Edit',
      status:
        offer.edit === 'queued'
          ? 'In the edit queue'
          : facts.edit_completed_at !== null
            ? 'Edit completed'
            : 'No edit asked',
      buttons:
        offer.edit === 'queued'
          ? [
              {
                key: 'done',
                label: 'Mark done',
                onPress: direct(() => markEditDone(db, facts.asset_id)),
              },
              {
                key: 'remove',
                label: 'Remove',
                onPress: direct(() =>
                  applyReviewDecisions(db, [], now(), {
                    needsEditChanges: [{ assetId: facts.asset_id, needsEdit: false }],
                  }),
                ),
              },
            ]
          : [
              {
                key: 'add',
                label: 'Queue an edit',
                onPress: direct(() =>
                  applyReviewDecisions(db, [], now(), {
                    needsEditChanges: [{ assetId: facts.asset_id, needsEdit: true }],
                  }),
                ),
              },
            ],
    });
    // --- favourite (tri-state honest; nextFavouriteIntent is the same
    // pure transition the deck's heart uses)
    const favStatus = favouriteStatusOf(facts);
    rows.push({
      icon: offer.favourite === 'cancel_remove' ? 'heart-off-outline' : 'heart-outline',
      label: 'Favourite',
      status:
        offer.favourite === 'cancel_add'
          ? 'Favourite queued'
          : offer.favourite === 'cancel_remove'
            ? 'Removal queued'
            : offer.favourite === 'remove_applied'
              ? 'Favourited in the gallery'
              : 'Not favourited',
      buttons: [
        {
          key: 'toggle',
          label:
            offer.favourite === 'add'
              ? 'Add favourite'
              : offer.favourite === 'cancel_add'
                ? 'Cancel'
                : offer.favourite === 'remove_applied'
                  ? 'Remove'
                  : 'Cancel removal',
          onPress: direct(() =>
            applyReviewDecisions(db, [], now(), {
              favouriteChanges: [nextFavouriteIntent(facts.asset_id, favStatus)],
            }),
          ),
        },
      ],
    });
    // --- share (a resolved pass is fact; only a new pass is addable)
    rows.push({
      icon: 'share-variant-outline',
      label: 'Share',
      status:
        offer.share === 'remove'
          ? 'In the share queue'
          : facts.share_carried === 1
            ? 'Shared before'
            : 'Not shared',
      buttons: [
        offer.share === 'remove'
          ? {
              key: 'remove',
              label: 'Remove',
              onPress: direct(() => removeFromShareQueue(db, facts.asset_id, now())),
            }
          : {
              key: 'add',
              label: 'Add to share queue',
              onPress: direct(() => addToShareQueue(db, facts.asset_id, now())),
            },
      ],
    });
    // --- organize (queue-then-assign, m0.8.2 F6: the album is chosen on
    // the Organize screen, so adding here needs no picker — the same
    // target-less queue row the deck's chip writes)
    const appliedAlbum =
      facts.organize_applied_target !== null
        ? decodeOrganizeTarget(facts.organize_applied_target)?.path
        : null;
    rows.push({
      icon: 'folder-move-outline',
      label: 'Organize',
      status:
        offer.organize === 'remove'
          ? 'Move queued'
          : facts.organize_applied_at !== null
            ? `Moved to ${appliedAlbum ?? 'an album'}`
            : 'No move asked',
      buttons: [
        offer.organize === 'remove'
          ? {
              key: 'remove',
              label: 'Remove',
              onPress: direct(() => unqueueOrganize(db, facts.asset_id, now())),
            }
          : {
              key: 'add',
              label: 'Queue a move',
              onPress: direct(async () => {
                const refusal = await queueOrganize(db, facts.asset_id, now());
                if (refusal !== null) throw new Error(refusal);
              }),
            },
      ],
    });
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop backdrop-press from closing when tapping the card. */}
        <Pressable style={[styles.card, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
          <View style={styles.header}>
            <Image
              source={{ uri: photo.uri }}
              style={styles.thumb}
              contentFit="cover"
              recyclingKey={photo.id}
            />
            <View style={styles.headerBody}>
              <View style={styles.stateLine}>
                <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                <Text style={styles.stateLabel}>{meta.label}</Text>
              </View>
              <Text style={styles.when}>
                {/* Date honesty (change 5): a NULL day is a tracked,
                    honestly-undated photo — takenAt is the mtime
                    fallback, so name the unknown and print no clock. */}
                {photo.day === null
                  ? labelForDayKey(UNDATED_DAY_KEY)
                  : `${labelForDayKey(photo.day ?? dayKey(photo.takenAt))} · ${formatClockSeconds(photo.takenAt)}`}
              </Text>
            </View>
          </View>

          {loadFailed ? (
            <Pressable onPress={() => setTick((t) => t + 1)}>
              <Text style={styles.readOnly}>
                Could not read this photo's state just now — tap to retry.
              </Text>
            </Pressable>
          ) : offer === null ? (
            <Text style={styles.readOnly}>Loading…</Text>
          ) : offer.readOnly !== null ? (
            <Text style={styles.readOnly}>
              {offer.readOnly === 'trashed'
                ? 'Moved to the system trash — your gallery controls how long it remains recoverable.'
                : 'Not analyzed yet — the scan will pick it up shortly.'}
            </Text>
          ) : (
            <>
              {/* The verdict control: three fixed-hue chips, selection as
                  an accent outline (rule 4 — never a fill). */}
              <View style={styles.verdictRow}>
                {VERDICT_TARGETS.map(({ target, label, meta: metaKey }) => {
                  const active = offer.verdict === target;
                  return (
                    <Pressable
                      key={target}
                      style={[
                        styles.verdictChip,
                        active && [styles.verdictChipActive, { borderColor: accent }],
                        busy && styles.dimmed,
                      ]}
                      disabled={busy || active}
                      onPress={() => setVerdict(target)}
                      accessibilityLabel={`Set verdict: ${label}`}
                    >
                      <View
                        style={[
                          styles.verdictSwatch,
                          { backgroundColor: VERDICT_META[metaKey].color },
                        ]}
                      />
                      <Text style={styles.verdictLabel}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {rows.map((row) => (
                <View key={row.label} style={styles.actionRow}>
                  <MaterialCommunityIcons name={row.icon} size={20} color={colors.text} />
                  <View style={styles.actionBody}>
                    <Text style={styles.actionLabel}>{row.label}</Text>
                    <Text style={styles.actionStatus}>{row.status}</Text>
                  </View>
                  {row.buttons.map((button) => (
                    <Pressable
                      key={button.key}
                      style={[styles.actionButton, busy && styles.dimmed]}
                      disabled={busy}
                      onPress={button.onPress}
                    >
                      <Text style={styles.actionButtonText}>{button.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </>
          )}

          <Pressable style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: touch.radius,
    borderTopRightRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  header: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  thumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  headerBody: { flex: 1, gap: 2, justifyContent: 'center' },
  stateLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 4 },
  stateLabel: { color: colors.text, fontSize: 17, fontWeight: '800' },
  when: { color: colors.textDim, fontSize: 13 },
  readOnly: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  verdictRow: { flexDirection: 'row', gap: 6 },
  verdictChip: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: touch.radius - 4,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  verdictChipActive: { backgroundColor: colors.surfaceRaised },
  verdictSwatch: { width: 12, height: 4, borderRadius: 2 },
  verdictLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  actionRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: touch.radius,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionBody: { flex: 1, gap: 1 },
  actionLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  actionStatus: { color: colors.textDim, fontSize: 12 },
  actionButton: {
    minHeight: 36,
    borderRadius: touch.radius - 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  dimmed: { opacity: 0.5 },
  close: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
});
