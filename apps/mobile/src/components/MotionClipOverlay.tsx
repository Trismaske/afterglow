/**
 * MotionClipOverlay — a MOTION PHOTO's embedded clip over its still (m0.9
 * phase 5, F25/G6). The page stays the photo page (expo-image on the JPEG
 * primary, the region-zoom pipeline on the same bytes); this overlay is
 * the video half of the dual identity, with the SAME playback machinery
 * and chrome as a video (the media model): the shared PlaybackChrome on
 * the deck stage — speaker, hairline, play/replay — and expo-video's
 * native transport in the expanded stage.
 *
 * THE PLAYER BOUND (M26): like VideoPage, a native player exists only
 * while the page is NEAR (current or a neighbour) — the inner
 * `MotionClipPlayer` owns the player's lifetime and mounts when the
 * pager settles, never mid-touch. Within that layer the still ↔ playing
 * handoff is props only (opacity and the player's source).
 *
 * The clip plays from a run-scoped cache file (the module's
 * `extractMotionClip`: the last `length` bytes of the photo, copied once
 * per volume + id + version, swept at every process start). Extraction
 * failing leaves the still in place and logs once per item — the photo
 * is complete without its clip. The resolved source is TAGGED with the
 * identity it was extracted for: an in-place edit keeps this component
 * (the page is keyed by id) and must never play the previous version's
 * clip.
 *
 * Modes (M5, the Motion photos row): `once` plays muted on page settle
 * and rests on the still (the overlay fades out at the clip's end —
 * the still IS the chosen frame); `loop` keeps playing until the page
 * leaves; `off` shows the still with a play control. The clip starts
 * muted and the speaker unmutes the CURRENT view only, like a video.
 * Zoom always shows the still (G6, structural): the overlay's opacity
 * is driven from the stage's zoom scale on the UI thread — no bridge
 * crossing — so a pinch reveals the JPEG under the playing clip at once,
 * and the clip simply continues invisibly until it ends.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer, type SurfaceType } from 'expo-video';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { extractMotionClip } from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf, volumeOf } from '../lib/mediaIdentity';
import { PlaybackChrome } from './PlaybackChrome';
import { TIME_UPDATE_INTERVAL_S } from './VideoPage';
import type { PlaybackMode } from '../lib/playbackPrefs';
import type { MotionClipRow } from '../db/store';

const warnedIds = new Set<string>();

export function MotionClipOverlay(props: {
  id: string;
  clip: MotionClipRow;
  /** Current page or a neighbour (M26): only then does a player exist. */
  near: boolean;
  active: boolean;
  mode: PlaybackMode;
  immersive: boolean;
  surfaceType: SurfaceType;
  /** The stage's zoom scale (1 = unzoomed) — read on the UI thread. */
  zoomScale: SharedValue<number>;
}) {
  if (!props.near) return null;
  return <MotionClipPlayer {...props} />;
}

function MotionClipPlayer({
  id,
  clip,
  active,
  mode,
  immersive,
  surfaceType,
  zoomScale,
}: {
  id: string;
  clip: MotionClipRow;
  active: boolean;
  mode: PlaybackMode;
  immersive: boolean;
  surfaceType: SurfaceType;
  zoomScale: SharedValue<number>;
}) {
  const [source, setSource] = useState<{ key: string; uri: string } | null>(null);
  // The cache name carries the VOLUME: raw ids and generations are
  // allocated per volume, so primary and an SD card can share both.
  const clipKey = `${volumeOf(id)}-${rawIdOf(id)}-${clip.version}`;
  const sourceUri = source !== null && source.key === clipKey ? source.uri : null;
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
    // A looping player emits playToEnd on every wrap — only a Once play
    // has actually ended.
    const sub = player.addListener('playToEnd', () => {
      if (!player.loop) setEnded(true);
    });
    return () => sub.remove();
  }, [player]);

  // Resolve the clip file once per volume + id + version; swap the
  // source in place (props only).
  useEffect(() => {
    let cancelled = false;
    void extractMotionClip(
      canonicalContentUri(id, 'photo'),
      clip.offset,
      clip.length,
      clipKey,
    ).then(
      (fileUri) => {
        if (!cancelled) setSource({ key: clipKey, uri: fileUri });
      },
      (error) => {
        if (cancelled || warnedIds.has(id)) return;
        warnedIds.add(id);
        console.warn(`[motion] clip extraction failed for ${id}: ${String(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, clip.offset, clip.length, clip.version, clipKey]);
  useEffect(() => {
    player.replace(sourceUri !== null ? { uri: sourceUri } : null, true);
  }, [player, sourceUri]);
  useEffect(() => {
    player.loop = mode === 'loop';
  }, [player, mode]);

  // Active + a playing mode → play; a mode turned Off while active →
  // pause; leaving → pause, rewind, re-mute (the speaker is per view).
  useEffect(() => {
    if (active && sourceUri !== null) {
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
  }, [player, active, mode, sourceUri]);

  // The clip layer shows while playing (once → the still returns at the
  // end) and, in the expanded stage, whenever the page is active so the
  // native transport has something to operate; never while zoomed.
  const playingVisible = isPlaying && !ended;
  const layerVisible = playingVisible || (immersive && active && sourceUri !== null);
  // ONE opacity source: the zoom test runs on the UI thread, the visible
  // flag is captured as a dependency (JS → worklet closure, safe).
  const visibility = useAnimatedStyle(
    () => ({ opacity: layerVisible && zoomScale.value <= 1.001 ? 1 : 0 }),
    [layerVisible],
  );
  const duration = player.duration;
  const progress = duration > 0 ? Math.min(1, time.currentTime / duration) : 0;

  return (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, visibility]}
        // The native transport owns taps in the expanded stage; on the
        // deck stage the layer is inert under the page's own press.
        pointerEvents={immersive && layerVisible ? 'auto' : 'none'}
      >
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={immersive}
          surfaceType={surfaceType}
          fullscreenOptions={{ enable: false }}
        />
      </Animated.View>
      {!immersive && active && sourceUri !== null && (
        <PlaybackChrome
          showPlayControl={!playingVisible}
          ended={ended}
          muted={muted}
          progress={progress}
          playLabel="Play motion photo"
          onPlay={() => {
            setEnded(false);
            player.replay();
          }}
          onToggleMuted={() => {
            player.muted = !player.muted;
          }}
        />
      )}
    </>
  );
}
