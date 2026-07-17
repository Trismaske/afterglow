import type { AfterglowApi } from '../shared/api';

declare global {
  interface Window {
    afterglow: AfterglowApi;
  }
}

export {};
