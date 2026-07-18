/**
 * Renderer entry: on a manual launch the settings screen comes first (v0.5 —
 * with a prominent Start button; it doubles as first-run and as the S-mid-
 * show screen); `--show` / screensaver launches go straight into the
 * crossfade slideshow. All input-driven exiting funnels through the one exit
 * arbiter (exit.ts); show hotkeys (S settings, O overlay, Q queue, arrows
 * nav, D/E/M/R/N/T flags) are handled first and never reach the exit path.
 * What "exit" means depends on the launch mode: manual → back to settings,
 * --show → quit the app.
 *
 * v0.3 story engine: the show always starts on a plain shuffled playlist;
 * when main pushes the background EXIF index (indexReady) and orderMode is
 * 'smart', the playlist hot-swaps to core's moments-cluster mix engine
 * without interrupting the running show (in shuffle mode the push refreshes
 * the plain playlist instead — that's how a v0.5 warm start from a stale
 * persisted index picks up new files).
 */

import type { LaunchDisplayMode, LibraryItem, ScreensaverStatus, Settings } from '../shared/api';
import { createExitArbiter } from './exit';
import { createFlagController, isShowHotkey, UNDO_WINDOW_MS } from './flags';
import { Overlay } from './overlay';
import { createPlaylist } from './playlist';
import { Slideshow } from './slideshow';
import { createSmartPlaylist, createSwappablePlaylist, type SwappablePlaylist } from './smart';
import { Toast } from './toast';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const settingsEl = $('settings');
const messageEl = $('message');
const stageEl = $('stage');
const chooseBtn = $<HTMLButtonElement>('choose');
const startBtn = $<HTMLButtonElement>('start');
const foldersEl = $('folders');
const durationInput = $<HTMLInputElement>('duration');
const orderModeSelect = $<HTMLSelectElement>('order-mode');
const gapInput = $<HTMLInputElement>('gap');
const capInput = $<HTMLInputElement>('cap');
const videoMaxInput = $<HTMLInputElement>('video-max');
const legendEl = $('legend');
const scrLabelEl = $('scr-label');
const scrFieldEl = $('scr-field');
const scrToggleBtn = $<HTMLButtonElement>('scr-toggle');
const scrStatusEl = $('scr-status');

const overlay = new Overlay($('overlay'));
const toast = new Toast($('toast'), UNDO_WINDOW_MS);

/** How long the shortcut legend stays up on its own after the show starts. */
const LEGEND_FLASH_MS = 6000;

/** True while the slideshow itself is on screen (hotkeys only apply then). */
let showActive = false;
/** True while the queue window is open (exit-on-input pauses). */
let queueOpen = false;
let overlayEnabled = true;
let currentUrl: string | null = null;
let slideshow: Slideshow | null = null;
/** Settings as last loaded/saved — the smart hot-swap reads gap/cap from here. */
let currentSettings: Settings | null = null;
/** The running show's playlist wrapper; null when no show is up. */
let swappable: SwappablePlaylist | null = null;
/** v0.5: 'manual' returns to settings on exit-input, 'show' quits the app. */
let launchMode: LaunchDisplayMode = 'manual';
/** True while the shortcut legend is force-shown right after show start. */
let legendFlashing = false;
let legendFlashTimer: ReturnType<typeof setTimeout> | null = null;

const arbiter = createExitArbiter({
  onExit: (reason) => {
    // v0.5: what leaving the show means depends on how we were launched.
    if (launchMode === 'manual') {
      console.log(`[afterglow] input (${reason}) — returning to settings`);
      showSettings();
    } else {
      window.afterglow.exit(reason);
    }
  },
  isExemptKey: (key) => showActive && isShowHotkey(key),
});

// The controller tracks items by their media URL (bijective with the path);
// main decodes + validates the URL and stores the real file path.
const flags = createFlagController({
  now: () => Date.now(),
  add: (url, flagType) => {
    void window.afterglow.addFlag(url, flagType);
  },
  remove: (url, flagType) => {
    void window.afterglow.removeFlag(url, flagType);
  },
  toast: (message) => toast.show(message),
});

