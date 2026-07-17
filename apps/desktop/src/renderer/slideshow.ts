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
 * first (createVideoWatch fires exactly once; a cap of 0 means "full
 * length", v0.5). A playback error mid-video advances immediately. Files
 * that fail to load — e.g. a .mov whose codec Chromium can't decode — are
 * logged and skipped like undecodable images.
 *
 * Seek API (v0.5 arrow navigation): next()/previous()/restartMoment()/
 * skipMoment() drive the same crossfade path through a Navigator that keeps
 * a back-buffer of shown items — ← replays history across crossfades and
 * videos, → replays forward history before pulling fresh items, ↑ jumps to
 * the current moment's first shown item (or just restarts the current
 * slide), ↓ skips the rest of the moment. Every navigation resets the
 * auto-advance timer. A step sequence counter makes rapid keypresses safe:
 * a superseded in-flight step abandons itself before touching the DOM.
 *
 * If a full playlist pass yields nothing displayable, onAllFailed fires and
 * the show stops (input still exits — the arbiter is independent).
 */

import { mediaKindFromUrl, type MediaKind } from '../shared/api';
import { createNavigator, type NavCandidate, type Navigator } from './navigator';
import type { Playlist } from './playlist';
import { createVideoWatch, type VideoWatch } from './video';

export interface SlideshowOptions {
  container: HTMLElement;
  playlist: Playlist;
  slideDurationMs: number;
  /** Per-video duration cap, ms (v0.4). 0 = play full length (v0.5). */
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
  private readonly nav: Navigator;
  private front = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private videoWatch: VideoWatch | null = null;
  private stopped = false;
  /** Bumped by every step; an in-flight step that lost the race aborts. */
  private seq = 0;

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
    this.nav = createNavigator(opts.playlist);
  }

  start(): void {
    void this.stepForward();
  }

  stop(): void {
    this.stopped = true;
    this.clearPending();
    for (const slot of this.slots) this.resetSlot(slot);
  }

  /** → skip ahead (forward history first, then fresh playlist items). */
  next(): void {
    void this.stepForward();
  }

  /** ← back through the history of shown items; no-op at the oldest entry. */
  previous(): void {
    void this.stepBackward();
  }

  /** ↑ back to the current moment's first shown item, or restart the slide. */
  restartMoment(): void {
    void this.stepMomentStart();
  }

  /** ↓ skip the rest of the current moment (plain next() outside moments). */
  skipMoment(): void {
    void this.stepForward(true);
  }

  /** Cancel whatever would advance the show next (timer or video watch). */
  private clearPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.videoWatch?.cancel();
    this.videoWatch = null;
  }

  /**
   * Load a candidate into the back slot and crossfade to it. Returns false
   * when it failed to load (caller tries the next candidate); true when it
   * is on screen OR the step was superseded/stopped (caller must bail).
   */
  private async tryShow(candidate: NavCandidate, seq: number): Promise<boolean> {
    const kind = mediaKindFromUrl(candidate.url) ?? 'photo';
    const back = this.slots[1 - this.front];
    const ok = await this.loadInto(back, candidate.url, kind);
    if (this.stopped || seq !== this.seq) return true; // superseded: stop looping
    if (!ok) {
      this.nav.failed(candidate);
      this.opts.log?.(`skipping unloadable ${kind}: ${candidate.url}`);
      return false;
    }
    this.nav.shown(candidate);
    this.clearPending();
    this.crossfade();
    this.opts.onShown?.(candidate.url);
    this.scheduleNext(kind, candidate.url);
    return true;
  }

  /**
   * Advance (auto-advance, → and ↓ share this path; ↓ first consumes the
   * rest of the current moment). One full failed pass stops the show.
   */
  private async stepForward(skipMoment = false): Promise<void> {
    if (this.stopped) return;
    const seq = ++this.seq;
    if (skipMoment) {
      const candidate = this.nav.momentSkip();
      if (candidate && (await this.tryShow(candidate, seq))) return;
      if (this.stopped || seq !== this.seq) return;
      // No moment to skip (or the landing item was unloadable): fall through
      // to plain forward stepping.
    }
    const attempts = Math.max(1, this.opts.playlist.size);
    for (let i = 0; i < attempts; i++) {
      if (await this.tryShow(this.nav.next(), seq)) return;
    }
    this.stop();
    this.opts.onAllFailed();
  }

  /** ← — replay history; entries that no longer load fall out of it. */
  private async stepBackward(): Promise<void> {
    if (this.stopped || this.nav.prev() === null) return; // nothing older
    const seq = ++this.seq;
    for (;;) {
      const candidate = this.nav.prev();
      if (candidate === null) {
        // Everything older failed to load; keep the current slide but give
        // it a fresh timer (the pending one was cleared by no one — only
        // tryShow clears — so this is just a defensive reschedule).
        this.restartCurrent(seq);
        return;
      }
      if (await this.tryShow(candidate, seq)) return;
      if (this.stopped || seq !== this.seq) return;
    }
  }

  /** ↑ — jump to the moment's first shown item, else restart the slide. */
  private async stepMomentStart(): Promise<void> {
    if (this.stopped) return;
    const seq = ++this.seq;
    for (;;) {
      const candidate = this.nav.momentStart();
      if (candidate === null) {
        this.restartCurrent(seq);
        return;
      }
      if (await this.tryShow(candidate, seq)) return;
      if (this.stopped || seq !== this.seq) return;
    }
  }

  /**
   * Restart the current slide's clock: photos get a fresh full timer,
   * videos rewind to the start with a fresh watch (shuffle-mode ↑).
   */
  private restartCurrent(seq: number): void {
    if (this.stopped || seq !== this.seq) return;
    const url = this.nav.current;
    if (url === null) return; // nothing on screen yet
    this.clearPending();
    const kind = mediaKindFromUrl(url) ?? 'photo';
    if (kind === 'video') {
      try {
        this.slots[this.front].video.currentTime = 0;
      } catch {
        // not seekable — the fresh watch below still restarts the cap clock
      }
    }
    this.scheduleNext(kind, url);
  }

  /** Photo: fixed timer. Video: play(), advance on ended/cap/error. */
  private scheduleNext(kind: MediaKind, url: string): void {
    if (kind === 'photo') {
      this.timer = setTimeout(() => void this.stepForward(), this.opts.slideDurationMs);
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
        void this.stepForward();
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
