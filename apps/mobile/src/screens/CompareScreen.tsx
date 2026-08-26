import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import {
  InterceptingGestureDetector,
  State,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  VirtualGestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { getSetting, setSetting, type ReviewGroupRow, type ReviewMemberRow } from '../db/store';
import {
  COMPARE_AFTER_CULL_KEY,
  COMPARE_AFTER_KEEP_KEY,
  parseCompareAfterCull,
  parseCompareAfterKeep,
  serializeComparePref,
  type CompareAfterCull,
  type CompareAfterKeep,
} from '../lib/comparePrefs';
import { showToast } from '../lib/toast';
import {
  DOUBLE_TAP_MS,
  FLICK_MIN_VELOCITY,
  ZOOM_TRACKING_START,
  zoomTouchFrame,
} from '../lib/zoomTarget';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected } from '../lib/favouriteState';
import { ActionChip } from '../components/ActionChip';
import { useRegionZoom } from '../components/useRegionZoom';
import { MAX_SCALE_FLOOR, maxScaleFor } from '../lib/regionZoom';
import { addToShareQueue, removeFromShareQueue } from '../db/shareStore';
import { queueOrganize, unqueueOrganize } from '../db/organizeStore';
import { useIsFocused } from '@react-navigation/native';

type Props = NativeStackScreenProps<RootStackParamList, 'Compare'>;

// The max zoom is DYNAMIC per photo (m0.8.8, Tristan): enough to reach
// 1:1 physical pixels plus inspection headroom, between MAX_SCALE_FLOOR
// and MAX_SCALE_CEILING — a fixed 16 stopped BEFORE 1:1 on a 200MP
// photo, while deep fixed maxima on a 12MP photo are pure mush. `maxScaleFor` in
// lib/regionZoom.ts owns the formula; Compare takes the MAX of its two
// photos' ceilings (you zoom for the detailed one). panBounds clamps to the photo's
// own edges, so a deep zoom cannot wander off the content.

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
 * VERDICTS (m0.8.8, F29/G10, D8): both buttons WRITE, immediately and
 * unconditionally — "Keep {N}" (keep-green, a targeted keep plus the
 * duel row in groups) and "Cull {N}" (cull-red, a plain cull, no duel:
 * a cull judgment says nothing about "better"). After either write, ONE
 * binary prompt about the other photo — "Cull the other photo?" after a
 * keep, "Keep the other photo?" after a cull — firing only while the
 * other photo is still unreviewed (never offers to overwrite settled
 * work; keep-both is two taps and a decline). Declining leaves the
 * other photo open (triage semantics) and closes the screen like every
 * resolved write. The prompt's "Remember this answer" checkbox stores
 * WHICHEVER button was pressed, per direction (lib/comparePrefs.ts);
 * Settings' reset row clears both memories.
 * Eligibility is undecided-or-KEPT (F11), so a duel can re-decide a
 * prior keep.
 *
 * The m0.8.2 whole-table machinery ("N is better", the accent branch,
 * the keep-both/cull dialog, the store's whole-table revalidation) is
 * DELETED — every outcome now maps onto the narrow targeted writes, so
 * a verdict button can always wear its verdict's colour (STATE_MODEL
 * rule 2). Duel rows record the keep direction (kept_both NULL); the
 * dialog-outcome values true/false are a closed era the stats read
 * historically.
 */
