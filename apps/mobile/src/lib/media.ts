/**
 * MediaStore adapter — maps expo-media-library assets into core MediaItems.
 *
 * Uses the SDK 57 *legacy* API (`expo-media-library/legacy`) deliberately:
 * the new class-based Query/Asset API landed in SDK 57 and the legacy
 * functions (`getAssetsAsync` paging) are the documented, battle-tested path.
 * Destructive actions deliberately bypass the legacy delete API and use the
 * app's MediaStore trash-request module below.
 *
 * DO NOT REMOVE `WRITE_EXTERNAL_STORAGE` FROM app.json. It looks dead — the
 * app calls no expo-media-library write API, and Android grants nothing for
 * it from API 30 — but below API 33 the library's own read gate
 * (`MediaLibraryModule.hasReadPermissions`) requires READ **and** WRITE to
 * be granted before ANY read call, and a permission absent from the manifest
 * can never be granted. Removing it leaves every `getAssetsAsync` here
 * throwing "Missing MEDIA_LIBRARY permissions" forever on Android 11/12 —
 * measured on the S10e (API 31), 2026-07-30: 0 photos scanned, vs 5 795 with
 * it kept. Harmless-looking on API 33+, which is why only an API 30-32
 * device catches it.
 */
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import type { MediaItem } from '@afterglow/core';
import {
  getMediaPresence,
  getMountedVolumes,
  loadMediaByVolumeId,
  mediaStoreActionsAvailable,
  queryMediaDetailsByUri,
  queryMediaFactsByIds,
  trashMedia,
  type MediaPresence,
  type MediaStoreActionStatus,
} from '../../modules/media-store-actions';

/**
 * Canonical volume-qualified identity (m0.7 gate 1, P4#2): every photo id
 * that leaves this adapter is `<volume>/<raw MediaStore id>`. This is THE
 * ingestion boundary (P5#1) — the legacy Expo asset's bare raw id never
 * reaches the core model or SQLite keys. The volume is REAL (m0.8.3, D7):
 * parsed from the asset's uri path by mechanism D (`volumeOfUriPath`),
 * never assumed primary. FAIL CLOSED: an asset whose volume cannot be
 * parsed is skipped LOUDLY (dropped from the page, warned once per
 * directory shape, counted in the page's `skipped`) — the scan reads the
 * count and withholds its baselines, because a pass must not claim
 * coverage it did not achieve.
 */
export { PRIMARY_VOLUME, canonicalPhotoId, rawIdOf, volumeOf } from './mediaIdentity';
export type { MediaRef, StoredMediaKind } from './mediaIdentity';
import {
  canonicalContentUri,
  canonicalPhotoId,
  rawIdOf,
  volumeOf,
  volumeOfUriPath,
  type MediaRef,
  type StoredMediaKind,
} from './mediaIdentity';

/** MediaStore's MEDIA_TYPE as the legacy Asset reports it → the stored
 * kind. Audio and unknown never reach here (the queries filter to photo
 * and video). */
function kindOfAsset(mediaType: string): StoredMediaKind {
  return mediaType === 'video' ? 'video' : 'photo';
}

/** Both kinds, every query (m0.9 phase 4): videos enter the scan, the
 * counts, the grids and the copy-detection pool alongside photos. */
const MEDIA_KINDS = [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video];

/** A camera-roll item — photo or video (m0.9 phase 4): the core item plus
 * MediaStore extras we persist. `item.id` is the canonical volume-qualified
 * id; `item.kind` is the stored kind. */
