/**
 * Shared selection-grid primitives of the share and organize queues
 * (m0.8.2, F7): both screens are a 4-column thumbnail grid with the same
 * selection language — tap toggles, long-press opens the viewer, a
 * selected cell takes an ACCENT OUTLINE plus a check (rule 4: never a
 * coloured fill), per-kind status renders as small overlay badges the
 * caller supplies. The chip is the screens' small header/action button.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '../theme';

export function QueueGridCell({
  id,
  uri,
  selected,
  accent,
  onPress,
  onLongPress,
  children,
}: {
  id: string;
  uri: string;
  selected: boolean;
  accent: string;
  onPress: () => void;
  onLongPress: () => void;
  /** Absolutely-positioned status badges (pass ✓, target, error). */
  children?: React.ReactNode;
}) {
  return (
    <Pressable style={styles.cell} onPress={onPress} onLongPress={onLongPress}>
      <Image
        source={{ uri }}
        style={[styles.thumb, selected && { borderColor: accent }]}
        contentFit="cover"
        recyclingKey={id}
      />
      {children}
      {selected ? (
        <MaterialCommunityIcons
          name="check-circle"
          size={20}
          color={accent}
          style={styles.selectBadge}
        />
      ) : null}
    </Pressable>
  );
}

export function Chip({
  label,
  onPress,
  disabled = false,
  destructive = false,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Destructive acts wear the cull red (vetted 2026-08-21): the remove
   * chip must not camouflage among its neutral row-mates. */
  destructive?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      style={[
        styles.chip,
        destructive && styles.chipDestructive,
        disabled && styles.disabled,
        style,
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.chipText, destructive && styles.chipTextDestructive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: { flex: 1 / 4, aspectRatio: 1 },
  // Rule 4: a selected photo takes an ACCENT OUTLINE, never a fill — a
  // coloured wash would read as "this photo carries that action".
  thumb: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selectBadge: { position: 'absolute', bottom: 4, right: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  chipDestructive: { borderColor: colors.cullDim },
  chipTextDestructive: { color: colors.cull },
  disabled: { opacity: 0.5 },
});