function updateOverlay(): void {
  if (!overlayEnabled || currentUrl === null) return;
  const url = currentUrl;
  void window.afterglow
    .getItemInfo(url)
    .then((info) => {
      if (url === currentUrl) overlay.update(info);
    })
    .catch(() => overlay.update(null));
}

function applyArbiterState(): void {
  if (showActive && queueOpen) {
    arbiter.disarm(); // reaching the queue window must not kill the show
  } else if (showActive) {
    arbiter.arm();
  }
}

/**
 * The shortcut legend (v0.5) is visible while the show runs and either the
 * overlay is on or the show just started (a few seconds' flash).
 */
function syncLegend(): void {
  legendEl.classList.toggle('hidden', !(showActive && (overlayEnabled || legendFlashing)));
}

/** Force the legend on for LEGEND_FLASH_MS (called at show start). */
function flashLegend(): void {
  legendFlashing = true;
  if (legendFlashTimer !== null) clearTimeout(legendFlashTimer);
  legendFlashTimer = setTimeout(() => {
    legendFlashing = false;
    legendFlashTimer = null;
    syncLegend();
  }, LEGEND_FLASH_MS);
  syncLegend();
}

/** Returns true when the key was consumed as a show hotkey. */
function handleHotkey(key: string): boolean {
  if (!showActive) return false;
  const k = key.toLowerCase();
  if (k === 'o') {
    overlayEnabled = !overlayEnabled;
    overlay.setVisible(overlayEnabled);
    if (overlayEnabled) updateOverlay();
    syncLegend();
    void window.afterglow.setOverlayEnabled(overlayEnabled);
    return true;
  }
  if (k === 'q') {
    window.afterglow.openQueue();
    return true;
  }
  if (k === 's') {
    showSettings();
    return true;
  }
  // v0.5 arrow navigation — handled by the slideshow's seek API.
  if (k === 'arrowleft') {
    slideshow?.previous();
    return true;
  }
  if (k === 'arrowright') {
    slideshow?.next();
    return true;
  }
  if (k === 'arrowup') {
    slideshow?.restartMoment();
    return true;
  }
  if (k === 'arrowdown') {
    slideshow?.skipMoment();
    return true;
  }
  return flags.keyPressed(key, currentUrl);
}

// The single wiring point between DOM input events and the exit path.
window.addEventListener('mousemove', (e) => arbiter.pointerMoved(e.screenX, e.screenY));
window.addEventListener('mousedown', () => {
  if (!queueOpen) arbiter.pointerDown();
});
window.addEventListener('keydown', (e) => {
  if (handleHotkey(e.key)) return;
  arbiter.keyDown(e.key);
});

window.afterglow.onQueueState((open) => {
  queueOpen = open;
  applyArbiterState();
});

// v0.3: the background EXIF index finished — hot-swap to smart order if the
// show is on a swappable playlist and smart mode is selected. Stale pushes
// (from before a settings change) are harmless: the next scan re-pushes.
// v0.5: in shuffle mode the push refreshes the plain playlist instead, so a
// warm start from a stale persisted index converges on the fresh scan.
window.afterglow.onIndexReady((items: LibraryItem[]) => {
  if (!swappable || !currentSettings) return;
  if (currentSettings.orderMode !== 'smart') {
    if (items.length > 0) {
      swappable.swap(
        createPlaylist(
          items.map((item) => item.url),
          Math.random,
        ),
      );
      console.log(`[afterglow] playlist refreshed from rescan (${items.length} files)`);
    }
    return;
  }
  const smart = createSmartPlaylist(items, {
    gapMinutes: currentSettings.momentGapMinutes,
    clusterCap: currentSettings.clusterCap,
    rng: Math.random,
  });
  if (!smart) return;
  swappable.swap(smart);
  console.log(
    `[afterglow] smart order engaged: ${smart.clusterCount} moments across ${smart.size} photos`,
  );
});

