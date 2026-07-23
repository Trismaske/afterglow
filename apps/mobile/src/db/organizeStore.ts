/**
 * Organize queue (m0.7 item E: R#6, N#8, P5#4, C#7) — "move to a different
 * album". Durable per-photo intents on `photos.organize_*`:
 *
 *   none → queued (volume + relative path stored durably; survives error,
 *   cancellation, retry; remove/change-target while queued) → applied
 *   (last applied target kept for History — organizing is REPEATABLE,
 *   N#8: a later queue starts a new intent) or error (retryable).
 *
 * Apply is batched (≤ ORGANIZE_BATCH_LIMIT per OS consent, P5#4): obtain
 * write access via createWriteRequest, move via verified RELATIVE_PATH
 * updates, then one SQLite transaction per batch commits outcomes AND the
 * post-move repair — photos.uri refresh from the verified new path (DB
 * source filters use uri LIKE), applied-target bookkeeping, activity_at.
 * A retry first recognizes "already at target" and completes the repair
 * without prompting again (N#8).
 *
 * m0.7 boundary: targets are PRIMARY external storage only, under DCIM/ or
 * Pictures/ (autonomous); cross-volume sources are rejected with a clear
 * message, never silently copied+trashed.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { PRIMARY_VOLUME } from '../lib/mediaIdentity';

export const ORGANIZE_BATCH_LIMIT = 500;

/** Allowed top-level directories for organize targets (autonomous). */
export const ORGANIZE_ROOTS = ['DCIM/', 'Pictures/'] as const;

export interface OrganizeTarget {
  volumeName: string;
  relativePath: string;
}

/** Validate a target path: primary volume, allowed root, sane segment. */
export function validateOrganizeTarget(target: OrganizeTarget): string | null {
  if (target.volumeName !== PRIMARY_VOLUME) {
    return 'Only albums on primary storage can be organize targets in this release.';
  }
  const path = target.relativePath.endsWith('/') ? target.relativePath : `${target.relativePath}/`;
  if (!ORGANIZE_ROOTS.some((root) => path.startsWith(root))) {
    return 'Albums must live under DCIM/ or Pictures/.';
  }
  if (path.includes('..') || path.includes('//') || path.trim() !== path) {
    return 'That album path is not valid.';
  }
  return null;
}

/** Normalized target path for a new album name → Pictures/<name>/. */
export function newAlbumPath(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '' || /[/\\:*?"<>|]/.test(trimmed)) return null;
  return `Pictures/${trimmed}/`;
}

export interface OrganizeQueueRow {
  photo_id: string;
  uri: string;
  taken_at: number;
  day: string | null;
  organize_volume: string;
  organize_path: string;
}

/** Queue a photo for a move. Present photos only (C#7); the target is
 * validated; a cross-volume SOURCE is rejected (R#6). */
export async function queueOrganize(
  db: SQLiteDatabase,
  photoId: string,
  target: OrganizeTarget,
  at: number,
): Promise<string | null> {
  const invalid = validateOrganizeTarget(target);
  if (invalid) return invalid;
  const photo = await db.getFirstAsync<{ is_present: number; volume_name: string | null }>(
    'SELECT is_present, volume_name FROM photos WHERE asset_id = ?',
    photoId,
  );
  if (!photo || photo.is_present !== 1) return 'That photo is no longer available.';
  if (photo.volume_name !== null && photo.volume_name !== PRIMARY_VOLUME) {
    return 'Photos on removable storage cannot be moved in this release.';
  }
  await db.runAsync(
    `UPDATE photos SET organize_state = 'queued', organize_volume = ?, organize_path = ?,
       organize_changed_at = ?, activity_at = ?
     WHERE asset_id = ?`,
    target.volumeName,
    target.relativePath,
    at,
    at,
    photoId,
  );
  return null;
}

/** Remove from the queue (keeps the photo; distinct from any past apply). */
export async function unqueueOrganize(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await db.runAsync(
    `UPDATE photos SET organize_state = 'none', organize_volume = NULL, organize_path = NULL,
       organize_changed_at = ?, activity_at = ?
     WHERE asset_id = ? AND organize_state IN ('queued', 'error')`,
    at,
    at,
    photoId,
  );
}

export async function getOrganizeQueue(db: SQLiteDatabase): Promise<OrganizeQueueRow[]> {
  return db.getAllAsync<OrganizeQueueRow>(
    `SELECT asset_id AS photo_id, uri, taken_at, day, organize_volume, organize_path
     FROM photos
     WHERE organize_state IN ('queued', 'error') AND is_present = 1
     ORDER BY taken_at ASC`,
  );
}

export async function countOrganizeQueue(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM photos WHERE organize_state IN ('queued', 'error') AND is_present = 1",
  );
  return row?.n ?? 0;
}

export interface OrganizeMoveOutcome {
  photoId: string;
  status: 'moved' | 'already' | 'error' | 'unsupported';
  message: string;
  newData?: string;
}

/**
 * Commit one batch's verified outcomes + post-move repair in ONE SQLite
 * transaction (R#6): moved/already → applied with uri refresh and the
 * N#8 last-applied bookkeeping; error/unsupported → error (retryable).
 */
export async function commitOrganizeOutcomes(
  db: SQLiteDatabase,
  outcomes: readonly OrganizeMoveOutcome[],
  at: number,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const outcome of outcomes) {
      if (outcome.status === 'moved' || outcome.status === 'already') {
        await txn.runAsync(
          `UPDATE photos SET
             organize_state = 'applied',
             organize_applied_at = ?,
             organize_applied_volume = organize_volume,
             organize_applied_path = organize_path,
             organize_volume = NULL,
             organize_path = NULL,
             uri = CASE WHEN ? <> '' THEN ? ELSE uri END,
             activity_at = ?
           WHERE asset_id = ?`,
          at,
          outcome.newData ?? '',
          outcome.newData ? `file://${outcome.newData}` : '',
          at,
          outcome.photoId,
        );
      } else {
        await txn.runAsync(
          `UPDATE photos SET organize_state = 'error', organize_changed_at = ?, activity_at = ?
           WHERE asset_id = ?`,
          at,
          at,
          outcome.photoId,
        );
      }
    }
  });
}
