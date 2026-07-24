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

interface NativeApi {
  trash(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
  setFavourite(uris: string[], value: boolean): Promise<{ status: MediaStoreActionStatus }>;
  isFavourite(uri: string): Promise<boolean | null>;
  mediaPresence(uri: string): Promise<'present' | 'trashed' | 'absent' | 'unknown'>;
  editDiagnostics(uri: string): Promise<EditDiagnosticsReport>;
  probeLaunch(uri: string, action: string, withWrite: boolean): Promise<ProbeLaunchResult>;
  requestWriteAccess(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
  shareUris(uris: string[]): Promise<{ result: 'dispatched' | 'error'; message: string }>;
  listImageAlbums(): Promise<VolumeAlbum[]>;
  queryRelativePaths(uris: string[]): Promise<RelativePathInfo[]>;
  moveToRelativePath(uris: string[], relativePath: string): Promise<MoveResult[]>;
}

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

export interface MoveResult {
  uri: string;
  status: 'moved' | 'already' | 'error' | 'unsupported';
  message: string;
  /** The current file path when status is 'moved' or 'already' (photos.uri repair). */
  newData?: string;
}

const native = requireOptionalNativeModule<NativeApi>('MediaStoreActions');

function available(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= 30 && native != null;
}

/** Whether the Android 11+ native module is present — callers that infer
 * "row absent" from a null query result MUST check this first (null from
 * an unavailable module is not evidence of anything). */
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
// The env/probe calls work on any Android version (they diagnose, not
// mutate); only the createWriteRequest probe needs Android 11+.

function diagnosticsAvailable(): boolean {
  return Platform.OS === 'android' && native != null;
}

export async function runEditDiagnostics(uri: string): Promise<EditDiagnosticsReport | null> {
  if (!diagnosticsAvailable()) return null;
  return native!.editDiagnostics(contentUris([uri])[0]);
}

export async function probeEditLaunch(
  uri: string,
  action: string,
  withWrite: boolean,
): Promise<ProbeLaunchResult> {
  if (!diagnosticsAvailable()) return { result: 'unsupported', message: 'Not on Android' };
  return native!.probeLaunch(contentUris([uri])[0], action, withWrite);
}

export async function requestMediaWriteAccess(
  uris: string[],
): Promise<{ status: MediaStoreActionStatus }> {
  if (!available()) return { status: 'unsupported' };
  return native!.requestWriteAccess(contentUris(uris));
}

/** The volume-aware album catalog (C#2). Empty on non-Android. */
export async function listImageAlbums(): Promise<VolumeAlbum[]> {
  if (!diagnosticsAvailable()) return [];
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

/** Verified RELATIVE_PATH moves (R#6). Callers hold write access first. */
export async function moveMediaToRelativePath(
  uris: string[],
  relativePath: string,
): Promise<MoveResult[]> {
  if (!available()) {
    return uris.map((uri) => ({
      uri,
      status: 'unsupported' as const,
      message: 'Requires Android 11',
    }));
  }
  return native!.moveToRelativePath(contentUris(uris), relativePath);
}

/** Fire the share sheet (SEND / SEND_MULTIPLE with read grants). Resolves
 * at dispatch — the C#10 at-most-once accounting boundary. */
export async function shareMediaUris(
  uris: string[],
): Promise<{ result: 'dispatched' | 'error' | 'unsupported'; message: string }> {
  if (!diagnosticsAvailable()) return { result: 'unsupported', message: 'Not on Android' };
  return native!.shareUris(contentUris(uris));
}
