import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
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
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession, type RedecideTarget } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Deck'>;

const UNDO_MS = 4000;
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
export function DeckScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const {
    session,
    groups,
    deckSetCursor,
    deckCull,
    deckUndoCull,
    keepRest,
    markBest,
    makeSingle,
    needsEdit,
    toggleNeedsEdit,
    redecide,
    version,
    pendingReconsider,
  } = useSession();
  const [busy, setBusy] = useState(false);
  const [pageW, setPageW] = useState(0);
  const [undo, setUndo] = useState<{ id: string } | null>(null);
  const [comparePicker, setComparePicker] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<FlatList<MediaItem>>(null);

  // m0.5: an explicit group (Groups screen tap) pins the deck to it; the
  // linear flow keeps following the first incomplete group.
  const explicitGroupId = route.params?.groupId;
  const groupId = useMemo(
    () => explicitGroupId ?? session?.currentGroupId() ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [explicitGroupId, session, version],
  );
  const info = useMemo(
    () => {
      if (!session || !groupId) return null;
      try {
        return session.groupInfo(groupId);
      } catch {
        return null; // stale explicit id (e.g. resumed navigation)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, groupId, version],
  );
  const browse = info?.complete ?? false;

  const aliveItems: MediaItem[] = useMemo(
    () => (session && info ? info.aliveIds.map((id) => session.item(id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, info],
  );
  // Browse mode pages every re-decidable member (kept AND staged culls).
  const browseItems: MediaItem[] = useMemo(() => {
    if (!session || !info || !browse) return [];
    return info.memberIds
      .filter((id) => {
        const s = session.getState(id);
        return s === 'kept' || s === 'culled';
      })
      .map((id) => session.item(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, info, browse, version]);
  const deckItems = browse ? browseItems : aliveItems;

  const [browseCursor, setBrowseCursor] = useState(0);
  const cursor = browse
    ? Math.min(browseCursor, Math.max(0, deckItems.length - 1))
    : (info?.cursor ?? 0);
  const current: MediaItem | null = deckItems[cursor] ?? null;
  const groupIndex = useMemo(
    () => (groupId ? groups.findIndex((g) => g.id === groupId) : -1),
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
      .onStart(() => {
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
    return Gesture.Simultaneous(pinch, pan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed]);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);
  // A new group means the old cull can't return to a live deck anymore;
  // ditto a group COMPLETING under the banner (cull of the last photo in
  // an explicitly opened group) — core undoCull only works on live decks,
  // browse mode's re-decide chips take over from there.
  useEffect(() => {
    clearUndo();
    setComparePicker(false);
  }, [groupId, browse, clearUndo]);
  useEffect(() => {
    setBrowseCursor(0);
  }, [groupId]);
  // The zoom overlay shows the CURRENT photo — leave zoom when it changes.
  const currentId = current?.id ?? null;
  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // Route forward: reconsider hint first, then — in the linear flow only —
  // remaining groups (stay), singles, and finally the cull list. An
  // explicitly opened group stays put (completed groups browse in place).
  useEffect(() => {
    if (!session) return;
    if (pendingReconsider) {
      navigation.replace('Reconsider', { groupId: pendingReconsider });
      return;
    }
    if (explicitGroupId) {
      if (!info) navigation.goBack(); // stale group id — nothing to show
      return;
    }
    if (groupId) return;
    if (session.nextSingle()) navigation.replace('Singles');
    else navigation.replace('CullList');
  }, [session, groupId, explicitGroupId, info, pendingReconsider, navigation]);

  // Keep the pager aligned with the cursor whenever the deck's membership
  // changes (cull/undo/make-single/re-decide) or a new group starts.
  // Swiping itself never triggers this (the key ignores the cursor).
  const deckKey = `${groupId ?? ''}:${browse ? 'b' : 'r'}:${deckItems.map((i) => i.id).join(',')}`;
  useEffect(() => {
    if (!pageW || deckItems.length === 0) return;
    listRef.current?.scrollToOffset({ offset: cursor * pageW, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pageW]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!groupId || !pageW) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / pageW);
      if (index === cursor) return;
      if (browse) setBrowseCursor(index);
      else deckSetCursor(groupId, index);
    },
    [groupId, pageW, cursor, browse, deckSetCursor],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (!groupId || !pageW) return;
      if (browse) setBrowseCursor(index);
      else deckSetCursor(groupId, index);
      listRef.current?.scrollToOffset({ offset: index * pageW, animated: true });
    },
    [groupId, pageW, browse, deckSetCursor],
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

  const cullCurrent = useCallback(() => {
    if (!current) return;
    const id = current.id;
    void run(async () => {
      await deckCull(id);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      setUndo({ id });
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    });
  }, [current, run, deckCull]);

  const undoLastCull = useCallback(() => {
    if (!undo) return;
    const id = undo.id;
    clearUndo();
    void run(() => deckUndoCull(id));
  }, [undo, clearUndo, run, deckUndoCull]);

  const finishGroup = useCallback(() => {
    if (!groupId || !session) return;
    void run(async () => {
      await keepRest(groupId);
      // Explicit visits return to the overview once the group is done —
      // unless a reconsider hint is about to take over the screen.
      const hasReconsider =
        session.reconsiderCandidates(groupId).filter((item) => !needsEdit(item.id)).length > 0;
      if (explicitGroupId && !hasReconsider) navigation.goBack();
    });
  }, [groupId, session, run, keepRest, needsEdit, explicitGroupId, navigation]);

  const openCompare = useCallback(
    (againstId?: string) => {
      if (!groupId || !current || aliveItems.length < 2) return;
      if (againstId === undefined && aliveItems.length > 2) {
        // m0.5: explicit opponent choice for larger groups.
        setComparePicker(true);
        return;
      }
      const other = againstId ?? aliveItems.find((i) => i.id !== current.id)?.id;
      if (!other || other === current.id) return;
      setComparePicker(false);
      navigation.navigate('Compare', { groupId, aId: current.id, bId: other });
    },
    [groupId, current, aliveItems, navigation],
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

  if (!session || !groupId || !info || !current) {
    return <View style={styles.root} />;
  }

  const isBest = info.bestId === current.id;
  const flagged = needsEdit(current.id);
  const keepCount = deckItems.length;
  const currentState = session.getState(current.id);
  const browseState: RedecideTarget =
    currentState === 'culled' ? 'cull' : flagged ? 'to_edit' : 'keep';

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          Group {groupIndex + 1} of {groups.length} · {keepCount} {browse ? 'reviewed' : 'in deck'}
        </Text>
        <Text style={styles.headerHint}>
          {browse
            ? 'Reviewed group — change any decision until the final delete confirmation.'
            : "Swipe through the group · cull what you don't want · Keep rest finishes."}
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
          {(isBest || flagged || (browse && currentState === 'culled')) && (
            <View style={styles.flagBadge} pointerEvents="none">
              <Text style={[styles.flagBadgeText, { color: theme.accent }]}>
                {[
                  isBest ? '★ best' : null,
                  flagged ? '✎ edit' : null,
                  browse && currentState === 'culled' ? '✕ staged to cull' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          )}
          {undo && (
            <Pressable style={styles.undoBanner} onPress={undoLastCull} disabled={busy}>
              <Text style={styles.undoText}>Photo staged to cull</Text>
              <Text style={[styles.undoAction, { color: theme.accent }]}>UNDO</Text>
            </Pressable>
          )}
        </View>
      </GestureDetector>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.thumbStrip}
        contentContainerStyle={styles.thumbStripContent}
      >
        {deckItems.map((item, index) => (
          <Pressable
            key={item.id}
            onPress={() => jumpTo(index)}
            onLongPress={() => {
              if (!browse && item.id !== current.id) openCompare(item.id);
            }}
          >
            <Image
              source={{ uri: item.uri }}
              style={[
                styles.thumb,
                index === cursor && styles.thumbActive,
                item.id === info.bestId && { borderColor: theme.accent },
              ]}
              contentFit="cover"
              recyclingKey={item.id}
            />
          </Pressable>
        ))}
      </ScrollView>

      {browse ? (
        // m0.5 re-decide chips: the current photo's verdict, changeable.
        <View style={styles.actionRow}>
          {(
            [
              { target: 'keep', label: '✓ Keep', dim: colors.keepDim, color: colors.keep },
              { target: 'to_edit', label: '✎ To edit', dim: colors.editDim, color: colors.edit },
              { target: 'cull', label: '✕ Cull', dim: colors.cullDim, color: colors.cull },
            ] as const
          ).map(({ target, label, dim, color }) => {
            const active = browseState === target;
            return (
              <Pressable
                key={target}
                style={[
                  styles.actionButton,
                  { backgroundColor: dim },
                  active && { borderWidth: 2, borderColor: color },
                ]}
                disabled={busy}
                onPress={() => void run(() => redecide(current.id, target))}
              >
                <Text style={styles.actionText}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <>
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.actionButton, styles.cullButton]}
              disabled={busy}
              onPress={cullCurrent}
            >
              <Text style={styles.actionText}>✕ Cull</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButton, styles.compareButton]}
              disabled={busy || keepCount < 2}
              onPress={() => openCompare()}
            >
              <Text style={[styles.actionText, keepCount < 2 && styles.actionTextDisabled]}>
                ⇄ Compare{keepCount > 2 ? ' with…' : ''}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.actionButton,
                styles.bestButton,
                isBest && { backgroundColor: theme.accentMuted, borderColor: theme.accent },
              ]}
              disabled={busy}
              onPress={() => void run(() => markBest(groupId, isBest ? null : current.id))}
            >
              <Text style={[styles.actionText, isBest && { color: theme.accent }]}>
                {isBest ? '★ Best' : '☆ Best'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.secondaryRow}>
            <Pressable
              style={[styles.secondaryButton, flagged && styles.secondaryButtonEdit]}
              disabled={busy}
              onPress={() => void toggleNeedsEdit(current.id)}
            >
              <Text style={[styles.secondaryText, flagged && styles.secondaryTextEdit]}>
                {flagged ? '✎ Needs edit ✓' : '✎ Needs edit'}
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              disabled={busy}
              onPress={() => void run(() => makeSingle(current.id))}
            >
              <Text style={styles.secondaryText}>↗ Not related — single</Text>
            </Pressable>
          </View>

          <BigButton
            label={busy ? '…' : `✓ Keep rest (${keepCount})`}
            color={colors.keep}
            disabled={busy}
            onPress={finishGroup}
          />
        </>
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
            <Text style={styles.pickerHint}>
              Pick the photo to compare against {cursor + 1}.
            </Text>
            <View style={styles.pickerGrid}>
              {aliveItems.map((item, index) =>
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
  timeBadgeText: { color: colors.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
  undoBanner: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  undoText: { color: colors.text, fontSize: 13 },
  undoAction: { fontSize: 13, fontWeight: '800' },
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
  },
  secondaryButtonEdit: { backgroundColor: colors.editDim, borderColor: colors.edit },
  secondaryText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  secondaryTextEdit: { color: colors.edit },
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
  pickerCloseText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