export interface LoadedPhoto {
  item: MediaItem;
  rawId: string;
  volumeName: string;
  filename: string;
  modTime: number;
  /** MediaStore GENERATION_MODIFIED when the load path had it (the
   * native per-item query, or the per-page facts join); null on a bare
   * expo-media-library page. The image cache version (item 3) is this,
   * else modTime. */
  generation: number | null;
  /** Display-space pixels; 0 when MediaStore has none (the scan's
   * measurement rescue fills them, M17). */
  width: number;
  height: number;
  /** MIME (classification truth, M15) and MediaStore's display name —
   * null on a bare expo page (the facts join fills them). */
  mimeType: string | null;
  displayName: string | null;
  /** Duration in ms for videos; null for photos or when unknown. */
  durationMs: number | null;
  /** MediaStore's SIZE when the load path had it — saves a stat. */
  sizeBytes: number | null;
  /** Set by the scan's bounded per-file read (phase 4, item 6) when it
   * COMPLETED for this item this pass: the motion facts (nulls = not a
   * motion photo) and the image version the read covered — the upsert
   * persists them together as the once-per-content marker. Unset = no
   * read this pass (marker current, or a failed read → retry). */
  facts?: {
    factsCheckedVersion: number;
    motionVideoOffset: number | null;
    motionVideoLength: number | null;
    motionPresentationUs: number | null;
  };
  /** MediaStore has no DATE_TAKEN for it — `item.timestamp` is the
   * modification-time fallback, and MediaStore sorted it at the end of
   * a DATE_TAKEN-descending stream (the scan handles these separately). */
  undated: boolean;
  /** Set by the D15 rescue when an EXIF read COMPLETED for this photo
   * this pass (found or absent): the modTime the read covered. The scan
   * upsert persists it as the once-per-content marker; unset = no read
   * this pass (dated photo, reuse, or a failed read → retry). */
  exifCheckedModTime?: number;
}

const PAGE_SIZE = 200;

/** Unparseable-volume warn, once per directory shape per process — loud
 * without flooding (a whole odd folder shares one line). */
const warnedUnparseableDirs = new Set<string>();
const WARNED_DIRS_CAP = 20;

function warnUnparseableVolume(uri: string): void {
  const dir = uri.slice(0, uri.lastIndexOf('/') + 1) || uri;
  if (warnedUnparseableDirs.has(dir) || warnedUnparseableDirs.size >= WARNED_DIRS_CAP) return;
  warnedUnparseableDirs.add(dir);
  console.warn(`[media] no volume parseable from uri shape ${dir} — photos there are skipped`);
}

function toLoadedPhoto(asset: MediaLibrary.Asset): LoadedPhoto | null {
  // Mechanism D (m0.8.3, D7): the REAL volume, from the uri path. Null =
  // fail closed — the caller drops the asset and counts the skip.
  const volumeName = volumeOfUriPath(asset.uri);
  if (volumeName === null) {
    warnUnparseableVolume(asset.uri);
    return null;
  }
  return {
    item: {
      id: canonicalPhotoId(volumeName, asset.id),
      // Some sources report 0 creationTime; fall back to modification
      // time so clustering stays best-effort instead of lumping them
      // all at epoch.
      timestamp: asset.creationTime || asset.modificationTime || 0,
      uri: asset.uri,
      kind: kindOfAsset(asset.mediaType),
    },
    rawId: asset.id,
    volumeName,
    filename: asset.filename,
    modTime: asset.modificationTime,
    generation: null,
    undated: !asset.creationTime,
    width: asset.width,
    height: asset.height,
    mimeType: null,
    displayName: null,
    // The legacy Asset reports seconds (0 for photos).
    durationMs:
      asset.mediaType === 'video' && asset.duration > 0 ? Math.round(asset.duration * 1000) : null,
    sizeBytes: null,
  };
}

/**
 * The per-page facts join (m0.9 phase 4): one Files-collection query per
 * volume per page adds what the legacy Asset lacks — MIME, display name,
 * duration, size and GENERATION_MODIFIED (the cache version the expo
 * path could not supply) — and re-reads width/height/kind from the same
 * row. Mutates in place. The SCAN calls this on its ingestion pages;
 * grid pagers do not (their rows come from SQLite). Without the native
 * module the page stays as the Asset shaped it, logged once. A failed
 * query THROWS — a partial page would classify the missing rows by
 * their filenames, and the scan's pass must fail closed instead.
 */
