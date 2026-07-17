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
import { colors, touch } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Duel'>;

const MAX_SCALE = 8;

function clamp(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

/**
 * The duel, m0.3 style: full-screen A/B flip compare. Both candidates are
 * rendered stacked in ONE transformed container — tap anywhere flips which
 * is visible (instant, no crossfade: flicker comparison is the point), and
 * pinch/pan zooms BOTH identically because the transform lives on the
 * shared parent (reanimated shared values + gesture-handler).
 *
 * The action buttons apply to the photo currently shown:
 *   - "Cull" stages IT for deletion; the hidden one wins the duel.
 *   - "Better" keeps both and advances the visible one.
 */
export function DuelScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const {
    session,
    groups,
    decideDuel,
    needsEdit,
    toggleNeedsEdit,
    version,
    pendingReconsider,
  } = useSession();
  const [busy, setBusy] = useState(false);
  const [showB, setShowB] = useState(false);

  const pair = useMemo(() => session?.nextPair() ?? null, [session, version]);
  const pairKey = pair ? `${pair.a.id}:${pair.b.id}` : '';

  // --- synchronized zoom state (shared by both stacked images) ----------
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);

  // New pair → fresh compare: reset zoom and show A.
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    tx.value = 0;
    ty.value = 0;
    savedTx.value = 0;
    savedTy.value = 0;
    setShowB(false);
    // Shared values are stable refs — only the pair matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);

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

  // ----------------------------------------------------------- session ---
  const groupInfo = useMemo(() => {
    if (!pair) return null;
    const index = groups.findIndex((g) => g.id === pair.groupId);
    if (index < 0) return null;
    const group = groups[index];
    return { index, total: groups.length, size: group.items.length, start: group.items[0].timestamp };
  }, [pair, groups]);

  // Route forward: a completed bracket with reconsider candidates first,
  // then remaining duels, singles, and finally the cull list.
  useEffect(() => {
    if (!session) return;
    if (pendingReconsider) {
      navigation.replace('Reconsider', { groupId: pendingReconsider });
      return;
    }
    if (pair) return;
    if (session.nextSingle()) navigation.replace('Singles');
    else navigation.replace('CullList');
  }, [session, pair, pendingReconsider, navigation]);

  const decide = useCallback(
    async (decision: Parameters<typeof decideDuel>[0]) => {
      if (busy) return;
      setBusy(true);
      try {
        await decideDuel(decision);
      } finally {
        setBusy(false);
      }
    },
    [busy, decideDuel],
  );

  if (!session || !pair) {
    return <View style={styles.root} />;
  }

  const visible = showB ? pair.b : pair.a;
  const visibleLabel = showB ? 'B' : 'A';

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {groupInfo
            ? `Group ${groupInfo.index + 1} of ${groupInfo.total} · ${groupInfo.size} shots · ${formatClock(groupInfo.start)}`
            : 'Duel'}
        </Text>
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
              {visibleLabel} · {formatClock(visible.timestamp)}
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
              style={[styles.abChip, visibleLabel === which && styles.abChipActive]}
            >
              <Text
                style={[styles.abChipText, visibleLabel === which && styles.abChipTextActive]}
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
          onPress={() => void decide({ cull: visible.id })}
        >
          <Text style={styles.actionText}>✕ Cull {visibleLabel}</Text>
        </Pressable>
        <Pressable
          style={[styles.actionButton, styles.betterButton]}
          disabled={busy}
          onPress={() => void decide({ keepBoth: true, winner: visible.id })}
        >
          <Text style={styles.actionText}>★ {visibleLabel} is better</Text>
        </Pressable>
      </View>
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
  abBadgeText: { color: colors.text, fontSize: 13, fontWeight: '700' },
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
  abChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  abChipText: { color: colors.textDim, fontSize: 15, fontWeight: '700' },
  abChipTextActive: { color: '#1a1205' },
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
});
