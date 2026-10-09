/**
 * The one action-chip control (m0.8.2, F16): Edit · Favourite · Organize
 * · Share as uniform icon+label buttons, extracted from the deck's two
 * render branches and adopted by Compare so every review surface offers
 * the four actions identically (rule 2: each chip lights in its own
 * action hue when the current photo has that action waiting). The chip
 * OFFERS work, so it reflects the pending state only — the photo's
 * badges are the carried-history view.
 */
import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import { Icon, type IconName } from './Icon';
import { colors, radius, type } from '../theme';

export type ActionChipKind = 'edit' | 'favourite' | 'organize' | 'share';

const META: Record<
  ActionChipKind,
  {
    icon: IconName;
    activeIcon: IconName;
    color: string;
    dim: string;
    label: string;
  }
> = {
  edit: {
    // The idle glyph is the outline, like the other three: a waiting
    // edit is told from none by the glyph as well as the hue (tester,
    // phase 6 device round 2026-09-25).
    icon: 'pencil-outline',
    activeIcon: 'pencil',
    color: colors.edit,
    dim: colors.editDim,
    label: 'Edit',
  },
  favourite: {
    icon: 'heart-outline',
    activeIcon: 'heart',
    color: colors.fav,
    dim: colors.favDim,
    label: 'Favourite',
  },
  organize: {
    icon: 'folder-move-outline',
    activeIcon: 'folder-move',
    color: colors.organize,
    dim: colors.organizeDim,
    label: 'Organize',
  },
  share: {
    icon: 'share-variant-outline',
    activeIcon: 'share-variant',
    color: colors.share,
    dim: colors.shareDim,
    label: 'Share',
  },
};

export function ActionChip({
  kind,
  active,
  iconOnly = false,
  onLabelLayout,
  disabled = false,
  dimmed = false,
  onPress,
}: {
  kind: ActionChipKind;
  /** The action is WAITING on the current photo — chip lights up. */
  active: boolean;
  /** Large text: the label is dropped and the icon carries the meaning
   * with its accessibility label (Tristan, 2026-10-09: the two-per-row
   * arrangement put Organize and Share on a second row the deck has no
   * room for — behind the finish button, unreachable). The row's
   * measured lever (components/useTextOverflow) sets it once any label
   * needed a second line. */
  iconOnly?: boolean;
  /** The label's onTextLayout (the deck's measured chip-row lever). */
  onLabelLayout?: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
  disabled?: boolean;
  /** The offer is WITHDRAWN (staged cull): render the chip visibly
   * inert. Deliberately separate from `disabled`, which also covers the
   * transient write lock (`busy`) — tying the look to that would dim
   * every chip for the length of every write, the "fading for a write
   * it had nothing to do with" defect (S23 pass 2026-08-04). */
  dimmed?: boolean;
  onPress: () => void;
}) {
  const meta = META[kind];
  return (
    <Pressable
      style={[
        styles.chip,
        active && { backgroundColor: meta.dim, borderColor: meta.color },
        dimmed && styles.chipDimmed,
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={meta.label}
      accessibilityState={{ disabled, selected: active }}
    >
      <Icon
        name={active ? meta.activeIcon : meta.icon}
        size={18}
        color={active ? meta.color : colors.textDim}
      />
      {!iconOnly && (
        <Text style={[styles.text, active && { color: meta.color }]} onTextLayout={onLabelLayout}>
          {meta.label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 6,
  },
  // Shrinkable so the label is measured in the width beside its icon,
  // not the chip's whole inner width (codex round 4).
  text: { color: colors.textDim, ...type.label, fontWeight: '700', flexShrink: 1 },
  chipDimmed: { opacity: 0.4 },
});
