/**
 * usePlaybackPlayer — THE playback lifecycle (m0.9 phase 5), shared by a
 * video page and a motion photo's clip overlay because the media model
 * gives both kinds the same playback machinery: one expo-video player
 * over a source, driven by the page's `active` flag and its kind's mode
 * (lib/playbackPrefs, M5), reporting the facts the deck-tier chrome
 * renders (PlaybackChrome) and the two things a user can do to it.
 *
 * Rules, once, for both kinds:
 *  - `once` and `loop` start MUTED when the page becomes active; `off`
 *    rests on the poster/still (a mode turned Off while active pauses
 *    where it is).
 *  - Leaving the page pauses, rewinds, and re-mutes — the speaker
 *    unmutes the CURRENT view only.
 *  - A looping player reports playToEnd on every wrap: only a Once play
 *    has ended, and only then does the control read Replay.
 *  - The source is swapped in place (`player.replace`) — props only, the
 *    player object is stable for the component's life (the M26 bound is
 *    the caller's: it mounts this hook's owner only while the page is
 *    near).
 *
 * Every divergence between the two kinds' behaviour (the S23 pass of
 * 2026-09-09: a video's tap not entering immersive, a motion photo's
 * transport dead) came from duplicated lifecycles — this hook is the
 * one place that can drift now.
 */
import { useCallback, useEffect, useState } from 'react';
import { useEvent } from 'expo';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import type { PlaybackMode } from '../lib/playbackPrefs';

/** Progress ticks per second for the hairline — coarse on purpose (a
 * 2 dp line cannot show finer). */
const TIME_UPDATE_INTERVAL_S = 0.25;

export interface PlaybackState {
  player: VideoPlayer;
  isPlaying: boolean;
  /** A Once play reached its end (the still returns / the last frame
   * holds; the control reads Replay). */
  ended: boolean;
  /** The props PlaybackChrome renders from — one wiring for both kinds. */
  chrome: {
    showPlayControl: boolean;
    ended: boolean;
    muted: boolean;
    progress: number;
    onPlay: () => void;
    onToggleMuted: () => void;
  };
}

export function usePlaybackPlayer({
  source,
  active,
  mode,
}: {
  /** The playable file's uri, or null while it is not yet known (a
   * motion clip still extracting) or the page is not near. */
  source: string | null;
  /** The pager has settled on this page and the deck is visible. */
  active: boolean;
  mode: PlaybackMode;
}): PlaybackState {
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.loop = mode === 'loop';
    p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { muted } = useEvent(player, 'mutedChange', { muted: player.muted });
  const time = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      if (!player.loop) setEnded(true);
    });
    return () => sub.remove();
  }, [player]);

  // The source swaps in place; a null source releases the decoder.
  useEffect(() => {
    player.replace(source !== null ? { uri: source } : null, true);
  }, [player, source]);

  useEffect(() => {
    player.loop = mode === 'loop';
  }, [player, mode]);

  useEffect(() => {
    if (active && source !== null) {
      if (mode === 'off') {
        player.pause();
        return;
      }
      setEnded(false);
      player.play();
      return;
    }
    player.pause();
    player.currentTime = 0;
    player.muted = true;
    setEnded(false);
  }, [player, active, mode, source]);

  const onPlay = useCallback(() => {
    setEnded(false);
    if (ended) player.replay();
    else player.play();
  }, [player, ended]);
  const onToggleMuted = useCallback(() => {
    player.muted = !player.muted;
  }, [player]);

  const duration = player.duration;
  const progress = duration > 0 ? Math.min(1, time.currentTime / duration) : 0;
  return {
    player,
    isPlaying,
    ended,
    chrome: {
      showPlayControl: !isPlaying || ended,
      ended,
      muted,
      progress,
      onPlay,
      onToggleMuted,
    },
  };
}
