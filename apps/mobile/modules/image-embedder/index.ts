/**
 * JS entry for the local image-embedder Expo module (Android-only) — the
 * MediaPipe MobileNetV3-large image embedder behind m0.8 similarity
 * grouping (docs/Plan_m0.8.md; study data in docs/grouping-study/).
 *
 * `embed(uri)` resolves to per-stage timings plus the L2-normalized
 * embedding as base64 float32 bytes (`decodeVec` turns it into a
 * Float32Array). Null when the native module is absent (iOS/Expo Go/stale
 * dev client) — callers treat null as "no similarity signal".
 */
import { requireOptionalNativeModule } from 'expo';

export interface EmbedResult {
  decodeMs: number;
  inferMs: number;
  dim: number;
  vecB64: string;
}

interface NativeApi {
  embed(uri: string): Promise<EmbedResult>;
}

const native = requireOptionalNativeModule<NativeApi>('ImageEmbedder');

/** Embed one photo uri, or null when the native module is unavailable. */
export async function embed(uri: string): Promise<EmbedResult | null> {
  if (!native) return null;
  return native.embed(uri);
}

/** Decode the base64 float32 payload into a Float32Array. */
export function decodeVec(vecB64: string): Float32Array {
  const raw = atob(vecB64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
