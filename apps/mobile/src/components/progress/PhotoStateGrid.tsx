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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import { classifyPhotoState, type EffectiveState, type ProgressFilter } from '../../lib/progress';
import { createMergedDescendingPager, type MergedPager } from '../../lib/progressPager';
import { fetchPhotoPageDesc, type LoadedPhoto } from '../../lib/media';
import { getGridPhotosByFilter, getStateRowsForAssets, type PhotoScope } from '../../db/store';
import { UNDATED_DAY_KEY } from '../../lib/dates';
import { colors, useTheme } from '../../theme';
import { stateMetaFor } from './stateMeta';

/** One grid tile: identity + what the state editor sheet needs. */
export interface GridPhoto {
  id: string;
  uri: string;
  takenAt: number;
  /** The display/filter bucket. */
  effective: EffectiveState;
  /** The actual photos.state row value; null = never tracked. */
  dbState: PhotoState | null;
}

const BATCH = 48;
const DB_FILTERS = ['in_group', 'to_edit', 'staged', 'done'] as const;
type DbFilter = (typeof DB_FILTERS)[number];

function isDbFilter(filter: ProgressFilter): filter is DbFilter {
  return (DB_FILTERS as readonly string[]).includes(filter);
}

/** The Unknown-day pseudo-day pages EVERY filter from SQLite — its
 * photos (no DATE_TAKEN) cannot be paged from MediaStore, and the
 * tracked rows are the complete population there. */
function isUndatedScope(scope: PhotoScope): boolean {
  return 'day' in scope && scope.day === UNDATED_DAY_KEY;
}

export function PhotoStateGrid({
  scope,
  startMs,
  endMs,
  roots,
  albumIds,
  filter,
  refreshKey,
  header,
  bottomInset,
  onPhotoPress,
}: {
  /** DB-side scope (day column or taken_at range). */
  scope: PhotoScope;
  /** MediaStore-side range (always ms). */
  startMs: number;
  endMs: number;
  roots: string[] | null;
  albumIds: string[] | null;
  filter: ProgressFilter;
  /** Bump to reload from scratch (state edits, focus refresh). */
  refreshKey: number;
  header: React.ReactElement;
  bottomInset: number;
  onPhotoPress: (photo: GridPhoto, siblings: GridPhoto[], index: number) => void;
}) {
  const db = useSQLiteContext();
  const { accent } = useTheme();
  const stateMeta = useMemo(() => stateMetaFor(accent), [accent]);
  const [items, setItems] = useState<GridPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const genRef = useRef(0);
  const loadingGenRef = useRef<number | null>(null);
  const offsetRef = useRef(0);
  const pagerRef = useRef<MergedPager<LoadedPhoto> | null>(null);

  const rootsKey = roots ? roots.join('\0') : '';
  const albumsKey = albumIds ? albumIds.join('\0') : '';
  const scopeKey = 'day' in scope ? `d:${scope.day}` : `r:${scope.startMs}:${scope.endMs}`;

  const loadMore = useCallback(
    async (gen: number, reset: boolean) => {
      if (loadingGenRef.current !== null) return;
      loadingGenRef.current = gen;
      setLoading(true);
      try {
        const fresh = () => gen === genRef.current;
        if (isDbFilter(filter) || isUndatedScope(scope)) {
          const rows = await getGridPhotosByFilter(
            db,
            scope,
            roots,
            filter,
            BATCH,
            offsetRef.current,
          );
          if (!fresh()) return;
          offsetRef.current += rows.length;
          const photos: GridPhoto[] = rows.map((r) => ({
            id: r.asset_id,
            uri: r.uri,
            takenAt: r.taken_at,
            dbState: r.state,
            effective: classifyPhotoState({ state: r.state, grouped: !!r.grouped }),
          }));
          if (rows.length < BATCH) setExhausted(true);
          setItems((prev) => (reset ? photos : [...prev, ...photos]));
        } else {
          const pager = pagerRef.current;
          if (!pager) return;
          const collected: GridPhoto[] = [];
          while (collected.length < BATCH && !pager.exhausted()) {
            const raw = await pager.next(BATCH);
            if (raw.length === 0) break;
            const states = await getStateRowsForAssets(
              db,
              raw.map((p) => p.item.id),
            );
            if (!fresh()) return;
            for (const p of raw) {
              const row = states.get(p.item.id);
              const effective = classifyPhotoState(row);
              if (filter === 'all' || effective === filter) {
                collected.push({
                  id: p.item.id,
                  uri: p.item.uri,
                  takenAt: p.item.timestamp,
                  dbState: row?.state ?? null,
                  effective,
                });
              }
            }
          }
          if (!fresh()) return;
          if (pager.exhausted()) setExhausted(true);
          setItems((prev) => (reset ? collected : [...prev, ...collected]));
        }
      } finally {
        if (loadingGenRef.current === gen) loadingGenRef.current = null;
        if (gen === genRef.current) setLoading(false);
      }
    },
    [db, filter, scope, roots],
  );

  // Reset + first page whenever the filter/scope/source/refresh changes.
  useEffect(() => {
    const gen = ++genRef.current;
    loadingGenRef.current = null;
    offsetRef.current = 0;
    setItems([]);
    setExhausted(false);
    if (isDbFilter(filter) || isUndatedScope(scope)) {
      pagerRef.current = null;
    } else {
      const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
      pagerRef.current = createMergedDescendingPager<LoadedPhoto, string>(
        buckets.map((album) => async (cursor, count) => {
          const page = await fetchPhotoPageDesc(startMs, endMs, album, cursor, count).catch(() => ({
            photos: [],
            endCursor: undefined,
            hasNext: false,
          }));
          return {
            items: page.photos,
            nextCursor: page.hasNext && page.endCursor !== undefined ? page.endCursor : null,
          };
        }),
        (p) => p.item.timestamp,
      );
    }
    void loadMore(gen, true);
    // loadMore is recreated alongside these deps; scopeKey/rootsKey/
    // albumsKey stand in for their object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, refreshKey, scopeKey, rootsKey, albumsKey, startMs, endMs]);

  const renderItem = useCallback(
    ({ item, index }: { item: GridPhoto; index: number }) => (
      <Pressable style={styles.tileWrap} onPress={() => onPhotoPress(item, items, index)}>
        <Image
          source={{ uri: item.uri }}
          style={styles.tile}
          contentFit="cover"
          recyclingKey={item.id}
        />
        <View style={[styles.dot, { backgroundColor: stateMeta[item.effective].color }]} />
      </Pressable>
    ),
    [onPhotoPress, items, stateMeta],
  );

  return (
    <FlatList
      style={styles.root}
      data={items}
      keyExtractor={(p) => p.id}
      renderItem={renderItem}
      numColumns={3}
      ListHeaderComponent={header}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (!exhausted && loadingGenRef.current === null) void loadMore(genRef.current, false);
      }}
      contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: bottomInset + 24 }}
      ListEmptyComponent={
        !loading && exhausted ? <Text style={styles.empty}>No photos in this state.</Text> : null
      }
      ListFooterComponent={
        loading ? <ActivityIndicator color={accent} style={styles.footer} /> : null
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
  dot: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.background,
  },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  footer: { marginVertical: 16 },
});
