/**
 * The flag-queue window: a small, ordinary (windowed, closable) window
 * listing everything flagged during the show. Same security model as the
 * slideshow window — contextIsolation, sandbox, its own minimal preload.
 *
 * It floats above the fullscreen slideshow (always-on-top) and the slideshow
 * keeps playing behind it; the exit arbiter is paused while it's open (the
 * open/close callback lets index.ts tell the slideshow renderer).
 */

import { BrowserWindow } from 'electron';
import * as path from 'node:path';

let queueWindow: BrowserWindow | null = null;

export function getQueueWindow(): BrowserWindow | null {
  return queueWindow && !queueWindow.isDestroyed() ? queueWindow : null;
}

export function isQueueWindow(sender: Electron.WebContents): boolean {
  const win = getQueueWindow();
  return win !== null && sender === win.webContents;
}

/** Open the queue window, or focus it if it is already up. */
export function openQueueWindow(onStateChange: (open: boolean) => void): BrowserWindow {
  const existing = getQueueWindow();
  if (existing) {
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 820,
    height: 520,
    minWidth: 480,
    minHeight: 240,
    title: 'Afterglow — flag queue',
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    webPreferences: {
      preload: path.join(__dirname, '../preload/queue.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  // Stay visible above the fullscreen slideshow window.
  win.setAlwaysOnTop(true, 'floating');
  void win.loadFile(path.join(__dirname, '../renderer/queue.html'));
  win.on('closed', () => {
    queueWindow = null;
    onStateChange(false);
  });
  queueWindow = win;
  onStateChange(true);
  return win;
}

export function closeQueueWindow(): void {
  getQueueWindow()?.close();
}
