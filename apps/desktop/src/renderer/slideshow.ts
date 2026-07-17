/**
 * Crossfade slideshow over two stacked, reused slots. Each slot owns one
 * <img> and one <video> element (v0.4); per slide exactly one of the two is
 * active and gets the 'visible' class, so photos and videos crossfade into
 * each other exactly like photos did in v0.1.
 *
 * Soak-safety: the four elements are created once and reused forever — no
 * DOM nodes or event listeners accumulate no matter how long the show runs.
 * Load/ended/error handlers are assigned (not addEventListener) and cleared
 * on every slot reset.
 *
 * Video slides (v0.4): muted, inline, autoplaying; the slide advances at the
 * video's natural end OR after the per-video duration cap, whichever comes
 * first (createVideoWatch fires exactly once). A playback error mid-video
 * advances immediately. Files that fail to load — e.g. a .mov whose codec
 * Chromium can't decode — are logged and skipped like undecodable images.
 *
 * If a full playlist pass yields nothing displayable, onAllFailed fires and
 * the show stops (input still exits — the arbiter is independent).
 */

import { mediaKindFromUrl, type MediaKind } from '../shared/api';
import type { Playlist } from './playlist';
import { createVideoWatch, type VideoWatch } from './video';

export interface SlideshowOptions {
  container: HTMLElement;
  playlist: Playlist;
  slideDurationMs: number;
  /** Per-video duration cap, ms (v0.4). */
  videoMaxDurationMs: number;
  /** Called when an entire pass over the playlist failed to load anything. */
  onAllFailed: () => void;
  /** Called after each successful crossfade with the shown URL. */
  onShown?: (url: string) => void;
  /** Skips/warnings. */
  log?: (msg: string) => void;
  /** Informational events (video started/ended/capped) — smoke test markers. */
  logInfo?: (msg: string) => void;
}

interface Slot {
  img: HTMLImageElement;
  video: HTMLVideoElement;
  /** Which element the last successful load went into. */
  active: HTMLImageElement | HTMLVideoElement | null;
}

export class Slideshow {
  private readonly slots: [Slot, Slot];
  private front = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private videoWatch: VideoWatch | null = null;
  private stopped = false;

  constructor(private readonly opts: SlideshowOptions) {
    const mkSlot = (): Slot => {
      const img = document.createElement('img');
      img.className = 'layer';
      img.alt = '';
      img.decoding = 'async';
      const video = document.createElement('video');
      video.className = 'layer';
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.autoplay = false; // play() is called at crossfade time
      video.preload = 'auto';
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.disablePictureInPicture = true;
      opts.container.appendChild(img);
      opts.container.appendChild(video);
      return { img, video, active: null };
    };
    this.slots = [mkSlot(), mkSlot()];
  }

  start(): void {
    void this.advance();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.videoWatch?.cancel();
    this.videoWatch = null;
    for (const slot of this.slots) this.resetSlot(slot);
  }

  /** Load the next displayable item into the back slot, then crossfade. */
  private async advance(): Promise<void> {
    if (this.stopped) return;
    // Whatever scheduled this advance is spent; make sure nothing else fires.
    this.videoWatch?.cancel();
    this.videoWatch = null;
    const { playlist, log } = this.opts;
    const attempts = Math.max(1, playlist.size);

    for (let i = 0; i < attempts; i++) {
      const url = playlist.next();
      const kind = mediaKindFromUrl(url) ?? 'photo';
      const back = this.slots[1 - this.front];
      const ok = await this.loadInto(back, url, kind);
      if (this.stopped) return;
      if (ok) {
        this.crossfade();
        this.opts.onShown?.(url);
        this.scheduleNext(kind, url);
        return;
      }
      log?.(`skipping unloadable ${kind}: ${url}`);
    }
    this.stop();
    this.opts.onAllFailed();
  }

  /** Photo: fixed timer. Video: play(), advance on ended/cap/error. */
  private scheduleNext(kind: MediaKind, url: string): void {
    if (kind === 'photo') {
      this.timer = setTimeout(() => void this.advance(), this.opts.slideDurationMs);
      return;
    }
    const video = this.slots[this.front].video;
    const watch = createVideoWatch({
      capMs: this.opts.videoMaxDurationMs,
      onAdvance: (reason) => {
        video.onended = null;
        video.onerror = null;
        this.videoWatch = null;
        if (reason === 'ended') this.opts.logInfo?.(`video ended: ${url}`);
        else if (reason === 'cap') this.opts.logInfo?.(`video capped after ${this.opts.videoMaxDurationMs} ms: ${url}`);
        else this.opts.log?.(`video failed during playback, advancing: ${url}`);
        void this.advance();
      },
    });
    this.videoWatch = watch;
    video.onended = () => watch.ended();
    video.onerror = () => watch.error();
    video.play().then(
      () => this.opts.logInfo?.(`video started: ${url}`),
      (err) => {
        this.opts.log?.(`video play() rejected: ${String(err)}`);
        watch.error();
      },
    );
  }

  private crossfade(): void {
    const incoming = this.slots[1 - this.front];
    const outgoing = this.slots[this.front];
    for (const el of [incoming.img, incoming.video]) {
      el.classList.toggle('visible', el === incoming.active);
    }
    outgoing.img.classList.remove('visible');
    outgoing.video.classList.remove('visible');
    // Freeze (and silence the decoder of) any video that is fading out.
    if (!outgoing.video.paused) outgoing.video.pause();
    this.front = 1 - this.front;
  }

  /** Clear all handlers and release any loaded video in the slot. */
  private resetSlot(slot: Slot): void {
    slot.img.onload = null;
    slot.img.onerror = null;
    slot.video.oncanplay = null;
    slot.video.onended = null;
    slot.video.onerror = null;
    if (!slot.video.paused) slot.video.pause();
    if (slot.video.getAttribute('src') !== null) {
      slot.video.removeAttribute('src');
      slot.video.load(); // detach the resource so the decoder is freed
    }
    slot.active = null;
  }

  private loadInto(slot: Slot, url: string, kind: MediaKind): Promise<boolean> {
    this.resetSlot(slot);
    return new Promise((resolve) => {
      if (kind === 'photo') {
        const done = (ok: boolean): void => {
          slot.img.onload = null;
          slot.img.onerror = null;
          slot.active = ok ? slot.img : null;
          resolve(ok);
        };
        slot.img.onload = () => done(true);
        slot.img.onerror = () => done(false);
        slot.img.src = url;
        return;
      }
      const done = (ok: boolean): void => {
        slot.video.oncanplay = null;
        slot.video.onerror = null;
        slot.active = ok ? slot.video : null;
        resolve(ok);
      };
      slot.video.oncanplay = () => done(true);
      slot.video.onerror = () => done(false);
      slot.video.src = url;
      slot.video.load();
    });
  }
}
