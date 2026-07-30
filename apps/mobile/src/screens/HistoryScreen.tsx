/**
 * History (m0.7 item G, #4): a reverse-chronological, filterable
 * current-state feed of decisions on photos still present, with
 * share-sheet events interleaved. Ordered by activity_at with two-stream
 * keyset pagination (C#15); trashed/deleted photos drop out (restore
 * brings them back via reconciliation); tapping a photo row opens the
 * standard full-screen viewer (PhotoViewer — gate 5), whose detail panel
 * hosts the state editor.
 */
import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import {
  getHistoryPage,
  type HistoryCursor,
  type HistoryFilter,
  type HistoryRow,
} from '../db/store';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { mapWithConcurrency } from '../lib/concurrency';
import { checkMediaPresence } from '../lib/media';
import { formatDayClock } from '../lib/format';
import { DecisionBadge } from '../components/DecisionBadge';
import { photoBadges, type BadgeWeight, type PhotoBadge } from '../lib/photoBadges';
import { PhotoViewer } from '../components/PhotoViewer';
import { useReview } from '../review/ReviewContext';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'History'>;

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'kept', label: 'Kept' },
  { key: 'culled', label: 'Staged' },
  { key: 'to_edit', label: 'To edit' },
  { key: 'favourite', label: 'Favourite' },
  { key: 'organized', label: 'Organized' },
  { key: 'shared', label: 'Sheet opened' },
];

/** Every badge the row wears, through the shared weighted vocabulary
 * (lib/photoBadges.ts): verdict first, then all four actions in the one
 * order, each loud while it WAITS and quiet once merely CARRIED
 * (STATE_MODEL rule 6) — the same badges the grid and deck draw. Live
 * wins over carried per kind, so a superseding queued action renders
 * loud over its earlier applied one; a staged cull's live actions demote
 * to quiet, because they are off every to-do list (livePhotoClause). */
function badgesOf(row: Extract<HistoryRow, { kind: 'photo' }>): PhotoBadge[] {
  const suspended = row.state === 'culled' || row.state === 'trashed';
  const weigh = (live: number, carried: boolean): BadgeWeight | null =>
    live === 1 ? (suspended ? 'carried' : 'live') : carried ? 'carried' : null;
  return photoBadges({
    state: row.state,
    edit: weigh(row.needs_edit, row.edit_applied === 1),
    // A queued REMOVAL wears the heart-off badge (grilling Q5); when
    // suspended it demotes to the carried heart — the gallery favourite
    // still stands while the switch-off waits.
    favourite:
      row.favourite_removing === 1
        ? suspended
          ? 'carried'
          : 'removing'
        : weigh(row.favourite_live, row.favourite_carried === 1),
    organize: weigh(row.organize_pending, row.organize_applied_at != null),
    share: weigh(row.share_live, row.share_applied === 1),
  });
}

