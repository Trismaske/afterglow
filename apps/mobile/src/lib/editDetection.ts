/**
 * Edit-detection heuristics (m0.3) — pure TypeScript, no platform APIs, no
 * Date.now(). Unit-tested with vitest (editDetection.test.ts); the impure
 * orchestration (MediaStore queries, SQLite writes) lives in detect.ts.
 *
 * Two heuristics, because Android editors differ (PLAN.md):
 *
 * 1. IN-PLACE edits (Samsung Gallery style): same asset, changed content.
 *    Signal = MediaStore modificationTime moved past our stored baseline.
 *    A stored content hash, when we have one, acts as tiebreaker: a moved
 *    mod time with an identical hash is a metadata-only change (favorite
 *    toggled, album moved), not an edit.
 *
 * 2. EDITED COPIES (Google Photos / Snapseed style): a new asset appears
 *    whose filename relates to the original (IMG_123-edit, IMG_123~2,
 *    IMG_123_1, IMG_123(1), edited_IMG_123 …) or whose creationTime sits
 *    within ±2 s of the original (editors that clone DATE_TAKEN). Only
 *    files written after the photo entered the to-edit queue qualify.
 *
 * Both can miss — that's fine. Detection is a convenience layer; manual
 * "Mark done" always exists (PLAN.md risk mitigation).
 */

// ------------------------------------------------------------- in-place

export type InPlaceVerdict =
  /** Mod time hasn't moved (or we have no baseline) — no edit signal. */
  | 'unchanged'
  /** Mod time moved and no hash baseline exists — treat as edited. */
  | 'edited'
  /** Mod time moved but a hash baseline exists — verify content changed. */
  | 'check-hash';

/**
 * Classify an in-place edit candidate from its stored baseline vs the
 * asset's current MediaStore modification time.
 */
export function classifyInPlace(
  storedModTime: number | null,
  currentModTime: number,
  hasBaselineHash: boolean,
): InPlaceVerdict {
  if (storedModTime == null || !currentModTime) return 'unchanged';
  if (currentModTime <= storedModTime) return 'unchanged';
  return hasBaselineHash ? 'check-hash' : 'edited';
}

// ------------------------------------------------------- filename kinship

/** Filename without its final extension ("IMG_123.jpg" → "IMG_123"). */
export function baseName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Separator that must sit between the shared base and the edit marker. */
const SEP_AFTER = /^[\s._~()-]/;
const SEP_BEFORE = /[\s._~()-]$/;

/** Bases shorter than this are too generic for prefix/suffix matching. */
const MIN_BASE_FOR_AFFIX = 3;

/**
 * Does `candidateFilename` look like it was derived from
 * `originalFilename`? Case-insensitive, extension-agnostic. Matches:
 *  - identical base, different file ("IMG_123.jpg" → "IMG_123.png")
 *  - original base + separator + anything ("IMG_123-edit", "IMG_123~2",
 *    "IMG_123_1", "IMG_123 (1)")
 *  - anything + separator + original base ("edited-IMG_123")
 * Deliberately does NOT match plain extensions of the digit run
 * ("IMG_1234" is unrelated to "IMG_123" — the separator is required).
 */
export function filenamesRelated(originalFilename: string, candidateFilename: string): boolean {
  const original = baseName(originalFilename).toLowerCase();
  const candidate = baseName(candidateFilename).toLowerCase();
  if (!original || !candidate) return false;
  if (original === candidate) return true;
  if (original.length < MIN_BASE_FOR_AFFIX) return false;
  if (candidate.startsWith(original)) return SEP_AFTER.test(candidate.slice(original.length));
  if (candidate.endsWith(original)) {
    return SEP_BEFORE.test(candidate.slice(0, candidate.length - original.length));
  }
  return false;
}

// -------------------------------------------------------- edited copies

/** Editors that clone DATE_TAKEN land within this window of the original. */
export const CREATION_TOLERANCE_MS = 2000;

export interface OriginalForMatch {
  assetId: string;
  filename: string;
  /** The original's creation time (MediaStore creationTime). */
  takenAt: number;
  /** When the photo entered the to-edit queue. */
  toEditAt: number;
}

export interface CandidateForMatch {
  id: string;
  filename: string;
  creationTime: number;
  modificationTime: number;
}

/**
 * Which candidates look like edited copies of `original`? A candidate
 * qualifies when its file was written after the original entered the
 * to-edit queue AND either its filename relates or its creationTime sits
 * within ±CREATION_TOLERANCE_MS of the original's. Callers must pre-filter
 * candidates already tracked in the DB (burst siblings from a reviewed
 * session would otherwise false-positive on the creation-time rule).
 */
export function matchEditedCopies<C extends CandidateForMatch>(
  original: OriginalForMatch,
  candidates: readonly C[],
): C[] {
  return candidates.filter((c) => {
    if (c.id === original.assetId) return false;
    if (!c.modificationTime || c.modificationTime < original.toEditAt) return false;
    return (
      filenamesRelated(original.filename, c.filename) ||
      Math.abs(c.creationTime - original.takenAt) <= CREATION_TOLERANCE_MS
    );
  });
}
