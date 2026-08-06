/**
 * "Forget this card" (m0.8.3 §7, mechanism 2) — the volume-scoped,
 * user-asserted exit for a card that is never coming back. Two levels,
 * both destructive-confirmed in the UI:
 *
 * - **keep**: every photo on the volume demotes to a TOMBSTONE — marked
 *   absent by user assertion with verdict/timestamps/day intact, so
 *   all-time counts, per-day charts and base rates survive; satellites
 *   are swept exactly like mechanism 1 (embeddings, hashes, duels,
 *   queued action rows; resolved rows stay). The Home banner clears
 *   because no present row remains unreachable.
 * - **erase**: the rows and every satellite are hard-deleted — all-time
 *   counts VISIBLY drop, which the confirmation copy must say.
 *
 * Offered where the unreachable state is named: the Settings row and the
 * Home banner's press-through (both land in Settings).
 *
 * Honest edge (stated in the flow copy): if a forgotten card returns
 * with files intact, the scan re-ingests — state-intact but needing
 * re-embedding (keep) or as brand-new unreviewed photos (erase).
 *
 * Per-photo forget is deliberately excluded (plan D11): the volume is
 * the use case, and a smaller destructive surface is the point.
 *
 * Healthy-DB hygiene only — the broken-DB recovery reset remains its own
 * TODO (D12).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { withWriteTransaction } from './database';
import { closeShareCycleIfQueueEmpty } from './shareStore';
import { repairGroupMembership } from './store';
import { SCAN_FINGERPRINT_KEY, SCAN_GENERATIONS_KEY } from '../lib/scanSkip';

export type ForgetLevel = 'keep' | 'erase';

export interface ForgetVolumeResult {
  /** Present rows the assertion covered. */
  photos: number;
  /** Every row touched — erase deletes this many (tombstones included). */
  rows: number;
}

/** What a forget would cover — the confirmation dialog's numbers
 * (codex phase-4: the irreversible copy must name the WHOLE population
 * the write touches, volume-wide and tombstones included, never the
 * source-scoped present subset a banner happened to show). */
export interface ForgettableCounts {
  /** Present rows on the volume (what "keep" demotes). */
  present: number;
  /** EVERY row on the volume, prior tombstones included (what "erase"
   * deletes, history and all). */
  total: number;
}

export async function countForgettable(
  db: SQLiteDatabase,
  volume: string,
): Promise<ForgettableCounts> {
  const row = await db.getFirstAsync<{ present: number; total: number }>(
    `SELECT SUM(CASE WHEN is_present = 1 THEN 1 ELSE 0 END) AS present,
            COUNT(*) AS total
       FROM photos WHERE volume_name = ?`,
    volume,
  );
  return { present: Number(row?.present ?? 0), total: Number(row?.total ?? 0) };
}