let warnedNoFactsJoin = false;
export async function joinMediaFacts(photos: LoadedPhoto[]): Promise<void> {
  if (photos.length === 0) return;
  if (!mediaStoreActionsAvailable()) {
    if (!warnedNoFactsJoin) {
      warnedNoFactsJoin = true;
      console.warn('[media] native module absent — pages carry no MIME, duration or generation');
    }
    return;
  }
  const byVolume = new Map<string, LoadedPhoto[]>();
  for (const photo of photos) {
    const list = byVolume.get(photo.volumeName);
    if (list) list.push(photo);
    else byVolume.set(photo.volumeName, [photo]);
  }
  for (const [volume, list] of byVolume) {
    const rows = await queryMediaFactsByIds(
      volume,
      list.map((p) => p.rawId),
    );
    const byId = new Map(rows.map((r) => [r.rawId, r]));
    for (const photo of list) {
      const row = byId.get(photo.rawId);
      if (!row) continue; // gone between the page and the join — the pass sees it next time
      photo.item.kind = row.kind;
      photo.generation = row.generationModified;
      photo.mimeType = row.mimeType;
      photo.displayName = row.displayName;
      photo.durationMs = row.durationMs;
      photo.sizeBytes = row.sizeBytes;
      if (row.width > 0 && row.height > 0) {
        photo.width = row.width;
        photo.height = row.height;
      }
    }
  }
}

/** Map one MediaStore page, dropping fail-closed assets; `skipped` is the
 * page's unparseable-volume count (the scan's baseline-withholding input). */
function toLoadedPage(assets: readonly MediaLibrary.Asset[]): {
  photos: LoadedPhoto[];
  skipped: number;
} {
  const photos: LoadedPhoto[] = [];
  let skipped = 0;
  for (const asset of assets) {
    const photo = toLoadedPhoto(asset);
    if (photo) photos.push(photo);
    else skipped += 1;
  }
  return { photos, skipped };
}

/**
 * Page through the photos in [startMs, endMs], oldest first by default
 * (`descending` flips to newest first — m0.5 "newest first" sessions),
 * optionally restricted to one MediaStore album (bucket). `onPage`
 * receives each page and returns false to stop early — this is what
 * keeps large scopes (6 months / year / all time, m0.3.1) from ever
 * materializing the whole MediaStore in memory.
 */
export async function pagePhotosInRange(
  startMs: number,
  endMs: number,
  albumId: string | undefined,
  onPage: (page: LoadedPhoto[]) => boolean | Promise<boolean>,
  descending = false,
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      ...(albumId !== undefined ? { album: albumId } : {}),
      ...(startMs > 0 ? { createdAfter: startMs } : {}),
      ...(Number.isFinite(endMs) ? { createdBefore: endMs } : {}),
      mediaType: MEDIA_KINDS,
      sortBy: [[MediaLibrary.SortBy.creationTime, !descending]],
    });
    const keepGoing = await onPage(toLoadedPage(page.assets).photos);
    if (!keepGoing || !page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
}

/** One newest-first page of photos (progress grids, m0.4 stage 3). */
export interface DescendingPhotoPage {
  photos: LoadedPhoto[];
  /** Assets dropped fail-closed (no parseable volume, m0.8.3 D7). A scan
   * pass that saw any must not advance its baselines. */
  skipped: number;
  /** Cursor for the next page; undefined when there is none. */
  endCursor: string | undefined;
  hasNext: boolean;
}

/**
 * Fetch one page of photos in [startMs, endMs], NEWEST first — the
 * building block for the progress photo grids' incremental loading
 * (progressPager.ts merges one such stream per source bucket). `after`
 * is the previous page's endCursor; undefined starts from the top.
 */
