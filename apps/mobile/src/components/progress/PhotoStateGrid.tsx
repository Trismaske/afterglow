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
import {
  classifyPhotoState,
  isActionFilter,
  type EffectiveState,
  type ProgressFilter,
} from '../../lib/progress';
import { createMergedDescendingPager, type MergedPager } from '../../lib/progressPager';
import { fetchPhotoPageDesc, type LoadedPhoto } from '../../lib/media';
import { rootKey, type SourceRoot } from '../../lib/sources';
import {
  getGridPhotosByFilter,
  getStateRowsForAssets,
  scopeKeyOf,
  type PhotoScope,
} from '../../db/store';
import { UNDATED_DAY_KEY } from '../../lib/dates';
import { colors, useTheme } from '../../theme';
import { VERDICT_META } from './stateMeta';

/** One grid tile: identity + what the state editor sheet needs. */
export interface GridPhoto {
  id: string;
  uri: string;
  takenAt: number;
  /** The display/filter bucket. */
  effective: EffectiveState;
  /** The actual photos.state row value; null = never tracked. */
  dbState: PhotoState | null;
  /** Pending ACTIONS (layer 2, never verdicts) — one dot each, so an
   * action-filtered grid shows why each photo matched. The MediaStore
   * engine leaves them undefined (its filters are verdict-only).
   * favPending is directional at the SQL layer: only a favourite waiting
   * TOWARD TRUE shows (a queued removal wears no heart). */
  editPending?: boolean;
  favPending?: boolean;
  organizePending?: boolean;
  sharePending?: boolean;
}

const BATCH = 48;
/** Filters the DB can answer directly. 'unreviewed' is the exception:
 * it includes photos MediaStore has that the scan has never tracked, so
 * it must be paged from MediaStore instead (v18). */
const DB_FILTERS = ['kept', 'staged'] as const;

function isDbFilter(filter: ProgressFilter): boolean {
  return (DB_FILTERS as readonly string[]).includes(filter) || isActionFilter(filter);
}

/** EVERY day scope pages EVERY filter from SQLite (m0.8.3, D16 —
 * decided with Tristan): a D15-rescued photo is DB-dated but
 * MediaStore-undated, so a DATE_TAKEN-range page would omit it from its
 * real day forever while the day's counts include it. The DB day column
 * is the app's truth of day membership; only library-wide RANGE scopes
 * keep the MediaStore engine (instant visibility for photos the scan
 * has not ingested yet). The Unknown-day pseudo-day was already here —
 * its photos cannot be paged from MediaStore at all. */
function isDbScope(scope: PhotoScope): boolean {
  return 'day' in scope;
}

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
  const db = useSQLiteContext();
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
  const pagerRef = useRef<MergedPager<LoadedPhoto> | null>(null);
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
            failedRef.current = true;
            return [];
          });
          if (!fresh()) return;
          offsetRef.current += rows.length;
          const photos: GridPhoto[] = rows.map((r) => ({
            id: r.asset_id,
            uri: r.uri,
            takenAt: r.taken_at,
            dbState: r.state,
            editPending: !!r.needs_edit,
            favPending: !!r.fav_pending,
            organizePending: !!r.organize_pending,
            sharePending: !!r.share_pending,
            effective: classifyPhotoState({ state: r.state }),
          }));
          // A failed page must NOT read as the end of the data: the
          // offset only advanced by rows actually returned, so leaving
          // `exhausted` unset lets the next scroll retry the same page.
          if (rows.length < BATCH && !failedRef.current) setExhausted(true);
          setItems((prev) => (reset ? photos : [...prev, ...photos]));
        } else {
          const pager = pagerRef.current;
          if (!pager) return;
          const failedBefore = failedRef.current;
          const collected: GridPhoto[] = [];
          while (collected.length < BATCH && !pager.exhausted()) {
            const raw = await pager.next(BATCH);
            if (raw.length === 0) break;
            // FAIL CLOSED like the page fetch beside it: a rejected
            // state join must not fall through `finally` as a silently
            // blank (or silently complete) grid — the same sticky
            // failure state renders the footer/empty copy (codex r4).
            const states = await getStateRowsForAssets(
              db,
              raw.map((p) => p.item.id),
            ).catch((error: unknown) => {
              console.warn('[progress] grid state join failed:', String(error));
              failedRef.current = true;
              return null;
            });
            if (states === null) break;
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
          // A page that JUST failed must not seal the grid as complete —
          // the failure footer/empty copy renders first, and only a
          // later page may mark exhaustion (the sticky flag keeps the
          // truncation visible in the footer either way).
          const failedThisPage = failedRef.current && !failedBefore;
          if (pager.exhausted() && !failedThisPage) setExhausted(true);
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
      pagerRef.current = null;
    } else {
      const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
      pagerRef.current = createMergedDescendingPager<LoadedPhoto, string>(
        buckets.map((album) => async (cursor, count) => {
          // FAIL CLOSED (m0.8.2): an errored page used to become an
          // empty exhausted one, so a MediaStore hiccup rendered "No
          // photos in this state" — a confident, wrong answer about the
          // user's library. Record the failure and say so instead.
          const page = await fetchPhotoPageDesc(startMs, endMs, album, cursor, count).catch(
            (error: unknown) => {
              console.warn('[progress] photo page failed:', String(error));
              failedRef.current = true;
              return { photos: [], endCursor: undefined, hasNext: false };
            },
          );
          return {
            items: page.photos,
            nextCursor: page.hasNext && page.endCursor !== undefined ? page.endCursor : null,
          };
        }),
        (p) => p.item.timestamp,
      );
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

  const renderItem = useCallback(
    ({ item, index }: { item: GridPhoto; index: number }) => (
      <Pressable style={styles.tileWrap} onPress={() => onPhotoPress(item, items, index)}>
        <Image
          source={{ uri: item.uri }}
          style={styles.tile}
          contentFit="cover"
          recyclingKey={item.id}
        />
        <View style={styles.dots}>
          {/* Verdict first, then every pending ACTION in photoBadges.ts
              order — the grid's own order under docs/STATE_MODEL.md.
              Without the action dots an action-filtered grid showed
              nothing but keep-green, giving no sign of why each photo
              matched. Each dot takes its kind's reserved hue (rule 2). */}
          <View style={[styles.dot, { backgroundColor: VERDICT_META[item.effective].color }]} />
          {item.editPending === true && (
            <View style={[styles.dot, { backgroundColor: colors.edit }]} />
          )}
          {item.favPending === true && (
            <View style={[styles.dot, { backgroundColor: colors.fav }]} />
          )}
          {item.organizePending === true && (
            <View style={[styles.dot, { backgroundColor: colors.organize }]} />
          )}
          {item.sharePending === true && (
            <View style={[styles.dot, { backgroundColor: colors.share }]} />
          )}
        </View>
      </Pressable>
    ),
    [onPhotoPress, items],
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
        !loading && (exhausted || failed) ? (
          <Text style={styles.empty}>
            {failed
              ? 'Could not read your photos just now. Pull back and reopen to try again.'
              : 'No photos in this state.'}
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
  dots: { position: 'absolute', right: 7, bottom: 7, flexDirection: 'row', gap: 3 },
  dot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.background,
  },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginVertical: 24 },
  footer: { marginVertical: 16 },
});
