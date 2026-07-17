import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SETTINGS,
  MAX_SLIDE_SECONDS,
  MIN_SLIDE_SECONDS,
  SETTINGS_FILENAME,
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

describe('loadSettings / saveSettings', () => {
  it('round-trips through disk', async () => {
    const dir = await tmpDir();
    const settings = { mediaFolders: ['/photos/one', '/photos/two'], slideDurationSeconds: 15 };
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
    await saveSettings(dir, { mediaFolders: ['/a'], slideDurationSeconds: 8 });
    await saveSettings(dir, { mediaFolders: ['/b'], slideDurationSeconds: 10 });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([SETTINGS_FILENAME]);
    expect((await loadSettings(dir)).mediaFolders).toEqual(['/b']);
  });

  it('creates the directory if needed', async () => {
    const dir = path.join(await tmpDir(), 'nested', 'deeper');
    await saveSettings(dir, { mediaFolders: [], slideDurationSeconds: 8 });
    expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });
});
