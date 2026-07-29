/**
 * Organize queue (m0.7 item E: R#6, N#8, P5#4, C#7) — "move to a different
 * album". Durable per-photo intents in `photo_actions`:
 *
 *   none → queued (m0.8.2, F6: the deck queues with NO target — a bare
 *   "move this somewhere"; the queue screen assigns albums in batches) →
 *   targeted (still `queued`, target set) → applied (last applied target
 *   kept for History — organizing is REPEATABLE, N#8: a later queue
 *   starts a new intent) or error (retryable; a re-target resets it to
 *   queued, because a new album is a fresh intent).
 *
 * Only TARGETED rows can move. Apply is batched (≤ ORGANIZE_BATCH_LIMIT
 * per OS consent, P5#4): obtain write access via createWriteRequest, move
 * via verified RELATIVE_PATH updates, then one SQLite transaction per
 * batch commits outcomes AND the post-move repair — photos.uri refresh
 * from the verified new path (DB source filters use uri LIKE),
 * applied-target bookkeeping, activity_at. A retry first recognizes
 * "already at target" and completes the repair without prompting again
 * (N#8). The commit guards match `target = ?`, which never matches NULL —
 * an untargeted row is structurally unmovable.
 *
 * m0.7 boundary: targets are PRIMARY external storage only, under DCIM/ or
 * Pictures/ (autonomous); cross-volume sources are rejected with a clear
 * message, never silently copied+trashed.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withWriteTransaction } from './database';
import { encodeOrganizeTarget, livePhotoClause, unqueueAction } from './actions';
import { chunk, IN_CHUNK } from './store';
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
  /** NULL until an album is assigned in the queue (m0.8.2, F6). */
  organize_volume: string | null;
  organize_path: string | null;
  /** 'error' = the move was attempted and FAILED; still queued work, but
   * the row says so rather than looking like it has not run yet. */
  state: string;
}

/** Queue a photo for a move — WITHOUT a target (m0.8.2, F6: the deck's
 * Organize chip is a toggle; albums are assigned in the queue). Present
 * photos only (C#7); a cross-volume SOURCE is rejected (R#6). A
 * re-queue after a completed move keeps the last target as a prefill —
 * the queue screen shows it and re-assignment is one selection away. */
