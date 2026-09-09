/**
 * VideoPage — the deck pager's page for a VIDEO (m0.9 phase 5, M26
 * option B): the player IS the page, with the item's OS frame
 * (OsThumbnail) as its instant first paint underneath. One player per
 * mounted page (the pager keeps one page each side of the current one,
 * so at most three exist — the M26 measurement).
 *
 * Playback follows the Videos mode (lib/playbackPrefs, M5): `once` and
 * `loop` start muted when the page becomes ACTIVE (the pager settled on
 * it); `off` rests on the poster with a play control. Leaving the page
 * pauses, rewinds, and re-mutes — the speaker unmutes the CURRENT view
 * only (the media model). A video that played to its end rests on its
 * last frame with a replay control.
 *
 * Two chrome tiers (M4): on the deck stage a speaker toggle, a thin
 * non-interactive progress hairline and a play/replay control, all
 * rendered INSIDE this page so they travel with it; in the expanded
 * (immersive) stage expo-video's native controls supply the full
 * transport — scrubber, pause, speaker — and this page renders no
 * chrome and no press surface of its own, so the player's controller
 * owns every tap. The playback chrome is exempt from the eye (M21's
 * "functional labels never hideable" rule): it operates the video, it
 * does not annotate it.
 *
 * `surfaceType` is the M27 measurement's knob; it must not change at
 * runtime (expo-video's contract), so it is fixed per build.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer, type SurfaceType } from 'expo-video';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { OsThumbnail } from './OsThumbnail';
import { colors, useTheme } from '../theme';
import type { PlaybackMode } from '../lib/playbackPrefs';
import { versionedUri } from '../lib/imageKeys';

/** Progress ticks per second for the hairline — coarse on purpose (a
 * 2 dp line cannot show finer). */
const TIME_UPDATE_INTERVAL_S = 0.25;

export function VideoPage({
  id,
  kind,
  uri,
  version,
  width,
  posterPx,
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
  /** The pager has settled on this page. */
  active: boolean;
  mode: PlaybackMode;
  /** The expanded stage: native transport, no page chrome. */
  immersive: boolean;
  surfaceType: SurfaceType;
  /** The deck's stage tap (immersive toggle / double-tap zoom). */
  onPress?: (event: GestureResponderEvent) => void;
}) {
  const theme = useTheme();
  // The version rides the uri so an edited file is a new source to the
  // player (item 3's rule, same as expo-image).
  const player = useVideoPlayer({ uri: versionedUri(uri, version) }, (p) => {
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

  // The page's lifecycle: active + a playing mode → play; leaving →
  // pause, rewind, re-mute (the speaker is per view).
  useEffect(() => {
    if (active) {
      if (mode !== 'off') {
        setEnded(false);
        player.play();
      }
      return;
    }
    player.pause();
    player.currentTime = 0;
    player.muted = true;
    setEnded(false);
  }, [player, active, mode]);

  const duration = player.duration;
  const progress = duration > 0 ? Math.min(1, time.currentTime / duration) : 0;
  const showPlayControl = !immersive && (!isPlaying || ended);

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
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={immersive}
        surfaceType={surfaceType}
        fullscreenOptions={{ enable: false }}
      />
      {!immersive && (
        <>
          {showPlayControl && (
            <Pressable
              style={styles.playControl}
              onPress={() => {
                setEnded(false);
                if (ended) player.replay();
                else player.play();
              }}
              accessibilityLabel={ended ? 'Replay' : 'Play'}
            >
              <MaterialCommunityIcons
                name={ended ? 'replay' : 'play'}
                size={44}
                color={colors.text}
              />
            </Pressable>
          )}
          <Pressable
            style={styles.speaker}
            onPress={() => {
              player.muted = !player.muted;
            }}
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
          >
            <MaterialCommunityIcons
              name={muted ? 'volume-off' : 'volume-high'}
              size={22}
              color={colors.text}
            />
          </Pressable>
          <View style={styles.hairlineTrack} pointerEvents="none">
            <View
              style={[
                styles.hairline,
                { width: `${progress * 100}%`, backgroundColor: theme.accent },
              ]}
            />
          </View>
        </>
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

const styles = StyleSheet.create({
  playControl: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -36,
    marginTop: -36,
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  speaker: {
    position: 'absolute',
    right: 10,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hairlineTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  hairline: { height: 2 },
});
