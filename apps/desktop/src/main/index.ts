/**
 * Afterglow Desktop — main process.
 *
 * Security model (non-negotiable): contextIsolation on, sandbox on,
 * nodeIntegration off, a minimal typed preload API, and media served through
 * a custom afterglow:// protocol that realpath-resolves every request and
 * refuses anything outside the configured media folders.
 */

import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { shuffled } from '@afterglow/core';
import { CHANNELS, MEDIA_HOST, MEDIA_SCHEME, toMediaUrl, type Settings } from '../shared/api';
import { isInsideAny } from './containment';
import { isImageFile, scanImages } from './scan';
import { loadSettings, saveSettings } from './settings';

const SMOKE = process.argv.includes('--smoke');
/** In smoke mode auto-quit after this long if all went well. */
const SMOKE_OK_MS = 3000;
/** ...and give up entirely after this long if the renderer never came up. */
const SMOKE_TIMEOUT_MS = 10_000;

// Smoke runs must be hermetic: never read or write the user's real settings.
if (SMOKE) {
  app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'afterglow-smoke-')));
}

// Must be registered before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let settings: Settings = { mediaFolders: [], slideDurationSeconds: 8 };
/** realpath()ed media folders — the containment allowlist for the protocol. */
let mediaRootsReal: string[] = [];
let mainWindow: BrowserWindow | null = null;

async function refreshMediaRoots(): Promise<void> {
  const roots: string[] = [];
  for (const folder of settings.mediaFolders) {
    try {
      roots.push(await fs.realpath(folder));
    } catch (err) {
      console.warn(`[afterglow] media folder unavailable, skipping: ${folder}`, err);
    }
  }
  mediaRootsReal = roots;
}

/**
 * afterglow://media/<encodeURIComponent(absolute path)> → file contents.
 * Refuses: non-media hosts, non-image extensions, unresolvable paths, and
 * anything whose realpath is not inside a configured media folder.
 */
async function handleMediaRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.hostname !== MEDIA_HOST) return new Response('not found', { status: 404 });
    const encoded = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    const filePath = decodeURIComponent(encoded);
    if (!path.isAbsolute(filePath) || !isImageFile(filePath)) {
      return new Response('forbidden', { status: 403 });
    }
    const real = await fs.realpath(filePath);
    if (!isInsideAny(real, mediaRootsReal)) {
      console.warn(`[afterglow] refused media request outside library: ${filePath}`);
      return new Response('forbidden', { status: 403 });
    }
    return await net.fetch(pathToFileURL(real).toString());
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getSettings, (): Settings => settings);

  ipcMain.handle(CHANNELS.chooseFolders, async (): Promise<Settings | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose photo folders',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    settings = { ...settings, mediaFolders: result.filePaths };
    await saveSettings(app.getPath('userData'), settings);
    await refreshMediaRoots();
    return settings;
  });

  ipcMain.handle(CHANNELS.getPlaylist, async (): Promise<string[]> => {
    await refreshMediaRoots();
    const files = await scanImages(settings.mediaFolders, {
      onError: (dir, err) => console.warn(`[afterglow] cannot read directory ${dir}`, err),
    });
    return shuffled(files, Math.random).map(toMediaUrl);
  });

  ipcMain.on(CHANNELS.exit, (_event, reason: unknown) => {
    console.log(`[afterglow] exit requested by renderer: ${String(reason)}`);
    app.quit();
  });

  // rendererReady is consumed by the smoke harness; a no-op listener keeps
  // normal runs quiet.
  ipcMain.on(CHANNELS.rendererReady, () => {});
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

/**
 * --smoke: start, load the renderer, and exit 0 within ~3s if the renderer
 * signalled ready with no console errors or load failures; exit 1 otherwise.
 */
function armSmokeHarness(win: BrowserWindow): void {
  let rendererReady = false;
  let failure: string | null = null;

  ipcMain.on(CHANNELS.rendererReady, () => {
    rendererReady = true;
  });

  // Electron ≥32 passes a structured event object (level/message fields).
  win.webContents.on('console-message', (event: { level?: string; message?: string }) => {
    const level = typeof event?.level === 'string' ? event.level : 'other';
    const message = typeof event?.message === 'string' ? event.message : '';
    console.log(`[renderer:${level}] ${message}`);
    if (level === 'error') failure = failure ?? `renderer console error: ${message}`;
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    failure = failure ?? `did-fail-load: ${code} ${desc}`;
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    failure = failure ?? `render-process-gone: ${details.reason}`;
  });

  const finish = (): void => {
    if (failure) {
      console.error(`[smoke] FAIL: ${failure}`);
      app.exit(1);
    } else if (!rendererReady) {
      console.error('[smoke] FAIL: renderer never signalled ready');
      app.exit(1);
    } else {
      console.log('[smoke] OK: renderer loaded cleanly');
      app.exit(0);
    }
  };
  setTimeout(finish, SMOKE_OK_MS);
  // Hard backstop in case the first timer never fires (hung startup).
  const backstop = setTimeout(() => {
    console.error('[smoke] FAIL: timed out');
    app.exit(1);
  }, SMOKE_TIMEOUT_MS);
  backstop.unref?.();
}

// Basic hardening: this app never navigates or opens windows.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(async () => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest);
  settings = await loadSettings(app.getPath('userData'));
  // Smoke runs can point at a fixture folder to exercise the full
  // scan → protocol → crossfade path headlessly.
  if (SMOKE && process.env.AFTERGLOW_SMOKE_MEDIA) {
    settings = { ...settings, mediaFolders: [process.env.AFTERGLOW_SMOKE_MEDIA] };
  }
  await refreshMediaRoots();
  registerIpc();
  mainWindow = createWindow();
  if (SMOKE) armSmokeHarness(mainWindow);
});
