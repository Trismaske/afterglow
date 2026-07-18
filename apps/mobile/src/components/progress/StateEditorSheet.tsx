/**
 * Small bottom-sheet state editor for one photo (progress pages, m0.4).
 * Shows the current state and the allowed transitions per lib/progress
 * `editorActions` (audited against the store semantics — see that
 * module's docs). Photos in the ACTIVE session are read-only here: a
 * direct DB write would desync the authoritative session snapshot.
 */
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { editorActions, type EditorAction } from '../../lib/progress';
import {
  markDoneToEdit,
  markEditDone,
  markKeptDone,
  setNeedsEdit,
  unstageCullDirect,
} from '../../db/store';
import { dayKey, labelForDayKey } from '../../lib/dates';
import { formatClockSeconds } from '../../lib/format';
import { colors, touch, useTheme } from '../../theme';
import { stateMetaFor } from './stateMeta';
import type { GridPhoto } from './PhotoStateGrid';

const ACTION_LABEL: Record<EditorAction, string> = {
  mark_done: 'Mark done',
  queue_edit: 'Send to the edit queue',
  unstage_cull: 'Un-cull — back to keepers',
};

const ACTION_ICON = {
  mark_done: 'check',
  queue_edit: 'pencil',
  unstage_cull: 'undo',
} as const;

function readOnlyHint(photo: GridPhoto, inActiveSession: boolean): string {
  if (inActiveSession) {
    return 'Part of the active review session — manage it from the session screens.';
  }
  switch (photo.dbState) {
    case 'trashed':
      return 'Moved to the system trash — your gallery controls how long it remains recoverable.';
    case 'confirmed':
      return 'Deletion in progress.';
    default:
      return 'Not reviewed yet — a review session decides keep or cull.';
  }
}

export function StateEditorSheet({
  photo,
  inActiveSession,
  onClose,
  onChanged,
}: {
  /** Null hides the sheet. */
  photo: GridPhoto | null;
  inActiveSession: boolean;
  onClose: () => void;
  /** A transition was written — reload counts and the grid. */
  onChanged: () => void;
}) {
  const db = useSQLiteContext();
  const { accent } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: EditorAction) => {
      if (!photo || busy) return;
      setBusy(true);
      try {
        // Every store call is state-guarded (`AND state = '…'`), so a
        // stale sheet acting on an already-changed row is a no-op.
        if (action === 'mark_done') {
          if (photo.dbState === 'kept') await markKeptDone(db, [photo.id]);
          else await markEditDone(db, photo.id);
        } else if (action === 'queue_edit') {
          if (photo.dbState === 'kept') await setNeedsEdit(db, photo.id, true, Date.now());
          else await markDoneToEdit(db, photo.id, Date.now());
        } else {
          await unstageCullDirect(db, photo.id, Date.now());
        }
        onChanged();
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [photo, busy, db, onChanged, onClose],
  );

  if (!photo) return null;
  const meta = stateMetaFor(accent)[photo.effective];
  const actions = editorActions(photo.dbState, inActiveSession);

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
                {labelForDayKey(dayKey(photo.takenAt))} · {formatClockSeconds(photo.takenAt)}
              </Text>
              <Text style={styles.hint}>{meta.hint}</Text>
            </View>
          </View>

          {actions.length === 0 ? (
            <Text style={styles.readOnly}>{readOnlyHint(photo, inActiveSession)}</Text>
          ) : (
            actions.map((action) => (
              <Pressable
                key={action}
                style={[styles.action, busy && styles.actionDisabled]}
                disabled={busy}
                onPress={() => void run(action)}
              >
                <MaterialCommunityIcons name={ACTION_ICON[action]} size={20} color={colors.text} />
                <Text style={styles.actionText}>{ACTION_LABEL[action]}</Text>
              </Pressable>
            ))
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
  hint: { color: colors.textDim, fontSize: 12 },
  readOnly: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  action: {
    minHeight: 52,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    flexDirection: 'row',
    gap: 8,
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  close: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
});
