/**
 * History (m0.7 item G, #4): a reverse-chronological, filterable
 * current-state feed of decisions, with share-sheet events interleaved.
 * Ordered by activity_at with two-stream keyset pagination (C#15);
 * tapping a photo row opens the standard full-screen viewer
 * (PhotoViewer — gate 5), whose detail panel hosts the state editor.
 *
 * TOMBSTONES (m0.8.6 D9): decided photos whose bytes are gone — a
 * forgotten card's keeps, executed culls — stay on the record as
 * placeholder tiles (grey cell, verdict badge, original date): the feed
 * is the complete record of review work. A Trashed chip completes the
 * verdict-chip family. Placeholders are expected-gone, so the per-page
 * MediaStore reconcile skips them (running it would "discover" their
 * absence and re-conclude it); they open no viewer — there is nothing
 * to show. Photos deleted outside Afterglow while UNDECIDED still drop
 * out through the reconcile, exactly as before.
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
import { formatClock, formatDayClock, plural } from '../lib/format';
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { DecisionBadge } from '../components/DecisionBadge';
import { demoteForState, photoBadges, type BadgeWeight, type PhotoBadge } from '../lib/photoBadges';
import { PhotoViewer } from '../components/PhotoViewer';
import { useReview } from '../review/ReviewContext';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'History'>;

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'kept', label: 'Kept' },
  { key: 'culled', label: 'Staged' },
  { key: 'trashed', label: 'Trashed' },
  { key: 'to_edit', label: 'To edit' },
  { key: 'favourite', label: 'Favourite' },
  { key: 'organized', label: 'Organized' },
  // "Shared" and it MEANS it (m0.8.6 D10 / F16): every row behind this
  // chip had a chosen target app — an abandoned sheet leaves no record.
  { key: 'shared', label: 'Shared' },
];

/** Every badge the row wears, through the shared weighted vocabulary
 * (lib/photoBadges.ts): verdict first, then all four actions in the one
 * order, each loud while it WAITS and quiet once merely CARRIED
 * (STATE_MODEL rule 6) — the same badges the grid and deck draw. Live
 * wins over carried per kind, so a superseding queued action renders
 * loud over its earlier applied one; demotion is per-kind (F21). */
