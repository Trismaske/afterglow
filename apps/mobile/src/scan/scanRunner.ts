/**
 * Continuous-scan orchestrator (m0.8 gate 2) — the impure driver over the
 * pure pieces: media paging (lib/media.ts via lib/progressPager.ts),
 * merge-window accumulation (lib/scanWindows.ts), embedding backfill
 * (lib/embeddings.ts), dHash floor (lib/similarityHashes.ts), the core
 * engine (@afterglow/core groupByEmbedding), the regroup boundary
 * (lib/regroupBoundary.ts), and durable writes (db/store.ts
 * writeContinuousGroups).
 *
 * On app open (Home, once permission is granted) the scan pages the
 * configured sources newest→oldest; each closed merge window is embedded
 * (cache-aware, per-photo persistence — interrupt-safe: a killed run
 * loses only in-flight work and resumes from the durable tables next
 * open) and grouped, and its groups land in the durable 'continuous'
 * grouping run. One flight per process at a time; a finished run may be
 * started again (next app open / after a source change).
 *
 * Status is a tiny observable snapshot for the Home surfaces (gate 4
 * consumes it; until then it also feeds dev logging).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding, MOMENTS_GAP_MS } from '@afterglow/core';
import { MODEL_SHA256 } from '../../modules/image-embedder';
import { dayKey } from '../lib/dates';
import { ensureEmbeddings, newEngineHealth, type EngineHealth } from '../lib/embeddings';
import { fetchPhotoPageDesc, type LoadedPhoto } from '../lib/media';
import { createMergedDescendingPager, type PageFetcher } from '../lib/progressPager';
import { frozenPhotos, reconcileWindowGroups } from '../lib/regroupBoundary';
import { createWindowAccumulator } from '../lib/scanWindows';
import { resolveSources } from '../lib/sourceCatalog';
import { ensureEmbeddingModel } from '../db/embeddingStore';
import {
  getGroupAssignments,
  getGroupMembers,
  getStatesForAssets,
  writeContinuousGroups,
} from '../db/store';

const SCAN_PAGE_SIZE = 200;

export interface ScanStatus {
  phase: 'idle' | 'scanning' | 'done' | 'error';
  /** Photos paged past so far this run. */
  scanned: number;
  /** Embeddings computed fresh this run (cache hits not counted). */
  embedded: number;
  /** Merge windows grouped and persisted this run. */
  windowsGrouped: number;
  /** A model swap discarded stored vectors at the start of this run. */
  modelReembed: boolean;
  error?: string;
}

const IDLE: ScanStatus = {
  phase: 'idle',
  scanned: 0,
  embedded: 0,
  windowsGrouped: 0,
  modelReembed: false,
};

let status: ScanStatus = IDLE;
const listeners = new Set<(status: ScanStatus) => void>();

export function getScanStatus(): ScanStatus {
  return status;
}

