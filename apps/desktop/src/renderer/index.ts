/**
 * Renderer entry: settings screen (doubles as first-run) when no folders are
 * configured or when S is pressed mid-show, otherwise the crossfade
 * slideshow. All input-driven exiting funnels through the one exit arbiter
 * (exit.ts); show hotkeys (S settings, O overlay, Q queue, D/E/M/R flags)
 * are handled first and never reach the exit path.
 *
 * v0.3 story engine: the show always starts on a plain shuffled playlist;
 * when main pushes the background EXIF index (indexReady) and orderMode is
 * 'smart', the playlist hot-swaps to core's moments-cluster mix engine
 * without interrupting the running show.
 */

import type { LibraryItem, Settings } from '../shared/api';
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

const overlay = new Overlay($('overlay'));
const toast = new Toast($('toast'), UNDO_WINDOW_MS);

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

const arbiter = createExitArbiter({
  onExit: (reason) => window.afterglow.exit(reason),
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

/** Returns true when the key was consumed as a show hotkey. */
function handleHotkey(key: string): boolean {
  if (!showActive) return false;
  const k = key.toLowerCase();
  if (k === 'o') {
    overlayEnabled = !overlayEnabled;
    overlay.setVisible(overlayEnabled);
    if (overlayEnabled) updateOverlay();
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
window.afterglow.onIndexReady((items: LibraryItem[]) => {
  if (!swappable || !currentSettings || currentSettings.orderMode !== 'smart') return;
  const smart = createSmartPlaylist(items, {
    gapMinutes: currentSettings.momentGapMinutes,
    clusterCap: currentSettings.clusterCap,
    rng: Math.random,
  });
  if (!smart) return;
  swappable.swap(smart);
  console.log(`[afterglow] smart order engaged: ${smart.clusterCount} moments across ${smart.size} photos`);
});

function showOnly(el: HTMLElement | null): void {
  for (const candidate of [settingsEl, messageEl, stageEl]) {
    candidate.classList.toggle('hidden', candidate !== el);
  }
}

function showMessage(text: string): void {
  showActive = false;
  swappable = null;
  currentUrl = null;
  overlay.setVisible(false);
  messageEl.textContent = text;
  showOnly(messageEl);
  document.body.classList.remove('interactive');
  arbiter.arm(); // a message screen still exits on any input
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
}

/** The settings screen — first-run and S-mid-show land here. */
function showSettings(): void {
  showActive = false;
  swappable = null;
  slideshow?.stop();
  slideshow = null;
  currentUrl = null; // no photo on screen: don't fetch stale overlay info
  overlay.setVisible(false);
  arbiter.disarm(); // the user must be able to click controls
  document.body.classList.add('interactive');
  if (currentSettings) populateSettingsForm(currentSettings);
  showOnly(settingsEl);
}

async function startShow(settings: Settings): Promise<void> {
  currentSettings = settings;
  swappable = null;
  const urls = await window.afterglow.getPlaylist();
  if (urls.length === 0) {
    showMessage('Afterglow found no images in your folders. Move the mouse or press any key to exit, then check the folders in settings.');
    return;
  }
  document.body.classList.remove('interactive');
  showOnly(stageEl);
  overlayEnabled = settings.overlayEnabled;
  overlay.setVisible(overlayEnabled);
  showActive = true;
  applyArbiterState();
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
    onAllFailed: () => showMessage('Afterglow could not display any of the images it found. Move the mouse or press any key to exit.'),
    onShown: (url) => {
      currentUrl = url;
      flags.itemChanged();
      updateOverlay();
      console.log(`[afterglow] showing ${url}`);
    },
    log: (msg) => console.warn(`[afterglow] ${msg}`),
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
      });
      await startShow(settings);
    } finally {
      startBtn.disabled = false;
    }
  })();
});

async function main(): Promise<void> {
  const settings = await window.afterglow.getSettings();
  currentSettings = settings;
  populateSettingsForm(settings);
  if (settings.mediaFolders.length === 0) {
    showSettings();
  } else {
    await startShow(settings);
  }
  window.afterglow.rendererReady();
}

void main().catch((err) => {
  console.error(`[afterglow] renderer failed to start: ${String(err)}`);
  showMessage('Afterglow failed to start. Move the mouse or press any key to exit.');
});
