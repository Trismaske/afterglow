/**
 * Shared selection-grid primitives of the share and organize queues
 * (m0.8.2, F7): both screens are a 4-column thumbnail grid with the same
 * selection language — tap toggles, long-press opens the deck in list
 * mode, a
 * selected cell takes an ACCENT OUTLINE plus a check (rule 4: never a
 * coloured fill), per-kind status renders as small overlay badges the
 * caller supplies. The chip is the screens' small header/action button.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { PixelRatio, useWindowDimensions } from 'react-native';
import { AnimatedThumb } from './AnimatedThumb';
import type { AnimatedCells } from './useAnimatedCells';
import type { AnimatedThumbRow } from '../lib/animatedThumbRow';
import { thumbBucketPx } from '../lib/thumbnailSize';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, radius, type } from '../theme';
import { StateDots } from './DecisionBadge';
import type { QueueDots } from './useQueueBadges';

export function QueueGridCell({
  row,
  index,
  cells,
  selected,
  accent,
  onPress,
  onLongPress,
  dots,
  dotsStyle,
  children,
}: {
  /** The cell's thumbnail row, its list index and the list's animated
   * controller (phase 6): the cell plays its clip while on screen. */
  row: AnimatedThumbRow;
  index: number;
  cells: AnimatedCells;
  selected: boolean;
  accent: string;
  onPress: () => void;
  onLongPress: () => void;
  /** The cell's inspection dots (F35): the verdict and the actions. */
  dots: QueueDots;
  /** Where the dots sit when the caller's own badges take the bottom
   * edge (the organize queue's album tag): a style over the default
   * bottom-left anchor. */
  dotsStyle?: StyleProp<ViewStyle>;
  /** Absolutely-positioned status badges (pass ✓, target, error). */
  children?: React.ReactNode;
}) {
  // Four cells across the screen (the grid contract) at device scale.
  const { width } = useWindowDimensions();
  const cellPx = thumbBucketPx(width / 4, PixelRatio.get());
  return (
    <Pressable style={styles.cell} onPress={onPress} onLongPress={onLongPress}>
      <AnimatedThumb
        row={row}
        px={cellPx}
        index={index}
        cells={cells}
        style={[styles.thumb, selected && { borderColor: accent }]}
      />
      <StateDots
        effective={dots.effective}
        badges={dots.badges}
        // Lifted clear of the select check while selected (codex round 4).
        style={[styles.dots, selected && styles.dotsLifted, dotsStyle]}
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
    borderRadius: radius.thumb,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selectBadge: { position: 'absolute', bottom: 4, right: 4 },
  // Bottom-left: the select check owns the bottom-right corner.
  dots: { position: 'absolute', left: 6, right: 6, bottom: 6 },
  dotsLifted: { bottom: 28 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, ...type.label, fontWeight: '600' },
  chipDestructive: { borderColor: colors.cullDim },
  chipTextDestructive: { color: colors.cull },
  disabled: { opacity: 0.5 },
});
