/**
 * Re-decide sheet (m0.5 reversible decisions): tap a DECIDED photo
 * anywhere it is visible in-session (group strips, completed-group
 * browse, cull list) and change its verdict — keep / to edit / cull —
 * until the final cull confirmation. Wraps SessionContext.redecide
 * (core unstageCull/cullKept + the app-side needs-edit flag); the modal
 * chrome follows the m0.4 StateEditorSheet.
 */
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaItem } from '@afterglow/core';
import { useSession, type RedecideTarget } from '../session/SessionContext';
import { formatClockSeconds } from '../lib/format';
import { colors, touch, useTheme } from '../theme';

/** The three re-decidable verdicts ('to_edit' = kept + needs-edit flag). */
export type DecidedState = 'kept' | 'to_edit' | 'culled';

const CHIP_META: Record<RedecideTarget, { label: string; color: string; dim: string }> = {
  keep: { label: '✓ Keep', color: colors.keep, dim: colors.keepDim },
  to_edit: { label: '✎ To edit', color: colors.edit, dim: colors.editDim },
  cull: { label: '✕ Cull', color: colors.cull, dim: colors.cullDim },
};

const STATE_LABEL: Record<DecidedState, string> = {
  kept: 'Keeping it',
  to_edit: 'Keeping it — in the edit queue',
  culled: 'Staged to cull',
};

const stateToTarget: Record<DecidedState, RedecideTarget> = {
  kept: 'keep',
  to_edit: 'to_edit',
  culled: 'cull',
};

export function ReDecideSheet({
  item,
  current,
  onClose,
}: {
  /** Null hides the sheet. */
  item: MediaItem | null;
  current: DecidedState;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { redecide } = useSession();
  const [busy, setBusy] = useState(false);

  const pick = useCallback(
    async (target: RedecideTarget) => {
      if (!item || busy) return;
      if (target === stateToTarget[current]) {
        onClose();
        return;
      }
      setBusy(true);
      try {
        await redecide(item.id, target);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [item, busy, current, redecide, onClose],
  );

  if (!item) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop backdrop-press from closing when tapping the card. */}
        <Pressable style={[styles.card, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
          <View style={styles.header}>
            <Image
              source={{ uri: item.uri }}
              style={styles.thumb}
              contentFit="cover"
              recyclingKey={item.id}
            />
            <View style={styles.headerBody}>
              <Text style={styles.stateLabel}>{STATE_LABEL[current]}</Text>
              <Text style={styles.when}>{formatClockSeconds(item.timestamp)}</Text>
              <Text style={styles.hint}>
                Change your mind any time before the final delete confirmation.
              </Text>
            </View>
          </View>

          <View style={styles.chipRow}>
            {(Object.keys(CHIP_META) as RedecideTarget[]).map((target) => {
              const meta = CHIP_META[target];
              const active = stateToTarget[current] === target;
              return (
                <Pressable
                  key={target}
                  style={[
                    styles.chip,
                    { backgroundColor: meta.dim },
                    active && { borderColor: meta.color, borderWidth: 2 },
                  ]}
                  disabled={busy}
                  onPress={() => void pick(target)}
                >
                  <Text style={styles.chipText}>{meta.label}</Text>
                  {active && <Text style={[styles.chipCurrent, { color: theme.accent }]}>current</Text>}
                </Pressable>
              );
            })}
          </View>

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
    gap: 12,
  },
  header: { flexDirection: 'row', gap: 12 },
  thumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  headerBody: { flex: 1, gap: 2, justifyContent: 'center' },
  stateLabel: { color: colors.text, fontSize: 16, fontWeight: '800' },
  when: { color: colors.textDim, fontSize: 13 },
  hint: { color: colors.textDim, fontSize: 12 },
  chipRow: { flexDirection: 'row', gap: 10 },
  chip: {
    flex: 1,
    minHeight: 56,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    gap: 2,
  },
  chipText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  chipCurrent: { fontSize: 11, fontWeight: '700' },
  close: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: colors.textDim, fontSize: 15, fontWeight: '600' },
});
