/**
 * THE standard full-screen photo viewer (m0.8 gate 5): one component for
 * deck browse, progress grids, history rows and the queue screens.
 * Horizontal paging over the host's loaded items, pinch-zoom with
 * one-finger pan + double-tap reset (the deck's gesture language), and a
 * per-photo decision-detail panel — the home for facts the small badges
 * only hint at (state + hint, time-attached grouping, superseded
 * organize intents, share/favourite queue membership). "Change decision"
 * opens the standard StateEditorSheet; its writes bubble up through
 * `onChanged` so hosts reload.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import { getPhotoFacts, type PhotoFacts } from '../db/store';
import { isInShareQueue } from '../db/shareStore';
import { classifyPhotoState } from '../lib/progress';
import { dayKey, labelForDayKey } from '../lib/dates';
import { formatClockSeconds } from '../lib/format';
import { colors, useTheme } from '../theme';
import { stateMetaFor } from './progress/stateMeta';
import { StateEditorSheet } from './progress/StateEditorSheet';
import type { GridPhoto } from './progress/PhotoStateGrid';

/** What a host must know about each photo it shows. */
export interface ViewerItem {
  id: string;
  uri: string;
  takenAt: number;
}

const MAX_SCALE = 8;

function clampPan(value: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(-max, value));
}

