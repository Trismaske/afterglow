import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import {
  InterceptingGestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  VirtualGestureDetector,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { getSetting, setSetting, type ReviewGroupRow, type ReviewMemberRow } from '../db/store';
import {
  COMPARE_AUTO_CULL_KEY,
  parseCompareDuelPref,
  serializeCompareDuelPref,
  type CompareDuelPref,
} from '../lib/comparePrefs';
import { showToast } from '../lib/toast';
import { DOUBLE_TAP_MS, pinchEngaged, pinchGain } from '../lib/zoomTarget';
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

// 16× (Tristan, 2026-08-04). Past 1:1 pixels by design: a 50 MP frame
// reaches one source pixel per screen pixel at ~5.7× on a 1440 px-wide
// phone, so the top of this range magnifies interpolation rather than
// revealing detail — wanted for inspecting a focus point, not for
// judging sharpness. panBounds clamps to the photo's own edges, so a
// deep zoom cannot wander off the content.
const MAX_SCALE = 16;

function clamp(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

/** The write-error surface for Compare's DIRECT queue writes (Organize/
 * Share bypass the provider, so App.tsx's decision alert never fires for
 * them) — the same promise that alert makes: the durable row is
 * unchanged, so the user simply retries the tap. */
function surfaceQueueWriteError(error: unknown): void {
  Alert.alert(
    'Change not saved',
    `Afterglow could not write the change to its database. Nothing was changed — please retry the action.\n\n${error instanceof Error ? error.message : String(error)}`,
  );
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
 * table — any singles duel, or a group duel whose endpoints include
 * EVERY undecided member (zero alive — browse — is vacuously covered;
 * kept endpoints alone never make a duel "whole" while an undecided
 * member watches from outside). There the "N is better" tap raises the
 * keep-both/cull dialog. Its "don't ask again" sticks with WHICHEVER
 * outcome it rides on — auto-cull or auto-keep-both (Tristan's
 * grilling), resettable from Settings: "Keep both" marks
 * BOTH photos kept, "Cull" stages the loser and leaves the winner
 * untouched — atomically either way, with the winner's star + duel row
 * in the group case. A duel with 3+ alive is TRIAGE: star + history,
 * no verdict — repeated burst duels pick best/worst, they do not keep.
 * Eligibility is undecided-or-KEPT (F11), so a duel can re-decide a
 * prior keep; "Cull N" always just stages the visible photo.
 *
 * m0.8.3: the whole-table claim is judged over the RENDERED reachable
 * table — the deck's load-time mounted snapshot rides into the write
 * (PersistDecisionExtras.mounted, store-revalidated) — so a hidden
 * unreachable member neither vetoes nor joins a verdict; its own
 * question waits for remount.
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
    celebrationTick,
    registerCelebrationHost,
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
  // 'missing' = the group is genuinely gone (stale id, dissolved pair) —
  // the missing-pair effect navigates back. 'failed' = the READ failed and
  // PROVES NOTHING: it renders the inline retry card (DeckScreen's failure
  // surface) instead of bouncing back over a transient SQLite error.
  const [loadedGroup, setLoadedGroup] = useState<ReviewGroupRow | 'loading' | 'missing' | 'failed'>(
    'loading',
  );
  // Bumped by the failure card's Retry — re-runs whichever load failed.
  const [loadTick, setLoadTick] = useState(0);
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
        console.warn('[compare] group load failed:', String(error));
        if (!cancelled) setLoadedGroup('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [numericGroupId, queueGroup, loadGroup, loadTick]);
  const group = queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
  /** An off-page group fetch is still in flight — a missing pair is not
   * terminal yet. */
  const groupPending = numericGroupId !== null && !queueGroup && loadedGroup === 'loading';
  // A day/run-scoped singles deck (m0.8.2) hands us photos that can sit
  // outside the queue's newest-first singles page, so the two ids would
  // not resolve from `singleRows` alone — fetch the SAME scope the deck
  // showed (day, optionally run-range narrowed) so the position labels
  // number over the same rows.
  const [dayRows, setDayRows] = useState<ReviewMemberRow[] | 'failed' | null>(null);
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    void loadDeckSingles(day, from !== undefined && to !== undefined ? { from, to } : null).then(
      (rows: ReviewMemberRow[]) => {
        if (!cancelled) setDayRows(rows);
      },
      (error: unknown) => {
        // An unreadable scope is NOT an empty one (DeckScreen's rule):
        // 'failed' renders the inline retry card and keeps the pair
        // unresolved, instead of leaving the screen actionable over
        // whatever other feed happens to hold the ids.
        console.warn('[compare] day singles load failed:', String(error));
        if (!cancelled) setDayRows('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [day, from, to, loadDeckSingles, loadTick]);
  /** The day fetch is still in flight — a missing pair is not terminal
   * yet (same rule as groupPending). */
  const dayPending = !!day && dayRows === null;
  /** The day's rows once landed; null while loading or failed. */
  const dayList = Array.isArray(dayRows) ? dayRows : null;
  const itemLookup = useMemo(() => {
    const map = new Map<string, { id: string; timestamp: number; uri: string }>();
    if (day) {
      // A day-scoped pair resolves from its OWN feed ONLY (codex r51):
      // the bounded global singles page can hold the ids by coincidence,
      // which used to keep a failed day fetch actionable over the WRONG
      // population — '?' position labels.
      for (const m of dayList ?? [])
        map.set(m.asset_id, { id: m.asset_id, timestamp: m.taken_at, uri: m.uri });
      return map;
    }
    if (numericGroupId !== null) {
      // A GROUP pair resolves from the requested group ONLY (codex r5):
      // after a dissolve its former members can reappear as singles in
      // other feeds, and resolving them there kept the screen actionable
      // with a stale group id — group writes then failed their
      // assignment guard while the action chips mutated borrowed photos.
      const source = queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
      for (const m of source?.members ?? [])
        map.set(m.asset_id, { id: m.asset_id, timestamp: m.taken_at, uri: m.uri });
      return map;
    }
    for (const m of singleRows)
      map.set(m.asset_id, { id: m.asset_id, timestamp: m.taken_at, uri: m.uri });
    return map;
  }, [singleRows, day, dayList, numericGroupId, queueGroup, loadedGroup]);
  const [busy, setBusy] = useState(false);
  const [showB, setShowB] = useState(false);
  const [duelPref, setDuelPref] = useState<CompareDuelPref>('ask');
  const [cullOffer, setCullOffer] = useState<{ winnerId: string; loserId: string } | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSetting(db, COMPARE_AUTO_CULL_KEY).then((raw) => {
      if (!cancelled) setDuelPref(parseCompareDuelPref(raw));
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
        // A singles deck numbers photos over its own day/run rows ONLY —
        // every singles caller passes `day` (DeckScreen). The global
        // feed is a bounded newest-first page that may not even contain
        // them (codex r50); a FAILED day fetch never reaches here — it
        // renders the retry card instead of numbering over a different
        // population (codex r51).
        const index = (dayList ?? []).findIndex((m) => m.asset_id === id);
        return index >= 0 ? String(index + 1) : '?';
      }
      if (!groupInfo) return '?';
      const member = groupInfo.memberIds.indexOf(id);
      return member >= 0 ? String(member + 1) : '?';
    },
    [dayList, groupInfo, singles],
  );
  // --- synchronized zoom state (shared by both stacked images) ----------
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);
  // A pinch must prove itself before it may change the zoom (see
  // lib/zoomTarget PINCH_ENGAGE_DELTA): these carry that decision, and
  // the raw scale it was made at, across the gesture's frames.
  const pinchLive = useSharedValue(false);
  const pinchBase = useSharedValue(1);

  const flip = useCallback(() => setShowB((v) => !v), []);

  // Taps live on the JS responder path (the stage is a Pressable), NOT
  // on a tap gesture (`useTapGesture`): any runOnJS from a gesture
  // worklet segfaults this build (SIGSEGV in AroundLock::utf8;
  // reanimated #9776, worklets 0.10.2 — see DeckScreen's bridge
  // comment). Flip needs setState, so
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

  const pinchGesture = usePinchGesture({
    onUpdate: (event) => {
      if (!pinchLive.value) {
        if (!pinchEngaged(event.scale)) return;
        pinchLive.value = true;
        pinchBase.value = event.scale;
      }
      const gain = pinchGain(event.scale, pinchBase.value);
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * gain));
      // Keep the pan inside bounds while zooming back out.
      const maxX = (stageW.value * (scale.value - 1)) / 2;
      const maxY = (stageH.value * (scale.value - 1)) / 2;
      tx.value = clamp(tx.value, maxX);
      ty.value = clamp(ty.value, maxY);
    },
    // onFinalize also fires when a pinch is CANCELLED, which onDeactivate
    // does not — the engagement flag has to clear either way.
    onFinalize: () => {
      pinchLive.value = false;
    },
    onDeactivate: () => {
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
    },
  });

  const panGesture = usePanGesture({
    minPointers: 1,
    maxPointers: 2,
    averageTouches: true,
    onUpdate: (event) => {
      if (scale.value <= 1) return;
      const maxX = (stageW.value * (scale.value - 1)) / 2;
      const maxY = (stageH.value * (scale.value - 1)) / 2;
      tx.value = clamp(savedTx.value + event.translationX, maxX);
      ty.value = clamp(savedTy.value + event.translationY, maxY);
    },
    onDeactivate: () => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    },
  });

  const composedGesture = useSimultaneousGestures(pinchGesture, panGesture);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  /** A READ failure on either load. It routes NOWHERE: the retry card
   * below renders instead of the missing-pair fallback, because a failed
   * read proves nothing about the pair — only 'missing'/absent rows do. */
  const groupFailed = numericGroupId !== null && !queueGroup && loadedGroup === 'failed';
  const dayFailed = dayRows === 'failed';
  const loadFailed = groupFailed || dayFailed;

  // A photo can vanish mid-compare only via external state weirdness —
  // fall back to the deck rather than rendering a dead screen. An
  // off-page group still loading is NOT terminal (gate 5), and neither
  // is a FAILED read (the retry card owns that state).
  useEffect(() => {
    if (!pair && !groupPending && !dayPending && !loadFailed) navigation.goBack();
  }, [pair, groupPending, dayPending, loadFailed, navigation]);

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
  // Claim the right to DRAW the moment while focused (m0.8.5, A4). A
  // crossing with no host registered anywhere says so with a toast
  // rather than arming an overlay nothing will claim.
  useEffect(() => {
    if (!isFocused) return;
    return registerCelebrationHost();
  }, [isFocused, registerCelebrationHost]);

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
      try {
        await compareKeepBoth(
          winnerId,
          loserId,
          singles ? undefined : (numericGroupId ?? undefined),
        );
      } catch {
        return; // surfaced by the provider alert; stay on the screen
      }
      showToast(
        singles
          ? `Kept photos ${posOf(winnerId)} and ${posOf(loserId)}`
          : `Both kept — photo ${posOf(winnerId)} starred best of group`,
      );
      navigation.goBack();
    },
    [compareKeepBoth, singles, numericGroupId, posOf, navigation],
  );

  /** Dialog/auto-cull outcome "Cull": stage the loser; the winner stays
   * untouched (a cull judgment says nothing about keeping — F15). Only
   * reachable through `decideBetter`'s whole-table gate, which is what
   * licenses the group leg's duel-carrying `compareCull` — its store
   * guard asserts the duel covers every alive member. The direct chip
   * writes through `decideCull` instead. */
  const cullLoserNow = useCallback(
    async (winnerId: string, loserId: string) => {
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
      navigation.goBack();
    },
    [singles, decide, numericGroupId, compareCull, posOf, navigation],
  );

  const decideBetter = useCallback(
    async (winnerId: string, loserId: string) => {
      if (busy) return;
      // The dialog appears exactly when the duel IS the whole table
      // (F15): any singles duel, or a group whose undecided remainder
      // this duel settles. "Settles" means every ALIVE member is one of
      // the two endpoints — kept members can rejoin a duel via F11, so
      // `aliveCount <= 2` alone is not enough: a kept-vs-kept (or
      // kept-vs-one-of-two-alive) duel leaves undecided members and
      // must stay verdict-free triage. Zero alive (browse) is vacuously
      // covered and keeps its dialog. The store re-validates this in
      // the write transaction against a racing scan.
      const wholeTable =
        singles || (groupInfo?.aliveIds ?? []).every((id) => id === winnerId || id === loserId);
      if (!wholeTable) {
        setBusy(true);
        try {
          await recordTriage(winnerId, loserId);
        } finally {
          setBusy(false);
        }
        return;
      }
      // The suppressed dialog honours WHICHEVER outcome it was
      // suppressed with (Tristan's grilling): auto-cull or
      // auto-keep-both.
      if (duelPref === 'cull') {
        setBusy(true);
        try {
          await cullLoserNow(winnerId, loserId);
        } finally {
          setBusy(false);
        }
      } else if (duelPref === 'keep_both') {
        setBusy(true);
        try {
          await keepBothNow(winnerId, loserId);
        } finally {
          setBusy(false);
        }
      } else {
        setDontAskAgain(false);
        setCullOffer({ winnerId, loserId });
      }
    },
    [groupInfo, duelPref, busy, cullLoserNow, keepBothNow, recordTriage, singles],
  );

  const resolveCullOffer = useCallback(
    async (cull: boolean) => {
      const offer = cullOffer;
      if (!offer || busy) return;
      setCullOffer(null);
      setBusy(true);
      try {
        // "Don't ask again" sticks with WHICHEVER outcome it rides on
        // (Tristan's grilling): cull → auto-cull, keep both →
        // auto-keep-both. The VERDICT never waits on the preference
        // write (codex r8): a rejected pref must not swallow the choice
        // the user just confirmed — the dialog simply asks again next
        // time, said out loud.
        if (dontAskAgain) {
          const pref: CompareDuelPref = cull ? 'cull' : 'keep_both';
          setDuelPref(pref);
          void setSetting(db, COMPARE_AUTO_CULL_KEY, serializeCompareDuelPref(pref)).catch(
            (error: unknown) => {
              console.warn('[compare] duel preference not saved:', String(error));
              setDuelPref('ask');
              showToast('Preference not saved — the dialog will ask again');
            },
          );
        }
        if (cull) await cullLoserNow(offer.winnerId, offer.loserId);
        else await keepBothNow(offer.winnerId, offer.loserId);
      } finally {
        setBusy(false);
      }
    },
    [cullOffer, busy, dontAskAgain, db, cullLoserNow, keepBothNow],
  );

  /** The DIRECT "Cull N" chip: a plain verdict write, NO duel and NO
   * star — the screen doc's "'Cull N' always just stages the visible
   * photo" taken literally. The duel-carrying `compareCull` claims its
   * verdicts cover every alive member (the store re-validates that in
   * the transaction), which is only true on the dialog/auto-cull path
   * `decideBetter` guards; routed through here, a 3+-alive group made
   * the always-visible chip throw "group changed" spuriously. The
   * expectedGroupId is the deck's own narrow assignment guard, not the
   * whole-table one. */
  const decideCull = useCallback(
    async (loserId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        try {
          await decide(loserId, 'cull', singles ? null : (numericGroupId ?? undefined));
        } catch {
          return; // surfaced by the provider alert; stay on the screen
        }
        showToast(`Photo ${posOf(loserId)} staged to cull`);
        navigation.goBack();
      } finally {
        setBusy(false);
      }
    },
    [busy, decide, singles, numericGroupId, posOf, navigation],
  );

  // A failed unit read renders the inline retry INSTEAD of the empty
  // root below (DeckScreen's failure surface): the failure state routes
  // nowhere, so the pair stays open until the read succeeds or the user
  // leaves. Genuinely-missing pairs keep the go-back effect above.
  if (loadFailed) {
    return (
      <View style={[styles.root, styles.loadFailedRoot]}>
        <Text style={styles.loadFailedText}>Could not load these photos just now.</Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            if (dayFailed) setDayRows(null);
            if (groupFailed) setLoadedGroup('loading');
            setLoadTick((t) => t + 1);
          }}
        >
          <Text style={[styles.retryText, { color: theme.accent }]}>Retry</Text>
        </Pressable>
      </View>
    );
  }

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

      {/* A VIRTUAL detector under an intercepting host (see DeckScreen):
          v3's plain GestureDetector is a HOST component, and this stage's
          child is a Pressable whose press IS the flip — the tap must keep
          reaching the JS responder path underneath. */}
      <InterceptingGestureDetector>
        <VirtualGestureDetector gesture={composedGesture}>
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
        </VirtualGestureDetector>
      </InterceptingGestureDetector>

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
        <ActionChip
          kind="favourite"
          active={favourite}
          disabled={busy}
          onPress={() => void toggleFavourite(visible.id).catch(() => {})}
        />
        {/* Organize/Share write the queue tables DIRECTLY (no provider
            write-error surface behind them, unlike Edit/Favourite above),
            so THIS screen must surface both failure shapes — a returned
            validation error and a rejected write — in the deck's copy; a
            swallowed one reads as a tap that did nothing. The badge
            refresh sits outside the guard: by then the write landed, so
            "nothing was changed" would be a lie — the next refresh
            reconciles the chip. */}
        <ActionChip
          kind="organize"
          active={queuedFor(visible.id).organize}
          disabled={busy}
          onPress={() =>
            void (async () => {
              try {
                if (queuedFor(visible.id).organize)
                  await unqueueOrganize(db, visible.id, Date.now());
                else {
                  const error = await queueOrganize(db, visible.id, Date.now());
                  if (error) {
                    Alert.alert('Cannot organize this photo', error);
                    return;
                  }
                }
              } catch (error) {
                surfaceQueueWriteError(error);
                return;
              }
              await refreshQueuedFor().catch(() => {});
            })()
          }
        />
        <ActionChip
          kind="share"
          active={queuedFor(visible.id).share}
          disabled={busy}
          onPress={() =>
            void (async () => {
              try {
                if (queuedFor(visible.id).share)
                  await removeFromShareQueue(db, visible.id, Date.now());
                else await addToShareQueue(db, visible.id, Date.now());
              } catch (error) {
                surfaceQueueWriteError(error);
                return;
              }
              await refreshQueuedFor().catch(() => {});
            })()
          }
        />
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, styles.cullButton]}
          disabled={busy}
          onPress={() => void decideCull(visible.id)}
        >
          <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
          <Text style={styles.actionText}>Cull {visibleLabel}</Text>
        </Pressable>
        <Pressable
          // ACCENT, not keep-green (rule 2, Tristan's grilling): "better"
          // is a selection whose outcome varies — triage, the dialog, or
          // an auto-cull under the suppressed preference — so a verdict
          // hue here claims a keep it may not write. The dialog's own
          // buttons carry the verdict colours.
          style={[
            styles.actionButton,
            { backgroundColor: theme.accentMuted, borderColor: theme.accent, borderWidth: 1 },
          ]}
          disabled={busy}
          onPress={() => void decideBetter(visible.id, hidden.id)}
        >
          <MaterialCommunityIcons
            name={singles ? 'check' : 'star'}
            size={21}
            color={theme.accent}
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
                Don't ask again — "better" always does what I pick now
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
  // Inline failure card (DeckScreen's quiet retry language).
  loadFailedRoot: { alignItems: 'center', justifyContent: 'center' },
  loadFailedText: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  retryText: { fontSize: 15, fontWeight: '700' },
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
