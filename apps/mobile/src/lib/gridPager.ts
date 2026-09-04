/**
 * The library-scope grid ENGINE (m0.9 phase 2 extraction): the
 * MediaStore merged pager plus its per-page SQLite state join and
 * filter application, moved VERBATIM out of PhotoStateGrid so the
 * deck's list source and the Progress grid page the exact same stream
 * — one engine, two consumers, order and membership parity by
 * construction.
 *
 * Only the open-ended library scope needs this: it must show photos
 * MediaStore has that the scan has never tracked, so it pages
 * MediaStore per source bucket (merged descending by timestamp),
 * plus one DB stream of RESCUED rows at their true taken_at (m0.8.6
 * change 4 — a rescued photo appears in BOTH streams; the state join
 * marks the MediaStore copy, and the collect loop drops it). Every
 * day/month scope is DB-backed (PhotoStateGrid's isDbScope) and never
 * comes here.
 *
 * FAIL CLOSED throughout (m0.8.2): a rejected page or state join is
 * reported through `onFailure` and never becomes a silent blank —
 * each consumer renders its own truncation copy.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { fetchPhotoPageDesc, type LoadedPhoto } from './media';
import { getRescuedPhotoPage, getStateRowsForAssets } from '../db/store';
import type { SourceRoot } from './sources';
import { classifyPhotoState, type EffectiveState } from './progress';
import type { PhotoState } from '@afterglow/core';
import { createMergedDescendingPager, type MergedPager, type PageFetcher } from './progressPager';

/** One merged-stream item before the state join. */
export interface GridPagedItem {
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
export type GridCursor = string | { takenAt: number; assetId: string };

/** One joined, filtered photo out of the stream. */
export interface LibraryGridPhoto {
  id: string;
  uri: string;
  /** The image cache version (item 3): the DB row's, else MediaStore's
   * own timestamp for an untracked photo. */
  version: number;
  /** A tracked row's dates are the DB's truth; an untracked one has
   * only MediaStore's. */
  takenAt: number;
  /** Tri-state (the grid contract): string = the DB's day; null = an
   * honest no-date claim; undefined = untracked with only MediaStore's
   * timestamp to go on. */
  day: string | null | undefined;
  dbState: PhotoState | null;
  effective: EffectiveState;
}

export interface LibraryGridStream {
  /** Collect up to `batch` photos passing `filter` ('all' or an
   * EffectiveState). Returns what it gathered; check `exhausted()` for
   * the end. A page/join failure calls `onFailure` and ends the pull. */
  collect(batch: number, filter: string): Promise<LibraryGridPhoto[]>;
  exhausted(): boolean;
}

export function createLibraryGridStream(
  db: SQLiteDatabase,
  opts: {
    startMs: number;
    endMs: number;
    albumIds: readonly string[] | null;
    roots: readonly SourceRoot[] | null;
    mounted: readonly string[] | null;
    /** Fail-closed reporting hook — the consumer owns the sticky flag. */
    onFailure: () => void;
  },
): LibraryGridStream {
  const { startMs, endMs, albumIds, roots, mounted, onFailure } = opts;
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const fetchers: PageFetcher<GridPagedItem, GridCursor>[] = buckets.map(
    (album) => async (cursor: GridCursor | undefined, count: number) => {
      // FAIL CLOSED (m0.8.2): an errored page used to become an empty
      // exhausted one, so a MediaStore hiccup rendered "No photos in
      // this state" — a confident, wrong answer about the user's
      // library. Record the failure and say so instead.
      const page = await fetchPhotoPageDesc(
        startMs,
        endMs,
        album,
        cursor as string | undefined,
        count,
      ).catch((error: unknown) => {
        console.warn('[grid] photo page failed:', String(error));
        onFailure();
        return { photos: [], endCursor: undefined, hasNext: false };
      });
      const items: GridPagedItem[] = page.photos.map((p: LoadedPhoto) => ({
        id: p.item.id,
        uri: p.item.uri,
        timestamp: p.item.timestamp,
        undated: p.undated,
        fromDb: false,
      }));
      return {
        items,
        nextCursor: page.hasNext && page.endCursor !== undefined ? page.endCursor : null,
      };
    },
  );
  // One more merge source (m0.8.6 change 4): the DB's rescued rows at
  // their TRUE taken_at — the merge position is decided before any
  // state join runs. Same fail-closed rule as above.
  fetchers.push(async (cursor: GridCursor | undefined, count: number) => {
    const rows = await getRescuedPhotoPage(
      db,
      roots,
      mounted,
      cursor as { takenAt: number; assetId: string } | undefined,
      count,
    ).catch((error: unknown) => {
      console.warn('[grid] rescued page failed:', String(error));
      onFailure();
      return [];
    });
    const items: GridPagedItem[] = rows.map((r) => ({
      id: r.asset_id,
      uri: r.uri,
      timestamp: r.taken_at,
      undated: false,
      fromDb: true,
    }));
    const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
    return {
      items,
      nextCursor:
        rows.length < count || last === undefined
          ? null
          : { takenAt: last.taken_at, assetId: last.asset_id },
    };
  });
  const pager: MergedPager<GridPagedItem> = createMergedDescendingPager<GridPagedItem, GridCursor>(
    fetchers,
    (p) => p.timestamp,
  );

  return {
    exhausted: () => pager.exhausted(),
    async collect(batch, filter) {
      const collected: LibraryGridPhoto[] = [];
      while (collected.length < batch && !pager.exhausted()) {
        const raw = await pager.next(batch);
        if (raw.length === 0) break;
        // FAIL CLOSED like the page fetch beside it: a rejected state
        // join must not fall through as a silently blank (or silently
        // complete) result (codex r4).
        const states = await getStateRowsForAssets(
          db,
          raw.map((p) => p.id),
        ).catch((error: unknown) => {
          console.warn('[grid] state join failed:', String(error));
          onFailure();
          return null;
        });
        if (states === null) break;
        for (const p of raw) {
          const row = states.get(p.id);
          // A rescued photo streams twice (change 4): drop the
          // MediaStore copy sitting at its mtime slot — the rescued
          // stream carries it at its true taken_at.
          if (row?.rescued && !p.fromDb) continue;
          const effective = classifyPhotoState(row);
          if (filter === 'all' || effective === filter) {
            collected.push({
              id: p.id,
              uri: p.uri,
              version: row?.image_version ?? p.timestamp,
              takenAt: row?.taken_at ?? p.timestamp,
              day: row !== undefined ? row.day : p.undated ? null : undefined,
              dbState: row?.state ?? null,
              effective,
            });
          }
        }
      }
      return collected;
    },
  };
}
