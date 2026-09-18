/**
 * Paged photo grid filtered by effective state (progress pages, m0.4).
 *
 * Two loading engines, chosen by the filter:
 * - DB-backed filters (in-group / kept / to-edit / staged / done): the
 *   rows exist in SQLite, so pages come straight from
 *   getGridPhotosByFilter (newest-first LIMIT/OFFSET) — no MediaStore
 *   scan to find 3 staged photos in a 5 000-photo scope.
 * - 'all' and 'unreviewed': untracked photos have no DB row, so pages
 *   come from MediaStore (newest-first, one cursor stream per source
 *   bucket, merged by progressPager.ts), joined against SQLite per page
 *   to classify each photo. Trashed rows appear in neither engine —
 *   their files are gone (the summary notes how many are hidden).
 *
 * The component IS the screen's FlatList (3-column grid) — the page
 * header is injected via ListHeaderComponent so nothing nests inside a
 * ScrollView.
 */
import type { StoredMediaKind } from '../../lib/mediaIdentity';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AnimatedThumb } from '../AnimatedThumb';
import { useAnimatedList } from '../useAnimatedCells';
import { animatedKindOf, type AnimatedKind } from '../../lib/animatedCells';
import { motionClipOf, type MotionClipRow } from '../../db/store';
import { thumbBucketPx } from '../../lib/thumbnailSize';
import { PixelRatio, useWindowDimensions } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import {
  classifyPhotoState,
  isDbFilter,
  type EffectiveState,
  type ProgressFilter,
} from '../../lib/progress';
import {
  createMergedDescendingPager,
  type MergedPager,
  type PageFetcher,
} from '../../lib/progressPager';
import { createLibraryGridStream, type LibraryGridStream } from '../../lib/gridPager';
import { rootKey, type SourceRoot } from '../../lib/sources';
import {
  getGridPhotosByFilter,
  getRescuedPhotoPage,
  getStateRowsForAssets,
  scopeKeyOf,
  type PhotoScope,
} from '../../db/store';
import { getActionBadges, getFavouriteActionStates } from '../../db/actions';
import { favouriteBadgeWeight, type FavouriteStatus } from '../../lib/favouriteState';
import {
  demoteForState,
  isSdPhoto,
  photoBadges,
  type WeightedActionSet,
} from '../../lib/photoBadges';
import { StateDots } from '../DecisionBadge';
import { UNDATED_DAY_KEY } from '../../lib/dates';
import { colors, useTheme } from '../../theme';

/** One grid tile: identity + what the tile's badge rendering needs. */
export interface GridPhoto {
  id: string;
  uri: string;
  /** The media kind (m0.9 phase 4). */
  kind: StoredMediaKind;
  /** The image cache version (item 3). */
  version: number;
  /** What the tile animates as (phase 6): null = a plain photo. */
  animated: AnimatedKind | null;
  /** A motion photo's clip, for the animated tile. */
  motion: MotionClipRow | null;
  takenAt: number;
  /** Capture day (m0.8.6 change 5): a string day from the DB; null =
   * TRACKED and honestly undated (takenAt is the mtime fallback —
   * surfaces say "Unknown day"); undefined = untracked, no DB claim
   * (takenAt is MediaStore's own date). */
  day: string | null | undefined;
  /** The display/filter bucket. */
  effective: EffectiveState;
  /** The actual photos.state row value; null = never tracked. */
  dbState: PhotoState | null;
  /** The WEIGHTED action set (m0.8.7 full hydration): live, carried and
   * the favourite's 'removing', already demoted per the photo's verdict
   * (demoteForState). Hydrated on BOTH engines — the MediaStore paths
   * used to render no action data at all. Undefined = the page's
   * hydration failed (badges absent, never wrong). */
  actions?: WeightedActionSet;
}

const BATCH = 48;

/** EVERY day scope — and since m0.8.6 every MONTH scope (change 1) —
 * pages EVERY filter from SQLite (m0.8.3, D16 — decided with Tristan):
 * a D15-rescued photo is DB-dated but MediaStore-undated, so a
 * DATE_TAKEN-range page would omit it from its real month forever while
 * the month's counts include it. The DB day column is the app's truth
 * of day/month membership; only the open-ended library scope keeps the
 * MediaStore engine (instant visibility for photos the scan has not
 * ingested yet). The Unknown-day pseudo-day was already here — its
 * photos cannot be paged from MediaStore at all. */
