/**
 * Playback — THE playback component (m0.9 phase 5): one expo-video
 * player over a source, its view, and its chrome, used unchanged by a
 * video page (over the OS frame's first paint) and by a motion photo's
 * clip overlay (over the still), on the deck stage and in the expanded
 * stage alike. Four scenarios, one code path: the S23's two passes
 * (2026-09-09, 09-10) found every divergence between the kinds and the
 * stages in duplicated lifecycles and a native controller that only one
 * stage used.
 *
 * THE LIFECYCLE (M5's modes, for both kinds):
 *  - `once` and `loop` start MUTED when the page becomes active; `off`
 *    rests on the first frame or the still (a mode turned Off while
 *    active pauses where it is).
 *  - Leaving the page pauses, rewinds, and re-mutes — the speaker
 *    unmutes the CURRENT view only.
 *  - A looping player reports playToEnd on every wrap: only a Once play
 *    has ended, and only then does the control read Replay.
 *  - The player is created WITH its source, never empty: a player
 *    prepared over an empty playlist reports playToEnd too (ExoPlayer's
 *    ENDED on an empty timeline), asynchronously, which read as Replay
 *    before a video's first play (the S23, 2026-09-10) — so a host
 *    mounts this component only once it knows the file, and keys it BY
 *    the file: a later source (an edited file) is a new instance with
 *    a new player and fresh state — expo's event snapshots survive a
 *    player swap inside one instance and would describe the old file.
 *    The M26 bound is the caller's too: it mounts this component only
 *    while the page is near.
 *
 * THE CHROME (M4, revised by the tester 2026-09-10): HIDDEN by default,
 * in both stages. A stage tap toggles it — the deck's press dispatches a
 * playable page's tap here, and `chromeVisible` is the deck's state, so
 * one page shows chrome at a time and a page change hides it. It
 * auto-hides after CHROME_HIDE_MS while the clip plays and stays while
 * paused or ended, so a stopped clip always offers its control. The
 * pieces: play / pause / replay in the centre, the speaker, expand or
 * collapse (immersive in and out — Back exits too), and a seek track
 * along the bottom (tap or drag; a JS responder, so the pager's scroll
 * stands down for it). The player VIEW never takes a tap
 * (`pointerEvents="none"`): the page's press beneath owns single and
 * double taps, the chrome's buttons above own theirs — the same tree in
 * both stages, which is what keeps a playing clip playing across the
 * immersive flip (a swapped root remounts the player).
 *
 * Exempt from the eye (M21's "functional labels never hideable"): this
 * chrome operates the clip, it does not annotate it.
 *
 * `surfaceType` is the M27 measurement's knob; it must not change at
 * runtime (expo-video's contract), so it is fixed per build.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView, type SurfaceType, type VideoPlayer } from 'expo-video';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, useTheme } from '../theme';
import type { PlaybackMode } from '../lib/playbackPrefs';

/** The chrome's life after a tap while the clip plays (tester's call,
 * 2026-09-10: Media3's 5 s hung around; YouTube sits near 3 s). */
export const CHROME_HIDE_MS = 2000;
/** Progress ticks per second for the seek track — coarse on purpose (a
 * 3 dp line cannot show finer). */
const TIME_UPDATE_INTERVAL_S = 0.25;

/** What the deck tells a playable page about its stage — one object
 * for both hosts, built per render by the deck. */
export interface PlaybackStage {
  /** The expanded stage: edge-to-edge, so the chrome keeps clear of the
   * OS navigation bar by `insetBottom`. */
  immersive: boolean;
  insetBottom: number;
  /** The deck's chrome state for THIS page (false on every other page). */
  chromeVisible: boolean;
  onChromeVisibleChange: (visible: boolean) => void;
  /** The chrome's expand and collapse buttons (the immersive flip). */
  onExpand: () => void;
  onCollapse: () => void;
}