export async function fetchPhotoPageDesc(
  startMs: number,
  endMs: number,
  albumId: string | undefined,
  after: string | undefined,
  first: number,
): Promise<DescendingPhotoPage> {
  const page = await MediaLibrary.getAssetsAsync({
    first,
    after,
    ...(albumId !== undefined ? { album: albumId } : {}),
    // A 0 lower bound must be OMITTED: the legacy MediaStore query turns
    // createdAfter into DATE_TAKEN > 0, which silently excludes undated
    // photos — and the continuous scan is the only review ingress.
    ...(startMs > 0 ? { createdAfter: startMs } : {}),
    // A finite upper bound renders as DATE_TAKEN < endMs — FALSE for SQL
    // NULL, so open-ended callers pass Infinity and get NO bounds (undated
    // photos must enter the scan and the all-photos counts).
    ...(Number.isFinite(endMs) ? { createdBefore: endMs } : {}),
    mediaType: MEDIA_KINDS,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });
  const mapped = toLoadedPage(page.assets);
  return {
    photos: mapped.photos,
    skipped: mapped.skipped,
    endCursor: page.endCursor ?? undefined,
    hasNext: !!page.hasNextPage && !!page.endCursor,
  };
}

/**
 * How many photos MediaStore has in [startMs, endMs] — cheap `first: 1`
 * queries reading PagedInfo.totalCount, no asset paging. `albumIds`
 * restricts the count to those buckets (one query per bucket, summed);
 * null/undefined = all folders (single query). getAssetsAsync only
 * accepts a single album, hence the fan-out — the selected source is
 * typically one or two buckets.
 */
/** Short-lived memo + single-flight for range counts (m0.8.1): Home, the
 * Progress view and the scan all ask for the SAME whole-corpus count
 * within the same second, and Home re-asked on every review mutation.
 * The window is small enough that a library change surfaces on the next
 * screen focus; `invalidatePhotoCounts()` clears it explicitly. */
const COUNT_TTL_MS = 20_000;
const countCache = new Map<string, { at: number; value: Promise<number> }>();

export function invalidatePhotoCounts(): void {
  countCache.clear();
}

export async function countPhotosInRange(
  startMs: number,
  endMs: number,
  albumIds?: readonly string[] | null,
  options?: {
    /** Bypass the memo and take a fresh count (the result still lands in
     * the cache). The delta tripwire needs this: its count must postdate
     * the generation snapshot, and a cache entry another screen primed
     * seconds earlier would let a permanent delete slip both checks. */
    fresh?: boolean;
  },
): Promise<number> {
  const key = `${startMs}|${endMs}|${albumIds ? [...albumIds].sort().join(',') : '*'}`;
  const hit = options?.fresh ? undefined : countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.value;
  const pending = (async () => {
    const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
    // Buckets counted CONCURRENTLY — a multi-folder source used to pay
    // one serialized round trip per bucket.
    const counts = await Promise.all(
      buckets.map(async (album) => {
        const page = await MediaLibrary.getAssetsAsync({
          first: 1,
          ...(album !== undefined ? { album } : {}),
          // Same undated-photo contract as fetchPhotoPageDesc.
          ...(startMs > 0 ? { createdAfter: startMs } : {}),
          ...(Number.isFinite(endMs) ? { createdBefore: endMs } : {}),
          mediaType: MEDIA_KINDS,
        });
        return page.totalCount;
      }),
    );
    return counts.reduce((sum, n) => sum + n, 0);
  })();
  countCache.set(key, { at: Date.now(), value: pending });
  try {
    return await pending;
  } catch (error) {
    countCache.delete(key); // never memoize a failure
    throw error;
  }
}

/** Live MediaStore details for one asset (edit detection, m0.3). */
export interface AssetDetails {
  id: string;
  filename: string;
  creationTime: number;
  modificationTime: number;
  uri: string;
  /** Readable file path when MediaStore exposes one (preferred for hashing). */
  localUri: string | null;
}

