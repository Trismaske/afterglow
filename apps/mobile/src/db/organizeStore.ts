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
import { encodeOrganizeTarget, leaveQueue, livePhotoClause, sourceExists } from './actions';
import type { SourceRoot } from '../lib/sources';
import { chunk, IN_CHUNK } from './store';
import { PRIMARY_VOLUME } from '../lib/mediaIdentity';

export const ORGANIZE_BATCH_LIMIT = 500;

/** Allowed top-level directories for organize targets (autonomous). */

export interface OrganizeTarget {
  volumeName: string;
  relativePath: string;
}

/**
 * Validate a target path: primary volume, sane segment. Nothing else.
 *
 * There is deliberately NO app-side allow-list of top-level directories
 * (m0.8.4, Tristan). m0.7 shipped one — `DCIM/` and `Pictures/` only,
 * an autonomous call that was never vetted — and it refused a perfectly
 * ordinary "move this to Downloads" with a message that read like
 * Android's rule rather than ours. **Android is the only authority on
 * where a photo may live**, and it is one we cannot restate accurately:
 * the allow-list varies by collection and version, so any copy of it
 * here is a second source of truth that silently drifts.
 *
 * What makes dropping it safe is the failure path: a refused move is
 * explained by `lib/organizeFailures.ts`, which quotes Android's own
 * words verbatim. So the platform's rule is stated by the platform, at
 * the moment it applies, in its own language — instead of being
 * guessed at here.
 *
 * The two checks that stay are ours to make: the volume (cross-volume
 * moves are not supported this release) and path sanity (traversal,
 * doubled separators, stray whitespace — none of which is Android's job
 * to catch for us).
 */
export function validateOrganizeTarget(target: OrganizeTarget): string | null {
  if (target.volumeName !== PRIMARY_VOLUME) {
    return 'Only albums on primary storage can be organize targets in this release.';
  }
  const path = target.relativePath.endsWith('/') ? target.relativePath : `${target.relativePath}/`;
  if (path.includes('..') || path.includes('//') || path.trim() !== path) {
    return 'That album path is not valid.';
  }
  return null;
}

/**
 * Where Android permits an IMAGES row to live, mirrored from the
 * platform's own refusal (measured on the S10e, 2026-07-31):
 *
 *   IllegalArgumentException: Primary directory Download not allowed
 *   for content://media/external_primary/images/media/143737;
 *   allowed directories are [DCIM, Pictures]
 *
 * A CONVENIENCE, not an authority. `validateOrganizeTarget` deliberately
 * does not consult it — Android decides, and a refusal is explained in
 * Android's own words (lib/organizeFailures.ts). This exists so the
 * album picker stops OFFERING targets the next step will refuse, which
 * is what m0.8.4's acceptance pass hit: Downloads was pickable, then
 * rejected after an OS consent tap.
 *
 * Being a convenience is what makes the duplication safe. If Android
 * ever widens the rule this filter is merely stale — it hides an option
 * that would have worked, which is annoying; it can never block a move
 * the platform would allow, because nothing downstream reads it.
 */
export function androidAllowsImagesIn(relativePath: string): boolean {
  const path = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
  return path.startsWith('DCIM/') || path.startsWith('Pictures/');
}