function isDbScope(scope: PhotoScope): boolean {
  return 'day' in scope || 'month' in scope;
}

/** What the library grid's merged pager streams: MediaStore photos and
 * DB rescued rows in ONE shape, keyed by their honest newest-first
 * timestamp (m0.8.6 change 4). A rescued photo appears in BOTH streams
 * — in MediaStore's undated tail wearing its mtime, and in the rescued
 * stream at its true `taken_at` — so the per-page state join marks the
 * MediaStore copy (rescued && !fromDb) and the collect loop drops it. */
interface GridPagedItem {
  id: string;
  uri: string;
  timestamp: number;
  /** MediaStore reported no capture date (untracked rows only — tracked
   * rows take their date truth from the state join instead). */
  undated: boolean;
  /** Came from the DB rescued stream, not MediaStore. */
  fromDb: boolean;
}

/** Each bucket's private cursor: a MediaStore endCursor string, or the
 * rescued stream's keyset. The merged pager hands each fetcher only its
 * own cursor back, so the union is safe by construction. */
type GridCursor = string | { takenAt: number; assetId: string };

const NO_FAVOURITE: FavouriteStatus = { state: 'none', target: null };

/** Hydrate one page's WEIGHTED action sets (m0.8.7): two chunked reads
 * for the whole page, demoted per photo verdict. A failed read logs and
 * returns null — the page renders with verdict badges only, never with
 * invented action data. */
async function hydrateActionWeights(
  db: Parameters<typeof getActionBadges>[0],
  photos: readonly GridPhoto[],
): Promise<Map<string, WeightedActionSet> | null> {
  if (photos.length === 0) return new Map();
  try {
    const ids = photos.map((p) => p.id);
    const [badges, favourites] = await Promise.all([
      getActionBadges(db, ids),
      getFavouriteActionStates(db, ids),
    ]);
    const out = new Map<string, WeightedActionSet>();
    for (const photo of photos) {
      const entry = badges.get(photo.id) ?? {};
      out.set(
        photo.id,
        demoteForState(photo.dbState, {
          edit: entry.edit ?? null,
          favourite: favouriteBadgeWeight(favourites.get(photo.id) ?? NO_FAVOURITE),
          organize: entry.organize ?? null,
          share: entry.share ?? null,
        }),
      );
    }
    return out;
  } catch (error) {
    console.warn('[progress] action hydration failed — badges omitted:', String(error));
    return null;
  }
}

/** A grid photo IS its thumbnail row (it carries the animated facts). */
const gridThumb = (photo: GridPhoto) => photo;

