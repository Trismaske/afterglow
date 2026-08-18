import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '../theme';
import type { BadgeWeight, PhotoBadge } from '../lib/photoBadges';

/**
 * The one icon language for photo decisions (m0.6): a small circular badge
 * with a Material glyph, used identically on Groups-strip thumbnails, the
 * deck strip, browse mode and list rows — replacing the m0.5 unicode ✕.
 *
 * - cull     — red close
 * - keep     — green check
 * - edit     — blue pencil (the to-edit flag)
 * - fav      — pink heart (absolute favourite, m0.6)
 * - share    — teal share glyph (waiting in the share queue)
 * - organize — amber folder-move (a queued move to another album)
 *
 * (The grey time-attached clock is GONE since m0.8.2: "grouped by time"
 * is internal scan quality the user cannot act on, and the scan itself
 * rewrites it once embeddings land — docs/STATE_MODEL.md.)
 *
 * `DECISION_GLYPHS` is exported for inline icon+text rows (deck footer,
 * sheets) so labels use the same glyph names, never emoji.
 *
 * Every badge carries a WEIGHT (m0.8.2). `live` is the badge as it has
 * always looked: the full action colour on its tinted disc, meaning the
 * action is waiting for you. `carried` is the same glyph at the same hue,
 * dimmed and on a plain untinted disc, meaning the action already
 * happened and the photo carries it — history, not a chore. The hue is
 * never desaturated toward grey: a greyed action would read as disabled.
 * Only actions take a weight; a verdict has no lifecycle and always
 * renders live.
 *
 * `BadgeCluster` is the REVIEW surfaces' layout (deck, Groups): the full
 * set from lib/photoBadges.ts — verdict plus all four actions — WRAPPED
 * inside its anchor, so a photo carrying every flag shows them all
 * (stacked rows on a small thumbnail) and none hides another. The summary
 * rows that read out one durable STATE (History, DayProgress strips) keep
 * their single state glyph, where a pencil means "in the edit queue"
 * rather than a flag beside a verdict.
 */
export type DecisionKind = 'cull' | 'keep' | 'edit' | 'fav' | 'fav_off' | 'share' | 'organize';

export const DECISION_GLYPHS: Record<
  DecisionKind,
  React.ComponentProps<typeof MaterialCommunityIcons>['name']
> = {
  cull: 'close',
  keep: 'check',
  edit: 'pencil',
  fav: 'heart',
  // Queued REMOVAL (Tristan, grilling Q5): the slash says the direction
  // — favourite-pink at the live weight, because the removal is waiting
  // work in the favourites queue. Never grey (rule 6).
  fav_off: 'heart-off',
  share: 'share-variant',
  organize: 'folder-move',
};

const BADGE_COLORS: Record<DecisionKind, { fg: string; bg: string }> = {
  cull: { fg: colors.cull, bg: colors.cullDim },
  keep: { fg: colors.keep, bg: colors.keepDim },
  edit: { fg: colors.edit, bg: colors.editDim },
  fav: { fg: colors.fav, bg: colors.favDim },
  fav_off: { fg: colors.fav, bg: colors.favDim },
  share: { fg: colors.share, bg: colors.shareDim },
  organize: { fg: colors.organize, bg: colors.organizeDim },
};

/** Alpha suffix for a CARRIED glyph: the same hue, ~65% strength, over
 * an OPAQUE disc so it stays legible on any photo underneath. Fading the
 * whole badge instead would fade the disc too and lose that guarantee. */
const CARRIED_ALPHA = 'a6';

export function DecisionBadge({
  kind,
  size = 18,
  weight = 'live',
  style,
}: {
  kind: DecisionKind;
  /** Badge diameter; the glyph scales with it. */
  size?: number;
  /** `carried` quiets an action that has already happened (m0.8.2). */
  weight?: BadgeWeight;
  style?: StyleProp<ViewStyle>;
}) {
  const { fg, bg } = BADGE_COLORS[kind];
  const carried = weight === 'carried';
  return (
    <View
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: carried ? colors.surfaceRaised : bg,
        },
        style,
      ]}
    >
      <MaterialCommunityIcons
        name={DECISION_GLYPHS[kind]}
        size={Math.round(size * 0.7)}
        color={carried ? `${fg}${CARRIED_ALPHA}` : fg}
      />
    </View>
  );
}

/**
 * Every badge a photo carries, wrapped inside its anchor so none is
 * hidden: rows fill right-to-left from the anchor corner and stack
 * upward when the width runs out (a 52 px deck thumbnail fits three per
 * row at size 14). Renders nothing when `kinds` is empty.
 */
export function BadgeCluster({
  badges,
  size = 18,
  style,
}: {
  badges: readonly PhotoBadge[];
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (badges.length === 0) return null;
  return (
    <View style={[styles.cluster, style]} pointerEvents="none">
      {badges.map((badge) => (
        <DecisionBadge key={badge.kind} kind={badge.kind} size={size} weight={badge.weight} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  cluster: {
    flexDirection: 'row',
    flexWrap: 'wrap-reverse',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    gap: 3,
  },
});
