/**
 * Crossfade slideshow over two stacked, reused <img> layers.
 *
 * Soak-safety: the two img elements are created once and reused forever —
 * no DOM nodes or event listeners accumulate no matter how long the show
 * runs. Image load/error handlers are assigned (not addEventListener) and
 * cleared after each load.
 *
 * Unreadable/undecodable files are logged (console.warn) and skipped; if a
 * full playlist pass yields nothing displayable, onAllFailed fires and the
 * show stops (input still exits — the arbiter is independent).
 */

import type { Playlist } from './playlist';

export interface SlideshowOptions {
  container: HTMLElement;
  playlist: Playlist;
  slideDurationMs: number;
  /** Called when an entire pass over the playlist failed to load anything. */
  onAllFailed: () => void;
  /** Called after each successful crossfade with the shown URL. */
  onShown?: (url: string) => void;
  log?: (msg: string) => void;
}

export class Slideshow {
  private readonly layers: [HTMLImageElement, HTMLImageElement];
  private front = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: SlideshowOptions) {
    const mk = (): HTMLImageElement => {
      const img = document.createElement('img');
      img.className = 'layer';
      img.alt = '';
      img.decoding = 'async';
      opts.container.appendChild(img);
      return img;
    };
    this.layers = [mk(), mk()];
  }

  start(): void {
    void this.advance();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Load the next displayable image into the back layer, then crossfade. */
  private async advance(): Promise<void> {
    if (this.stopped) return;
    const { playlist, log } = this.opts;
    const attempts = Math.max(1, playlist.size);

    for (let i = 0; i < attempts; i++) {
      const url = playlist.next();
      const back = this.layers[1 - this.front];
      const ok = await this.loadInto(back, url);
      if (this.stopped) return;
      if (ok) {
        this.crossfade();
        this.opts.onShown?.(url);
        this.timer = setTimeout(() => void this.advance(), this.opts.slideDurationMs);
        return;
      }
      log?.(`skipping unloadable image: ${url}`);
    }
    this.stop();
    this.opts.onAllFailed();
  }

  private crossfade(): void {
    const incoming = this.layers[1 - this.front];
    const outgoing = this.layers[this.front];
    incoming.classList.add('visible');
    outgoing.classList.remove('visible');
    this.front = 1 - this.front;
  }

  private loadInto(img: HTMLImageElement, url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = url;
    });
  }
}
