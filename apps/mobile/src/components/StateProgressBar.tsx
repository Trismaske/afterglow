import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { groupedUnderlineRuns, progressRemainder } from '../lib/progress';

export interface ProgressSegment {
  /** Photo count for this segment (0 renders nothing). */
  count: number;
  color: string;
}

/** How much of one segment sits in a similarity group. */
export interface GroupedSpan {
  count: number;
  /** The segment this span belongs to, so it can be placed under it. */
  of: number;
}

/**
 * Segmented review bar: each VERDICT gets a coloured slice proportional
 * to its share of the scope.
 *
 * Fill means DECIDED (docs/STATE_MODEL.md rule 1) — unreviewed photos are
 * the empty track, never a slice — so the coloured fraction always equals
 * the "X of Y reviewed" figure printed beside it. Before v18 the
 * "in groups" count was drawn as a fourth slice, which made unreviewed
 * photos read as progress.
 *
 * `grouped` draws the ANNOTATION layer as a thin rule UNDER the bar,
 * spanning the grouped part of each segment in order (rule 5). It sits on
 * its own plane precisely so it cannot be mistaken for a decision. Its
 * geometry is `groupedUnderlineRuns` — pure, and unit-tested, because an
 * underline that does not line up annotates the wrong photos.
 */
export function StateProgressBar({
  segments,
  total,
  height = 10,
  grouped,
}: {
  segments: readonly ProgressSegment[];
  total: number;
  height?: number;
  grouped?: readonly GroupedSpan[];
}) {
  const remainder = progressRemainder(
    total,
    segments.map((segment) => segment.count),
  );
  return (
    <View style={styles.wrap}>
      <View style={[styles.track, { height, borderRadius: height / 2 }]}>
        {total > 0 &&
          segments
            .filter((s) => s.count > 0)
            .map((s, i) => (
              <View key={i} style={{ flexGrow: s.count, flexBasis: 0, backgroundColor: s.color }} />
            ))}
        {total > 0 && remainder > 0 && <View style={{ flexGrow: remainder, flexBasis: 0 }} />}
      </View>
      {grouped !== undefined && total > 0 && (
        <View style={styles.groupedRow}>
          {groupedUnderlineRuns(total, grouped).map((run, i) => (
            <View
              key={i}
              style={[run.marked && styles.groupedMark, { flexGrow: run.weight, flexBasis: 0 }]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 3 },
  groupedRow: { flexDirection: 'row', height: 2, width: '100%' },
  groupedMark: { backgroundColor: colors.textDim, borderRadius: 1 },
  track: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    width: '100%',
  },
});
