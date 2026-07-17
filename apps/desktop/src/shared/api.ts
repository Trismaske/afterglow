/**
 * Shared contract between main, preload and renderer.
 *
 * Pure types + tiny pure helpers only — this file is imported from all three
 * bundles, so it must not touch Electron or Node APIs. (@afterglow/core is
 * pure TS, so its types are fine here.)
 */

import type { FlagType, MediaKind } from '@afterglow/core';

export type { MediaKind };

/** How the slideshow orders photos (v0.3 story engine). */
export type OrderMode = 'shuffle' | 'smart';

/**
 * The honest media format lists (v0.4). Images are what Chromium decodes
 * natively; videos are containers Chromium can *usually* decode (a .mov with
 * a codec Chromium lacks — HEVC, ProRes — loads with an error and the show
 * skips it gracefully). Deliberately absent: AVI/MKV (never claimed), HEIC
 * (no desktop decoder yet), GIF (later).
 *
 * These live in the shared module (pure, no Node APIs) because renderer,
 * preload and main all route on them: the scanner collects these extensions,
 * the afterglow:// protocol allowlists them, and the slideshow picks
 * <img> vs <video> per item.
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'] as const;

/** Lowercased ".ext" of a path/file name, or null (pure, no node:path). */
function extnameLower(filePath: string): string | null {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match ? match[0].toLowerCase() : null;
}

/** 'photo' | 'video' for a file path, or null if it isn't displayable media. */
export function mediaKindFromPath(filePath: string): MediaKind | null {
  const ext = extnameLower(filePath);
  if (ext === null) return null;
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'photo';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  return null;
}

/** Kind for an afterglow://media/... URL, or null for foreign/non-media URLs. */
export function mediaKindFromUrl(url: string): MediaKind | null {
  const filePath = fromMediaUrl(url);
  return filePath === null ? null : mediaKindFromPath(filePath);
}

/** Persisted app settings (JSON in app.getPath('userData')/settings.json). */
export interface Settings {
  /** Absolute paths of folders to scan (recursively) for images. */
  mediaFolders: string[];
  /** How long each slide stays up, in seconds. */
  slideDurationSeconds: number;
  /** Whether the path/date overlay is shown (toggle with O during the show). */
  overlayEnabled: boolean;
  /**
   * 'smart' = moments clusters + mix engine once the EXIF index is ready
   * (the show always starts in shuffle and hot-swaps); 'shuffle' = v0.1
   * behavior forever.
   */
  orderMode: OrderMode;
  /** Max silence between shots that still counts as one "moment" (minutes). */
  momentGapMinutes: number;
  /** Max photos played per cluster run (evenly sampled when over). */
  clusterCap: number;
  /**
   * Per-video duration cap in seconds (v0.4). A video slide advances at the
   * video's natural end or after this many seconds, whichever comes first.
   */
  videoMaxSeconds: number;
}

/**
 * User-editable settings fields (settings screen → main). Folders change
 * through the chooseFolders dialog, so they are not patchable here.
 */
export interface SettingsPatch {
  slideDurationSeconds?: number;
  overlayEnabled?: boolean;
  orderMode?: OrderMode;
  momentGapMinutes?: number;
  clusterCap?: number;
  videoMaxSeconds?: number;
}

/** One indexed photo/video, pushed to the renderer when the index is ready. */
export interface LibraryItem {
  /** afterglow://media/... URL (same encoding as playlist entries). */
  url: string;
  /**
   * Best-known capture time in ms since epoch: EXIF DateTimeOriginal (or
   * CreateDate), falling back to file mtime (always mtime for videos).
   * Timezone-naive local time.
   */
  timestampMs: number;
  /** 'photo' or 'video' — the slideshow picks <img> vs <video> on this. */
  kind: MediaKind;
}

/** Metadata for the overlay: where the current photo lives and when it was taken. */
export interface ItemInfo {
  /** Absolute file path (as encoded in the media URL). */
  path: string;
  /** EXIF capture time (DateTimeOriginal/CreateDate), ms since epoch, or null. */
  captureDateMs: number | null;
  /** File mtime, ms since epoch, or null if the file could not be stat'ed. */
  fileDateMs: number | null;
}

/** One flagged photo, as shown in the queue window. */
export interface QueueEntry {
  path: string;
  flagType: FlagType;
  /** When the flag was captured, ms since epoch. */
  at: number;
}

