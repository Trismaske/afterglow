/**
 * Ghost placeholder (m0.8.2, F2): a dim card-shaped rectangle holding a
 * block's space while its data loads, so Home's cold start paints its
 * full structure ONCE and blocks fill in place instead of inserting at
 * different heights ("the UI redraws itself chaotically" — tester).
 * Deliberately not a shimmer framework: one shape, the surface palette,
 * no animation — arriving content is the transition.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, touch } from '../theme';

export function Ghost({ height, style }: { height: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.ghost, { height }, style]} />;
}

const styles = StyleSheet.create({
  ghost: {
    borderRadius: touch.radius,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.55,
  },
});
