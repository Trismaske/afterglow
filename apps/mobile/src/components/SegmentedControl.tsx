/**
 * SegmentedControl — one choice among a few, in one pill (the iOS
 * idiom; m0.9 phase 5, the S23 pass of 2026-09-09: the Playback rows'
 * loose chip rows read as rushed and ate a screen). The selected segment
 * fills with the accent; every segment is a radio to accessibility.
 *
 * Large text (Tristan's screenshot review, 2026-10-09): the pill stays
 * ONE ROW whenever its labels fit, and the measurement decides — it
 * starts on one row at every scale (no threshold guess: the guess put
 * five-option pills on three-plus-two rows at 1.3 when one row fit, and
 * the lever never came back). Once any label needs a second line the
 * pill becomes a vertical radio LIST, one option per full-width row
 * with the chosen one filled — the form every platform takes when
 * choices outgrow a row — never a pill broken across rows (stretched
 * segments and gaps). The list latches until the font scale or the
 * width changes (components/useTextOverflow).
 */
import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
import { colors, radius, type, useTheme } from '../theme';
import { useTextOverflow } from './useTextOverflow';

export function SegmentedControl<Id extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { id: Id; label: string }[];
  /** The selected segment; null selects nothing (a value not read yet). */
  value: Id | null;
  onChange: (id: Id) => void;
  /** What the choice governs (read before each segment's label). */
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  // Measured lever: no guess, one row until a label reports a second line.
  const labels = useTextOverflow(false);
  const list = labels.overflow;
  const onLabelLayout = (id: string) => (event: NativeSyntheticEvent<TextLayoutEventData>) =>
    labels.watch(id)(event);
  return (
    <View
      style={[styles.pill, list && styles.list]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, checked: active }}
            style={[
              styles.segment,
              list && styles.row,
              active && { backgroundColor: theme.accent },
            ]}
          >
            <Text
              style={[styles.label, active && { color: theme.onAccent }]}
              onTextLayout={onLabelLayout(option.id)}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    padding: 3,
  },
  /** The list: the same surface, one option per row, card corners. */
  list: { flexDirection: 'column', borderRadius: radius.card, gap: 2 },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  /** A list row: full width, the label flush left, chip corners. */
  row: { flex: 0, alignItems: 'flex-start', paddingHorizontal: 14, borderRadius: radius.chip },
  label: { color: colors.textDim, ...type.label, fontWeight: '600' },
});
