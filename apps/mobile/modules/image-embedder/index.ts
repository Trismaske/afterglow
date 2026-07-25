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

/**
 * SHA-256 of the bundled model asset — THE model pin. The README's fetch
 * step verifies the asset against this same value, and labels-v1
 * (docs/grouping-study/labels-v1.json) embeds it: vectors from any other
 * model are incompatible with the stored embeddings AND the frozen
 * regression fixtures. Swapping the model asset MUST change this constant
 * — that mismatch is what triggers the app's explicit re-embed event
 * (db/embeddingStore.ts ensureEmbeddingModel).
 */
export const MODEL_SHA256 = '11af3c560dfeed7737cb4c03c23bf52a8403020784192d4dea0b74862a12828d';

/** Embedding dimensionality of the pinned model. */
export const MODEL_DIM = 1280;

/**
 * Default long-edge decode cap (px) for embedding decodes. Gate-2 device
 * measurement (2026-07-25, S23 + S10e): decode time is cap-INVARIANT
 * (134–145 ms/photo on the S10e at caps 224→1024 — JPEG entropy decode
 * dominates, sample-size decoding doesn't reduce it), so the cap stays at
 * 1024 — the gate-0 configuration the desktop↔device cosine-drift numbers
 * (±0.02 typical, 0.067 max) were measured at. Throughput comes from the
 * pipeline's decode/infer overlap (lib/embeddings.ts, concurrency 2), not
 * from the cap.
 */
export const DEFAULT_DECODE_CAP = 1024;

export interface EmbedResult {
  decodeMs: number;
  inferMs: number;
  dim: number;
  vecB64: string;
  /** 64-bit dHash hex from the same decode; null unless requested. */
  dhashHex: string | null;
}

interface NativeApi {
  embed(uri: string, decodeCap: number, withDhash: boolean): Promise<EmbedResult>;
  dhash(uri: string, decodeCap: number): Promise<string>;
}

const native = requireOptionalNativeModule<NativeApi>('ImageEmbedder');

/** Embed one photo uri, or null when the native module is unavailable.
 * `withDhash` also computes the photo's dHash from the same decode
 * (lib/dhashDecode.ts semantics, natively — the scan's single-decode path). */
export async function embed(
  uri: string,
  decodeCap: number = DEFAULT_DECODE_CAP,
  withDhash = false,
): Promise<EmbedResult | null> {
  if (!native) return null;
  return native.embed(uri, decodeCap, withDhash);
}

/** dHash only (no inference) — for photos whose embedding is already
 * cached. Decodes at the SAME cap as the embed path so a photo's hash
 * never depends on which path produced it. Null when the native module
 * is unavailable. */
export async function dhash(
  uri: string,
  decodeCap: number = DEFAULT_DECODE_CAP,
): Promise<string | null> {
  if (!native) return null;
  return native.dhash(uri, decodeCap);
}

/** Decode the base64 payload into bytes (little-endian float32). */
export function decodeVecBytes(vecB64: string): Uint8Array {
  const raw = atob(vecB64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Decode the base64 float32 payload into a Float32Array. */
export function decodeVec(vecB64: string): Float32Array {
  return new Float32Array(decodeVecBytes(vecB64).buffer);
}
