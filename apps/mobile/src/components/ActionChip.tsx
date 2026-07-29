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
import { Pressable, StyleSheet, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '../theme';

export type ActionChipKind = 'edit' | 'favourite' | 'organize' | 'share';

const META: Record<
  ActionChipKind,
  {
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    activeIcon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    color: string;
    dim: string;
    label: string;
  }
> = {
  edit: {
    icon: 'pencil',
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
  disabled = false,
  onPress,
}: {
  kind: ActionChipKind;
  /** The action is WAITING on the current photo — chip lights up. */
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const meta = META[kind];
  return (
    <Pressable
      style={[styles.chip, active && { backgroundColor: meta.dim, borderColor: meta.color }]}
      disabled={disabled}
      onPress={onPress}
    >
      <MaterialCommunityIcons
        name={active ? meta.activeIcon : meta.icon}
        size={18}
        color={active ? meta.color : colors.textDim}
      />
      <Text style={[styles.text, active && { color: meta.color }]}>{meta.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 6,
  },
  text: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
});