function showOnly(el: HTMLElement | null): void {
  for (const candidate of [settingsEl, messageEl, stageEl]) {
    candidate.classList.toggle('hidden', candidate !== el);
  }
}

/** What any-input does from a show/message screen, for message texts. */
function exitHint(): string {
  return launchMode === 'manual'
    ? 'Move the mouse or press any key to return to settings.'
    : 'Move the mouse or press any key to exit.';
}

function showMessage(text: string): void {
  showActive = false;
  swappable = null;
  currentUrl = null;
  overlay.setVisible(false);
  syncLegend();
  window.afterglow.setShowActive(false);
  messageEl.textContent = text;
  showOnly(messageEl);
  document.body.classList.remove('interactive');
  arbiter.arm(); // a message screen still reacts to any input (exit/settings)
}

function renderFolderList(folders: readonly string[]): void {
  foldersEl.textContent = folders.length === 0 ? 'No folders chosen yet.' : folders.join('\n');
  foldersEl.classList.toggle('empty', folders.length === 0);
  foldersEl.style.whiteSpace = 'pre-line';
  startBtn.disabled = folders.length === 0;
}

function populateSettingsForm(settings: Settings): void {
  renderFolderList(settings.mediaFolders);
  durationInput.value = String(settings.slideDurationSeconds);
  orderModeSelect.value = settings.orderMode;
  gapInput.value = String(settings.momentGapMinutes);
  capInput.value = String(settings.clusterCap);
  videoMaxInput.value = String(settings.videoMaxSeconds);
}

// ---- v0.5: Windows "set as default screensaver" ----

/** Cached last-known status so the toggle knows which action it performs. */
let scrStatus: ScreensaverStatus | null = null;

function renderScreensaverStatus(status: ScreensaverStatus, error: string | null = null): void {
  scrStatus = status;
  scrToggleBtn.textContent =
    status.registered === 'self' ? 'Unset as default screensaver' : 'Set as default screensaver';
  if (error) {
    scrStatusEl.textContent = error;
  } else if (status.registered === 'self') {
    scrStatusEl.textContent = 'Afterglow is the default screensaver.';
  } else if (status.registered === 'other') {
    scrStatusEl.textContent = `Current screensaver: ${status.currentPath ?? 'unknown'}`;
  } else if (!status.scrPresent) {
    scrStatusEl.textContent = 'Not set. Requires the installed (installer) version of Afterglow.';
  } else {
    scrStatusEl.textContent = 'No screensaver is set.';
  }
}

function refreshScreensaverUi(): void {
  void window.afterglow
    .screensaverStatus()
    .then((status) => renderScreensaverStatus(status))
    .catch(() => {
      scrStatusEl.textContent = 'Screensaver status unavailable.';
    });
}

scrToggleBtn.addEventListener('click', () => {
  void (async () => {
    scrToggleBtn.disabled = true;
    try {
      const result =
        scrStatus?.registered === 'self'
          ? await window.afterglow.screensaverUnregister()
          : await window.afterglow.screensaverRegister();
      renderScreensaverStatus(result.status, result.error);
    } finally {
      scrToggleBtn.disabled = false;
    }
  })();
});

/** The settings screen — manual launch, first-run and S-mid-show land here. */
function showSettings(): void {
  showActive = false;
  swappable = null;
  slideshow?.stop();
  slideshow = null;
  currentUrl = null; // no photo on screen: don't fetch stale overlay info
  overlay.setVisible(false);
  syncLegend();
  window.afterglow.setShowActive(false);
  arbiter.disarm(); // the user must be able to click controls
  document.body.classList.add('interactive');
  if (currentSettings) populateSettingsForm(currentSettings);
  if (!scrFieldEl.classList.contains('hidden')) refreshScreensaverUi();
  showOnly(settingsEl);
}

