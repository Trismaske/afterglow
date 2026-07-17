/**
 * Renderer entry: first-run screen when no folders are configured, otherwise
 * the crossfade slideshow. All input-driven exiting funnels through the one
 * exit arbiter (exit.ts); show hotkeys (O overlay, Q queue, D/E/M/R flags)
 * are handled first and never reach the exit path.
 */

import type { Settings } from '../shared/api';
import { createExitArbiter } from './exit';
import { createFlagController, isShowHotkey, UNDO_WINDOW_MS } from './flags';
import { Overlay } from './overlay';
import { createPlaylist } from './playlist';
import { Slideshow } from './slideshow';
import { Toast } from './toast';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const firstRunEl = $('first-run');
const messageEl = $('message');
const stageEl = $('stage');
const chooseBtn = $<HTMLButtonElement>('choose');

const overlay = new Overlay($('overlay'));
const toast = new Toast($('toast'), UNDO_WINDOW_MS);

/** True while the slideshow itself is on screen (hotkeys only apply then). */
let showActive = false;
/** True while the queue window is open (exit-on-input pauses). */
let queueOpen = false;
let overlayEnabled = true;
let currentUrl: string | null = null;
let slideshow: Slideshow | null = null;

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

function showOnly(el: HTMLElement | null): void {
  for (const candidate of [firstRunEl, messageEl, stageEl]) {
    candidate.classList.toggle('hidden', candidate !== el);
  }
}

function showMessage(text: string): void {
  showActive = false;
  overlay.setVisible(false);
  messageEl.textContent = text;
  showOnly(messageEl);
  document.body.classList.remove('interactive');
  arbiter.arm(); // a message screen still exits on any input
}

function showFirstRun(): void {
  showActive = false;
  arbiter.disarm(); // the user must be able to click the button
  document.body.classList.add('interactive');
  showOnly(firstRunEl);
}

async function startShow(settings: Settings): Promise<void> {
  const urls = await window.afterglow.getPlaylist();
  if (urls.length === 0) {
    showMessage('Afterglow found no images in your folders. Move the mouse or press any key to exit, then check the folders in settings.json.');
    return;
  }
  document.body.classList.remove('interactive');
  showOnly(stageEl);
  overlayEnabled = settings.overlayEnabled;
  overlay.setVisible(overlayEnabled);
  showActive = true;
  applyArbiterState();
  slideshow?.stop();
  slideshow = new Slideshow({
    container: stageEl,
    playlist: createPlaylist(urls, Math.random),
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
      if (settings) await startShow(settings);
    } finally {
      chooseBtn.disabled = false;
    }
  })();
});

async function main(): Promise<void> {
  const settings = await window.afterglow.getSettings();
  if (settings.mediaFolders.length === 0) {
    showFirstRun();
  } else {
    await startShow(settings);
  }
  window.afterglow.rendererReady();
}

void main().catch((err) => {
  console.error(`[afterglow] renderer failed to start: ${String(err)}`);
  showMessage('Afterglow failed to start. Move the mouse or press any key to exit.');
});
