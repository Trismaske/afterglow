/**
 * The deck's LIST-SOURCE contract (m0.9 phase 2, P2-1 —
 * docs/Plan_m0.9.md): the deck browses arbitrary photo lists without
 * knowing any surface. A host navigates with a serializable
 * `DeckListDescriptor` in the route params; `resolveDeckListPage` is
 * the ONE resolver the deck calls, and its table delegates to the SAME
 * query functions the host screens use — order and filter parity by
 * construction, one source of truth per list.
 *
 * Adding a surface = one descriptor variant + one table entry; the
 * deck never changes. Runtime functions in params were rejected
 * (serializability breaks navigation state restoration), and a dynamic
 * provider registry was rejected (registration-order and restoration
 * hazards) — the table is static and testable.
 *
 * Liveness (P2-3) is the source's own truth: the deck re-resolves on
 * review-version bumps and external refresh, and each source's query
 * naturally yields the right membership — a queue drops removed rows,
 * a grid/day scope keeps decided photos (badged), History converts to
 * tombstones and filters them here. The photo-anchored cursor bridges
 * every change.
 *
 * Paging: one contract for three shapes. Queue sources return the
 * whole set (`next: null`); History pages by its two-stream keyset
 * cursor; DB-filter grids page by LIMIT/OFFSET. The pager-backed grid
 * filters ('all'/'unreviewed' outside the Unknown day, which ride the
 * MediaStore merged pager) are wired with the Progress host rewire —
 * until then they fail EARLY and named, never silently empty.
 *
 * Purity split: the descriptor codec is pure (unit-tested in
 * deckList.test.ts); the resolver takes `db` and delegates to the
 * store layer (real-DB parity in deckList.real.test.ts).
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getGridPhotosByFilter,
  getHistoryPage,
  getPhotoQueueFacts,
  getToEditPhotos,
  type HistoryCursor,
  type HistoryFilter,
  type HistoryPhotoRow,
  type PhotoScope,
} from '../db/store';
import type { PhotoState } from '@afterglow/core';
import { getShareQueue } from '../db/shareStore';
import { getOrganizeQueue } from '../db/organizeStore';
import { getQueue } from '../db/actions';
import type { SourceRoot } from './sources';
import { UNDATED_DAY_KEY } from './dates';

/** The four action queues, by their photo_actions kind. */
export type DeckListQueue = 'edit' | 'favourite' | 'share' | 'organize';

/** One serializable value in the Deck route's params — the whole list
 * identity. Every variant must survive JSON round-trips (navigation
 * state restoration). */
export type DeckListDescriptor =
  | { source: 'queue'; queue: DeckListQueue }
  | { source: 'history'; filter: HistoryFilter }
  | { source: 'grid'; day: string; filter: string };

/** What the deck renders per list photo — the retired ViewerItem
 * contract plus the tracked flag (P2-5: untracked photos, reachable
 * through pager-backed grids, disable every control). */
export interface DeckListRow {
  id: string;
  uri: string;
  takenAt: number;
  /** Capture day; null = tracked and honestly undated ("Unknown day",
   * no clock — takenAt is the mtime fallback there). */
  day: string | null;
  /** The verdict, for badges and the verdict row's active outline. */
  state: PhotoState;
  tracked: boolean;
}

/** Opaque-to-the-deck paging position, tagged per source shape. */
export type DeckListCursor = { history: HistoryCursor } | { offset: number };

export interface DeckListPage {
  rows: DeckListRow[];
  /** Pass back to fetch the next page; null = the list is complete. */
  next: DeckListCursor | null;
}

const HISTORY_FILTERS: readonly HistoryFilter[] = [
  'all',
  'kept',
  'culled',
  'trashed',
  'to_edit',
  'favourite',
  'organized',
  'shared',
];
const QUEUES: readonly DeckListQueue[] = ['edit', 'favourite', 'share', 'organize'];

/** DB-filter grid page size — mirrors the grids' own incremental loads. */
const GRID_PAGE = 120;

/** GRID_FILTER_SQL's own rule (db/store.ts): these two are DB-backed
 * only for the Unknown day; everywhere else they ride the MediaStore
 * merged pager. */
const PAGER_BACKED_FILTERS: readonly string[] = ['all', 'unreviewed'];

/** One batched verdict read for sources whose queries do not select
 * `state` (the queue lists); grid and History rows carry their own. */