export function PhotoViewer({
  items,
  initialIndex,
  onClose,
  onChanged,
}: {
  items: ViewerItem[];
  initialIndex: number;
  onClose: () => void;
  /** A state edit was written from the detail panel — reload the host. */
  onChanged?: () => void;
}) {
  const db = useSQLiteContext();
  // Viewer edits write SQLite directly (StateEditorSheet) — the review
  // queue must observe them even when the host only reloads local rows.
  const { refresh: refreshReview } = useReview();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [cursor, setCursor] = useState(Math.min(initialIndex, Math.max(0, items.length - 1)));
  // undefined = loading, null = never tracked.
  const [facts, setFacts] = useState<PhotoFacts | null | undefined>(undefined);
  const [shareQueued, setShareQueued] = useState(false);
  const [editing, setEditing] = useState<GridPhoto | null>(null);
  const [factsTick, setFactsTick] = useState(0);
  const listRef = useRef<FlatList<ViewerItem>>(null);

  const current: ViewerItem | null = items[cursor] ?? null;
  const currentId = current?.id ?? null;

  // ------------------------------------------------------ pinch zoom
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
      // onFinalize also fires on cancellation — a broken gesture can
      // never leave the pager frozen at scale 1.
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
    return Gesture.Simultaneous(pinch, pan, doubleTap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagerGesture, zoomed]);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // ------------------------------------------------------ facts panel
  useEffect(() => {
    let cancelled = false;
    setFacts(undefined);
    setShareQueued(false);
    if (currentId) {
      void Promise.all([getPhotoFacts(db, currentId), isInShareQueue(db, currentId)]).then(
        ([f, queued]) => {
          if (cancelled) return;
          setFacts(f);
          setShareQueued(queued);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [db, currentId, factsTick]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!width) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / width);
      if (index !== cursor) setCursor(Math.min(Math.max(0, index), items.length - 1));
    },
    [width, cursor, items.length],
  );

  const renderPage = useCallback(
    ({ item }: { item: ViewerItem }) => (
      <View style={{ width, height: '100%' }}>
        <Image
          source={{ uri: item.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          recyclingKey={item.id}
          transition={40}
        />
      </View>
    ),
    [width],
  );

  const meta = facts
    ? stateMetaFor(theme.accent)[
        classifyPhotoState({ state: facts.state, grouped: facts.group_id !== null })
      ]
    : null;
  const organizeSuperseded =
    facts?.organize_applied_at != null &&
    (facts.organize_state === 'queued' || facts.organize_state === 'error');
  const factLines: {
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    text: string;
  }[] = [];
  if (facts) {
    if (facts.is_best === 1) factLines.push({ icon: 'star', text: 'Best of its group.' });
    if (facts.favourite_state === 'applied')
      factLines.push({ icon: 'heart', text: 'Favourited in your gallery.' });
    else if (facts.favourite_state === 'queued_apply')
      factLines.push({ icon: 'heart-outline', text: 'Favourite queued for gallery confirmation.' });
    if (facts.edit_completed_at != null)
      factLines.push({ icon: 'pencil', text: 'Was edited via the edit queue.' });
    if (shareQueued) factLines.push({ icon: 'share-variant', text: 'In the share queue.' });
    if (facts.organize_applied_at != null)
      factLines.push({
        icon: organizeSuperseded ? 'folder-clock' : 'folder-move',
        text: organizeSuperseded
          ? 'Moved to an album once, but a newer move is still pending — the shown album is superseded until it applies.'
          : 'Moved to an album.',
      });
    else if (facts.organize_state === 'queued')
      factLines.push({ icon: 'folder-clock', text: 'Album move queued.' });
    if (facts.time_attached === 1)
      factLines.push({
        icon: 'clock-outline',
        text: 'Grouped by time — this photo has no image signature yet, so it joined the group of its nearest neighbour.',
      });
    if (facts.user_single === 1)
      factLines.push({ icon: 'image-move', text: 'You marked it not related — it stays single.' });
  }

  if (!current) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A native Modal is its own root — RNGH gestures inside it need
          their own GestureHandlerRootView on Android. */}
      <GestureHandlerRootView style={styles.root}>
        <GestureDetector gesture={zoomGesture}>
          <View
            style={styles.stage}
            onLayout={(event) => {
              stageW.value = event.nativeEvent.layout.width;
              stageH.value = event.nativeEvent.layout.height;
            }}
          >
            <GestureDetector gesture={pagerGesture}>
              <FlatList
                ref={listRef}
                data={items}
                keyExtractor={(i) => i.id}
                renderItem={renderPage}
                horizontal
                pagingEnabled
                scrollEnabled={!zoomed}
                showsHorizontalScrollIndicator={false}
                initialScrollIndex={cursor}
                getItemLayout={(_data, index) => ({
                  length: width,
                  offset: width * index,
                  index,
                })}
                onMomentumScrollEnd={onMomentumEnd}
              />
            </GestureDetector>
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
          </View>
        </GestureDetector>

        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.closeButton} hitSlop={8} onPress={onClose}>
            <MaterialCommunityIcons name="close" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.topTitle}>
            {labelForDayKey(dayKey(current.takenAt))} · {formatClockSeconds(current.takenAt)}
          </Text>
          <Text style={styles.topIndex}>
            {cursor + 1}/{items.length}
          </Text>
        </View>

        {!zoomed && (
          <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
            {meta && facts ? (
              <>
                <View style={styles.stateLine}>
                  <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                  <Text style={styles.stateLabel}>{meta.label}</Text>
                  <Text style={styles.stateHint}>{meta.hint}</Text>
                </View>
                {factLines.map((line) => (
                  <View key={line.icon + line.text} style={styles.factLine}>
                    <MaterialCommunityIcons name={line.icon} size={16} color={colors.textDim} />
                    <Text style={styles.factText}>{line.text}</Text>
                  </View>
                ))}
                <Pressable
                  style={styles.editState}
                  onPress={() =>
                    setEditing({
                      id: facts.asset_id,
                      uri: facts.uri,
                      takenAt: facts.taken_at,
                      effective: classifyPhotoState({
                        state: facts.state,
                        grouped: facts.group_id !== null,
                      }),
                      dbState: facts.state,
                    })
                  }
                >
                  <MaterialCommunityIcons name="pencil-outline" size={18} color={theme.accent} />
                  <Text style={[styles.editStateText, { color: theme.accent }]}>
                    Change decision
                  </Text>
                </Pressable>
              </>
            ) : (
              <Text style={styles.factText}>
                {facts === null
                  ? 'Not tracked yet — it enters review when the scan reaches it.'
                  : 'Loading…'}
              </Text>
            )}
          </View>
        )}

        <StateEditorSheet
          photo={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setFactsTick((t) => t + 1);
            void refreshReview();
            onChanged?.();
          }}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  stage: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  topIndex: { color: colors.textDim, fontSize: 13, fontVariant: ['tabular-nums'] },
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  stateLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  swatch: { width: 12, height: 12, borderRadius: 4 },
  stateLabel: { color: colors.text, fontSize: 15, fontWeight: '800' },
  stateHint: { color: colors.textDim, fontSize: 12, flexShrink: 1 },
  factLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  factText: { color: colors.textDim, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  editState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
  },
  editStateText: { fontSize: 14, fontWeight: '700' },
});
