/**
 * SegmentedControl — one choice among a few, in one pill (the iOS
 * idiom; m0.9 phase 5, the S23 pass of 2026-09-09: the Playback rows'
 * loose chip rows read as rushed and ate a screen). The selected segment
 * fills with the accent; every segment is a radio to accessibility.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, useTheme } from '../theme';

export function SegmentedControl<Id extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { id: Id; label: string }[];
  value: Id;
  onChange: (id: Id) => void;
  /** What the choice governs (read before each segment's label). */
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={styles.pill}
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
            style={[styles.segment, active && { backgroundColor: theme.accent }]}
          >
            <Text style={[styles.label, active && { color: theme.onAccent }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    borderRadius: 999,
    backgroundColor: colors.surfaceRaised,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: 'center',
  },
  label: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
});
