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
 * THE SCAN NOTICES (m0.9 phase 9): a check is requested by the
 * MediaStore observer (scan/scanNotices.ts — debounced, foreground
 * only), by every foreground return (the review provider), by a
 * pull-to-refresh on Home, Everything and Progress (requestLibraryCheck)
 * and by a surface that finds items MediaStore has and the DB lacks. A
 * notice during a flight queues ONE check for after it. No timer polls.
 * THE SCAN EXPLAINS ITSELF: the status carries the pass's kind, a full
 * pass's reason and a delta's size (lib/scanProgress.ts renders the one
 * line both Home and Settings show); nothing renders during the skip
 * check. An interrupted full pass resumes at its enumeration checkpoint
 * (lib/scanCheckpoint.ts) and names the durable work left.
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
import { logFootprint } from '../lib/footprint';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding, MOMENTS_GAP_MS } from '@afterglow/core';
import { MODEL_SHA256 } from '../../modules/image-embedder';
import { dayKey, exifDateTimeToMs } from '../lib/dates';
import { ensureEmbeddings, newEngineHealth, type EngineHealth } from '../lib/embeddings';
import {
  checkMediaPresence,
  checkMediaPresenceDetailed,
  countPhotosInRange,
  fetchPhotoPageDesc,
  getAssetDetails,
  getEditableContentUri,
  joinMediaFacts,
  loadPhotoById,
  type LoadedPhoto,
} from '../lib/media';
import { perfAggregate } from '../lib/perfLog';
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
  SCAN_CHECKPOINT_KEY,
  advance as advanceCheckpoint,
  canResume,
  changesAboveBoundary,
  checkpointScope,
  parseCheckpoint,
  type ScanCheckpoint,
} from '../lib/scanCheckpoint';
import type { FullPassReason } from '../lib/scanProgress';
import {
  getFavouriteMediaIds,
  getMediaCountsByVolume,
  getMediaChangedSince,
  getMediaGenerations,
  getMountedVolumes,
  listMediaIds,
  mediaStoreActionsAvailable,
  readExifDateTimeOriginal,
  readMediaFacts,
  type ChangedMediaRow,
  type MediaFactsRequest,
} from '../../modules/media-store-actions';
import { canonicalPhotoId, rawIdOf, volumeOf } from '../lib/mediaIdentity';
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
import { fileSize, fileSizeOrNull } from '../lib/hash';
import { ensureEmbeddingModel } from '../db/embeddingStore';
import { withWriteTransaction } from '../db/database';
import {
  adoptReturningFiles,
  countAnalyzedPresent,
  countPresentPhotos,
  countTrackedByVolume,
  deleteSetting,
  getNotRelatedPairsAmong,
  getPhotoTimestamps,
  getPresentLossCandidates,
  getPresentPhotosSince,
  hasPresentTwinAtPath,
  getRescueBaselines,
  getTakenAtForAssets,
  getPresentAssetRefs,
  getFactsBaselines,
  getSetting,
  setSetting,
  updatePhotoUri,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
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
  /** 'checking' (m0.9 phase 9) covers the skip check and the delta
   * planning — a few native reads before anything is known. The
   * surfaces render nothing for it: a "Scanning…" on every foreground
   * return was F27's complaint. */
  phase: 'idle' | 'checking' | 'scanning' | 'done' | 'error';
  /** Which pass runs (m0.9 phase 9) — the line names each differently. */
  kind: 'full' | 'delta' | 'targeted' | null;
  /** Why a full pass is full, decided where the pass is decided (F27's
   * invariant: no silent full pass — and now none unnamed). */
  reason: FullPassReason | null;
  /** A delta's size: the changed items it lands, trashed ones excluded. */
  changed: number | null;
  /** A resumed full pass: items still to analyze at pass start, from
   * DURABLE state (the library snapshot minus present rows that are
   * videos or hold an embedding) — never the enumeration counter. */
  remaining: number | null;
  /** This full pass resumed an interrupted one at its checkpoint (the
   * reason shown is the interrupted pass's own, carried by it). */
  resumed: boolean;
  /** Photos paged past so far this run (a resumed pass continues the
   * interrupted pass's count). */
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
  kind: null,
  reason: null,
  changed: null,
  remaining: null,
  resumed: false,
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

/** The publish cadence (G13, m0.9 phase 9): counters reach subscribers
 * at most once a second — per photo on the embed path, per page on the
 * walk — and a phase change publishes at once. ONE throttle, here, for
 * every subscriber (Home used to own a second one, coupled to the page
 * size): smooth on slow phases, one state update a second on fast ones,
 * and the accessibility idle the UI gate needs stays reachable. */
const PUBLISH_INTERVAL_MS = 1000;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let publishedAt = 0;
let publishedPhase: ScanStatus['phase'] = 'idle';

function publish(): void {
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
  }
  publishedAt = Date.now();
  publishedPhase = status.phase;
  for (const listener of listeners) listener(status);
}

function update(patch: Partial<ScanStatus>): void {
  status = { ...status, ...patch };
  const elapsed = Date.now() - publishedAt;
  if (status.phase !== publishedPhase || elapsed >= PUBLISH_INTERVAL_MS) publish();
  else if (!publishTimer) publishTimer = setTimeout(publish, PUBLISH_INTERVAL_MS - elapsed);
  // Phase-3 spike (b): the WAL curve DURING a scan — the embedding-heavy
  // initial pass is the suspected checkpoint-starvation window, and the
  // end-of-scan line alone cannot show a mid-scan balloon. logFootprint
  // self-throttles to one line a minute, so this costs one cheap early
  // return per status tick.
  if (status.phase === 'scanning') logFootprint('scan progress');
}

let flight: Promise<void> | null = null;
/** A rescan asked for during a flight, with its origin (phase 9): the
 * Settings row's own request names itself as such on the line. */
let rescanQueued: RescanOrigin | null = null;
/** A library change NOTICED during a flight (m0.9 phase 9): the pass's
 * generations were read at its start, so a change landing mid-pass was
 * invisible until the next trigger. One check runs after the flight. */
let noticeQueued = false;
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
  options: { force?: RescanOrigin } = {},
): Promise<void> {
  if (flight) return flight;
  const force = options.force ?? null;
  flight = scan(db, force)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[scan] failed:', message);
      update({ phase: 'error', error: message });
    })
    .finally(() => {
      flight = null;
      if (rescanQueued !== null) {
        const origin = rescanQueued;
        rescanQueued = null;
        // A queued rescan came from a settings apply/reset — forced (it
        // may rewrite scan OUTPUT without changing scan INPUT).
        void startContinuousScan(db, { force: origin });
      } else if (pendingTargets.length > 0) {
        // Targets that arrived mid-flight drain in their own pass.
        void startContinuousScan(db);
      } else if (noticeQueued) {
        noticeQueued = false;
        void startContinuousScan(db);
      }
    });
  return flight;
}

