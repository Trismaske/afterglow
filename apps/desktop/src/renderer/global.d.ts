import type { AfterglowApi, AfterglowQueueApi } from '../shared/api';

declare global {
  interface Window {
    /** Slideshow window (preload/index.ts). */
    afterglow: AfterglowApi;
    /** Queue window (preload/queue.ts). */
    afterglowQueue: AfterglowQueueApi;
  }
}

export {};
