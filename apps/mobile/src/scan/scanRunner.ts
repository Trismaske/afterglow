/**
 * Continuous-scan orchestrator (m0.8 gate 2) — the impure driver over the
 * pure pieces: media paging (lib/media.ts via lib/progressPager.ts),
 * merge-window accumulation (lib/scanWindows.ts), embedding backfill
 * (lib/embeddings.ts), dHash floor (lib/similarityHashes.ts), the core
 * engine (@afterglow/core groupByEmbedding), and durable writes
 * (db/store.ts writeContinuousGroups).
 *
 * On app open (Home, once permission is granted) the scan pages the
 * configured sources newest→oldest; each closed merge window is embedded
 * (cache-aware, per-photo persistence — interrupt-safe: a killed run
 * loses only in-flight work and resumes from the durable tables next
 * open) and grouped, and its groups land in the durable 'continuous'
 * grouping run. One flight per process at a time; a finished run may be
 * started again (next app open / after a source change).
 *
 * GROUPS LAND AS TRUTH (v22, docs/Regroup_design.md): grouping is pure
 * presentation — photos own their review state, and every pass rewrites
 * membership freely, decided members included. The one durable user
 * judgment about membership is the "not related" pair set, injected into
 * the engine as cannot-link constraints and revalidated inside the write
 * transaction. The in-transaction decision-write guards (store.ts)
 * protect verdicts against stale renders; nothing protects membership,
 * because membership is not state.
 *
 * Status is a tiny observable snapshot for the Home surfaces (gate 4
 * consumes it; until then it also feeds dev logging).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding, MOMENTS_GAP_MS } from '@afterglow/core';
import { MODEL_SHA256 } from '../../modules/image-embedder';
import { dayKey, exifDateTimeToMs } from '../lib/dates';
import { ensureEmbeddings, newEngineHealth, type EngineHealth } from '../lib/embeddings';
import {
  checkMediaPresence,
  countPhotosInRange,
  fetchPhotoPageDesc,
  getAssetDetails,
  getEditableContentUri,
  loadPhotoById,
  type LoadedPhoto,
} from '../lib/media';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { createMergedDescendingPager, type PageFetcher } from '../lib/progressPager';
import { createWindowAccumulator } from '../lib/scanWindows';
import { resolveSources } from '../lib/sourceCatalog';
import type { SourceRoot } from '../lib/sources';
import { GROUPING_STRICTNESS_KEY, parseStrictness } from '../lib/groupingPrefs';
import {
  SCAN_FINGERPRINT_KEY,
  SCAN_GENERATIONS_KEY,
  scanCanSkip,
  scanFingerprint,
} from '../lib/scanSkip';
import {
  getFavouriteImageIds,
  getImageCountsByVolume,
  getMediaChangedSince,
  getMediaGenerations,
  getMountedVolumes,
  mediaStoreActionsAvailable,
  readExifDateTimeOriginal,
  type ChangedMediaRow,
} from '../../modules/media-store-actions';
import { canonicalPhotoId, volumeOf } from '../lib/mediaIdentity';
import {
  filterGenerationsToVolumes,
  mergeGenerationBaselines,
  neverSeenVolumes,
  missingGenerationVolumes,
  rawVolumeOfKey,
  scopeRelevantVolumes,
  volumesDisagreeingAfterDelta,
  volumesWithUntracedLoss,
  type VolumeCountRow,
} from '../lib/volumeScan';
import {
  coveredBy,
  describeDeltaPlan,
  deltaVerdict,
  filterChangedToSources,
  planDeltaRanges,
  rangesForTargets,
} from '../lib/deltaScan';
import { mapWithConcurrency } from '../lib/concurrency';
import { waitForUserWrites } from '../lib/writePriority';
import { fileSize } from '../lib/hash';
import { ensureEmbeddingModel } from '../db/embeddingStore';
import {
  countPresentPhotos,
  countTrackedByVolume,
  getNotRelatedPairsAmong,
  getPhotoTimestamps,
  getRescueBaselines,
  getTakenAtForAssets,
  getPresentAssetIds,
  getSetting,
  setSetting,
  updatePhotoUri,
  writeContinuousGroups,
} from '../db/store';

const SCAN_PAGE_SIZE = 200;
/**
 * When the library was last VERIFIED current (epoch ms, as a string).
 *
 * Written by a complete clean pass AND by a skip, because a skip is
 * OS-level proof that nothing changed — just as good an answer to "are
 * my numbers current?" as a pass, and cheaper. Recording only passes
 * would leave a phone that verifies daily reading "last full pass 6 days
 * ago", implying a staleness it has actually disproved every day
 * (m0.8.2).
 */
export const SCAN_VERIFIED_AT_KEY = 'scan_verified_at';
/** When the last FULL pass finished (epoch ms). Distinct from the
 * verification stamp: only a full pass enumerates everything, so only a
 * full pass can find a photo deleted with no trace. */
const SCAN_FULL_AT_KEY = 'scan_full_at';
/** A full pass runs at least this often, whatever the delta thinks.
 * The backstop for the one deletion a delta cannot see: a PERMANENT
 * delete (no trash) hidden behind an add, which leaves the counts equal
 * and the change query silent. Insurance while the delta is young —
 * revisited in docs/TODO.md ("Revisit the weekly full pass"). */
const FULL_PASS_MAX_AGE_MS = 7 * 86_400_000;

export interface ScanStatus {
  phase: 'idle' | 'scanning' | 'done' | 'error';
  /** Photos paged past so far this run. */
  scanned: number;
  /** Embeddings computed fresh this run (cache hits not counted). */
  embedded: number;
  /** Merge windows grouped and persisted this run. */
  windowsGrouped: number;
  /** THIS pass's progress denominator (m0.8.2, F3 — Home and Settings
   * render the percent from it): the in-source
   * MediaStore count for a FULL pass; null for a delta (its coverage is
   * a handful of ranges — the line shows counts instead) and until the
   * cheap totalCount query lands or when it failed (the scan itself
   * never depends on it). Clamp on use: photos land mid-scan. */
  total: number | null;
  /** The library-size snapshot taken at pass start (F4): while a scan
   * runs, Home's "N pictures total" line reads THIS number, so the card
   * and the scan line can never quote two different library sizes. For
   * a full pass it equals `total` by construction. */
  corpusTotal: number | null;
  /** A model swap discarded stored vectors at the start of this run. */
  modelReembed: boolean;
  error?: string;
}