/**
 * A library change was NOTICED (m0.9 phase 9): the MediaStore observer,
 * a foreground return, a pull-to-refresh, or a surface that found items
 * MediaStore has and the DB lacks. Starts the check now, or queues ONE
 * for after the running flight. Never forced — the unchanged-library
 * skip makes a false notice cost one generation read.
 */
export function noticeMediaChange(db: SQLiteDatabase): Promise<void> {
  if (flight) {
    noticeQueued = true;
    return flight;
  }
  return startContinuousScan(db);
}

/**
 * Pull-to-refresh's trigger (m0.9 phase 9): a notice whose promise
 * settles when the check has CONCLUDED — skipped as unchanged, or a
 * pass under way (the status line is the feedback from there) — so the
 * spinner never spins for a whole pass.
 */
export function requestLibraryCheck(db: SQLiteDatabase): Promise<void> {
  console.log('[scan] notice: pull-to-refresh — checking');
  const flightDone = noticeMediaChange(db);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeScanStatus((s) => {
      if (s.phase !== 'checking') finish();
    });
    if (status.phase !== 'checking') finish();
    void flightDone.finally(finish);
  });
}

/**
 * A scan-relevant setting changed (photo source, grouping strictness):
 * run a fresh scan over the new configuration. An in-flight run finishes
 * against its old settings first (interrupting it would waste its
 * persisted progress for nothing — the queued rescan re-reads every
 * setting when it starts).
 */
export function requestRescan(
  db: SQLiteDatabase,
  /** 'settings' (an apply or reset asked for it) or 'manual' (the
   * Settings row's own "Rescan library"): the line names which. */
  origin: RescanOrigin = 'settings',
): Promise<void> {
  if (flight) {
    rescanQueued = origin;
    supersedeScan();
    return flight;
  }
  // FORCED: setting applies and resets rewrite scan output (groups,
  // scopes) without necessarily changing the fingerprint's inputs —
  // the unchanged-library skip must not swallow them.
  return startContinuousScan(db, { force: origin });
}

/** Why a forced pass was asked for — the status line names each. */
export type RescanOrigin = 'settings' | 'manual';

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
/** The pass's facts diagnostics are emitted on EVERY exit of the walk —
 * a superseded or aborted pass has already committed windows whose
 * marker is stamped, so a SEF tripwire seen there would otherwise be
 * lost for good (the next pass skips the stamped row). */
async function pageAndGroup(
  db: SQLiteDatabase,
  args: Parameters<typeof pageAndGroupWalk>[1],
): ReturnType<typeof pageAndGroupWalk> {
  try {
    return await pageAndGroupWalk(db, args);
  } finally {
    reportFactsPassStats();
  }
}

async function pageAndGroupWalk(
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
    /** A FULL pass's enumeration checkpoint (m0.9 phase 9): after each
     * closed dated window commits, the boundary it proves is persisted
     * (lib/scanCheckpoint.ts); `current` carries the resumed pass's
     * starting point so the boundary only ever moves down. Omitted for
     * deltas and targeted passes. */
    checkpoint?: {
      scope: string;
      generations: Readonly<Record<string, number>>;
      current: ScanCheckpoint | null;
      /** The pass's reason, carried so a resume can show it. */
      reason: FullPassReason;
    };
  },
): Promise<{ seenIds: Set<string>; skipped: number; exifFailed: number } | null> {
  const { ranges, albumIds, baseThreshold, engine, superseded, mountedVolumes, favourites } = args;
  const checkpoint = args.checkpoint ?? null;
  // Rows covered by CLOSED dated windows so far (codex r6): the status
  // counter runs a page ahead, and a checkpoint carrying it would
  // resume past rows the crash never committed. Starts at the resumed
  // pass's own base.
  let covered = checkpoint?.current?.scanned ?? 0;
  // Persist the boundary AFTER the window's transaction committed and
  // only while this pass is still the current one: a superseded write
  // was aborted inside its transaction, and a checkpoint past it would
  // claim coverage the queued rescan then skips. Through a SESSION
  // write transaction like every store write under a pass (measured on
  // the S10e, r2): a write on the shared main connection while a screen
  // read on it is mid-iteration fails at once with a stale-snapshot
  // BUSY that no busy timeout covers.
  // FROZEN once the pass owes a retry (codex r2): a fail-closed skip, a
  // read that did not complete or an engine error withholds the stamp
  // at the end, and the boundary must not move past the material those
  // conditions promise to revisit — the next resume then re-walks from
  // the last clean window, exactly as the retry contract says.
  const noteCheckpoint = async (window: readonly LoadedPhoto[]): Promise<void> => {
    if (checkpoint === null || superseded()) return;
    if (skipped > 0 || exifFailed > 0 || engine.engineErrors > 0) return;
    // Counted only when the window LOWERS the boundary, and only its
    // members BELOW the previous boundary (codex r9/r10): a resume's
    // above-boundary windows, and the above-boundary half of a window
    // straddling the saved boundary, are already inside the prior
    // checkpoint's coverage and must not inflate the resumed percent.
    const previous = checkpoint.current;
    const fresh =
      previous === null
        ? window.length
        : window.filter((p) => p.item.timestamp < previous.boundary).length;
    const next = advanceCheckpoint(previous, {
      scope: checkpoint.scope,
      generations: { ...checkpoint.generations },
      windowTimesMs: window.map((p) => p.item.timestamp),
      scanned: covered + fresh,
      reason: checkpoint.reason,
    });
    if (next === null) return;
    covered += fresh;
    checkpoint.current = next;
    // Re-checked INSIDE the transaction (codex r2): Forget supersedes
    // and deletes the checkpoint in its own transaction, and a write
    // queued behind it would otherwise recreate the boundary Forget's
    // walk from the top must not resume below.
    await withWriteTransaction(db, async (txn) => {
      if (superseded()) return;
      await setSetting(txn, SCAN_CHECKPOINT_KEY, JSON.stringify(next));
    });
  };
  resetFactsPassStats();
  // Fail-closed drops this pass: unparseable volumes (counted by the
  // adapter per page) plus parsed volumes outside the mounted set. Any
  // skip makes the pass ineligible to advance its baselines (finishPass).
  let skipped = 0;
  // EXIF reads attempted but never completed (codex r2): the pass may
  // finish, but storing its fingerprint would let the unchanged-library
  // skip hide the promised retry. The per-file facts reads (phase 4)
  // that did not complete count here too — same rule, same retry.
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
        // m0.9 phase 4: MIME, display name, duration, size and the
        // generation ride the page from the Files collection.
        await joinMediaFacts(page.photos);
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
        exifFailed += await processWindow(
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
      exifFailed += await processWindow(
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
            `its items are skipped this pass`,
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
        exifFailed += await processWindow(
          db,
          window,
          engine,
          baseThreshold,
          superseded,
          mountedVolumes,
          favourites,
        );
        await noteCheckpoint(window);
      }
    }
  }
  if (superseded()) return null;
  for (const window of accumulator.flush()) {
    if (superseded()) return null;
    exifFailed += await processWindow(
      db,
      window,
      engine,
      baseThreshold,
      superseded,
      mountedVolumes,
      favourites,
    );
    await noteCheckpoint(window);
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
  /** The changed items the delta lands (trashed rows excluded) — the
   * size the status line names (M9: items). */
  changed: number;
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
  /** Tracked rows the loss walk's probe named PENDING (codex r7/r8):
   * still tracked, absent from the pass-start count while they are
   * being rewritten, so the post-delta agreement nets them out as the
   * tripwire did. Only positively pending rows — a present or
   * undecidable candidate stays unexplained and fails closed. */
  pendingByVolume: Record<string, number>;
  /** The returned rows the loss walk kept (the bytes back on disk under
   * a new id): each is adopted by the window that lands the new id — and
   * when that row is still PENDING no window lands it this pass (codex
   * r10), so an old id still present after the walk is netted out of
   * the post-delta agreement, exactly like a pending row. */
  returnedIdsByVolume: Record<string, string[]>;
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
  return getMediaCountsByVolume([...volumes]);
}

