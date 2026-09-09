/**
 * VideoPage — the deck pager's page for a VIDEO (m0.9 phase 5, M26
 * option B): the player IS the page, with the item's OS frame
 * (OsThumbnail) as its instant first paint underneath.
 *
 * THE PLAYER BOUND (M26, enforced here, not trusted to FlatList's
 * window): a native player and its view exist only while the page is
 * NEAR — the current page or one of its two neighbours — so at most
 * three exist whatever the list keeps mounted (its initial render
 * retains its first cells). A far page is its poster alone. The inner
 * `VideoPlayerLayer` owns the player's whole lifetime; it mounts when a
 * page becomes near, which happens when the pager settles on a new
 * index (the same moment the list itself mounts pages), never mid-touch.
 *
 * Playback follows the Videos mode (lib/playbackPrefs, M5): `once` and
 * `loop` start muted when the page becomes ACTIVE (the pager settled on
 * it and the deck is the visible screen); `off` rests on the poster
 * with a play control, and a mode turning Off pauses a playing clip.
 * Leaving the page pauses, rewinds, and re-mutes — the speaker unmutes
 * the CURRENT view only (the media model). A video that played to its
 * end rests on its last frame with a replay control.
 *
 * Two chrome tiers (M4): on the deck stage the shared PlaybackChrome
 * (speaker, hairline, play/replay), rendered INSIDE this page so it
 * travels with it; in the expanded (immersive) stage expo-video's
 * native controls supply the full transport and this page renders no
 * chrome and no press surface of its own, so the player's controller
 * owns every tap.
 *
 * `surfaceType` is the M27 measurement's knob; it must not change at
 * runtime (expo-video's contract), so it is fixed per build.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer, type SurfaceType } from 'expo-video';
import { OsThumbnail } from './OsThumbnail';
import { PlaybackChrome } from './PlaybackChrome';
import type { PlaybackMode } from '../lib/playbackPrefs';
import { versionedUri } from '../lib/imageKeys';

/** Progress ticks per second for the hairline — coarse on purpose (a
 * 2 dp line cannot show finer). */
export const TIME_UPDATE_INTERVAL_S = 0.25;

export function VideoPage({
  id,
  kind,
  uri,
  version,
  width,
  posterPx,
  near,
  active,
  mode,
  immersive,
  surfaceType,
  onPress,
}: {
  id: string;
  kind: 'video';
  uri: string;
  version: number;
  width: number;
  /** The poster's OS-thumbnail bucket (the stage's first-paint size). */
  posterPx: number;
  /** The current page or its neighbour (M26): only then does a player
   * exist. */
  near: boolean;
  /** The pager has settled on this page and the deck is visible. */
  active: boolean;
  mode: PlaybackMode;
  /** The expanded stage: native transport, no page chrome. */
  immersive: boolean;
  surfaceType: SurfaceType;
  /** The deck's stage tap (immersive toggle / double-tap zoom). */
  onPress?: (event: GestureResponderEvent) => void;
}) {
  const body = (
    <View style={{ width, height: '100%' }}>
      <OsThumbnail
        assetId={id}
        kind={kind}
        uri={uri}
        version={version}
        px={posterPx}
        contentFit="contain"
        style={StyleSheet.absoluteFill}
      />
      {near && (
        <VideoPlayerLayer
          // The version rides the uri so an edited file is a new source
          // (item 3's rule, same as expo-image).
          source={versionedUri(uri, version)}
          active={active}
          mode={mode}
          immersive={immersive}
          surfaceType={surfaceType}
        />
      )}
    </View>
  );
  // In immersive mode the native controller owns every tap; the deck's
  // stage press would flip immersive off on the first touch.
  if (immersive || !onPress) return body;
  return (
    <Pressable style={{ width, height: '100%' }} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** The player's whole lifetime — exists only while the page is near. */
function VideoPlayerLayer({
  source,
  active,
  mode,
  immersive,
  surfaceType,
}: {
  source: string;
  active: boolean;
  mode: PlaybackMode;
  immersive: boolean;
  surfaceType: SurfaceType;
}) {
  const player = useVideoPlayer({ uri: source }, (p) => {
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
  useEffect(() => {
    player.loop = mode === 'loop';
  }, [player, mode]);

  // The page's lifecycle: active + a playing mode → play; a mode turned
  // Off while active → pause where it is; leaving → pause, rewind,
  // re-mute (the speaker is per view).
  useEffect(() => {
    if (active) {
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
  }, [player, active, mode]);

  const duration = player.duration;
  const progress = duration > 0 ? Math.min(1, time.currentTime / duration) : 0;
  return (
    <>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={immersive}
        surfaceType={surfaceType}
        fullscreenOptions={{ enable: false }}
      />
      {!immersive && (
        <PlaybackChrome
          showPlayControl={!isPlaying || ended}
          ended={ended}
          muted={muted}
          progress={progress}
          onPlay={() => {
            setEnded(false);
            if (ended) player.replay();
            else player.play();
          }}
          onToggleMuted={() => {
            player.muted = !player.muted;
          }}
        />
      )}
    </>
  );
}
