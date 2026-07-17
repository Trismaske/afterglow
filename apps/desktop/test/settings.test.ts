import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SETTINGS,
  MAX_CLUSTER_CAP,
  MAX_MOMENT_GAP_MINUTES,
  MAX_SLIDE_SECONDS,
  MIN_CLUSTER_CAP,
  MIN_MOMENT_GAP_MINUTES,
  MIN_SLIDE_SECONDS,
  SETTINGS_FILENAME,
  applySettingsPatch,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from '../src/main/settings';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'afterglow-settings-test-'));
}

describe('normalizeSettings', () => {
  it('returns defaults for garbage input', () => {
    for (const raw of [null, undefined, 42, 'hi', [], { mediaFolders: 'nope' }]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid folders, drops non-strings and duplicates', () => {
    const s = normalizeSettings({
      mediaFolders: ['/a', 7, '', '/b', '/a'],
      slideDurationSeconds: 12,
    });
    expect(s.mediaFolders).toEqual(['/a', '/b']);
    expect(s.slideDurationSeconds).toBe(12);
  });

  it('accepts only booleans for overlayEnabled, defaulting to true', () => {
    expect(normalizeSettings({ overlayEnabled: false }).overlayEnabled).toBe(false);
    expect(normalizeSettings({ overlayEnabled: true }).overlayEnabled).toBe(true);
    expect(normalizeSettings({}).overlayEnabled).toBe(true);
    expect(normalizeSettings({ overlayEnabled: 'yes' }).overlayEnabled).toBe(true);
    expect(normalizeSettings({ overlayEnabled: 0 }).overlayEnabled).toBe(true);
  });

  it('accepts only valid order modes, defaulting to smart', () => {
    expect(normalizeSettings({ orderMode: 'shuffle' }).orderMode).toBe('shuffle');
    expect(normalizeSettings({ orderMode: 'smart' }).orderMode).toBe('smart');
    expect(normalizeSettings({ orderMode: 'chaos' }).orderMode).toBe('smart');
    expect(normalizeSettings({}).orderMode).toBe('smart');
  });

  it('clamps and rounds momentGapMinutes and clusterCap', () => {
    expect(normalizeSettings({ momentGapMinutes: 0 }).momentGapMinutes).toBe(MIN_MOMENT_GAP_MINUTES);
    expect(normalizeSettings({ momentGapMinutes: 1e6 }).momentGapMinutes).toBe(MAX_MOMENT_GAP_MINUTES);
    expect(normalizeSettings({ momentGapMinutes: 4.6 }).momentGapMinutes).toBe(5);
    expect(normalizeSettings({ momentGapMinutes: 'x' }).momentGapMinutes).toBe(DEFAULT_SETTINGS.momentGapMinutes);
    expect(normalizeSettings({ clusterCap: 0 }).clusterCap).toBe(MIN_CLUSTER_CAP);
    expect(normalizeSettings({ clusterCap: 9999 }).clusterCap).toBe(MAX_CLUSTER_CAP);
    expect(normalizeSettings({ clusterCap: NaN }).clusterCap).toBe(DEFAULT_SETTINGS.clusterCap);
  });

  it('clamps slide duration and rejects non-finite values', () => {
    expect(normalizeSettings({ slideDurationSeconds: 0 }).slideDurationSeconds).toBe(MIN_SLIDE_SECONDS);
    expect(normalizeSettings({ slideDurationSeconds: 1e9 }).slideDurationSeconds).toBe(MAX_SLIDE_SECONDS);
    expect(normalizeSettings({ slideDurationSeconds: NaN }).slideDurationSeconds).toBe(
      DEFAULT_SETTINGS.slideDurationSeconds,
    );
    expect(normalizeSettings({ slideDurationSeconds: '9' }).slideDurationSeconds).toBe(
      DEFAULT_SETTINGS.slideDurationSeconds,
    );
  });
});

describe('applySettingsPatch', () => {
  it('applies whitelisted fields and revalidates', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      slideDurationSeconds: 20,
      orderMode: 'shuffle',
      momentGapMinutes: 10,
      clusterCap: 5,
    });
    expect(next).toEqual({
      ...DEFAULT_SETTINGS,
      slideDurationSeconds: 20,
      orderMode: 'shuffle',
      momentGapMinutes: 10,
      clusterCap: 5,
    });
  });

  it('never lets a patch touch mediaFolders', () => {
    const current = { ...DEFAULT_SETTINGS, mediaFolders: ['/photos'] };
    const next = applySettingsPatch(current, { mediaFolders: ['/evil'], clusterCap: 4 } as unknown);
    expect(next.mediaFolders).toEqual(['/photos']);
    expect(next.clusterCap).toBe(4);
  });

  it('ignores garbage patches and clamps bad values', () => {
    const current = { ...DEFAULT_SETTINGS, slideDurationSeconds: 15 };
    expect(applySettingsPatch(current, null)).toEqual(current);
    expect(applySettingsPatch(current, 'nope')).toEqual(current);
    expect(applySettingsPatch(current, { clusterCap: -3 }).clusterCap).toBe(MIN_CLUSTER_CAP);
    // untouched fields survive a partial patch
    expect(applySettingsPatch(current, { clusterCap: 4 }).slideDurationSeconds).toBe(15);
  });
});

describe('loadSettings / saveSettings', () => {
  it('round-trips through disk', async () => {
    const dir = await tmpDir();
    const settings = {
      mediaFolders: ['/photos/one', '/photos/two'],
      slideDurationSeconds: 15,
      overlayEnabled: false,
      orderMode: 'shuffle' as const,
      momentGapMinutes: 7,
      clusterCap: 12,
    };
    await saveSettings(dir, settings);
    expect(await loadSettings(dir)).toEqual(settings);
  });

  it('returns defaults when the file is missing', async () => {
    const dir = await tmpDir();
    expect(await loadSettings(path.join(dir, 'nope'))).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when the file is corrupt', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, SETTINGS_FILENAME), '{not json!!', 'utf8');
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });

  it('writes atomically: no temp files left behind, target always valid', async () => {
    const dir = await tmpDir();
    await saveSettings(dir, { ...DEFAULT_SETTINGS, mediaFolders: ['/a'] });
    await saveSettings(dir, { ...DEFAULT_SETTINGS, mediaFolders: ['/b'], slideDurationSeconds: 10 });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([SETTINGS_FILENAME]);
    expect((await loadSettings(dir)).mediaFolders).toEqual(['/b']);
  });

  it('creates the directory if needed', async () => {
    const dir = path.join(await tmpDir(), 'nested', 'deeper');
    await saveSettings(dir, { ...DEFAULT_SETTINGS });
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });
});