function badgesOf(row: Extract<HistoryRow, { kind: 'photo' }>): PhotoBadge[] {
  const weigh = (live: number, carried: boolean): BadgeWeight | null =>
    live === 1 ? 'live' : carried ? 'carried' : null;
  // Per-kind suspension in ONE place (m0.8.7, F21): demoteForState keeps
  // share/edit live on a staged cull and demotes the rest.
  return photoBadges({
    state: row.state,
    ...demoteForState(row.state, {
      edit: weigh(row.needs_edit, row.edit_applied === 1),
      // A queued REMOVAL wears the heart-off badge (grilling Q5); when
      // suspended it demotes to the carried heart — the gallery
      // favourite still stands while the switch-off waits.
      favourite:
        row.favourite_removing === 1
          ? 'removing'
          : weigh(row.favourite_live, row.favourite_carried === 1),
      organize: weigh(row.organize_pending, row.organize_applied_at != null),
      share: weigh(row.share_live, row.share_applied === 1),
    }),
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
      // TOMBSTONES are skipped (D9): they are expected-gone, and running
      // the check would report exactly that and drop the placeholder the
      // feed exists to keep.
      const photoIds = pageRows
        .filter(
          (row): row is Extract<HistoryRow, { kind: 'photo' }> =>
            row.kind === 'photo' && row.is_present === 1 && row.state !== 'trashed',
        )
        .map((row) => row.asset_id);
      const presences = await mapWithConcurrency(photoIds, 6, (id) => checkMediaPresence(id));
      const gone = new Set<string>(
        photoIds.filter((_, i) => presences[i] === 'trashed' || presences[i] === 'absent'),
      );
      if (gone.size === 0) return pageRows;
      // Mounted snapshot: the repair must defer a group still holding a
      // member on an ejected card (final cycle P4, plan §5). Duels are
      // append-only (v22) and survive every removal.
      const carriedFavourites = await reconcileExternallyRemoved(
        db,
        [...gone],
        Date.now(),
        await mountedVolumeSet(),
      );
      // The removal may have dissolved a cached group or moved its
      // survivor to singles — the review queue must observe it.
      void refreshReview().catch(() => {});
      // CONVERT in place, never drop or rebase (closing grilling,
      // 2026-08-20): the reconcile keeps the row's activity position
      // (external removal is not app activity), so the loaded row simply
      // becomes what the DB now says — a tombstone tile, inert, at the
      // same spot. A decided row renders the D9 placeholder; an
      // UNDECIDED one keeps its is_present so this visit still shows
      // what the eye saw — the predicate drops it on the next read.
      return pageRows.map((row) =>
        row.kind === 'photo' && gone.has(row.asset_id) && row.state !== 'unreviewed'
          ? {
              ...row,
              is_present: 0,
              state: 'trashed' as const,
              // The cleanup just DELETED every unresolved action row
              // (queued and error) — mirror that here, or the tombstone
              // wears carried badges for work that never happened (codex
              // r7). Applied/carried columns are resolved_at proof and
              // survive — except the favourite, whose carried bit is
              // DERIVED (COALESCE of pending over applied direction) and
              // can flip when cleanup drops a re-queued opposite
              // direction: the reconcile hands back the post-cleanup
              // truth (codex r8).
              needs_edit: 0,
              favourite_live: 0,
              favourite_removing: 0,
              favourite_carried: carriedFavourites.has(row.asset_id) ? 1 : 0,
              organize_pending: 0,
              share_live: 0,
            }
          : row,
      );
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
              Shared · {plural(item.member_count, 'photo')}
              {item.label ? ` · “${item.label}”` : ''}
            </Text>
            <Text style={styles.rowTime}>{formatDayClock(item.chosen_at)}</Text>
          </View>
          <MaterialCommunityIcons name="share-variant" size={20} color={colors.share} />
        </View>
      );
    }
    const badges = badgesOf(item);
    // A TOMBSTONE (D9): the bytes are gone, so a grey cell stands in for
    // the thumbnail and the row opens nothing — the verdict badge and
    // the original date are the record.
    const tombstone = item.is_present === 0 || item.state === 'trashed';
    return (
      <Pressable style={styles.row} disabled={tombstone} onPress={() => setViewerId(item.asset_id)}>
        {tombstone ? (
          <View style={[styles.thumb, styles.tombstone]}>
            <MaterialCommunityIcons name="image-off-outline" size={22} color={colors.textDim} />
          </View>
        ) : (
          <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
        )}
        <View style={styles.rowBody}>
          {/* A tombstone's line is the photo's ORIGINAL date (D9) — the
              capture day plus clock, or the honest Unknown day — never
              the activity time a live row shows (codex r1): an executed
              cull's activity_at is when the trash concluded, not when
              the photo was taken. */}
          <Text style={styles.rowTime}>
            {tombstone
              ? item.day === null
                ? labelForDayKey(UNDATED_DAY_KEY)
                : `${labelForDayKey(item.day)} ${formatClock(item.taken_at)}`
              : formatDayClock(item.activity_at)}
          </Text>
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
          // Tombstones open no viewer (D9) and must not sit in its
          // item list either — a swipe would land on a gone photo.
          const photoRows = (rows ?? []).filter(
            (r): r is Extract<HistoryRow, { kind: 'photo' }> =>
              r.kind === 'photo' && r.is_present === 1 && r.state !== 'trashed',
          );
          const index = photoRows.findIndex((r) => r.asset_id === viewerId);
          if (index < 0) return null;
          return (
            <PhotoViewer
              items={photoRows.map((r) => ({
                id: r.asset_id,
                uri: r.uri,
                takenAt: r.taken_at,
                day: r.day,
              }))}
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
  tombstone: { alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowTime: { color: colors.textDim, fontSize: 13 },
  badges: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
});