async function statesFor(
  db: SQLiteDatabase,
  ids: readonly string[],
): Promise<Map<string, PhotoState>> {
  const map = new Map<string, PhotoState>();
  if (ids.length === 0) return map;
  const rows = await db.getAllAsync<{ asset_id: string; state: PhotoState }>(
    `SELECT asset_id, state FROM photos WHERE asset_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  for (const r of rows) map.set(r.asset_id, r.state);
  return map;
}

/**
 * Fail-closed param decode: navigation params are outside our type
 * system (deep links, state restoration), so an unrecognized shape
 * returns null and the deck falls back to its unit params — never a
 * half-valid list.
 */
export function listFromParams(value: unknown): DeckListDescriptor | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.source === 'queue') {
    return QUEUES.includes(v.queue as DeckListQueue)
      ? { source: 'queue', queue: v.queue as DeckListQueue }
      : null;
  }
  if (v.source === 'history') {
    return HISTORY_FILTERS.includes(v.filter as HistoryFilter)
      ? { source: 'history', filter: v.filter as HistoryFilter }
      : null;
  }
  if (v.source === 'grid') {
    return typeof v.day === 'string' && typeof v.filter === 'string'
      ? { source: 'grid', day: v.day, filter: v.filter }
      : null;
  }
  return null;
}

/** Stable identity for effect dependencies and unitKey-style stamps. */
export function deckListKey(descriptor: DeckListDescriptor): string {
  switch (descriptor.source) {
    case 'queue':
      return `list:queue:${descriptor.queue}`;
    case 'history':
      return `list:history:${descriptor.filter}`;
    case 'grid':
      return `list:grid:${descriptor.day}:${descriptor.filter}`;
  }
}

/** The one resolver. The two scope axes (mounted volumes, source
 * roots) are EXPLICIT inputs — the deck's list loader re-reads them per
 * resolve exactly as every host screen does per load, and the tests
 * pass them plainly (no native imports in this module). */
export async function resolveDeckListPage(
  db: SQLiteDatabase,
  descriptor: DeckListDescriptor,
  cursor: DeckListCursor | null,
  mounted: readonly string[] | null,
  roots: readonly SourceRoot[] | null,
): Promise<DeckListPage> {
  switch (descriptor.source) {
    case 'queue': {
      switch (descriptor.queue) {
        case 'edit': {
          const rows = await getToEditPhotos(db, mounted, roots);
          const states = await statesFor(
            db,
            rows.map((r) => r.asset_id),
          );
          return {
            rows: rows.map((r) => ({
              id: r.asset_id,
              uri: r.uri,
              takenAt: r.taken_at,
              day: r.day,
              state: states.get(r.asset_id) ?? 'unreviewed',
              tracked: true,
            })),
            next: null,
          };
        }
        case 'share': {
          const rows = await getShareQueue(db, Date.now(), mounted, roots);
          const states = await statesFor(
            db,
            rows.map((r) => r.photo_id),
          );
          return {
            rows: rows.map((r) => ({
              id: r.photo_id,
              uri: r.uri,
              takenAt: r.taken_at,
              day: r.day,
              state: states.get(r.photo_id) ?? 'unreviewed',
              tracked: true,
            })),
            next: null,
          };
        }
        case 'organize': {
          const rows = await getOrganizeQueue(db, mounted, roots);
          const states = await statesFor(
            db,
            rows.map((r) => r.photo_id),
          );
          return {
            rows: rows.map((r) => ({
              id: r.photo_id,
              uri: r.uri,
              takenAt: r.taken_at,
              day: r.day,
              state: states.get(r.photo_id) ?? 'unreviewed',
              tracked: true,
            })),
            next: null,
          };
        }
        case 'favourite': {
          // The FavouritesQueueScreen join, verbatim: the action queue in
          // queued_at order, photo facts fetched per id (capture time, not
          // queue time — the deck renders the day and clock it was taken).
          const actions = await getQueue(db, 'favourite', mounted, roots);
          const byId = await getPhotoQueueFacts(
            db,
            actions.map((a) => a.photoId),
          );
          const states = await statesFor(
            db,
            actions.map((a) => a.photoId),
          );
          return {
            rows: actions.map((action) => ({
              id: action.photoId,
              uri: byId.get(action.photoId)?.uri ?? '',
              takenAt: byId.get(action.photoId)?.takenAt ?? action.queuedAt,
              day: byId.get(action.photoId)?.day ?? null,
              state: states.get(action.photoId) ?? 'unreviewed',
              tracked: true,
            })),
            next: null,
          };
        }
      }
      // Exhaustive by type; unreachable.
      throw new Error(`unknown queue: ${String((descriptor as { queue: unknown }).queue)}`);
    }
    case 'history': {
      const page = await getHistoryPage(
        db,
        descriptor.filter,
        cursor !== null && 'history' in cursor ? cursor.history : null,
      );
      // The HistoryScreen pager filter, verbatim: photo rows only, and
      // never a gone photo — a swipe must not land on a tombstone.
      const rows = page.rows
        .filter(
          (r): r is HistoryPhotoRow =>
            r.kind === 'photo' && r.is_present === 1 && r.state !== 'trashed',
        )
        .map((r) => ({
          id: r.asset_id,
          uri: r.uri,
          takenAt: r.taken_at,
          day: r.day,
          state: r.state,
          tracked: true,
        }));
      return { rows, next: page.next !== null ? { history: page.next } : null };
    }
    case 'grid': {
      // DB-filter grids page SQLite; 'all'/'unreviewed' are DB-backed
      // ONLY for the Unknown day (GRID_FILTER_SQL's own rule) — the
      // MediaStore-pager-backed variants land with the Progress host
      // rewire, and until then this fails EARLY and named.
      if (PAGER_BACKED_FILTERS.includes(descriptor.filter) && descriptor.day !== UNDATED_DAY_KEY) {
        throw new Error(
          `deck list: grid filter '${descriptor.filter}' is MediaStore-pager-backed — wired with the Progress host rewire`,
        );
      }
      const offset = cursor !== null && 'offset' in cursor ? cursor.offset : 0;
      const scope: PhotoScope = { day: descriptor.day };
      const rows = await getGridPhotosByFilter(
        db,
        scope,
        roots,
        descriptor.filter,
        GRID_PAGE,
        offset,
        mounted,
      );
      return {
        rows: rows.map((r) => ({
          id: r.asset_id,
          uri: r.uri,
          takenAt: r.taken_at,
          day: r.day,
          state: r.state,
          tracked: true,
        })),
        next: rows.length === GRID_PAGE ? { offset: offset + GRID_PAGE } : null,
      };
    }
  }
}