export async function forgetVolume(
  db: SQLiteDatabase,
  volume: string,
  level: ForgetLevel,
  at: number,
  /** Mounted volumes at confirm time (final cycle O2): the forgotten
   * volume's own rows are tombstoned/deleted before the repair runs, but
   * a touched group can ALSO hold a member on a different, merely
   * unmounted card — that member's assignment defers like every other
   * unreachable member's. Null = unknowable = no deferral. */
  mounted: readonly string[] | null = null,
): Promise<ForgetVolumeResult> {
  let photos = 0;
  let rows = 0;
  await withWriteTransaction(db, async (txn) => {
    const ids = await txn.getAllAsync<{ asset_id: string }>(
      'SELECT asset_id FROM photos WHERE volume_name = ?',
      volume,
    );
    if (ids.length === 0) return;
    rows = ids.length;
    const present = await txn.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM photos WHERE volume_name = ? AND is_present = 1',
      volume,
    );
    photos = Number(present?.n ?? 0);
    // The groups whose membership this touches, read BEFORE the writes.
    const groups = await txn.getAllAsync<{ group_id: number }>(
      `SELECT DISTINCT a.group_id FROM photo_group_assignments a
        JOIN photos p ON p.asset_id = a.photo_id
       WHERE p.volume_name = ? AND a.group_id IS NOT NULL`,
      volume,
    );

    // Satellites first (both levels) — mechanism 1's sweep, in bulk.
    // Sub-selects rather than id lists: a card can hold tens of
    // thousands of rows, and the transaction must stay one statement per
    // table, not one per photo.
    const byVolume = 'SELECT asset_id FROM photos WHERE volume_name = ?';
    await txn.runAsync(`DELETE FROM photo_embeddings WHERE asset_id IN (${byVolume})`, volume);
    await txn.runAsync(`DELETE FROM photo_hashes WHERE asset_id IN (${byVolume})`, volume);
    await txn.runAsync(
      `DELETE FROM duels WHERE winner_id IN (${byVolume}) OR loser_id IN (${byVolume})`,
      volume,
      volume,
    );
    await txn.runAsync(
      `DELETE FROM edit_copy_matches
        WHERE state = 'pending' AND (original_id IN (${byVolume}) OR copy_id IN (${byVolume}))`,
      volume,
      volume,
    );

    if (level === 'keep') {
      // Queued work dies (its file is gone for good); completed work —
      // resolved action rows, share/trash history — stays: it feeds base
      // rates and turnaround, and it HAPPENED.
      await txn.runAsync(
        `DELETE FROM photo_actions
          WHERE resolved_at IS NULL AND photo_id IN (${byVolume})`,
        volume,
      );
      await txn.runAsync(
        `UPDATE photo_actions SET state = 'applied', target = NULL
          WHERE state IN ('queued', 'error') AND resolved_at IS NOT NULL
            AND photo_id IN (${byVolume})`,
        volume,
      );
      // The tombstone: absent by user assertion, verdict intact —
      // activity_at DELIBERATELY untouched (final cycle O7): Forget is
      // not a photo decision, and restamping would resurface thousands
      // of old decisions at the top of History wearing today's date.
      await txn.runAsync('UPDATE photos SET is_present = 0 WHERE volume_name = ?', volume);
    } else {
      // ERASE: hard-delete rows + satellites without ON DELETE CASCADE
      // (share/trash member rows are plain REFERENCES and would block
      // the delete). This is the one path that makes all-time counts
      // drop — the confirmation copy says so.
      await txn.runAsync(`DELETE FROM share_batch_members WHERE photo_id IN (${byVolume})`, volume);
      // A share batch whose every member was on this card would linger in
      // History as "Share sheet opened · 0 photos" — an event about
      // nothing. Mixed batches keep their surviving members.
      await txn.runAsync(
        `DELETE FROM share_batches
          WHERE id NOT IN (SELECT DISTINCT batch_id FROM share_batch_members)`,
      );
      await txn.runAsync(`DELETE FROM trash_batch_members WHERE photo_id IN (${byVolume})`, volume);
      // photo_actions, photo_group_assignments, edit_copy_matches and
      // trash_reservations cascade with the photos rows.
      await txn.runAsync('DELETE FROM photos WHERE volume_name = ?', volume);
    }

    // Durably defeat the unchanged-library skip IN THIS TRANSACTION
    // (final cycle P4): the flow's forced rescan is process-local — if
    // the process dies before that pass completes, a forgotten card
    // returning unchanged could fingerprint-match the stored pass and
    // never re-ingest, breaking the dialog's promise. No fingerprint =
    // never skip; no baselines = the next open runs the full pass the
    // forced rescan intended anyway.
    await txn.runAsync(
      'DELETE FROM settings WHERE key IN (?, ?)',
      SCAN_FINGERPRINT_KEY,
      SCAN_GENERATIONS_KEY,
    );

    // Membership repair over the touched groups. The forgotten volume
    // itself needs no deferral (its rows are tombstoned/deleted above —
    // the user just asserted the card is never coming back), but the
    // mounted set still defers for members on OTHER unmounted cards.
    await repairGroupMembership(
      txn,
      groups.map((g) => Number(g.group_id)),
      mounted,
    );
    // Forget can retire the last live queued share — the empty→non-empty
    // cycle contract holds here like every other queue-emptying path
    // (final cycle N8).
    await closeShareCycleIfQueueEmpty(txn, at);
  });
  return { photos, rows };
}
