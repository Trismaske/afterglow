import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '../theme';

/**
 * The one icon language for photo decisions (m0.6): a small circular badge
 * with a Material glyph, used identically on Groups-strip thumbnails, the
 * deck strip, browse mode and list rows — replacing the m0.5 unicode ✕.
 *
 * - cull  — red close
 * - keep  — green check
 * - edit  — blue pencil (implies kept; takes display precedence over keep)
 * - best  — star in the session accent (pass `accent`; relative best-of-group)
 * - fav   — pink heart (absolute favourite, m0.6)
 * - time  — grey clock (m0.8 gate 5: grouped by time only — the photo has
 *           no embedding and joined its nearest neighbour's group)
 *
 * `DECISION_GLYPHS` is exported for inline icon+text rows (deck footer,
 * sheets) so labels use the same glyph names, never emoji.
 */
export type DecisionKind = 'cull' | 'keep' | 'edit' | 'best' | 'fav' | 'time';

export const DECISION_GLYPHS: Record<
  DecisionKind,
  React.ComponentProps<typeof MaterialCommunityIcons>['name']
> = {
  cull: 'close',
  keep: 'check',
  edit: 'pencil',
  best: 'star',
  fav: 'heart',
  time: 'clock-outline',
};

const BADGE_COLORS: Record<DecisionKind, { fg: string; bg: string }> = {
  cull: { fg: colors.cull, bg: colors.cullDim },
  keep: { fg: colors.keep, bg: colors.keepDim },
  edit: { fg: colors.edit, bg: colors.editDim },
  best: { fg: colors.text, bg: colors.surfaceRaised }, // fg overridden by accent
  fav: { fg: colors.fav, bg: colors.favDim },
  time: { fg: colors.textDim, bg: colors.surfaceRaised },
};

export function DecisionBadge({
  kind,
  size = 18,
  accent,
  style,
}: {
  kind: DecisionKind;
  /** Badge diameter; the glyph scales with it. */
  size?: number;
  /** Session accent — colors the `best` star (ignored elsewhere). */
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { fg, bg } = BADGE_COLORS[kind];
  return (
    <View
      style={[
        styles.badge,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
        style,
      ]}
    >
      <MaterialCommunityIcons
        name={DECISION_GLYPHS[kind]}
        size={Math.round(size * 0.7)}
        color={kind === 'best' && accent ? accent : fg}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
});
