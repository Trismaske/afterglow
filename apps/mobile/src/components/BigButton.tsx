import React from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors, touch } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  color?: string;
  textColor?: string;
  disabled?: boolean;
  style?: ViewStyle;
}

/** Big-touch-target action button (min 64pt tall). */
export function BigButton({ label, onPress, color, textColor, disabled, style }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: color ?? colors.surfaceRaised },
        disabled && styles.disabled,
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
  disabled: { opacity: 0.4 },
  label: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
});
