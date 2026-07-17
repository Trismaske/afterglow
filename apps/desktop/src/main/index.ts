/**
 * Afterglow Desktop — main process.
 *
 * Security model (non-negotiable): contextIsolation on, sandbox on,
 * nodeIntegration off, a minimal typed preload API, and media served through
 * a custom afterglow:// protocol that realpath-resolves every request and
 * refuses anything outside the configured media folders.
 */

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { mkdtempSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLAG_TYPES, shuffled, type FlagType } from '@afterglow/core';
import {
  CHANNELS,
  MEDIA_HOST,
  MEDIA_SCHEME,
  fromMediaUrl,
  mediaKindFromPath,
  toMediaUrl,
  type ItemInfo,
  type LibraryItem,
  type QueueEntry,
  type Settings,
} from '../shared/api';
import { isInsideAny } from './containment';
import { openFlagStore, type FlagStore } from './flagstore';
import { buildIndex, INDEX_FILENAME, loadIndex, saveIndex } from './indexer';
import { getImageDates } from './metadata';
import { closeQueueWindow, getQueueWindow, isQueueWindow, openQueueWindow } from './queue-window';
import { isMediaFile, scanMedia } from './scan';
import { applySettingsPatch, DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from './settings';

const SMOKE = process.argv.includes('--smoke');
/**
 * In smoke mode auto-quit after this long if all went well. 4s leaves room
 * for the video smoke (AFTERGLOW_SMOKE_EXPECT_VIDEO): a ~1s fixture clip has
 * to load, play and end inside this window. AFTERGLOW_SMOKE_OK_MS (smoke
 * only) stretches the window so a mixed photo+video fixture can play a full
 * playlist epoch before the assertions run.
 */
const SMOKE_OK_MS = (() => {
  const override = Number(process.env.AFTERGLOW_SMOKE_OK_MS);
  return Number.isFinite(override) && override >= 1000 ? Math.min(override, 120_000) : 4000;
})();
/** ...and give up entirely after this long if the renderer never came up. */
const SMOKE_TIMEOUT_MS = SMOKE_OK_MS + 8000;

// Smoke runs must be hermetic: never read or write the user's real settings.
if (SMOKE) {
  app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'afterglow-smoke-')));
}

// Must be registered before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let settings: Settings = { ...DEFAULT_SETTINGS };
/** realpath()ed media folders — the containment allowlist for the protocol. */
let mediaRootsReal: string[] = [];
let mainWindow: BrowserWindow | null = null;
let flagStore: FlagStore | null = null;

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
 * Refuses: non-media hosts, non-media extensions (images + MP4/WebM/MOV
 * since v0.4), unresolvable paths, and anything whose realpath is not inside
 * a configured media folder. Request headers are forwarded so <video> range
 * requests stream instead of buffering whole files.
 */
async function handleMediaRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.hostname !== MEDIA_HOST) return new Response('not found', { status: 404 });
    const encoded = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    const filePath = decodeURIComponent(encoded);
    if (!path.isAbsolute(filePath) || !isMediaFile(filePath)) {
      return new Response('forbidden', { status: 403 });
    }
    const real = await fs.realpath(filePath);
    if (!isInsideAny(real, mediaRootsReal)) {
      console.warn(`[afterglow] refused media request outside library: ${filePath}`);
      return new Response('forbidden', { status: 403 });
    }
    return await net.fetch(pathToFileURL(real).toString(), { headers: request.headers });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

/**
 * Decode a renderer-supplied media URL and verify it points at a real media
 * file inside the configured library (same containment rules as the
 * protocol). Returns the decoded path, or null for anything suspect.
 */
async function libraryPathFromUrl(url: unknown): Promise<string | null> {
  if (typeof url !== 'string') return null;
  const filePath = fromMediaUrl(url);
  if (!filePath || !path.isAbsolute(filePath) || !isMediaFile(filePath)) return null;
  try {
    const real = await fs.realpath(filePath);
    return isInsideAny(real, mediaRootsReal) ? filePath : null;
  } catch {
    return null;
  }
}

