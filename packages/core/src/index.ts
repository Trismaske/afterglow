/**
 * @afterglow/core — shared, pure-TypeScript intelligence for Afterglow
 * Desktop and Afterglow Companion.
 *
 * No filesystem or platform APIs live here. Both apps feed MediaItem[]
 * through their own adapters.
 */

/** A single photo or video, as seen by the core logic. */
export interface MediaItem {
  /** Stable identifier (file path on desktop, MediaStore id on Android). */
  id: string;
  /** Capture time in ms since epoch (EXIF DateTimeOriginal, or mtime fallback). */
  timestamp: number;
  /** Path or content URI — opaque to core. */
  uri: string;
  kind: 'photo' | 'video';
}
