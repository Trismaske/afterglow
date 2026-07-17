/**
 * Preload: the only bridge between renderer and main. Exposes the minimal
 * typed API defined in shared/api.ts — nothing else crosses the boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { FlagType } from '@afterglow/core';
import {
  CHANNELS,
  type AfterglowApi,
  type ItemInfo,
  type LaunchInfo,
  type LibraryItem,
  type ScreensaverResult,
  type ScreensaverStatus,
  type Settings,
  type SettingsPatch,
} from '../shared/api';

const api: AfterglowApi = {
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings) as Promise<Settings>,
  chooseFolders: () => ipcRenderer.invoke(CHANNELS.chooseFolders) as Promise<Settings | null>,
  getPlaylist: () => ipcRenderer.invoke(CHANNELS.getPlaylist) as Promise<string[]>,
  exit: (reason: string) => ipcRenderer.send(CHANNELS.exit, reason),
  rendererReady: () => ipcRenderer.send(CHANNELS.rendererReady),
  getLaunchInfo: () => ipcRenderer.invoke(CHANNELS.launchInfo) as Promise<LaunchInfo>,
  setShowActive: (active: boolean) => ipcRenderer.send(CHANNELS.showState, active),
  screensaverStatus: () => ipcRenderer.invoke(CHANNELS.screensaverStatus) as Promise<ScreensaverStatus>,
  screensaverRegister: () => ipcRenderer.invoke(CHANNELS.screensaverRegister) as Promise<ScreensaverResult>,
  screensaverUnregister: () => ipcRenderer.invoke(CHANNELS.screensaverUnregister) as Promise<ScreensaverResult>,
  getItemInfo: (url: string) => ipcRenderer.invoke(CHANNELS.getItemInfo, url) as Promise<ItemInfo | null>,
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(CHANNELS.updateSettings, patch) as Promise<Settings>,
  onIndexReady: (cb: (items: LibraryItem[]) => void) => {
    ipcRenderer.on(CHANNELS.indexReady, (_event, items: unknown) => {
      if (Array.isArray(items)) cb(items as LibraryItem[]);
    });
  },
  setOverlayEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.setOverlayEnabled, enabled) as Promise<Settings>,
  addFlag: (url: string, flagType: FlagType) =>
    ipcRenderer.invoke(CHANNELS.flagAdd, url, flagType) as Promise<boolean>,
  removeFlag: (url: string, flagType: FlagType) =>
    ipcRenderer.invoke(CHANNELS.flagRemove, url, flagType) as Promise<boolean>,
  openQueue: () => ipcRenderer.send(CHANNELS.openQueue),
  onQueueState: (cb: (open: boolean) => void) => {
    ipcRenderer.on(CHANNELS.queueState, (_event, open: unknown) => cb(open === true));
  },
};

contextBridge.exposeInMainWorld('afterglow', api);