/** IPC channel names, single source of truth. */
export const CHANNELS = {
  getSettings: 'afterglow:get-settings',
  chooseFolders: 'afterglow:choose-folders',
  getPlaylist: 'afterglow:get-playlist',
  exit: 'afterglow:exit',
  rendererReady: 'afterglow:renderer-ready',
  // v0.3 — story engine
  updateSettings: 'afterglow:update-settings',
  /** main → slideshow renderer: EXIF index built/refreshed (LibraryItem[]). */
  indexReady: 'afterglow:index-ready',
  // v0.2 — overlay + flag capture
  getItemInfo: 'afterglow:get-item-info',
  setOverlayEnabled: 'afterglow:set-overlay-enabled',
  flagAdd: 'afterglow:flag-add',
  flagRemove: 'afterglow:flag-remove',
  openQueue: 'afterglow:open-queue',
  /** main → slideshow renderer: queue window opened/closed (boolean). */
  queueState: 'afterglow:queue-state',
  // v0.2 — queue window (its own preload)
  queueList: 'afterglow:queue-list',
  queueRemove: 'afterglow:queue-remove',
  queueReveal: 'afterglow:queue-reveal',
  queueOpen: 'afterglow:queue-open',
  queueClose: 'afterglow:queue-close',
  /** main → queue renderer: the flag queue changed (QueueEntry[]). */
  queueChanged: 'afterglow:queue-changed',
} as const;

/**
 * The minimal typed API the preload exposes as `window.afterglow`.
 * Keep this surface as small as possible — it is the security boundary.
 */
export interface AfterglowApi {
  getSettings(): Promise<Settings>;
  /**
   * Opens the OS folder picker (openDirectory + multiSelections), persists
   * the chosen folders and returns the new settings, or null if cancelled.
   */
  chooseFolders(): Promise<Settings | null>;
  /** Shuffled list of afterglow://media/... URLs for every image found. */
  getPlaylist(): Promise<string[]>;
  /** Ask the main process to quit (the ONE exit path from the renderer). */
  exit(reason: string): void;
  /** Renderer reached a stable state (slideshow / first-run / message). */
  rendererReady(): void;
  /** Path + dates for a media URL; null if it isn't a library image. */
  getItemInfo(url: string): Promise<ItemInfo | null>;
  /** Persist user-editable settings fields; returns the updated settings. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /**
   * Subscribe to EXIF-index completion. Fires after every scan once the
   * background indexer finishes (fast when the index was already on disk).
   */
  onIndexReady(cb: (items: LibraryItem[]) => void): void;
  /** Persist the overlay toggle; returns the updated settings. */
  setOverlayEnabled(enabled: boolean): Promise<Settings>;
  /** Flag the photo behind a media URL. True if newly added, false if it was already flagged. */
  addFlag(url: string, flagType: FlagType): Promise<boolean>;
  /** Un-flag. True if an entry was removed. */
  removeFlag(url: string, flagType: FlagType): Promise<boolean>;
  /** Open (or focus) the flag-queue window. The slideshow keeps running. */
  openQueue(): void;
  /** Subscribe to queue-window open/close (exit arbiter pauses while open). */
  onQueueState(cb: (open: boolean) => void): void;
}

/** The API the queue window's preload exposes as `window.afterglowQueue`. */
export interface AfterglowQueueApi {
  /** Current queue entries, oldest first. */
  list(): Promise<QueueEntry[]>;
  /** Remove one entry; resolves to the updated queue. */
  remove(path: string, flagType: FlagType): Promise<QueueEntry[]>;
  /** Reveal the file in the OS file manager. */
  reveal(path: string): Promise<void>;
  /** Open the file with the OS default app. Resolves to '' or an error message. */
  open(path: string): Promise<string>;
  /** Close the queue window. */
  close(): void;
  /** Subscribe to queue changes pushed from the main process. */
  onChanged(cb: (entries: QueueEntry[]) => void): void;
}

export const MEDIA_SCHEME = 'afterglow';
export const MEDIA_HOST = 'media';

/** Build the custom-protocol URL for an absolute file path. */
export function toMediaUrl(absolutePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(absolutePath)}`;
}

/** Inverse of {@link toMediaUrl}. Returns null for anything else. */
export function fromMediaUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;
  const encoded = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
