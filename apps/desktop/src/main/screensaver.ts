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

/** A string registry value with its exact type, so a rollback can restore
 * it verbatim (rewriting a REG_EXPAND_SZ path as REG_SZ would stop its
 * environment variables from resolving). */
export interface RegSzValue {
  type: 'REG_SZ' | 'REG_EXPAND_SZ';
  value: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull a string value out of `reg query` output. Lines look like
 * `    SCRNSAVE.EXE    REG_SZ    C:\path with spaces\Afterglow.scr`;
 * REG_EXPAND_SZ is accepted too. The value name must match EXACTLY
 * (whole-key listings also contain e.g. `SCRNSAVE.EXE.backup` rows).
 * Returns null when the value isn't there.
 */
export function parseRegSzTyped(stdout: string, valueName: string): RegSzValue | null {
  // The data part is optional: an EMPTY string value (a valid "no
  // screensaver" state) prints as just `NAME    REG_SZ` after trimming.
  const pattern = new RegExp(
    `^${escapeRegExp(valueName)}\\s+(REG_(?:EXPAND_)?SZ)(?:\\s+(.*))?$`,
    'i',
  );
  for (const line of stdout.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (match) {
      return { type: match[1].toUpperCase() as RegSzValue['type'], value: (match[2] ?? '').trim() };
    }
  }
  return null;
}

/** The value text alone (status displays don't care about the type). */
export function parseRegSz(stdout: string, valueName: string): string | null {
  return parseRegSzTyped(stdout, valueName)?.value ?? null;
}

/** Whether a `reg query` LISTING mentions the exact value at all —
 * distinguishes "absent" from "present but not a restorable string type". */
function valueNameListed(stdout: string, valueName: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(valueName)}\\s`, 'i');
  return stdout.split(/\r?\n/).some((line) => pattern.test(line.trim()));
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
  // Capture the previous value WITH its registry type before overwriting,
  // so a half-failed registration can restore it verbatim. The whole key
  // is listed (no /v): reg.exe uses exit 1 for BOTH a missing value and
  // general failures, so only a successful listing can distinguish
  // "value absent" from "could not read". Anything unconfirmed aborts
  // before touching the registry — a rollback we could not guarantee
  // must never be needed.
  const priorQuery = await reg(['query', DESKTOP_KEY]);
  if (priorQuery.code !== 0) {
    return {
      status,
      error: `Could not read the current screensaver registration (reg.exe exited ${priorQuery.code}) — nothing was changed. Try again.`,
    };
  }
  const prior = parseRegSzTyped(priorQuery.stdout, SCRNSAVE_VALUE);
  if (prior === null && valueNameListed(priorQuery.stdout, SCRNSAVE_VALUE)) {
    // Present but not a string type we can restore verbatim — abort.
    return {
      status,
      error:
        'Could not read the current screensaver registration — nothing was changed. Try again.',
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
  // Without this value Windows never launches the configured saver, so a
  // failure here is a failed registration, not a cosmetic one.
  const activate = await reg([
    'add',
    DESKTOP_KEY,
    '/v',
    'ScreenSaveActive',
    '/t',
    'REG_SZ',
    '/d',
    '1',
    '/f',
  ]);
  if (activate.code !== 0) {
    // Best-effort rollback of the first write: a half-failed registration
    // must not leave Afterglow displacing the user's previous screensaver.
    if (prior !== null) {
      await reg([
        'add',
        DESKTOP_KEY,
        '/v',
        SCRNSAVE_VALUE,
        '/t',
        prior.type,
        '/d',
        prior.value,
        '/f',
      ]);
    } else {
      await reg(['delete', DESKTOP_KEY, '/v', SCRNSAVE_VALUE, '/f']);
    }
    return {
      status: await getScreensaverStatus(),
      error: `Could not enable the screensaver (ScreenSaveActive): ${activate.stderr.trim() || `reg.exe exited ${activate.code}`}`,
    };
  }
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
