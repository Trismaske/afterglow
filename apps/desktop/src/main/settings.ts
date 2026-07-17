/**
 * Settings persistence: JSON at <userData>/settings.json, written atomically
 * (temp file + rename) so a crash mid-write can never corrupt the file.
 *
 * All functions take the directory explicitly so tests can point them at a
 * temp dir; the main process passes app.getPath('userData').
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../shared/api';

export const SETTINGS_FILENAME = 'settings.json';

export const MIN_SLIDE_SECONDS = 2;
export const MAX_SLIDE_SECONDS = 3600;

export const DEFAULT_SETTINGS: Settings = {
  mediaFolders: [],
  slideDurationSeconds: 8,
  overlayEnabled: true,
};

/**
 * Coerce arbitrary parsed JSON into a valid Settings object.
 * Unknown keys are dropped, bad values fall back to defaults, the slide
 * duration is clamped to [MIN_SLIDE_SECONDS, MAX_SLIDE_SECONDS].
 */
export function normalizeSettings(raw: unknown): Settings {
  const out: Settings = {
    mediaFolders: [...DEFAULT_SETTINGS.mediaFolders],
    slideDurationSeconds: DEFAULT_SETTINGS.slideDurationSeconds,
    overlayEnabled: DEFAULT_SETTINGS.overlayEnabled,
  };
  if (typeof raw !== 'object' || raw === null) return out;
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.mediaFolders)) {
    out.mediaFolders = obj.mediaFolders
      .filter((f): f is string => typeof f === 'string' && f.length > 0)
      .filter((f, i, arr) => arr.indexOf(f) === i);
  }

  const dur = obj.slideDurationSeconds;
  if (typeof dur === 'number' && Number.isFinite(dur)) {
    out.slideDurationSeconds = Math.min(MAX_SLIDE_SECONDS, Math.max(MIN_SLIDE_SECONDS, dur));
  }

  if (typeof obj.overlayEnabled === 'boolean') {
    out.overlayEnabled = obj.overlayEnabled;
  }
  return out;
}

/** Load settings; a missing or corrupt file yields defaults (never throws). */
export async function loadSettings(dir: string): Promise<Settings> {
  try {
    const text = await fs.readFile(path.join(dir, SETTINGS_FILENAME), 'utf8');
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS, mediaFolders: [...DEFAULT_SETTINGS.mediaFolders] };
  }
}

/** Atomically persist settings (mkdir -p, write temp, rename over target). */
export async function saveSettings(dir: string, settings: Settings): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, SETTINGS_FILENAME);
  const tmp = path.join(dir, `${SETTINGS_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  const payload = JSON.stringify(normalizeSettings(settings), null, 2) + '\n';
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, target);
}
