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

import type { StoredMediaKind } from './mediaIdentity';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getGridPhotosByFilter,
  getHistoryPage,
  getPhotoQueueFacts,
  getStatesForAssets,
  motionClipOf,
  type MotionClipRow,
  getToEditPhotos,
  type HistoryCursor,
  type HistoryFilter,
  type HistoryPhotoRow,
  type PhotoScope,
} from '../db/store';
import type { PhotoState } from '@afterglow/core';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { mapWithConcurrency } from './concurrency';
import { isDbFilter, isProgressFilter, type ProgressFilter } from './progress';
import { dayKey } from './dates';
import { getShareQueue } from '../db/shareStore';
import { getOrganizeQueue } from '../db/organizeStore';
import { getQueue } from '../db/actions';
import type { SourceRoot } from './sources';

/** The four action queues, by their photo_actions kind. */
export type DeckListQueue = 'edit' | 'favourite' | 'share' | 'organize';

/** One serializable value in the Deck route's params — the whole list
 * identity. Every variant must survive JSON round-trips (navigation
 * state restoration). */
export type DeckListDescriptor =
  | { source: 'queue'; queue: DeckListQueue }
  | { source: 'history'; filter: HistoryFilter }
  | {
      source: 'grid';
      /** At most one of day/month — the DB-backed grid scopes
       * (PhotoStateGrid's isDbScope rule). NEITHER present = the
       * open-ended LIBRARY scope, which rides the shared MediaStore
       * merged-pager engine (lib/gridPager.ts) so untracked photos
       * appear exactly as the Progress grid shows them. */
      day?: string;
      month?: string;
      filter: ProgressFilter;
    };

/** What the deck renders per list photo — the retired ViewerItem
 * contract plus the tracked flag (P2-5: untracked photos, reachable
 * through pager-backed grids, disable every control). */
export interface DeckListRow {
  id: string;
  uri: string;
  /** The media kind (m0.9 phase 4): the item's MediaStore collection. */
  kind: StoredMediaKind;
  /** A motion photo's clip (phase 5), null otherwise — on the row so the
   * page mounts its overlay synchronously. */
  motion: MotionClipRow | null;
  /** The image cache version (item 3): the row's COALESCE(file_generation, file_mtime). */
  version: number;
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

/** The queue lists' verdict read: their queries do not select `state`
 * (grid and History rows carry their own). The store's CHUNKED reader —
 * a queue is unbounded, and one IN (...) per row tripped SQLite's
 * variable floor past ~999 items (codex, 2026-09-01). */
const statesFor = getStatesForAssets;

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
    if (typeof v.filter !== 'string' || !isProgressFilter(v.filter)) return null;
    if (typeof v.day === 'string' && v.month === undefined)
      return { source: 'grid', day: v.day, filter: v.filter };
    if (typeof v.month === 'string' && v.day === undefined)
      return { source: 'grid', month: v.month, filter: v.filter };
    if (v.day === undefined && v.month === undefined) return { source: 'grid', filter: v.filter };
    return null;
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
      return `list:grid:${descriptor.day ?? (descriptor.month !== undefined ? `m:${descriptor.month}` : 'library')}:${descriptor.filter}`;
  }
}

/** The one resolver. The two scope axes (mounted volumes, source
 * roots) are EXPLICIT inputs — the deck's list loader re-reads them per
 * resolve exactly as every host screen does per load, and the tests
 * pass them plainly (no native imports in this module). */
/** The History source's presence seam (P2-1: the host's per-page
 * MediaStore reconcile moves into the resolver). Native, so the DECK
 * supplies it; the node tests pass none and read the DB as-is — a
 * deliberate, visible omission, never a fallback the app takes. */
export interface PresenceProbe {
  checkPresence: typeof import('./media').checkMediaPresence;
  now: () => number;
  /** The reconcile may dissolve a cached group — the review queue must
   * observe it (the host calls its provider refresh here). */
  onRemoved: () => void;
}

