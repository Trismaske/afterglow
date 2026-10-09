/**
 * SegmentedControl — one choice among a few, in one pill (the iOS
 * idiom; m0.9 phase 5, the S23 pass of 2026-09-09: the Playback rows'
 * loose chip rows read as rushed and ate a screen). The selected segment
 * fills with the accent; every segment is a radio to accessibility.
 */
import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from 'react-native';
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
  // Measured lever (the close-out grilling): a pill of more than three
  // segments wraps three to a row when any segment label needs a second
  // line, and two to a row when it still does; the thresholds are the
  // first guess (lib/textScale.ts), the labels' own lines the truth. A
  // scale or width change starts from the guess again.
  const large = useLargeText();
  const huge = useHugeText();
  const { fontScale, width } = useWindowDimensions();
  const guess = options.length > 3 ? (huge ? 2 : large ? 1 : 0) : 0;
  const [level, setLevel] = useState(guess);
  useEffect(() => setLevel(guess), [guess, fontScale, width]);
  // A report belongs to the arrangement that produced it: two labels
  // wrapping in the same five-column layout advance the level once,
  // not twice (codex round 4).
  const renderedLevel = level;
  const onLabelLayout = (event: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (options.length > 3 && event.nativeEvent.lines.length > 1)
      setLevel((current) => (current === renderedLevel ? Math.min(2, current + 1) : current));
  };
  const wrap = level > 0;
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
              level === 1 && styles.segmentWrapped,
              level === 2 && styles.segmentWrappedHuge,
              active && { backgroundColor: theme.accent },
            ]}
          >
            <Text
              style={[styles.label, active && { color: theme.onAccent }]}
              onTextLayout={onLabelLayout}
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