function isFlagType(value: unknown): value is FlagType {
  return typeof value === 'string' && (FLAG_TYPES as readonly string[]).includes(value);
}

/** Queue-window open/close: tell the slideshow renderer so it can pause exit-on-input. */
function notifyQueueState(open: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CHANNELS.queueState, open);
  }
}

/** Push the current queue to the queue window (if open). */
function pushQueueChanged(entries: QueueEntry[]): void {
  getQueueWindow()?.webContents.send(CHANNELS.queueChanged, entries);
}

// ---- v0.3: background EXIF indexing ----

/**
 * Monotonic generation counter: every scan bumps it, and an in-flight build
 * from an older scan cancels itself instead of publishing stale results.
 */
let indexGeneration = 0;

const warn = (msg: string, err?: unknown): void => console.warn(`[afterglow] ${msg}`, err);

/**
 * Kick off (or restart) the background index build for a fresh scan result.
 * Never blocks the caller: the slideshow starts in shuffle order and the
 * renderer hot-swaps to smart order when `indexReady` arrives.
 */
function startIndexing(files: readonly string[]): void {
  const generation = ++indexGeneration;
  void (async () => {
    try {
      const dir = app.getPath('userData');
      const prev = await loadIndex(dir, warn);
      const entries = await buildIndex(files, prev, {
        onWarn: warn,
        isCancelled: () => generation !== indexGeneration,
      });
      if (entries === null || generation !== indexGeneration) return; // superseded
      await saveIndex(dir, entries);
      const items: LibraryItem[] = entries.map((e) => ({
        url: toMediaUrl(e.path),
        timestampMs: e.timestampMs,
        kind: mediaKindFromPath(e.path) ?? 'photo',
      }));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CHANNELS.indexReady, items);
      }
      console.log(`[afterglow] EXIF index ready (${entries.length} files)`);
    } catch (err) {
      warn('background indexing failed; staying in shuffle order', err);
    }
  })();
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
    const files = await scanMedia(settings.mediaFolders, {
      onError: (dir, err) => console.warn(`[afterglow] cannot read directory ${dir}`, err),
    });
    // v0.3: index in the background; the shuffled playlist returns immediately.
    startIndexing(files);
    return shuffled(files, Math.random).map(toMediaUrl);
  });

  ipcMain.handle(CHANNELS.updateSettings, async (_event, patch: unknown): Promise<Settings> => {
    settings = applySettingsPatch(settings, patch);
    await saveSettings(app.getPath('userData'), settings);
    return settings;
  });

  ipcMain.on(CHANNELS.exit, (_event, reason: unknown) => {
    console.log(`[afterglow] exit requested by renderer: ${String(reason)}`);
    app.quit();
  });

  // rendererReady is consumed by the smoke harness; a no-op listener keeps
  // normal runs quiet.
  ipcMain.on(CHANNELS.rendererReady, () => {});

  // ---- v0.2: overlay + flag capture ----

  ipcMain.handle(CHANNELS.getItemInfo, async (_event, url: unknown): Promise<ItemInfo | null> => {
    const filePath = await libraryPathFromUrl(url);
    if (!filePath) return null;
    const dates = await getImageDates(filePath);
    return { path: filePath, ...dates };
  });

  ipcMain.handle(CHANNELS.setOverlayEnabled, async (_event, enabled: unknown): Promise<Settings> => {
    settings = { ...settings, overlayEnabled: enabled === true };
    await saveSettings(app.getPath('userData'), settings);
    return settings;
  });

  ipcMain.handle(CHANNELS.flagAdd, async (_event, url: unknown, flagType: unknown): Promise<boolean> => {
    if (!flagStore || !isFlagType(flagType)) return false;
    const filePath = await libraryPathFromUrl(url);
    if (!filePath) return false;
    return flagStore.add({ path: filePath, flagType, at: Date.now() });
  });

  ipcMain.handle(CHANNELS.flagRemove, async (_event, url: unknown, flagType: unknown): Promise<boolean> => {
    if (!flagStore || !isFlagType(flagType)) return false;
    if (typeof url !== 'string') return false;
    const filePath = fromMediaUrl(url);
    if (!filePath) return false;
    return flagStore.remove(filePath, flagType);
  });

  ipcMain.on(CHANNELS.openQueue, () => {
    openQueueWindow(notifyQueueState);
  });

  // ---- v0.2: queue window (guarded to its own webContents) ----

  ipcMain.handle(CHANNELS.queueList, (event): QueueEntry[] => {
    if (!flagStore || !isQueueWindow(event.sender)) return [];
    return flagStore.list();
  });

  ipcMain.handle(CHANNELS.queueRemove, async (event, filePath: unknown, flagType: unknown): Promise<QueueEntry[]> => {
    if (!flagStore || !isQueueWindow(event.sender)) return [];
    if (typeof filePath === 'string' && isFlagType(flagType)) {
      await flagStore.remove(filePath, flagType);
    }
    return flagStore.list();
  });

  // shell.* only ever runs for paths currently in the flag queue, and only
  // for the queue window's own webContents.
  ipcMain.handle(CHANNELS.queueReveal, (event, filePath: unknown): void => {
    if (!flagStore || !isQueueWindow(event.sender)) return;
    if (typeof filePath !== 'string' || !flagStore.hasPath(filePath)) return;
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(CHANNELS.queueOpen, async (event, filePath: unknown): Promise<string> => {
    if (!flagStore || !isQueueWindow(event.sender)) return 'not allowed';
    if (typeof filePath !== 'string' || !flagStore.hasPath(filePath)) return 'not in the queue';
    return shell.openPath(filePath);
  });

  ipcMain.on(CHANNELS.queueClose, (event) => {
    if (isQueueWindow(event.sender)) closeQueueWindow();
  });
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
 *
 * With AFTERGLOW_SMOKE_MEDIA set it also drives the v0.2 capture path:
 * a simulated E keypress must flag the item on screen (verified in
 * flags.json on disk) and a simulated Q keypress must open the queue window
 * (whose console is watched for errors like the main window's).
 *
 * With AFTERGLOW_SMOKE_EXPECT_VIDEO additionally set (v0.4), the run fails
 * unless the renderer logged that a video started playing AND finished
 * (natural end or duration cap) — i.e. the full scan → protocol → <video>
 * playback → advance path worked.
 */
function armSmokeHarness(win: BrowserWindow): void {
  let rendererReady = false;
  let failure: string | null = null;
  const exercised = Boolean(process.env.AFTERGLOW_SMOKE_MEDIA);
  const expectVideo = Boolean(process.env.AFTERGLOW_SMOKE_EXPECT_VIDEO);
  let sawVideoStarted = false;
  let sawVideoFinished = false;

  ipcMain.on(CHANNELS.rendererReady, () => {
    rendererReady = true;
  });

  const watch = (contents: Electron.WebContents, label: string): void => {
    // Electron ≥32 passes a structured event object (level/message fields).
    contents.on('console-message', (event: { level?: string; message?: string }) => {
      const level = typeof event?.level === 'string' ? event.level : 'other';
      const message = typeof event?.message === 'string' ? event.message : '';
      console.log(`[${label}:${level}] ${message}`);
      if (level === 'error') failure = failure ?? `${label} console error: ${message}`;
      if (message.includes('[afterglow] video started')) sawVideoStarted = true;
      if (message.includes('[afterglow] video ended') || message.includes('[afterglow] video capped')) {
        sawVideoFinished = true;
      }
    });
    contents.on('did-fail-load', (_e, code, desc) => {
      failure = failure ?? `${label} did-fail-load: ${code} ${desc}`;
    });
    contents.on('render-process-gone', (_e, details) => {
      failure = failure ?? `${label} render-process-gone: ${details.reason}`;
    });
  };
  watch(win.webContents, 'renderer');
  app.on('web-contents-created', (_event, contents) => watch(contents, 'queue-renderer'));

  if (exercised) {
    // E flags the current photo; Q opens the queue window. Both are show
    // hotkeys and must NOT exit the app.
    setTimeout(() => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'e' }), 1200);
    setTimeout(() => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'q' }), 2000);
  }

  const verifyCapture = (): string | null => {
    if (!exercised) return null;
    const entries = flagStore?.list() ?? [];
    if (entries.length !== 1 || entries[0].flagType !== 'edit') {
      return `expected exactly one 'edit' flag after simulated E keypress, got ${JSON.stringify(entries)}`;
    }
    try {
      const raw = readFileSync(path.join(app.getPath('userData'), 'flags.json'), 'utf8');
      const parsed = JSON.parse(raw) as { entries?: unknown[] };
      if (!Array.isArray(parsed.entries) || parsed.entries.length !== 1) {
        return `flags.json on disk does not hold the flagged item: ${raw}`;
      }
    } catch (err) {
      return `flags.json was not persisted: ${String(err)}`;
    }
    if (!getQueueWindow()) return 'queue window did not open after simulated Q keypress';
    // v0.3: the background EXIF index must have been built and persisted.
    try {
      const raw = readFileSync(path.join(app.getPath('userData'), INDEX_FILENAME), 'utf8');
      const parsed = JSON.parse(raw) as { entries?: Array<{ timestampMs?: unknown }> };
      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        return `index.json on disk holds no entries: ${raw}`;
      }
      if (!parsed.entries.every((e) => typeof e.timestampMs === 'number' && Number.isFinite(e.timestampMs))) {
        return `index.json contains entries without a usable timestamp: ${raw}`;
      }
    } catch (err) {
      return `index.json was not persisted: ${String(err)}`;
    }
    if (expectVideo && !sawVideoStarted) {
      return 'expected a video to start playing (no "video started" console marker)';
    }
    if (expectVideo && !sawVideoFinished) {
      return 'expected the video slide to finish (no "video ended"/"video capped" marker)';
    }
    return null;
  };

  const finish = (): void => {
    failure = failure ?? verifyCapture();
    if (failure) {
      console.error(`[smoke] FAIL: ${failure}`);
      app.exit(1);
    } else if (!rendererReady) {
      console.error('[smoke] FAIL: renderer never signalled ready');
      app.exit(1);
    } else {
      console.log(
        exercised
          ? `[smoke] OK: renderer loaded cleanly, flag captured + persisted, queue window opened, EXIF index persisted${expectVideo ? ', video played to completion' : ''}`
          : '[smoke] OK: renderer loaded cleanly',
      );
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
  flagStore = await openFlagStore(app.getPath('userData'), {
    onChange: pushQueueChanged,
    onWarn: (msg, err) => console.warn(`[afterglow] ${msg}`, err),
  });
  // Smoke runs can point at a fixture folder to exercise the full
  // scan → protocol → crossfade path headlessly. AFTERGLOW_SMOKE_VIDEO_CAP_S
  // (smoke only) shrinks the per-video cap so the cap path is provable with
  // a long fixture clip inside the smoke window; the value still goes
  // through normalizeSettings, same as any user input.
  if (SMOKE && process.env.AFTERGLOW_SMOKE_MEDIA) {
    settings = { ...settings, mediaFolders: [process.env.AFTERGLOW_SMOKE_MEDIA] };
    const capOverride = Number(process.env.AFTERGLOW_SMOKE_VIDEO_CAP_S);
    if (Number.isFinite(capOverride)) {
      settings = { ...normalizeSettings({ ...settings, videoMaxSeconds: capOverride }), mediaFolders: settings.mediaFolders };
    }
  }
  await refreshMediaRoots();
  registerIpc();
  mainWindow = createWindow();
  if (SMOKE) armSmokeHarness(mainWindow);
});