export function HistoryScreen(_props: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refresh: refreshReview } = useReview();

  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // codex r9: a rejected read no longer escapes as an unhandled
  // rejection or flattens into "empty"/"complete". Whatever rows are on
  // screen stay (rows null → the empty-state area says the read failed;
  // rows present → a quiet footer says the feed may be truncated), and
  // the next successful read clears it.
  const [failed, setFailed] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Monotonic request token: a reload invalidates every in-flight fetch
  // (an older filter's result finishing last must not win the state).
  const requestRef = useRef(0);

  // The screen contract: photos deleted or trashed OUTSIDE Afterglow drop
  // out. Only Afterglow's own trash resolution clears is_present, so each
  // fetched page is reconciled against MediaStore — fail-closed: only an
  // authoritative 'trashed'/'absent' answer converges the row (exactly
  // like a verified trash outcome, without credit); 'unknown' changes
  // nothing.
  const reconcilePage = useCallback(
    async (pageRows: HistoryRow[]): Promise<HistoryRow[]> => {
      // BOUNDED CONCURRENCY (m0.8.1): checkMediaPresence is two native
      // calls, and a 40-row page ran them 80× in series — the page's
      // dominant cost on every focus and every "load more".
      const photoIds = pageRows.filter((row) => row.kind === 'photo').map((row) => row.asset_id);
      const presences = await mapWithConcurrency(photoIds, 6, (id) => checkMediaPresence(id));
      const gone = new Set<string>(
        photoIds.filter((_, i) => presences[i] === 'trashed' || presences[i] === 'absent'),
      );
      if (gone.size === 0) return pageRows;
      // Quad-state 'absent' = permanently gone → duel history dies with
      // the sweep; 'trashed' is restorable and keeps it (grilling Q13).
      const permanentlyGone = new Set<string>(photoIds.filter((_, i) => presences[i] === 'absent'));
      // Mounted snapshot: the repair must defer a group still holding a
      // member on an ejected card (final cycle P4, plan §5).
      await reconcileExternallyRemoved(
        db,
        [...gone],
        Date.now(),
        await mountedVolumeSet(),
        permanentlyGone,
      );
      // The removal may have dissolved a cached group or moved its
      // survivor to singles — the review queue must observe it.
      void refreshReview().catch(() => {});
      return pageRows.filter((row) => row.kind !== 'photo' || !gone.has(row.asset_id));
    },
    [db, refreshReview],
  );

  const reload = useCallback(
    async (which: HistoryFilter) => {
      const token = ++requestRef.current;
      try {
        const page = await getHistoryPage(db, which, null);
        const rowsNow = await reconcilePage(page.rows);
        if (requestRef.current !== token) return; // superseded by a newer reload
        setRows(rowsNow);
        setNext(page.next);
        setFailed(false);
      } catch {
        // codex r9: an initial rejection left the screen blank forever
        // with an unhandled rejection; a focus-refresh rejection kept a
        // stale feed silently. Mark it and keep what is shown.
        if (requestRef.current === token) setFailed(true);
      }
    },
    [db, reconcilePage],
  );

  useFocusEffect(
    useCallback(() => {
      // C#15: the cursor resets after any mutation elsewhere — refetching
      // on focus keeps the keyset coherent.
      void reload(filter);
    }, [reload, filter]),
  );

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    // Extends the stream the current token owns; a reload started
    // meanwhile bumps the token and this append is discarded.
    const token = requestRef.current;
    try {
      const page = await getHistoryPage(db, filter, next);
      const rowsNow = await reconcilePage(page.rows);
      if (requestRef.current !== token) return;
      setRows((old) => [...(old ?? []), ...rowsNow]);
      setNext(page.next);
      setFailed(false);
    } catch {
      // codex r9: a later page's rejection silently truncated the feed.
      // `next` deliberately stays set — the feed is NOT complete — and
      // the footer below says so; a later scroll or reopen retries.
      if (requestRef.current === token) setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [db, filter, next, loadingMore, reconcilePage]);

  const renderItem = useCallback(({ item }: { item: HistoryRow }) => {
    if (item.kind === 'share') {
      return (
        <View style={styles.shareRow}>
          <View style={styles.shareThumbs}>
            {item.thumb_uris.slice(0, 3).map((uri, i) => (
              <Image
                key={`${item.batch_id}-${i}`}
                source={{ uri }}
                style={[styles.shareThumb, { left: i * 14 }]}
                contentFit="cover"
              />
            ))}
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>
              Share sheet opened · {item.member_count} photo{item.member_count === 1 ? '' : 's'}
              {item.label ? ` · “${item.label}”` : ''}
            </Text>
            <Text style={styles.rowTime}>{formatDayClock(item.opened_at)}</Text>
          </View>
          <MaterialCommunityIcons name="share-variant" size={20} color={colors.share} />
        </View>
      );
    }
    const badges = badgesOf(item);
    return (
      <Pressable style={styles.row} onPress={() => setViewerId(item.asset_id)}>
        <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
        <View style={styles.rowBody}>
          <Text style={styles.rowTime}>{formatDayClock(item.activity_at)}</Text>
          <View style={styles.badges}>
            {badges.map((badge) => (
              <DecisionBadge key={badge.kind} kind={badge.kind} size={20} weight={badge.weight} />
            ))}
          </View>
        </View>
      </Pressable>
    );
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[
              styles.chip,
              filter === f.key && [styles.chipActive, { borderColor: theme.accent }],
            ]}
            onPress={() => {
              setRows(null);
              // codex r9: a fresh fetch starts — do not show the old
              // failure line over its loading state.
              setFailed(false);
              if (f.key === filter) {
                // Same filter tapped again: the focus effect keys on
                // `filter` and will NOT re-run — reload explicitly.
                void reload(f.key);
              } else {
                // The focus effect re-runs on the filter change —
                // reloading here too would double the presence checks
                // and reconciliation work.
                setFilter(f.key);
              }
            }}
          >
            <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => (r.kind === 'share' ? `share-${r.batch_id}` : r.asset_id)}
        renderItem={renderItem}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        contentContainerStyle={{ gap: 8, paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={
          failed ? (
            // codex r9: the initial read failed — say so with the
            // empty-state styling instead of a blank screen.
            <Text style={styles.empty}>
              Could not read your history just now — pull back and reopen to try again.
            </Text>
          ) : rows !== null ? (
            <Text style={styles.empty}>
              Decisions land here as you review — photos deleted outside Afterglow drop out.
            </Text>
          ) : null
        }
        ListFooterComponent={
          failed && rows !== null && rows.length > 0 ? (
            // codex r9: a truncated feed must SAY it is truncated (the
            // PhotoStateGrid footer's copy family) — and the cursor stays
            // set, so the feed is never marked complete by a failure.
            <Text style={styles.empty}>
              Could not read more of your history just now — pull back and reopen to try again.
            </Text>
          ) : null
        }
      />
      {viewerId !== null &&
        (() => {
          const photoRows = (rows ?? []).filter(
            (r): r is Extract<HistoryRow, { kind: 'photo' }> => r.kind === 'photo',
          );
          const index = photoRows.findIndex((r) => r.asset_id === viewerId);
          if (index < 0) return null;
          return (
            <PhotoViewer
              items={photoRows.map((r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at }))}
              initialIndex={index}
              onClose={() => setViewerId(null)}
              onChanged={() => void reload(filter).catch(() => {})}
            />
          );
        })()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 14, paddingTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 15,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Rule 4: selection is an ACCENT OUTLINE over a neutral lift, never a
  // fill — a filled chip in edit-blue said "this filter is an edit".
  // Same shape the Progress chips use.
  chipActive: { backgroundColor: colors.surfaceRaised },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    gap: 12,
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderRadius: touch.radius,
    borderWidth: 1,
    // A share EVENT wears share's hue (rule 2) — it was edit-blue.
    borderColor: colors.share,
    padding: 10,
    gap: 12,
  },
  shareThumbs: { width: 66, height: 38 },
  shareThumb: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowTime: { color: colors.textDim, fontSize: 13 },
  badges: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
});
