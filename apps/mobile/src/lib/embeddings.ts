/**
 * Per-photo embedding pipeline (m0.8 gate 2) — the impure partner of the
 * grouping engine's injected `vecOf`, mirroring similarityHashes.ts.
 *
 * The image-embedder module (MediaPipe MobileNetV3-large) decodes and
 * embeds each photo natively; vectors persist immediately per photo into
 * photo_embeddings (interrupt-safe by construction — a killed scan loses
 * at most the in-flight photos), keyed by asset id and invalidated when
 * `mod_time` moves (in-place edit). Failures are per-photo and non-fatal:
 * a null vector is NOT cached (transient read errors retry next scan) and
 * the photo stays a singleton in grouping (core's null-vector rule).
 *
 * Concurrency is adaptive (2–4 workers): inference is serialized inside
 * the native module (one embedder instance, deliberately — MediaPipe
 * embedders are not thread-safe), so once enough workers overlap decode
 * with inference, throughput hits the inference floor and more workers
 * only stack decoded bitmaps. The sweet spot is ceil(decode/infer) + 1,
 * and both stage timings come back with every embed result, so the pool
 * self-tunes from measured EMAs — no hardware heuristics (S10e sweep
 * 2026-07-25: 57/40/38/41/40 ms per photo at 2/3/4/6/8 workers; plateau
 * at 3–4 = the ~39 ms inference floor).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  embed,
  dhash,
  decodeVecBytes,
  DEFAULT_DECODE_CAP,
  MODEL_DIM,
} from '../../modules/image-embedder';
import type { LoadedPhoto } from './media';
import { getPhotoEmbeddings, setPhotoEmbedding } from '../db/embeddingStore';
import { waitForUserWrites } from './writePriority';
import { getPhotoHashes, setPhotoHash } from '../db/store';

const MIN_WORKERS = 2;
const MAX_WORKERS = 4;
/** EMA smoothing for the per-stage timings the module reports. */
const EMA_ALPHA = 0.3;
/** Timing samples required before the pool scales beyond MIN_WORKERS. */
const MIN_SAMPLES = 3;
/** Stop issuing native calls once this many CONSECUTIVE engine-level
 * errors occurred (any success resets the streak) — the engine is down,
 * whether it never came up (missing model, dead MediaPipe init) or died
 * mid-run (module teardown), and a large window would otherwise burn
 * hundreds of futile calls. Photo-level failures (corrupt or unreadable
 * files — the module codes them DECODE_FAILED/TOO_SMALL) never count. */
export const ENGINE_FAILURE_ABORT = 5;

/** Module error codes that indict the PHOTO, not the engine. */
const PER_PHOTO_CODES = new Set(['DECODE_FAILED', 'TOO_SMALL', 'BAD_CAP']);

/** Fresh-embed health, cumulative across one scan run (owned by the scan
 * runner, threaded through every window's ensureEmbeddings call). */
export interface EngineHealth {
  /** Fresh embed attempts (cache misses that reached the module). */
  attempts: number;
  /** Attempts that produced no vector, photo- and engine-level alike. */
  failures: number;
  /** Engine-level errors only (uncoded / non-photo error codes). */
  engineErrors: number;
  /** Engine-level errors since the last success (death trigger). */
  consecutiveEngineErrors: number;
  successes: number;
  /** Engine declared dead: absent module, or ENGINE_FAILURE_ABORT
   * CONSECUTIVE engine-level errors. No further native calls. */
  dead: boolean;
}

export function newEngineHealth(): EngineHealth {
  return {
    attempts: 0,
    failures: 0,
    engineErrors: 0,
    consecutiveEngineErrors: 0,
    successes: 0,
    dead: false,
  };
}

/** Aligned Float32Array view over possibly-unaligned stored bytes. */
export function vecFromBytes(bytes: Uint8Array): Float32Array {
  const copy = Uint8Array.prototype.slice.call(bytes);
  return new Float32Array(copy.buffer);
}

export interface EnsureEmbeddingsResult {
  /** asset id → vector; null = uncomputable this run. */
  vectors: Map<string, Float32Array | null>;
  /** asset id → dHash (only when `withHashes`); null = uncomputable. */
  hashes: Map<string, string | null>;
  /** How many embeddings were computed fresh (vs served from cache). */
  computed: number;
  /** Fresh attempts that yielded NO vector (thrown error, absent module,
   * wrong dim). The scan aborts when every attempt fails — an engine-wide
   * failure (missing model, dead MediaPipe init) must never masquerade as
   * a completed scan of time-only groups. */
  failed: number;
}

/**
 * Ensure every given photo has a current stored embedding — and, with
 * `withHashes`, a current stored dHash — computing the missing or stale
 * ones (stored mod_time ≠ live modificationTime) with bounded
 * concurrency. Fresh embeds get their hash from the SAME native decode
 * (module `withDhash`); photos whose embedding is cached but hash is
 * missing get the module's standalone bounded-decode `dhash`. The
 * manipulator-based session hash path (similarityHashes.ts) is NEVER
 * used here — it leaks native memory at corpus scale (lmkd kill at
 * 4.5 GB RSS, 2026-07-25). `onProgress(done, total)` fires once per
 * photo that needed embedding.
 */
