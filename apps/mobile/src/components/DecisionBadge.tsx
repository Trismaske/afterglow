import React, { useEffect, useReducer, useState } from 'react';
import {
  PixelRatio,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { Icon, type IconName } from './Icon';
import { colors, radius } from '../theme';
import { badgesHidden, subscribeBadgesHidden } from '../lib/badgePrefs';
import {
  CLUSTER_GAP,
  marksFitOneLine,
  type BadgeWeight,
  type PhotoBadge,
} from '../lib/photoBadges';
import type { EffectiveState } from '../lib/progress';
import { VERDICT_META } from './progress/stateMeta';

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
 * `BadgeCluster` is the deck stage's badge box (docs/STATE_MODEL.md rule
 * 7, marks FLOW): the full set from lib/photoBadges.ts — the kind chip,
 * then the verdict and all four actions — on one line when it fits the
 * box, otherwise the chip on its own line above the discs, every line
 * flush left (the box sits bottom-left). The summary rows that read out
 * one durable STATE (History, DayProgress strips) keep their single
 * state glyph, where a pencil means "in the edit queue" rather than a
 * flag beside a verdict.
 */
// prettier-ignore
export type DecisionKind =
  'cull' | 'keep' | 'trashed' | 'edit' | 'fav' | 'fav_off' | 'share' | 'organize' | 'video' | 'motion' | 'gif';

/** The three KIND CHIPS (m0.9 phase 7, G6): text, not a glyph — the
 * word is the mark. Layer-3 annotations: near-white on the plain disc,
 * never an action hue; only BadgeCluster draws them (the thumbnails'
 * kind MARK lives in AnimatedThumb). */
export const KIND_CHIP_LABELS: Record<'video' | 'motion' | 'gif', string> = {
  video: 'Video',
  motion: 'Motion',
  gif: 'GIF',
};

export const DECISION_GLYPHS: Record<DecisionKind, IconName> = {
  cull: 'close',
  keep: 'check',
  trashed: 'trash-can-outline',
  edit: 'pencil',
  fav: 'heart',
  // Queued REMOVAL (Tristan, grilling Q5): the slash says the direction
  // — favourite-pink at the live weight, because the removal is waiting
  // work in the favourites queue. Never grey (rule 6).
  fav_off: 'heart-off',
  share: 'share-variant',
  organize: 'folder-move',
  // The kind chips render as TEXT (KindChip); these glyphs serve the
  // inline icon+text rows that name a kind.
  video: 'video-outline',
  motion: 'motion-play-outline',
  gif: 'file-gif-box',
};

const BADGE_COLORS: Record<DecisionKind, { fg: string; bg: string }> = {
  cull: { fg: colors.cull, bg: colors.cullDim },
  keep: { fg: colors.keep, bg: colors.keepDim },
  // The executed cull (m0.8.6 D9, History tombstones): cull-red — the
  // state model's one double-duty hue — with the trash-can glyph telling
  // 'done' apart from 'staged'.
  trashed: { fg: colors.cull, bg: colors.cullDim },
  edit: { fg: colors.edit, bg: colors.editDim },
  fav: { fg: colors.fav, bg: colors.favDim },
  fav_off: { fg: colors.fav, bg: colors.favDim },
  share: { fg: colors.share, bg: colors.shareDim },
  organize: { fg: colors.organize, bg: colors.organizeDim },
  // Annotations: near-white on the plain disc (rule 3's colour for a
  // thing with no hue of its own), never an action hue (rule 2).
  video: { fg: colors.text, bg: colors.surfaceRaised },
  motion: { fg: colors.text, bg: colors.surfaceRaised },
  gif: { fg: colors.text, bg: colors.surfaceRaised },
};

export function isKindChip(kind: DecisionKind): kind is 'video' | 'motion' | 'gif' {
  return kind === 'video' || kind === 'motion' || kind === 'gif';
}

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
      <Icon
        name={DECISION_GLYPHS[kind]}
        size={Math.round(size * 0.7)}
        color={carried ? `${fg}${CARRIED_ALPHA}` : fg}
      />
    </View>
  );
}

