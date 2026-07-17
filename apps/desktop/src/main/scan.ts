/**
 * Recursive image scan over the configured media folders.
 *
 * Rules (documented in assumptions-desktop.md):
 * - Only extensions Chromium decodes natively in v0.1: .jpg/.jpeg/.png/.webp.
 * - Dot-entries (hidden files/dirs like .thumbnails) are skipped.
 * - Symlinks are skipped entirely — the media protocol refuses anything whose
 *   realpath escapes the configured folders, so following links would only
 *   produce images that later fail the containment check.
 * - Unreadable directories are logged and skipped, never fatal.
 * - Overlapping/nested folders are de-duplicated; output is sorted for
 *   determinism (shuffling happens later).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ScanOptions {
  /** Called for directories that could not be read. Defaults to no-op. */
  onError?: (dir: string, err: unknown) => void;
}

/** Recursively collect absolute paths of all images under `folders`. */
export async function scanImages(folders: readonly string[], opts: ScanOptions = {}): Promise<string[]> {
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
      } else if (entry.isFile() && isImageFile(entry.name)) {
        found.add(full);
      }
    }
  }

  for (const folder of folders) {
    await walk(folder);
  }
  return [...found].sort();
}
