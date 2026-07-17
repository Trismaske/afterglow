/**
 * Preload for the flag-queue window. Same rules as the slideshow preload:
 * minimal, typed, nothing but the declared surface crosses the boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { FlagType } from '@afterglow/core';
import { CHANNELS, type AfterglowQueueApi, type QueueEntry } from '../shared/api';

const api: AfterglowQueueApi = {
  list: () => ipcRenderer.invoke(CHANNELS.queueList) as Promise<QueueEntry[]>,
  remove: (path: string, flagType: FlagType) =>
    ipcRenderer.invoke(CHANNELS.queueRemove, path, flagType) as Promise<QueueEntry[]>,
  reveal: (path: string) => ipcRenderer.invoke(CHANNELS.queueReveal, path) as Promise<void>,
  open: (path: string) => ipcRenderer.invoke(CHANNELS.queueOpen, path) as Promise<string>,
  close: () => ipcRenderer.send(CHANNELS.queueClose),
  onChanged: (cb: (entries: QueueEntry[]) => void) => {
    ipcRenderer.on(CHANNELS.queueChanged, (_event, entries: unknown) => {
      if (Array.isArray(entries)) cb(entries as QueueEntry[]);
    });
  },
};

contextBridge.exposeInMainWorld('afterglowQueue', api);