/** A kind chip: the kind's word as quiet near-white text on the plain
 * disc. Only legible at deck-stage sizes — small clusters render the
 * glyph badges alone (see BadgeCluster). */
function KindChip({
  kind,
  size,
  onWidth,
}: {
  kind: 'video' | 'motion' | 'gif';
  size: number;
  onWidth?: (width: number) => void;
}) {
  // The pill's height follows its label's scaled line, never just the
  // disc size: the label is sp and grew with the font while the pill
  // stayed 24 dp, and Android clips a rounded view's children to its
  // outline — at 2.0 "Video" lost its lower half (the grilling,
  // 2026-10-11). Computed from the scale, like the disc.
  const { fontScale } = useWindowDimensions();
  const fontSize = Math.round(size * 0.55);
  const height = Math.max(size, Math.round(fontSize * Math.max(1, fontScale) * 1.4) + 4);
  return (
    <View
      style={[styles.pill, { height, borderRadius: height / 2 }]}
      onLayout={onWidth && ((e: LayoutChangeEvent) => onWidth(e.nativeEvent.layout.width))}
    >
      <Text style={[styles.pillText, { fontSize }]} numberOfLines={1}>
        {KIND_CHIP_LABELS[kind]}
      </Text>
    </View>
  );
}

/** The one hide-all control's read side (m0.8.7, F19/L6): a durable
 * setting flips every cluster at once for an unobstructed photo. */
export function useBadgesHidden(): boolean {
  const [hidden, setHidden] = useState(badgesHidden);
  useEffect(() => subscribeBadgesHidden(setHidden), []);
  return hidden;
}

/** Text pills are unreadable below this cluster size — smaller clusters
 * keep the glyph badges and drop only the kind chip. */
const MIN_PILL_SIZE = 18;

/** A kind chip's laid-out width per label, size and font scale, learnt
 * from its first layout and kept for the session: the one-line fit is
 * arithmetic over it (lib/photoBadges' marksFitOneLine), never a Yoga
 * wrap — Yoga sized the pill to one line and drew a wrapped second
 * outside its backdrop (the tester, 2026-09-28; reproduced on the S10e
 * with three badges and a chip). */
const chipWidths = new Map<string, number>();

function chipWidthKey(kind: DecisionKind, size: number): string {
  return `${kind}|${size}|${PixelRatio.getFontScale()}`;
}

/**
 * Every badge a photo carries, inside its box so none is hidden (rule 7,
 * marks FLOW): the kind chip first, then the glyph badges, on one line
 * when `maxWidth` holds them, otherwise the chip on its own line above
 * the discs, both flush left; the pill grows upward from its bottom
 * anchor. Without a `maxWidth` the cluster is always one line. Renders
 * nothing when `badges` is empty or the user hid badges (the one durable
 * toggle, F19/L6).
 */