async function startShow(settings: Settings): Promise<void> {
  currentSettings = settings;
  swappable = null;
  const urls = await window.afterglow.getPlaylist();
  if (urls.length === 0) {
    showMessage(
      `Afterglow found no images in your folders. ${exitHint()} Then check the folders in settings.`,
    );
    return;
  }
  document.body.classList.remove('interactive');
  showOnly(stageEl);
  overlayEnabled = settings.overlayEnabled;
  overlay.setVisible(overlayEnabled);
  showActive = true;
  applyArbiterState();
  window.afterglow.setShowActive(true); // main blocks display sleep while up
  flashLegend(); // remind about the shortcuts for a few seconds
  slideshow?.stop();
  slideshow = null;
  // S ↔ settings ↔ start can cycle: drop the previous show's <img> layers so
  // DOM nodes (and a stale 'visible' photo) never accumulate across restarts.
  stageEl.replaceChildren();
  // Start in shuffle order; indexReady hot-swaps to smart when appropriate.
  swappable = createSwappablePlaylist(createPlaylist(urls, Math.random));
  slideshow = new Slideshow({
    container: stageEl,
    playlist: swappable,
    slideDurationMs: Math.max(1000, settings.slideDurationSeconds * 1000),
    // 0 = play full length (v0.5): pass the sentinel straight through.
    videoMaxDurationMs:
      settings.videoMaxSeconds === 0 ? 0 : Math.max(1000, settings.videoMaxSeconds * 1000),
    onAllFailed: () =>
      showMessage(`Afterglow could not display any of the media it found. ${exitHint()}`),
    onShown: (url) => {
      currentUrl = url;
      flags.itemChanged();
      updateOverlay();
      console.log(`[afterglow] showing ${url}`);
    },
    log: (msg) => console.warn(`[afterglow] ${msg}`),
    logInfo: (msg) => console.log(`[afterglow] ${msg}`),
  });
  slideshow.start();
}

chooseBtn.addEventListener('click', () => {
  void (async () => {
    chooseBtn.disabled = true;
    try {
      const settings = await window.afterglow.chooseFolders();
      if (settings) {
        currentSettings = settings;
        renderFolderList(settings.mediaFolders);
      }
    } finally {
      chooseBtn.disabled = false;
    }
  })();
});

/** Read the form, persist via main (which validates/clamps), start the show. */
startBtn.addEventListener('click', () => {
  void (async () => {
    startBtn.disabled = true;
    try {
      const settings = await window.afterglow.updateSettings({
        slideDurationSeconds: Number(durationInput.value),
        orderMode: orderModeSelect.value === 'shuffle' ? 'shuffle' : 'smart',
        momentGapMinutes: Number(gapInput.value),
        clusterCap: Number(capInput.value),
        // Blank must NOT read as 0 ("full length", v0.5) — Number('') is 0,
        // so send NaN instead and let main fall back to the default.
        videoMaxSeconds: videoMaxInput.value.trim() === '' ? NaN : Number(videoMaxInput.value),
      });
      await startShow(settings);
    } finally {
      startBtn.disabled = false;
    }
  })();
});

async function main(): Promise<void> {
  const [settings, launch] = await Promise.all([
    window.afterglow.getSettings(),
    window.afterglow.getLaunchInfo(),
  ]);
  launchMode = launch.mode;
  currentSettings = settings;
  populateSettingsForm(settings);
  if (launch.platform === 'win32') {
    // The screensaver row only exists on Windows; status loads lazily when
    // the settings screen is shown.
    scrLabelEl.classList.remove('hidden');
    scrFieldEl.classList.remove('hidden');
  }
  // v0.5: manual launches always land on settings (that's where the
  // prominent Start button lives); --show / screensaver launches go straight
  // into the show — unless there is nothing configured to show yet.
  if (launch.mode === 'show' && settings.mediaFolders.length > 0) {
    await startShow(settings);
  } else {
    showSettings();
  }
  window.afterglow.rendererReady();
}

void main().catch((err) => {
  console.error(`[afterglow] renderer failed to start: ${String(err)}`);
  showMessage(`Afterglow failed to start. ${exitHint()}`);
});