export function PhotoStateGrid({
  scope,
  startMs,
  endMs,
  roots,
  albumIds,
  filter,
  refreshKey,
  mounted,
  header,
  bottomInset,
  onPhotoPress,
}: {
  /** DB-side scope (day column or taken_at range). */
  scope: PhotoScope;
  /** MediaStore-side range (always ms). */
  startMs: number;
  endMs: number;
  roots: SourceRoot[] | null;
  albumIds: string[] | null;
  filter: ProgressFilter;
  /** Bump to reload from scratch (state edits, focus refresh). */
  refreshKey: number;
  /** The PARENT's mounted-volume snapshot (final cycle O5): the chips'
   * counts and the grid they label must page one world, so the grid
   * never re-reads the provider itself — a filter tap after an active-
   * session eject would otherwise page the new reachable population
   * under a chip still advertising the old count. `undefined` = counts
   * not loaded yet; the DB engine waits for it. Identity is stable
   * across reloads that observed no change (sameVolumeSet upstream). */
  mounted: readonly string[] | null | undefined;
  header: React.ReactElement;
  bottomInset: number;
  onPhotoPress: (photo: GridPhoto, siblings: GridPhoto[], index: number) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const tilePx = thumbBucketPx(windowWidth / 3, PixelRatio.get());
  const db = useSQLiteContext();
  // Animated thumbnails (phase 6): the clips on screen play, per the
  // Settings row; the list's viewability drives it.
  const { accent } = useTheme();
  const [items, setItems] = useState<GridPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  /** A page read FAILED this pass — the empty state must say so rather
   * than claim the filter matched nothing (fail-closed). */
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false);
  const genRef = useRef(0);
  const loadingGenRef = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const streamRef = useRef<LibraryGridStream | null>(null);
  const rootsKey = roots ? roots.map(rootKey).join('\0') : '';
  const albumsKey = albumIds ? albumIds.join('\0') : '';
  const scopeKey = scopeKeyOf(scope);

  const loadMore = useCallback(
    async (gen: number, reset: boolean) => {
      if (loadingGenRef.current !== null) return;
      loadingGenRef.current = gen;
      const dbEngine = isDbFilter(filter) || isDbScope(scope);
      // The DB engine clears the flag EVERY page (its retry re-reads the
      // same offset, so a later success really has recovered); the
      // MediaStore engine only clears on reset — a failed bucket's page
      // is gone from this pass, so the truncation must stay visible even
      // when later pages from healthy buckets succeed.
      if (reset || dbEngine) failedRef.current = false;
      setLoading(true);
      try {
        const fresh = () => gen === genRef.current;
        if (dbEngine) {
          // FAIL CLOSED, mirroring the MediaStore engine below: a
          // rejected query must not become a silent blank grid claiming
          // "No photos in this state".
          const rows = await getGridPhotosByFilter(
            db,
            scope,
            roots,
            filter,
            BATCH,
            offsetRef.current,
            // One world per pass (M6/N3/O5): the parent's snapshot, never
            // a live provider read — reset re-fires when it changes.
            mounted ?? null,
          ).catch((error: unknown) => {
            console.warn('[progress] grid query failed:', String(error));
            // Gen-scoped (codex r3): a superseded pass's late rejection
            // must not poison the replacement generation's failure flag.
            if (gen === genRef.current) failedRef.current = true;
            return [];
          });
          if (!fresh()) return;
          offsetRef.current += rows.length;
          const photos: GridPhoto[] = rows.map((r) => ({
            id: r.asset_id,
            uri: r.uri,
            kind: r.kind,
            version: r.image_version,
            animated: animatedKindOf({
              kind: r.kind,
              mimeType: r.mime_type,
              hasMotion: r.motion_offset !== null,
            }),
            motion: motionClipOf(r),
            takenAt: r.taken_at,
            day: r.day,
            dbState: r.state,
            effective: classifyPhotoState({ state: r.state }),
          }));
          const weights = await hydrateActionWeights(db, photos);
          if (!fresh()) return;
          if (weights !== null) {
            for (const photo of photos) photo.actions = weights.get(photo.id);
          }
          // A failed page must NOT read as the end of the data: the
          // offset only advanced by rows actually returned, so leaving
          // `exhausted` unset lets the next scroll retry the same page.
          if (rows.length < BATCH && !failedRef.current) setExhausted(true);
          setItems((prev) => (reset ? photos : [...prev, ...photos]));
        } else {
          const stream = streamRef.current;
          if (!stream) return;
          const failedBefore = failedRef.current;
          // The engine itself (fetchers, merge, state join, filter,
          // rescued-copy dedup) is the SHARED lib/gridPager.ts stream —
          // the deck's library-grid list source pages the same code.
          const pulled = await stream.collect(BATCH, filter);
          if (!fresh()) return;
          const collected: GridPhoto[] = pulled.map((r) => ({
            id: r.id,
            uri: r.uri,
            kind: r.kind,
            version: r.version,
            animated: animatedKindOf({
              kind: r.kind,
              mimeType: r.mimeType,
              hasMotion: r.motion !== null,
            }),
            motion: r.motion,
            takenAt: r.takenAt,
            day: r.day,
            dbState: r.dbState,
            effective: r.effective,
          }));
          // FULL hydration on the MediaStore engine too (m0.8.7): the
          // All/Unreviewed paths used to render no action data at all.
          const weights = await hydrateActionWeights(db, collected);
          if (!fresh()) return;
          if (weights !== null) {
            for (const photo of collected) photo.actions = weights.get(photo.id);
          }
          // A page that JUST failed must not seal the grid as complete —
          // the failure footer/empty copy renders first, and only a
          // later page may mark exhaustion (the sticky flag keeps the
          // truncation visible in the footer either way).
          const failedThisPage = failedRef.current && !failedBefore;
          if (stream.exhausted() && !failedThisPage) setExhausted(true);
          setItems((prev) => (reset ? collected : [...prev, ...collected]));
        }
      } finally {
        if (loadingGenRef.current === gen) loadingGenRef.current = null;
        if (gen === genRef.current) {
          setLoading(false);
          setFailed(failedRef.current);
        }
      }
    },
    [db, filter, scope, roots, mounted],
  );

  // Reset + first page whenever the filter/scope/source/refresh — or
  // the parent's mounted snapshot (O5) — changes.
  useEffect(() => {
    const gen = ++genRef.current;
    loadingGenRef.current = null;
    offsetRef.current = 0;
    setItems([]);
    setExhausted(false);
    if (isDbFilter(filter) || isDbScope(scope)) {
      streamRef.current = null;
    } else {
      streamRef.current = createLibraryGridStream(db, {
        startMs,
        endMs,
        albumIds: albumIds ?? null,
        roots,
        mounted: mounted ?? null,
        // Gen-scoped (codex r3): a superseded pass's late rejection
        // must not poison the replacement generation's failure flag.
        onFailure: () => {
          if (gen === genRef.current) failedRef.current = true;
        },
      });
    }
    // The DB engine pages the parent's world — before the first counts
    // load lands there is no world to page (the spinner shows); the
    // prop's arrival re-fires this effect.
    if ((isDbFilter(filter) || isDbScope(scope)) && mounted === undefined) return;
    void loadMore(gen, true);
    // loadMore is recreated alongside these deps; scopeKey/rootsKey/
    // albumsKey stand in for their object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, refreshKey, scopeKey, rootsKey, albumsKey, startMs, endMs, mounted]);

  const { cells } = useAnimatedList({
    rows: items,
    thumbOf: gridThumb,
    columns: 3,
    tileDp: useWindowDimensions().width / 3,
  });
  const renderItem = useCallback(
    ({ item, index }: { item: GridPhoto; index: number }) => (
      <Pressable style={styles.tileWrap} onPress={() => onPhotoPress(item, items, index)}>
        {/* The OS thumbnail source (phase 3, item 2): a third of the
            screen at device scale, bucketed — playing its clip while on
            screen (phase 6). */}
        <AnimatedThumb row={item} px={tilePx} index={index} cells={cells} style={styles.tile} />
        {/* The shared inspection-dot row (StateDots' header): verdict
            dot + weighted action glyphs, the same marks the deck strip
            and the timeline cards wear. */}
        <StateDots
          effective={item.effective}
          style={styles.dots}
          badges={
            item.actions !== undefined
              ? photoBadges({
                  state: item.dbState ?? 'unreviewed',
                  ...item.actions,
                  sdCard: isSdPhoto(item.id),
                })
              : []
          }
        />
      </Pressable>
    ),
    [onPhotoPress, items, tilePx, cells],
  );

  return (
    <FlatList
      style={styles.root}
      data={items}
      keyExtractor={(p) => p.id}
      renderItem={renderItem}
      numColumns={3}
      {...cells.listProps}
      ListHeaderComponent={header}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (!exhausted && loadingGenRef.current === null) void loadMore(genRef.current, false);
      }}
      contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: bottomInset + 24 }}
      ListEmptyComponent={
        !loading && (exhausted || failed) ? (
          <Text style={styles.empty}>
            {failed
              ? 'Could not read your library just now. Pull back and reopen to try again.'
              : 'No items in this state.'}
          </Text>
        ) : null
      }
      ListFooterComponent={
        loading ? (
          <ActivityIndicator color={accent} style={styles.footer} />
        ) : failed && items.length > 0 ? (
          // A truncated grid must SAY it is truncated (fail closed): the
          // failure copy used to live only in the empty state, so a
          // LATER page's failure read as "that's everything". The copy
          // promises only what BOTH engines deliver — the MediaStore
          // pager drains a failed bucket's cursor, so an in-place scroll
          // retry is not universally true (codex r3); reopening is.
          <Text style={styles.empty}>
            Could not read all of your photos just now — pull back and reopen to try again.
          </Text>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  tileWrap: { width: '33.33%', aspectRatio: 1, padding: 2 },
  tile: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
  },
  dots: { position: 'absolute', right: 7, bottom: 7 },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  footer: { marginVertical: 16 },
});