/**
 * Canonical ids of every in-scope row on the given volumes — the
 * ids-only enumeration (m0.9 phase 9): one projected column per volume,
 * seconds on a 33k library. A dirs scope restricts to its buckets (a
 * volume with none in scope contributes nothing, exactly as the paging
 * does). `undatedOnly` returns the rows without DATE_TAKEN. Throws on
 * any failure: a partial set would read as deletions.
 */
async function enumerateMediaIds(
  volumes: readonly string[],
  albumIdsByVolume: Readonly<Record<string, string[]>> | null,
  undatedOnly = false,
): Promise<Set<string>> {
  const out = new Set<string>();
  // A dirs scope's bucket list is user-sized (a recursive root over
  // hundreds of albums): chunked under the provider's SQL variable
  // floor, the chunks unioned — one bucket belongs to one chunk.
  const BUCKET_CHUNK = 400;
  for (const volume of volumes) {
    const buckets = albumIdsByVolume === null ? [] : (albumIdsByVolume[volume] ?? []);
    if (albumIdsByVolume !== null && buckets.length === 0) continue;
    const chunks = albumIdsByVolume === null ? [[]] : chunkList(buckets, BUCKET_CHUNK);
    for (const part of chunks) {
      for (const rawId of await listMediaIds(volume, part, undatedOnly)) {
        out.add(canonicalPhotoId(volume, rawId));
      }
    }
  }
  return out;
}

function chunkList<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The ids-only loss reconciliation (F44, m0.9 phase 9). A volume holding
 * fewer in-scope rows than the DB tracks, net of the trashed rows the
 * change query reported, is the one trace a trash-bypassing delete
 * leaves — Samsung Gallery's Recycle bin moves the file under
 * Android/.Trash and deletes the MediaStore row outright (measured on
 * the S23), so the rows stayed present, as empty thumbnails, until a
 * 4.5-minute full pass found them. They are nameable without the walk:
 * enumerate the volume's in-scope ids, diff against the tracked present
 * set, and converge the difference exactly as the full pass's unseen
 * reconciliation would — through the SAME tri-state presence probe per
 * candidate (codex r1): the enumeration's default view omits a tracked
 * row an app is rewriting in place (IS_PENDING), and the uri-shaped
 * source clause can be looser than the bucket-shaped enumeration, so a
 * row the diff names is only gone when the probe says so; a row the
 * probe finds present or cannot decide stays, and the count it leaves
 * unexplained goes to the full pass as before. Mutates `counts` with
 * the post-reconciliation tracked numbers and returns the volumes whose
 * loss the walk could NOT explain. Throws propagate to the planner's
 * catch: an enumeration that failed proves nothing.
 */
async function reconcileUntracedLoss(
  db: SQLiteDatabase,
  losses: readonly string[],
  sources: {
    roots: readonly SourceRoot[] | null;
    albumIdsByVolume: Readonly<Record<string, string[]>> | null;
  },
  trashedIds: ReadonlySet<string>,
  counts: Record<string, VolumeCountRow>,
  mountedVolumes: ReadonlySet<string>,
  /** Out: the kept (pending or undecidable) count per volume. */
  pendingByVolume: Record<string, number>,
  /** Out: the returned candidates' old ids per volume. */
  returnedIdsByVolume: Record<string, string[]>,
): Promise<string[]> {
  for (const volume of losses) {
    const started = Date.now();
    const enumerated = await enumerateMediaIds([volume], sources.albumIdsByVolume);
    const tracked = await getPresentLossCandidates(db, sources.roots, volume);
    const candidates = tracked.filter((row) => !enumerated.has(row.id) && !trashedIds.has(row.id));
    const gone: string[] = [];
    let pending = 0;
    let returned = 0;
    const returnedIds: string[] = [];
    let unexplained = 0;
    for (const row of candidates) {
      // The probe FIRST (codex r8): only a row the provider itself names
      // PENDING is netted out of the count checks — an in-place rewrite
      // keeps its size, and the size shortcut below would have called it
      // a return. A row the probe finds plainly present yet absent from
      // the enumeration (the uri-shaped source clause is looser than the
      // bucket enumeration), or one it cannot decide, stays unexplained
      // and the full pass remains the answer — never a netted-out
      // "explanation" that advances the baseline over a stale row.
      const presence = await checkMediaPresenceDetailed({ id: row.id, kind: row.kind });
      if (presence === 'pending') {
        pending += 1;
        continue;
      }
      if (presence === 'trashed') {
        gone.push(row.id);
        continue;
      }
      if (presence === 'absent') {
        // The bytes still at the stored path at the stored size (codex
        // r6): the old id is gone from the provider but the file came
        // back under a NEW id in the same change set (a Gallery delete
        // and restore beside another delete). Not a loss — the window
        // that lands the new id adopts this row with its verdict intact,
        // and a tombstone written here would reset it to review.
        if (row.sizeBytes !== null && fileSizeOrNull(row.uri) === row.sizeBytes) {
          returned += 1;
          returnedIds.push(row.id);
        } else gone.push(row.id);
        continue;
      }
      unexplained += 1;
    }
    if (gone.length > 0) {
      await assertMountedUnchanged(mountedVolumes);
      await reconcileExternallyRemoved(db, gone, Date.now(), [...mountedVolumes]);
    }
    // Pending rows and returns are absent from the provider's default
    // view while still tracked: in flight for the tripwire, like a
    // reported trash (codex r6). Only the PENDING ones ride the decision
    // into the post-delta agreement (a return is adopted when landed,
    // so tracked and MediaStore agree on it by then).
    counts[volume].trashedInFlight += pending + returned;
    pendingByVolume[volume] = pending;
    returnedIdsByVolume[volume] = returnedIds;
    console.log(
      `[scan] delta: ${gone.length} tracked item(s) gone from ${volume} with no trace — ` +
        `reconciled by an id walk over ${enumerated.size} rows in ${Date.now() - started} ms` +
        (pending > 0 ? ` (${pending} still being written — deferred)` : '') +
        (returned > 0 ? ` (${returned} back on disk under a new id — adopted when landed)` : '') +
        (unexplained > 0 ? ` (${unexplained} present or undecidable — unexplained)` : ''),
    );
  }
  const trackedAfter = await countTrackedByVolume(db, sources.roots);
  for (const volume of losses) counts[volume].tracked = trackedAfter[volume] ?? 0;
  return volumesWithUntracedLoss(counts);
}

