/**
 * Recursive media scan over the configured media folders.
 *
 * Rules (documented in assumptions-desktop.md):
 * - Only extensions Chromium decodes natively: images .jpg/.jpeg/.png/.webp,
 *   videos .mp4/.webm/.mov (v0.4). The lists live in shared/api.ts because
 *   the protocol allowlist and the renderer's <img>/<video> routing use the
 *   same source of truth.
 * - Dot-entries (hidden files/dirs like .thumbnails) are skipped.
 * - Symlinks are skipped entirely — the media protocol refuses anything whose
 *   realpath escapes the configured folders, so following links would only
 *   produce media that later fails the containment check.
 * - Unreadable directories are logged and skipped, never fatal.
 * - Overlapping/nested folders are de-duplicated; output is sorted for
 *   determinism (shuffling happens later).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, mediaKindFromPath } from '../shared/api';

export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS };

export function isImageFile(filePath: string): boolean {
  return mediaKindFromPath(filePath) === 'photo';
}

export function isVideoFile(filePath: string): boolean {
  return mediaKindFromPath(filePath) === 'video';
}

/** Anything the slideshow can display: image or video. */
export function isMediaFile(filePath: string): boolean {
  return mediaKindFromPath(filePath) !== null;
}

export interface ScanOptions {
  /** Called for directories that could not be read. Defaults to no-op. */
  onError?: (dir: string, err: unknown) => void;
}

/** Recursively collect absolute paths of all displayable media under `folders`. */
export async function scanMedia(folders: readonly string[], opts: ScanOptions = {}): Promise<string[]> {
  const found = new Set<string>();
  const visitedDirs = new Set<string>();

  async function walk(dir: string): Promise<void> {
    const abs = path.resolve(dir);
    if (visitedDirs.has(abs)) return;
    visitedDirs.add(abs);

    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      opts.onError?.(abs, err);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        found.add(full);
      }
    }
  }

  for (const folder of folders) {
    await walk(folder);
  }
  return [...found].sort();
}
