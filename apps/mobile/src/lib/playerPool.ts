/**
 * The player pool (m0.9 phase 6, docs/AnimatedThumbnails_design.md D6):
 * a fixed set of expo-video players made once for a list and borrowed
 * by its cells — a cell entering the screen swaps its source into a
 * borrowed player, a cell leaving pauses it and hands it back — so a
 * scroll CREATES and DESTROYS nothing. Releasing players mid-scroll was
 * the lag spike the S23 showed under thermal load (2026-09-16); with
 * the pool the S10e's scripted 300-cell scroll has the same frame-time
 * percentiles with the cells playing and stopped.
 *
 * Every player carries a THUMBNAIL bound (D11 amended 2026-09-18):
 * muted, one second ahead and 4 MiB of samples — a cell shows a few
 * seconds of a clip at 120 dp, and the deck's 16 MiB times a dozen
 * players took the S23's Java heap down — no time-update ticks. Impure by nature (native players);
 * the sizing rule is pure in lib/animatedCells.ts.
 */
import { createVideoPlayer, type VideoPlayer } from 'expo-video';

/** The thumbnail bound: a second ahead, 4 MiB of samples (a dozen
 * players stay under 50 MB of Java heap together). */
const BUFFER_S = 1;
const BUFFER_BYTES = 4 * 1024 * 1024;

export interface PlayerPool {
  /** A free player, or null when every player is out (the pool was
   * sized for the geometry, so this is a logged surprise, not a case). */
  borrow(): VideoPlayer | null;
  /** Back to the pool, paused; a released pool takes nothing back. */
  giveBack(player: VideoPlayer): void;
  /** Releases every player; the pool is dead afterwards. */
  release(): void;
  readonly size: number;
}

export function makePlayerPool(size: number): PlayerPool {
  const all: VideoPlayer[] = [];
  for (let i = 0; i < size; i += 1) {
    const p = createVideoPlayer(null);
    p.muted = true;
    p.timeUpdateEventInterval = 0;
    p.bufferOptions = {
      preferredForwardBufferDuration: BUFFER_S,
      minBufferForPlayback: 0.5,
      maxBufferBytes: BUFFER_BYTES,
      prioritizeTimeOverSizeThreshold: false,
    };
    all.push(p);
  }
  const free = [...all];
  let released = false;
  return {
    size,
    borrow() {
      if (released) return null;
      const p = free.pop();
      if (p === undefined) {
        console.warn(`[thumbs] player pool of ${size} exhausted`);
        return null;
      }
      return p;
    },
    giveBack(player) {
      if (released) return;
      player.pause();
      player.muted = true;
      free.push(player);
    },
    release() {
      if (released) return;
      released = true;
      for (const p of all) p.release();
      all.length = 0;
      free.length = 0;
    },
  };
}