/**
 * Decide whether this pass can be a delta, and over which ranges.
 *
 * Returns a FullPassReason for "run a full pass" — every uncertainty
 * resolves that way, because a full pass is exactly what shipped before
 * the delta existed. A missing baseline, an unreadable change set or a
 * cost model that says the delta is not a decisive win all land here.
 *
 * INVARIANT (F27, m0.8.7): every fallback to a full pass logs its
 * reason before returning, and (m0.9 phase 9) RETURNS it, so the status
 * line names it; none returns silently. The one unlogged fallback (the
 * undated bail, which ran AFTER the "DELTA wins" line printed) is
 * exactly how every WhatsApp arrival silently cost a 5-minute corpus
 * walk. The force-shaped reasons (forced rescan, model swap, a resume,
 * weekly due, generation gap) are decided by scan() before this runs.
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
  /** All mounted volumes at pass start — the loss reconciliation's fence
   * and its repair's reachability. */
  mountedVolumes: ReadonlySet<string>,
): Promise<DeltaDecision | FullPassReason> {
  const roots = sources.roots;
  try {
    const raw = await getSetting(db, SCAN_GENERATIONS_KEY);
    if (raw === null) {
      console.log('[scan] delta: no stored baseline — the first pass must be full');
      return 'first';
    }
    const previous = JSON.parse(raw) as Record<string, number>;
    const keys = Object.keys(filteredGenerations);
    // Mirror scanCanSkip's rule: an EMPTY generation map means the native
    // read FAILED (or no scope-relevant volume is mounted) — either way
    // there is nothing to prove a delta against.
    if (keys.length === 0) {
      console.log('[scan] delta: no generation evidence for any in-scope volume — full pass');
      return 'storage';
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
      return 'storage';
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
    const inSource = filterChangedToSources(allChanged, sources.albumIdsByVolume);
    if (inSource.length < allChanged.length) {
      console.log(
        `[scan] delta: ${allChanged.length - inSource.length} out-of-source change(s) ignored`,
      );
    }
    // PENDING rows (m0.9 phase 9, the pending-row race): Samsung's camera
    // holds a fresh capture in MediaStore's PENDING state for seconds; a
    // delta racing that window used to lump the row with the out-of-
    // source changes and then NOTHING re-checked. Named for what it is
    // and left out of the plan — the row cannot be paged yet, and the
    // observer re-fires when it finalizes (its GENERATION_MODIFIED moves
    // again, so the next change query reports it).
    const pending = inSource.filter((row) => row.isPending);
    if (pending.length > 0) {
      console.log(
        `[scan] delta: ${pending.length} change(s) still being written (MediaStore pending) — ` +
          `re-checked when they finalize`,
      );
    }
    const changed = inSource.filter((row) => !row.isPending);
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
          `[scan] delta: ${moved.length} changed items moved their DATE_TAKEN — ` +
            `full pass to rewindow both sides`,
        );
        return 'dates';
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
    // A loss with no trace routes to the ids-only reconciliation first
    // (F44, m0.9 phase 9); only a loss the id walk cannot explain still
    // costs the full pass.
    const losses = volumesWithUntracedLoss(counts);
    const pendingByVolume: Record<string, number> = {};
    const returnedIdsByVolume: Record<string, string[]> = {};
    if (losses.length > 0) {
      const unexplained = await reconcileUntracedLoss(
        db,
        losses,
        sources,
        new Set(trashedIds),
        counts,
        mountedVolumes,
        pendingByVolume,
        returnedIdsByVolume,
      );
      if (unexplained.length > 0) {
        console.log(
          `[scan] delta: tracked items gone from MediaStore with no trace on ` +
            `${unexplained.join(', ')} — the id walk could not explain it; full pass to reconcile`,
        );
        return 'loss';
      }
    }
    const plan = planDeltaRanges(changed, timestamps, ADJACENT_MERGE_MAX_GAP_MS);
    const verdict = deltaVerdict({
      covered: coveredBy(timestamps, plan.ranges),
      changed: plan.changed,
      ranges: plan.ranges.length,
      corpus: timestamps.length,
    });
    console.log(`[scan] ${describeDeltaPlan(plan, verdict)}`);
    if (!verdict.worthIt) return 'cost'; // reason printed on the line above
    // UNDATED changes (no DATE_TAKEN) cannot be placed in any range —
    // they land by direct per-id fetch instead (F27; each one used to
    // silently discard the whole delta AFTER "DELTA wins" printed,
    // turning every WhatsApp arrival into a corpus walk). Trashed
    // undated rows need no fetch: trashedIds reconciles them by id.
    const undatedIds = changed
      .filter((row) => !row.isTrashed && row.dateTakenMs === null)
      .map((row) => canonicalPhotoId(row.volumeName, row.rawId));
    return {
      ranges: plan.ranges,
      changed: plan.changed - plan.trashed,
      trashedIds,
      undatedIds,
      mediaByVolumeAtStart: mediaByVolume,
      pendingByVolume,
      returnedIdsByVolume,
    };
  } catch (error) {
    console.log(`[scan] delta unavailable, running a full pass: ${String(error)}`);
    return 'unavailable';
  }
}

/**
 * A RESUMED full pass's coverage (lib/scanCheckpoint.ts, m0.9 phase 9):
 * the dated walk BELOW the checkpoint's boundary; the rows changed
 * ABOVE it since the checkpoint's generations, re-paged as delta ranges
 * clipped to the boundary (the camera did not stop between sessions);
 * the undated tail by ids (no bounded range reaches it); and the
 * trashed rows since, by id. A capture-time move above the boundary is
 * the one change a resume cannot repair — it throws, like any read
 * failure here, and the caller walks from the top instead: a resume
 * that cannot see what changed above its boundary would stamp a lie.
 */
