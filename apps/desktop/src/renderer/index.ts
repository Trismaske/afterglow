/**
 * Renderer entry: first-run screen when no folders are configured, otherwise
 * the crossfade slideshow. All input-driven exiting funnels through the one
 * exit arbiter (exit.ts).
 */

import { createExitArbiter } from './exit';
import { createPlaylist } from './playlist';
import { Slideshow } from './slideshow';
import type { Settings } from '../shared/api';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const firstRunEl = $('first-run');
const messageEl = $('message');
const stageEl = $('stage');
const chooseBtn = $<HTMLButtonElement>('choose');

const arbiter = createExitArbiter({
  onExit: (reason) => window.afterglow.exit(reason),
});

// The single wiring point between DOM input events and the exit path.
window.addEventListener('mousemove', (e) => arbiter.pointerMoved(e.screenX, e.screenY));
window.addEventListener('mousedown', () => arbiter.pointerDown());
window.addEventListener('keydown', (e) => arbiter.keyDown(e.key));

let slideshow: Slideshow | null = null;

function showOnly(el: HTMLElement | null): void {
  for (const candidate of [firstRunEl, messageEl, stageEl]) {
    candidate.classList.toggle('hidden', candidate !== el);
  }
}

function showMessage(text: string): void {
  messageEl.textContent = text;
  showOnly(messageEl);
  document.body.classList.remove('interactive');
  arbiter.arm(); // a message screen still exits on any input
}

function showFirstRun(): void {
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
  arbiter.arm();
  slideshow?.stop();
  slideshow = new Slideshow({
    container: stageEl,
    playlist: createPlaylist(urls, Math.random),
    slideDurationMs: Math.max(1000, settings.slideDurationSeconds * 1000),
    onAllFailed: () => showMessage('Afterglow could not display any of the images it found. Move the mouse or press any key to exit.'),
    onShown: (url) => console.log(`[afterglow] showing ${url}`),
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