export async function ensureEmbeddings(
  db: SQLiteDatabase,
  photos: readonly LoadedPhoto[],
  onProgress?: (done: number, total: number, ok: boolean) => void,
  withHashes = false,
  health: EngineHealth = newEngineHealth(),
): Promise<EnsureEmbeddingsResult> {
  const vectors = new Map<string, Float32Array | null>();
  const hashes = new Map<string, string | null>();
  const ids = photos.map((p) => p.item.id);
  const cached = await getPhotoEmbeddings(db, ids);
  // Only native-produced hashes: the manipulator resamples differently and
  // cross-source Hamming comparisons would blur the near-dup floor.
  const cachedHashes = withHashes
    ? await getPhotoHashes(db, ids, 'native')
    : new Map<string, never>();

  const todo: LoadedPhoto[] = [];
  const hashOnly: LoadedPhoto[] = [];
  for (const photo of photos) {
    const row = cached.get(photo.item.id);
    if (row && row.modTime === photo.modTime && row.vec.byteLength === MODEL_DIM * 4) {
      vectors.set(photo.item.id, vecFromBytes(row.vec));
      if (withHashes) {
        const hashRow = cachedHashes.get(photo.item.id);
        if (hashRow && hashRow.mod_time === photo.modTime) hashes.set(photo.item.id, hashRow.hash);
        else hashOnly.push(photo);
      }
    } else {
      todo.push(photo);
    }
  }

  const total = todo.length;
  let done = 0;
  let next = 0;
  let decodeEma = 0;
  let inferEma = 0;
  let samples = 0;
  let active = 0;
  const pool: Promise<void>[] = [];

  const desiredWorkers = (): number => {
    if (samples < MIN_SAMPLES) return MIN_WORKERS;
    const ratio = Math.ceil(decodeEma / Math.max(1, inferEma)) + 1;
    return Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, ratio));
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (health.dead) return;
      // WRITE PRIORITY (vetted): a pending user decision reaches SQLite
      // before this photo's embed persists.
      await waitForUserWrites();
      const index = next++;
      if (index >= total) return;
      const photo = todo[index];
      health.attempts++;
      let vec: Float32Array | null = null;
      try {
        const result = await embed(photo.item.uri, DEFAULT_DECODE_CAP, withHashes);
        if (result === null) {
          // Native module absent: nothing photo-specific about it.
          health.dead = true;
        } else if (result.dim !== MODEL_DIM) {
          // A "successful" response with the wrong dimensionality means a
          // mismatched model/module — engine-level, not photo-level.
          health.engineErrors++;
          health.consecutiveEngineErrors++;
        } else {
          samples++;
          decodeEma =
            samples === 1 ? result.decodeMs : decodeEma + EMA_ALPHA * (result.decodeMs - decodeEma);
          inferEma =
            samples === 1 ? result.inferMs : inferEma + EMA_ALPHA * (result.inferMs - inferEma);
          const bytes = decodeVecBytes(result.vecB64);
          if (bytes.byteLength === MODEL_DIM * 4) {
            // Durability first: the vector only counts once persisted — a
            // failed BLOB write (I/O, storage full) throws into the engine
            // catch below, so the photo counts as failed instead of the
            // scan reporting completion without its promised embedding.
            // (Hash writes below stay tolerant: hashes are a derived
            // cache, recomputed next run at grouping-equal cost.)
            await setPhotoEmbedding(db, photo.item.id, bytes, photo.modTime);
            vec = vecFromBytes(bytes);
          } else {
            // Payload/dim disagreement: also an engine-level malformation.
            health.engineErrors++;
            health.consecutiveEngineErrors++;
          }
          if (withHashes && result.dhashHex) {
            hashes.set(photo.item.id, result.dhashHex);
            await setPhotoHash(db, photo.item.id, result.dhashHex, photo.modTime, 'native').catch(
              () => {},
            );
          }
        }
      } catch (error) {
        // Photo-level failures (module-coded: corrupt/unreadable/tiny) are
        // null-and-move-on; anything else is an engine-level error.
        const code = (error as { code?: string }).code;
        if (code === undefined || !PER_PHOTO_CODES.has(code)) {
          health.engineErrors++;
          health.consecutiveEngineErrors++;
        }
      }
      vectors.set(photo.item.id, vec);
      if (withHashes && !hashes.has(photo.item.id)) hashes.set(photo.item.id, null);
      if (vec === null) health.failures++;
      else {
        health.successes++;
        health.consecutiveEngineErrors = 0;
      }
      if (health.consecutiveEngineErrors >= ENGINE_FAILURE_ABORT) health.dead = true;
      done++;
      onProgress?.(done, total, vec !== null);
      spawn();
    }
  };
  const spawn = (): void => {
    while (active < Math.min(desiredWorkers(), total - next + active)) {
      active++;
      pool.push(
        worker().finally(() => {
          active--;
        }),
      );
    }
  };
  spawn();
  while (pool.length > 0) await pool.pop();
  // Photos skipped by the dead-engine stop still get explicit nulls (no
  // vector was produced); the caller reads `health` for the abort signal.
  let failed = 0;
  for (const photo of todo) {
    if ((vectors.get(photo.item.id) ?? null) === null) {
      vectors.set(photo.item.id, null);
      if (withHashes && !hashes.has(photo.item.id)) hashes.set(photo.item.id, null);
      failed++;
    }
  }

  // One-time hash backfill for cached-embedding photos (bounded decode,
  // no inference); failures yield null and are not cached (retry next scan).
  // Skipped when the engine is down — the same native decode path serves it.
  for (const photo of hashOnly) {
    if (health.dead) {
      hashes.set(photo.item.id, null);
      continue;
    }
    let hash: string | null = null;
    try {
      hash = await dhash(photo.item.uri);
      if (hash !== null) {
        await setPhotoHash(db, photo.item.id, hash, photo.modTime, 'native').catch(() => {});
      }
    } catch {
      // Per-photo failure: null, uncached.
    }
    hashes.set(photo.item.id, hash);
  }
  return { vectors, hashes, computed: total, failed };
}