async function planResume(
  db: SQLiteDatabase,
  checkpoint: ScanCheckpoint,
  generations: Readonly<Record<string, number>>,
  sources: {
    roots: readonly SourceRoot[] | null;
    albumIdsByVolume: Readonly<Record<string, string[]>> | null;
  },
  mountedVolumes: ReadonlySet<string>,
): Promise<{ ranges: TimeRange[]; undatedIds: string[]; trashedIds: string[] }> {
  const allChanged: ChangedMediaRow[] = [];
  const keys = Object.keys(generations);
  for (const key of keys) {
    const since = checkpoint.generations[key];
    if (since === undefined) throw new Error(`no checkpoint generation for ${key}`);
    if (since === generations[key]) continue;
    allChanged.push(...(await getMediaChangedSince(rawVolumeOfKey(key), since)));
  }
  const inSource = filterChangedToSources(allChanged, sources.albumIdsByVolume).filter(
    (row) => !row.isPending,
  );
  // A capture-time move anywhere in the change set is the one change a
  // resume cannot repair (both windows re-form, and one may be above
  // the boundary): the delta planner refuses it the same way.
  const stored = await getTakenAtForAssets(
    db,
    inSource.map((row) => canonicalPhotoId(row.volumeName, row.rawId)),
  );
  const moved = inSource.filter((row) => {
    if (row.isTrashed) return false;
    const oldAt = stored.get(canonicalPhotoId(row.volumeName, row.rawId));
    return oldAt !== undefined && oldAt !== row.dateTakenMs;
  });
  if (moved.length > 0) {
    throw new Error(`${moved.length} changed item(s) moved their DATE_TAKEN since the checkpoint`);
  }
  // "Above" reaches one merge gap BELOW the boundary too: the closed
  // window's members sit at or above it, and a row that landed since
  // within a gap of them (a backdated arrival) belongs in THEIR window
  // — the planner's expansion over the stored timestamps then re-pages
  // the window whole, and the clip below keeps the main range from
  // paging the same rows twice.
  const reach = checkpoint.boundary - ADJACENT_MERGE_MAX_GAP_MS;
  const above = changesAboveBoundary(inSource, reach);
  // Rows that LEFT the prefix between sessions (codex r2) — trashed,
  // deleted with no trace, moved out of scope: their old windows were
  // grouped WITH them and must re-form without them, as a clean pass
  // would have them. The ids-only enumeration names the departed rows;
  // the end-of-pass reconciliation converges them.
  const enumerated = await enumerateMediaIds([...mountedVolumes], sources.albumIdsByVolume);
  const departed = (
    await getPresentPhotosSince(db, sources.roots, [...mountedVolumes], reach)
  ).filter((row) => !enumerated.has(row.id));
  const points: ChangedMediaRow[] = [
    ...above,
    ...departed.map((row) => ({
      volumeName: volumeOf(row.id),
      rawId: rawIdOf(row.id),
      mediaType: 'photo' as const,
      dateTakenMs: row.takenAt,
      dateModifiedSec: null,
      isTrashed: false,
      isPending: false,
      generationAdded: 0,
      generationModified: 0,
      bucketId: null,
    })),
  ];
  const timestamps = await getPhotoTimestamps(db, sources.roots);
  const plan = planDeltaRanges(points, timestamps, ADJACENT_MERGE_MAX_GAP_MS);
  // Clipped to the boundary: the main range covers everything below it,
  // and the merged pager hands a window straddling the two to the
  // accumulator in order — contiguous, never overlapping.
  const ranges: TimeRange[] = [
    { startMs: 0, endMs: checkpoint.boundary - 1 },
    ...plan.ranges
      .filter((range) => range.endMs >= checkpoint.boundary)
      .map((range) => ({
        startMs: Math.max(range.startMs, checkpoint.boundary),
        endMs: range.endMs,
      })),
  ];
  const undated = await enumerateMediaIds(keys.map(rawVolumeOfKey), sources.albumIdsByVolume, true);
  const trashedIds = inSource
    .filter((row) => row.isTrashed)
    .map((row) => canonicalPhotoId(row.volumeName, row.rawId));
  console.log(
    `[scan] resuming the interrupted full pass below ${new Date(checkpoint.boundary).toISOString()} ` +
      `(${checkpoint.scanned} already walked; ${above.length} changed and ${departed.length} departed above it → ` +
      `${plan.ranges.length} range(s); ${undated.size} undated by id; ${trashedIds.length} trashed since)`,
  );
  return { ranges, undatedIds: [...undated], trashedIds };
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
      `[scan] ${skipped} items were skipped fail-closed (volume unparseable or unmounted) — ` +
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
  // A completed resumed pass IS the full pass; its checkpoint is spent
  // (m0.9 phase 9). Kept while the stamp is withheld above: the next
  // open then resumes at the last boundary and retries the withheld
  // reads instead of re-walking the whole library.
  if (args.wasFullPass) {
    await setSetting(db, SCAN_FULL_AT_KEY, String(Date.now()));
    await deleteSetting(db, SCAN_CHECKPOINT_KEY);
  }
}