export async function resolveDeckListPage(
  db: SQLiteDatabase,
  descriptor: DeckListDescriptor,
  cursor: DeckListCursor | null,
  mounted: readonly string[] | null,
  roots: readonly SourceRoot[] | null,
  /** Bucket ids of the source selection (library-grid scope only) —
   * null = all folders, exactly as ResolvedSources reports it. */
  albumIds: readonly string[] | null = null,
  probe: PresenceProbe | null = null,
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
              version: r.image_version,
              kind: r.kind,
              motion: motionClipOf(r),
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
              version: r.image_version,
              kind: r.kind,
              motion: motionClipOf(r),
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
              version: r.image_version,
              kind: r.kind,
              motion: motionClipOf(r),
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
              kind: byId.get(action.photoId)?.kind ?? 'photo',
              motion: byId.get(action.photoId)?.motion ?? null,
              version: byId.get(action.photoId)?.imageVersion ?? 0,
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
      let live = page.rows.filter(
        (r): r is HistoryPhotoRow =>
          r.kind === 'photo' && r.is_present === 1 && r.state !== 'trashed',
      );
      // The host's per-page presence reconcile (its screen contract):
      // photos deleted or trashed OUTSIDE Afterglow drop out — only an
      // authoritative 'trashed'/'absent' converges a row, 'unknown'
      // changes nothing (fail-closed). Bounded concurrency: the check
      // is two native calls per photo.
      if (probe !== null && live.length > 0) {
        const ids = live.map((r) => r.asset_id);
        const presences = await mapWithConcurrency(live, 6, (r) =>
          probe.checkPresence({ id: r.asset_id, kind: r.media_kind }),
        );
        const gone = new Set(
          ids.filter((_, i) => presences[i] === 'trashed' || presences[i] === 'absent'),
        );
        if (gone.size > 0) {
          await reconcileExternallyRemoved(db, [...gone], probe.now(), mounted);
          probe.onRemoved();
          live = live.filter((r) => !gone.has(r.asset_id));
        }
      }
      const rows = live.map((r) => ({
        id: r.asset_id,
        uri: r.uri,
        version: r.image_version,
        // The FEED discriminator is `kind` ('photo' row vs share event);
        // the media kind is media_kind.
        kind: r.media_kind,
        motion: motionClipOf(r),
        takenAt: r.taken_at,
        day: r.day,
        state: r.state,
        tracked: true,
      }));
      return { rows, next: page.next !== null ? { history: page.next } : null };
    }
    case 'grid': {
      const offset = cursor !== null && 'offset' in cursor ? cursor.offset : 0;
      if (
        descriptor.day === undefined &&
        descriptor.month === undefined &&
        !isDbFilter(descriptor.filter)
      ) {
        // LIBRARY scope, 'all' / 'unreviewed': the shared MediaStore
        // merged-pager engine (PhotoStateGrid's engine choice — one
        // predicate, lib/progress isDbFilter).
        // Stateless paging over a stateful stream: re-pull delivered +
        // one page from a fresh stream each resolve and slice — the
        // per-bucket cursor fetches are sub-millisecond, and the deck's
        // version-bump reloads re-pull from scratch anyway.
        // Lazy import: gridPager pulls lib/media (expo-media-library, a
        // native module) — a static import would drag it into the node
        // test env, where every OTHER source is exercisable. Only this
        // on-device-only branch pays the load.
        const { createLibraryGridStream } = await import('./gridPager');
        const stream = createLibraryGridStream(db, {
          startMs: 0,
          endMs: Number.POSITIVE_INFINITY,
          albumIds,
          roots,
          mounted,
          // Fail closed by FAILING: a truncated browse list silently
          // missing photos would masquerade as membership truth.
          onFailure: () => {
            throw new Error('deck list: library grid page failed');
          },
        });
        const pulled = await stream.collect(offset + GRID_PAGE, descriptor.filter);
        const page = pulled.slice(offset);
        return {
          rows: page.map((r) => ({
            id: r.id,
            uri: r.uri,
            kind: r.kind,
            motion: r.motion,
            version: r.version,
            takenAt: r.takenAt,
            // The tri-state collapses for the deck row: an untracked
            // photo's only date claim is MediaStore's own timestamp —
            // the same claim the grid tile renders — so the badge says
            // that day rather than a false "Unknown day".
            day: r.day !== undefined ? r.day : dayKey(r.takenAt),
            state: r.dbState ?? 'unreviewed',
            tracked: r.dbState !== null,
          })),
          next:
            stream.exhausted() && pulled.length < offset + GRID_PAGE
              ? null
              : { offset: offset + page.length },
        };
      }
      // Every day and month scope is DB-backed (m0.8.6 change 1 —
      // PhotoStateGrid's isDbScope), every filter included — and so is
      // the LIBRARY scope under a verdict or action filter (S23,
      // 2026-09-01: a Progress 'favourite' tile opened a deck that
      // streamed MediaStore against a filter the stream can never
      // match, resolved empty, and bounced straight back to the grid).
      const scope: PhotoScope =
        descriptor.day !== undefined
          ? { day: descriptor.day }
          : descriptor.month !== undefined
            ? { month: descriptor.month }
            : { startMs: 0, endMs: Number.POSITIVE_INFINITY };
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
          version: r.image_version,
          kind: r.kind,
          motion: motionClipOf(r),
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
