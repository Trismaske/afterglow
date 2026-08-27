/**
 * THE standard full-screen photo viewer (m0.8 gate 5): one component for
 * deck browse, progress grids, history rows and the queue screens.
 * Horizontal paging over the host's loaded items, pinch-zoom with
 * one-finger pan + double-tap reset (the deck's gesture language), and a
 * per-photo decision-detail panel — the home for facts the small badges
 * only hint at (state + hint, time-attached grouping, organize intents
 * with their full album paths, queued and carried share/favourite
 * facts). "Change decision"
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
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useAnimatedStyle } from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import { getPhotoFacts, type PhotoFacts } from '../db/store';
import { decodeOrganizeTarget } from '../db/actions';
import { isInShareQueue } from '../db/shareStore';
import { classifyPhotoState } from '../lib/progress';
import { dayKey, labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { formatClockSeconds, plural } from '../lib/format';
import { badgesHidden, setBadgesHidden, subscribeBadgesHidden } from '../lib/badgePrefs';
import { colors, useTheme } from '../theme';
import { VERDICT_META } from './progress/stateMeta';
import { StateEditorSheet } from './progress/StateEditorSheet';
import type { GridPhoto } from './progress/PhotoStateGrid';
import { useDoubleTapZoom } from './useDoubleTapZoom';
import { useStageMaxScale, useStageRegionZoom } from './useStageZoom';
import { MediaStageView, useMediaStage } from './MediaStage';

/** What a host must know about each photo it shows. */
export interface ViewerItem {
  id: string;
  uri: string;
  takenAt: number;
  /** Capture day (m0.8.6 change 5): null = tracked and honestly undated
   * — the top bar says "Unknown day" and shows no clock, because
   * `takenAt` is then the mtime fallback and rendering it would turn a
   * soft claim into a confident lie. undefined = the host has no DB
   * claim (untracked photo); the bar falls back to `takenAt`, refined by
   * the facts row once it loads. */
  day?: string | null;
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
  const [factsFailed, setFactsFailed] = useState(false);
  const [shareQueued, setShareQueued] = useState(false);
  const [editing, setEditing] = useState<GridPhoto | null>(null);
  const [factsTick, setFactsTick] = useState(0);
  // The Deck header's eye, mirrored (vetted 2026-08-21): the viewer is
  // the other surface where badges visually compete with the photo, so
  // it carries a second access point to the SAME durable toggle.
  const [hideBadges, setHideBadges] = useState(badgesHidden);
  useEffect(() => subscribeBadgesHidden(setHideBadges), []);
  const listRef = useRef<FlatList<ViewerItem>>(null);

  const current: ViewerItem | null = items[cursor] ?? null;
  const currentId = current?.id ?? null;