const IDLE: ScanStatus = {
  phase: 'idle',
  scanned: 0,
  embedded: 0,
  windowsGrouped: 0,
  total: null,
  corpusTotal: null,
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
/** Eject/un-eject re-placement requests (m0.8.7, Regroup_design §5):
 * each is one photo whose window should re-page NOW rather than on the
 * next natural pass. Drained by the next flight, which runs a TARGETED
 * pass instead of a full one — through the same single-flight, the same
 * range machinery, and the same status line as any small delta. */
const pendingTargets: RescanTarget[] = [];
/** Bumped by requestRescan: a running flight captures its generation and
 * stops persisting once superseded — groups written under old settings
 * (source/strictness) would repopulate what the change just reset. */
let scanGeneration = 0;

export interface RescanTarget {
  assetId: string;
  /** photos.taken_at — the window walk's anchor for a dated photo. */
  takenAtMs: number;
  /** photos.day IS NULL: no range can fetch it — the pass lands it by
   * direct per-id fetch instead (the F27 machinery). */
  undated: boolean;
}

/**
 * Re-place one photo through a TARGETED window rescan (Regroup_design
 * §5): the eject/un-eject flows call this so the regroup lands in
 * seconds through the normal pipeline instead of waiting for the next
 * natural pass. Routed through the single-flight; a running pass drains
 * the target when it finishes.
 */
export function requestTargetedRescan(db: SQLiteDatabase, target: RescanTarget): Promise<void> {
  pendingTargets.push(target);
  return startContinuousScan(db);
}

/**
 * Start the continuous scan unless one is already running; resolves when
 * the run finishes. Errors land in the status (phase 'error') and never
 * throw — the next app open retries from durable state.
 */
export function startContinuousScan(
  db: SQLiteDatabase,
  options: { force?: boolean } = {},
): Promise<void> {
  if (flight) return flight;
  const force = options.force ?? false;
  flight = scan(db, force)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[scan] failed:', message);
      update({ phase: 'error', error: message });
    })
    .finally(() => {
      flight = null;
      if (rescanQueued) {
        rescanQueued = false;
        // A queued rescan came from a settings apply/reset — forced (it
        // may rewrite scan OUTPUT without changing scan INPUT).
        void startContinuousScan(db, { force: true });
      } else if (pendingTargets.length > 0) {
        // Targets that arrived mid-flight drain in their own pass.
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
  // FORCED: setting applies and resets rewrite scan output (groups,
  // scopes) without necessarily changing the fingerprint's inputs —
  // the unchanged-library skip must not swallow them.
  return startContinuousScan(db, { force: true });
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

/** The whole library, in the shape a delta range takes — a full pass is
 * a delta pass over one unbounded range, which is why they share code. */
const FULL_RANGE = { startMs: 0, endMs: Number.POSITIVE_INFINITY };

interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * Page these time ranges and group every merge window they close.
 *
 * THE SAME function serves a full pass (one unbounded range) and a delta
 * pass (the walked windows around what changed). Sharing it is what makes
 * "a delta produces the groups a full pass would" structural rather than
 * a claim: the two cannot drift apart, because there is only one of them.
 *
 * Returns the ids enumerated, or null when a settings change superseded
 * the run mid-flight.
 */
async function pageAndGroup(
  db: SQLiteDatabase,
  args: {
    ranges: readonly TimeRange[];
    albumIds: readonly string[] | undefined;
    baseThreshold: number;
    engine: EngineHealth;
    superseded: () => boolean;
    /** Raw volume names mounted at pass start (m0.8.3, D7) — REQUIRED
     * (acquisition failure aborts the pass before this runs). A parsed
     * volume outside the set is skipped fail-closed and counted, like an
     * unparseable one. */
    mountedVolumes: ReadonlySet<string>;
    /** Pass-start IS_FAVORITE snapshot (F20); null = read failed. */
    favourites: ReadonlySet<string> | null;
    /** Changed UNDATED photos to land by DIRECT per-id fetch (F27): no
     * DATE_TAKEN range can cover them, and the old fallback walked the
     * whole corpus for each one. They join the undated batch and take
     * the same rescue/window path a full pass gives them. Omit/empty for
     * full passes (the unbounded walk already returns them). */
    undatedIds?: readonly string[];
  },
): Promise<{ seenIds: Set<string>; skipped: number; exifFailed: number } | null> {
  const { ranges, albumIds, baseThreshold, engine, superseded, mountedVolumes, favourites } = args;
  // Fail-closed drops this pass: unparseable volumes (counted by the
  // adapter per page) plus parsed volumes outside the mounted set. Any
  // skip makes the pass ineligible to advance its baselines (finishPass).
  let skipped = 0;
  // EXIF reads attempted but never completed (codex r2): the pass may
  // finish, but storing its fingerprint would let the unchanged-library
  // skip hide the promised retry.
  let exifFailed = 0;
  const unmountedWarned = new Set<string>();
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  // One fetcher per (range × bucket), merged into ONE descending stream —
  // so a window straddling two ranges still reaches the accumulator in
  // order, exactly as it would in a single unbounded walk.
  const fetchers: PageFetcher<LoadedPhoto, string>[] = [];
  for (const range of ranges) {
    for (const albumId of buckets) {
      // INCLUSIVE bounds → EXCLUSIVE query. fetchPhotoPageDesc renders
      // `DATE_TAKEN > start AND DATE_TAKEN < end`, but a walked window's
      // bounds ARE photos — so querying them raw drops the window's first
      // and last members, and a single-photo window matches nothing at
      // all. Timestamps are whole milliseconds, so widening by 1 ms
      // includes exactly the boundary photos and nothing else.
      const from = range.startMs > 0 ? range.startMs - 1 : 0;
      const to = Number.isFinite(range.endMs) ? range.endMs + 1 : range.endMs;
      fetchers.push(async (cursor, count) => {
        const page = await fetchPhotoPageDesc(from, to, albumId, cursor, count);
        skipped += page.skipped;
        return { items: page.photos, nextCursor: page.hasNext ? (page.endCursor ?? null) : null };
      });
    }
  }
  const pager = createMergedDescendingPager(fetchers, (photo) => photo.item.timestamp);

  const accumulator = createWindowAccumulator(ADJACENT_MERGE_MAX_GAP_MS);
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
  let stopped = false;
  const processUndatedBatch = async (batch: LoadedPhoto[]): Promise<void> => {
    if (batch.length === 0) return;
    // D15 EXIF date rescue, BEFORE the batch sorts and windows: rescued
    // photos window among the batch under their REAL timestamps, and the
    // write below lands the real day.
    exifFailed += await applyExifDateRescue(db, batch);
    const tail = createWindowAccumulator(ADJACENT_MERGE_MAX_GAP_MS);
    for (const photo of batch.sort((a, b) => b.item.timestamp - a.item.timestamp)) {
      for (const window of tail.feed(photo)) {
        if (superseded()) {
          stopped = true;
          return;
        }
        await processWindow(
          db,
          window,
          engine,
          baseThreshold,
          superseded,
          mountedVolumes,
          favourites,
        );
      }
    }
    for (const window of tail.flush()) {
      if (superseded()) {
        stopped = true;
        return;
      }
      await processWindow(
        db,
        window,
        engine,
        baseThreshold,
        superseded,
        mountedVolumes,
        favourites,
      );
    }
  };
  for (;;) {
    if (superseded()) return null;
    const paged = await pager.next(SCAN_PAGE_SIZE);
    if (paged.length === 0) break;
    // Mounted-set validation (m0.8.3, D7): a parsed volume the OS does
    // not currently enumerate is fail-closed — MediaStore returning rows
    // for it would contradict the pass-start snapshot, and ingesting
    // them would stamp identity the scan cannot verify.
    const photos = paged.filter((photo) => {
      if (mountedVolumes.has(photo.volumeName)) return true;
      skipped += 1;
      if (!unmountedWarned.has(photo.volumeName)) {
        unmountedWarned.add(photo.volumeName);
        console.warn(
          `[scan] volume '${photo.volumeName}' is not in the mounted set — ` +
            `its photos are skipped this pass`,
        );
      }
      return false;
    });
    if (photos.length === 0) continue;
    for (const photo of photos) seenIds.add(photo.item.id);
    update({ scanned: status.scanned + photos.length });
    for (const photo of photos) {
      if (photo.undated) {
        undated.push(photo);
        if (undated.length >= UNDATED_BATCH) {
          await processUndatedBatch(undated.splice(0));
          if (stopped) return null;
        }
        continue;
      }
      for (const window of accumulator.feed(photo)) {
        if (superseded()) return null;
        await processWindow(
          db,
          window,
          engine,
          baseThreshold,
          superseded,
          mountedVolumes,
          favourites,
        );
      }
    }
  }
  if (superseded()) return null;
  for (const window of accumulator.flush()) {
    if (superseded()) return null;
    await processWindow(db, window, engine, baseThreshold, superseded, mountedVolumes, favourites);
  }
  // F27's direct landing: fetch each changed undated photo by id and
  // feed it into the undated batch below. A fetch failure is a
  // fail-closed skip — the pass keeps its results but withholds its
  // baselines, so the next open retries the photo.
  let fetched = 0;
  for (const id of args.undatedIds ?? []) {
    if (superseded()) return null;
    const photo = await loadPhotoById(id);
    if (photo === null) {
      skipped += 1;
      continue;
    }
    seenIds.add(photo.item.id);
    undated.push(photo);
    fetched += 1;
  }
  if (fetched > 0) {
    update({ scanned: status.scanned + fetched });
    console.log(`[scan] delta: ${fetched} undated changed photo(s) landed by direct fetch`);
  }
  await processUndatedBatch(undated.splice(0));
  return stopped ? null : { seenIds, skipped, exifFailed };
}

/**
 * The mid-pass mount fence (m0.8.3 phase 2, codex): the mounted set is
 * snapshotted at pass start, and a card ejected (or inserted) AFTER that
 * snapshot silently changes what merged paging returns while the
 * snapshot-based reachability freeze still trusts the old world. Every
 * write boundary re-reads the live set and ABORTS the pass on any
 * difference — persisted progress survives (interrupt-safe by design),
 * baselines are never stored, and the next open rescans under the new
 * reality. Throws also when the live read itself fails: a fence that
 * cannot see is not a fence.
 */
async function assertMountedUnchanged(baseline: ReadonlySet<string>): Promise<void> {
  const now = new Set(await getMountedVolumes());
  const changed = now.size !== baseline.size || [...baseline].some((v) => !now.has(v));
  if (changed) {
    throw new Error(
      `storage volumes changed mid-scan (was ${[...baseline].join(',')}; now ${[...now].join(
        ',',
      )}) — pass aborted; the next open rescans`,
    );
  }
}

/** Is a full reconciliation pass overdue? Never having run one counts. */
async function fullPassDue(db: SQLiteDatabase): Promise<boolean> {
  const at = Number(await getSetting(db, SCAN_FULL_AT_KEY));
  return !Number.isFinite(at) || Date.now() - at > FULL_PASS_MAX_AGE_MS;
}

interface DeltaDecision {
  ranges: TimeRange[];
  /** Rows MediaStore reports as trashed — deletions, made visible. Only
   * mounted volumes contribute (their change queries are the source), so
   * a deletion is never concluded for an absent volume (invariant 6). */
  trashedIds: string[];
  /** Changed UNDATED, non-trashed, in-source rows (F27): landed by
   * direct per-id fetch — no range can cover them. */
  undatedIds: string[];
  /** MediaStore's pass-START count PER VOLUME (m0.8.3 phase 2). The
   * post-delta agreement compares against THESE, pinned, so its
   * behaviour cannot depend on whether the pass outlived a query cache
   * TTL — photos captured mid-pass belong to the next open, not to a
   * spurious full pass. */
  mediaByVolumeAtStart: Record<string, number>;
}

/**
 * MediaStore's source-scoped count per volume (invariant 1's left side).
 * A dirs scope counts its own buckets (a bucket belongs to one volume);
 * "All folders" asks the native per-volume counter. Throws propagate to
 * planPass's catch → full pass.
 */
async function mediaCountsByVolume(
  volumes: readonly string[],
  albumIdsByVolume: Readonly<Record<string, string[]>> | null,
): Promise<Record<string, number>> {
  if (albumIdsByVolume !== null) {
    const out: Record<string, number> = {};
    for (const volume of volumes) {
      const albumIds = albumIdsByVolume[volume] ?? [];
      out[volume] =
        albumIds.length === 0
          ? 0
          : // FRESH, never the memo: these counts must postdate the
            // generation snapshot (same rule as the old global tripwire).
            await countPhotosInRange(0, Number.POSITIVE_INFINITY, albumIds, { fresh: true });
    }
    return out;
  }
  return getImageCountsByVolume([...volumes]);
}

/**
 * Decide whether this pass can be a delta, and over which ranges.
 *
 * Returns null for "run a full pass" — every uncertainty resolves that
 * way, because a full pass is exactly what shipped before the delta
 * existed. A forced rescan, a model swap, a missing baseline, an
 * unreadable change set or a cost model that says the delta is not a
 * decisive win all land here.
 *
 * INVARIANT (F27, m0.8.7): every fallback to a full pass logs its
 * reason before returning; none returns silently. The one unlogged
 * fallback (the undated bail, which ran AFTER the "DELTA wins" line
 * printed) is exactly how every WhatsApp arrival silently cost a
 * 5-minute corpus walk. The force-shaped reasons (forced rescan, model
 * swap, weekly due, generation gap) are logged by scan() where they are
 * decided.
 */
async function planPass(
  db: SQLiteDatabase,
  /** Generations restricted to SCOPE-RELEVANT mounted volumes (plan §4
   * invariant 7) — an out-of-scope card's activity never reaches this
   * function, and an unmounted volume simply is not in the map
   * (invariant 2: skipped, never compared, baseline retained). */
  filteredGenerations: Readonly<Record<string, number>>,
  sources: {
    roots: readonly SourceRoot[] | null;
    albumIdsByVolume: Readonly<Record<string, string[]>> | null;
  },
  force: boolean,
): Promise<DeltaDecision | null> {
  if (force) return null; // reason logged by scan()
  const roots = sources.roots;
  try {
    const raw = await getSetting(db, SCAN_GENERATIONS_KEY);
    if (raw === null) {
      console.log('[scan] delta: no stored baseline — the first pass must be full');
      return null;
    }
    const previous = JSON.parse(raw) as Record<string, number>;
    const keys = Object.keys(filteredGenerations);
    // Mirror scanCanSkip's rule: an EMPTY generation map means the native
    // read FAILED (or no scope-relevant volume is mounted) — either way
    // there is nothing to prove a delta against.
    if (keys.length === 0) {
      console.log('[scan] delta: no generation evidence for any in-scope volume — full pass');
      return null;
    }
    // A scope-relevant volume the baseline never saw (a card inserted or
    // a folder on it newly selected) has no "since" to query from — only
    // a full pass can take it in (invariant 5; the picker save already
    // forces the rescan for the newly-added-folder case).
    const unseenVolumes = neverSeenVolumes(keys, previous);
    if (unseenVolumes.length > 0) {
      console.log(
        `[scan] delta: never-seen in-scope volume(s) ${unseenVolumes.join(', ')} — full pass`,
      );
      return null;
    }
    const allChanged: ChangedMediaRow[] = [];
    for (const key of keys) {
      if (previous[key] === filteredGenerations[key]) continue;
      // Keys are "<volume>|<MediaStore version>" (the native module bakes
      // the version in so a provider rebuild mismatches every key); the
      // change query wants the raw volume name. Spike A finding 1: the
      // generation counter is SHARED across external volumes, so a
      // per-volume "changed" can be a false positive from another
      // volume's writes — harmless (the change query returns nothing).
      allChanged.push(...(await getMediaChangedSince(rawVolumeOfKey(key), previous[key])));
    }
    // F27 leg 1: the change query is volume-wide, but the scan is
    // source-scoped everywhere else — an out-of-source change (the
    // measured WhatsApp case) must plan nothing, exactly as it is
    // invisible to every other read. Keyed on each row's CURRENT bucket;
    // trashed rows always pass (see filterChangedToSources).
    const changed = filterChangedToSources(allChanged, sources.albumIdsByVolume);
    if (changed.length < allChanged.length) {
      console.log(
        `[scan] delta: ${allChanged.length - changed.length} out-of-source change(s) ignored`,
      );
    }
    const timestamps = await getPhotoTimestamps(db, roots);
    // Canonical ids carry each row's REAL volume (m0.8.3 phase 2): the
    // old aliasing hazard died with volume-qualified identity, so
    // cross-volume change sets reconcile directly — no full-pass detour.
    const trashedIds = changed
      .filter((row) => row.isTrashed)
      .map((row) => canonicalPhotoId(row.volumeName, row.rawId));
    // Gallery-trashed rows are already hidden from the MediaStore counts
    // below but stay tracked as present until THIS pass reconciles them —
    // subtract the overlap PER VOLUME, or every external delete (a
    // culling app's most common library change) reads as an untraced
    // loss and the delta's whole deletion path goes unreachable.
    const trashedTrackedByVolume: Record<string, number> = {};
    const trashedByVolume = new Map<string, string[]>();
    for (const id of trashedIds) {
      const volume = volumeOf(id);
      const list = trashedByVolume.get(volume) ?? [];
      list.push(id);
      trashedByVolume.set(volume, list);
    }
    for (const [volume, ids] of trashedByVolume) {
      trashedTrackedByVolume[volume] = await countPresentPhotos(db, ids);
    }
    // A MOVED DATE_TAKEN re-pages only the NEW window; the OLD window's
    // survivors would keep their stale grouping while the counts still
    // agree and the baseline advances. Only a full pass rewindows both
    // sides (and covers an old position that lived in the undated
    // batch, which no range can reach). Rare event — the documented
    // degrade path is the honest answer. TRASHED rows are compared too:
    // a row that moved AND was trashed still strands its old window's
    // survivors, and the tripwire balances (codex r3).
    const movedCandidates = changed.filter((row) => row.dateTakenMs !== null);
    if (movedCandidates.length > 0) {
      const stored = await getTakenAtForAssets(
        db,
        movedCandidates.map((row) => canonicalPhotoId(row.volumeName, row.rawId)),
      );
      const moved = movedCandidates.filter((row) => {
        const oldAt = stored.get(canonicalPhotoId(row.volumeName, row.rawId));
        return oldAt !== undefined && oldAt !== row.dateTakenMs;
      });
      if (moved.length > 0) {
        console.log(
          `[scan] delta: ${moved.length} changed photos moved their DATE_TAKEN — ` +
            `full pass to rewindow both sides`,
        );
        return null;
      }
    }
    // COUNT TRIPWIRES, PER VOLUME (invariant 1). MediaStore has NO
    // deletion tombstone: a removed row simply vanishes, and the
    // generation counter does not say what it counted, so no change query
    // can ever report a delete that bypassed the system trash. A volume
    // holding FEWER photos than we track on it (net of the trashed rows
    // the change query DID report) is the only evidence such a delete
    // leaves. Only "fewer" trips it — more just means photos we have not
    // ingested yet, the delta's normal input, which is why the same
    // comparison runs AGAIN per volume after the pass. Mounted volumes
    // only, by construction: the keys ARE the mounted scope-relevant set.
    const volumes = keys.map(rawVolumeOfKey);
    const mediaByVolume = await mediaCountsByVolume(volumes, sources.albumIdsByVolume);
    const trackedByVolume = await countTrackedByVolume(db, roots);
    const counts: Record<string, VolumeCountRow> = {};
    for (const volume of volumes) {
      counts[volume] = {
        media: mediaByVolume[volume] ?? 0,
        tracked: trackedByVolume[volume] ?? 0,
        trashedInFlight: trashedTrackedByVolume[volume] ?? 0,
      };
    }
    console.log(
      `[scan] delta tripwire (per volume): ` +
        volumes
          .map(
            (v) =>
              `${v}: MediaStore ${counts[v].media} vs tracked ${counts[v].tracked}` +
              (counts[v].trashedInFlight > 0 ? ` (${counts[v].trashedInFlight} trashed)` : ''),
          )
          .join(' · '),
    );
    const losses = volumesWithUntracedLoss(counts);
    if (losses.length > 0) {
      console.log(
        `[scan] delta: tracked photos gone from MediaStore with no trace on ` +
          `${losses.join(', ')} — full pass to reconcile`,
      );
      return null;
    }
    const plan = planDeltaRanges(changed, timestamps, ADJACENT_MERGE_MAX_GAP_MS);
    const verdict = deltaVerdict({
      covered: coveredBy(timestamps, plan.ranges),
      changed: plan.changed,
      ranges: plan.ranges.length,
      corpus: timestamps.length,
    });
    console.log(`[scan] ${describeDeltaPlan(plan, verdict)}`);
    if (!verdict.worthIt) return null; // reason printed on the line above
    // UNDATED changes (no DATE_TAKEN) cannot be placed in any range —
    // they land by direct per-id fetch instead (F27; each one used to
    // silently discard the whole delta AFTER "DELTA wins" printed,
    // turning every WhatsApp arrival into a corpus walk). Trashed
    // undated rows need no fetch: trashedIds reconciles them by id.
    const undatedIds = changed
      .filter((row) => !row.isTrashed && row.dateTakenMs === null)
      .map((row) => canonicalPhotoId(row.volumeName, row.rawId));
    return { ranges: plan.ranges, trashedIds, undatedIds, mediaByVolumeAtStart: mediaByVolume };
  } catch (error) {
    console.log(`[scan] delta unavailable, running a full pass: ${String(error)}`);
    return null;
  }
}

/**
 * Persist the "this library is current" evidence — but only for a pass
 * that is entitled to claim it: not superseded, no engine errors (failed
 * embeds re-attempt next pass, and a stored fingerprint would freeze
 * their time-attached gaps), and reconciliation not capped. The
 * fingerprint was read at pass START, so photos landing mid-scan
 * mismatch on the next open.
 */
async function finishPass(
  db: SQLiteDatabase,
  args: {
    superseded: () => boolean;
    engine: EngineHealth;
    fingerprint: string;
    /** This pass's SCOPE-RELEVANT mounted volumes' generations — merged
     * over the stored baselines below, never overwriting an absent
     * volume's entry (invariant 2). */
    generations: Readonly<Record<string, number>>;
    unseenOverCap: boolean;
    /** Fail-closed volume skips this pass (m0.8.3, D7): any skip means
     * the pass did not achieve its claimed coverage — baselines are
     * withheld and the next launch retries. */
    skipped: number;
    /** EXIF reads attempted but never completed (codex r2): storing the
     * fingerprint over them would let the unchanged-library skip hide
     * the promised retry until an unrelated media change. */
    exifFailed: number;
    wasFullPass: boolean;
  },
): Promise<void> {
  const { superseded, engine, fingerprint, generations, unseenOverCap, skipped, exifFailed } = args;
  if (skipped > 0) {
    console.warn(
      `[scan] ${skipped} photos were skipped fail-closed (volume unparseable or unmounted) — ` +
        `baseline withheld; the next pass retries them`,
    );
    return;
  }
  if (exifFailed > 0) {
    console.warn(
      `[scan] ${exifFailed} EXIF date reads did not complete — ` +
        `baseline withheld; the next pass retries them`,
    );
    return;
  }
  if (superseded() || engine.dead || engine.engineErrors > 0 || unseenOverCap) return;
  await setSetting(db, SCAN_FINGERPRINT_KEY, fingerprint);
  // Re-checked between writes (final cycle S6): Forget supersedes and
  // then DELETES these keys in its own transaction — a pass past the
  // check above must not re-create them behind it. The check-then-queue
  // is synchronous, so a supersede seen here means our later writes
  // would land after Forget's delete.
  if (superseded()) return;
  // MERGED, never overwritten (m0.8.3 phase 2, invariant 2): this pass's
  // scope-relevant mounted volumes replace their own entries; a stored
  // baseline for an unmounted (or out-of-scope) volume is retained
  // untouched, so remount resumes its delta exactly where it left off
  // (invariant 4).
  const storedRaw = await getSetting(db, SCAN_GENERATIONS_KEY);
  const merged = mergeGenerationBaselines(
    storedRaw === null ? null : (JSON.parse(storedRaw) as Record<string, number>),
    generations,
  );
  if (superseded()) return; // S6, same rule — never past a supersede
  await setSetting(db, SCAN_GENERATIONS_KEY, JSON.stringify(merged));
  await setSetting(db, SCAN_VERIFIED_AT_KEY, String(Date.now()));
  // Only a FULL pass may restart the weekly clock — a delta never
  // enumerated everything, so it cannot stand in for the reconciliation.
  if (args.wasFullPass) await setSetting(db, SCAN_FULL_AT_KEY, String(Date.now()));
}

async function scan(db: SQLiteDatabase, force: boolean): Promise<void> {
  const generation = scanGeneration;
  const superseded = (): boolean => generation !== scanGeneration;

  // TARGETED pass (Regroup_design §5): drain the eject/un-eject targets
  // and return — never a full pass's stamps (no fingerprint, no
  // baselines, no reconciliation: re-placement is presentation repair
  // and must not claim verification). A forced rescan outranks it: the
  // full pass covers every target anyway.
  const targets = pendingTargets.splice(0);
  if (targets.length > 0 && !force) {
    await targetedPass(db, targets, superseded);
    return;
  }
  // A forced run DROPS drained targets: the full pass below re-windows
  // the whole library, targets included.

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
  const rawStrictness = await getSetting(db, GROUPING_STRICTNESS_KEY);

  // UNCHANGED-LIBRARY SKIP (m0.8.1): a full pass costs ~6 min of CPU on
  // a 27k corpus and used to run on EVERY app open. MediaStore's
  // per-volume generation bumps on any insert/update/delete, so a
  // fingerprint (generations + scope + strictness + model) matching the
  // last COMPLETE clean pass is OS-level proof the pass is a no-op.
  const generations = await getMediaGenerations().catch(() => ({}));
  // The mounted-volume set is REQUIRED (codex phase-2 round): the
  // reconcile scope and page validation must never
  // run blind — "unknown" aborting here (the throw fails the scan,
  // phase 'error', retried next open) is the only answer that cannot
  // treat an ejected card's photos as reachable. Independent of the
  // generation read on purpose: that one degrades to {} on failure (no
  // skip evidence, so no skip), while this one may not degrade at all.
  const mounted = await getMountedVolumes();
  // SCOPE-RELEVANT volumes only, mounted only (m0.8.3 phase 2,
  // invariants 2 + 7): an out-of-scope card's activity must not defeat
  // the skip, and an unmounted volume's entry simply is not there — the
  // fingerprint after an eject differs once (one pass runs, stores the
  // narrower map) and then skips again while the card stays out.
  const relevantVolumes = new Set(scopeRelevantVolumes(mounted, sources.roots ?? null));
  const relevantGenerations = filterGenerationsToVolumes(generations, relevantVolumes);
  // SNAPSHOT CONSISTENCY (final cycle Q1): generations were read BEFORE
  // the mounted set — a card mounting between the two native calls is in
  // `mounted` but absent from the map, so the filtered fingerprint can
  // equal a stored pre-card pass and falsely skip the card's ingestion.
  // A relevant mounted volume without a generation entry disqualifies
  // the skip; the pass itself proceeds and covers the card.
  const generationGap = missingGenerationVolumes(generations, relevantVolumes).length > 0;
  if (generationGap && Object.keys(generations).length > 0) {
    console.log('[scan] a mounted volume has no generation entry — skip disqualified');
  }
  const fingerprint = scanFingerprint({
    generations: relevantGenerations,
    roots: sources.roots ?? null,
    strictness: rawStrictness,
    modelSha: MODEL_SHA256,
  });
  // PERIODIC FULL PASS, checked BEFORE the skip so it cannot be starved
  // by it. A permanent delete (no system trash) removes the row with no
  // tombstone and no generation record: no delta can see it, and once a
  // later pass stores the moved generation the skip would then match
  // forever with the stale row still in the queue. This is the guarantee
  // that such a row is eventually reconciled.
  const fullDue = await fullPassDue(db);
  if (fullDue) console.log('[scan] full pass due — weekly reconciliation');
  if (!force && !model.cleared && !fullDue && !generationGap) {
    const stored = await getSetting(db, SCAN_FINGERPRINT_KEY);
    if (scanCanSkip({ generations: relevantGenerations, stored, current: fingerprint })) {
      // The skip CLAIMS verification, so it takes the same fence a
      // completing pass does (final cycle T3): a card hot-mounting
      // after the mounted read above is in neither the fingerprint nor
      // the gap check — re-read and compare before accepting.
      const nowMounted = new Set(await getMountedVolumes());
      if (nowMounted.size !== mounted.length || !mounted.every((v) => nowMounted.has(v))) {
        console.log('[scan] mounted volumes changed during startup — skip disqualified');
      } else {
        update({ phase: 'done' });
        // The skip IS the verification — record it, or Settings would
        // report a staleness this call just disproved.
        await setSetting(db, SCAN_VERIFIED_AT_KEY, String(Date.now()));
        console.log('[scan] library unchanged since last complete pass — skipped');
        return;
      }
    }
  }

  // Grouping strictness (gate 4): the ONE user control over the engine —
  // read once per run; a change mid-run applies from the next scan.
  const strictness = parseStrictness(rawStrictness);
  const engine = newEngineHealth();

  // A pass is RUNNING — re-resolve the source scope FRESH, past every
  // catalog cache (codex r4): a ten-minute-old bucket set can miss a
  // brand-new album under a recursive root, and the pass would then
  // enumerate, count and BASELINE around photos it never saw. The skip
  // path above deliberately used the cached resolution (its proof is
  // the generations, and the fingerprint's roots are durable settings).
  // NO cached fallback here (codex r5): a pass run over a possibly-stale
  // scope that then advances the baseline is exactly the hole the fresh
  // read closes — failing the scan (phase 'error', retried next open)
  // is the only answer that cannot stamp a lie.
  const passSources = await resolveSources(db, { fresh: true });

  // Library snapshot for the status line and Home's card (m0.8.2, F3/F4)
  // — fetched AFTER the skip check, so an unchanged open stays one
  // native call. Display-only, so the 20 s count cache may serve it;
  // planPass's tripwire takes its own FRESH count (it must postdate the
  // generation snapshot).
  const corpusTotal = await countPhotosInRange(
    0,
    Number.POSITIVE_INFINITY,
    passSources.albumIds ?? undefined,
  ).catch((error): null => {
    console.warn(
      '[scan] corpus count failed — progress shows counts, not a percent:',
      String(error),
    );
    return null;
  });
  update({ corpusTotal });

  // The pass's own scope-relevant slice, from the FRESH resolution (the
  // fingerprint above deliberately used the cached one).
  const passRelevantGenerations = filterGenerationsToVolumes(
    generations,
    new Set(scopeRelevantVolumes(mounted, passSources.roots ?? null)),
  );

  // The remaining force reason gets its log line too (F27's invariant:
  // no silent full pass) — the other three printed theirs above.
  if (force && !model.cleared && !fullDue && !generationGap) {
    console.log('[scan] full pass: forced rescan (settings change or reset)');
  }

  // DELTA vs FULL (m0.8.2 phase 2). Both run the SAME grouping code
  // below, differing only in which time ranges they page — which is what
  // makes "a delta produces the groups a full pass would" a structural
  // property rather than a hope.
  const decision = await planPass(
    db,
    passRelevantGenerations,
    { roots: passSources.roots ?? null, albumIdsByVolume: passSources.albumIdsByVolume ?? null },
    // generationGap forces FULL (final cycle R2): a volume that mounted
    // between the generation and mounted reads has no entry, so a delta
    // planned from the older keys could complete "verified" without
    // ever enumerating the card.
    force || model.cleared || fullDue || generationGap,
  );

  // The mounted-volume set at pass start (m0.8.3, D7): ALL mounted
  // volumes (scope filtering is the query's job — a photo on any mounted
  // volume is validly stamped). Never null: acquisition failure aborted
  // the pass above.
  const mountedVolumes: ReadonlySet<string> = new Set(mounted);

  // F20: the pass-start favourite snapshot — one indexed query per
  // mounted volume, projected onto exactly the rows this pass walks. A
  // failed read degrades to "project nothing this pass", loudly, once —
  // an empty set would read as "nothing is favourited" and CLEAR every
  // carried favourite, which a query failure must never claim.
  let favourites: ReadonlySet<string> | null = null;
  if (mediaStoreActionsAvailable()) {
    try {
      const flagged = new Set<string>();
      for (const volume of mounted) {
        for (const rawId of await getFavouriteImageIds(volume)) {
          flagged.add(canonicalPhotoId(volume, rawId));
        }
      }
      favourites = flagged;
    } catch (error) {
      console.warn(
        '[scan] favourite flags unavailable this pass — carried favourites not reconciled:',
        String(error),
      );
    }
  }

  if (decision) {
    const deltaResult = await pageAndGroup(db, {
      ranges: decision.ranges,
      albumIds: passSources.albumIds ?? undefined,
      baseThreshold: strictness.baseThreshold,
      engine,
      superseded,
      mountedVolumes,
      favourites,
      undatedIds: decision.undatedIds,
    });
    if (deltaResult === null) {
      console.log('[scan] superseded by a settings change — stopping for the queued rescan');
      return;
    }
    // A DELTA enumerated only its ranges, so "not seen" means nothing and
    // the removal reconciliation below cannot run. Deletions arrive by a
    // different route: a gallery delete TRASHES the row rather than
    // removing it, which the change query reports directly (measured on
    // device).
    // Those rows are acted on HERE rather
    // than by re-paging their range, because MediaStore filters trashed
    // rows out of the paging the scan does.
    if (decision.trashedIds.length > 0) {
      // Fence + mounted-aware repair (codex phase-2): a deletion is only
      // concluded against the live mounted world, and the membership
      // repair defers groups still holding an unreachable member.
      await assertMountedUnchanged(mountedVolumes);
      // Gallery trashes are 30-day-restorable — no permanentIds: their
      // duel history survives a restore (grilling Q13).
      await reconcileExternallyRemoved(db, decision.trashedIds, Date.now(), [...mountedVolumes]);
      console.log(`[scan] delta: ${decision.trashedIds.length} trashed photos left the queue`);
    }
    // POST-DELTA CONSISTENCY CHECK, PER VOLUME (invariant 1's second
    // half). Having just ingested everything the change set held, each
    // mounted scope-relevant volume's tracked count must equal its
    // PASS-START MediaStore count (pinned in the decision — a fresh
    // query here would make the check's behaviour depend on pass
    // duration vs the count cache's TTL, and photos captured mid-pass
    // belong to the next open). The tripwire before the pass is
    // one-directional by necessity — MediaStore holding MORE than we
    // track is the delta's normal input — so a silently MISSED ADDITION
    // is invisible to it and would otherwise sit until the weekly
    // reconciliation. Checked here instead, and repaired immediately.
    const trackedAfter = await countTrackedByVolume(db, passSources.roots ?? null);
    const disagreeing = volumesDisagreeingAfterDelta(decision.mediaByVolumeAtStart, trackedAfter);
    if (disagreeing.length === 0) {
      // Final fence: baselines must describe the world they were read in.
      await assertMountedUnchanged(mountedVolumes);
      await finishPass(db, {
        superseded,
        engine,
        fingerprint,
        generations: passRelevantGenerations,
        unseenOverCap: false,
        skipped: deltaResult.skipped,
        exifFailed: deltaResult.exifFailed,
        wasFullPass: false,
      });
      update({ phase: 'done' });
      console.log(
        `[scan] delta done: ${status.scanned} in ${decision.ranges.length} ranges, ` +
          `embedded ${status.embedded} fresh, ${status.windowsGrouped} windows grouped`,
      );
      return;
    }
    // Loud, and repaired NOW rather than queued: the library is provably
    // inconsistent, and leaving it that way until the next open would
    // show the user counts that disagree with their gallery.
    console.warn(
      `[scan] delta left the library inconsistent on ${disagreeing.join(', ')} ` +
        `(MediaStore at start: ${disagreeing
          .map((v) => `${v}=${decision.mediaByVolumeAtStart[v]}`)
          .join(', ')} vs tracked: ${disagreeing
          .map((v) => `${v}=${trackedAfter[v] ?? 0}`)
          .join(', ')}) — running a full pass immediately`,
    );
    // The full pass is a fresh enumeration; its progress line must not
    // continue the delta's count — the pass-start snapshot serves as its
    // denominator. `windowsGrouped` deliberately keeps counting: the
    // refresh subscribers diff it, and a rewind would silence them until
    // the new run caught up past the old value.
    const mediaAtStartTotal = Object.values(decision.mediaByVolumeAtStart).reduce(
      (sum, n) => sum + n,
      0,
    );
    update({ scanned: 0, total: mediaAtStartTotal, corpusTotal: mediaAtStartTotal });
  }

  // A FULL pass's denominator is the library snapshot (F3 — the percent
  // branch); a delta keeps total null and the line shows plain counts.
  if (status.total === null) update({ total: status.corpusTotal });

  const fullResult = await pageAndGroup(db, {
    ranges: [FULL_RANGE],
    albumIds: passSources.albumIds ?? undefined,
    baseThreshold: strictness.baseThreshold,
    engine,
    superseded,
    mountedVolumes,
    favourites,
  });
  if (fullResult === null) {
    console.log('[scan] superseded by a settings change — stopping for the queued rescan');
    return;
  }
  const seenIds = fullResult.seenIds;

  // Backstop for tiny corpora that never reached the consecutive-error
  // threshold: a scan with engine errors and literally zero successes must
  // never end as 'done' with time-only groups posing as grouped output.
  if (engine.attempts > 0 && engine.successes === 0 && (engine.dead || engine.engineErrors > 0)) {
    throw new Error(
      `embedding engine unavailable — ${engine.engineErrors} engine errors, ` +
        `0 of ${engine.attempts} fresh embeds succeeded`,
    );
  }

  // A COMPLETE pass enumerated every in-source MediaStore photo ON
  // MOUNTED VOLUMES, so a tracked present row the pager never met was
  // removed outside Afterglow — but ONLY for rows whose volume was
  // mounted (invariants 2 + 6): an unmounted volume's photos are absent
  // from enumeration because the VOLUME is away (merged queries silently
  // drop them, spike A finding 2), which is no evidence about the
  // photos. They are excluded up front — never probed, never marked,
  // never blocking the baseline. Absence-from-enumeration alone is not
  // authoritative even on mounted volumes (photos can land mid-scan
  // behind the cursor), so each candidate gets the tri-state presence
  // check and only verified 'trashed'/'absent' rows converge — exactly
  // the History reconciliation contract.
  const tracked = await getPresentAssetIds(db, passSources.roots ?? null, [...mountedVolumes]);
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
  let unresolved = 0;
  for (const id of unseen.slice(0, RECONCILE_CAP)) {
    const presence = await checkMediaPresence(id);
    if (presence === 'trashed' || presence === 'absent') {
      // Both converge the same way — duels are append-only (v22) and
      // survive every removal, so 'absent' needs no separate marking.
      gone.push(id);
    } else if (presence === 'present') {
      // Present but NOT enumerated: the photo moved (same MediaStore id,
      // new path — e.g. out of the selected source). Refresh its uri so
      // source-scoped reads stop surfacing it under the stale path.
      const details = await getAssetDetails(id);
      if (details?.uri) {
        await updatePhotoUri(db, id, details.uri);
        movedUris += 1;
      } else {
        // Present but its details would not load — the row is neither
        // reconciled nor repaired. Counted below: a pass with unresolved
        // rows must not stamp its baseline as if it settled them
        // (codex r8).
        unresolved += 1;
      }
    } else {
      // 'unknown' — the tri-state check could not decide. Same rule.
      unresolved += 1;
    }
  }
  if (movedUris > 0) console.log(`[scan] refreshed ${movedUris} moved photo paths`);
  if (unresolved > 0) {
    console.warn(
      `[scan] ${unresolved} unseen photos could not be verified — ` +
        `baseline withheld; the next pass retries them`,
    );
  }
  if (gone.length > 0) {
    // Fence + mounted-aware repair (codex phase-2), same as the delta's
    // trashed reconcile above.
    await assertMountedUnchanged(mountedVolumes);
    await reconcileExternallyRemoved(db, gone, Date.now(), [...mountedVolumes]);
    console.log(`[scan] reconciled ${gone.length} externally removed photos`);
  }

  // Final fence: baselines must describe the world they were read in.
  await assertMountedUnchanged(mountedVolumes);
  await finishPass(db, {
    superseded,
    engine,
    fingerprint,
    generations: passRelevantGenerations,
    unseenOverCap: unseen.length > RECONCILE_CAP || unresolved > 0,
    skipped: fullResult.skipped,
    exifFailed: fullResult.exifFailed,
    wasFullPass: true,
  });

  update({ phase: 'done' });
  // One summary line per run — the only permanent scan log besides errors
  // (release builds have no inspectable DB; this is the field diagnostic).
  console.log(
    `[scan] done: scanned ${status.scanned}, embedded ${status.embedded} fresh, ` +
      `${status.windowsGrouped} windows grouped`,
  );
}

/**
 * The TARGETED pass (Regroup_design §5): walk each dated target's window
 * from the tracked timestamps (the same walk a changed photo gets) and
 * re-page just those ranges; undated targets land by direct per-id
 * fetch. No fingerprint, no baselines, no reconciliation — this pass
 * re-places photos and claims nothing else. Failures land in the status
 * like any scan error; the next natural pass covers whatever this one
 * missed.
 */
async function targetedPass(
  db: SQLiteDatabase,
  targets: readonly RescanTarget[],
  superseded: () => boolean,
): Promise<void> {
  status = { ...IDLE, phase: 'scanning' };
  update({});
  const sources = await resolveSources(db);
  const rawStrictness = await getSetting(db, GROUPING_STRICTNESS_KEY);
  const strictness = parseStrictness(rawStrictness);
  const engine = newEngineHealth();
  const mounted = await getMountedVolumes();
  const mountedVolumes: ReadonlySet<string> = new Set(mounted);
  const timestamps = await getPhotoTimestamps(db, sources.roots ?? null);
  const dated = targets.filter((t) => !t.undated);
  const ranges = rangesForTargets(
    dated.map((t) => t.takenAtMs),
    timestamps,
    ADJACENT_MERGE_MAX_GAP_MS,
  );
  const undatedIds = targets.filter((t) => t.undated).map((t) => t.assetId);
  console.log(
    `[scan] targeted rescan: ${targets.length} photo(s) → ${ranges.length} range(s)` +
      (undatedIds.length > 0 ? `, ${undatedIds.length} by direct fetch` : ''),
  );
  const result = await pageAndGroup(db, {
    ranges,
    albumIds: sources.albumIds ?? undefined,
    baseThreshold: strictness.baseThreshold,
    engine,
    superseded,
    mountedVolumes,
    // No favourite projection on a targeted pass: it re-places
    // membership, nothing more.
    favourites: null,
    undatedIds,
  });
  if (result === null) {
    console.log('[scan] targeted rescan superseded — the queued rescan covers it');
    return;
  }
  update({ phase: 'done' });
  console.log(`[scan] targeted rescan done: ${status.scanned} re-paged`);
}

/**
 * D15 EXIF date rescue (m0.8.3): any photo landing UNDATED at ingestion
 * gets one native ExifInterface read of DateTimeOriginal — found → the
 * timestamp and day become real (naive local time, device timezone —
 * clustering's standing best-effort stance); absent → the photo stays
 * honestly undated (a WhatsApp-stripped JPEG keeps its Unknown day).
 *
 * ONCE PER PHOTO, via the stored row: MediaStore reports these photos
 * undated on EVERY pass, and the scan's upsert rewrites taken_at/day from
 * the ingested values — so a known, unmodified photo must REUSE its
 * stored values (a NEF rescued last pass would otherwise be clobbered
 * back to the mtime fallback), and a stored undated verdict (day NULL,
 * same mod_time) means the header was already read and had nothing.
 * READ-ONLY by contract: the app never modifies original photo bytes.
 *
 * Mutates the batch in place (timestamp + undated flag). Returns the
 * count of FAILED reads (attempted but never completed): the pass must
 * not store its skip fingerprint or baselines over them, or the
 * unchanged-library skip would hide the promised retry until an
 * unrelated media change (codex r2). Module absent → no attempt at all
 * and zero failures — a failure that can never succeed must not defeat
 * the skip forever on devices without the native module.
 */
async function applyExifDateRescue(db: SQLiteDatabase, batch: LoadedPhoto[]): Promise<number> {
  if (!mediaStoreActionsAvailable()) return 0;
  const stored = await getRescueBaselines(
    db,
    batch.map((photo) => photo.item.id),
  );
  const toProbe: LoadedPhoto[] = [];
  for (const photo of batch) {
    const row = stored.get(photo.item.id);
    // Reuse ONLY on the rescue's own completed-read marker (codex r1):
    // photos.mod_time belongs to edit detection, and a row without the
    // marker (new, content changed, or a past read that FAILED) probes.
    if (row && row.exifCheckedModTime !== null && row.exifCheckedModTime === photo.modTime) {
      // The stored row IS the rescue verdict for this content version —
      // carried EXPLICITLY (final cycle Q3): the upsert clears the
      // marker on dated rows that arrive without one, because those are
      // MediaStore-dated; a reused rescue must not look like one.
      photo.item.timestamp = row.takenAt;
      photo.undated = row.day === null;
      photo.exifCheckedModTime = row.exifCheckedModTime;
    } else {
      toProbe.push(photo);
    }
  }
  if (toProbe.length === 0) return 0;
  let rescued = 0;
  let failed = 0;
  const PROBE_CHUNK = 100;
  for (let i = 0; i < toProbe.length; i += PROBE_CHUNK) {
    const chunkPhotos = toProbe.slice(i, i + PROBE_CHUNK);
    let results;
    try {
      // Bounded like every other per-item native round trip (m0.8.1,
      // lib/concurrency.ts) — 100 concurrent uri resolutions would spike
      // the module queue for no throughput gain.
      const uris = await mapWithConcurrency(chunkPhotos, 6, (photo) =>
        getEditableContentUri(photo.item.id),
      );
      results = await readExifDateTimeOriginal(uris);
    } catch (error) {
      failed += chunkPhotos.length;
      console.warn(`[scan] exif rescue read failed for a chunk: ${String(error)}`);
      continue;
    }
    for (let j = 0; j < chunkPhotos.length; j++) {
      const result = results[j];
      if (!result || result.error !== null) {
        // The read never completed — no marker, so the next pass
        // retries. Locking the photo undated on a transient failure
        // would be silent data loss of a recoverable date (codex r1).
        failed += 1;
        continue;
      }
      // COMPLETED read (found or honestly absent): stamp the marker.
      chunkPhotos[j].exifCheckedModTime = chunkPhotos[j].modTime;
      const ms = result.dateTimeOriginal ? exifDateTimeToMs(result.dateTimeOriginal) : null;
      if (ms !== null) {
        chunkPhotos[j].item.timestamp = ms;
        chunkPhotos[j].undated = false;
        rescued += 1;
      }
    }
  }
  if (rescued > 0 || failed > 0) {
    console.log(
      `[scan] exif rescue: ${rescued} of ${toProbe.length} undated photos got real dates` +
        (failed > 0 ? ` (${failed} reads failed — retried next pass)` : ''),
    );
  }
  return failed;
}

/** Embed, group, and persist one closed merge window. */
async function processWindow(
  db: SQLiteDatabase,
  window: LoadedPhoto[],
  engine: EngineHealth,
  baseThreshold: number,
  stale?: () => boolean,
  /** Mounted volumes at pass start — the mid-pass mount fence, and the
   * membership repair's dissolve deferral for groups still holding an
   * unreachable member. */
  mountedVolumes?: ReadonlySet<string> | null,
  /** Canonical ids MediaStore reported IS_FAVORITE=1 for at pass start
   * (F20). Null = the read failed — the pass projects nothing. */
  favourites?: ReadonlySet<string> | null,
): Promise<void> {
  const favouriteOf = (id: string): boolean | null =>
    favourites === null || favourites === undefined ? null : favourites.has(id);
  // WRITE PRIORITY (vetted): a pending user decision reaches SQLite
  // before this window's transactions.
  await waitForUserWrites();
  // Fence BEFORE the embed phase too (final cycle M4): ensureEmbeddings
  // persists embeddings/hashes per photo as it goes, so an eject during
  // a long decode would otherwise write satellite rows under a stale
  // mounted snapshot. The pre-write fence below still guards the group
  // write itself.
  if (mountedVolumes) await assertMountedUnchanged(mountedVolumes);
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

  // The user's cannot-link judgments among this window's photos, handed
  // to the engine as constraints (docs/Regroup_design.md §4.2). The
  // write transaction re-reads them — an eject landing between this read
  // and the write must still win.
  const cannotLink = await getNotRelatedPairsAmong(db, ids);

  const groups = groupByEmbedding(
    window.map((p) => p.item),
    (id) => vectors.get(id) ?? null,
    withHashes ? (id) => hashes.get(id) ?? null : undefined,
    { baseThreshold, cannotLink },
  );
  const multi = groups.filter((g) => g.items.length >= 2);
  const singles = groups.filter((g) => g.items.length === 1).map((g) => g.items[0].id);

  // Re-check right before the write — a user write may have started
  // while the embed phase above was running — and re-verify the MOUNTED
  // SET (codex phase-2; ordered AFTER the user-write wait, final cycle
  // round 2: the wait itself is a window): an eject after the pass-start
  // snapshot silently empties merged paging, and the fence aborts before
  // any write can act on that stale picture.
  await waitForUserWrites();
  if (mountedVolumes) await assertMountedUnchanged(mountedVolumes);
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
        // v14: recorded so reclaimable bytes is an exact SUM (0 = the
        // stat failed → NULL keeps the row in the transient stat-fallback).
        sizeBytes: fileSize(p.item.uri) || null,
        // NULL unless the D15 rescue completed a read this pass — the
        // upsert's COALESCE then retains any stored marker.
        exifCheckedModTime: p.exifCheckedModTime ?? null,
        // F20: the pass-start favourite snapshot, projected as the
        // carried favourite action; null = the read failed this pass.
        favourite: favouriteOf(p.item.id),
      })),
      groups: multi.map((g) => ({
        members: g.items.map((item) => item.id),
        timeAttached: g.timeAttached,
      })),
      singles,
    },
    Date.now(),
    // Checked INSIDE the exclusive transaction: a window superseded
    // mid-embed must not commit after the strictness reset cleared the
    // queue (the entry fence alone leaves that race open).
    { abortIf: stale, mountedVolumes: mountedVolumes ? [...mountedVolumes] : null },
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