export function CompareScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { groupId, aId, bId, singles = false, day, from, to } = route.params;
  const {
    groups,
    singles: singleRows,
    compareKeepWinner,
    needsEdit,
    toggleNeedsEdit,
    decide,
    favouriteStatus,
    toggleFavourite,
    queuedFor,
    refreshQueuedFor,
    loadGroup,
    loadDeckSingles,
    registerCelebrationHost,
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
  /** Each candidate photo, WITH its verdict: the action chips gate on a
   * staged cull (m0.8.5, F13) and must read the state from the same
   * population the pair itself resolves from — a second lookup with its
   * own source rules is how the two would drift. */
  const itemLookup = useMemo(() => {
    const map = new Map<
      string,
      { id: string; timestamp: number; uri: string; state: ReviewMemberRow['state'] }
    >();
    if (day) {
      // A day-scoped pair resolves from its OWN feed ONLY (codex r51):
      // the bounded global singles page can hold the ids by coincidence,
      // which used to keep a failed day fetch actionable over the WRONG
      // population — '?' position labels.
      for (const m of dayList ?? [])
        map.set(m.asset_id, {
          id: m.asset_id,
          timestamp: m.taken_at,
          uri: m.uri,
          state: m.state,
        });
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
        map.set(m.asset_id, {
          id: m.asset_id,
          timestamp: m.taken_at,
          uri: m.uri,
          state: m.state,
        });
      return map;
    }
    for (const m of singleRows)
      map.set(m.asset_id, {
        id: m.asset_id,
        timestamp: m.taken_at,
        uri: m.uri,
        state: m.state,
      });
    return map;
  }, [singleRows, day, dayList, numericGroupId, queueGroup, loadedGroup]);
  const [busy, setBusy] = useState(false);
  const [showB, setShowB] = useState(false);
  const [afterKeep, setAfterKeep] = useState<CompareAfterKeep>('ask');
  const [afterCull, setAfterCull] = useState<CompareAfterCull>('ask');
  /** The pending binary prompt about the OTHER photo (D8): raised after
   * an immediate Keep/Cull write when the other photo is unreviewed and
   * its direction's preference says ask. */
  const [prompt, setPrompt] = useState<{
    kind: 'cullOther' | 'keepOther';
    decidedId: string;
    otherId: string;
  } | null>(null);
  const [rememberAnswer, setRememberAnswer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSetting(db, COMPARE_AFTER_KEEP_KEY).then((raw) => {
      if (!cancelled) setAfterKeep(parseCompareAfterKeep(raw));
    });
    void getSetting(db, COMPARE_AFTER_CULL_KEY).then((raw) => {
      if (!cancelled) setAfterCull(parseCompareAfterCull(raw));
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
  /** Dynamic zoom ceiling: the MAX of the two photos' maxScaleFor —
   * flicker comparison zooms for the more detailed side. */
  const maxScale = useSharedValue<number>(MAX_SCALE_FLOOR);
  const stageH = useSharedValue(0);
  // ONE tracker for the whole pinch-pan (zoomTouchFrame, m0.8.8 —
  // DeckScreen carries the rationale). Compare has no pager, so the PAN
  // handler below is the single driver for scale AND translation.
  const zoomTracking = useSharedValue(ZOOM_TRACKING_START);

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
    // The pinch DETECTOR keeps the two-finger arbitration; the zoom
    // itself is driven from the PAN handler's raw touch frames below
    // (zoomTouchFrame — ONE tracker, DeckScreen carries the rationale).
    onBegin: () => {
      cancelAnimation(scale);
      cancelAnimation(tx);
      cancelAnimation(ty);
    },
    // onFinalize also fires when a pinch is CANCELLED, which onDeactivate
    // does not — the anchor has to clear either way. The ZOOMED marker
    // survives (codex round 1): the simultaneous pan outlives the pinch
    // (it deactivates on the LAST finger, the pinch finalizes earlier),
    // and its no-fling-after-zoom check reads this flag — a full reset
    // here let a scale-changing stream end as a flick. The pan's own
    // onBegin starts the next stream's tracking fresh.
    onFinalize: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
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
    // Only the release VELOCITY still reads the averaged pointer (the
    // decay below); the translation itself is touch-position anchored
    // (onTouchesMove).
    averageTouches: true,
    onBegin: () => {
      // A finger landing mid-decay claims the photo wherever the decay
      // carried it (DeckScreen carries the same rule).
      // The decay itself must STOP here (codex device-pass round):
      // left running it keeps moving the photo under the finger, and
      // the first pan update then snaps back to this snapshot.
      cancelAnimation(tx);
      cancelAnimation(ty);
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      // A fresh touch stream: a fresh anchor, and whether it turns into
      // a pinch is decided by the frames ahead of it (tracking.zoomed).
      zoomTracking.value = ZOOM_TRACKING_START;
    },
    // The whole pinch-pan runs off the raw touch frames (zoomTouchFrame
    // — m0.8.6 §10's touch-position anchoring, unified with the pinch
    // in m0.8.8): a touch-set change re-anchors (down/up force it; the
    // count check catches a same-count swap between move frames), so
    // everything stays continuous across finger changes.
    onTouchesDown: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesUp: () => {
      zoomTracking.value = { ...ZOOM_TRACKING_START, zoomed: zoomTracking.value.zoomed };
    },
    onTouchesMove: (event) => {
      const step = zoomTouchFrame(
        zoomTracking.value,
        event.allTouches,
        // Two fingers drive unconditionally — the initial pinch from
        // scale 1 included (Compare has no pager to protect); a single
        // finger needs the zoom AND activation, so a flip-tap's jitter
        // cannot nudge the photo.
        event.allTouches.length >= 2 || (scale.value > 1 && event.state === State.ACTIVE),
        scale.value,
        tx.value,
        ty.value,
        1,
        maxScale.value,
        stageW.value / 2,
        stageH.value / 2,
      );
      zoomTracking.value = step.tracking;
      if (step.transform === null) return;
      scale.value = step.transform.scale;
      // Compare clamps to the stage rectangle (its stacked pair shares
      // one transform; per-photo edges are not meaningful here).
      const maxX = (stageW.value * (step.transform.scale - 1)) / 2;
      const maxY = (stageH.value * (step.transform.scale - 1)) / 2;
      tx.value = clamp(step.transform.x, maxX);
      ty.value = clamp(step.transform.y, maxY);
    },
    onDeactivate: (event) => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
      if (scale.value <= 1) return;
      // A stream that ZOOMED ends as a pinch, not a flick — momentum
      // out of it flung the photo on every two-finger zoom (round 5).
      if (zoomTracking.value.zoomed) return;
      // The release keeps the flick's momentum — the standard gallery
      // feel (m0.8.5 §10 check 9 round 3), inside the same bounds the
      // drag was clamped to. Sub-flick velocities are lift-off noise
      // (FLICK_MIN_VELOCITY): a hold-then-lift moves nothing.
      const maxX = (stageW.value * (scale.value - 1)) / 2;
      const maxY = (stageH.value * (scale.value - 1)) / 2;
      if (Math.abs(event.velocityX) >= FLICK_MIN_VELOCITY) {
        tx.value = withDecay({ velocity: event.velocityX, clamp: [-maxX, maxX] }, () => {
          savedTx.value = tx.value;
        });
      }
      if (Math.abs(event.velocityY) >= FLICK_MIN_VELOCITY) {
        ty.value = withDecay({ velocity: event.velocityY, clamp: [-maxY, maxY] }, () => {
          savedTy.value = ty.value;
        });
      }
    },
  });

  const composedGesture = useSimultaneousGestures(pinchGesture, panGesture);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // F22 (m0.8.8): the region-zoom pipeline for BOTH stacked photos —
  // flicker comparison is the point, so both stay warm (D2's guardrail
  // and the shared retention budget exist for exactly this pair). Each
  // hook plans against its own source dimensions under the one shared
  // transform; the hooks poll shared values from JS (never runOnJS).
  const regionStageSize = useCallback(
    () => ({ width: stageW.value, height: stageH.value }),
    [stageW, stageH],
  );
  const regionViewport = useCallback(
    () => ({ scale: scale.value, tx: tx.value, ty: ty.value }),
    [scale, tx, ty],
  );
  const regionZoomA = useRegionZoom(
    pair?.a.id ?? null,
    pair?.a.uri ?? null,
    pair !== null,
    regionStageSize,
    regionViewport,
  );
  const regionZoomB = useRegionZoom(
    pair?.b.id ?? null,
    pair?.b.uri ?? null,
    pair !== null,
    regionStageSize,
    regionViewport,
  );
  useEffect(() => {
    const forSize = (size: { width: number; height: number } | null) =>
      size
        ? maxScaleFor(stageW.value, stageH.value, size.width, size.height, PixelRatio.get())
        : MAX_SCALE_FLOOR;
    maxScale.value = Math.max(forSize(regionZoomA.sourceSize), forSize(regionZoomB.sourceSize));
  }, [regionZoomA.sourceSize, regionZoomB.sourceSize, maxScale, stageW, stageH]);

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

  /**
   * The goal moment: Compare HOSTS it but never draws it (m0.8.5, A2,
   * codex r1).
   *
   * Every decision path here ends in `goBack()`, so a moment claimed on
   * this screen would be torn down within a frame or two — F4's defect
   * in miniature. The deck this screen returns to draws it instead, and
   * the consume-once ref survives the transition.
   *
   * Registering still matters: it is what stops a crossing decided in a
   * duel from degrading to the no-host toast while a perfectly good deck
   * sits mounted underneath. Registration is MOUNT-scoped, not
   * focus-scoped, for the same reason — the deck below is unfocused
   * while this screen is up, and a moment armed here must still find a
   * host.
   */
  useEffect(() => registerCelebrationHost(), [registerCelebrationHost]);

  /** The other photo's LIVE state — the follow-up prompt fires only
   * while it is still unreviewed (G10: never offer to overwrite
   * settled work). */
  const otherPending = useCallback(
    (id: string) => (itemLookup.get(id)?.state ?? 'unreviewed') === 'unreviewed',
    [itemLookup],
  );

  /** Write the other photo's KEEP (the accepted "Keep the other?" and
   * the remembered-keep path): a targeted keep plus the duel row in
   * groups (the duel records the keep direction), a plain keep in
   * singles (singles record no duel rows — unchanged contract). */
  const keepOtherNow = useCallback(
    async (keepId: string, againstId: string) => {
      if (singles) await decide(keepId, 'keep', null);
      else if (numericGroupId !== null) await compareKeepWinner(numericGroupId, keepId, againstId);
      showToast(`Photo ${posOf(keepId)} kept`);
    },
    [singles, decide, numericGroupId, compareKeepWinner, posOf],
  );

  /** "Keep {N}" — writes IMMEDIATELY (F29/G10): a targeted keep plus
   * the duel row in groups (kept_both NULL — the duel answers "which
   * did you keep out of this pair", nothing more), a plain keep in
   * singles. Then the after-keep step: prompt, remembered answer, or
   * nothing (other photo already settled). */
  const keepVisible = useCallback(
    async (keepId: string, otherId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        try {
          if (singles) await decide(keepId, 'keep', null);
          else if (numericGroupId !== null)
            await compareKeepWinner(numericGroupId, keepId, otherId);
          else return;
        } catch {
          return; // surfaced by the provider alert; stay on the screen
        }
        // Truthful surfaces: only groups record a duel row (singles
        // duels never have) — the toast must not claim otherwise.
        showToast(
          singles
            ? `Photo ${posOf(keepId)} kept`
            : `Photo ${posOf(keepId)} kept — compare recorded`,
        );
        if (!otherPending(otherId)) {
          navigation.goBack();
          return;
        }
        if (afterKeep === 'cull') {
          try {
            await decide(otherId, 'cull', singles ? null : (numericGroupId ?? undefined));
            showToast(`Photo ${posOf(otherId)} staged to cull`);
          } catch {
            return; // the keep landed; the remembered cull did not — stay
          }
          navigation.goBack();
          return;
        }
        if (afterKeep === 'leave') {
          navigation.goBack();
          return;
        }
        setRememberAnswer(false);
        setPrompt({ kind: 'cullOther', decidedId: keepId, otherId });
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      singles,
      decide,
      numericGroupId,
      compareKeepWinner,
      posOf,
      otherPending,
      afterKeep,
      navigation,
    ],
  );

  /** "Cull {N}" — writes IMMEDIATELY (F29/G10): a plain cull, no duel
   * row (a cull judgment says nothing about "better" — the m0.8.2 chip
   * contract, kept). Then the after-cull step, mirroring keepVisible. */
  const cullVisible = useCallback(
    async (cullId: string, otherId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        try {
          await decide(cullId, 'cull', singles ? null : (numericGroupId ?? undefined));
        } catch {
          return; // surfaced by the provider alert; stay on the screen
        }
        showToast(`Photo ${posOf(cullId)} staged to cull`);
        if (!otherPending(otherId)) {
          navigation.goBack();
          return;
        }
        if (afterCull === 'keep') {
          try {
            await keepOtherNow(otherId, cullId);
          } catch {
            return; // the cull landed; the remembered keep did not — stay
          }
          navigation.goBack();
          return;
        }
        if (afterCull === 'leave') {
          navigation.goBack();
          return;
        }
        setRememberAnswer(false);
        setPrompt({ kind: 'keepOther', decidedId: cullId, otherId });
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      singles,
      decide,
      numericGroupId,
      posOf,
      otherPending,
      afterCull,
      keepOtherNow,
      navigation,
    ],
  );

  /** Resolve the binary prompt (D8). `apply` = the verdict button was
   * pressed; false = "Leave open". "Remember this answer" stores
   * WHICHEVER button resolved it, per direction — a remembered "Leave
   * open" silences the prompt, a remembered verdict auto-applies it.
   * The verdict never waits on the preference write (codex r8, kept): a
   * rejected pref must not swallow the choice the user just confirmed —
   * the prompt simply asks again next time, said out loud. */
  const resolvePrompt = useCallback(
    async (apply: boolean) => {
      const active = prompt;
      if (!active || busy) return;
      setPrompt(null);
      setBusy(true);
      try {
        if (rememberAnswer) {
          if (active.kind === 'cullOther') {
            const pref: CompareAfterKeep = apply ? 'cull' : 'leave';
            setAfterKeep(pref);
            void setSetting(db, COMPARE_AFTER_KEEP_KEY, serializeComparePref(pref)).catch(
              (error: unknown) => {
                console.warn('[compare] prompt preference not saved:', String(error));
                setAfterKeep('ask');
                showToast('Preference not saved — the prompt will ask again');
              },
            );
          } else {
            const pref: CompareAfterCull = apply ? 'keep' : 'leave';
            setAfterCull(pref);
            void setSetting(db, COMPARE_AFTER_CULL_KEY, serializeComparePref(pref)).catch(
              (error: unknown) => {
                console.warn('[compare] prompt preference not saved:', String(error));
                setAfterCull('ask');
                showToast('Preference not saved — the prompt will ask again');
              },
            );
          }
        }
        if (apply) {
          try {
            if (active.kind === 'cullOther') {
              await decide(active.otherId, 'cull', singles ? null : (numericGroupId ?? undefined));
              showToast(`Photo ${posOf(active.otherId)} staged to cull`);
            } else {
              await keepOtherNow(active.otherId, active.decidedId);
            }
          } catch {
            return; // the first verdict already landed; stay for a retry
          }
        }
        navigation.goBack();
      } finally {
        setBusy(false);
      }
    },
    [
      prompt,
      busy,
      rememberAnswer,
      db,
      decide,
      singles,
      numericGroupId,
      posOf,
      keepOtherNow,
      navigation,
    ],
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
  /**
   * A staged cull's actions are SUSPENDED (docs/STATE_MODEL.md rule 6):
   * they demote to carried and leave every queue, so offering the chips
   * would let you queue work on a photo that is on its way out.
   *
   * The deck has always gated on this; Compare gated on `busy` alone
   * (F13). The two surfaces draw the same chips and must answer the same
   * way — the more so since m0.8.5 changed the deck's navigation, and a
   * divergence hidden by today's routing is a defect waiting for the
   * next routing change.
   */
  const visibleCulled = itemLookup.get(visible.id)?.state === 'culled';
  const actionsDisabled = busy || visibleCulled;
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
      {/* Decorative border on the OUTER frame, never the measured stage
          (DeckScreen's stageFrame comment): a border insets absoluteFill
          children while onLayout reports the border box, and that 2 dp
          disagreement magnifies into a visible content jump on every
          patch apply at deep zoom. */}
      <View style={styles.stageFrame}>
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
                {/* Per-photo layer groups (F22): each photo, its dwell-
                  warmed base, and its settled patch flip together under
                  the shared transform — both sides stay warm so the
                  flicker comparison is sharp in both directions. */}
                <View style={StyleSheet.absoluteFill}>
                  <Image
                    source={{ uri: pair.a.uri }}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    recyclingKey={pair.a.id}
                  />
                  {/* ALWAYS MOUNTED, props-only (useRegionZoom header:
                    a mid-gesture mount breaks RNGH pointer tracking). */}
                  <Image
                    source={regionZoomA.baseSource ?? undefined}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    transition={0}
                    allowDownscaling={false}
                  />
                  {regionZoomA.patchSlots.map((slot, slotIndex) => (
                    <Image
                      key={slotIndex}
                      source={slot?.source ?? undefined}
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: slot?.width ?? 1,
                        height: slot?.height ?? 1,
                        // Transform, not left/top: layout snaps to the pixel
                        // grid, and a deep-zoom scale magnified that snap into
                        // a visible content jump on every apply (S10e video 6).
                        transform: [
                          { translateX: slot?.left ?? 0 },
                          { translateY: slot?.top ?? 0 },
                        ],
                        zIndex: slot?.z ?? 0,
                        opacity: slot ? 1 : 0,
                      }}
                      contentFit="fill"
                      transition={0}
                      allowDownscaling={false}
                    />
                  ))}
                </View>
                {/* Stacked on top; opacity flip keeps both mounted so the zoom
                transform (on the shared parent) applies to both at once. */}
                <View style={[StyleSheet.absoluteFill, { opacity: showB ? 1 : 0 }]}>
                  <Image
                    source={{ uri: pair.b.uri }}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    recyclingKey={pair.b.id}
                  />
                  {/* ALWAYS MOUNTED, props-only (useRegionZoom header:
                    a mid-gesture mount breaks RNGH pointer tracking). */}
                  <Image
                    source={regionZoomB.baseSource ?? undefined}
                    style={StyleSheet.absoluteFill}
                    contentFit="contain"
                    transition={0}
                    allowDownscaling={false}
                  />
                  {regionZoomB.patchSlots.map((slot, slotIndex) => (
                    <Image
                      key={slotIndex}
                      source={slot?.source ?? undefined}
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: slot?.width ?? 1,
                        height: slot?.height ?? 1,
                        // Transform, not left/top: layout snaps to the pixel
                        // grid, and a deep-zoom scale magnified that snap into
                        // a visible content jump on every apply (S10e video 6).
                        transform: [
                          { translateX: slot?.left ?? 0 },
                          { translateY: slot?.top ?? 0 },
                        ],
                        zIndex: slot?.z ?? 0,
                        opacity: slot ? 1 : 0,
                      }}
                      contentFit="fill"
                      transition={0}
                      allowDownscaling={false}
                    />
                  ))}
                </View>
              </Animated.View>
              <View style={styles.abBadge} pointerEvents="none">
                <Text style={styles.abBadgeText}>
                  {visibleLabel} · {formatClockPrecise(visible.timestamp, withMs)}
                </Text>
              </View>
              {/* Zoom fail-soft notice (DeckScreen's zoomNotice comment).
                  Compare has no zoom-only overlay, so it shows whenever
                  the VISIBLE photo's pipeline rejected — reviewed with
                  the m0.9 metadata-corner redesign. */}
              {(showB ? regionZoomB : regionZoomA).failed && (
                <View style={styles.zoomNotice} pointerEvents="none">
                  <Text style={styles.zoomNoticeText}>
                    Full detail unavailable — image file can't be fully read
                  </Text>
                </View>
              )}
            </Pressable>
          </VirtualGestureDetector>
        </InterceptingGestureDetector>
      </View>

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
          disabled={actionsDisabled}
          dimmed={visibleCulled}
          onPress={() => void toggleNeedsEdit(visible.id).catch(() => {})}
        />
        <ActionChip
          kind="favourite"
          active={favourite}
          disabled={actionsDisabled}
          dimmed={visibleCulled}
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
          disabled={actionsDisabled}
          dimmed={visibleCulled}
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
          disabled={actionsDisabled}
          dimmed={visibleCulled}
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
          onPress={() => void cullVisible(visible.id, hidden.id)}
        >
          <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
          <Text style={styles.actionText}>Cull {visibleLabel}</Text>
        </Pressable>
        <Pressable
          // Both buttons WRITE (F29/G10), so both wear their verdict's
          // colour (STATE_MODEL rule 2) — the accent "is better" branch
          // is gone.
          style={[styles.actionButton, styles.keepButton]}
          disabled={busy}
          onPress={() => void keepVisible(visible.id, hidden.id)}
        >
          <MaterialCommunityIcons name="check" size={21} color={colors.keep} />
          <Text style={styles.actionText}>Keep {visibleLabel}</Text>
        </Pressable>
      </View>
      <Pressable style={styles.closeButton} disabled={busy} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>Close — no verdict</Text>
      </Pressable>

      {/* The binary follow-up prompt about the OTHER photo (F29/G10,
          D8): fires only while it is still unreviewed; both answers
          resolve the compare. A system-back dismissal counts as "Leave
          open" — the first verdict already landed, so the prompt must
          never strand the screen mid-flow. */}
      <Modal
        visible={prompt !== null}
        transparent
        animationType="fade"
        onRequestClose={() => void resolvePrompt(false)}
      >
        <View style={styles.offerBackdrop}>
          <View style={styles.offerCard}>
            <Text style={styles.offerTitle}>
              {prompt?.kind === 'cullOther' ? 'Cull the other photo?' : 'Keep the other photo?'}
            </Text>
            <Text style={styles.offerText}>
              {prompt?.kind === 'cullOther'
                ? `Photo ${prompt ? posOf(prompt.otherId) : ''} is still unreviewed. Culling stages it — deleted only after you confirm the cull list.`
                : `Photo ${prompt ? posOf(prompt.otherId) : ''} is still unreviewed. Leaving it open keeps it in the review queue.`}
            </Text>
            <Pressable
              style={styles.offerCheckRow}
              hitSlop={6}
              onPress={() => setRememberAnswer((v) => !v)}
            >
              <View
                style={[
                  styles.offerCheckbox,
                  rememberAnswer && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                {rememberAnswer && (
                  <MaterialCommunityIcons name="check" size={15} color={theme.onAccent} />
                )}
              </View>
              <Text style={styles.offerCheckLabel}>Remember this answer</Text>
            </Pressable>
            <View style={styles.offerButtons}>
              <Pressable style={styles.offerButton} onPress={() => void resolvePrompt(false)}>
                <Text style={styles.offerButtonText}>Leave open</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.offerButton,
                  prompt?.kind === 'cullOther' ? styles.offerCullButton : styles.offerKeepButton,
                ]}
                onPress={() => void resolvePrompt(true)}
              >
                <Text style={styles.offerButtonText}>
                  {prompt?.kind === 'cullOther'
                    ? `Cull ${prompt ? posOf(prompt.otherId) : ''}`
                    : `Keep ${prompt ? posOf(prompt.otherId) : ''}`}
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
  /** Border here, NOT on the stage (DeckScreen's stageFrame comment). */
  stageFrame: {
    flex: 1,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  stage: { flex: 1 },
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
  /** The zoom fail-soft notice (DeckScreen's zoomNotice). */
  zoomNotice: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  zoomNoticeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
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
  keepButton: { backgroundColor: colors.keepDim },
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
    // "Leave open" writes nothing, so it wears the neutral surface
    // (STATE_MODEL rule 3); the verdict answer overrides with its hue.
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  offerKeepButton: { backgroundColor: colors.keepDim },
  offerCullButton: { backgroundColor: colors.cullDim },
  offerButtonText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
