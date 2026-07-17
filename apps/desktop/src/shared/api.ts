/**
 * Shared contract between main, preload and renderer.
 *
 * Pure types + tiny pure helpers only — this file is imported from all three
 * bundles, so it must not touch Electron or Node APIs.
 */

/** Persisted app settings (JSON in app.getPath('userData')/settings.json). */
export interface Settings {
  /** Absolute paths of folders to scan (recursively) for images. */
  mediaFolders: string[];
  /** How long each slide stays up, in seconds. */
  slideDurationSeconds: number;
}

/** IPC channel names, single source of truth. */
export const CHANNELS = {
  getSettings: 'afterglow:get-settings',
  chooseFolders: 'afterglow:choose-folders',
  getPlaylist: 'afterglow:get-playlist',
  exit: 'afterglow:exit',
  rendererReady: 'afterglow:renderer-ready',
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
