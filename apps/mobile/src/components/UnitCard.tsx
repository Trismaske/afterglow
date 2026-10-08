/**
 * One timeline-unit card (m0.8.2): header line + thumbnail strip, shared
 * by the review overview (group AND singles-run cards) and DayProgress's
 * per-day group list — extracted when the overview was rebuilt for the
 * merged timeline (the two screens carried byte-identical card markup).
 * The card renders structure only; callers supply the title/status copy
 * and any per-thumbnail overlay (badge clusters, decision badges).
 *
 * UNIFORM HEIGHT (final device pass, Tristan): every card is exactly
 * unitCardHeight(fontScale) tall — one single-line header, one fixed-height
 * thumb row of at most STRIP_THUMBS slots (more members wear the "+N"
 * chip in the last slot). Uniformity is LOAD-BEARING, not cosmetic: it
 * is what makes the Timeline's getItemLayout exact, which is what makes
 * every filter-switch landing deterministic on a cold list and retires
 * the estimated-height machinery (mVCP, scroll retries) wholesale. It
 * also settles the §5 observation that sparse cards rendered LARGER
 * than dense ones. Thumb-count configurability is parked to m0.8.7.
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PixelRatio, useWindowDimensions } from 'react-native';
import { AnimatedThumb } from './AnimatedThumb';
import type { AnimatedCells } from './useAnimatedCells';
import { thumbRowOf, type AnimatedThumbRow, type ThumbFacts } from '../lib/animatedThumbRow';
import { thumbBucketPx } from '../lib/thumbnailSize';
import { colors, radius, touch, type } from '../theme';

/** Thumbs per row; a card with more members shows STRIP_THUMBS - 1 plus
 * the "+N" chip (Tristan, final device pass: five reads best on
 * device; three left the chip crowding two photos). */
const STRIP_THUMBS = 5;
const THUMB_H = 56;
/** A card thumb is at most a quarter of the card wide (~100 dp), taller
 * than THUMB_H never — bucket on the wider side at device scale. */
const CARD_THUMB_PX = thumbBucketPx(100, PixelRatio.get());
/** The header row at font scale 1: one line of `type.body`. */
const HEADER_H = type.body.lineHeight;
const CARD_PAD = 12;
const CARD_GAP = 10;

/** The header row's height at an OS font scale: its one line of text,
 * scaled — the card grows with the text instead of clipping it (the
 * accessibility walk, 1.5×: the title was cut mid-glyph at 20 dp). */
export function unitCardHeaderHeight(fontScale: number): number {
  return Math.round(HEADER_H * (Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1));
}

/** The exact rendered height of every card at a font scale — the
 * Timeline's getItemLayout is built on this number being TRUE (heights
 * are pinned by style, never by content; the one scaling part is the
 * header line, pinned to the same function). */
export function unitCardHeight(fontScale: number): number {
  return CARD_PAD * 2 + unitCardHeaderHeight(fontScale) + CARD_GAP + THUMB_H + 2;
}

/** A card member: its identity plus the facts its thumbnail animates by
 * (phase 6; every member projection carries them). */
export interface UnitCardMember extends ThumbFacts {
  asset_id: string;
  /** The member's part (phase 10, lib/groupParts.ts): a card whose
   * members arrive part by part draws a divider where it changes. */
  part?: number;
}

/** The members a card SHOWS (the rest wear the "+N" chip), as thumbnail
 * rows — the card renders them and its host's controller reads their
 * kinds, so both go through here. */
export function cardThumbRows(members: readonly UnitCardMember[]): AnimatedThumbRow[] {
  const shown = members.length > STRIP_THUMBS ? STRIP_THUMBS - 1 : members.length;
  return members.slice(0, shown).map((m) => thumbRowOf(m.asset_id, m));
}

export function UnitCard({
  title,
  status,
  statusDone = false,
  members,
  onPress,
  renderOverlay,
  animated,
}: {
  title: string;
  status: string;
  /** Renders the status in keep-green (the "Reviewed" resting state). */
  statusDone?: boolean;
  /** Display-ordered. */
  members: readonly UnitCardMember[];
  onPress: () => void;
  /** Absolutely-positioned overlay inside a thumbnail (badges). */
  renderOverlay?: (assetId: string) => React.ReactNode;
  /** The host list's animated controller and this card's place in it
   * (phase 6): the card's thumbnails play their clips while the card is
   * on screen, each addressed by its position in the row. */
  animated: { cells: AnimatedCells; index: number; cellKey: string };
}) {
  const thumbs = useMemo(() => cardThumbRows(members), [members]);
  const rest = members.length - thumbs.length;
  // A part boundary between two shown thumbnails (phase 10): the same
  // bar the deck's strip draws, in the gap, consuming no width.
  const boundary = (sub: number): boolean =>
    sub > 0 && (members[sub - 1].part ?? 0) !== (members[sub].part ?? 0);
  const fontScale = useWindowDimensions().fontScale;
  return (
    <Pressable style={[styles.card, { height: unitCardHeight(fontScale) }]} onPress={onPress}>
      <View style={[styles.header, { height: unitCardHeaderHeight(fontScale) }]}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.status, statusDone && styles.statusDone]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      <View style={styles.strip}>
        {thumbs.map((thumb, sub) => (
          <View key={thumb.id} style={styles.thumbWrap} pointerEvents="none">
            {boundary(sub) && <View style={styles.partDivider} />}
            <AnimatedThumb
              row={thumb}
              px={CARD_THUMB_PX}
              index={animated.index}
              cellKey={animated.cellKey}
              sub={sub}
              cells={animated.cells}
              style={styles.thumb}
              markSize={11}
            />
            {renderOverlay?.(thumb.id)}
          </View>
        ))}
        {rest > 0 && (
          <View style={[styles.thumbWrap, styles.thumbMore]}>
            <Text style={styles.thumbMoreText}>+{rest}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: CARD_PAD,
    gap: CARD_GAP,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: { color: colors.text, ...type.body, fontWeight: '600', flexShrink: 1 },
  // Shrinkable as a LAST resort (large font scales): numberOfLines then
  // ellipsizes instead of the card's overflow clipping mid-glyph. At
  // normal scale the callers' copy fits whole (codex r7).
  status: { color: colors.textDim, ...type.label, flexShrink: 1 },
  statusDone: { color: colors.keep },
  strip: { flexDirection: 'row', gap: 6 },
  // Fixed HEIGHT, flexible width capped for sparse cards: a one-photo
  // run must not render a screen-wide banner — a quarter of the row is
  // the largest a thumbnail gets; strips of four or more share evenly.
  thumbWrap: { flex: 1, maxWidth: '25%', height: THUMB_H },
  thumb: {
    width: '100%',
    height: '100%',
    borderRadius: radius.thumb,
    backgroundColor: colors.surfaceRaised,
  },
  thumbMore: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.thumb,
    backgroundColor: colors.surfaceRaised,
  },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
  partDivider: {
    position: 'absolute',
    left: -4,
    top: 6,
    bottom: 6,
    width: 2,
    borderRadius: 1,
    backgroundColor: colors.textDim,
    zIndex: 1,
  },
});
