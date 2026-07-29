/**
 * Shared types for @afterglow/core.
 *
 * Pure data shapes only — no platform APIs. Both apps map their native
 * media representations (file paths, MediaStore rows) into these.
 */

/** Media kinds core understands. */
export type MediaKind = 'photo' | 'video';

/** A single photo or video, as seen by the core logic. */
export interface MediaItem {
  /** Stable identifier (file path on desktop, MediaStore id on Android). */
  id: string;
  /** Capture time in ms since epoch (EXIF DateTimeOriginal, or mtime fallback). */
  timestamp: number;
  /** Path or content URI — opaque to core. */
  uri: string;
  kind: MediaKind;
}

/**
 * A time-proximate group of media items.
 * `items` is always sorted ascending by timestamp.
 */
export interface Cluster {
  /** Deterministic id derived from the first item (stable across re-clustering). */
  id: string;
  items: MediaItem[];
  /** Timestamp of the first item. */
  start: number;
  /** Timestamp of the last item. */
  end: number;
}

/**
 * A photo's VERDICT — layer 1 of the three-layer state model
 * (docs/STATE_MODEL.md). One per photo, mutually exclusive:
 *
 * ```
 * unreviewed ──review──┬─▶ culled ─▶ trashed   (staged, then executed)
 *                      └─▶ kept
 * ```
 *
 * m0.8.2 shrank this list from six to four. `to_edit` left because a
 * photo flagged for editing is simply KEPT with a pending edit — an
 * action, not a verdict — and `done` was renamed `kept` so the verb on
 * the button and the value in the column are finally the same word.
 * `confirmed` left because nothing ever wrote it.
 *
 * Pending actions (edit, favourite, organize, share) and annotations
 * (grouped, time-attached, best) are separate layers and never appear
 * here.
 */
export const PHOTO_STATES = ['unreviewed', 'kept', 'culled', 'trashed'] as const;
export type PhotoState = (typeof PHOTO_STATES)[number];

/** One compare outcome (m0.1+ duel history — mined by later features).
 * `keptBoth` carries the DIALOG outcome: true = Keep both, false = the
 * loser was culled, null = a verdict-free TRIAGE duel (3+ alive — star
 * and history only). Stats' "kept both %" reads over non-null rows, or
 * every burst triage would count as a keep-both decision (m0.8.2). */
export interface DuelRecord {
  groupId: string;
  winnerId: string;
  loserId: string;
  keptBoth: boolean | null;
  /** Injected decision time, ms since epoch. */
  at: number;
}

/**
 * Desktop flag-to-queue types (keys D/E/M/R/N/T while the slideshow runs).
 * `rename` = needs renaming, `date` = needs its date fixed (both v0.5).
 */
export const FLAG_TYPES = ['delete', 'edit', 'move', 'review', 'rename', 'date'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

/**
 * Injected random source: returns a float in [0, 1).
 * Core never calls Math.random() itself — pass `Math.random` from the app,
 * or a seeded rng (see {@link mulberry32}) for deterministic behavior.
 */
export type Rng = () => number;
