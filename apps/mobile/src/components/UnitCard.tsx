/**
 * One timeline-unit card (m0.8.2): header line + thumbnail strip, shared
 * by the review overview (group AND singles-run cards) and DayProgress's
 * per-day group list — extracted when the overview was rebuilt for the
 * merged timeline (the two screens carried byte-identical card markup).
 * The card renders structure only; callers supply the title/status copy,
 * any per-thumbnail overlay (badge clusters, decision badges) and an
 * optional border colour (the best star's accent ring).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { colors, touch } from '../theme';

const STRIP_THUMBS = 6;

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
  borderColorOf,
}: {
  title: string;
  status: string;
  /** Renders the status in keep-green (the "Reviewed" resting state). */
  statusDone?: boolean;
  /** Display-ordered (the caller decides e.g. best-first). */
  members: readonly UnitCardMember[];
  onPress: () => void;
  /** Absolutely-positioned overlay inside a thumbnail (badges). */
  renderOverlay?: (assetId: string) => React.ReactNode;
  /** A 2px border for a thumbnail (the best star's accent ring). */
  borderColorOf?: (assetId: string) => string | undefined;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={[styles.status, statusDone && styles.statusDone]}>{status}</Text>
      </View>
      <View style={styles.strip}>
        {members.slice(0, STRIP_THUMBS).map((member) => {
          const border = borderColorOf?.(member.asset_id);
          return (
            <View key={member.asset_id} style={styles.thumbWrap} pointerEvents="none">
              <Image
                source={{ uri: member.uri }}
                style={[
                  styles.thumb,
                  border !== undefined && { borderWidth: 2, borderColor: border },
                ]}
                contentFit="cover"
                recyclingKey={member.asset_id}
              />
              {renderOverlay?.(member.asset_id)}
            </View>
          );
        })}
        {members.length > STRIP_THUMBS && (
          <View style={[styles.thumb, styles.thumbMore]}>
            <Text style={styles.thumbMoreText}>+{members.length - STRIP_THUMBS}</Text>
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
    padding: 12,
    gap: 10,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  status: { color: colors.textDim, fontSize: 13 },
  statusDone: { color: colors.keep },
  strip: { flexDirection: 'row', gap: 6 },
  // maxWidth caps the flex share: a ONE-photo unit (a single-member
  // timeline run) must not render a full-width, screen-filling square —
  // a third of the card is the largest a thumbnail gets, and strips of
  // three or more are unaffected.
  thumbWrap: { flex: 1, maxWidth: '33%' },
  thumb: { width: '100%', aspectRatio: 1, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  thumbMore: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
});
