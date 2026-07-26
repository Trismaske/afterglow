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
import {
  checkMediaPresence,
  fetchPhotoPageDesc,
  getAssetDetails,
  type LoadedPhoto,
} from '../lib/media';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { createMergedDescendingPager, type PageFetcher } from '../lib/progressPager';
import { frozenPhotos, reconcileWindowGroups } from '../lib/regroupBoundary';
import { createWindowAccumulator } from '../lib/scanWindows';
import { resolveSources } from '../lib/sourceCatalog';
import { GROUPING_STRICTNESS_KEY, parseStrictness } from '../lib/groupingPrefs';
import { waitForUserWrites } from '../lib/writePriority';
import { ensureEmbeddingModel } from '../db/embeddingStore';
import {
  getGroupAssignments,
  getGroupMembers,
  getMetadataGroupIds,
  getPresentAssetIds,
  getSetting,
  getStatesForAssets,
  updatePhotoUri,
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
/** Bumped by requestRescan: a running flight captures its generation and
 * stops persisting once superseded — groups written under old settings
 * (source/strictness) would repopulate what the change just reset. */
let scanGeneration = 0;

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
 * A scan-relevant setting changed (photo source, grouping strictness):
 * run a fresh scan over the new configuration. An in-flight run finishes
 * against its old settings first (interrupting it would waste its
 * persisted progress for nothing — the queued rescan re-reads every
 * setting when it starts).
 */
export function requestRescan(db: SQLiteDatabase): Promise<void> {
  if (flight) {
    rescanQueued = true;
    supersedeScan();
    return flight;
  }
  return startContinuousScan(db);
}

/**
 * Stop any in-flight scan from persisting further windows (it exits at
 * the next boundary; persisted progress stays). Settings flows call this
 * BEFORE resetting/refreshing so the old flight cannot repopulate what
 * the change is about to reset — then requestRescan starts the new run.
 */
export function supersedeScan(): void {
  scanGeneration += 1;
}

async function scan(db: SQLiteDatabase): Promise<void> {
  const generation = scanGeneration;
  const superseded = (): boolean => generation !== scanGeneration;
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
      // Open-ended: undated photos (no DATE_TAKEN) must enter the scan.
      const page = await fetchPhotoPageDesc(0, Number.POSITIVE_INFINITY, albumId, cursor, count);
      return { items: page.photos, nextCursor: page.hasNext ? (page.endCursor ?? null) : null };
    },
  );
  const pager = createMergedDescendingPager(fetchers, (photo) => photo.item.timestamp);

  // Grouping strictness (gate 4): the ONE user control over the engine —
  // read once per run; a change mid-run applies from the next scan.
  const strictness = parseStrictness(await getSetting(db, GROUPING_STRICTNESS_KEY));

  const accumulator = createWindowAccumulator(ADJACENT_MERGE_MAX_GAP_MS);
  const engine = newEngineHealth();
  const seenIds = new Set<string>();
  // MediaStore orders the stream by DATE_TAKEN — undated photos land at
  // the END with mtime-fallback timestamps that would violate the
  // accumulator's descending contract. They get their own ordered passes
  // in memory-bounded BATCHES: every batch sorts by effective time and
  // windows among itself (a boundary may split a would-be window — the
  // price of not buffering an unbounded undated set, e.g. WhatsApp
  // libraries where DATE_TAKEN is commonly null). Nothing is discarded.
  const undated: LoadedPhoto[] = [];
  const UNDATED_BATCH = 5_000;
  const processUndatedBatch = async (batch: LoadedPhoto[]): Promise<void> => {
    if (batch.length === 0) return;
    const tail = createWindowAccumulator(ADJACENT_MERGE_MAX_GAP_MS);
    for (const photo of batch.sort((a, b) => b.item.timestamp - a.item.timestamp)) {
      for (const window of tail.feed(photo)) {
        if (superseded()) return; // same fence as the dated stream
        await processWindow(db, window, engine, strictness.baseThreshold, superseded);
      }
    }
    for (const window of tail.flush()) {
      if (superseded()) return;
      await processWindow(db, window, engine, strictness.baseThreshold, superseded);
    }
  };
  for (;;) {
    if (superseded()) {
      console.log('[scan] superseded by a settings change — stopping for the queued rescan');
      return;
    }
    const photos = await pager.next(SCAN_PAGE_SIZE);
    if (photos.length === 0) break;
    for (const photo of photos) seenIds.add(photo.item.id);
    update({ scanned: status.scanned + photos.length });
    for (const photo of photos) {
      if (photo.undated) {
        undated.push(photo);
        if (undated.length >= UNDATED_BATCH) await processUndatedBatch(undated.splice(0));
        continue;
      }
      for (const window of accumulator.feed(photo)) {
        if (superseded()) {
          console.log('[scan] superseded by a settings change — stopping for the queued rescan');
          return;
        }
        await processWindow(db, window, engine, strictness.baseThreshold, superseded);
      }
    }
  }
  if (superseded()) {
    console.log('[scan] superseded by a settings change — stopping for the queued rescan');
    return;
  }
  for (const window of accumulator.flush()) {
    if (superseded()) {
      console.log('[scan] superseded by a settings change — stopping for the queued rescan');
      return;
    }
    await processWindow(db, window, engine, strictness.baseThreshold, superseded);
  }
  await processUndatedBatch(undated.splice(0));
  // Backstop for tiny corpora that never reached the consecutive-error
  // threshold: a scan with engine errors and literally zero successes must
  // never end as 'done' with time-only groups posing as grouped output.
  if (engine.attempts > 0 && engine.successes === 0 && (engine.dead || engine.engineErrors > 0)) {
    throw new Error(
      `embedding engine unavailable — ${engine.engineErrors} engine errors, ` +
        `0 of ${engine.attempts} fresh embeds succeeded`,
    );
  }
  // A COMPLETE pass enumerated every in-source MediaStore photo, so a
  // tracked present row the pager never met was removed outside Afterglow.
  // Absence-from-enumeration alone is not authoritative (photos can land
  // mid-scan behind the cursor), so each candidate gets the tri-state
  // presence check and only verified 'trashed'/'absent' rows converge —
  // exactly the History reconciliation contract.
  const tracked = await getPresentAssetIds(db, sources.roots ?? null);
  const unseen = tracked.filter((id) => !seenIds.has(id));
  const RECONCILE_CAP = 500;
  if (unseen.length > RECONCILE_CAP) {
    // Loud, once: the remainder reconciles on later scans/History pages.
    console.warn(
      `[scan] ${unseen.length} unseen tracked photos — verifying only ${RECONCILE_CAP} this run`,
    );
  }
  const gone: string[] = [];
  let movedUris = 0;
  for (const id of unseen.slice(0, RECONCILE_CAP)) {
    const presence = await checkMediaPresence(id);
    if (presence === 'trashed' || presence === 'absent') {
      gone.push(id);
    } else if (presence === 'present') {
      // Present but NOT enumerated: the photo moved (same MediaStore id,
      // new path — e.g. out of the selected source). Refresh its uri so
      // source-scoped reads stop surfacing it under the stale path.
      const details = await getAssetDetails(id);
      if (details?.uri) {
        await updatePhotoUri(db, id, details.uri);
        movedUris += 1;
      }
    }
  }
  if (movedUris > 0) console.log(`[scan] refreshed ${movedUris} moved photo paths`);
  if (gone.length > 0) {
    await reconcileExternallyRemoved(db, gone, Date.now());
    console.log(`[scan] reconciled ${gone.length} externally removed photos`);
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
  baseThreshold: number,
  stale?: () => boolean,
): Promise<void> {
  // WRITE PRIORITY (vetted): a pending user decision reaches SQLite
  // before this window's transactions.
  await waitForUserWrites();
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
    { baseThreshold },
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

  const frozen = frozenPhotos(ids, {
    states,
    assignments,
    groupMembers: members,
    metadataGroups: await getMetadataGroupIds(db, touchedGroups),
  });
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
        // Undated photos carry NO day: their timestamp is only the mtime
        // fallback, and the day surfaces exclude them on both sides.
        day: p.undated ? null : dayKey(p.item.timestamp),
        volumeName: p.volumeName,
        rawId: p.rawId,
      })),
      groups: plan.groups,
      singles: plan.singles,
    },
    Date.now(),
    // Checked INSIDE the exclusive transaction: a window superseded
    // mid-embed must not commit after the strictness reset cleared the
    // queue (the entry fence alone leaves that race open).
    { abortIf: stale },
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
