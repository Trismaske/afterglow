/**
 * The stack header's title as OUR text (m0.9.1, Tristan's screenshot
 * review 2026-10-09): React Navigation's native-stack title ignored the
 * OS font size entirely — the same 198 × 81 px box from 0.8 to 2.0 —
 * while every subtitle under it scaled, so at 1.3 a subtitle matched
 * its title and at 2.0 outgrew it. Rendered through `headerTitle`, the
 * title takes the `type.title` token and scales with everything else.
 * One line, ellipsized: the OS toolbar's height is fixed, so this is
 * the app's one deliberately ellipsized text (docs/STATE_MODEL.md,
 * "Text scales; layouts stack").
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors, type } from '../theme';

export function HeaderTitle({ children }: { children?: React.ReactNode }) {
  return (
    <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, ...type.title, fontWeight: '600' },
});
