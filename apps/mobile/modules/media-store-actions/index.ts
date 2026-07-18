import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type MediaStoreActionStatus = 'applied' | 'cancelled' | 'unsupported';

interface NativeApi {
  trash(uris: string[]): Promise<{ status: MediaStoreActionStatus }>;
  setFavourite(uris: string[], value: boolean): Promise<{ status: MediaStoreActionStatus }>;
  isFavourite(uri: string): Promise<boolean | null>;
  isTrashed(uri: string): Promise<boolean | null>;
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
