/**
 * Minimal stepped slider (m0.5 similarity fine-tune). No native slider
 * dependency exists in the app and adding one would require a dev-client
 * rebuild, so this is a pressable/pannable track built on the already-
 * shipped react-native-gesture-handler: drag (horizontal-activated so
 * vertical scrolling wins) or tap to pick a value, − / + for single
 * steps. Values are integers 0..max.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { colors } from '../theme';

const THUMB = 22;

export function FineSlider({
  value,
  max,
  accent,
  onCommit,
}: {
  value: number;
  max: number;
  accent: string;
  /** Fired when the user releases the drag / taps / steps. */
  onCommit: (value: number) => void;
}) {
  const [trackW, setTrackW] = useState(0);
  /** Live drag preview; null = show the committed value. */
  const [drag, setDrag] = useState<number | null>(null);

  const commit = useCallback(
    (next: number) => {
      setDrag(null);
      onCommit(next);
    },
    [onCommit],
  );

  const clearDrag = useCallback(() => setDrag(null), []);

  const gesture = useMemo(() => {
    const fromX = (x: number): number => {
      'worklet';
      if (trackW <= 0) return value;
      return Math.min(max, Math.max(0, Math.round((x / trackW) * max)));
    };
    const pan = Gesture.Pan()
      .activeOffsetX([-5, 5])
      .failOffsetY([-12, 12])
      .onUpdate((event) => {
        runOnJS(setDrag)(fromX(event.x));
      })
      .onEnd((event) => {
        runOnJS(commit)(fromX(event.x));
      })
      .onFinalize((_event, success) => {
        if (!success) runOnJS(clearDrag)();
      });
    const tap = Gesture.Tap().onEnd((event, success) => {
      if (success) runOnJS(commit)(fromX(event.x));
    });
    return Gesture.Exclusive(pan, tap);
  }, [trackW, max, value, commit, clearDrag]);

  const shown = drag ?? value;
  const ratio = max > 0 ? shown / max : 0;

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.stepButton}
        hitSlop={6}
        disabled={shown <= 0}
        onPress={() => commit(Math.max(0, shown - 1))}
      >
        <Text style={[styles.stepText, shown <= 0 && styles.stepTextDisabled]}>−</Text>
      </Pressable>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.trackHit}
          onLayout={(event) => setTrackW(event.nativeEvent.layout.width)}
        >
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: accent }]} />
          </View>
          {trackW > 0 && (
            <View
              pointerEvents="none"
              style={[
                styles.thumb,
                { backgroundColor: accent, left: ratio * trackW - THUMB / 2 },
              ]}
            />
          )}
        </View>
      </GestureDetector>
      <Pressable
        style={styles.stepButton}
        hitSlop={6}
        disabled={shown >= max}
        onPress={() => commit(Math.min(max, shown + 1))}
      >
        <Text style={[styles.stepText, shown >= max && styles.stepTextDisabled]}>+</Text>
      </Pressable>
      <Text style={styles.valueText}>{shown}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepText: { color: colors.text, fontSize: 18, fontWeight: '800' },
  stepTextDisabled: { color: colors.textDim },
  trackHit: { flex: 1, height: 40, justifyContent: 'center' },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 3 },
  thumb: {
    position: 'absolute',
    top: (40 - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    borderColor: colors.text,
  },
  valueText: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '700',
    minWidth: 24,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
