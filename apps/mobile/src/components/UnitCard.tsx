/**
 * One timeline-unit card (m0.8.2): header line + thumbnail strip, shared
 * by the review overview (group AND singles-run cards) and DayProgress's
 * per-day group list — extracted when the overview was rebuilt for the
 * merged timeline (the two screens carried byte-identical card markup).
 * The card renders structure only; callers supply the title/status copy
 * and any per-thumbnail overlay (badge clusters, decision badges).
 *
 * UNIFORM HEIGHT (final device pass, Tristan): every card is exactly
 * UNIT_CARD_HEIGHT tall — one single-line header, one fixed-height
 * thumb row of at most STRIP_THUMBS slots (more members wear the "+N"
 * chip in the last slot). Uniformity is LOAD-BEARING, not cosmetic: it
 * is what makes the Timeline's getItemLayout exact, which is what makes
 * every filter-switch landing deterministic on a cold list and retires
 * the estimated-height machinery (mVCP, scroll retries) wholesale. It
 * also settles the §5 observation that sparse cards rendered LARGER
 * than dense ones. Thumb-count configurability is parked to m0.8.7.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { colors, touch } from '../theme';

/** Thumbs per row; a card with more members shows STRIP_THUMBS - 1 plus
 * the "+N" chip (Tristan, final device pass: five reads best on
 * device; three left the chip crowding two photos). */
const STRIP_THUMBS = 5;
const THUMB_H = 56;
const HEADER_H = 20;
const CARD_PAD = 12;
const CARD_GAP = 10;

/** The exact rendered height of every card — the Timeline's
 * getItemLayout is built on this number being TRUE (heights are pinned
 * by style, never by content). */
export const UNIT_CARD_HEIGHT = CARD_PAD * 2 + HEADER_H + CARD_GAP + THUMB_H + 2;

export interface UnitCardMember {
  asset_id: string;
  uri: string;
}

export function UnitCard({
  title,
  status,
  statusDone = false,
  members,
  onPress,
  renderOverlay,
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
}) {
  const shown = members.length > STRIP_THUMBS ? STRIP_THUMBS - 1 : members.length;
  const rest = members.length - shown;
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.status, statusDone && styles.statusDone]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      <View style={styles.strip}>
        {members.slice(0, shown).map((member) => (
          <View key={member.asset_id} style={styles.thumbWrap} pointerEvents="none">
            <Image
              source={{ uri: member.uri }}
              style={styles.thumb}
              contentFit="cover"
              recyclingKey={member.asset_id}
            />
            {renderOverlay?.(member.asset_id)}
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
    height: UNIT_CARD_HEIGHT,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: CARD_PAD,
    gap: CARD_GAP,
    overflow: 'hidden',
  },
  header: {
    height: HEADER_H,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  status: { color: colors.textDim, fontSize: 13, flexShrink: 0 },
  statusDone: { color: colors.keep },
  strip: { flexDirection: 'row', gap: 6 },
  // Fixed HEIGHT, flexible width capped for sparse cards: a one-photo
  // run must not render a screen-wide banner — a quarter of the row is
  // the largest a thumbnail gets; strips of four or more share evenly.
  thumbWrap: { flex: 1, maxWidth: '25%', height: THUMB_H },
  thumb: { width: '100%', height: '100%', borderRadius: 8, backgroundColor: colors.surfaceRaised },
  thumbMore: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
  },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
});
