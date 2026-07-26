import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useIsFocused } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useReview, type RedecideTarget } from '../review/ReviewContext';
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';
import { completedDuringVisit, destinationAfterGroup } from '../lib/groupFlow';
import { DecisionBadge, DECISION_GLYPHS, type DecisionKind } from '../components/DecisionBadge';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { isFavouriteSelected, shouldOfferFavouriteHandoff } from '../lib/favouriteState';
import { PhotoViewer } from '../components/PhotoViewer';
import { useSQLiteContext } from 'expo-sqlite';
import { addToShareQueue, isInShareQueue, removeFromShareQueue } from '../db/shareStore';
import { newAlbumPath, queueOrganize } from '../db/organizeStore';
import { listImageAlbums, type VolumeAlbum } from '../../modules/media-store-actions';
import { PRIMARY_VOLUME } from '../lib/mediaIdentity';

type DeckProps = NativeStackScreenProps<RootStackParamList, 'Deck'>;
type SinglesProps = NativeStackScreenProps<RootStackParamList, 'Singles'>;
type SharedProps = {
  navigation: NativeStackNavigationProp<RootStackParamList>;
  explicitGroupId?: string;
  singlesMode: boolean;
};

const THUMB = 52;
const MAX_SCALE = 8;

function clampPan(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

/**
 * Swipe-deck group review (m0.4, replacing the duel bracket): the group is
 * a horizontally swipeable stack of its alive photos. Cull any photo as
 * you meet it (brief Undo affordance), star one as best, flag needs-edit,
 * eject a mis-grouped photo to the singles flow, or open the Compare tool.
 *
 * m0.5:
 * - `route.params.groupId` opens a SPECIFIC group (Groups screen, any
 *   order). Without it the screen drives the linear flow as before.
 * - A COMPLETED group opens in browse mode: page through every remaining
 *   member (kept and staged alike) and re-decide any of them via the
 *   keep / to-edit / cull chips — decisions stay reversible until the
 *   final cull confirmation.
 * - Pinch-zoom on the deck card: a two-finger pinch freezes the pager
 *   and zooms the current photo in an overlay (one-finger pan while
 *   zoomed); zooming back out restores paging. Gesture arbitration:
 *   pinch needs two pointers so one-finger swipes always reach the
 *   pager; while zoomed the pager's scroll is disabled outright.
 * - "Compare with…": the Compare button opens a thumbnail picker of the
 *   group's other alive members (straight into Compare when only two
 *   are alive). Long-pressing a strip thumbnail stays as the shortcut.
 */
export function DeckScreen({ navigation, route }: DeckProps) {
  return (
    <ReviewDeck
      navigation={navigation}
      explicitGroupId={route.params?.groupId}
      singlesMode={false}
    />
  );
}

export function SinglesDeckScreen({ navigation }: SinglesProps) {
  return <ReviewDeck navigation={navigation as DeckProps['navigation']} singlesMode />;
}

function ReviewDeck({ navigation, explicitGroupId, singlesMode }: SharedProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isFocused = useIsFocused();
  const {
    groups,
    singles,
    decide,
    clearDecision,
    keepRest,
    markBest,
    makeSingle,
    needsEdit,
    toggleNeedsEdit,
    favouriteStatus,
    toggleFavourite,
    keepAllSingles,
    version,
    loadGroup,
    refresh,
  } = useReview();
  const [busy, setBusy] = useState(false);
  const [pageW, setPageW] = useState(0);
  const [comparePicker, setComparePicker] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const listRef = useRef<FlatList<MediaItem>>(null);

  // m0.5: an explicit group (Groups screen tap) pins the deck to it; the
  // linear flow keeps following the first group in the queue (all queue
  // groups have unreviewed members, so the first is the next unfinished).
  const groupId = useMemo(
    () =>
      singlesMode ? null : (explicitGroupId ?? (groups[0] ? String(groups[0].groupId) : null)),
    [explicitGroupId, groups, singlesMode],
  );
  const queueGroup: ReviewGroupRow | null = useMemo(
    () => (groupId ? (groups.find((g) => String(g.groupId) === groupId) ?? null) : null),
    [groups, groupId],
  );
  // Gate 5: an explicitly opened group ABSENT from the queue is fetched
  // directly — completed groups reopen in browse/re-decide mode instead
  // of bouncing back. 'missing' = the group is genuinely gone (a pair
  // dissolved by ejection, or a stale id) — the advance effect handles it.
  const [loadedGroup, setLoadedGroup] = useState<ReviewGroupRow | 'loading' | 'missing'>('loading');
  useEffect(() => {
    let cancelled = false;
    if (singlesMode || !explicitGroupId || queueGroup) {
      setLoadedGroup('loading');
      return;
    }
    void loadGroup(Number(explicitGroupId)).then((fetched) => {
      if (!cancelled) setLoadedGroup(fetched ?? 'missing');
    });
    return () => {
      cancelled = true;
    };
  }, [explicitGroupId, queueGroup, loadGroup, singlesMode, version]);
  const group: ReviewGroupRow | null =
    queueGroup ?? (typeof loadedGroup === 'object' ? loadedGroup : null);
  // Derived deck info (the old core groupInfo shape, DB-backed): a group
  // absent from the queue but explicitly opened is COMPLETE (browse mode)
  // — the queue only lists groups with unreviewed members.
  const stateOf = useMemo(() => {
    const map = new Map<string, ReviewMemberRow['state']>();
    if (group) for (const m of group.members) map.set(m.asset_id, m.state);
    for (const m of singles) map.set(m.asset_id, m.state);
    return map;
  }, [group, singles]);
  const timeAttachedOf = useMemo(() => {
    const set = new Set<string>();
    if (group) for (const m of group.members) if (m.time_attached === 1) set.add(m.asset_id);
    for (const m of singles) if (m.time_attached === 1) set.add(m.asset_id);
    return set;
  }, [group, singles]);
  const info = useMemo(() => {
    if (!group) return null;
    const aliveIds = group.members.filter((m) => m.state === 'unreviewed').map((m) => m.asset_id);
    return {
      memberIds: group.members.map((m) => m.asset_id),
      aliveIds,
      complete: aliveIds.length === 0,
      bestId: group.bestPhotoId,
      cursor: 0,
    };
  }, [group]);
  const browse = info?.complete ?? false;
  // `index` remembers the visited group's position so a DISSOLVED pair
  // (no longer in `groups`) can still advance from its former spot.
  const completionRef = useRef<{ groupId: string | null; complete: boolean | null; index: number }>(
    {
      groupId: explicitGroupId ?? null,
      complete: explicitGroupId ? (info?.complete ?? null) : null,
      index: explicitGroupId ? groups.findIndex((g) => String(g.groupId) === explicitGroupId) : -1,
    },
  );

  const toItem = (m: ReviewMemberRow): MediaItem => ({
    id: m.asset_id,
    timestamp: m.taken_at,
    uri: m.uri,
    kind: 'photo',
  });
  const aliveItems: MediaItem[] = useMemo(
    () => (group ? group.members.filter((m) => m.state === 'unreviewed').map(toItem) : []),
    [group],
  );
  // Gate 5: culled photos STAY in the live deck badged with their verdict
  // (reversible until the final confirmation) — kept photos still leave.
  const liveItems: MediaItem[] = useMemo(
    () =>
      group
        ? group.members.filter((m) => m.state === 'unreviewed' || m.state === 'culled').map(toItem)
        : [],
    [group],
  );
  // Browse mode pages every re-decidable member (done, to_edit AND staged
  // culls — everything before the final confirmation).
  const browseItems: MediaItem[] = useMemo(() => {
    if (!group || !browse) return [];
    return group.members
      .filter((m) => m.state === 'done' || m.state === 'to_edit' || m.state === 'culled')
      .map(toItem);
  }, [group, browse]);
  // The singles feed: unreviewed + staged culls badged (gate 5).
  const singlesItems: MediaItem[] = useMemo(
    () => (singlesMode ? singles.map(toItem) : []),
    [singles, singlesMode],
  );
  const deckItems = singlesMode ? singlesItems : browse ? browseItems : liveItems;

  // The deck cursor is screen-local everywhere (m0.8: derived model — the
  // DB has no cursor; a decision shrinks the alive deck and the cursor
  // clamps to the next photo).
  const [browseCursor, setBrowseCursor] = useState(0);
  const cursor = Math.min(browseCursor, Math.max(0, deckItems.length - 1));
  const current: MediaItem | null = deckItems[cursor] ?? null;
  const groupIndex = useMemo(
    () => (groupId ? groups.findIndex((g) => String(g.groupId) === groupId) : -1),
    [groups, groupId],
  );

  // Millisecond precision only where adjacent deck photos share a second
  // AND the timestamps carry sub-second data (m0.4).
  const needMs = useMemo(() => millisNeeded(deckItems.map((i) => i.timestamp)), [deckItems]);

  // ------------------------------------------------- pinch zoom (m0.5)
  // Two-pointer pinch zooms the current photo in an overlay; the pager
  // freezes while zoomed and resumes once the zoom springs back to 1.
  const [zoomed, setZoomed] = useState(false);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(0);
  const stageH = useSharedValue(0);
  const pagerGesture = useMemo(() => Gesture.Native(), []);

  const resetZoom = useCallback(() => {
    scale.value = 1;
    savedScale.value = 1;
    tx.value = 0;
    ty.value = 0;
    savedTx.value = 0;
    savedTy.value = 0;
    setZoomed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .simultaneousWithExternalGesture(pagerGesture)
      .onBegin(() => {
        runOnJS(setZoomed)(true);
      })
      .onUpdate((event) => {
        scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * event.scale));
        const maxX = (stageW.value * (scale.value - 1)) / 2;
        const maxY = (stageH.value * (scale.value - 1)) / 2;
        tx.value = clampPan(tx.value, maxX);
        ty.value = clampPan(ty.value, maxY);
      })
      .onEnd(() => {
        savedScale.value = scale.value;
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      })
      // onFinalize (unlike onEnd) also fires on cancellation, so a broken
      // gesture can never leave the pager frozen at scale 1.
      .onFinalize(() => {
        if (scale.value <= 1.02) {
          scale.value = withTiming(1);
          savedScale.value = 1;
          tx.value = withTiming(0);
          ty.value = withTiming(0);
          savedTx.value = 0;
          savedTy.value = 0;
          runOnJS(setZoomed)(false);
        }
      });
    const pan = Gesture.Pan()
      .enabled(zoomed)
      .minPointers(1)
      .maxPointers(2)
      .averageTouches(true)
      .onUpdate((event) => {
        if (scale.value <= 1) return;
        const maxX = (stageW.value * (scale.value - 1)) / 2;
        const maxY = (stageH.value * (scale.value - 1)) / 2;
        tx.value = clampPan(savedTx.value + event.translationX, maxX);
        ty.value = clampPan(savedTy.value + event.translationY, maxY);
      })
      .onEnd(() => {
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      });
    // m0.7 (#18): double-tap resets zoom while zoomed.
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .enabled(zoomed)
      .onEnd(() => {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
        runOnJS(setZoomed)(false);
      });
    const tap = Gesture.Tap()
      .numberOfTaps(1)
      .maxDuration(250)
      .onEnd((_event, success) => {
        if (success) runOnJS(fireStageTap)();
      });
    return Gesture.Simultaneous(pinch, pan, doubleTap, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagerGesture, zoomed]);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // Browse mode: a single tap on the stage opens the standard full-screen
  // viewer (gate 5). Ref-dispatched so the gesture memo stays stable.
  const stageTapRef = useRef<() => void>(() => {});
  stageTapRef.current = () => {
    if (!zoomed && browse && !singlesMode) setViewerOpen(true);
  };
  const fireStageTap = useCallback(() => stageTapRef.current(), []);

  useEffect(() => {
    setComparePicker(false);
    setViewerOpen(false);
  }, [groupId, browse, singlesMode]);
  useEffect(() => {
    setBrowseCursor(0);
  }, [groupId]);
  // The zoom overlay shows the CURRENT photo — leave zoom when it changes.
  const currentId = current?.id ?? null;
  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // Linear flow follows the first incomplete group, then singles and the
  // cull list. Explicitly opening an ALREADY completed group still permits
  // browse/re-decide mode.
  const hasSingles = singles.length > 0;
  useEffect(() => {
    if (singlesMode) return;
    if (explicitGroupId) {
      if (!group && loadedGroup === 'missing') {
        // A pair DISSOLVES during this visit when "Not related" ejects
        // one member (C#6) — that is a completion: advance to the next
        // group/Singles like any other finish. Only a genuinely stale id
        // (resumed navigation — never observed live) goes back.
        // Same guard as the normal completion effect: don't navigate
        // while the ejection's persist is in flight or another screen is
        // on top — the next focused, idle render performs the advance.
        if (busy || !isFocused) return;
        if (
          completionRef.current.groupId === explicitGroupId &&
          completionRef.current.complete !== null
        ) {
          const destination = destinationAfterGroup(
            groups.map((g) => ({ id: String(g.groupId), complete: false })),
            explicitGroupId,
            hasSingles,
            completionRef.current.index,
          );
          if (destination.screen === 'Deck') {
            navigation.replace('Deck', { groupId: destination.groupId });
          } else {
            navigation.replace(destination.screen);
          }
        } else {
          navigation.goBack(); // stale group id — nothing to show
        }
      }
      return;
    }
    if (groupId) return;
    if (hasSingles) navigation.replace('Singles');
    else navigation.replace('CullList');
  }, [
    groupId,
    explicitGroupId,
    group,
    loadedGroup,
    groups,
    hasSingles,
    navigation,
    singlesMode,
    busy,
    isFocused,
  ]);

  const singlesPending = singlesMode ? singles.filter((m) => m.state === 'unreviewed').length : 0;

  // m0.7 (#20): only advance out of Singles when completion happened
  // DURING this visit. A fully-reviewed singles pseudo-group opened from
  // the Groups screen is a deliberate revisit and stays in browse mode —
  // exactly like reopening a completed group.
  const singlesEnteredCompleteRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!singlesMode) {
      singlesEnteredCompleteRef.current = null;
      return;
    }
    if (singlesEnteredCompleteRef.current === null) {
      singlesEnteredCompleteRef.current = singlesPending === 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singlesMode]);
  useEffect(() => {
    if (!singlesMode || singlesPending > 0 || busy || !isFocused) return;
    if (singlesEnteredCompleteRef.current === true) return; // deliberate revisit
    if (groups.length > 0) navigation.goBack();
    else navigation.replace('CullList');
  }, [busy, isFocused, navigation, groups, singlesMode, singlesPending]);

  // A group that becomes complete during this visit advances immediately.
  // This covers Keep rest, culling/ejecting the final member, and completion
  // while returning from Compare. A group that was complete when opened is a
  // deliberate revisit and stays in browse mode.
  useEffect(() => {
    if (!explicitGroupId || !info) return;
    const previous = completionRef.current;
    if (previous.groupId !== explicitGroupId) {
      completionRef.current = {
        groupId: explicitGroupId,
        complete: info.complete,
        index: groupIndex,
      };
      return;
    }
    // Do not consume the transition while its write is still in flight, or
    // while Compare/another screen is on top. The next focused, idle render
    // performs the advance.
    if (!isFocused || busy) return;
    const justCompleted = completedDuringVisit(previous, explicitGroupId, info.complete, isFocused);
    completionRef.current = {
      groupId: explicitGroupId,
      complete: info.complete,
      index: groupIndex,
    };
    if (!justCompleted) return;

    const destination = destinationAfterGroup(
      groups.map((g) => ({ id: String(g.groupId), complete: false })),
      explicitGroupId,
      hasSingles,
    );
    if (destination.screen === 'Deck') {
      navigation.replace('Deck', { groupId: destination.groupId });
    } else {
      navigation.replace(destination.screen);
    }
  }, [busy, explicitGroupId, groupIndex, groups, hasSingles, info, isFocused, navigation]);

  // Keep the pager aligned with the cursor whenever the deck's membership
  // changes (cull/undo/make-single/re-decide) or a new group starts.
  // Swiping itself never triggers this (the key ignores the cursor).
  const deckKey = `${singlesMode ? 'singles' : (groupId ?? '')}:${browse ? 'b' : 'r'}:${deckItems.map((i) => i.id).join(',')}`;
  useEffect(() => {
    if (!pageW || deckItems.length === 0) return;
    listRef.current?.scrollToOffset({ offset: cursor * pageW, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pageW]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!pageW) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / pageW);
      if (index !== cursor) setBrowseCursor(index);
    },
    [pageW, cursor],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (!pageW) return;
      setBrowseCursor(index);
      listRef.current?.scrollToOffset({ offset: index * pageW, animated: true });
    },
    [pageW],
  );

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // Gate 5: the culled photo stays in the deck badged (tap Cull again to
  // un-cull) — advance the pager past it; membership does not change, so
  // the deckKey effect won't move the cursor for us.
  const cullCurrent = useCallback(() => {
    if (!current) return;
    const id = current.id;
    const index = cursor;
    void run(async () => {
      await decide(id, 'cull');
      if (index + 1 < deckItems.length) jumpTo(index + 1);
    });
  }, [current, cursor, deckItems.length, jumpTo, run, decide]);

  const isBest = !!current && !singlesMode && info?.bestId === current.id;

  // m0.7 item E queue row: Share toggle + Organize picker.
  const db = useSQLiteContext();
  // null = the queued-state query for the CURRENT photo hasn't resolved —
  // the toggle stays disabled so a quick tap can't act on the previous
  // photo's stale value. shareStateForRef names the photo the state
  // describes, so async completions for a photo the user has moved past
  // never overwrite the new photo's state.
  const [shareQueued, setShareQueued] = useState<boolean | null>(null);
  const shareStateForRef = useRef<string | null>(null);
  /** Photo id the organize picker was opened for (null = closed) — bound
   * at press so an album chosen after a swipe still targets that photo. */
  const [organizePickerFor, setOrganizePickerFor] = useState<string | null>(null);
  const [albums, setAlbums] = useState<VolumeAlbum[]>([]);
  const [newAlbumName, setNewAlbumName] = useState('');
  useEffect(() => {
    let cancelled = false;
    shareStateForRef.current = currentId ?? null;
    setShareQueued(null);
    if (currentId) {
      void isInShareQueue(db, currentId).then((queued) => {
        if (!cancelled) setShareQueued(queued);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [db, currentId, version]);

  const toggleShare = useCallback(async () => {
    if (!current || shareQueued === null) return;
    const id = current.id;
    const wasQueued = shareQueued;
    // Pending (null) for the mutation too — a second tap before the write
    // lands must not act on the stale value.
    setShareQueued(null);
    try {
      if (wasQueued) {
        await removeFromShareQueue(db, id, Date.now());
        if (shareStateForRef.current === id) setShareQueued(false);
      } else {
        const added = await addToShareQueue(db, id, Date.now());
        if (shareStateForRef.current === id) setShareQueued(added);
      }
    } catch {
      if (shareStateForRef.current === id) setShareQueued(wasQueued);
    }
  }, [db, current, shareQueued]);

  const openOrganizePicker = useCallback(async () => {
    const id = current?.id;
    if (!id) return;
    const catalog = await listImageAlbums();
    setAlbums(
      catalog
        .filter((a) => a.volumeName === PRIMARY_VOLUME)
        .sort((a, b) => b.photoCount - a.photoCount),
    );
    setNewAlbumName('');
    setOrganizePickerFor(id);
  }, [current]);

  const chooseOrganizeTarget = useCallback(
    async (relativePath: string) => {
      if (!organizePickerFor) return;
      const error = await queueOrganize(
        db,
        organizePickerFor,
        { volumeName: PRIMARY_VOLUME, relativePath },
        Date.now(),
      );
      if (error) Alert.alert('Cannot use that album', error);
      setOrganizePickerFor(null);
    },
    [db, organizePickerFor],
  );

  const finishGroup = useCallback(() => {
    if (!group) return;
    void run(() => keepRest(group.groupId));
  }, [group, run, keepRest]);

  const toggleBest = useCallback(() => {
    if (!group || !current) return;
    void run(async () => {
      await markBest(group.groupId, isBest ? null : current.id);
      // m0.7 item F (#10): the hand-off is WRITE-ONLY — never offered for
      // an already-favourited photo (toggleFavourite would UN-favourite
      // it), and "Not now" stays a strict no-op.
      const offer = shouldOfferFavouriteHandoff(favouriteStatus(current.id));
      if (!isBest && offer && Platform.OS === 'android' && Number(Platform.Version) >= 30) {
        Alert.alert('Best of this group', 'Would you also like to favourite it in your gallery?', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Favourite', onPress: () => void toggleFavourite(current.id) },
        ]);
      }
    });
  }, [current, favouriteStatus, group, isBest, markBest, run, toggleFavourite]);

  const openCompare = useCallback(
    (againstId?: string) => {
      // Compare works on undecided photos only — the feed's staged culls
      // re-decide via the chips instead.
      const candidates = singlesMode
        ? deckItems.filter((i) => (stateOf.get(i.id) ?? 'unreviewed') === 'unreviewed')
        : aliveItems;
      if ((!singlesMode && !groupId) || !current || candidates.length < 2) return;
      if (againstId === undefined && candidates.length > 2) {
        // m0.5: explicit opponent choice for larger groups.
        setComparePicker(true);
        return;
      }
      const other = againstId ?? candidates.find((i) => i.id !== current.id)?.id;
      if (!other || other === current.id) return;
      setComparePicker(false);
      navigation.navigate('Compare', {
        ...(groupId ? { groupId } : {}),
        singles: singlesMode,
        aId: current.id,
        bId: other,
      });
    },
    [aliveItems, current, deckItems, groupId, navigation, singlesMode, stateOf],
  );

  const renderPage = useCallback(
    ({ item }: { item: MediaItem }) => (
      <View style={{ width: pageW, height: '100%' }}>
        <Image
          source={{ uri: item.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          recyclingKey={item.id}
          transition={40}
        />
      </View>
    ),
    [pageW],
  );

  if (!current || (!singlesMode && (!groupId || !info))) {
    return <View style={styles.root} />;
  }

  const flagged = needsEdit(current.id);
  const favourite = isFavouriteSelected(favouriteStatus(current.id));
  const keepCount = deckItems.length;
  const currentState = stateOf.get(current.id) ?? 'unreviewed';
  const browseState: RedecideTarget =
    currentState === 'culled' ? 'cull' : flagged ? 'to_edit' : 'keep';
  const currentDecision: DecisionKind | null =
    currentState === 'culled'
      ? 'cull'
      : currentState === 'done' || currentState === 'to_edit'
        ? flagged
          ? 'edit'
          : 'keep'
        : null;

  // Re-decide: tapping the ACTIVE verdict clears back to unreviewed.
  const redecide = async (id: string, target: RedecideTarget) => {
    const state = stateOf.get(id) ?? 'unreviewed';
    const activeTarget: RedecideTarget | null =
      state === 'culled'
        ? 'cull'
        : state === 'to_edit'
          ? 'to_edit'
          : state === 'done'
            ? 'keep'
            : null;
    if (activeTarget === target) await clearDecision(id);
    else await decide(id, target);
  };

  const decideSingleCurrent = async (target: RedecideTarget) => {
    // Keep/to-edit remove the photo from the feed (same-index advance);
    // a fresh cull keeps it badged in place (gate 5) — advance past it.
    const index = cursor;
    const wasCulled = (stateOf.get(current.id) ?? 'unreviewed') === 'culled';
    await redecide(current.id, target);
    if (target === 'cull' && !wasCulled && index + 1 < deckItems.length) jumpTo(index + 1);
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {singlesMode
            ? `Singles · ${keepCount - singlesPending} of ${keepCount} reviewed`
            : browse
              ? `Group · ${keepCount} reviewed`
              : `Group ${groupIndex + 1} of ${groups.length} · ${aliveItems.length} of ${keepCount} to review`}
        </Text>
        <Text style={styles.headerHint}>
          {singlesMode
            ? 'Scroll freely · use the same decisions, compare and zoom as groups.'
            : browse
              ? 'Reviewed group — change any decision until the final delete confirmation.'
              : 'Swipe through the group · culled shots stay badged until you confirm · Keep rest finishes.'}
        </Text>
      </View>

      <GestureDetector gesture={zoomGesture}>
        <View
          style={styles.stage}
          onLayout={(event) => {
            setPageW(event.nativeEvent.layout.width);
            stageW.value = event.nativeEvent.layout.width;
            stageH.value = event.nativeEvent.layout.height;
          }}
        >
          {pageW > 0 && (
            <GestureDetector gesture={pagerGesture}>
              <View style={styles.pager}>
                <FlatList
                  ref={listRef}
                  data={deckItems}
                  keyExtractor={(i) => i.id}
                  renderItem={renderPage}
                  horizontal
                  pagingEnabled
                  scrollEnabled={!zoomed}
                  showsHorizontalScrollIndicator={false}
                  initialScrollIndex={Math.min(cursor, deckItems.length - 1)}
                  getItemLayout={(_data, index) => ({
                    length: pageW,
                    offset: pageW * index,
                    index,
                  })}
                  onMomentumScrollEnd={onMomentumEnd}
                />
              </View>
            </GestureDetector>
          )}
          {zoomed && (
            <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]} pointerEvents="none">
              <Image
                source={{ uri: current.uri }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                recyclingKey={`zoom-${current.id}`}
              />
            </Animated.View>
          )}
          <View style={styles.posBadge} pointerEvents="none">
            <Text style={styles.posBadgeText}>
              {cursor + 1}/{keepCount}
            </Text>
          </View>
          <View style={styles.timeBadge} pointerEvents="none">
            <Text style={styles.timeBadgeText}>
              {formatClockPrecise(current.timestamp, needMs[cursor] ?? false)}
            </Text>
          </View>
          {(isBest || favourite || currentDecision || timeAttachedOf.has(current.id)) && (
            <View style={styles.flagBadge} pointerEvents="none">
              {currentDecision && <DecisionBadge kind={currentDecision} size={24} />}
              {isBest && <DecisionBadge kind="best" size={24} accent={theme.accent} />}
              {favourite && <DecisionBadge kind="fav" size={24} />}
              {timeAttachedOf.has(current.id) && <DecisionBadge kind="time" size={24} />}
            </View>
          )}
        </View>
      </GestureDetector>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.thumbStrip}
        contentContainerStyle={styles.thumbStripContent}
      >
        {deckItems.map((item, index) => {
          const itemState = stateOf.get(item.id) ?? 'unreviewed';
          const itemDecision: DecisionKind | null =
            itemState === 'culled'
              ? 'cull'
              : itemState === 'done' || itemState === 'to_edit'
                ? needsEdit(item.id)
                  ? 'edit'
                  : 'keep'
                : null;
          return (
            <Pressable
              key={item.id}
              onPress={() => jumpTo(index)}
              onLongPress={() => {
                if ((singlesMode || !browse) && item.id !== current.id) openCompare(item.id);
              }}
            >
              <Image
                source={{ uri: item.uri }}
                style={[
                  styles.thumb,
                  index === cursor && styles.thumbActive,
                  item.id === info?.bestId && { borderColor: theme.accent },
                ]}
                contentFit="cover"
                recyclingKey={item.id}
              />
              {itemDecision && <DecisionBadge kind={itemDecision} style={styles.thumbDecision} />}
              {item.id === info?.bestId && (
                <DecisionBadge kind="best" accent={theme.accent} style={styles.thumbBest} />
              )}
              {isFavouriteSelected(favouriteStatus(item.id)) && (
                <DecisionBadge kind="fav" style={styles.thumbFavourite} />
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {singlesMode || browse ? (
        <>
          <View style={styles.actionRow}>
            {(
              [
                {
                  target: 'keep',
                  label: 'Keep',
                  kind: 'keep',
                  dim: colors.keepDim,
                  color: colors.keep,
                },
                {
                  target: 'cull',
                  label: 'Cull',
                  kind: 'cull',
                  dim: colors.cullDim,
                  color: colors.cull,
                },
              ] as const
            ).map(({ target, label, kind, dim, color }) => {
              const active = currentState !== 'unreviewed' && browseState === target;
              return (
                <Pressable
                  key={target}
                  style={[
                    styles.actionButton,
                    { backgroundColor: dim },
                    active && { borderWidth: 2, borderColor: color },
                  ]}
                  disabled={busy}
                  onPress={() =>
                    void run(() =>
                      singlesMode ? decideSingleCurrent(target) : redecide(current.id, target),
                    )
                  }
                >
                  <MaterialCommunityIcons name={DECISION_GLYPHS[kind]} size={20} color={color} />
                  <Text style={styles.actionText}>{label}</Text>
                </Pressable>
              );
            })}
            {singlesMode && (
              // Completed-group BROWSE deliberately has no Compare (the
              // strip long-press already excludes it): its members are
              // decided, and the Compare verdicts (cull the loser, star
              // the best) reject decided/non-alive photos — re-deciding
              // happens through the chips above instead.
              <Pressable
                style={[styles.actionButton, styles.compareButton]}
                disabled={busy || deckItems.length < 2}
                onPress={() => openCompare()}
              >
                <MaterialCommunityIcons
                  name="compare-horizontal"
                  size={20}
                  color={colors.textDim}
                />
                <Text
                  style={[styles.actionText, deckItems.length < 2 && styles.actionTextDisabled]}
                >
                  Compare
                </Text>
              </Pressable>
            )}
          </View>
          <View style={styles.secondaryRow}>
            <Pressable
              style={[styles.secondaryButton, flagged && styles.secondaryButtonEdit]}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  singlesMode ? decideSingleCurrent('to_edit') : redecide(current.id, 'to_edit'),
                )
              }
            >
              <MaterialCommunityIcons
                name="pencil"
                size={18}
                color={flagged ? colors.edit : colors.textDim}
              />
              <Text style={[styles.secondaryText, flagged && styles.secondaryTextEdit]}>Edit</Text>
            </Pressable>
            {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
              <Pressable
                style={[styles.secondaryButton, favourite && styles.secondaryButtonFavourite]}
                disabled={busy}
                onPress={() => void run(() => toggleFavourite(current.id))}
              >
                <MaterialCommunityIcons
                  name={favourite ? 'heart' : 'heart-outline'}
                  size={18}
                  color={favourite ? colors.fav : colors.textDim}
                />
                <Text style={[styles.secondaryText, favourite && styles.secondaryTextFavourite]}>
                  Favourite
                </Text>
              </Pressable>
            )}
            <Pressable
              style={styles.secondaryButton}
              disabled={busy}
              onPress={() => void openOrganizePicker()}
            >
              <MaterialCommunityIcons name="folder-move-outline" size={18} color={colors.textDim} />
              <Text style={styles.secondaryText}>Organize</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, !!shareQueued && styles.secondaryButtonEdit]}
              disabled={busy || shareQueued === null}
              onPress={() => void toggleShare()}
            >
              <MaterialCommunityIcons
                name={shareQueued ? 'share-variant' : 'share-variant-outline'}
                size={18}
                color={shareQueued ? colors.edit : colors.textDim}
              />
              <Text style={[styles.secondaryText, shareQueued && styles.secondaryTextEdit]}>
                Share
              </Text>
            </Pressable>
            {!singlesMode && groupId && (
              <Pressable
                style={[
                  styles.secondaryButton,
                  isBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
                ]}
                // A staged cull in browse mode is not ALIVE — core
                // rejects it as best; re-decide it as kept first.
                disabled={busy || (browse && !!current && !info?.aliveIds.includes(current.id))}
                onPress={toggleBest}
              >
                <MaterialCommunityIcons
                  name={isBest ? 'star' : 'star-outline'}
                  size={18}
                  color={isBest ? theme.accent : colors.textDim}
                />
                <Text style={[styles.secondaryText, isBest && { color: theme.accent }]}>Best</Text>
              </Pressable>
            )}
          </View>
          {singlesMode && singlesPending > 0 && (
            <BigButton
              label={busy ? 'Saving…' : `Keep remaining (${singlesPending})`}
              color={colors.keep}
              disabled={busy}
              onPress={() => void run(keepAllSingles)}
            />
          )}
        </>
      ) : (
        <>
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.actionButton, { backgroundColor: colors.keepDim }]}
              disabled={busy}
              onPress={() => void run(() => decide(current.id, 'keep'))}
            >
              <MaterialCommunityIcons name={DECISION_GLYPHS.keep} size={21} color={colors.keep} />
              <Text style={styles.actionText}>Keep</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.compareButton]}
              disabled={busy || aliveItems.length < 2}
              onPress={() => openCompare()}
            >
              <MaterialCommunityIcons name="compare-horizontal" size={21} color={colors.textDim} />
              <Text style={[styles.actionText, aliveItems.length < 2 && styles.actionTextDisabled]}>
                Compare{aliveItems.length > 2 ? ' with…' : ''}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionButton,
                styles.cullButton,
                currentState === 'culled' && { borderWidth: 2, borderColor: colors.cull },
              ]}
              disabled={busy}
              onPress={() =>
                currentState === 'culled'
                  ? void run(() => clearDecision(current.id))
                  : cullCurrent()
              }
            >
              <MaterialCommunityIcons name="close" size={21} color={colors.cull} />
              <Text style={styles.actionText}>Cull</Text>
            </Pressable>
          </View>

          <View style={styles.secondaryRow}>
            <Pressable
              style={[styles.secondaryButton, flagged && styles.secondaryButtonEdit]}
              disabled={busy}
              onPress={() => void toggleNeedsEdit(current.id)}
            >
              <MaterialCommunityIcons
                name="pencil"
                size={18}
                color={flagged ? colors.edit : colors.textDim}
              />
              <Text style={[styles.secondaryText, flagged && styles.secondaryTextEdit]}>Edit</Text>
            </Pressable>
            {Platform.OS === 'android' && Number(Platform.Version) >= 30 && (
              <Pressable
                style={[styles.secondaryButton, favourite && styles.secondaryButtonFavourite]}
                disabled={busy}
                onPress={() => void run(() => toggleFavourite(current.id))}
              >
                <MaterialCommunityIcons
                  name={favourite ? 'heart' : 'heart-outline'}
                  size={18}
                  color={favourite ? colors.fav : colors.textDim}
                />
                <Text style={[styles.secondaryText, favourite && styles.secondaryTextFavourite]}>
                  Favourite
                </Text>
              </Pressable>
            )}
            <Pressable
              style={styles.secondaryButton}
              disabled={busy}
              onPress={() => void openOrganizePicker()}
            >
              <MaterialCommunityIcons name="folder-move-outline" size={18} color={colors.textDim} />
              <Text style={styles.secondaryText}>Organize</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, !!shareQueued && styles.secondaryButtonEdit]}
              disabled={busy || shareQueued === null}
              onPress={() => void toggleShare()}
            >
              <MaterialCommunityIcons
                name={shareQueued ? 'share-variant' : 'share-variant-outline'}
                size={18}
                color={shareQueued ? colors.edit : colors.textDim}
              />
              <Text style={[styles.secondaryText, shareQueued && styles.secondaryTextEdit]}>
                Share
              </Text>
            </Pressable>
          </View>

          <View style={styles.secondaryRow}>
            <Pressable
              style={[
                styles.secondaryButton,
                isBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
              ]}
              // A staged cull is not ALIVE — un-cull it before starring.
              disabled={busy || currentState === 'culled'}
              onPress={toggleBest}
            >
              <MaterialCommunityIcons
                name={isBest ? 'star' : 'star-outline'}
                size={18}
                color={isBest ? theme.accent : colors.textDim}
              />
              <Text style={[styles.secondaryText, isBest && { color: theme.accent }]}>Best</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              disabled={busy}
              onPress={() => void run(() => makeSingle(current.id))}
            >
              <MaterialCommunityIcons name="image-move" size={18} color={colors.textDim} />
              <Text style={styles.secondaryText}>Not related</Text>
            </Pressable>
          </View>

          <BigButton
            label={busy ? 'Saving…' : `Keep remaining (${aliveItems.length})`}
            color={colors.keep}
            disabled={busy || aliveItems.length === 0}
            onPress={finishGroup}
          />
        </>
      )}

      {/* m0.7 item E: album picker for the deck Organize button. */}
      <Modal
        visible={organizePickerFor !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setOrganizePickerFor(null)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setOrganizePickerFor(null)}>
          <Pressable style={styles.pickerCard} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Move to album</Text>
            <ScrollView style={{ maxHeight: 280 }}>
              {albums.map((album) => (
                <Pressable
                  key={`${album.volumeName}:${album.bucketId}`}
                  style={styles.albumRow}
                  onPress={() => void chooseOrganizeTarget(album.relativePath)}
                >
                  <MaterialCommunityIcons name="folder-image" size={18} color={colors.textDim} />
                  <Text style={styles.albumName}>{album.displayName}</Text>
                  <Text style={styles.albumCount}>{album.photoCount}</Text>
                </Pressable>
              ))}
              {albums.length === 0 && (
                <Text style={styles.albumEmpty}>No albums found — create one below.</Text>
              )}
            </ScrollView>
            <View style={styles.albumNewRow}>
              <TextInput
                style={styles.albumNewInput}
                placeholder="New album name"
                placeholderTextColor={colors.textDim}
                value={newAlbumName}
                onChangeText={setNewAlbumName}
              />
              <Pressable
                style={styles.pickerClose}
                disabled={!newAlbumPath(newAlbumName)}
                onPress={() => {
                  const path = newAlbumPath(newAlbumName);
                  if (path) void chooseOrganizeTarget(path);
                }}
              >
                <Text style={styles.pickerCloseText}>Create</Text>
              </Pressable>
            </View>
            <Pressable style={styles.pickerClose} onPress={() => setOrganizePickerFor(null)}>
              <Text style={styles.pickerCloseText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {viewerOpen && (
        <PhotoViewer
          items={deckItems.map((i) => ({ id: i.id, uri: i.uri, takenAt: i.timestamp }))}
          initialIndex={cursor}
          onClose={() => setViewerOpen(false)}
          onChanged={() => void refresh()}
        />
      )}

      {/* m0.5: explicit opponent picker for the Compare tool. */}
      <Modal
        visible={comparePicker}
        transparent
        animationType="fade"
        onRequestClose={() => setComparePicker(false)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setComparePicker(false)}>
          <Pressable style={styles.pickerCard} onPress={() => {}}>
            <Text style={styles.pickerTitle}>Compare with…</Text>
            <Text style={styles.pickerHint}>Pick the photo to compare against {cursor + 1}.</Text>
            <View style={styles.pickerGrid}>
              {(singlesMode ? deckItems : aliveItems).map((item, index) =>
                item.id === current.id ? null : (
                  <Pressable key={item.id} onPress={() => openCompare(item.id)}>
                    <Image
                      source={{ uri: item.uri }}
                      style={styles.pickerThumb}
                      contentFit="cover"
                      recyclingKey={item.id}
                    />
                    <View style={styles.pickerIndex}>
                      <Text style={styles.pickerIndexText}>{index + 1}</Text>
                    </View>
                  </Pressable>
                ),
              )}
            </View>
            <Pressable style={styles.pickerClose} onPress={() => setComparePicker(false)}>
              <Text style={styles.pickerCloseText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
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
  pager: { flex: 1 },
  posBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  posBadgeText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  timeBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  timeBadgeText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  flagBadge: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  flagBadgeText: { fontSize: 13, fontWeight: '700' },
  thumbStrip: { flexGrow: 0 },
  thumbStripContent: { gap: 6, paddingHorizontal: 2 },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbActive: { borderColor: colors.text },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  cullButton: { backgroundColor: colors.cullDim },
  compareButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bestButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  actionTextDisabled: { color: colors.textDim },
  secondaryRow: { flexDirection: 'row', gap: 10 },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 6,
  },
  secondaryButtonEdit: { backgroundColor: colors.editDim, borderColor: colors.edit },
  secondaryButtonFavourite: { backgroundColor: colors.favDim, borderColor: colors.fav },
  secondaryText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  secondaryTextEdit: { color: colors.edit },
  secondaryTextFavourite: { color: colors.fav },
  thumbDecision: { position: 'absolute', top: 3, right: 3 },
  thumbBest: { position: 'absolute', top: 3, left: 3 },
  thumbFavourite: { position: 'absolute', bottom: 3, right: 3 },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  pickerCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  pickerTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  pickerHint: { color: colors.textDim, fontSize: 13 },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickerThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
  },
  pickerIndex: {
    position: 'absolute',
    top: 4,
    left: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  pickerIndexText: { color: colors.text, fontSize: 11, fontWeight: '800' },
  pickerClose: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  albumName: { color: colors.text, fontSize: 15, flex: 1 },
  albumCount: { color: colors.textDim, fontSize: 13 },
  albumEmpty: { color: colors.textDim, fontSize: 14, paddingVertical: 12 },
  albumNewRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  albumNewInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  pickerCloseText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