async function scan(db: SQLiteDatabase, force: RescanOrigin | null): Promise<void> {
  const generation = scanGeneration;
  const superseded = (): boolean => generation !== scanGeneration;

  // TARGETED pass (Regroup_design §5): drain the eject/un-eject targets
  // and return — never a full pass's stamps (no fingerprint, no
  // baselines, no reconciliation: re-placement is presentation repair
  // and must not claim verification). A forced rescan outranks it: the
  // full pass covers every target anyway.
  const targets = pendingTargets.splice(0);
  if (targets.length > 0 && force === null) {
    await targetedPass(db, targets, superseded);
    return;
  }
  // A forced run DROPS drained targets: the full pass below re-windows
  // the whole library, targets included.

  // CHECKING, not scanning (m0.9 phase 9): nothing is known yet, and
  // the surfaces render nothing for this phase.
  status = { ...IDLE, phase: 'checking' };
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
  // A library with no baseline yet has nothing to be "weekly" about: the
  // first pass is named as such (codex r1 — the weekly clock is unset on
  // a fresh database too, and used to outrank the missing baseline).
  const firstPass = (await getSetting(db, SCAN_GENERATIONS_KEY)) === null;
  // THE CHECKPOINT (m0.9 phase 9): an interrupted full pass over this
  // scope owes the rest of its walk, and owes it BEFORE the skip or a
  // delta can claim the library current (the interrupted pass stored no
  // fingerprint, but an older complete pass's may still match, and a
  // delta over "no changes" would stamp a half-regrouped library). A
  // forced pass or a model swap discards it — their full walk is the
  // point; so does a scope or storage change it cannot cover.
  const scope = checkpointScope({
    roots: sources.roots ?? null,
    strictness: rawStrictness,
    modelSha: MODEL_SHA256,
  });
  let checkpoint = parseCheckpoint(await getSetting(db, SCAN_CHECKPOINT_KEY));
  if (checkpoint !== null) {
    const resumable =
      !force &&
      !model.cleared &&
      canResume(checkpoint, { scope, generationKeys: Object.keys(relevantGenerations) });
    if (!resumable) {
      console.log(
        `[scan] checkpoint discarded (${
          force ? 'forced rescan' : model.cleared ? 'model changed' : 'scope or storage changed'
        })`,
      );
      await deleteSetting(db, SCAN_CHECKPOINT_KEY);
      checkpoint = null;
    }
  }
  if (!force && !model.cleared && !fullDue && !generationGap && checkpoint === null) {
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

  // The pass's checkpoint scope comes from the FRESH resolution; a stale
  // cached scope at the check above cannot resume a pass over another.
  const passScope = checkpointScope({
    roots: passSources.roots ?? null,
    strictness: rawStrictness,
    modelSha: MODEL_SHA256,
  });
  if (checkpoint !== null && passScope !== scope) {
    console.log('[scan] checkpoint discarded (source scope changed since the last pass)');
    await deleteSetting(db, SCAN_CHECKPOINT_KEY);
    checkpoint = null;
  }
  // The pass-shaped reasons, in precedence: a forced walk and a model
  // swap discard everything; a resumable checkpoint outranks the weekly
  // clock (the resumed pass IS the weekly pass when due); a generation
  // gap forces FULL (final cycle R2): a volume that mounted between the
  // generation and mounted reads has no entry, so a delta planned from
  // the older keys could complete "verified" without ever enumerating
  // the card.
  const forcedReason: FullPassReason | null = force
    ? force === 'manual'
      ? 'manual'
      : 'forced'
    : model.cleared
      ? 'model'
      : checkpoint !== null
        ? 'resume'
        : firstPass
          ? 'first'
          : fullDue
            ? 'weekly'
            : generationGap
              ? 'storage'
              : null;
  // ONE line for the reason the precedence selected (codex r3): the
  // sink and the status name the same reason, never a lower-priority
  // condition that was also true (F27's invariant: no silent full pass).
  if (forcedReason !== null) {
    const detail: Record<
      Exclude<FullPassReason, 'cost' | 'dates' | 'loss' | 'inconsistent' | 'unavailable'>,
      string
    > = {
      forced: 'forced rescan (settings change or reset)',
      manual: 'forced rescan (the Settings row)',
      model: 'embedding model changed — every vector is recomputed',
      resume: 'an interrupted full pass resumes at its checkpoint',
      first: 'no stored baseline — the first pass must be full',
      weekly: 'full pass due — weekly reconciliation',
      storage: 'a mounted volume has no generation evidence',
    };
    console.log(`[scan] full pass: ${detail[forcedReason]}`);
  }

  // The mounted-volume set at pass start (m0.8.3, D7): ALL mounted
  // volumes (scope filtering is the query's job — a photo on any mounted
  // volume is validly stamped). Never null: acquisition failure aborted
  // the pass above.
  const mountedVolumes: ReadonlySet<string> = new Set(mounted);

  // DELTA vs FULL (m0.8.2 phase 2). Both run the SAME grouping code
  // below, differing only in which time ranges they page — which is what
  // makes "a delta produces the groups a full pass would" a structural
  // property rather than a hope.
  const decision: DeltaDecision | FullPassReason =
    forcedReason ??
    (await planPass(
      db,
      passRelevantGenerations,
      {
        roots: passSources.roots ?? null,
        albumIdsByVolume: passSources.albumIdsByVolume ?? null,
      },
      mountedVolumes,
    ));

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
        for (const rawId of await getFavouriteMediaIds(volume)) {
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

  let fullReason: FullPassReason;
  if (typeof decision === 'string') {
    fullReason = decision;
  } else {
    update({ phase: 'scanning', kind: 'delta', reason: null, changed: decision.changed });
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
      console.log(`[scan] delta: ${decision.trashedIds.length} trashed items left the queue`);
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
    // Net of the rows the loss walk kept as in flight (codex r7): a
    // pending in-place rewrite is tracked and absent from the pass-start
    // count, and must not read as a missed removal here.
    for (const [volume, pending] of Object.entries(decision.pendingByVolume)) {
      if (pending > 0) trackedAfter[volume] = (trackedAfter[volume] ?? 0) - pending;
    }
    // A returned row still under its OLD id after the walk was not
    // adopted — its new row is still pending and no window landed it
    // (codex r10): netted out like a pending row, so the agreement
    // does not send it to a full pass that would tombstone it.
    for (const [volume, ids] of Object.entries(decision.returnedIdsByVolume)) {
      let deferred = 0;
      for (const id of ids) {
        // Still present under the old id AND no landed twin at its path:
        // the replacement is pending (codex r11 — a twin landed beside
        // it means the adoption declined, a ghost that must fail closed).
        if ((await countPresentPhotos(db, [id])) === 0) continue;
        if (await hasPresentTwinAtPath(db, id)) continue;
        deferred += 1;
      }
      if (deferred > 0) trackedAfter[volume] = (trackedAfter[volume] ?? 0) - deferred;
    }
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
      logFootprint('delta done');
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
    fullReason = 'inconsistent';
  }

  // A FULL pass's denominator is the library snapshot (F3 — the percent
  // branch); a delta keeps total null and the line shows plain counts.
  if (status.total === null) update({ total: status.corpusTotal });

  // The work actually LEFT, from durable state (m0.9 phase 9): the
  // snapshot minus present rows that need no analysis. Named on a
  // resumed pass, where the enumeration counter cannot be trusted.
  const analyzed = await countAnalyzedPresent(db, passSources.roots ?? null, mounted).catch(
    (error): null => {
      console.warn('[scan] analyzed count failed — no remaining count this pass:', String(error));
      return null;
    },
  );
  const remaining =
    status.corpusTotal !== null && analyzed !== null
      ? Math.max(0, status.corpusTotal - analyzed)
      : null;

  // The resumed pass's coverage, or the whole library.
  let ranges: TimeRange[] = [FULL_RANGE];
  let resumeUndatedIds: string[] | undefined;
  let resumeTrashedIds: string[] = [];
  let resumed: ScanCheckpoint | null = null;
  if (fullReason === 'resume' && checkpoint !== null) {
    try {
      const plan = await planResume(
        db,
        checkpoint,
        passRelevantGenerations,
        {
          roots: passSources.roots ?? null,
          albumIdsByVolume: passSources.albumIdsByVolume ?? null,
        },
        mountedVolumes,
      );
      ranges = plan.ranges;
      resumeUndatedIds = plan.undatedIds;
      resumeTrashedIds = plan.trashedIds;
      resumed = checkpoint;
      // The interrupted pass's own reason, resumed (Tristan, 2026-10-03):
      // the user may never have seen it before the interruption.
      if (checkpoint.reason !== undefined && checkpoint.reason !== 'resume') {
        fullReason = checkpoint.reason;
      }
    } catch (error) {
      // The reason stays 'resume' — the line's "still to analyze" is
      // durable truth whichever row the walk starts from; only the
      // boundary is given up.
      console.log(`[scan] resume unavailable, walking from the top: ${String(error)}`);
      await deleteSetting(db, SCAN_CHECKPOINT_KEY);
      checkpoint = null;
    }
  }
  // OUTSIDE the planner's catch (self-review, REVIEW_CLASSES 25): the
  // mount fence's throw must abort the pass as it does everywhere else,
  // never read as "resume unavailable" and walk on under a changed
  // mounted set.
  if (resumeTrashedIds.length > 0) {
    await assertMountedUnchanged(mountedVolumes);
    await reconcileExternallyRemoved(db, resumeTrashedIds, Date.now(), [...mountedVolumes]);
    console.log(`[scan] resume: ${resumeTrashedIds.length} trashed items left the queue`);
  }
  update({
    phase: 'scanning',
    kind: 'full',
    reason: fullReason,
    remaining,
    resumed: resumed !== null,
    scanned: resumed !== null ? resumed.scanned : status.scanned,
  });

  const fullResult = await pageAndGroup(db, {
    ranges,
    albumIds: passSources.albumIds ?? undefined,
    baseThreshold: strictness.baseThreshold,
    engine,
    superseded,
    mountedVolumes,
    favourites,
    undatedIds: resumeUndatedIds,
    // Checkpoints need a generation to re-page from on resume: without
    // one (the native read failed) the pass still runs, unresumable.
    checkpoint:
      Object.keys(passRelevantGenerations).length > 0
        ? {
            scope: passScope,
            generations: passRelevantGenerations,
            current: resumed,
            reason: fullReason,
          }
        : undefined,
  });
  if (fullResult === null) {
    console.log('[scan] superseded by a settings change — stopping for the queued rescan');
    return;
  }
  // A RESUMED pass's own walk covered only the part below its boundary:
  // its "seen" set is the ids-only enumeration (seconds), which is the
  // same evidence a complete walk's would be. Throws → the pass errors
  // and the next open resumes at the final boundary and retries.
  const seenIds =
    resumed !== null
      ? await enumerateMediaIds([...mountedVolumes], passSources.albumIdsByVolume ?? null)
      : fullResult.seenIds;

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
  const tracked = await getPresentAssetRefs(db, passSources.roots ?? null, [...mountedVolumes]);
  const unseen = tracked.filter((ref) => !seenIds.has(ref.id));
  const RECONCILE_CAP = 500;
  if (unseen.length > RECONCILE_CAP) {
    // Loud, once: the remainder reconciles on later scans/History pages.
    console.warn(
      `[scan] ${unseen.length} unseen tracked items — verifying only ${RECONCILE_CAP} this run`,
    );
  }
  const gone: string[] = [];
  let movedUris = 0;
  let unresolved = 0;
  for (const ref of unseen.slice(0, RECONCILE_CAP)) {
    const id = ref.id;
    const presence = await checkMediaPresence(ref);
    if (presence === 'trashed' || presence === 'absent') {
      // Both converge the same way — duels are append-only (v22) and
      // survive every removal, so 'absent' needs no separate marking.
      gone.push(id);
    } else if (presence === 'present') {
      // Present but NOT enumerated: the photo moved (same MediaStore id,
      // new path — e.g. out of the selected source). Refresh its uri so
      // source-scoped reads stop surfacing it under the stale path.
      const details = await getAssetDetails(ref);
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
      `[scan] ${unresolved} unseen items could not be verified — ` +
        `baseline withheld; the next pass retries them`,
    );
  }
  if (gone.length > 0) {
    // Fence + mounted-aware repair (codex phase-2), same as the delta's
    // trashed reconcile above.
    await assertMountedUnchanged(mountedVolumes);
    await reconcileExternallyRemoved(db, gone, Date.now(), [...mountedVolumes]);
    console.log(`[scan] reconciled ${gone.length} externally removed items`);
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
  logFootprint('scan done');
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
  status = { ...IDLE, phase: 'scanning', kind: 'targeted' };
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
    // m0.9 phase 4: videos carry no EXIF header — an undated video stays
    // honestly undated, never probed, never counted as a failed read.
    if (photo.item.kind !== 'photo') continue;
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
        getEditableContentUri({ id: photo.item.id, kind: photo.item.kind }),
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

/** The upsert row for one paged item — the window's write and the
 * returning-file adoption build the same row (favourite added by the
 * write, from its pass-start snapshot). */
function upsertRowOf(p: LoadedPhoto): ContinuousPhotoUpsert {
  return {
    assetId: p.item.id,
    uri: p.item.uri,
    takenAt: p.item.timestamp,
    modTime: p.modTime,
    fileGeneration: p.generation,
    fileMtime: p.modTime,
    // v24 media kinds: MediaStore's facts (the page join / the direct
    // fetch) plus the per-file read's results when it completed.
    kind: p.item.kind,
    mimeType: p.mimeType,
    displayName: p.displayName ?? p.filename,
    width: p.width > 0 ? p.width : null,
    height: p.height > 0 ? p.height : null,
    durationMs: p.durationMs,
    motionVideoOffset: p.facts?.motionVideoOffset ?? null,
    motionVideoLength: p.facts?.motionVideoLength ?? null,
    motionPresentationUs: p.facts?.motionPresentationUs ?? null,
    factsCheckedVersion: p.facts?.factsCheckedVersion ?? null,
    // Undated photos carry NO day: their timestamp is only the mtime
    // fallback, and the day surfaces exclude them on both sides.
    day: p.undated ? null : dayKey(p.item.timestamp),
    volumeName: p.volumeName,
    rawId: p.rawId,
    // v14: recorded so reclaimable bytes is an exact SUM (0 = the
    // stat failed → NULL keeps the row in the transient stat-fallback).
    sizeBytes: p.sizeBytes ?? (fileSize(p.item.uri) || null),
    // NULL unless the D15 rescue completed a read this pass — the
    // upsert's COALESCE then retains any stored marker.
    exifCheckedModTime: p.exifCheckedModTime ?? null,
  };
}

/** Embed, group, and persist one closed merge window. Returns the
 * number of per-file facts reads that did NOT complete (the pass adds
 * them to its withheld-baseline count). */
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
): Promise<number> {
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
  // m0.9 phase 4: only PHOTOS reach the engine — videos are singles by
  // design (G5: no grouping, no embeddings) and ride the window only so
  // they land in capture order with their neighbours.
  const photos = window.filter((p) => p.item.kind === 'photo');
  const videos = window.filter((p) => p.item.kind === 'video');
  // The bounded per-file read (phase 4, item 6) — motion detection and
  // the measurement rescue for every item whose marker is stale.
  const factsFailed = await applyMediaFactsRead(db, window);

  // dHash floor input rides the embed pipeline (module-computed from the
  // same decode — never the manipulator path, which leaks at corpus
  // scale); only bursts with company can contain near-dup pairs, so
  // singles-only windows skip the hash work entirely.
  const withHashes = hasMultiPhotoBurst(photos);
  // Field timings per window (phase 8): the three stages that hold the
  // JS thread or the database — the embed pass (native decode, per-
  // photo persists), the SYNCHRONOUS engine pass (pure JS over the
  // window's vectors: nothing else runs while it does), and the write
  // transaction. Named beside the `js thread lag` line they explain.
  const embedStarted = Date.now();
  const { vectors, hashes } = await ensureEmbeddings(
    db,
    photos,
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
  perfAggregate('scan window embed', Date.now() - embedStarted, photos.length);
  // A returning file adopts its tombstone BEFORE the constraints read
  // (phase 9, F44; codex r2): its not-related judgments live under the
  // old id until then, and a plan made without them would be skipped at
  // the write's revalidation. The window's write then revives the row
  // under its new id.
  if (mountedVolumes) await assertMountedUnchanged(mountedVolumes);
  await adoptReturningFiles(db, window.map(upsertRowOf), async (ref) => {
    const presence = await checkMediaPresence(ref);
    return presence === 'absent' || presence === 'trashed';
  });
  const cannotLink = await getNotRelatedPairsAmong(db, ids);

  const groupStarted = Date.now();
  const groups = groupByEmbedding(
    photos.map((p) => p.item),
    (id) => vectors.get(id) ?? null,
    withHashes ? (id) => hashes.get(id) ?? null : undefined,
    { baseThreshold, cannotLink },
  );
  perfAggregate('scan window group', Date.now() - groupStarted, photos.length);
  const multi = groups.filter((g) => g.items.length >= 2);
  const singles = [
    ...groups.filter((g) => g.items.length === 1).map((g) => g.items[0].id),
    ...videos.map((v) => v.item.id),
  ];

  // Re-check right before the write — a user write may have started
  // while the embed phase above was running — and re-verify the MOUNTED
  // SET (codex phase-2; ordered AFTER the user-write wait, final cycle
  // round 2: the wait itself is a window): an eject after the pass-start
  // snapshot silently empties merged paging, and the fence aborts before
  // any write can act on that stale picture.
  await waitForUserWrites();
  if (mountedVolumes) await assertMountedUnchanged(mountedVolumes);
  const writeStarted = Date.now();
  await writeContinuousGroups(
    db,
    {
      photos: window.map((p) => ({ ...upsertRowOf(p), favourite: favouriteOf(p.item.id) })),
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
  perfAggregate('scan window write', Date.now() - writeStarted, window.length);
  update({ windowsGrouped: status.windowsGrouped + 1 });
  return factsFailed;
}

/**
 * The bounded per-file read (m0.9 phase 4, item 6): motion-photo
 * detection plus M17's measurement rescue, ONE open per content version,
 * through the module's `readMediaFacts` (MediaFacts.kt). Runs where the
 * D15 rescue runs — per window, before the write — and the weekly full
 * pass IS the one-time backfill: every row whose `facts_checked_version`
 * differs from the version about to be written is read, so the corpus
 * converges and an edited file (new version) is re-read. Mutates the
 * window in place (`facts`, and width/height/duration when measured).
 * Returns the count of reads that did NOT complete: the pass withholds
 * its baseline over them (like EXIF failures), so the next pass retries.
 * Module absent → nothing attempted, zero failures (a failure that can
 * never succeed must not defeat the unchanged-library skip forever).
 */
const MOTION_LOG_CAP = 8;
/** Per-PASS diagnostics for the facts read: the first few detections
 * named per pass, and the SEF tripwire's count reported ONCE per pass
 * (applyMediaFactsRead runs per window). Reset at pass start
 * (pageAndGroup), emitted at pass end. */
const factsPassStats = { motionLogged: 0, sefWithoutXmp: 0 };
function resetFactsPassStats(): void {
  factsPassStats.motionLogged = 0;
  factsPassStats.sefWithoutXmp = 0;
}
function reportFactsPassStats(): void {
  if (factsPassStats.sefWithoutXmp > 0) {
    // The SEF tripwire: the specimen the unparsed-trailer decision lacks.
    console.warn(
      `[scan] media facts: ${factsPassStats.sefWithoutXmp} file(s) carry a Samsung SEF motion block with NO motion XMP — ` +
        'unrecognised container, read as stills (the trailer parser is built when such a file exists)',
    );
  }
}
async function applyMediaFactsRead(db: SQLiteDatabase, window: LoadedPhoto[]): Promise<number> {
  if (!mediaStoreActionsAvailable()) return 0;
  const stored = await getFactsBaselines(
    db,
    window.map((p) => p.item.id),
  );
  const versionOf = (p: LoadedPhoto): number => p.generation ?? p.modTime;
  const toRead = window.filter((p) => stored.get(p.item.id) !== versionOf(p));
  if (toRead.length === 0) return 0;
  let failed = 0;
  let motion = 0;
  const READ_CHUNK = 50;
  for (let i = 0; i < toRead.length; i += READ_CHUNK) {
    const chunkPhotos = toRead.slice(i, i + READ_CHUNK);
    const requests: MediaFactsRequest[] = await Promise.all(
      chunkPhotos.map(async (p) => ({
        uri: await getEditableContentUri({ id: p.item.id, kind: p.item.kind }),
        kind: p.item.kind,
        motion: p.item.kind === 'photo',
        dimensions: !(p.width > 0 && p.height > 0),
        duration: p.item.kind === 'video' && p.durationMs === null,
      })),
    );
    let results;
    try {
      results = await readMediaFacts(requests);
    } catch (error) {
      failed += chunkPhotos.length;
      console.warn(`[scan] media facts read failed for a chunk: ${String(error)}`);
      continue;
    }
    for (let j = 0; j < chunkPhotos.length; j++) {
      const result = results[j];
      const p = chunkPhotos[j];
      if (!result || result.status !== 'ok') {
        failed += 1;
        continue;
      }
      perfAggregate('media facts', result.elapsedMs, 1);
      if (result.width && result.height) {
        p.width = result.width;
        p.height = result.height;
      }
      if (result.durationMs != null) p.durationMs = result.durationMs;
      if (result.sefMotionWithoutXmp) factsPassStats.sefWithoutXmp += 1;
      if (result.motionOffset != null) {
        motion += 1;
        // The first few detections per pass, named — the device pass
        // checks these against the specimen files' known offsets; the
        // count line below covers the rest (no per-item flooding).
        if (factsPassStats.motionLogged < MOTION_LOG_CAP) {
          factsPassStats.motionLogged += 1;
          console.log(
            `[scan] motion photo ${p.displayName ?? p.filename}: video at ` +
              `${result.motionOffset}+${result.motionLength ?? '?'}` +
              (result.durationMs != null ? `, ${result.durationMs} ms` : '') +
              (result.motionPresentationUs != null
                ? ` (still at ${result.motionPresentationUs} µs)`
                : ''),
          );
        }
      }
      p.facts = {
        factsCheckedVersion: versionOf(p),
        motionVideoOffset: result.motionOffset ?? null,
        motionVideoLength: result.motionLength ?? null,
        motionPresentationUs: result.motionPresentationUs ?? null,
      };
    }
  }
  if (failed > 0) {
    console.warn(
      `[scan] media facts: ${failed} of ${toRead.length} reads did not complete — retried next pass`,
    );
  }
  if (motion > 0)
    console.log(`[scan] media facts: ${motion} motion photo(s) among ${toRead.length} read`);
  return failed;
}

/** Does any 3-min burst in this (chronological) window hold ≥ 2 photos? */
function hasMultiPhotoBurst(window: readonly LoadedPhoto[]): boolean {
  for (let i = 1; i < window.length; i++) {
    if (window[i].item.timestamp - window[i - 1].item.timestamp <= MOMENTS_GAP_MS) return true;
  }
  return false;
}
