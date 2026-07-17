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
 * Mobile review states (Companion state machine, PLAN.md):
 *
 * ```
 * unreviewed ──duel/single review──┬─▶ culled ─▶ confirmed ─▶ trashed
 *                                  └─▶ kept ──┬─▶ to_edit ─▶ done
 *                                             └───────────▶ done
 * ```
 *
 * `to_edit` and `done` are declared now so m0.2 can adopt them without a
 * core type change; m0.1 only produces the first five.
 */
export const PHOTO_STATES = [
  'unreviewed',
  'kept',
  'culled',
  'confirmed',
  'trashed',
  'to_edit',
  'done',
] as const;
export type PhotoState = (typeof PHOTO_STATES)[number];

/** Desktop flag-to-queue types (keys D/E/M/R while the slideshow runs). */
export const FLAG_TYPES = ['delete', 'edit', 'move', 'review'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

/**
 * Injected random source: returns a float in [0, 1).
 * Core never calls Math.random() itself — pass `Math.random` from the app,
 * or a seeded rng (see {@link mulberry32}) for deterministic behavior.
 */
export type Rng = () => number;