export function BadgeCluster({
  badges,
  size = 18,
  maxWidth,
  style,
}: {
  badges: readonly PhotoBadge[];
  size?: number;
  /** The inner width the box offers (its padding excluded). */
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const hidden = useBadgesHidden();
  const [, relayout] = useReducer((n: number) => n + 1, 0);
  if (hidden || badges.length === 0) return null;
  const marks = badges.filter((badge) => !isKindChip(badge.kind));
  const chips = size >= MIN_PILL_SIZE ? badges.filter((badge) => isKindChip(badge.kind)) : [];
  if (marks.length === 0 && chips.length === 0) return null;
  const oneLine =
    maxWidth === undefined ||
    marksFitOneLine(
      chips.map((chip) => chipWidths.get(chipWidthKey(chip.kind, size))),
      marks.length,
      size,
      maxWidth,
    ) !== false;
  const chipNodes = chips.map((badge) =>
    isKindChip(badge.kind) ? (
      <KindChip
        key={badge.kind}
        kind={badge.kind}
        size={size}
        onWidth={(width) => {
          const key = chipWidthKey(badge.kind, size);
          if (chipWidths.get(key) === width) return;
          chipWidths.set(key, width);
          relayout();
        }}
      />
    ) : null,
  );
  const markNodes = marks.map((badge) => (
    <DecisionBadge key={badge.kind} kind={badge.kind} size={size} weight={badge.weight} />
  ));
  return (
    <View style={[styles.cluster, style]} pointerEvents="none">
      {oneLine ? (
        <View style={styles.clusterRow}>
          {chipNodes}
          {markNodes}
        </View>
      ) : (
        <>
          <View style={styles.clusterRow}>{chipNodes}</View>
          <View style={styles.clusterRow}>{markNodes}</View>
        </>
      )}
    </View>
  );
}

/**
 * The INSPECTION-DOT row (m0.9, tester request 2026-08-29): the
 * Progress grid's state language, shared verbatim by every
 * thumbnail-scale surface — grid tiles, the deck's film strip, Timeline
 * and DayProgress cards. The VERDICT is a colored dot (VERDICT_META);
 * actions ride beside it as the weighted glyph badges. Verdict GLYPHS
 * and the kind chip stay out — the dot already carries the verdict,
 * and the thumbnail's kind MARK (AnimatedThumb) carries the kind; a
 * small square carries no annotation (G12). (The trashed glyph stays: browse
 * decks can hold tombstoned members the dot's effective-state palette
 * cannot express.)
 *
 * An UNREVIEWED photo wears no dot (tester, 2026-08-31): only a
 * decision or an action earns a mark, so a plain thumbnail says
 * "nothing here yet" by itself.
 *
 * Deliberately EXEMPT from the F19 eye (vetted 2026-09-01): the
 * eye clears the STAGE for an unobstructed look at the photo — these
 * corner marks are wayfinding on thumbnails, and the eye hiding the
 * strip's markers while the grid's dots stayed read as a bug on the
 * S23. The eye now governs the stage cluster; inspection dots always
 * show.
 */
export function StateDots({
  effective,
  badges,
  size = 13,
  style,
}: {
  effective: EffectiveState;
  badges: readonly PhotoBadge[];
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const shown = badges.filter((b) => !isKindChip(b.kind) && b.kind !== 'keep' && b.kind !== 'cull');
  if (effective === 'unreviewed' && shown.length === 0) return null;
  return (
    <View style={[styles.dotsRow, style]} pointerEvents="none">
      {effective !== 'unreviewed' && (
        <View style={[styles.stateDot, { backgroundColor: VERDICT_META[effective].color }]} />
      )}
      {shown.map((b) => (
        <DecisionBadge key={b.kind} kind={b.kind} size={size} weight={b.weight} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Wraps inside a bounded host (every host bounds it left and right):
  // the BOTTOM row fills first and the overflow goes to a row above it
  // (the tester, 2026-09-28), never past the thumbnail's edge.
  dotsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap-reverse',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 3,
  },
  stateDot: {
    width: 11,
    height: 11,
    borderRadius: radius.box,
    borderWidth: 1.5,
    borderColor: colors.background,
  },
  badge: { alignItems: 'center', justifyContent: 'center' },
  pill: {
    justifyContent: 'center',
    paddingHorizontal: 6,
    maxWidth: 96,
    backgroundColor: colors.surfaceRaised,
  },
  pillText: { color: colors.text, fontWeight: '600' },
  // A column of rows (BadgeCluster), flush left like the box it fills:
  // the pill is anchored at its bottom, so a second row grows it upward.
  // The glyph row itself never wraps: a full set is five glyphs, 132 dp
  // at the stage's size, and the narrowest supported window (360 dp,
  // portrait-locked) leaves the pill 152 dp after the gutters, the
  // buttons' row and its padding (codex); the chip is what drops to its
  // own line.
  cluster: { alignItems: 'flex-start', gap: CLUSTER_GAP },
  clusterRow: { flexDirection: 'row', alignItems: 'center', gap: CLUSTER_GAP },
});