/**
 * Re-query one asset. Returns null when the asset no longer exists (or the
 * lookup fails) — callers treat that as "no detection signal".
 *
 * VOLUME GUARD (m0.8.3, codex r1): Expo resolves the RAW id against the
 * merged external collection, and raw MediaStore ids can collide across
 * volumes — so a lookup for an SD photo's id can return a primary row.
 * The returned uri must parse to the canonical id's own volume; anything
 * else is treated as "no signal" rather than risk repairing this row
 * with another volume's path (updatePhotoUri) or feeding edit detection
 * another photo's times.
 */
export async function getAssetDetails(ref: MediaRef): Promise<AssetDetails | null> {
  const assetId = ref.id;
  // CANONICAL lookup first (final cycle Q2): query the volume-qualified
  // content URI natively — immune to cross-volume raw-id collisions,
  // where the merged lookup below can only fail closed to null and leave
  // the row permanently unresolvable (edit detection silent, the full
  // pass withholding its baseline every run). The merged path survives
  // as the module-absent fallback.
  if (mediaStoreActionsAvailable()) {
    try {
      const [row] = await queryMediaDetailsByUri([await getEditableContentUri(ref)]);
      if (row.status === 'mismatch') {
        // A caller identity defect, named loudly; the read is "no signal"
        // (null), never an absence (m0.9 close-out codex).
        console.error(
          `[media] details of ${assetId} queried under the wrong collection (kind ${ref.kind})`,
        );
        return null;
      }
      if (row.status !== 'found') return null;
      // No DATA path or no DATE_MODIFIED = no usable repair/detection
      // signal — same "no signal" contract as a failed lookup.
      if (!row.data || row.dateModifiedMs == null) return null;
      const fileUri = `file://${row.data}`;
      return {
        id: assetId,
        filename: row.displayName ?? '',
        creationTime: row.dateTakenMs ?? 0,
        modificationTime: row.dateModifiedMs,
        uri: fileUri,
        localUri: fileUri,
      };
    } catch {
      return null;
    }
  }
  try {
    // Accepts canonical volume-qualified ids; Expo wants the raw id.
    const info = await MediaLibrary.getAssetInfoAsync(rawIdOf(assetId));
    if (!info) return null;
    if (volumeOfUriPath(info.uri) !== volumeOf(assetId)) return null;
    return {
      id: canonicalPhotoId(volumeOf(assetId), info.id),
      filename: info.filename,
      creationTime: info.creationTime,
      modificationTime: info.modificationTime,
      uri: info.uri,
      localUri: info.localUri ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Load one photo by canonical id in the scan's LoadedPhoto shape (F27:
 * the delta's direct landing of changed undated photos). The read is
 * volume-QUALIFIED (codex m0.8.7 r1): raw MediaStore ids can collide
 * across volumes, and the merged-collection lookup then answers for the
 * wrong volume — permanently fail-closing exactly the photo this fetch
 * exists to land. Null when the row is absent on its volume or the
 * lookup fails; the scan counts that as a fail-closed skip and withholds
 * its baselines. A build without the native module (stale dev client)
 * falls back to the merged read plus the volume check — logged once.
 */
let warnedMergedFallback = false;
export async function loadPhotoById(assetId: string): Promise<LoadedPhoto | null> {
  try {
    const row = await loadMediaByVolumeId(volumeOf(assetId), rawIdOf(assetId));
    if (row === 'module-absent') {
      if (!warnedMergedFallback) {
        warnedMergedFallback = true;
        console.warn(
          '[media] native module absent — direct fetches use the merged collection (raw-id collisions fail closed)',
        );
      }
      const info = await MediaLibrary.getAssetInfoAsync(rawIdOf(assetId));
      if (!info) return null;
      const photo = toLoadedPhoto(info);
      if (photo === null || photo.item.id !== assetId) return null;
      return photo;
    }
    if (row === null || row.dataPath === null) return null;
    const uri = `file://${row.dataPath}`;
    return {
      item: {
        id: assetId,
        timestamp: row.dateTakenMs ?? row.dateModifiedSec * 1000,
        uri,
        kind: row.kind,
      },
      rawId: row.rawId,
      volumeName: volumeOf(assetId),
      filename: row.displayName ?? row.dataPath.slice(row.dataPath.lastIndexOf('/') + 1),
      modTime: row.dateModifiedSec * 1000,
      generation: row.generationModified,
      undated: row.dateTakenMs === null,
      width: row.width,
      height: row.height,
      mimeType: row.mimeType,
      displayName: row.displayName,
      durationMs: row.durationMs,
      sizeBytes: row.sizeBytes,
    };
  } catch {
    return null;
  }
}

/** Candidate asset for edited-copy detection. */
export interface CandidateAsset {
  id: string;
  kind: StoredMediaKind;
  filename: string;
  creationTime: number;
  modificationTime: number;
  uri: string;
}

/**
 * Photos whose creationTime falls in [startMs, endMs] (endMs omitted =
 * open-ended), capped at `max` — candidate pool for edited-copy detection.
 * `albumIds` restricts the scan to the photo-source buckets (m0.3.1):
 * each bucket is paged newest-first up to `max`, then the union is
 * re-sorted and re-capped so the result is the newest `max` overall.
 */
export async function loadCandidatesCreatedBetween(
  startMs: number,
  endMs: number | undefined,
  max: number,
  albumIds?: readonly string[] | null,
): Promise<CandidateAsset[]> {
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const out: CandidateAsset[] = [];
  for (const album of buckets) {
    let loaded = 0;
    let after: string | undefined;
    while (loaded < max) {
      const page = await MediaLibrary.getAssetsAsync({
        first: Math.min(PAGE_SIZE, max - loaded),
        after,
        ...(album !== undefined ? { album } : {}),
        ...(startMs > 0 ? { createdAfter: startMs } : {}),
        ...(endMs !== undefined ? { createdBefore: endMs } : {}),
        mediaType: MEDIA_KINDS,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      for (const asset of page.assets) {
        loaded++;
        // Same fail-closed volume rule as toLoadedPhoto: an unparseable
        // asset just yields no detection candidate.
        const volumeName = volumeOfUriPath(asset.uri);
        if (volumeName === null) {
          warnUnparseableVolume(asset.uri);
          continue;
        }
        out.push({
          id: canonicalPhotoId(volumeName, asset.id),
          kind: kindOfAsset(asset.mediaType),
          filename: asset.filename,
          creationTime: asset.creationTime,
          modificationTime: asset.modificationTime,
          uri: asset.uri,
        });
      }
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
  }
  if (buckets.length > 1) {
    out.sort((a, b) => b.creationTime - a.creationTime);
    return out.slice(0, max);
  }
  return out;
}

/**
 * The `content://` URI for an asset — what ACTION_EDIT needs (external
 * editors can't be granted access to a raw `file://` path on modern
 * Android). CONSTRUCTED from the canonical id (m0.8.3, codex r1), never
 * resolved through Expo: the reverse lookup queries the merged external
 * collection by raw `_ID` alone, and raw ids can collide across volumes
 * — a resolved uri can silently address another volume's photo, and
 * every action (trash, favourite, edit, share, presence, EXIF read)
 * flows through here.
 *
 * Deliberately still async (m0.8.4): the body no longer awaits, but
 * de-asyncing is churn across every caller for no gain.
 */
export async function getEditableContentUri(ref: MediaRef): Promise<string> {
  return canonicalContentUri(ref.id, ref.kind);
}

/**
 * Tri-state presence check for the trash lifecycle (C#1) — shared by the
 * confirm flow and startup recovery. 'absent' only on an AUTHORITATIVE
 * result: the row reports IS_TRASHED = 1, or a successful full-access
 * query proves the id left MediaStore entirely (e.g. the system removed
 * the trashed row before an interrupted launch recovered). Every failure
 * or partial-access path is 'unknown' — ambiguity must not earn
 * reclaimed-bytes credit or release a photo as gone.
 */
export async function verifyTrashedTriState(
  ref: MediaRef,
): Promise<'present' | 'absent' | 'unknown'> {
  const presence = await checkMediaPresence(ref);
  if (presence === 'trashed' || presence === 'absent') return 'absent';
  if (presence === 'present') return 'present';
  return 'unknown';
}

/**
 * Fail-closed presence check for feed reconciliation (History's
 * "deleted outside Afterglow drop out" contract). 'absent' comes ONLY
 * from the native quad-state query's successful-empty result (the asset
 * id is authoritatively gone from MediaStore, trashed rows included) —
 * every failure path (module missing, pre-R, null cursor, exception) is
 * 'unknown' and callers must change nothing.
 */
export async function checkMediaPresence(
  ref: MediaRef,
): Promise<'present' | 'trashed' | 'absent' | 'unknown'> {
  const detailed = await checkMediaPresenceDetailed(ref);
  return detailed === 'pending' ? 'present' : detailed;
}

/**
 * The same probe with a PENDING row named (m0.9 phase 9): the scan's loss
 * walk nets a pending row out of its count checks, where a merely
 * "present" row absent from the enumeration must stay unexplained.
 */
export async function checkMediaPresenceDetailed(
  ref: MediaRef,
): Promise<Exclude<MediaPresence, 'mismatch'>> {
  if (!mediaStoreActionsAvailable()) return 'unknown';
  try {
    const presence = await getMediaPresence(await getEditableContentUri(ref));
    if (presence === 'mismatch') {
      // A mis-addressed collection (an images uri for a video row or the
      // reverse) is a caller defect, named loudly and read as unknown:
      // nothing destructive may follow from it (m0.9 close-out codex).
      console.error(
        `[media] presence of ${ref.id} queried under the wrong collection (kind ${ref.kind})`,
      );
      return 'unknown';
    }
    if (presence !== 'absent') return presence;
    // 'absent' (a successful EMPTY cursor) is authoritative only while
    // the row's volume is actually mounted (final cycle V1) — cross-OEM
    // insurance, kept deliberately (Tristan, grilling Q5): our S10e
    // (Android 12) provably THROWS "Volume not found" for an ejected
    // volume's URI (measured 2026-07-30, sm-simulated eject), but
    // Android does not specify empty-vs-throw, and a provider answering
    // empty-success would let every 'absent' consumer — History
    // reconciliation, copy cleanup, trash recovery — sweep state the
    // eject contract preserves. LIVE read, not the burst cache: this
    // gates destructive conclusions.
    const live = await getMountedVolumes();
    return live.includes(volumeOf(ref.id)) ? 'absent' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface TrashAssetsResult {
  status: MediaStoreActionStatus | 'failed';
  /** Where a 'failed' result failed (codex m0.8.7 r2): 'prepare' =
   * resolving content uris, BEFORE any native call — Android was never
   * asked; 'dispatch' = the native trash request itself. */
  stage?: 'prepare' | 'dispatch';
  error?: string;
}

/**
 * Move assets to Android's recoverable system trash after the OS-owned
 * confirmation sheet. THIS IS THE ONLY MEDIA REMOVAL CALL IN THE APP.
 * Afterglow never permanently deletes a photo: the Android 11 floor
 * guarantees a system trash exists, so there is no fallback to design.
 * A build without the native module removes nothing at all.
 */
export async function trashAssets(refs: readonly MediaRef[]): Promise<TrashAssetsResult> {
  if (refs.length === 0) return { status: 'applied' };
  // Two tries, because the stage is the classifier's tier-1 fact (codex
  // m0.8.7 r2): a uri-resolution failure must not wear Android's name.
  let uris: string[];
  try {
    uris = await Promise.all(refs.map(getEditableContentUri));
  } catch (error) {
    return {
      status: 'failed',
      stage: 'prepare',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    // trashMedia reports failures by THROWING (its status union has no
    // 'failed'), so a returned result needs no stage.
    return await trashMedia(uris);
  } catch (error) {
    return {
      status: 'failed',
      stage: 'dispatch',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
