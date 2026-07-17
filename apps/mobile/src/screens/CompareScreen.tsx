import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Compare'>;

const MAX_SCALE = 8;

function clamp(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

/**
 * The on-demand compare tool (m0.4 — the m0.3 duel screen's A/B flip +
 * synchronized zoom, kept as a tool the deck opens for any two photos).
 * Both candidates are rendered stacked in ONE transformed container — tap
 * anywhere flips which is visible (instant, no crossfade: flicker
 * comparison is the point), and pinch/pan zooms BOTH identically because
 * the transform lives on the shared parent.
 *
 * The verdict buttons apply to the photo currently shown and return to
 * the deck:
 *   - "Cull" stages IT for deletion (records a compare, keptBoth=false).
 *   - "Better" keeps both and records the compare (keptBoth=true) —
 *     compare losers that stay kept feed the Reconsider hint.
 *   - "Close" records nothing.
 */
export function CompareScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { aId, bId } = route.params;
  const { session, recordCompare, compareCull, needsEdit, toggleNeedsEdit } = useSession();
  const [busy, setBusy] = useState(false);
  const [showB, setShowB] = useState(false);

  const pair = useMemo(() => {
    if (!session) return null;
    try {
      return { a: session.item(aId), b: session.item(bId) };
    } catch {
      return null;
    }
  }, [session, aId, bId]);

  // --- synchronized zoom state (shared by both stacked images) ----------
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);

  const flip = useCallback(() => setShowB((v) => !v), []);

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(300)
        .onEnd((_event, success) => {
          if (success) runOnJS(flip)();
        }),
    [flip],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onUpdate((event) => {
          scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * event.scale));
          // Keep the pan inside bounds while zooming back out.
          const maxX = (stageW.value * (scale.value - 1)) / 2;
          const maxY = (stageH.value * (scale.value - 1)) / 2;
          tx.value = clamp(tx.value, maxX);
          ty.value = clamp(ty.value, maxY);
        })
        .onEnd(() => {
          savedScale.value = scale.value;
          savedTx.value = tx.value;
          savedTy.value = ty.value;
          if (scale.value <= 1.02) {
            scale.value = withTiming(1);
            savedScale.value = 1;
            tx.value = withTiming(0);
            ty.value = withTiming(0);
            savedTx.value = 0;
            savedTy.value = 0;
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .minPointers(1)
        .maxPointers(2)
        .averageTouches(true)
        .onUpdate((event) => {
          if (scale.value <= 1) return;
          const maxX = (stageW.value * (scale.value - 1)) / 2;
          const maxY = (stageH.value * (scale.value - 1)) / 2;
          tx.value = clamp(savedTx.value + event.translationX, maxX);
          ty.value = clamp(savedTy.value + event.translationY, maxY);
        })
        .onEnd(() => {
          savedTx.value = tx.value;
          savedTy.value = ty.value;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const composedGesture = useMemo(
    () => Gesture.Exclusive(Gesture.Simultaneous(pinchGesture, panGesture), tapGesture),
    [pinchGesture, panGesture, tapGesture],
  );

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // A photo can vanish mid-compare only via external state weirdness —
  // fall back to the deck rather than rendering a dead screen.
  useEffect(() => {
    if (!pair) navigation.goBack();
  }, [pair, navigation]);

  const decideBetter = useCallback(
    async (winnerId: string, loserId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await recordCompare(winnerId, loserId);
        navigation.goBack();
      } finally {
        setBusy(false);
      }
    },
    [busy, recordCompare, navigation],
  );

  const decideCull = useCallback(
    async (loserId: string, winnerId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await compareCull(loserId, winnerId);
        navigation.goBack();
      } finally {
        setBusy(false);
      }
    },
    [busy, compareCull, navigation],
  );

  if (!session || !pair) {
    return <View style={styles.root} />;
  }

  const visible = showB ? pair.b : pair.a;
  const hidden = showB ? pair.a : pair.b;
  const visibleLabel = showB ? 'B' : 'A';

  // Seconds always; millis when the two candidates share a second and the
  // data has sub-second resolution (same rule as the deck labels).
  const needMs = millisNeeded([pair.a.timestamp, pair.b.timestamp].sort((x, y) => x - y));
  const withMs = needMs[0] || needMs[1];

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Compare</Text>
        <Text style={styles.headerHint}>Tap to flip A/B · pinch to zoom both · decide below.</Text>
      </View>

      <GestureDetector gesture={composedGesture}>
        <View
          style={styles.stage}
          onLayout={(event) => {
            stageW.value = event.nativeEvent.layout.width;
            stageH.value = event.nativeEvent.layout.height;
          }}
        >
          <Animated.View style={[styles.stack, zoomStyle]}>
            <Image
              source={{ uri: pair.a.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              recyclingKey={pair.a.id}
            />
            {/* Stacked on top; opacity flip keeps both mounted so the zoom
                transform (on the shared parent) applies to both at once. */}
            <Image
              source={{ uri: pair.b.uri }}
              style={[StyleSheet.absoluteFill, { opacity: showB ? 1 : 0 }]}
              contentFit="contain"
              recyclingKey={pair.b.id}
            />
          </Animated.View>
          <View style={styles.abBadge} pointerEvents="none">
            <Text style={styles.abBadgeText}>
              {visibleLabel} · {formatClockPrecise(visible.timestamp, withMs)}
            </Text>
          </View>
        </View>
      </GestureDetector>

      <View style={styles.subRow}>
        <View style={styles.abChips}>
          {(['A', 'B'] as const).map((which) => (
            <Pressable
              key={which}
              onPress={() => setShowB(which === 'B')}
              style={[
                styles.abChip,
                visibleLabel === which && { backgroundColor: theme.accent, borderColor: theme.accent },
              ]}
            >
              <Text
                style={[styles.abChipText, visibleLabel === which && { color: theme.onAccent }]}
              >
                {which}
              </Text>
            </Pressable>
          ))}
        </View>
        {/* m0.2: the flag follows the photo — a kept photo with the flag
            lands in the to-edit queue instead of plain done. */}
        <Pressable
          style={[styles.editTag, needsEdit(visible.id) && styles.editTagActive]}
          hitSlop={8}
          disabled={busy}
          onPress={() => void toggleNeedsEdit(visible.id)}
        >
          <Text style={[styles.editTagText, needsEdit(visible.id) && styles.editTagTextActive]}>
            {needsEdit(visible.id) ? `✎ ${visibleLabel} needs edit ✓` : `✎ ${visibleLabel} needs edit`}
          </Text>
        </Pressable>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, styles.cullButton]}
          disabled={busy}
          onPress={() => void decideCull(visible.id, hidden.id)}
        >
          <Text style={styles.actionText}>✕ Cull {visibleLabel}</Text>
        </Pressable>
        <Pressable
          style={[styles.actionButton, styles.betterButton]}
          disabled={busy}
          onPress={() => void decideBetter(visible.id, hidden.id)}
        >
          <Text style={styles.actionText}>★ {visibleLabel} is better</Text>
        </Pressable>
      </View>
      <Pressable style={styles.closeButton} disabled={busy} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>Close — no verdict</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12, gap: 10, paddingTop: 8 },
  header: { gap: 2, paddingHorizontal: 4 },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  headerHint: { color: colors.textDim, fontSize: 12 },
  stage: {
    flex: 1,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  stack: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  abBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  abBadgeText: { color: colors.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  abChips: { flexDirection: 'row', gap: 6 },
  abChip: {
    minWidth: 44,
    minHeight: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  abChipText: { color: colors.textDim, fontSize: 15, fontWeight: '700' },
  editTag: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  editTagActive: { backgroundColor: colors.editDim, borderColor: colors.edit },
  editTagText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  editTagTextActive: { color: colors.edit },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionButton: {
    flex: 1,
    minHeight: 60,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cullButton: { backgroundColor: colors.cullDim },
  betterButton: { backgroundColor: '#1f3a2a' },
  actionText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  closeButton: {
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
