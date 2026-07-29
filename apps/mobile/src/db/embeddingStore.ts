/**
 * Persistence for continuous-scan photo embeddings (m0.8 gate 2).
 *
 * `photo_embeddings` holds one CURRENT vector per asset — little-endian
 * float32 bytes as a BLOB, keyed like photo_hashes: a row whose stored
 * `mod_time` differs from the asset's live modificationTime is stale
 * (in-place edit) and gets recomputed by the scan.
 *
 * The embedding model is pinned: `ensureEmbeddingModel` compares the
 * bundled model's SHA-256 (modules/image-embedder MODEL_SHA256) against
 * the stored settings row and, on mismatch, clears the whole table in the
 * same transaction — the one explicit re-embed event. Vectors from
 * different models are incompatible (Plan_m0.8.md decision 10); mixing
 * them would silently corrupt grouping, so the swap is destructive and
 * loud (callers surface the reset in the scan status).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withWriteTransaction } from './database';

const MODEL_SHA_KEY = 'embedding_model_sha256';

/** Max ids per IN (...) chunk — stays under SQLite's bind-parameter limit. */
const IN_CHUNK = 500;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export interface EmbeddingRow {
  modTime: number;
  /** Little-endian float32 bytes (wrap in an aligned Float32Array to use). */
  vec: Uint8Array;
}

/** Stored embeddings for the given assets (missing rows simply absent). */
export async function getPhotoEmbeddings(
  db: SQLiteDatabase,
  assetIds: readonly string[],
): Promise<Map<string, EmbeddingRow>> {
  const out = new Map<string, EmbeddingRow>();
  for (const ids of chunk(assetIds, IN_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ asset_id: string; mod_time: number; vec: Uint8Array }>(
      `SELECT asset_id, mod_time, vec FROM photo_embeddings WHERE asset_id IN (${placeholders})`,
      ...ids,
    );
    for (const row of rows) out.set(row.asset_id, { modTime: row.mod_time, vec: row.vec });
  }
  return out;
}

/** Upsert one photo's current embedding (replaces any stale vector). */
export async function setPhotoEmbedding(
  db: SQLiteDatabase,
  assetId: string,
  vec: Uint8Array,
  modTime: number,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO photo_embeddings (asset_id, mod_time, vec) VALUES (?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET mod_time = excluded.mod_time, vec = excluded.vec`,
    assetId,
    modTime,
    vec,
  );
}

/** How many embeddings are stored (scan-status corpus accounting). */
export async function countPhotoEmbeddings(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM photo_embeddings');
  return row?.n ?? 0;
}

export interface EnsureModelResult {
  /** True when stored embeddings were discarded (model swap, or vectors
   * found without a pin — unknown provenance is not trusted). */
  cleared: boolean;
  /** How many vectors were discarded (0 when nothing was stored). */
  discarded: number;
}

/**
 * Pin the embedding model: first call stores the SHA; a changed SHA
 * clears every stored vector and re-pins, atomically. Returns what
 * happened so the scan can log the re-embed event loudly, once.
 */
export async function ensureEmbeddingModel(
  db: SQLiteDatabase,
  modelSha256: string,
): Promise<EnsureModelResult> {
  const stored = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    MODEL_SHA_KEY,
  );
  if (stored?.value === modelSha256) return { cleared: false, discarded: 0 };
  let discarded = 0;
  await withWriteTransaction(db, async (txn) => {
    const row = await txn.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM photo_embeddings',
    );
    discarded = row?.n ?? 0;
    await txn.runAsync('DELETE FROM photo_embeddings');
    await txn.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      MODEL_SHA_KEY,
      modelSha256,
    );
  });
  return { cleared: discarded > 0, discarded };
}
