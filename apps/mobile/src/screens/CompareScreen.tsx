import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { getSetting, setSetting, type ReviewGroupRow, type ReviewMemberRow } from '../db/store';
import {
  COMPARE_AUTO_CULL_KEY,
  parseCompareAutoCull,
  serializeCompareAutoCull,
} from '../lib/comparePrefs';
import { showToast } from '../lib/toast';
import { DOUBLE_TAP_MS } from '../lib/zoomTarget';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected } from '../lib/favouriteState';
import { ActionChip } from '../components/ActionChip';
import { GoalCelebration } from '../components/GoalCelebration';
import { addToShareQueue, removeFromShareQueue } from '../db/shareStore';
import { queueOrganize, unqueueOrganize } from '../db/organizeStore';
import { useIsFocused } from '@react-navigation/native';

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
 * Labels are the photos' DECK POSITIONS ("3" / "7", matching the deck's
 * "3/9" numbering) instead of A/B, so testers can find the photo again
 * after leaving compare.
 *
 * VERDICTS (m0.8.2, F15): a duel writes them only when it IS the whole
 * table — any singles duel, or a group whose undecided remainder this
 * duel settles (≤ 2 alive). There the "N is better" tap raises the
 * keep-both/cull dialog (suppressed by the persisted "don't ask again"
 * auto-cull preference, resettable from Settings): "Keep both" marks
 * BOTH photos kept, "Cull" stages the loser and leaves the winner
 * untouched — atomically either way, with the winner's star + duel row
 * in the group case. A duel with 3+ alive is TRIAGE: star + history,
 * no verdict — repeated burst duels pick best/worst, they do not keep.
 * Eligibility is undecided-or-KEPT (F11), so a duel can re-decide a
 * prior keep; "Cull N" always just stages the visible photo.
 */