export function subscribeScanStatus(listener: (status: ScanStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(patch: Partial<ScanStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

let flight: Promise<void> | null = null;
let rescanQueued = false;

/**
 * Start the continuous scan unless one is already running; resolves when
 * the run finishes. Errors land in the status (phase 'error') and never
 * throw — the next app open retries from durable state.
 */
export function startContinuousScan(db: SQLiteDatabase): Promise<void> {
  if (flight) return flight;
  flight = scan(db)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[scan] failed:', message);
      update({ phase: 'error', error: message });
    })
    .finally(() => {
      flight = null;
      if (rescanQueued) {
        rescanQueued = false;
        void startContinuousScan(db);
      }
    });
  return flight;
}

/**
 * The configured photo source changed: run a fresh scan over the new
 * selection. An in-flight run finishes against its old buckets first
 * (interrupting it would waste its persisted progress for nothing — the
 * queued rescan re-reads the setting when it starts).
 */
export function rescanAfterSourceChange(db: SQLiteDatabase): Promise<void> {
  if (flight) {
    rescanQueued = true;
    return flight;
  }
  return startContinuousScan(db);
}

async function scan(db: SQLiteDatabase): Promise<void> {
  status = { ...IDLE, phase: 'scanning' };
  update({});

  const model = await ensureEmbeddingModel(db, MODEL_SHA256);
  if (model.cleared) {
    // Deliberate, loud, once: the pinned model changed, stored vectors are
    // incompatible, and the whole corpus re-embeds this run.
    console.warn(`[scan] embedding model changed — discarded ${model.discarded} stored vectors`);
    update({ modelReembed: true });
  }

  const sources = await resolveSources(db);
  const buckets: (string | undefined)[] = sources.albumIds ?? [undefined];
  const fetchers: PageFetcher<LoadedPhoto, string>[] = buckets.map(
    (albumId) => async (cursor, count) => {
      const page = await fetchPhotoPageDesc(0, Date.now(), albumId, cursor, count);
      return { items: page.photos, nextCursor: page.hasNext ? (page.endCursor ?? null) : null };
    },
  );
  const pager = createMergedDescendingPager(fetchers, (photo) => photo.item.timestamp);

  const accumulator = createWindowAccumulator(ADJACENT_MERGE_MAX_GAP_MS);
  const engine = newEngineHealth();
  for (;;) {
    const photos = await pager.next(SCAN_PAGE_SIZE);
    if (photos.length === 0) break;
    update({ scanned: status.scanned + photos.length });
    for (const photo of photos) {
      for (const window of accumulator.feed(photo)) {
        await processWindow(db, window, engine);
      }
    }
  }
  for (const window of accumulator.flush()) {
    await processWindow(db, window, engine);
  }
  // Backstop for tiny corpora that never reached the consecutive-error
  // threshold: a scan with engine errors and literally zero successes must
  // never end as 'done' with time-only groups posing as grouped output.
  if (engine.attempts > 0 && engine.successes === 0 && (engine.dead || engine.engineErrors > 0)) {
    throw new Error(
      `embedding engine unavailable — ${engine.engineErrors} engine errors, ` +
        `0 of ${engine.attempts} fresh embeds succeeded`,
    );
  }
  update({ phase: 'done' });
  // One summary line per run — the only permanent scan log besides errors
  // (release builds have no inspectable DB; this is the field diagnostic).
  console.log(
    `[scan] done: scanned ${status.scanned}, embedded ${status.embedded} fresh, ` +
      `${status.windowsGrouped} windows grouped`,
  );
}

/** Embed, group, reconcile, and persist one closed merge window. */
async function processWindow(
  db: SQLiteDatabase,
  window: LoadedPhoto[],
  engine: EngineHealth,
): Promise<void> {
  const ids = window.map((p) => p.item.id);

  // dHash floor input rides the embed pipeline (module-computed from the
  // same decode — never the manipulator path, which leaks at corpus
  // scale); only bursts with company can contain near-dup pairs, so
  // singles-only windows skip the hash work entirely.
  const withHashes = hasMultiPhotoBurst(window);
  const { vectors, hashes } = await ensureEmbeddings(
    db,
    window,
    (_done, _total, ok) => {
      // Only PERSISTED embeddings count — failures must not inflate the
      // completion metrics or the summary log.
      if (ok) update({ embedded: status.embedded + 1 });
    },
    withHashes,
    engine,
  );
  // Abort BEFORE this window is written: a dead engine (absent module or
  // repeated engine-level errors with zero successes) must not persist
  // time-attached groups masquerading as grouped output.
  if (engine.dead) {
    throw new Error(
      `embedding engine unavailable — ${engine.engineErrors} engine errors, ` +
        `${engine.successes} successes in ${engine.attempts} attempts`,
    );
  }

  const groups = groupByEmbedding(
    window.map((p) => p.item),
    (id) => vectors.get(id) ?? null,
    withHashes ? (id) => hashes.get(id) ?? null : undefined,
  );

  // Regroup boundary (decision 5): freeze photos whose current group has
  // been touched by review; states are fetched for the window AND every
  // member of any group the window intersects.
  const assignments = await getGroupAssignments(db, ids);
  const touchedGroups = [
    ...new Set(
      [...assignments.values()].map((a) => a.groupId).filter((g): g is number => g !== null),
    ),
  ];
  const members = await getGroupMembers(db, touchedGroups);
  const stateIds = new Set(ids);
  for (const memberIds of members.values()) for (const id of memberIds) stateIds.add(id);
  const states = await getStatesForAssets(db, [...stateIds]);

  const frozen = frozenPhotos(ids, { states, assignments, groupMembers: members });
  const plan = reconcileWindowGroups(
    groups.map((g) => ({
      members: g.items.map((item) => item.id),
      timeAttached: g.timeAttached,
    })),
    frozen,
  );

  await writeContinuousGroups(
    db,
    {
      photos: window.map((p) => ({
        assetId: p.item.id,
        uri: p.item.uri,
        takenAt: p.item.timestamp,
        modTime: p.modTime,
        day: dayKey(p.item.timestamp),
        volumeName: p.volumeName,
        rawId: p.rawId,
      })),
      groups: plan.groups,
      singles: plan.singles,
    },
    Date.now(),
  );
  update({ windowsGrouped: status.windowsGrouped + 1 });
}

/** Does any 3-min burst in this (chronological) window hold ≥ 2 photos? */
function hasMultiPhotoBurst(window: readonly LoadedPhoto[]): boolean {
  for (let i = 1; i < window.length; i++) {
    if (window[i].item.timestamp - window[i - 1].item.timestamp <= MOMENTS_GAP_MS) return true;
  }
  return false;
}
