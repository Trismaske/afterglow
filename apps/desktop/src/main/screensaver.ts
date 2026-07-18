/**
 * Windows screensaver registration (v0.5).
 *
 * The NSIS installer copies the installed app exe to `Afterglow.scr` in the
 * install directory (a renamed Electron exe is a valid .scr — Windows just
 * launches it with `/s`, which main's launch-mode parsing handles). This
 * module registers/deregisters that .scr as the user's default screensaver
 * via the per-user registry values Windows actually reads:
 *
 *   HKCU\Control Panel\Desktop  SCRNSAVE.EXE      = <path to .scr>
 *   HKCU\Control Panel\Desktop  ScreenSaveActive  = 1
 *
 * Everything shells out to `reg.exe` via execFile (argument vector, never a
 * shell string), and every path is written/read verbatim — no elevation
 * needed, HKCU is user-writable. On non-Windows platforms every call
 * degrades to an "unsupported" status; the settings UI is hidden there.
 *
 * Untestable on this dev machine (Linux) — the registry parsing is kept as
 * a pure function with unit tests, the rest is defensive.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ScreensaverResult, ScreensaverStatus } from '../shared/api';

export const SCR_BASENAME = 'Afterglow.scr';
const DESKTOP_KEY = 'HKCU\\Control Panel\\Desktop';
const SCRNSAVE_VALUE = 'SCRNSAVE.EXE';

/** The .scr the installer placed: next to the running exe. */
export function scrPath(execPath: string = process.execPath): string {
  return path.join(path.dirname(execPath), SCR_BASENAME);
}

/**
 * Pull a REG_SZ value out of `reg query` output. Lines look like
 * `    SCRNSAVE.EXE    REG_SZ    C:\path with spaces\Afterglow.scr`;
 * REG_EXPAND_SZ is accepted too. Returns null when the value isn't there
 * (reg.exe also exits 1 then, but parsing defensively costs nothing).
 */
export function parseRegSz(stdout: string, valueName: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith(valueName.toUpperCase())) continue;
    const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

/** Case-insensitive path equality (Windows filesystems are case-insensitive). */
export function isSameWindowsPath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

interface RegResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run reg.exe; never throws — a missing value is exit code 1, not an error. */
function reg(args: readonly string[]): Promise<RegResult> {
  return new Promise((resolve) => {
    execFile('reg.exe', [...args], { windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (((err as { code?: unknown }).code as number | undefined) ?? 1) : 0;
      resolve({
        code: typeof code === 'number' ? code : 1,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

const UNSUPPORTED: ScreensaverStatus = {
  supported: false,
  scrPresent: false,
  registered: 'none',
  currentPath: null,
};

export async function getScreensaverStatus(): Promise<ScreensaverStatus> {
  if (process.platform !== 'win32') return { ...UNSUPPORTED };
  const scr = scrPath();
  let scrPresent = false;
  try {
    await fs.access(scr);
    scrPresent = true;
  } catch {
    // unpackaged run, or the installer didn't place the .scr
  }
  const query = await reg(['query', DESKTOP_KEY, '/v', SCRNSAVE_VALUE]);
  const currentPath = query.code === 0 ? parseRegSz(query.stdout, SCRNSAVE_VALUE) : null;
  const registered =
    currentPath === null ? 'none' : isSameWindowsPath(currentPath, scr) ? 'self' : 'other';
  return { supported: true, scrPresent, registered, currentPath };
}

/** Set Afterglow.scr as the default screensaver and switch saving on. */
export async function registerScreensaver(): Promise<ScreensaverResult> {
  const status = await getScreensaverStatus();
  if (!status.supported) {
    return { status, error: 'Screensaver integration is only available on Windows.' };
  }
  if (!status.scrPresent) {
    return {
      status,
      error: `${SCR_BASENAME} was not found next to the app — install Afterglow with the installer to use it as a screensaver.`,
    };
  }
  const add = await reg([
    'add',
    DESKTOP_KEY,
    '/v',
    SCRNSAVE_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    scrPath(),
    '/f',
  ]);
  if (add.code !== 0) {
    return {
      status,
      error: `Could not write the registry: ${add.stderr.trim() || `reg.exe exited ${add.code}`}`,
    };
  }
  // Make sure the screensaver machinery is on at all (harmless if already 1).
  await reg(['add', DESKTOP_KEY, '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '1', '/f']);
  return { status: await getScreensaverStatus(), error: null };
}

/** Remove the registration — but never touch someone else's screensaver. */
export async function unregisterScreensaver(): Promise<ScreensaverResult> {
  const status = await getScreensaverStatus();
  if (!status.supported || status.registered !== 'self') {
    return { status, error: null }; // nothing of ours to remove
  }
  const del = await reg(['delete', DESKTOP_KEY, '/v', SCRNSAVE_VALUE, '/f']);
  if (del.code !== 0) {
    return {
      status,
      error: `Could not update the registry: ${del.stderr.trim() || `reg.exe exited ${del.code}`}`,
    };
  }
  return { status: await getScreensaverStatus(), error: null };
}