export async function queueOrganize(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<string | null> {
  const photo = await db.getFirstAsync<{ is_present: number; volume_name: string | null }>(
    'SELECT is_present, volume_name FROM photos WHERE asset_id = ?',
    photoId,
  );
  if (!photo || photo.is_present !== 1) return 'That photo is no longer available.';
  if (photo.volume_name !== null && photo.volume_name !== PRIMARY_VOLUME) {
    return 'Photos on removable storage cannot be moved in this release.';
  }
  await db.runAsync(
    `INSERT INTO photo_actions (photo_id, kind, state, target, queued_at)
     VALUES (?, 'organize', 'queued', NULL, ?)
     ON CONFLICT(photo_id, kind) DO UPDATE SET
       state = 'queued', queued_at = excluded.queued_at`,
    photoId,
    at,
  );
  // History is ordered by activity_at and drops rows without it, so an
  // intent change has to stamp it — the pre-v18 column write did.
  await db.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
  return null;
}

/**
 * Assign one album to a batch of queued rows (m0.8.2, F6 — the queue
 * screen's "Choose album" over a selection). Validates the target once,
 * then re-targets every still-live queued/error row in the set: an
 * errored row resets to `queued`, because a new album is a fresh intent.
 * Chunked — selections are unbounded (TODO rider: no unchunked IN lists
 * on batch paths).
 */
export async function setOrganizeTargets(
  db: SQLiteDatabase,
  photoIds: readonly string[],
  target: OrganizeTarget,
  at: number,
): Promise<string | null> {
  const invalid = validateOrganizeTarget(target);
  if (invalid) return invalid;
  if (photoIds.length === 0) return null;
  const encoded = encodeOrganizeTarget(target.volumeName, target.relativePath);
  await withWriteTransaction(db, async (txn) => {
    for (const batch of chunk(photoIds, IN_CHUNK)) {
      const placeholders = batch.map(() => '?').join(',');
      await txn.runAsync(
        `UPDATE photo_actions SET target = ?, state = 'queued'
          WHERE kind = 'organize' AND state IN ('queued', 'error')
            AND photo_id IN (${placeholders})`,
        encoded,
        ...batch,
      );
      await txn.runAsync(
        `UPDATE photos SET activity_at = ? WHERE asset_id IN (${placeholders})`,
        at,
        ...batch,
      );
    }
  });
  return null;
}

/** Remove from the queue (keeps the photo; distinct from any past apply). */
export async function unqueueOrganize(
  db: SQLiteDatabase,
  photoId: string,
  at: number,
): Promise<void> {
  await unqueueAction(db, photoId, 'organize');
  await db.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
}

export async function getOrganizeQueue(db: SQLiteDatabase): Promise<OrganizeQueueRow[]> {
  // NULL-safe target projection: an untargeted row (m0.8.2) comes back
  // with NULL volume/path rather than substr() noise.
  return db.getAllAsync<OrganizeQueueRow>(
    `SELECT p.asset_id AS photo_id, p.uri, p.taken_at, p.day, pa.state,
            CASE WHEN pa.target IS NULL THEN NULL
                 ELSE substr(pa.target, 1, instr(pa.target, char(10)) - 1) END AS organize_volume,
            CASE WHEN pa.target IS NULL THEN NULL
                 ELSE substr(pa.target, instr(pa.target, char(10)) + 1) END AS organize_path
     FROM photos p
     JOIN photo_actions pa ON pa.photo_id = p.asset_id AND pa.kind = 'organize'
     WHERE pa.state IN ('queued', 'error') AND ${livePhotoClause('p.asset_id')}
     ORDER BY p.taken_at ASC`,
  );
}

export async function countOrganizeQueue(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id AND pa.kind = 'organize'
      WHERE pa.state IN ('queued', 'error') AND ${livePhotoClause('p.asset_id')}`,
  );
  return row?.n ?? 0;
}

export interface OrganizeMoveOutcome {
  photoId: string;
  status: 'moved' | 'already' | 'error' | 'unsupported';
  message: string;
  newData?: string;
  /** The intent this move EXECUTED. Commit bookkeeping applies only
   * while the durable intent still matches — a mid-move removal or
   * retarget (another screen, or after navigating away) keeps its newer
   * intent; the uri truth still refreshes for a physically moved file. */
  volumeName: string;
  relativePath: string;
}

/**
 * Commit one batch's verified outcomes + post-move repair in ONE SQLite
 * transaction (R#6): moved/already → applied with uri refresh and the
 * N#8 last-applied bookkeeping; error/unsupported → error (retryable).
 * Every intent write is guarded by the executed target — stale
 * continuations can never clear or mislabel a newer durable intent.
 */
export async function commitOrganizeOutcomes(
  db: SQLiteDatabase,
  outcomes: readonly OrganizeMoveOutcome[],
  at: number,
): Promise<void> {
  await withWriteTransaction(db, async (txn) => {
    for (const outcome of outcomes) {
      if (outcome.status === 'moved' || outcome.status === 'already') {
        // Guarded on the REQUESTED target: an outcome for a move the
        // user has since re-targeted must not mark the new one applied.
        await txn.runAsync(
          `UPDATE photo_actions
              SET state = 'applied', resolved_at = ?, applied_target = target
            WHERE photo_id = ? AND kind = 'organize'
              AND state IN ('queued', 'error') AND target = ?`,
          at,
          outcome.photoId,
          `${outcome.volumeName}\n${outcome.relativePath}`,
        );
        await txn.runAsync(
          'UPDATE photos SET activity_at = ? WHERE asset_id = ?',
          at,
          outcome.photoId,
        );
        // The uri truth refreshes REGARDLESS of intent bookkeeping — the
        // file physically moved, and a stale uri would break thumbnails
        // and source filtering.
        await txn.runAsync(
          `UPDATE photos SET uri = CASE WHEN ? <> '' THEN ? ELSE uri END, mod_time = NULL
           WHERE asset_id = ?`,
          outcome.newData ?? '',
          outcome.newData ? `file://${outcome.newData}` : '',
          outcome.photoId,
        );
      } else {
        await txn.runAsync(
          `UPDATE photo_actions SET state = 'error'
            WHERE photo_id = ? AND kind = 'organize' AND state = 'queued' AND target = ?`,
          outcome.photoId,
          `${outcome.volumeName}\n${outcome.relativePath}`,
        );
      }
    }
  });
}
