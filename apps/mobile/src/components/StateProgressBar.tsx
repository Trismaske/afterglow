import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { progressRemainder } from '../lib/progress';

export interface ProgressSegment {
  /** Photo count for this segment (0 renders nothing). */
  count: number;
  color: string;
}

/**
 * Segmented inbox-zero progress bar: each state gets a colored slice
 * proportional to its share of the day. Order the segments done-first so
 * the bar visually "fills up" toward inbox zero. Segments are scaled
 * against `total` — the unreviewed remainder renders as a transparent
 * filler slice, so 1 done of 14 is a 7% bar, not a full one.
 */
export function StateProgressBar({
  segments,
  total,
  height = 10,
}: {
  segments: readonly ProgressSegment[];
  total: number;
  height?: number;
}) {
  const remainder = progressRemainder(
    total,
    segments.map((segment) => segment.count),
  );
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      {total > 0 &&
        segments
          .filter((s) => s.count > 0)
          .map((s, i) => (
            <View key={i} style={{ flexGrow: s.count, flexBasis: 0, backgroundColor: s.color }} />
          ))}
      {total > 0 && remainder > 0 && <View style={{ flexGrow: remainder, flexBasis: 0 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    width: '100%',
  },
});
