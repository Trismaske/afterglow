import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';

export interface ProgressSegment {
  /** Photo count for this segment (0 renders nothing). */
  count: number;
  color: string;
}

/**
 * Segmented inbox-zero progress bar: each state gets a colored slice
 * proportional to its share of the day. Order the segments done-first so
 * the bar visually "fills up" toward inbox zero.
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
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      {total > 0 &&
        segments
          .filter((s) => s.count > 0)
          .map((s, i) => (
            <View
              key={i}
              style={{ flexGrow: s.count, flexBasis: 0, backgroundColor: s.color }}
            />
          ))}
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