export function Playback({
  source,
  active,
  mode,
  surfaceType,
  stage,
  restsOnStill = false,
  zoomScale,
  playLabel = 'Play',
}: {
  /** The playable file's uri (known before mount and the instance's
   * key — header). */
  source: string;
  /** The pager has settled on this page and the deck is visible. */
  active: boolean;
  mode: PlaybackMode;
  surfaceType: SurfaceType;
  stage: PlaybackStage;
  /** The host's own image is the resting frame (a motion photo's
   * still): the player view shows only while a play is underway. A
   * video's view is always shown over its poster. */
  restsOnStill?: boolean;
  /** The stage's zoom scale (1 = unzoomed): zoom shows the host's still
   * and no chrome — read on the UI thread, so a pinch reveals the still
   * at once (G6). */
  zoomScale?: SharedValue<number>;
  /** The accessibility label of a fresh play (Pause and Replay are fixed). */
  playLabel?: string;
}) {
  const theme = useTheme();
  const playback = usePlayer(source, active, mode);
  const { immersive, insetBottom, chromeVisible, onChromeVisibleChange, onExpand, onCollapse } =
    stage;

  // Auto-hide: only while playing; any chrome interaction restarts it.
  // The deck's callback is read through a ref so a deck re-render (a
  // fresh closure per page) never restarts the timer.
  const [interaction, setInteraction] = useState(0);
  const touched = useCallback(() => setInteraction((n) => n + 1), []);
  const hideRef = useRef(onChromeVisibleChange);
  hideRef.current = onChromeVisibleChange;
  useEffect(() => {
    if (!chromeVisible || !playback.isPlaying) return;
    const timer = setTimeout(() => hideRef.current(false), CHROME_HIDE_MS);
    return () => clearTimeout(timer);
  }, [chromeVisible, playback.isPlaying, interaction]);

  // ONE opacity rule on the UI thread: zoom hides the player view (the
  // still shows beneath) and the chrome; a still-resting host shows the
  // view only while a play is underway.
  const unzoomed = useSharedValue(1);
  const zoom = zoomScale ?? unzoomed;
  const viewShown = !restsOnStill || playback.underway;
  const viewStyle = useAnimatedStyle(
    () => ({ opacity: viewShown && zoom.value <= 1.001 ? 1 : 0 }),
    [viewShown],
  );
  const chromeStyle = useAnimatedStyle(() => ({ opacity: zoom.value <= 1.001 ? 1 : 0 }), []);

  const onCentre = useCallback(() => {
    touched();
    if (playback.isPlaying) playback.pause();
    else playback.play();
  }, [playback, touched]);
  const onSpeaker = useCallback(() => {
    touched();
    playback.toggleMuted();
  }, [playback, touched]);
  const onStage = useCallback(() => {
    touched();
    if (immersive) onCollapse();
    else onExpand();
  }, [immersive, onCollapse, onExpand, touched]);
  const onSeek = useCallback(
    (fraction: number) => {
      touched();
      playback.seek(fraction);
    },
    [playback, touched],
  );

  const centreIcon = playback.isPlaying ? 'pause' : playback.ended ? 'replay' : 'play';
  const centreLabel = playback.isPlaying ? 'Pause' : playback.ended ? 'Replay' : playLabel;
  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, viewStyle]} pointerEvents="none">
        <VideoView
          player={playback.player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          surfaceType={surfaceType}
          fullscreenOptions={{ enable: false }}
        />
      </Animated.View>
      {chromeVisible && (
        <Animated.View
          style={[StyleSheet.absoluteFill, chromeStyle]}
          pointerEvents="box-none"
          accessibilityLabel="Playback controls"
        >
          <Pressable style={styles.centre} onPress={onCentre} accessibilityLabel={centreLabel}>
            <MaterialCommunityIcons name={centreIcon} size={44} color={colors.text} />
          </Pressable>
          <SeekTrack
            progress={playback.progress}
            accent={theme.accent}
            insetBottom={insetBottom}
            onSeek={onSeek}
          />
          <Pressable
            style={[styles.button, { right: 58, bottom: 12 + insetBottom }]}
            onPress={onStage}
            accessibilityLabel={immersive ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <MaterialCommunityIcons
              name={immersive ? 'fullscreen-exit' : 'fullscreen'}
              size={24}
              color={colors.text}
            />
          </Pressable>
          <Pressable
            style={[styles.button, { right: 10, bottom: 12 + insetBottom }]}
            onPress={onSpeaker}
            accessibilityLabel={playback.muted ? 'Unmute' : 'Mute'}
          >
            <MaterialCommunityIcons
              name={playback.muted ? 'volume-off' : 'volume-high'}
              size={22}
              color={colors.text}
            />
          </Pressable>
        </Animated.View>
      )}
    </>
  );
}

