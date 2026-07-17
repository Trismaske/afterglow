/**
 * Settings persistence: JSON at <userData>/settings.json, written atomically
 * (temp file + rename) so a crash mid-write can never corrupt the file.
 *
 * All functions take the directory explicitly so tests can point them at a
 * temp dir; the main process passes app.getPath('userData').
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Settings, SettingsPatch } from '../shared/api';

export const SETTINGS_FILENAME = 'settings.json';

export const MIN_SLIDE_SECONDS = 2;
export const MAX_SLIDE_SECONDS = 3600;
export const MIN_MOMENT_GAP_MINUTES = 1;
export const MAX_MOMENT_GAP_MINUTES = 720;
export const MIN_CLUSTER_CAP = 2;
export const MAX_CLUSTER_CAP = 100;
export const MIN_VIDEO_MAX_SECONDS = 2;
export const MAX_VIDEO_MAX_SECONDS = 600;
/** videoMaxSeconds sentinel: 0 = play every video to its natural end (v0.5). */
export const VIDEO_FULL_LENGTH = 0;

export const DEFAULT_SETTINGS: Settings = {
  mediaFolders: [],
  slideDurationSeconds: 8,
  overlayEnabled: true,
  orderMode: 'smart',
  momentGapMinutes: 3,
  clusterCap: 8,
  videoMaxSeconds: 30,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

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
    orderMode: DEFAULT_SETTINGS.orderMode,
    momentGapMinutes: DEFAULT_SETTINGS.momentGapMinutes,
    clusterCap: DEFAULT_SETTINGS.clusterCap,
    videoMaxSeconds: DEFAULT_SETTINGS.videoMaxSeconds,
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

  if (obj.orderMode === 'shuffle' || obj.orderMode === 'smart') {
    out.orderMode = obj.orderMode;
  }
  out.momentGapMinutes = clampInt(
    obj.momentGapMinutes,
    MIN_MOMENT_GAP_MINUTES,
    MAX_MOMENT_GAP_MINUTES,
    DEFAULT_SETTINGS.momentGapMinutes,
  );
  out.clusterCap = clampInt(obj.clusterCap, MIN_CLUSTER_CAP, MAX_CLUSTER_CAP, DEFAULT_SETTINGS.clusterCap);
  // v0.5: an explicit 0 means "play videos full length" (no cap). Everything
  // else clamps to 2–600 as before; non-numeric input falls back to the
  // default, so a blank field can never silently become "uncapped".
  const vm = obj.videoMaxSeconds;
  if (typeof vm === 'number' && Number.isFinite(vm) && Math.round(vm) === 0) {
    out.videoMaxSeconds = VIDEO_FULL_LENGTH;
  } else {
    out.videoMaxSeconds = clampInt(vm, MIN_VIDEO_MAX_SECONDS, MAX_VIDEO_MAX_SECONDS, DEFAULT_SETTINGS.videoMaxSeconds);
  }
  return out;
}

/**
 * Apply a renderer-supplied patch (untrusted) to the current settings.
 * Only whitelisted fields transfer; everything is re-validated by
 * {@link normalizeSettings}, so bad values clamp or fall back rather than
 * corrupting the persisted state.
 */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) return current;
  const p = patch as SettingsPatch;
  return normalizeSettings({
    ...current,
    ...(p.slideDurationSeconds !== undefined && { slideDurationSeconds: p.slideDurationSeconds }),
    ...(p.overlayEnabled !== undefined && { overlayEnabled: p.overlayEnabled }),
    ...(p.orderMode !== undefined && { orderMode: p.orderMode }),
    ...(p.momentGapMinutes !== undefined && { momentGapMinutes: p.momentGapMinutes }),
    ...(p.clusterCap !== undefined && { clusterCap: p.clusterCap }),
    ...(p.videoMaxSeconds !== undefined && { videoMaxSeconds: p.videoMaxSeconds }),
  });
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
