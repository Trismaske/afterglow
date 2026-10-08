/**
 * SegmentedControl — one choice among a few, in one pill (the iOS
 * idiom; m0.9 phase 5, the S23 pass of 2026-09-09: the Playback rows'
 * loose chip rows read as rushed and ate a screen). The selected segment
 * fills with the accent; every segment is a radio to accessibility.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, type, useTheme } from '../theme';
import { useHugeText, useLargeText } from './useLargeText';

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
  // Large text (lib/textScale.ts): more than three segments wrap onto
  // two rows, three to a row, instead of breaking a label mid-word (the
  // walk at 1.3×: "Strictes / t").
  const wrap = useLargeText() && options.length > 3;
  // Past the huge threshold a third of the pill no longer holds
  // "Strictest" either: two to a row.
  const huge = useHugeText();
  return (
    <View
      style={[styles.pill, wrap && styles.pillWrapped]}
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
              wrap && (huge ? styles.segmentWrappedHuge : styles.segmentWrapped),
              active && { backgroundColor: theme.accent },
            ]}
          >
            <Text style={[styles.label, active && { color: theme.onAccent }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pillWrapped: { flexWrap: 'wrap' },
  segmentWrapped: { flexBasis: '32%', flexGrow: 1 },
  segmentWrappedHuge: { flexBasis: '48%', flexGrow: 1 },
  pill: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  label: { color: colors.textDim, ...type.label, fontWeight: '600' },
});
