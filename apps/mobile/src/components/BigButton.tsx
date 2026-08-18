import React from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors, touch } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  color?: string;
  textColor?: string;
  /** Blocks the press — including transient write locks. */
  disabled?: boolean;
  /** The dimmed LOOK, split from the press lock (m0.8.6 N2, the same
   * rule ActionChip carries): tie the look to `disabled` and every
   * unrelated write dims the button for the write's duration — the
   * "fading for a write it had nothing to do with" defect. Omitted, the
   * look follows `disabled` (the pre-split behaviour, right for callers
   * whose disabled state IS durable). */
  dimmed?: boolean;
  style?: ViewStyle;
}

/** Big-touch-target action button (min 64pt tall). */
export function BigButton({ label, onPress, color, textColor, disabled, dimmed, style }: Props) {
  const dim = dimmed ?? disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: color ?? colors.surfaceRaised },
        dim && styles.dimmed,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <Text style={[styles.label, { color: textColor ?? colors.text }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: touch.action,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressed: { opacity: 0.75 },
  dimmed: { opacity: 0.4 },
  label: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
});
