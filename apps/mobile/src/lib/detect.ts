/**
 * Edit-detection orchestration (m0.3) — runs on app open (Home focus,
 * throttled). Pure decision logic lives in editDetection.ts; this file
 * wires it to MediaStore and SQLite.
 *
 * For every photo waiting in the edit queue:
 *  - IN-PLACE: re-query the asset; if its modificationTime moved past our
 *    stored baseline (hash tiebreaker when we have one) → auto-mark done.
 *    The caller shows an unobtrusive notice.
 *  - EDITED COPY: scan photos written since the photo entered the queue
 *    (plus a ±2 s creation-time sibling window) for filename/timestamp
 *    matches → track the copy as done and hand the original back to the
 *    caller to prompt keep-or-cull.
 *
 * Baseline hashes are computed lazily here (bounded per run) for queued
 * photos that don't have one yet, so the next run can tell a real edit
 * from a metadata-only mod-time bump.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { mountedVolumeSet } from './mountedVolumes';
import {
  checkMediaPresence,
  getAssetDetails,
  loadCandidatesCreatedBetween,
  type CandidateAsset,
} from './media';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { mapWithConcurrency } from './concurrency';
import { sha256OfFile } from './hash';
import { resolveSources } from './sourceCatalog';
import { classifyInPlace, matchEditedCopies, mergeSiblingWindows } from './editDetection';
import { dayKey } from './dates';
import {
  dismissCopyMatch,
  getEditDetectionRows,
  getDetectionTrackedAssets,
  getStatesForAssets,
  insertDetectedCopyWithMatch,
  getPendingCopyMatches,
  markEditDone,
  setContentHash,
  updateModTimeBaseline,
  type EditDetectionRow,
} from '../db/store';

/** Cap on lazily computed baseline hashes per run (full-file reads). */
const MAX_BASELINE_HASHES_PER_RUN = 5;
/** Cap on the "new photos since flagging" candidate scan. */
const MAX_NEW_ASSET_SCAN = 400;
/** Cap on ONE photo's ±2 s sibling window (bursts are never this big).
 * A merged window carries this budget PER window it absorbed, so
 * collapsing overlapping scans stays a speed change and never a coverage
 * change. */
const MAX_SIBLING_SCAN = 50;

export interface DetectedCopy {
  originalAssetId: string;
  originalFilename: string;
  copyAssetId: string;
  copyFilename: string;
}

export interface EditDetectionResult {
  /** In-place edits detected and auto-marked done — the caller reconciles
   * any of these that belong to the active session (reconcileEditsDone). */
  autoDoneIds: string[];
  /** Edited copies detected (copy already tracked as done) — the caller
   * prompts keep-or-cull for each original. */
  copies: DetectedCopy[];
  /** Externally removed photos reconciled during this run — group
   * membership may have changed; the caller must refresh its queue. */
  reconciled: number;
}

interface LiveRow {
  row: EditDetectionRow;
  filename: string;
}

/**
 * `onAutoDone` fires immediately after each durable markEditDone commit —
 * callers reconcile the active session incrementally there, so a failure in
 * a LATER detection step (whose ids the caller would never see) cannot
 * strand a stale live To-Edit flag on an already-done row.
 */
