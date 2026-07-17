/**
 * Preload: the only bridge between renderer and main. Exposes the minimal
 * typed API defined in shared/api.ts — nothing else crosses the boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type AfterglowApi, type Settings } from '../shared/api';

const api: AfterglowApi = {
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings) as Promise<Settings>,
  chooseFolders: () => ipcRenderer.invoke(CHANNELS.chooseFolders) as Promise<Settings | null>,
  getPlaylist: () => ipcRenderer.invoke(CHANNELS.getPlaylist) as Promise<string[]>,
  exit: (reason: string) => ipcRenderer.send(CHANNELS.exit, reason),
  rendererReady: () => ipcRenderer.send(CHANNELS.rendererReady),
};

contextBridge.exposeInMainWorld('afterglow', api);
