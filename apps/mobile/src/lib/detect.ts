/**
 * Edit-detection orchestration (m0.3) — runs on app open (Home focus,
 * throttled). Pure decision logic lives in editDetection.ts; this file
 * wires it to MediaStore and SQLite.
 *
 * For every to_edit photo:
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
import {
  checkMediaPresence,
  getAssetDetails,
  loadCandidatesCreatedBetween,
  type CandidateAsset,
} from './media';
import { reconcileExternallyRemoved } from '../db/trashStore';
import { sha256OfFile } from './hash';
import { resolveSources } from './sourceCatalog';
import { classifyInPlace, CREATION_TOLERANCE_MS, matchEditedCopies } from './editDetection';
import { dayKey } from './dates';
import {
  dismissCopyMatch,
  getEditDetectionRows,
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
/** Cap on each ±2 s sibling window query (bursts are never this big). */
const MAX_SIBLING_SCAN = 50;

export interface DetectedCopy {
  originalAssetId: string;
  originalFilename: string;
  copyAssetId: string;
  copyFilename: string;
}

export interface EditDetectionResult {
  /** In-place edits detected and auto-marked done. */
  autoDone: number;
  /** Edited copies detected (copy already tracked as done) — the caller
   * prompts keep-or-cull for each original. */
  copies: DetectedCopy[];
}

interface LiveRow {
  row: EditDetectionRow;
  filename: string;
}

export async function runEditDetection(db: SQLiteDatabase): Promise<EditDetectionResult> {
  const result: EditDetectionResult = { autoDone: 0, copies: [] };
  const rows = await getEditDetectionRows(db);
  if (rows.length === 0) return result;

  // Pass 1: in-place edits. Rows that survive go to copy detection.
  const live: LiveRow[] = [];
  let hashBudget = MAX_BASELINE_HASHES_PER_RUN;
  for (const row of rows) {
    const details = await getAssetDetails(row.asset_id);
    if (!details) continue; // asset gone/unreadable — manual mark-done still works
    const verdict = classifyInPlace(row.mod_time, details.modificationTime, !!row.content_hash);
    if (verdict === 'edited') {
      await markEditDone(db, row.asset_id);
      result.autoDone++;
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
        await markEditDone(db, row.asset_id);
        result.autoDone++;
        continue;
      }
      // Metadata-only change: move the baseline forward, stay queued.
      await updateModTimeBaseline(db, row.asset_id, details.modificationTime);
    } else {
      if (row.mod_time == null) {
        // Fresh baseline for a re-queued photo (done → to_edit reset it):
        // record the current file state so only FUTURE edits count — the
        // previous cycle's edit was already consumed.
        await updateModTimeBaseline(db, row.asset_id, details.modificationTime);
      }
      if (!row.content_hash && hashBudget > 0) {
        // Unchanged and unhashed: bank a baseline for future tiebreaks.
        hashBudget--;
        const hash = await sha256OfFile(details.localUri ?? row.uri);
        if (hash) await setContentHash(db, row.asset_id, hash).catch(() => {});
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
  for (const l of live) {
    const siblings = await loadCandidatesCreatedBetween(
      l.row.taken_at - CREATION_TOLERANCE_MS,
      l.row.taken_at + CREATION_TOLERANCE_MS,
      MAX_SIBLING_SCAN,
      sources.albumIds,
    );
    for (const c of siblings) pool.set(c.id, c);
  }

  // Anything we already track (any state) is not an unnoticed copy —
  // this also keeps burst siblings from false-positive timestamp matches
  // and prevents re-prompting for copies detected on a previous run.
  const tracked = await getStatesForAssets(db, [...pool.keys()]);
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
        await reconcileExternallyRemoved(db, [match.copy_id], Date.now());
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
