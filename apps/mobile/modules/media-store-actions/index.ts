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
  isTrashed(uri: string): Promise<boolean | null>;
  editDiagnostics(uri: string): Promise<EditDiagnosticsReport>;
  probeLaunch(uri: string, action: string, withWrite: boolean): Promise<ProbeLaunchResult>;
  requestWriteAccess(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
}

const native = requireOptionalNativeModule<NativeApi>('MediaStoreActions');

function available(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= 30 && native != null;
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

export async function isMediaTrashed(uri: string): Promise<boolean | null> {
  if (!available()) return null;
  return native!.isTrashed(contentUris([uri])[0]);
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
