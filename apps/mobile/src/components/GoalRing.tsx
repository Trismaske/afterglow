/**
 * Daily-goal progress ring (m0.8 gate 4) — pure React Native, no SVG
 * dependency: two half-circle arcs, each clipped by a half-width wrapper
 * and rotated by its share of the progress. The right half sweeps the
 * first 50%, the left half the rest; a reached goal closes the circle.
 * The rotations come from lib/dailyGoal.ringArcs (pure, unit-tested —
 * the border-semicircle geometry is easy to invert by accident).
 */
import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ringArcs } from '../lib/dailyGoal';
import { colors, type } from '../theme';

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
  // The ring grows with the font scale: its centre holds a display line
  // and a caption line, and both scale, so a fixed diameter had the text
  // crossing the stroke at 2.0× (Tristan, 2026-10-09). It grows by HALF
  // the scale's excess (1.5× at 2.0): the whole of it filled a 320 dp
  // screen's card and pushed the goal lines below the fold, while the
  // text needs only its own width (133 dp at 2.0 against the 178 dp this
  // leaves inside the stroke). Computed, never measured — the card's
  // geometry stays deterministic.
  const { fontScale } = useWindowDimensions();
  const diameter = Math.round(size * (1 + Math.max(0, fontScale - 1) / 2));
  const half = diameter / 2;
  const arc = (rotation: number, visible: boolean) => ({
    width: diameter,
    height: diameter,
    borderRadius: half,
    borderWidth: strokeWidth,
    borderColor: 'transparent',
    borderTopColor: visible ? color : 'transparent',
    borderRightColor: visible ? color : 'transparent',
    transform: [{ rotate: `${rotation}deg` }],
  });
  return (
    <View style={{ width: diameter, height: diameter }}>
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: half, borderWidth: strokeWidth, borderColor: colors.surfaceRaised },
        ]}
      />
      {/* Right half (0°..180° clockwise from 12): the first 50%. */}
      <View style={[styles.halfClip, { width: half, height: diameter, left: half }]}>
        <View style={[arc(right.rotation, right.sweep > 0), { marginLeft: -half }]} />
      </View>
      {/* Left half (180°..360°): only once the right half is full. */}
      <View style={[styles.halfClip, { width: half, height: diameter, left: 0 }]}>
        <View style={[arc(left.rotation, left.sweep > 0)]} />
      </View>
      {/* The centre texts wrap INSIDE the stroke: a long caption ("of
          100000 today" at 2.0×, codex round 6) breaks into lines within
          the interior instead of running across the ring. */}
      <View style={[StyleSheet.absoluteFill, styles.center, { padding: strokeWidth + 6 }]}>
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
  centerTitle: { color: colors.text, ...type.display, fontWeight: '800', textAlign: 'center' },
  centerSubtitle: { color: colors.textDim, ...type.caption, marginTop: 2, textAlign: 'center' },
});