export async function runEditDetection(
  db: SQLiteDatabase,
  onAutoDone?: (assetId: string) => void,
): Promise<EditDetectionResult> {
  const result: EditDetectionResult = { autoDoneIds: [], copies: [], reconciled: 0 };
  const rows = await getEditDetectionRows(db, await mountedVolumeSet());
  if (rows.length === 0) return result;

  // Pass 1: in-place edits. Rows that survive go to copy detection.
  const live: LiveRow[] = [];
  let hashBudget = MAX_BASELINE_HASHES_PER_RUN;
  // The per-photo MediaStore lookups run bounded-parallel (m0.8.1, was
  // serial); the decision loop below stays sequential because it WRITES.
  const detailsByRow = await mapWithConcurrency(rows, 6, (row) =>
    getAssetDetails(row.asset_id).catch(() => null),
  );
  for (const [index, row] of rows.entries()) {
    const details = detailsByRow[index];
    if (!details) continue; // asset gone/unreadable — manual mark-done still works
    const verdict = classifyInPlace(row.mod_time, details.modificationTime, !!row.content_hash);
    if (verdict === 'edited') {
      // Keyed to the captured cycle: a photo re-queued mid-run (a fresh
      // queued_at) must not be completed on this run's stale evidence.
      if (await markEditDone(db, row.asset_id, Date.now(), row.to_edit_at)) {
        onAutoDone?.(row.asset_id);
        result.autoDoneIds.push(row.asset_id);
      }
      continue;
    }
    if (verdict === 'check-hash') {
      const current = await sha256OfFile(details.localUri ?? row.uri);
      if (current === null) {
        // C#9: an unreadable/hash-failed file is NOT evidence its pixels
        // changed — stay queued/unknown; the baseline is left alone so the
        // next run re-checks.
        live.push({ row, filename: details.filename });
        continue;
      }
      if (current !== row.content_hash) {
        if (await markEditDone(db, row.asset_id, Date.now(), row.to_edit_at)) {
          onAutoDone?.(row.asset_id);
          result.autoDoneIds.push(row.asset_id);
        }
        continue;
      }
      // Metadata-only change: move the baseline forward, stay queued.
      await updateModTimeBaseline(db, row.asset_id, details.modificationTime, row.to_edit_at);
    } else {
      if (row.mod_time == null) {
        // Fresh baseline for a re-queued photo (re-flagging reset it):
        // record the current file state so only FUTURE edits count — the
        // previous cycle's edit was already consumed.
        await updateModTimeBaseline(db, row.asset_id, details.modificationTime, row.to_edit_at);
      }
      if (!row.content_hash && hashBudget > 0) {
        // Unchanged and unhashed: bank a baseline for future tiebreaks.
        hashBudget--;
        const hash = await sha256OfFile(details.localUri ?? row.uri);
        if (hash) await setContentHash(db, row.asset_id, hash, row.to_edit_at).catch(() => {});
      }
    }
    live.push({ row, filename: details.filename });
  }
  if (live.length === 0) return result;

  // Pass 2: edited copies. One shared "new since flagging" scan plus a
  // small per-photo creation-time sibling window. Both scans respect the
  // photo-source filter (m0.3.1) — an editor that saves its copy OUTSIDE
  // the selected source folders (e.g. Snapseed → Pictures/ while the
  // source is DCIM/Camera) is therefore not detected; manual Mark done
  // covers that, and in-place detection (pass 1) is unaffected since it
  // re-queries queued assets directly.
  const sources = await resolveSources(db);
  const pool = new Map<string, CandidateAsset>();
  const oldestFlag = Math.min(...live.map((l) => l.row.to_edit_at ?? l.row.taken_at));
  for (const c of await loadCandidatesCreatedBetween(
    oldestFlag,
    undefined,
    MAX_NEW_ASSET_SCAN,
    sources.albumIds,
  )) {
    pool.set(c.id, c);
  }
  // MERGED + BOUNDED-PARALLEL sibling windows (m0.8.1): this ran ONE
  // paged MediaStore scan per queued photo, serialized — and the windows
  // are ±CREATION_TOLERANCE_MS around each photo, so a burst of queued
  // photos re-scanned almost the same range N times. Overlapping windows
  // now collapse into one scan each, each carrying the summed budget of
  // the windows it absorbed (lib/editDetection.ts).
  const merged = mergeSiblingWindows(live.map((l) => l.row.taken_at));
  const scans = await mapWithConcurrency(merged, 4, async (window) => {
    const cap = MAX_SIBLING_SCAN * window.merged;
    // INCLUSIVE window → EXCLUSIVE MediaStore query: widen by 1 ms, or a
    // copy whose cloned capture time sits EXACTLY at the ±tolerance edge
    // is excluded before matching ever sees it (the same correction the
    // scan pager and the progress ranges carry — codex r4).
    const found = await loadCandidatesCreatedBetween(
      window.startMs > 0 ? window.startMs - 1 : 0,
      window.endMs + 1,
      cap,
      sources.albumIds,
    );
    // A bound that silently drops rows reads as "we looked at everything"
    // to whoever debugs the missed detection. Say so, once, loudly.
    if (found.length >= cap) {
      console.warn(
        `[detect] sibling window ${window.startMs}-${window.endMs} hit its ${cap}-row cap ` +
          `(${window.merged} merged) — an edited copy in this range may go undetected`,
      );
    }
    return found;
  });
  for (const siblings of scans) for (const c of siblings) pool.set(c.id, c);

  // Anything already REVIEW-tracked is not an unnoticed copy — that keeps
  // burst siblings from false-positive timestamp matches and prevents
  // re-prompting for copies detected on a previous run. Rows the
  // continuous scan created but nobody touched do NOT count as tracked
  // (m0.8: every photo gets a row within seconds, so a freshly saved
  // editor copy usually has one before detection sees it).
  const tracked = await getDetectionTrackedAssets(db, [...pool.keys()]);
  let candidates = [...pool.values()].filter((c) => !tracked.has(c.id));

  for (const l of live) {
    if (candidates.length === 0) break;
    const matches = matchEditedCopies(
      {
        assetId: l.row.asset_id,
        filename: l.filename,
        takenAt: l.row.taken_at,
        toEditAt: l.row.to_edit_at ?? l.row.taken_at,
      },
      candidates,
    );
    // One best copy per original (C#12): only the first match records —
    // this run, and across runs (the insert skips an original with any
    // existing match). One transaction: a crash can never leave a
    // tracked copy without its pending match (the prompt would be
    // unrecoverable). Unchosen candidates stay untracked and reviewable.
    const [copy] = matches;
    if (copy) {
      const takenAt = copy.creationTime || copy.modificationTime;
      const recorded = await insertDetectedCopyWithMatch(
        db,
        l.row.asset_id,
        {
          assetId: copy.id,
          uri: copy.uri,
          takenAt,
          modTime: copy.modificationTime,
          day: dayKey(takenAt),
        },
        Date.now(),
        l.row.to_edit_at, // evidence belongs to the captured cycle
      );
      if (recorded) {
        result.copies.push({
          originalAssetId: l.row.asset_id,
          originalFilename: l.filename,
          copyAssetId: copy.id,
          copyFilename: copy.filename,
        });
        // A copy belongs to one RECORDED original — an unrecorded
        // candidate stays available for later originals (burst
        // timestamps often match several).
        candidates = candidates.filter((c) => c.id !== copy.id);
      }
    }
  }
  // C#12: previously detected matches whose prompt was deferred re-emit
  // until resolved — a "Decide later" is a postponement, not a dismissal.
  const pending = await getPendingCopyMatches(db);
  const emitted = new Set(result.copies.map((c) => `${c.originalAssetId} ${c.copyAssetId}`));
  for (const match of pending) {
    if (emitted.has(`${match.original_id} ${match.copy_id}`)) continue;
    const original = live.find((l) => l.row.asset_id === match.original_id);
    if (!original) continue; // original resolved/left the queue
    const copyDetails = await getAssetDetails(match.copy_id);
    if (!copyDetails) {
      // getAssetDetails is null for BOTH a missing asset and a transient
      // lookup failure — only an authoritative absence may dismiss the
      // only pending match (fail-closed, like every removal decision).
      // Confirmed absence also converges the copy's tracked 'done' row
      // (presence, intents, counts) via the shared removal cleanup.
      const presence = await checkMediaPresence(match.copy_id);
      if (presence === 'absent' || presence === 'trashed') {
        // Reconcile the copy's tracked row FIRST: a crash between the
        // two leaves the pending match as the retry signal (the next
        // scan lands here again); the reverse order would strand a
        // 'done' row for an absent photo with no way back.
        // Mounted snapshot so the membership repair defers a group still
        // holding a member on an ejected card (final cycle P4, plan §5).
        // 'absent' = permanently gone → duels die too; a restorable
        // 'trashed' keeps them (grilling Q13).
        await reconcileExternallyRemoved(
          db,
          [match.copy_id],
          Date.now(),
          await mountedVolumeSet(),
          presence === 'absent' ? new Set([match.copy_id]) : undefined,
        );
        result.reconciled += 1;
        await dismissCopyMatch(db, match.original_id, match.copy_id);
      }
      continue;
    }
    result.copies.push({
      originalAssetId: match.original_id,
      originalFilename: original.filename,
      copyAssetId: match.copy_id,
      copyFilename: copyDetails.filename,
    });
  }
  return result;
}
