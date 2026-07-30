/**
 * Per-volume scan contract (m0.8.3 phase 2, pure) — the decision math
 * behind plan §4's seven invariants. The impure runner (scan/scanRunner)
 * feeds it mounted volumes, per-volume counts, and stored baselines; every
 * rule that can be unit-tested lives here.
 *
 * Vocabulary:
 * - A GENERATION KEY is "<volume>|<MediaStore version>" (the native module
 *   bakes the version in so a provider rebuild mismatches every stored
 *   key); `rawVolumeOfKey` recovers the volume.
 * - SCOPE-RELEVANT volumes (invariant 7): under "All folders" every
 *   mounted volume; under a dirs selection only the roots' volumes. An
 *   out-of-scope card's activity must never defeat the unchanged-library
 *   skip, never trigger a pass, and never enter a tripwire.
 * - Invariant 2: an unmounted volume is skipped entirely — its stored
 *   baseline is RETAINED, never compared, never advanced.
 */
import type { SourceRoot } from './sources';

/** The raw volume name behind a generation key. */
/** Relevant mounted volumes with NO entry in the versioned generation
 * map (keys `<volume>|<MediaStore version>`): the mounted set moved
 * between the two native reads — a card that mounted mid-startup has no
 * generation entry, so the unchanged-library skip is disqualified and
 * the pass runs FULL (a delta planned from the older keys could finish
 * "verified" without enumerating the card; final cycle Q1/R2). */
export function missingGenerationVolumes(
  generations: Readonly<Record<string, number>>,
  relevantVolumes: ReadonlySet<string>,
): string[] {
  const raw = new Set(Object.keys(generations).map(rawVolumeOfKey));
  return [...relevantVolumes].filter((volume) => !raw.has(volume));
}

export function rawVolumeOfKey(key: string): string {
  const bar = key.indexOf('|');
  return bar < 0 ? key : key.slice(0, bar);
}

/**
 * Scope-relevant mounted volumes (invariants 5 + 7): all mounted volumes
 * under "All folders" (roots null); under a dirs selection, only mounted
 * volumes some root names. Order follows `mounted`.
 */
export function scopeRelevantVolumes(
  mounted: readonly string[],
  roots: readonly SourceRoot[] | null,
): string[] {
  if (roots === null) return [...mounted];
  return mounted.filter((volume) => roots.some((root) => root.volume === volume));
}

/**
 * Restrict a generation map to the given raw volumes — the fingerprint's
 * input (invariant 7) and the slice of the current map a pass may compare
 * and store. Keys whose volume is not listed are dropped.
 */
export function filterGenerationsToVolumes(
  generations: Readonly<Record<string, number>>,
  volumes: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, generation] of Object.entries(generations)) {
    if (volumes.has(rawVolumeOfKey(key))) out[key] = generation;
  }
  return out;
}

/**
 * Merge this pass's observed generations over the stored baselines
 * (invariant 2): a stored entry survives unless its RAW VOLUME appears in
 * `current` (same volume, possibly a new provider-version key — current
 * wins per volume, not per key, or a provider rebuild would leave a stale
 * twin behind). Entries for unmounted or out-of-scope volumes are
 * retained untouched — remount resumes from them (invariant 4), and
 * phase 4's "Forget this card" is the designed exit for dead ones.
 */
export function mergeGenerationBaselines(
  stored: Readonly<Record<string, number>> | null,
  current: Readonly<Record<string, number>>,
): Record<string, number> {
  const currentVolumes = new Set(Object.keys(current).map(rawVolumeOfKey));
  const out: Record<string, number> = {};
  for (const [key, generation] of Object.entries(stored ?? {})) {
    if (!currentVolumes.has(rawVolumeOfKey(key))) out[key] = generation;
  }
  return { ...out, ...current };
}

/** One volume's pre-pass tripwire inputs (invariant 1). */
export interface VolumeCountRow {
  /** MediaStore's source-scoped count for the volume, freshly read. */
  media: number;
  /** Tracked present rows for the volume under the same source scope. */
  tracked: number;
  /** Tracked rows the change set already reports as trashed — hidden
   * from the MediaStore count but still present in the DB until this
   * pass reconciles them. */
  trashedInFlight: number;
}

/**
 * Volumes whose MediaStore count fell below what the DB tracks, net of
 * in-flight trashed rows — the only evidence a permanent, trash-bypassing
 * delete leaves (invariant 1, per volume, mounted volumes only: callers
 * must not hand this an unmounted volume's row — invariant 6 forbids
 * concluding deletions there). "More" is never flagged: photos not yet
 * ingested are the delta's normal input.
 */
export function volumesWithUntracedLoss(
  counts: Readonly<Record<string, VolumeCountRow>>,
): string[] {
  return Object.entries(counts)
    .filter(([, row]) => row.media < row.tracked - row.trashedInFlight)
    .map(([volume]) => volume);
}

/**
 * Post-delta agreement (invariant 1's second half): after ingesting the
 * change set, each mounted scope-relevant volume's tracked count must
 * equal MediaStore's PASS-START count. A shortfall is a silently missed
 * addition; an excess is a missed removal — both fall back to a full
 * pass. Returns the disagreeing volumes.
 */
export function volumesDisagreeingAfterDelta(
  mediaAtStart: Readonly<Record<string, number>>,
  trackedAfter: Readonly<Record<string, number>>,
): string[] {
  return Object.keys(mediaAtStart).filter(
    (volume) => mediaAtStart[volume] !== (trackedAfter[volume] ?? 0),
  );
}

/**
 * Volumes the stored baseline has never seen (invariant 5): a card
 * inserted since the last pass has no "since" to delta from — a full
 * pass takes it in. Callers pass scope-relevant volumes only, so an
 * out-of-scope card never triggers anything.
 */
export function neverSeenVolumes(
  relevantKeys: readonly string[],
  stored: Readonly<Record<string, number>>,
): string[] {
  return relevantKeys.filter((key) => stored[key] === undefined).map(rawVolumeOfKey);
}
