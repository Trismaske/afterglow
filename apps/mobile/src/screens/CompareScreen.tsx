import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
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
import { getSetting, setSetting } from '../db/store';
import {
  COMPARE_AUTO_CULL_KEY,
  parseCompareAutoCull,
  serializeCompareAutoCull,
} from '../lib/comparePrefs';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected } from '../lib/favouriteState';

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
 * m0.5 changes:
 * - Labels are the photos' GROUP POSITIONS ("3" / "7", matching the deck's
 *   "3/9" numbering) instead of A/B, so testers can find the photo again
 *   after leaving compare.
 * - "N is better" now visibly means something: it stars N best-of-group
 *   (markBest) and records the compare history, with a toast
 *   saying so. In a TWO-photo group it also offers to cull the other —
 *   confirm dialog with "Don't ask again" (suppression persisted in
 *   settings; resettable from Settings → auto-cull thereafter).
 * - "Cull N" is unchanged: stages N and records the compare.
 */
export function CompareScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { groupId, aId, bId, singles = false } = route.params;
  const {
    session,
    recordCompare,
    compareCull,
    markBest,
    needsEdit,
    toggleNeedsEdit,
    decideSingle,
    redecide,
    favouriteStatus,
    toggleFavourite,
  } = useSession();
  const [busy, setBusy] = useState(false);
  const [showB, setShowB] = useState(false);
  const [autoCull, setAutoCull] = useState(false);
  const [cullOffer, setCullOffer] = useState<{ winnerId: string; loserId: string } | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSetting(db, COMPARE_AUTO_CULL_KEY).then((raw) => {
      if (!cancelled) setAutoCull(parseCompareAutoCull(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const pair = useMemo(() => {
    if (!session) return null;
    try {
      return { a: session.item(aId), b: session.item(bId) };
    } catch {
      return null;
    }
  }, [session, aId, bId]);

  // m0.5: group positions as labels (1-based over the deck's alive order,
  // frozen at mount — membership can't change while this screen is up).
  const groupInfo = useMemo(() => {
    if (!session || !groupId || singles) return null;
    try {
      return session.groupInfo(groupId);
    } catch {
      return null;
    }
  }, [session, groupId, singles]);
  const posOf = useCallback(
    (id: string): string => {
      if (singles && session) {
        const index = session.toJSON().singleIds.indexOf(id);
        return index >= 0 ? String(index + 1) : '?';
      }
      if (!groupInfo) return '?';
      const alive = groupInfo.aliveIds.indexOf(id);
      if (alive >= 0) return String(alive + 1);
      const member = groupInfo.memberIds.indexOf(id);
      return member >= 0 ? String(member + 1) : '?';
    },
    [groupInfo, session, singles],
  );
  const aliveCount = groupInfo?.aliveIds.length ?? 0;

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

  // m0.7 (#18): double-tap resets zoom when zoomed; when not zoomed it
  // falls through (fails fast) so the flip tap keeps its snappiness.
  const doubleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onTouchesDown((_event, manager) => {
          if (scale.value <= 1.02) manager.fail();
        })
        .onEnd((_event, success) => {
          if (!success) return;
          scale.value = withTiming(1);
          savedScale.value = 1;
          tx.value = withTiming(0);
          ty.value = withTiming(0);
          savedTx.value = 0;
          savedTy.value = 0;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
    () =>
      Gesture.Exclusive(
        Gesture.Simultaneous(pinchGesture, panGesture),
        doubleTapGesture,
        tapGesture,
      ),
    [pinchGesture, panGesture, doubleTapGesture, tapGesture],
  );

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // A photo can vanish mid-compare only via external state weirdness —
  // fall back to the deck rather than rendering a dead screen.
  useEffect(() => {
    if (!pair) navigation.goBack();
  }, [pair, navigation]);

  /** Star the winner + keep both, with the m0.5 visibility toast. */
  const betterKeepBoth = useCallback(
    async (winnerId: string, loserId: string) => {
      if (!groupId) return;
      await markBest(groupId, winnerId);
      await recordCompare(winnerId, loserId);
      showToast(`Photo ${posOf(winnerId)} starred best of group — compare recorded`);
      navigation.goBack();
    },
    [groupId, markBest, recordCompare, posOf, navigation],
  );

  /** Star the winner + stage the two-photo-group loser. */
  const betterCullLoser = useCallback(
    async (winnerId: string, loserId: string) => {
      if (!groupId) return;
      await markBest(groupId, winnerId);
      await compareCull(loserId, winnerId);
      showToast(`Photo ${posOf(winnerId)} kept — photo ${posOf(loserId)} staged to cull`);
      navigation.goBack();
    },
    [groupId, markBest, compareCull, posOf, navigation],
  );

  const decideBetter = useCallback(
    async (winnerId: string, loserId: string) => {
      if (busy) return;
      if (singles && session) {
        setBusy(true);
        try {
          const state = session.getState(winnerId);
          if (state === 'unreviewed') await decideSingle(winnerId, 'keep');
          else if (state !== 'kept' || needsEdit(winnerId)) await redecide(winnerId, 'keep');
          navigation.goBack();
        } finally {
          setBusy(false);
        }
        return;
      }
      // Two-photo group: "better" implies the other loses the group —
      // offer the cull (or just do it once the dialog was suppressed).
      if (aliveCount === 2) {
        if (autoCull) {
          setBusy(true);
          try {
            await betterCullLoser(winnerId, loserId);
          } finally {
            setBusy(false);
          }
        } else {
          setDontAskAgain(false);
          setCullOffer({ winnerId, loserId });
        }
        return;
      }
      setBusy(true);
      try {
        await betterKeepBoth(winnerId, loserId);
      } finally {
        setBusy(false);
      }
    },
    [
      aliveCount,
      autoCull,
      betterCullLoser,
      betterKeepBoth,
      busy,
      decideSingle,
      navigation,
      needsEdit,
      redecide,
      session,
      singles,
    ],
  );

  const resolveCullOffer = useCallback(
    async (cull: boolean) => {
      const offer = cullOffer;
      if (!offer || busy) return;
      setCullOffer(null);
      setBusy(true);
      try {
        if (cull) {
          // "Don't ask again" only sticks with the cull choice — it means
          // "better = auto-cull the loser from now on".
          if (dontAskAgain) {
            setAutoCull(true);
            await setSetting(db, COMPARE_AUTO_CULL_KEY, serializeCompareAutoCull(true));
          }
          await betterCullLoser(offer.winnerId, offer.loserId);
        } else {
          await betterKeepBoth(offer.winnerId, offer.loserId);
        }
      } finally {
        setBusy(false);
      }
    },
    [cullOffer, busy, dontAskAgain, db, betterCullLoser, betterKeepBoth],
  );

  const decideCull = useCallback(
    async (loserId: string, winnerId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        if (singles && session) {
          const state = session.getState(loserId);
          if (state === 'unreviewed') await decideSingle(loserId, 'cull');
          else if (state !== 'culled') await redecide(loserId, 'cull');
        } else {
          await compareCull(loserId, winnerId);
        }
        navigation.goBack();
      } finally {
        setBusy(false);
      }
    },
    [busy, compareCull, decideSingle, navigation, redecide, session, singles],
  );

  if (!session || !pair) {
    return <View style={styles.root} />;
  }

  const visible = showB ? pair.b : pair.a;
  const hidden = showB ? pair.a : pair.b;
  const visibleLabel = posOf(visible.id);
  const favourite = isFavouriteSelected(favouriteStatus(visible.id));

  // Seconds always; millis when the two candidates share a second and the
  // data has sub-second resolution (same rule as the deck labels).
  const needMs = millisNeeded([pair.a.timestamp, pair.b.timestamp].sort((x, y) => x - y));
  const withMs = needMs[0] || needMs[1];

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          Compare {posOf(pair.a.id)} vs {posOf(pair.b.id)}
        </Text>
        <Text style={styles.headerHint}>
          Tap to flip {posOf(pair.a.id)}/{posOf(pair.b.id)} · pinch to zoom both · decide below.
        </Text>
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
          {([pair.a, pair.b] as const).map((item, index) => {
            const active = (index === 1) === showB;
            return (
              <Pressable
                key={item.id}
                onPress={() => setShowB(index === 1)}
                style={[
                  styles.abChip,
                  active && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                <Text style={[styles.abChipText, active && { color: theme.onAccent }]}>
                  {posOf(item.id)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* m0.2: the flag follows the photo — a kept photo with the flag
            lands in the to-edit queue instead of plain done. */}
        <Pressable
          style={[styles.editTag, needsEdit(visible.id) && styles.editTagActive]}
          hitSlop={8}
          disabled={busy}
          onPress={() => void toggleNeedsEdit(visible.id)}
        >
          <MaterialCommunityIcons
            name={needsEdit(visible.id) ? 'pencil' : 'pencil-outline'}
            size={18}
            color={needsEdit(visible.id) ? colors.edit : colors.textDim}
          />
          <Text style={[styles.editTagText, needsEdit(visible.id) && styles.editTagTextActive]}>
            {visibleLabel} needs edit
          </Text>
        </Pressable>
        {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
          <Pressable
            style={[styles.editTag, favourite && styles.favouriteTagActive]}
            hitSlop={8}
            disabled={busy}
            onPress={() => void toggleFavourite(visible.id)}
          >
            <MaterialCommunityIcons
              name={favourite ? 'heart' : 'heart-outline'}
              size={18}
              color={favourite ? colors.fav : colors.textDim}
            />
          </Pressable>
        )}
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, styles.cullButton]}
          disabled={busy}
          onPress={() => void decideCull(visible.id, hidden.id)}
        >
          <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
          <Text style={styles.actionText}>Cull {visibleLabel}</Text>
        </Pressable>
        <Pressable
          style={[styles.actionButton, styles.betterButton]}
          disabled={busy}
          onPress={() => void decideBetter(visible.id, hidden.id)}
        >
          <MaterialCommunityIcons
            name={singles ? 'check' : 'star'}
            size={21}
            color={singles ? colors.keep : theme.accent}
          />
          <Text style={styles.actionText}>
            {singles ? `Keep ${visibleLabel}` : `${visibleLabel} is better`}
          </Text>
        </Pressable>
      </View>
      <Pressable style={styles.closeButton} disabled={busy} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>Close — no verdict</Text>
      </Pressable>

      {/* m0.5: two-photo group "better" → offer to cull the loser. */}
      <Modal
        visible={cullOffer !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setCullOffer(null)}
      >
        <View style={styles.offerBackdrop}>
          <View style={styles.offerCard}>
            <Text style={styles.offerTitle}>
              Keep only photo {cullOffer ? posOf(cullOffer.winnerId) : ''}?
            </Text>
            <Text style={styles.offerText}>
              It becomes the group's best. Photo {cullOffer ? posOf(cullOffer.loserId) : ''} goes to
              the cull list — deleted only after you confirm the list.
            </Text>
            <Pressable
              style={styles.offerCheckRow}
              hitSlop={6}
              onPress={() => setDontAskAgain((v) => !v)}
            >
              <View
                style={[
                  styles.offerCheckbox,
                  dontAskAgain && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                {dontAskAgain && (
                  <MaterialCommunityIcons name="check" size={15} color={theme.onAccent} />
                )}
              </View>
              <Text style={styles.offerCheckLabel}>
                Don't ask again — "better" always culls the other photo
              </Text>
            </Pressable>
            <View style={styles.offerButtons}>
              <Pressable
                style={[styles.offerButton, styles.offerKeepButton]}
                onPress={() => void resolveCullOffer(false)}
              >
                <Text style={styles.offerButtonText}>Keep both</Text>
              </Pressable>
              <Pressable
                style={[styles.offerButton, styles.offerCullButton]}
                onPress={() => void resolveCullOffer(true)}
              >
                <Text style={styles.offerButtonText}>
                  Cull {cullOffer ? posOf(cullOffer.loserId) : ''}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    gap: 10,
    paddingTop: 8,
  },
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
  abBadgeText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  editTagActive: { backgroundColor: colors.editDim, borderColor: colors.edit },
  favouriteTagActive: { backgroundColor: colors.favDim, borderColor: colors.fav },
  editTagText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  editTagTextActive: { color: colors.edit },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionButton: {
    flex: 1,
    minHeight: 60,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
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
  offerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  offerCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 12,
  },
  offerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  offerText: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  offerCheckRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  offerCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offerCheckLabel: { color: colors.textDim, fontSize: 13, flex: 1, lineHeight: 18 },
  offerButtons: { flexDirection: 'row', gap: 10 },
  offerButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offerKeepButton: { backgroundColor: colors.keepDim },
  offerCullButton: { backgroundColor: colors.cullDim },
  offerButtonText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