/** Normalized target path for a NEW album name → `Pictures/<name>/`.
 * Creating an album still defaults to Pictures/ — that is a sensible
 * home for one the user is inventing, not a restriction: existing
 * albums anywhere on primary storage are pickable (validateOrganizeTarget). */
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
  // The pre-read exists for the user-facing MESSAGES; the write below
  // re-proves presence itself, so this read racing a scan reconcile can
  // never queue an action on a photo that just vanished.
  const photo = await db.getFirstAsync<{ is_present: number; volume_name: string }>(
    'SELECT is_present, volume_name FROM photos WHERE asset_id = ?',
    photoId,
  );
  if (!photo || photo.is_present !== 1) return 'That photo is no longer available.';
  // Real volume identity (v20, NOT NULL) makes this rejection live for
  // SD photos — the D3 organize limitation, NAMED at the affordance
  // (plan §6: visible-and-named, never a dead chip or a Move-time
  // surprise). The deck shows this as an alert on the chip tap.
  if (photo.volume_name !== PRIMARY_VOLUME) {
    return 'On SD card — moves are not supported in this release. Cull, favourite, edit and share all work.';
  }
  let queued = false;
  // ONE transaction for queue truth + its History stamp: as separate
  // autocommit statements, a death between them left the row queued with
  // no activity_at — and History orders by activity_at and drops rows
  // without it, so the intent change would never surface there.
  await withWriteTransaction(db, async (txn) => {
    // INSERT..SELECT keeps the presence guard INSIDE the write (the
    // is_present = 1 pattern used across db/): zero rows means the photo
    // went absent since the validate read above.
    const result = await txn.runAsync(
      `INSERT INTO photo_actions (photo_id, kind, state, target, queued_at)
       SELECT asset_id, 'organize', 'queued', NULL, ?
         FROM photos WHERE asset_id = ? AND is_present = 1
       ON CONFLICT(photo_id, kind) DO UPDATE SET
         state = 'queued', queued_at = excluded.queued_at,
         -- The documented prefill survives a full completed -> requeue ->
         -- unqueue -> requeue lap: leaveQueue's demote clears target, so
         -- a bare preserve would prefill NULL — the applied album is the
         -- next best memory of "probably still right" (codex r7).
         target = COALESCE(target, applied_target)`,
      at,
      photoId,
    );
    queued = Number(result.changes) > 0;
    if (queued) {
      await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
    }
  });
  return queued ? null : 'That photo is no longer available.';
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
        // Only rows the re-target above actually touched: stamping the
        // whole batch would bump History for photos whose organize row
        // was concurrently unqueued or resolved.
        `UPDATE photos SET activity_at = ?
          WHERE asset_id IN (${placeholders})
            AND EXISTS (SELECT 1 FROM photo_actions pa
                         WHERE pa.photo_id = photos.asset_id AND pa.kind = 'organize'
                           AND pa.state = 'queued' AND pa.target = ?)`,
        at,
        ...batch,
        encoded,
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
  // leaveQueue's two statements + the History stamp in ONE transaction
  // (queue truth and its activity_at must land or fail together). The
  // stamp only lands when a row actually left the queue — stamping a
  // no-op would bump History for a photo whose intent did not change
  // (the same only-rows-touched rule setOrganizeTargets applies).
  await withWriteTransaction(db, async (txn) => {
    const left = await leaveQueue(txn, photoId, 'organize');
    if (left > 0) {
      await txn.runAsync('UPDATE photos SET activity_at = ? WHERE asset_id = ?', at, photoId);
    }
  });
}

export async function getOrganizeQueue(
  db: SQLiteDatabase,
  /** m0.8.3 §5: an unmounted volume's queued moves wait for remount. */
  mounted: readonly string[] | null = null,
  /** m0.8.7 F18: out-of-source queued moves wait with their folder. */
  roots: readonly SourceRoot[] | null = null,
): Promise<OrganizeQueueRow[]> {
  const reach =
    mounted === null
      ? { sql: '', params: [] as string[] }
      : mounted.length === 0
        ? { sql: ' AND 0', params: [] as string[] }
        : {
            sql: ` AND p.volume_name IN (${mounted.map(() => '?').join(',')})`,
            params: [...mounted],
          };
  const src = sourceExists(roots, 'p.asset_id');
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
     WHERE pa.state IN ('queued', 'error') AND ${livePhotoClause('p.asset_id', 'organize')}${reach.sql}${src.sql}
     ORDER BY p.taken_at ASC`,
    ...reach.params,
    ...src.params,
  );
}

export async function countOrganizeQueue(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM photos p
       JOIN photo_actions pa ON pa.photo_id = p.asset_id AND pa.kind = 'organize'
      WHERE pa.state IN ('queued', 'error') AND ${livePhotoClause('p.asset_id', 'organize')}`,
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
        const applied = await txn.runAsync(
          `UPDATE photo_actions
              SET state = 'applied', resolved_at = ?, applied_target = target
            WHERE photo_id = ? AND kind = 'organize'
              AND state IN ('queued', 'error') AND target = ?`,
          at,
          outcome.photoId,
          `${outcome.volumeName}\n${outcome.relativePath}`,
        );
        // History stamps only when the intent transition ACTUALLY landed
        // (codex r8): a stale outcome for a since-retargeted or removed
        // intent correctly no-ops above, and bumping History for it
        // would announce a change that did not happen. The uri repair
        // below stays unconditional — the file really moved.
        if (Number(applied.changes) > 0) {
          await txn.runAsync(
            'UPDATE photos SET activity_at = ? WHERE asset_id = ?',
            at,
            outcome.photoId,
          );
        }
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
