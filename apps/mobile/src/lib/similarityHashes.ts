/**
 * Per-photo dHash pipeline (m0.4) — the impure half of dhashDecode.ts.
 *
 * expo-image-manipulator (SDK 57 context API) shrinks each photo to the
 * 9×8 dHash grid on the native side and returns a tiny base64 JPEG; the
 * pure pipeline (dhashDecode.ts) turns that into a 16-char hex hash.
 *
 * Hashes are cached in SQLite (photo_hashes, migration v5) keyed by
 * MediaStore asset id, invalidated when the asset's modificationTime
 * moves (in-place edit). Computation is lazy — it happens at
 * group-building time, only for photos in multi-photo time clusters —
 * and runs with bounded concurrency so a first session over ~200 new
 * photos keeps the UI thread breathing (the heavy work is native
 * resizing; the JS side decodes 9×8 JPEGs, which is microseconds each).
 * Progress is reported per finished photo for the "Analyzing photos
 * n/total" feedback on the start button.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { LoadedPhoto } from './media';
import { dhashFromJpegBase64, DHASH_GRID_COLS, DHASH_GRID_ROWS } from './dhashDecode';
import { getPhotoHashes, setPhotoHash } from '../db/store';

/** Photos hashed in parallel. Native resize dominates; 3 keeps it smooth. */
const HASH_CONCURRENCY = 3;

/**
 * dHash of one photo uri, or null when the image can't be read/decoded.
 * Failures are per-photo and non-fatal — a null hash falls back to
 * time-cluster grouping (core's conservative null rule).
 */
export async function computeDhash(uri: string): Promise<string | null> {
  try {
    const context = ImageManipulator.manipulate(uri);
    try {
      const image = await context
        .resize({ width: DHASH_GRID_COLS, height: DHASH_GRID_ROWS })
        .renderAsync();
      try {
        const saved = await image.saveAsync({
          format: SaveFormat.JPEG,
          compress: 1,
          base64: true,
        });
        if (!saved.base64) return null;
        return dhashFromJpegBase64(saved.base64);
      } finally {
        image.release();
      }
    } finally {
      context.release();
    }
  } catch {
    return null;
  }
}

export interface EnsureHashesResult {
  /** asset id → hash; null = uncomputable (missing entries were skipped). */
  hashes: Map<string, string | null>;
  /** How many hashes were computed fresh (vs served from cache). */
  computed: number;
}

/**
 * Ensure every given photo has a cached dHash, computing the missing or
 * stale ones (stored mod_time ≠ current modificationTime) with bounded
 * concurrency. `onProgress(done, total)` fires once per photo that
 * needed computing. Failed computations yield null and are NOT cached,
 * so a transient read error retries on the next group build.
 */
export async function ensureDhashes(
  db: SQLiteDatabase,
  photos: readonly LoadedPhoto[],
  onProgress?: (done: number, total: number) => void,
): Promise<EnsureHashesResult> {
  const hashes = new Map<string, string | null>();
  const cached = await getPhotoHashes(
    db,
    photos.map((p) => p.item.id),
  );

  const todo: LoadedPhoto[] = [];
  for (const photo of photos) {
    const row = cached.get(photo.item.id);
    if (row && row.mod_time === photo.modTime) hashes.set(photo.item.id, row.hash);
    else todo.push(photo);
  }

  const total = todo.length;
  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      const photo = todo[index];
      const hash = await computeDhash(photo.item.uri);
      hashes.set(photo.item.id, hash);
      if (hash !== null) {
        await setPhotoHash(db, photo.item.id, hash, photo.modTime).catch(() => {});
      }
      done++;
      onProgress?.(done, total);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, total) }, () => worker()),
  );
  return { hashes, computed: total };
}