export function CompareScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { groupId, aId, bId, singles = false, day, from, to } = route.params;
  const {
    groups,
    singles: singleRows,
    recordCompare,
    compareCull,
    compareKeepBoth,
    needsEdit,
    toggleNeedsEdit,
    decide,
    favouriteStatus,
    toggleFavourite,
    queuedFor,
    refreshQueuedFor,
    loadGroup,
    loadDeckSingles,
    noteDecisions,
    celebrationTick,
    consumeCelebration,
  } = useReview();
  const isFocused = useIsFocused();
  const numericGroupId = groupId ? Number(groupId) : null;
  const queueGroup = useMemo(
    () =>
      numericGroupId !== null ? (groups.find((g) => g.groupId === numericGroupId) ?? null) : null,
    [groups, numericGroupId],
  );
  // An explicitly opened group can sit outside the queue page (DayProgress,
  // a scan pushing it off) — fetch it directly, like the deck does.
  const [loadedGroup, setLoadedGroup] = useState<ReviewGroupRow | 'loading' | 'missing'>('loading');
  useEffect(() => {
    let cancelled = false;
    if (numericGroupId === null || queueGroup) {
      setLoadedGroup('loading');
      return;
    }
    void loadGroup(numericGroupId).then(
      (fetched) => {
        if (!cancelled) setLoadedGroup(fetched ?? 'missing');
      },
      (error) => {
        // Terminal: the missing-pair effect navigates back instead of
        // leaving a permanently blank screen.
        console.warn('[compare] group load failed:', String(error));
        if (!cancelled) setLoadedGroup('missing');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [numericGroupId, queueGroup, loadGroup]);
  const group = queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
  /** An off-page group fetch is still in flight — a missing pair is not
   * terminal yet. */
  const groupPending = numericGroupId !== null && !queueGroup && loadedGroup === 'loading';
  // A day/run-scoped singles deck (m0.8.2) hands us photos that can sit
  // outside the queue's newest-first singles page, so the two ids would
  // not resolve from `singleRows` alone — fetch the SAME scope the deck
  // showed (day, optionally run-range narrowed) so the position labels
  // number over the same rows.
  const [dayRows, setDayRows] = useState<ReviewMemberRow[] | null>(null);
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    void loadDeckSingles(day, from !== undefined && to !== undefined ? { from, to } : null).then(
      (rows: ReviewMemberRow[]) => {
        if (!cancelled) setDayRows(rows);
      },
      (error: unknown) => {
        // Terminal, like a failed group fetch: the pair simply will not
        // resolve, and the effect below returns to the deck.
        console.warn('[compare] day singles load failed:', String(error));
        if (!cancelled) setDayRows([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [day, from, to, loadDeckSingles]);
  /** The day fetch is still in flight — a missing pair is not terminal
   * yet (same rule as groupPending). */
  const dayPending = !!day && dayRows === null;
  const itemLookup = useMemo(() => {
    const map = new Map<string, { id: string; timestamp: number; uri: string }>();
    for (const g of [...groups, ...(typeof loadedGroup === 'object' ? [loadedGroup] : [])])
      for (const m of g.members)
        map.set(m.asset_id, { id: m.asset_id, timestamp: m.taken_at, uri: m.uri });
    for (const m of [...singleRows, ...(dayRows ?? [])])
      map.set(m.asset_id, { id: m.asset_id, timestamp: m.taken_at, uri: m.uri });
    return map;
  }, [groups, singleRows, dayRows, loadedGroup]);
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
    const a = itemLookup.get(aId);
    const b = itemLookup.get(bId);
    return a && b ? { a, b } : null;
  }, [itemLookup, aId, bId]);

  // m0.5: group positions as labels (1-based, frozen at mount). Since
  // the deck keeps EVERY member in place badged (m0.8.2 unification),
  // its numbering runs over ALL members — Compare's labels must match,
  // kept members included (they are duel-able now, F11).
  const groupInfo = useMemo(() => {
    if (!group || singles) return null;
    return {
      aliveIds: group.members.filter((m) => m.state === 'unreviewed').map((m) => m.asset_id),
      memberIds: group.members.map((m) => m.asset_id),
    };
  }, [group, singles]);
  const posOf = useCallback(
    (id: string): string => {
      if (singles) {
        // A singles deck numbers photos over its own day/run rows — the
        // global feed is a bounded newest-first page that may not even
        // contain them (codex r50).
        const rows = day ? (dayRows ?? []) : singleRows;
        const index = rows.findIndex((m) => m.asset_id === id);
        return index >= 0 ? String(index + 1) : '?';
      }
      if (!groupInfo) return '?';
      const member = groupInfo.memberIds.indexOf(id);
      return member >= 0 ? String(member + 1) : '?';
    },
    [day, dayRows, groupInfo, singleRows, singles],
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

  // Taps live on the JS responder path (the stage is a Pressable), NOT
  // on Gesture.Tap: any runOnJS from a gesture worklet segfaults this
  // build (SIGSEGV in AroundLock::utf8; reanimated #9776, worklets
  // 0.10.2 — see DeckScreen's bridge comment). Flip needs setState, so
  // the whole tap/double-tap arbitration moves here.
  // Not zoomed: every tap flips immediately (a double tap is two flips,
  // exactly the old fails-fast behavior). Zoomed: a tap waits one
  // double-tap window so m0.7 (#18)'s double-tap-resets-zoom can win —
  // writing shared values FROM JS is the safe direction of the bridge.
  // Deliberately NO double-tap-zoom here (unlike deck/viewer): the tap
  // IS the flip, and buying a zoom gesture would tax every unzoomed
  // flip with the wait window. Zooming in Compare stays pinch-only.
  const pendingFlip = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendingFlip.current) clearTimeout(pendingFlip.current);
    },
    [],
  );
  const onStagePress = useCallback(() => {
    if (scale.value <= 1.02) {
      flip();
      return;
    }
    if (pendingFlip.current) {
      clearTimeout(pendingFlip.current);
      pendingFlip.current = null;
      scale.value = withTiming(1);
      savedScale.value = 1;
      tx.value = withTiming(0);
      ty.value = withTiming(0);
      savedTx.value = 0;
      savedTy.value = 0;
      return;
    }
    pendingFlip.current = setTimeout(() => {
      pendingFlip.current = null;
      flip();
    }, DOUBLE_TAP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip]);

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
    () => Gesture.Simultaneous(pinchGesture, panGesture),
    [pinchGesture, panGesture],
  );

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // A photo can vanish mid-compare only via external state weirdness —
  // fall back to the deck rather than rendering a dead screen. An
  // off-page group still loading is NOT terminal (gate 5).
  useEffect(() => {
    if (!pair && !groupPending && !dayPending) navigation.goBack();
  }, [pair, groupPending, dayPending, navigation]);

  // Goal moment (F14, amended): a crossing HERE celebrates HERE — the
  // context holds the counter; this screen notes its fresh decisions and
  // claims the pending moment while it is the focused surface.
  const [celebrating, setCelebrating] = useState(false);
  const [celebrationGoal, setCelebrationGoal] = useState(0);
  useEffect(() => {
    if (!isFocused) return;
    const goal = consumeCelebration();
    if (goal !== null) {
      setCelebrationGoal(goal);
      setCelebrating(true);
    }
  }, [celebrationTick, isFocused, consumeCelebration]);
  /** The photo's state BEFORE this duel wrote — the fresh-decision count
   * for noteDecisions (only unreviewed → decided counts). */
  const priorState = useCallback(
    (id: string): string => {
      const member = group?.members.find((m) => m.asset_id === id);
      if (member) return member.state;
      const row =
        (dayRows ?? []).find((m) => m.asset_id === id) ?? singleRows.find((m) => m.asset_id === id);
      return row?.state ?? 'unreviewed';
    },
    [group, dayRows, singleRows],
  );

  /** Triage (3+ comparable in the group, F15): star the winner + record
   * the duel, NO verdicts — repeated burst duels pick best/worst, they
   * do not keep. */
  const recordTriage = useCallback(
    async (winnerId: string, loserId: string) => {
      if (numericGroupId === null) return;
      try {
        await recordCompare(numericGroupId, winnerId, loserId);
      } catch {
        return; // surfaced by the provider alert; stay on the screen
      }
      showToast(`Photo ${posOf(winnerId)} starred best of group — compare recorded`);
      navigation.goBack();
    },
    [numericGroupId, recordCompare, posOf, navigation],
  );

  /** Dialog outcome "Keep both" (F15): BOTH participants land on kept —
   * atomically, with the winner's star + duel row in the group case. */
  const keepBothNow = useCallback(
    async (winnerId: string, loserId: string) => {
      const fresh = [winnerId, loserId].filter((id) => priorState(id) === 'unreviewed').length;
      try {
        await compareKeepBoth(
          winnerId,
          loserId,
          singles ? undefined : (numericGroupId ?? undefined),
        );
      } catch {
        return; // surfaced by the provider alert; stay on the screen
      }
      noteDecisions(fresh);
      showToast(
        singles
          ? `Kept photos ${posOf(winnerId)} and ${posOf(loserId)}`
          : `Both kept — photo ${posOf(winnerId)} starred best of group`,
      );
      navigation.goBack();
    },
    [compareKeepBoth, singles, numericGroupId, posOf, navigation, priorState, noteDecisions],
  );

  /** Dialog outcome "Cull": stage the loser; the winner stays untouched
   * (a cull judgment says nothing about keeping — F15). */
  const cullLoserNow = useCallback(
    async (winnerId: string, loserId: string) => {
      const fresh = priorState(loserId) === 'unreviewed' ? 1 : 0;
      try {
        if (singles) {
          await decide(loserId, 'cull', null);
          showToast(`Photo ${posOf(loserId)} staged to cull`);
        } else if (numericGroupId !== null) {
          await compareCull(numericGroupId, loserId, winnerId);
          showToast(
            `Photo ${posOf(winnerId)} starred best — photo ${posOf(loserId)} staged to cull`,
          );
        }
      } catch {
        return; // surfaced by the provider alert; stay on the screen
      }
      noteDecisions(fresh);
      navigation.goBack();
    },
    [singles, decide, numericGroupId, compareCull, posOf, navigation, priorState, noteDecisions],
  );

  const decideBetter = useCallback(
    async (winnerId: string, loserId: string) => {
      if (busy) return;
      // The dialog appears exactly when the duel IS the whole table
      // (F15): any singles duel, or a group whose undecided remainder
      // this duel settles (≤ 2 alive — kept members can rejoin a duel
      // via F11 without reopening the question for the rest). Otherwise
      // the duel is triage and writes no verdict.
      const wholeTable = singles || aliveCount <= 2;
      if (!wholeTable) {
        setBusy(true);
        try {
          await recordTriage(winnerId, loserId);
        } finally {
          setBusy(false);
        }
        return;
      }
      if (autoCull) {
        setBusy(true);
        try {
          await cullLoserNow(winnerId, loserId);
        } finally {
          setBusy(false);
        }
      } else {
        setDontAskAgain(false);
        setCullOffer({ winnerId, loserId });
      }
    },
    [aliveCount, autoCull, busy, cullLoserNow, recordTriage, singles],
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
          await cullLoserNow(offer.winnerId, offer.loserId);
        } else {
          await keepBothNow(offer.winnerId, offer.loserId);
        }
      } finally {
        setBusy(false);
      }
    },
    [cullOffer, busy, dontAskAgain, db, cullLoserNow, keepBothNow],
  );

  const decideCull = useCallback(
    async (loserId: string, winnerId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await cullLoserNow(winnerId, loserId);
      } finally {
        setBusy(false);
      }
    },
    [busy, cullLoserNow],
  );

  if (!pair) {
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
        {/* The stage itself is the tap target: presses flip (JS thread),
            while drags and pinches hand over to the gestures above. */}
        <Pressable
          style={styles.stage}
          onPress={onStagePress}
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
        </Pressable>
      </GestureDetector>

      <View style={styles.subRow}>
        <View style={styles.abChips}>
          {([pair.a, pair.b] as const).map((item, index) => {
            const active = (index === 1) === showB;
            return (
              <Pressable
                key={item.id}
                onPress={() => {
                  // An explicit chip choice outranks a stage tap still
                  // waiting out its double-tap window.
                  if (pendingFlip.current) {
                    clearTimeout(pendingFlip.current);
                    pendingFlip.current = null;
                  }
                  setShowB(index === 1);
                }}
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
        <Text style={styles.actingOn}>Actions apply to photo {visibleLabel}</Text>
      </View>

      {/* All four actions, the deck's uniform chips (m0.8.2, F16) —
          acting on the VISIBLE photo, like the verdict buttons below.
          Edit is the flag toggle; Organize and Share toggle their queues
          exactly as the deck does (organize queues target-less, F6). */}
      <View style={styles.chipRow}>
        <ActionChip
          kind="edit"
          active={needsEdit(visible.id)}
          disabled={busy}
          onPress={() => void toggleNeedsEdit(visible.id).catch(() => {})}
        />
        {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
          <ActionChip
            kind="favourite"
            active={favourite}
            disabled={busy}
            onPress={() => void toggleFavourite(visible.id).catch(() => {})}
          />
        )}
        <ActionChip
          kind="organize"
          active={queuedFor(visible.id).organize}
          disabled={busy}
          onPress={() =>
            void (async () => {
              if (queuedFor(visible.id).organize) await unqueueOrganize(db, visible.id, Date.now());
              else {
                const error = await queueOrganize(db, visible.id, Date.now());
                if (error) return;
              }
              await refreshQueuedFor();
            })().catch(() => {})
          }
        />
        <ActionChip
          kind="share"
          active={queuedFor(visible.id).share}
          disabled={busy}
          onPress={() =>
            void (async () => {
              if (queuedFor(visible.id).share)
                await removeFromShareQueue(db, visible.id, Date.now());
              else await addToShareQueue(db, visible.id, Date.now());
              await refreshQueuedFor();
            })().catch(() => {})
          }
        />
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
          {/* One label for both modes (F15): the dialog carries the
              verdict question, so the button no longer promises a keep
              it might not write. */}
          <Text style={styles.actionText}>{visibleLabel} is better</Text>
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
            {/* F15: the dialog IS the verdict — both answers write. */}
            <Text style={styles.offerText}>
              Keep both marks photos {cullOffer ? posOf(cullOffer.winnerId) : ''} and{' '}
              {cullOffer ? posOf(cullOffer.loserId) : ''} kept
              {singles
                ? ''
                : ` (photo ${cullOffer ? posOf(cullOffer.winnerId) : ''} stars as the group's best)`}
              . Cull stages photo {cullOffer ? posOf(cullOffer.loserId) : ''} — deleted only after
              you confirm the cull list.
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

      {/* The goal moment (F14): a crossing decided HERE shows HERE. */}
      {celebrating && (
        <GoalCelebration
          goal={celebrationGoal}
          accent={theme.accent}
          onDone={() => setCelebrating(false)}
        />
      )}
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
  actingOn: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
  chipRow: { flexDirection: 'row', gap: 10 },
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
  betterButton: { backgroundColor: colors.keepDim },
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