  // The viewer is anchored to a PHOTO, not a position: a host reload can
  // reorder items (History reorders on activity_at), and the numeric
  // cursor would silently switch photos. The anchor updates ONLY on
  // user-driven navigation (mount, swipe) — a render must never re-derive
  // it from an already-reordered list, or the effect below compares the
  // wrong id and keeps the wrong position.
  const anchorIdRef = useRef<string | null>(items[initialIndex]?.id ?? null);
  useEffect(() => {
    const anchored = anchorIdRef.current;
    if (anchored === null) return;
    const index = items.findIndex((i) => i.id === anchored);
    setCursor((previous) => {
      const next = index >= 0 ? index : Math.min(previous, Math.max(0, items.length - 1));
      if (index < 0) anchorIdRef.current = items[next]?.id ?? null; // photo left — re-anchor
      if (next !== previous) {
        listRef.current?.scrollToOffset({ offset: next * width, animated: false });
      }
      return next;
    });
    // Only item-set changes re-anchor; swipes drive the cursor directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ------------------------------------------------------ pinch zoom
  // The whole driver set — shared values, gestures, overlay styles —
  // is the deck-canonical MediaStage (m0.9 phase 1,
  // docs/Plan_m0.9.md; the bridge/worklet rules live in its
  // header). The viewer's former explicit pager link (useNativeGesture
  // + simultaneousWith) is dropped in the alignment: the stage pinch
  // claims two-finger streams from the pager by ACTIVATION, exactly
  // like the deck. The panel below reacts to `scale` via animated
  // props (the inverse of the overlay).
  const stage = useMediaStage();
  const {
    scale,
    savedScale,
    tx,
    ty,
    savedTx,
    savedTy,
    stageW,
    stageH,
    maxScale,
    imageAspect,
    resetZoom,
  } = stage;

  // F22 (m0.8.8): the region-zoom pipeline for the current page — the
  // viewer is dwell-by-nature, so bases warm almost immediately after a
  // page settles. Wiring (JS-side polling callbacks + the resolution-
  // driven zoom ceiling): components/useStageZoom.ts.
  const regionZoom = useStageRegionZoom(
    { stageW, stageH, scale, tx, ty },
    currentId,
    current?.uri ?? null,
    current !== null,
  );
  useStageMaxScale(maxScale, stageW, stageH, regionZoom.sourceSize);

  // The facts panel does the inverse of the zoom overlay: it fades out
  // while zoomed (`scale` on the UI thread), and its accessibility
  // importance follows.
  const panelStyle = useAnimatedStyle(() => ({
    opacity: scale.value > 1 ? 0 : 1,
  }));
  // importantForAccessibility too: opacity 0 hides the panel from eyes
  // and pointerEvents from touch, but its "Change decision" Pressable
  // would otherwise stay focusable to TalkBack while invisible over the
  // zoomed photo (codex r50).
  const panelProps = useAnimatedProps(() => ({
    pointerEvents: (scale.value > 1 ? 'none' : 'auto') as 'auto' | 'none',
    importantForAccessibility: (scale.value > 1 ? 'no-hide-descendants' : 'auto') as
      'no-hide-descendants' | 'auto',
  }));

  useEffect(() => {
    resetZoom();
  }, [currentId, resetZoom]);

  // ------------------------------------------------------ facts panel
  // F30 (m0.8.7): a RE-READ of the same photo keeps the previous facts
  // rendered, dimmed (`factsStale` on the panel) — clearing them here
  // unmounted the panel to "Loading…" and it visibly collapsed and
  // returned on every state-editor write. Only a photo CHANGE clears.
  const lastFactsIdRef = useRef<string | null>(null);
  const [factsStale, setFactsStale] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (currentId !== lastFactsIdRef.current) {
      lastFactsIdRef.current = currentId;
      setFacts(undefined);
      setShareQueued(false);
    }
    setFactsFailed(false);
    if (currentId) {
      setFactsStale(true);
      void Promise.all([getPhotoFacts(db, currentId), isInShareQueue(db, currentId)]).then(
        ([f, queued]) => {
          if (cancelled) return;
          setFacts(f);
          setShareQueued(queued);
          setFactsStale(false);
        },
        (error: unknown) => {
          // FAIL CLOSED with a retry (codex r10): an unhandled rejection
          // left the panel on "Loading…" forever with "Change decision"
          // unreachable. Tapping the failure line retries via factsTick.
          console.warn('[viewer] facts read failed:', String(error));
          if (!cancelled) {
            setFactsFailed(true);
            setFactsStale(false);
          }
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
      if (index !== cursor) {
        const clamped = Math.min(Math.max(0, index), items.length - 1);
        anchorIdRef.current = items[clamped]?.id ?? null; // user navigation moves the anchor
        setCursor(clamped);
      }
    },
    [width, cursor, items],
  );

  // Double-tap zooms to the tapped point — a Pressable press on the JS
  // thread, exactly like the deck's (the bridge comment above); there is
  // no single-tap action here. currentId scopes the tap window to one
  // photo (the hook serves every pager page).
  const onPagePress = useDoubleTapZoom(
    { scale, savedScale, tx, ty, savedTx, savedTy, stageW, stageH, imageAspect },
    undefined,
    currentId,
  );
  /** Photos whose load FAILED — a black stage says nothing, and the
   * one real way here is a file deleted outside Afterglow that no
   * reconcile has met yet (device pass, 2026-08-20). Named in place. */
  const [deadIds, setDeadIds] = useState<ReadonlySet<string>>(new Set());
  const renderPage = useCallback(
    ({ item }: { item: ViewerItem }) => (
      <Pressable style={{ width, height: '100%' }} onPress={onPagePress}>
        {deadIds.has(item.id) ? (
          <View style={styles.deadPage}>
            <MaterialCommunityIcons name="image-off-outline" size={44} color={colors.textDim} />
            <Text style={styles.deadText}>
              This photo can't be shown — it may have been deleted outside Afterglow.
            </Text>
          </View>
        ) : (
          <Image
            source={{ uri: item.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            recyclingKey={item.id}
            transition={40}
            onError={() => setDeadIds((old) => new Set(old).add(item.id))}
          />
        )}
      </Pressable>
    ),
    [width, onPagePress, deadIds],
  );

  const meta = facts ? VERDICT_META[classifyPhotoState({ state: facts.state })] : null;
  const organizeSuperseded = facts?.organize_applied_at != null && facts.organize_queued === 1;
  const factLines: {
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
    text: string;
  }[] = [];
  if (facts) {
    // SUSPENDED (codex r6): a staged cull or trashed photo keeps its
    // action rows, but it is in no queue (STATE_MODEL.md — the badges
    // demote to carried for the same reason). The lines describe the
    // retained intent instead of claiming live queue membership; every
    // queue claim below routes through these.
    const suspended = facts.state === 'culled' || facts.state === 'trashed';
    const queued = (liveText: string, retainedText: string) =>
      suspended ? retainedText : liveText;
    // Favourite is DIRECTIONAL (STATE_MODEL.md): the queued row wins the
    // line while one waits — including a queued removal, under which the
    // carried heart must not show — else the resolved apply carries it
    // (FAVOURITE_HELD's resolved half), like the edit pair below.
    if (facts.favourite_queued === 1)
      factLines.push({
        icon: 'heart-outline',
        text: queued(
          'Favourite queued for gallery confirmation.',
          'Favourite request rides along — resumes if the photo is un-staged.',
        ),
      });
    else if (facts.favourite_queued === 0)
      factLines.push({
        icon: 'heart-off-outline',
        text: queued(
          'Favourite removal queued.',
          'Favourite removal rides along — resumes if the photo is un-staged.',
        ),
      });
    else if (facts.favourite_applied === 1)
      factLines.push({ icon: 'heart', text: 'Favourited in your gallery.' });
    if (facts.needs_edit === 1)
      // Edit stays IN its queue on a staged cull (m0.8.7, F21 point 1).
      factLines.push({ icon: 'pencil-outline', text: 'In the edit queue.' });
    if (facts.edit_completed_at != null)
      factLines.push({ icon: 'pencil', text: 'Was edited via the edit queue.' });
    if (shareQueued)
      // Share stays IN its queue on a staged cull (m0.8.7, F21 point 1).
      factLines.push({ icon: 'share-variant', text: 'In the share queue.' });
    // Carried share (codex r7): mirrors the edit pair above — the queued
    // line while the queue holds it, the resolved fact once it let go.
    else if (facts.share_carried === 1)
      factLines.push({ icon: 'share-variant', text: 'Was shared from the share queue.' });
    // The organize lines carry the FULL album path (codex r7): the
    // decision appendix promises it lives one long-press away, here. A
    // target-less queue row (m0.8.2 F6) keeps the pathless copy.
    const pendingAlbum = decodeOrganizeTarget(facts.organize_target)?.path ?? null;
    const appliedAlbum = decodeOrganizeTarget(facts.organize_applied_target)?.path ?? null;
    if (facts.organize_applied_at != null) {
      const movedOnce = appliedAlbum ? `Moved to ${appliedAlbum} once` : 'Moved to an album once';
      const newerMove = pendingAlbum ? `a newer move to ${pendingAlbum}` : 'a newer move';
      factLines.push({
        icon: organizeSuperseded ? 'folder-clock' : 'folder-move',
        text: organizeSuperseded
          ? // codex r7: the superseded branch bypassed the suspended
            // wording, claiming a live pending move on a staged cull.
            queued(
              `${movedOnce}, but ${newerMove} is still pending — the shown album is superseded until it applies.`,
              `${movedOnce}, and ${newerMove} rides along — back in the queue if the photo is un-staged.`,
            )
          : appliedAlbum
            ? `Moved to ${appliedAlbum}.`
            : 'Moved to an album.',
      });
    } else if (facts.organize_queued === 1)
      factLines.push({
        icon: 'folder-clock',
        text: pendingAlbum
          ? queued(
              `Album move queued → ${pendingAlbum}`,
              `Album move to ${pendingAlbum} rides along — back in the queue if the photo is un-staged.`,
            )
          : queued(
              'Album move queued.',
              'Album move rides along — back in the queue if the photo is un-staged.',
            ),
      });
    // time_attached is deliberately NOT surfaced (m0.8.2): internal scan
    // quality the user cannot act on; the scan rewrites it once
    // embeddings land (docs/STATE_MODEL.md).
    if (facts.not_related_count > 0)
      factLines.push({
        icon: 'image-move',
        text: `You marked it not related to ${plural(facts.not_related_count, 'photo')} — it never groups with them.`,
      });
  }

  if (!current) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A native Modal is its own root — RNGH gestures inside it need
          their own GestureHandlerRootView on Android. */}
      <GestureHandlerRootView style={styles.root}>
        <MediaStageView
          controller={stage}
          overlayFor={current}
          regionZoom={regionZoom}
          backdropColor="#000"
          noticeBottom={96}
          deadContent={
            deadIds.has(current.id) ? (
              // A dead page double-tapped into zoom must keep its
              // explanation (codex r7): the overlay's plain black stage
              // over the same failed URI recreated exactly what the
              // placeholder exists to prevent. Rendered on the
              // UNtransformed layer so it stays legible.
              <View style={styles.deadPage}>
                <MaterialCommunityIcons name="image-off-outline" size={44} color={colors.textDim} />
                <Text style={styles.deadText}>
                  This photo can't be shown — it may have been deleted outside Afterglow.
                </Text>
              </View>
            ) : undefined
          }
        >
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(i) => i.id}
            renderItem={renderPage}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={cursor}
            getItemLayout={(_data, index) => ({
              length: width,
              offset: width * index,
              index,
            })}
            onMomentumScrollEnd={onMomentumEnd}
          />
        </MediaStageView>

        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.closeButton} hitSlop={8} onPress={onClose}>
            <MaterialCommunityIcons name="close" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.topTitle}>
            {(() => {
              // Date honesty (m0.8.6 change 5): the facts row is the
              // authority once loaded (it self-heals a rescued photo the
              // host mislabeled); while loading — or when no row exists
              // (untracked) — the host's own day claim. A NULL day =
              // honestly undated — name the unknown and print NO clock
              // (takenAt is the mtime fallback there).
              const day = facts != null ? facts.day : current.day;
              if (day === null) return labelForDayKey(UNDATED_DAY_KEY);
              // taken_at self-heals from the facts row too: a host that
              // mislabeled a rescued photo with its mtime is corrected
              // the moment the row loads.
              const at = facts != null ? facts.taken_at : current.takenAt;
              return `${labelForDayKey(day ?? dayKey(at))} · ${formatClockSeconds(at)}`;
            })()}
          </Text>
          <Pressable
            style={styles.closeButton}
            hitSlop={8}
            onPress={() => void setBadgesHidden(db, !badgesHidden())}
            accessibilityLabel={hideBadges ? 'Show photo badges' : 'Hide photo badges'}
          >
            <MaterialCommunityIcons
              name={hideBadges ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color={colors.textDim}
            />
          </Pressable>
          <Text style={styles.topIndex}>
            {cursor + 1}/{items.length}
          </Text>
        </View>

        <Animated.View
          style={[styles.panel, { paddingBottom: insets.bottom + 12 }, panelStyle]}
          animatedProps={panelProps}
        >
          {meta && facts ? (
            // F30: dimmed while a re-read is in flight — the previous
            // facts stay mounted instead of collapsing to "Loading…".
            // A FAILED re-read keeps them too, but visibly stale and
            // non-interactive (codex m0.8.7 r1): editing against facts
            // the read could not confirm would write on stale truth.
            <View style={factsStale || factsFailed ? styles.factsStale : null}>
              <View style={styles.stateLine}>
                <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                <Text style={styles.stateLabel}>{meta.label}</Text>
              </View>
              {factLines.map((line) => (
                <View key={line.icon + line.text} style={styles.factLine}>
                  <MaterialCommunityIcons name={line.icon} size={16} color={colors.textDim} />
                  <Text style={styles.factText}>{line.text}</Text>
                </View>
              ))}
              {factsFailed ? (
                <Pressable onPress={() => setFactsTick((t) => t + 1)}>
                  <Text style={styles.factText}>
                    Could not refresh this photo's details — shown as last read. Tap to retry.
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.editState}
                  onPress={() =>
                    setEditing({
                      id: facts.asset_id,
                      uri: facts.uri,
                      takenAt: facts.taken_at,
                      day: facts.day,
                      effective: classifyPhotoState({ state: facts.state }),
                      dbState: facts.state,
                    })
                  }
                >
                  <MaterialCommunityIcons name="pencil-outline" size={18} color={theme.accent} />
                  <Text style={[styles.editStateText, { color: theme.accent }]}>
                    Change decision
                  </Text>
                </Pressable>
              )}
            </View>
          ) : factsFailed ? (
            <Pressable onPress={() => setFactsTick((t) => t + 1)}>
              <Text style={styles.factText}>
                Could not read this photo's details just now — tap to retry.
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.factText}>
              {facts === null
                ? 'Not tracked yet — it enters review when the scan reaches it.'
                : 'Loading…'}
            </Text>
          )}
        </Animated.View>

        <StateEditorSheet
          photo={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setFactsTick((t) => t + 1);
            void refreshReview().catch(() => {});
            onChanged?.();
          }}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  deadPage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  deadText: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  /** The zoom-time fail-soft notice (DeckScreen's zoomNotice). */
  root: { flex: 1, backgroundColor: '#000' },
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
  factsStale: { opacity: 0.5 },
  editState: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
  },
  editStateText: { fontSize: 14, fontWeight: '700' },
});