interface PlayerState {
  player: VideoPlayer;
  isPlaying: boolean;
  /** A Once play reached its end: the control reads Replay. */
  ended: boolean;
  /** A play began and has neither ended nor been rewound — paused
   * mid-clip counts (the paused frame stays up). */
  underway: boolean;
  muted: boolean;
  /** 0–1 of the clip's duration. */
  progress: number;
  play: () => void;
  pause: () => void;
  toggleMuted: () => void;
  seek: (fraction: number) => void;
}

/** The lifecycle in the header, as one hook. */
function usePlayer(source: string, active: boolean, mode: PlaybackMode): PlayerState {
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
  const [underway, setUnderway] = useState(false);

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      if (player.loop) return;
      setEnded(true);
      setUnderway(false);
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    player.loop = mode === 'loop';
  }, [player, mode]);

  useEffect(() => {
    if (active) {
      if (mode === 'off') {
        player.pause();
        return;
      }
      setEnded(false);
      setUnderway(true);
      player.play();
      return;
    }
    player.pause();
    player.currentTime = 0;
    player.muted = true;
    setEnded(false);
    setUnderway(false);
  }, [player, active, mode, source]);

  const play = useCallback(() => {
    setEnded(false);
    setUnderway(true);
    if (ended) player.replay();
    else player.play();
  }, [player, ended]);
  const pause = useCallback(() => player.pause(), [player]);
  const toggleMuted = useCallback(() => {
    player.muted = !player.muted;
  }, [player]);
  const seek = useCallback(
    (fraction: number) => {
      const duration = player.duration;
      if (!(duration > 0)) return;
      player.currentTime = fraction * duration;
      // A seek leaves the ended state (ExoPlayer is READY again) and
      // shows the sought frame: the control reads Play, not Replay.
      setEnded(false);
      setUnderway(true);
    },
    [player],
  );

  const duration = player.duration;
  const progress = duration > 0 ? Math.min(1, time.currentTime / duration) : 0;
  return useMemo(
    () => ({
      player,
      isPlaying,
      ended,
      underway,
      muted,
      progress,
      play,
      pause,
      toggleMuted,
      seek,
    }),
    [player, isPlaying, ended, underway, muted, progress, play, pause, toggleMuted, seek],
  );
}

/** The seek track: a 3 dp line along the bottom edge inside a taller
 * touch band; tap or drag anywhere on the band seeks to that fraction,
 * and a seek on an ended clip resumes it (ExoPlayer's own semantic).
 * A JS responder, deliberately — the stage's rules forbid a Gesture
 * Handler pan beside the pager's native scroll (MediaStage.tsx: the
 * worklets crash class) — and one that blocks the native responder on
 * grant, so the pager stands down for the drag. The block lands one
 * bridge hop after touch-down: a thumb that starts a scrub is well
 * inside that (measured on the S10e, 2026-09-10: a 1.5 s drag seeks
 * continuously end to end), a flick that crosses the scroll slop within
 * ~10 ms pages instead — a flick IS the page gesture. */
function SeekTrack({
  progress,
  accent,
  insetBottom,
  onSeek,
}: {
  progress: number;
  accent: string;
  insetBottom: number;
  onSeek: (fraction: number) => void;
}) {
  const width = useRef(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const responder = useMemo(() => {
    const seekAt = (event: GestureResponderEvent) => {
      if (width.current <= 0) return;
      const fraction = Math.min(1, Math.max(0, event.nativeEvent.locationX / width.current));
      setScrub(fraction);
      onSeek(fraction);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: seekAt,
      onPanResponderMove: seekAt,
      onPanResponderRelease: () => setScrub(null),
      onPanResponderTerminate: () => setScrub(null),
    });
  }, [onSeek]);
  const shown = scrub ?? progress;
  return (
    <View
      {...responder.panHandlers}
      style={[styles.seekBand, { bottom: insetBottom }]}
      onLayout={(event: LayoutChangeEvent) => {
        width.current = event.nativeEvent.layout.width;
      }}
      accessibilityLabel="Seek"
    >
      <View style={styles.seekTrack}>
        <View style={[styles.seekFill, { width: `${shown * 100}%`, backgroundColor: accent }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
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
  button: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  seekBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 28,
    justifyContent: 'flex-end',
  },
  seekTrack: { height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  seekFill: { height: 3 },
});
