/**
 * Daily-goal progress ring (m0.8 gate 4) — pure React Native, no SVG
 * dependency: two half-circle arcs, each clipped by a half-width wrapper
 * and rotated by its share of the progress. The right half sweeps the
 * first 50%, the left half the rest; a reached goal closes the circle.
 * The rotations come from lib/dailyGoal.ringArcs (pure, unit-tested —
 * the border-semicircle geometry is easy to invert by accident).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ringArcs } from '../lib/dailyGoal';
import { colors } from '../theme';

export function GoalRing({
  size,
  strokeWidth,
  progress,
  color,
  centerTitle,
  centerSubtitle,
}: {
  size: number;
  strokeWidth: number;
  /** 0..1 (clamped). */
  progress: number;
  color: string;
  centerTitle: string;
  centerSubtitle?: string;
}) {
  const { right, left } = ringArcs(progress);
  const half = size / 2;
  const arc = (rotation: number, visible: boolean) => ({
    width: size,
    height: size,
    borderRadius: half,
    borderWidth: strokeWidth,
    borderColor: 'transparent',
    borderTopColor: visible ? color : 'transparent',
    borderRightColor: visible ? color : 'transparent',
    transform: [{ rotate: `${rotation}deg` }],
  });
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: half, borderWidth: strokeWidth, borderColor: colors.surfaceRaised },
        ]}
      />
      {/* Right half (0°..180° clockwise from 12): the first 50%. */}
      <View style={[styles.halfClip, { width: half, height: size, left: half }]}>
        <View style={[arc(right.rotation, right.sweep > 0), { marginLeft: -half }]} />
      </View>
      {/* Left half (180°..360°): only once the right half is full. */}
      <View style={[styles.halfClip, { width: half, height: size, left: 0 }]}>
        <View style={[arc(left.rotation, left.sweep > 0)]} />
      </View>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <Text style={styles.centerTitle}>{centerTitle}</Text>
        {centerSubtitle !== undefined && (
          <Text style={styles.centerSubtitle}>{centerSubtitle}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  halfClip: { position: 'absolute', overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerTitle: { color: colors.text, fontSize: 26, fontWeight: '800' },
  centerSubtitle: { color: colors.textDim, fontSize: 12, marginTop: 2 },
});
