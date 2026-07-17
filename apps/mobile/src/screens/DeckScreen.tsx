import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
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
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClockPrecise, millisNeeded } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Deck'>;

const UNDO_MS = 4000;
const THUMB = 52;

/**
 * Swipe-deck group review (m0.4, replacing the duel bracket): the group is
 * a horizontally swipeable stack of its alive photos. Cull any photo as
 * you meet it (brief Undo affordance), star one as best, flag needs-edit,
 * eject a mis-grouped photo to the singles flow, or open the Compare tool
 * (A/B flip + synced zoom) against the next photo — long-press a thumbnail
 * to compare against that one instead. "Keep rest" finishes the group:
 * the survivors are kept.
 *
 * Pinch-zoom is deliberately NOT on this screen (it fights the pager
 * gesture) — the Compare tool carries the zoom plumbing.
 */
export function DeckScreen({ navigation }: Props) {
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
    version,
    pendingReconsider,
  } = useSession();
  const [busy, setBusy] = useState(false);
  const [pageW, setPageW] = useState(0);
  const [undo, setUndo] = useState<{ id: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<FlatList<MediaItem>>(null);

  // The group currently under review (first incomplete one).
  const groupId = useMemo(
    () => session?.currentGroupId() ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, version],
  );
  const info = useMemo(
    () => (session && groupId ? session.groupInfo(groupId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, groupId, version],
  );
  const aliveItems: MediaItem[] = useMemo(
    () => (session && info ? info.aliveIds.map((id) => session.item(id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, info],
  );
  const cursor = info?.cursor ?? 0;
  const current: MediaItem | null = aliveItems[cursor] ?? null;
  const groupIndex = useMemo(
    () => (groupId ? groups.findIndex((g) => g.id === groupId) : -1),
    [groups, groupId],
  );

  // Millisecond precision only where adjacent deck photos share a second
  // AND the timestamps carry sub-second data (m0.4).
  const needMs = useMemo(() => millisNeeded(aliveItems.map((i) => i.timestamp)), [aliveItems]);

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);
  // A new group means the old cull can't return to a live deck anymore.
  useEffect(() => {
    clearUndo();
  }, [groupId, clearUndo]);

  // Route forward: reconsider hint first, then remaining groups (stay),
  // singles, and finally the cull list — same flow shape as m0.3.
  useEffect(() => {
    if (!session) return;
    if (pendingReconsider) {
      navigation.replace('Reconsider', { groupId: pendingReconsider });
      return;
    }
    if (groupId) return;
    if (session.nextSingle()) navigation.replace('Singles');
    else navigation.replace('CullList');
  }, [session, groupId, pendingReconsider, navigation]);

  // Keep the pager aligned with the cursor whenever the deck's membership
  // changes (cull/undo/make-single) or a new group starts. Swiping itself
  // never triggers this (the key ignores the cursor).
  const deckKey = `${groupId ?? ''}:${info?.aliveIds.join(',') ?? ''}`;
  useEffect(() => {
    if (!pageW || aliveItems.length === 0) return;
    listRef.current?.scrollToOffset({ offset: cursor * pageW, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckKey, pageW]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!groupId || !pageW) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / pageW);
      if (index !== cursor) deckSetCursor(groupId, index);
    },
    [groupId, pageW, cursor, deckSetCursor],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (!groupId || !pageW) return;
      deckSetCursor(groupId, index);
      listRef.current?.scrollToOffset({ offset: index * pageW, animated: true });
    },
    [groupId, pageW, deckSetCursor],
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

  const openCompare = useCallback(
    (againstId?: string) => {
      if (!groupId || !current || aliveItems.length < 2) return;
      const other =
        againstId ?? aliveItems[(cursor + 1) % aliveItems.length].id;
      if (other === current.id) return;
      navigation.navigate('Compare', { groupId, aId: current.id, bId: other });
    },
    [groupId, current, aliveItems, cursor, navigation],
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
  const keepCount = aliveItems.length;

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          Group {groupIndex + 1} of {groups.length} · {keepCount} in deck
        </Text>
        <Text style={styles.headerHint}>
          Swipe through the group · cull what you don't want · Keep rest finishes.
        </Text>
      </View>

      <View
        style={styles.stage}
        onLayout={(event) => setPageW(event.nativeEvent.layout.width)}
      >
        {pageW > 0 && (
          <FlatList
            ref={listRef}
            data={aliveItems}
            keyExtractor={(i) => i.id}
            renderItem={renderPage}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.min(cursor, aliveItems.length - 1)}
            getItemLayout={(_data, index) => ({
              length: pageW,
              offset: pageW * index,
              index,
            })}
            onMomentumScrollEnd={onMomentumEnd}
          />
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
        {(isBest || flagged) && (
          <View style={styles.flagBadge} pointerEvents="none">
            <Text style={[styles.flagBadgeText, { color: theme.accent }]}>
              {[isBest ? '★ best' : null, flagged ? '✎ edit' : null].filter(Boolean).join(' · ')}
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

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.thumbStrip}
        contentContainerStyle={styles.thumbStripContent}
      >
        {aliveItems.map((item, index) => (
          <Pressable
            key={item.id}
            onPress={() => jumpTo(index)}
            onLongPress={() => {
              if (item.id !== current.id) openCompare(item.id);
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
            ⇄ Compare
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
        onPress={() => void run(() => keepRest(groupId))}
      />
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
});
