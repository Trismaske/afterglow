import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type MediaStoreActionStatus = 'applied' | 'cancelled' | 'unsupported';

/** Gate-0 (m0.7 item A) environment probe results — all human-readable strings. */
export interface EditDiagnosticsReport {
  sdkInt: string;
  device: string;
  myUid: string;
  myPackage: string;
  readPerm: string;
  writePerm: string;
  openStream: string;
  editHandlers: string;
  viewHandlers: string;
}

/** Outcome of one intent-dispatch probe (the dispatch itself, not the user's trip). */
export interface ProbeLaunchResult {
  result: 'launched' | 'security' | 'no_handler' | 'error' | 'unsupported';
  message: string;
}

/** One D15 EXIF read result: the raw DateTimeOriginal string ("YYYY:MM:DD
 * HH:MM:SS", naive local time) or null, plus the error that prevented the
 * read (null on a clean read — including a clean read of a file that
 * simply has no tag). */
export interface ExifDateResult {
  uri: string;
  dateTimeOriginal: string | null;
  error: string | null;
}

interface NativeApi {
  trash(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
  setFavourite(uris: string[], value: boolean): Promise<{ status: MediaStoreActionStatus }>;
  isFavourite(uri: string): Promise<boolean | null>;
  mediaPresence(uri: string): Promise<'present' | 'trashed' | 'absent' | 'unknown'>;
  editDiagnostics(uri: string): Promise<EditDiagnosticsReport>;
  probeLaunch(uri: string, action: string, withWrite: boolean): Promise<ProbeLaunchResult>;
  requestWriteAccess(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
  shareUris(
    uris: string[],
    token: number,
  ): Promise<{ result: 'dispatched' | 'error'; message: string }>;
  listImageAlbums(): Promise<VolumeAlbum[]>;
  mediaGenerations(): Promise<Record<string, number>>;
  mediaChangedSince(volume: string, since: number): Promise<NativeChangedRow[]>;
  queryRelativePaths(uris: string[]): Promise<RelativePathInfo[]>;
  queryImageDetails(uris: string[]): Promise<ImageDetailsRow[]>;
  moveToRelativePath(uris: string[], relativePath: string): Promise<MoveResult[]>;
  readExifDateTimeOriginal(uris: string[]): Promise<ExifDateResult[]>;
  countImagesByVolume(volumes: string[]): Promise<Record<string, number>>;
  listMountedVolumes(): Promise<string[]>;
  addListener(event: 'volumesChanged', listener: () => void): { remove(): void };
  addListener(
    event: 'shareTargetChosen',
    listener: (payload: { token: number; component: string }) => void,
  ): { remove(): void };
}

/** One row MediaStore reports as added or modified since a generation.
 * `isTrashed` is the reason this exists: a user deleting a photo in
 * their gallery TRASHES it, leaving the row in place with the flag set —
 * a modification the delta pass can see, not an absence it has to
 * infer. */
export interface ChangedMediaRow {
  volumeName: string;
  rawId: string;
  /** DATE_TAKEN in ms, or null for an undated photo. */
  dateTakenMs: number | null;
  /** DATE_MODIFIED in SECONDS (MediaStore's unit), or null. */
  dateModifiedSec: number | null;
  isTrashed: boolean;
  generationAdded: number;
  generationModified: number;
}

type NativeChangedRow = ChangedMediaRow;

/** One (volume, bucket) album entry — volume identity preserved (C#2). */
export interface VolumeAlbum {
  volumeName: string;
  bucketId: string;
  displayName: string;
  relativePath: string;
  photoCount: number;
}

/** Read-only path lookup result — nulls when the row/columns are
 * unavailable (never an authoritative statement of anything). */
export interface RelativePathInfo {
  uri: string;
  relativePath: string | null;
  data: string | null;
}

/** Details by canonical content URI (m0.8.3 final cycle Q2) — the
 * collision-proof replacement for merged-collection raw-id lookups.
 * 'absent' is authoritative (successful empty query); 'error' is not
 * evidence of anything. dateModifiedMs is already converted to ms. */
export interface ImageDetailsRow {
  uri: string;
  status: 'found' | 'absent' | 'error';
  displayName?: string | null;
  dateModifiedMs?: number | null;
  dateTakenMs?: number | null;
  data?: string | null;
  message?: string;
}

export interface MoveResult {
  uri: string;
  status: 'moved' | 'already' | 'error' | 'unsupported';
  message: string;
  /** The current file path when status is 'moved' or 'already' (photos.uri repair). */
  newData?: string;
}

const native = requireOptionalNativeModule<NativeApi>('MediaStoreActions');

function available(): boolean {
  return Platform.OS === 'android' && native != null;
}

/** Whether the native module is present — callers that infer "row absent"
 * from a null query result MUST check this first (null from an
 * unavailable module is not evidence of anything). Since m0.8.4's Android
 * 11 floor this is the module's ONE capability predicate: the trash
 * boundary, the canonical details query, the diagnostics and the D15 EXIF
 * read all had separate version thresholds below 30, and every one of
 * them is now satisfied by any device that can install the app.
 *
 * Non-Android is deliberately unguarded ABOVE this predicate (Tristan,
 * m0.8.4): re-adding `Platform.OS === 'android'` gates would write a
 * second floor into six screens a future iOS build must find and delete.
 * A missing module degrades through the `unsupported` status instead. */
export function mediaStoreActionsAvailable(): boolean {
  return available();
}

function contentUris(uris: string[]): string[] {
  const invalid = uris.find((uri) => !uri.startsWith('content://'));
  if (invalid) throw new Error('MediaStore actions require Android content URIs.');
  return uris;
}

export async function trashMedia(uris: string[]): Promise<{ status: MediaStoreActionStatus }> {
  if (!available()) return { status: 'unsupported' };
  return native!.trash(contentUris(uris));
}

export async function setMediaFavourite(
  uris: string[],
  value: boolean,
): Promise<{ status: MediaStoreActionStatus }> {
  if (!available()) return { status: 'unsupported' };
  return native!.setFavourite(contentUris(uris), value);
}

export async function isMediaFavourite(uri: string): Promise<boolean | null> {
  if (!available()) return null;
  return native!.isFavourite(contentUris([uri])[0]);
}

/** Quad-state presence: 'absent' ONLY from a successful empty query with
 * MATCH_INCLUDE (authoritative — the id is gone from MediaStore); every
 * failure path is 'unknown'. */
export async function getMediaPresence(
  uri: string,
): Promise<'present' | 'trashed' | 'absent' | 'unknown'> {
  if (!available()) return 'unknown';
  return native!.mediaPresence(contentUris([uri])[0]);
}

// ---- Gate-0 editor-launch diagnostic matrix (m0.7 item A) ----------------

export async function runEditDiagnostics(uri: string): Promise<EditDiagnosticsReport | null> {
  if (!available()) return null;
  return native!.editDiagnostics(contentUris([uri])[0]);
}

export async function probeEditLaunch(
  uri: string,
  action: string,
  withWrite: boolean,
): Promise<ProbeLaunchResult> {
  if (!available()) return { result: 'unsupported', message: 'Not on Android' };
  return native!.probeLaunch(contentUris([uri])[0], action, withWrite);
}

export async function requestMediaWriteAccess(
  uris: string[],
): Promise<{ status: MediaStoreActionStatus }> {
  if (!available()) return { status: 'unsupported' };
  return native!.requestWriteAccess(contentUris(uris));
}

/** The volume-aware album catalog (C#2). Empty on non-Android. */
/** Per-volume MediaStore generations (API 30+; {} = unavailable),
 * keyed "<volume>|<MediaStore version>". An unchanged generation is an
 * OS guarantee the volume's library did not change — the continuous
 * scan's skip evidence — but ONLY within one MediaStore version:
 * generations reset when the provider database is rebuilt, so the
 * version rides in the key and a rebuild mismatches every stored key
 * (no version-aware logic needed downstream; split on the first '|'
 * for the raw volume name).
 *
 * ALL VOLUMES OR NONE (m0.8.2): the native side THROWS if any enumerated
 * volume is unreadable, because a partial map is indistinguishable from
 * a complete one once fingerprinted, and would let a consistently
 * failing volume skip the scan forever. Callers catch and treat it as
 * "cannot prove unchanged". */
export async function getMediaGenerations(): Promise<Record<string, number>> {
  if (!available()) return {};
  return native!.mediaGenerations();
}

/**
 * Rows added or modified on `volume` since `since` — the delta scan's
 * change discovery (m0.8.2 phase 1: computed and logged only).
 *
 * Includes TRASHED rows deliberately. Everything else in the app queries
 * MediaStore's default view, which hides them; here they are the most
 * valuable rows in the result, because a trash is how a deletion becomes
 * visible at all.
 *
 * Throws rather than returning a partial set — same rule as the two
 * calls above. Callers treat a throw as "no delta available" and fall
 * back to a full pass.
 */
export async function getMediaChangedSince(
  volume: string,
  since: number,
): Promise<ChangedMediaRow[]> {
  if (!available()) return [];
  return native!.mediaChangedSince(volume, since);
}

/** The volume-aware album catalog. ALL VOLUMES OR NONE, same rule and
 * same reason: a partial catalog hides folders the user selected on the
 * dropped volume, and can make the default-source probe conclude
 * DCIM/Camera is absent and broaden to every folder. */
export async function listImageAlbums(): Promise<VolumeAlbum[]> {
  if (!available()) return [];
  return native!.listImageAlbums();
}

/** Read-only RELATIVE_PATH/DATA lookup (the organize crash-repair
 * precheck) — never mutates, unlike moveMediaToRelativePath. */
export async function queryMediaRelativePaths(uris: string[]): Promise<RelativePathInfo[]> {
  if (!available()) {
    return uris.map((uri) => ({ uri, relativePath: null, data: null }));
  }
  return native!.queryRelativePaths(contentUris(uris));
}

/** Storage-volume mount/unmount push events (m0.8.3): fires on the OS
 * MEDIA_* broadcasts while the app runs — the only signal for a card
 * swap that happens while the app stays foregrounded. No-op (returns a
 * dummy unsubscribe) when the module is absent. */
export function subscribeVolumesChanged(listener: () => void): () => void {
  if (Platform.OS !== 'android' || native == null) return () => {};
  const subscription = native.addListener('volumesChanged', listener);
  return () => subscription.remove();
}

/** Image details by canonical content URI (Q2). Throws when unavailable
 * — callers gate on mediaStoreActionsAvailable() and fall back to the
 * volume-guarded merged lookup. */
export async function queryImageDetailsByUri(uris: string[]): Promise<ImageDetailsRow[]> {
  if (!available()) throw new Error('canonical details query unavailable');
  return native!.queryImageDetails(contentUris(uris));
}

/** Verified RELATIVE_PATH moves (R#6). Callers hold write access first. */
export async function moveMediaToRelativePath(
  uris: string[],
  relativePath: string,
): Promise<MoveResult[]> {
  if (!available()) {
    return uris.map((uri) => ({
      uri,
      status: 'unsupported' as const,
      message: "Afterglow's media module is not available in this build",
    }));
  }
  return native!.moveToRelativePath(contentUris(uris), relativePath);
}

/** D15 EXIF date rescue: one header-only DateTimeOriginal read per uri.
 * Read-only by contract — the app never modifies original photo bytes.
 * Unavailable module → every row comes back erroring, so callers degrade
 * to "stays undated" and stay retry-eligible. Callers short-circuit the
 * whole rescue on mediaStoreActionsAvailable() rather than probing: a
 * "failed" that can never succeed must not defeat the unchanged-library
 * skip forever (codex r2). */
export async function readExifDateTimeOriginal(uris: string[]): Promise<ExifDateResult[]> {
  if (!available()) {
    return uris.map((uri) => ({ uri, dateTimeOriginal: null, error: 'module unavailable' }));
  }
  return native!.readExifDateTimeOriginal(contentUris(uris));
}

/** The mounted volume set (m0.8.3 phase 2, codex): the scan REQUIRES
 * this — reachability decisions (the regroup freeze, reconcile scope,
 * page validation) must never run blind, so unknown means the pass
 * ABORTS rather than treating every volume as reachable. THROWS when
 * the module is absent or a mounted volume cannot be named. */
export async function getMountedVolumes(): Promise<string[]> {
  if (!available()) throw new Error('mounted-volume enumeration unavailable');
  return native!.listMountedVolumes();
}

/** Per-volume image counts (m0.8.3 phase 2) — the "All folders" side of
 * the per-volume scan tripwires. ALL VOLUMES OR NONE (a partial map
 * would hide exactly the tripwire this feeds) — THROWS when any volume
 * is uncountable or the module/API is unavailable; the scan's planner
 * catches and falls back to a full pass. */
export async function getImageCountsByVolume(volumes: string[]): Promise<Record<string, number>> {
  if (!available()) throw new Error('per-volume counts unavailable');
  return native!.countImagesByVolume(volumes);
}

/** Fire the share sheet (SEND / SEND_MULTIPLE with read grants). Resolves
 * at dispatch — the C#10 at-most-once accounting boundary. `token`
 * (the batch id) rides the chooser's IntentSender and comes back in the
 * shareTargetChosen event when the user picks a target app (m0.8.6
 * D10); a dismissed sheet fires nothing. */
export async function shareMediaUris(
  uris: string[],
  token: number,
): Promise<{ result: 'dispatched' | 'error' | 'unsupported'; message: string }> {
  if (!available()) return { result: 'unsupported', message: 'Not on Android' };
  return native!.shareUris(contentUris(uris), token);
}

/** The chooser's chosen-target callback (m0.8.6 D10): the user handed
 * `token`'s batch to `component`. The strongest share fact Android
 * offers — never a delivery claim. No-op unsubscribe off Android. */
export function subscribeShareTargetChosen(
  listener: (payload: { token: number; component: string }) => void,
): () => void {
  if (Platform.OS !== 'android' || native == null) return () => {};
  const subscription = native.addListener('shareTargetChosen', listener);
  return () => subscription.remove();
}
