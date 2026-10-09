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
 *  - THE BUFFER BOUND: ExoPlayer's sample buffers are JAVA byte arrays,
 *    and Media3's default load control fills up to ~128 MB of them per
 *    player for video — three players (the M26 bound) over the S23's
 *    4K camera clips took the 256 MB Java heap down in seconds (three
 *    OutOfMemoryError tombstones, 2026-09-13). Every player is bounded
 *    to PLAYBACK_BUFFER_S ahead and PLAYBACK_BUFFER_BYTES of samples:
 *    a local file refills at disk speed, so a few seconds is plenty,
 *    and three players stay under 50 MB together.
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
 * pieces: play / pause / replay in the centre, STOP on the bottom row's
 * left while a play is underway (the tester, 2026-09-25: a looping motion
 * photo never showed its still — stop rewinds and rests the clip on it,
 * a video on its first frame, and Play starts it over), the speaker,
 * expand or collapse (immersive in and out — Back exits too), and the seek track
 * grown to its touch form on the bottom edge with the buttons above it
 * (tap or drag; a JS responder, so the pager's scroll stands down for
 * it). A DRAG runs the player in Media3's scrubbing mode for its
 * duration (the tester, 2026-09-14: frame-exact seeks on a 4K clip
 * queued behind the finger and read as a pause): the picture follows
 * the finger — seeks coalesce so only the newest target renders, the
 * codec rate rises, flushes are skipped, and normal playback is
 * suppressed until the release, which seeks exactly to the landing
 * fraction and turns the mode off, so a playing clip plays on from
 * there with no gap and a paused one stays paused. While a scrub is underway the REST of the chrome — this
 * component's and the deck's stage chrome — hides (the tester's call
 * 2026-09-14, YouTube's idiom): nothing else can be reached during a
 * scrub anyway, and the bar alone reads as the scrub. The seek track's
 * THIN form — a hairline of progress along the bottom edge — shows
 * whenever the player view does, chrome or not (YouTube's idiom, the
 * tester's call 2026-09-13); the touch form thickens it in place. The
 * player VIEW never takes a tap (`pointerEvents="none"`): the page's
 * press beneath owns single and double taps, the chrome's buttons above
 * own theirs — the same tree in both stages, which is what keeps a
 * playing clip playing across the immersive flip (a swapped root
 * remounts the player).
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
import { colors, radius, scrim, useTheme } from '../theme';
import type { PlaybackMode } from '../lib/playbackPrefs';

/** The chrome's life after a tap while the clip plays (tester's call,
 * 2026-09-10: Media3's 5 s hung around; YouTube sits near 3 s). */
export const CHROME_HIDE_MS = 2000;
/** Progress ticks per second for the seek track — coarse on purpose (a
 * hairline cannot show finer). */
const TIME_UPDATE_INTERVAL_S = 0.25;
/** A seek's target stands in for the reported time until a tick lands
 * within this fraction of it, or SEEK_SETTLE_TICKS ticks have passed.
 * expo-video posts the seek to the main thread while its clock's next
 * tick may already be queued ahead of it (IntervalUpdateClock: the
 * clock runs paused or playing), so exactly one stale tick — the
 * pre-seek position — can arrive after a seek; shown, it snapped the
 * thumb back on every release (S23, 2026-09-14). ExoPlayer masks the
 * position at the target from the seek call on, so the tick after that
 * one agrees. */
const SEEK_SETTLE_FRACTION = 0.02;
const SEEK_SETTLE_TICKS = 2;
/** The seek tolerance while a finger DRAGS the track (seconds each way):
 * the player may land on the nearest keyframe inside it instead of
 * decoding from the previous keyframe to the exact frame, so each step
 * under the finger is cheap; the release seeks exactly. Camera clips
 * keep keyframes about a second apart, so half a second finds one from
 * most positions. */
const SCRUB_SEEK_TOLERANCE_S = 0.5;
/** The buffer bound (header): seconds ahead and bytes of samples per
 * player. 16 MiB holds ~3 s of a 45 Mbps 4K clip and ~90 s of 1080p. */
const PLAYBACK_BUFFER_S = 4;
const PLAYBACK_BUFFER_BYTES = 16 * 1024 * 1024;

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
  /** A scrub on the seek track began or ended: the deck hides its own
   * stage chrome for the scrub's duration (header). */
  onScrubbingChange: (scrubbing: boolean) => void;
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
  peek = false,
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
  /** The host is showing its still over the clip for a moment (a
   * motion photo's hold-to-peek): the view hides, the clip plays on. */
  peek?: boolean;
}) {
  const theme = useTheme();
  const playback = usePlayer(source, active, mode);
  const {
    immersive,
    insetBottom,
    chromeVisible,
    onChromeVisibleChange,
    onExpand,
    onCollapse,
    onScrubbingChange,
  } = stage;

  // Auto-hide: only while playing; any chrome interaction restarts it.
  // The deck's callback is read through a ref so a deck re-render (a
  // fresh closure per page) never restarts the timer.
  const [interaction, setInteraction] = useState(0);
  const touched = useCallback(() => setInteraction((n) => n + 1), []);
  // A finger DOWN on a button suspends the auto-hide until it lifts
  // (codex): a hold longer than the timer must not unmount the button
  // under the press it is about to deliver.
  const [pressing, setPressing] = useState(false);
  const pressIn = useCallback(() => {
    setPressing(true);
    touched();
  }, [touched]);
  const pressOut = useCallback(() => {
    setPressing(false);
    touched();
  }, [touched]);
  const hideRef = useRef(onChromeVisibleChange);
  hideRef.current = onChromeVisibleChange;
  // A scrub underway: the rest of the chrome hides (header) and the
  // auto-hide waits — a finger resting on the thumb must not lose its
  // track. The deck is told through a ref so a page re-render never
  // re-fires it; an end is reported once, from release, from the chrome
  // hiding under the scrub, or from unmount.
  const [scrubbing, setScrubbing] = useState(false);
  const scrubRef = useRef(onScrubbingChange);
  scrubRef.current = onScrubbingChange;
  const playerScrubRef = useRef(playback.scrub);
  playerScrubRef.current = playback.scrub;
  /** The last fraction a drag reached (every drag step comes through
   * `onSeek`): the landing when the chrome hides under the scrub and
   * the track goes with it before its release can report one. */
  const landingRef = useRef<number | undefined>(undefined);
  const onScrubbing = useCallback(
    (underway: boolean, fraction?: number) => {
      setScrubbing(underway);
      if (underway) landingRef.current = undefined;
      playerScrubRef.current(underway, fraction ?? landingRef.current);
      scrubRef.current(underway);
      touched();
    },
    [touched],
  );
  const scrubbingRef = useRef(false);
  scrubbingRef.current = scrubbing;
  useEffect(() => {
    if (chromeVisible || !scrubbingRef.current) return;
    setScrubbing(false);
    playerScrubRef.current(false, landingRef.current);
    scrubRef.current(false);
  }, [chromeVisible]);
  useEffect(
    () => () => {
      // The player is released with this component (its hook's own
      // cleanup ran first), so only the deck is told; the scrubbing
      // mode dies with the player.
      if (scrubbingRef.current) scrubRef.current(false);
    },
    [],
  );
  useEffect(() => {
    if (!chromeVisible || !playback.isPlaying || scrubbing || pressing) return;
    const timer = setTimeout(() => hideRef.current(false), CHROME_HIDE_MS);
    return () => clearTimeout(timer);
  }, [chromeVisible, playback.isPlaying, interaction, scrubbing, pressing]);

  // ONE opacity rule on the UI thread: zoom hides the player view (the
  // still shows beneath) and the chrome; a still-resting host shows the
  // view only while a play is underway.
  const unzoomed = useSharedValue(1);
  const zoom = zoomScale ?? unzoomed;
  const viewShown = (!restsOnStill || playback.underway) && !peek;
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
  const onStop = useCallback(() => {
    touched();
    playback.stop();
  }, [playback, touched]);
  const onStage = useCallback(() => {
    touched();
    if (immersive) onCollapse();
    else onExpand();
  }, [immersive, onCollapse, onExpand, touched]);
  const onSeek = useCallback(
    (fraction: number) => {
      touched();
      landingRef.current = fraction;
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
        {!chromeVisible && (
          <SeekTrack
            progress={playback.progress}
            accent={theme.accent}
            insetBottom={insetBottom}
            expanded={false}
          />
        )}
      </Animated.View>
      {chromeVisible && (
        <Animated.View
          style={[StyleSheet.absoluteFill, chromeStyle]}
          pointerEvents="box-none"
          accessibilityLabel="Playback controls"
        >
          {!scrubbing && (
            <Pressable
              style={styles.centre}
              onPressIn={pressIn}
              onPressOut={pressOut}
              onPress={onCentre}
              accessibilityLabel={centreLabel}
            >
              <MaterialCommunityIcons name={centreIcon} size={44} color={colors.text} />
            </Pressable>
          )}
          <SeekTrack
            progress={playback.progress}
            accent={theme.accent}
            insetBottom={insetBottom}
            expanded
            onSeek={onSeek}
            onScrubbing={onScrubbing}
          />
          {!scrubbing && (playback.underway || playback.isPlaying) && (
            <Pressable
              style={[styles.button, { right: 106, bottom: STAGE_BOTTOM_ROW + insetBottom }]}
              onPressIn={pressIn}
              onPressOut={pressOut}
              onPress={onStop}
              accessibilityLabel="Stop"
            >
              <MaterialCommunityIcons name="stop" size={24} color={colors.text} />
            </Pressable>
          )}
          {!scrubbing && (
            <Pressable
              style={[styles.button, { right: 58, bottom: STAGE_BOTTOM_ROW + insetBottom }]}
              onPressIn={pressIn}
              onPressOut={pressOut}
              onPress={onStage}
              accessibilityLabel={immersive ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <MaterialCommunityIcons
                name={immersive ? 'fullscreen-exit' : 'fullscreen'}
                size={24}
                color={colors.text}
              />
            </Pressable>
          )}
          {!scrubbing && (
            <Pressable
              style={[styles.button, { right: 10, bottom: STAGE_BOTTOM_ROW + insetBottom }]}
              onPressIn={pressIn}
              onPressOut={pressOut}
              onPress={onSpeaker}
              accessibilityLabel={playback.muted ? 'Unmute' : 'Mute'}
            >
              <MaterialCommunityIcons
                name={playback.muted ? 'volume-off' : 'volume-high'}
                size={22}
                color={colors.text}
              />
            </Pressable>
          )}
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
  /** Rewind and rest: the still (a motion photo) or the first frame (a
   * video); the next Play starts over. */
  stop: () => void;
  toggleMuted: () => void;
  seek: (fraction: number) => void;
  /** A drag on the track began (true) or ended (false, with the landing
   * fraction) — the scrubbing mode in the header. */
  scrub: (underway: boolean, fraction?: number) => void;
}

/** The lifecycle in the header, as one hook. */
function usePlayer(source: string, active: boolean, mode: PlaybackMode): PlayerState {
  const player = useVideoPlayer({ uri: source }, (p) => {
    p.muted = true;
    p.loop = mode === 'loop';
    p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
    p.bufferOptions = {
      preferredForwardBufferDuration: PLAYBACK_BUFFER_S,
      minBufferForPlayback: 1,
      maxBufferBytes: PLAYBACK_BUFFER_BYTES,
      prioritizeTimeOverSizeThreshold: false,
    };
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
  /** The last seek's target while the ticks have not caught up with it
   * (SEEK_SETTLE_FRACTION). */
  const [sought, setSought] = useState<{ fraction: number; ticks: number } | null>(null);
  useEffect(() => {
    setSought((pending) => {
      if (pending === null) return null;
      const duration = player.duration;
      const reported = duration > 0 ? time.currentTime / duration : 0;
      const ticks = pending.ticks + 1;
      if (Math.abs(reported - pending.fraction) <= SEEK_SETTLE_FRACTION) return null;
      if (ticks >= SEEK_SETTLE_TICKS) return null;
      return { fraction: pending.fraction, ticks };
    });
  }, [player, time]);

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
    setSought(null);
  }, [player, active, mode, source]);

  const play = useCallback(() => {
    setEnded(false);
    setUnderway(true);
    if (ended) player.replay();
    else player.play();
  }, [player, ended]);
  const pause = useCallback(() => player.pause(), [player]);
  const stop = useCallback(() => {
    player.pause();
    player.currentTime = 0;
    setEnded(false);
    setUnderway(false);
    setSought(null);
  }, [player]);
  const toggleMuted = useCallback(() => {
    player.muted = !player.muted;
  }, [player]);
  const seek = useCallback(
    (fraction: number) => {
      const duration = player.duration;
      if (!(duration > 0)) return;
      player.currentTime = fraction * duration;
      setSought({ fraction, ticks: 0 });
      // A seek leaves the ended state (ExoPlayer is READY again) and
      // shows the sought frame: the control reads Play, not Replay.
      setEnded(false);
      setUnderway(true);
    },
    [player],
  );
  const scrub = useCallback(
    (underway: boolean, fraction?: number) => {
      if (underway) {
        player.seekTolerance = {
          toleranceBefore: SCRUB_SEEK_TOLERANCE_S,
          toleranceAfter: SCRUB_SEEK_TOLERANCE_S,
        };
        player.scrubbingModeOptions = { scrubbingModeEnabled: true };
        return;
      }
      // The setters post to the player's thread in order: exact
      // tolerance, the landing seek, then the mode off — playback
      // resumes at the landing frame, never at the last cheap step. A
      // page that went INACTIVE under the scrub has just been paused
      // and rewound by the effect above (the page change hid the chrome
      // and ended the scrub): its landing must not undo that.
      player.seekTolerance = { toleranceBefore: 0, toleranceAfter: 0 };
      if (fraction !== undefined && active) seek(fraction);
      player.scrubbingModeOptions = { scrubbingModeEnabled: false };
    },
    [player, seek, active],
  );

  const duration = player.duration;
  const progress =
    sought !== null ? sought.fraction : duration > 0 ? Math.min(1, time.currentTime / duration) : 0;
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
      stop,
      toggleMuted,
      seek,
      scrub,
    }),
    [
      player,
      isPlaying,
      ended,
      underway,
      muted,
      progress,
      play,
      pause,
      stop,
      toggleMuted,
      seek,
      scrub,
    ],
  );
}

/** The seek track, two forms along the bottom edge. THIN (chrome
 * hidden): a 2 dp hairline of progress, inert. EXPANDED (chrome shown):
 * the SAME full-width line grown to three times its height in place,
 * its bottom still on the stage edge, and a thumb: a HALF disc
 * standing on the line, its flat side on the track's top edge (the
 * tester, 2026-09-27: a whole dot touching the line only at its bottom
 * read wrong; the track never lifts or narrows, 2026-09-25). The thumb's
 * centre is clamped a radius in from either end so it stays whole at
 * 0 and 1, and the fill's front is the dome's front the whole way. A taller touch band
 * above the line; tap or drag anywhere on the band seeks to that fraction,
 * and a seek on an ended clip resumes it (ExoPlayer's own semantic).
 * A JS responder, deliberately — the stage's rules forbid a Gesture
 * Handler pan beside the pager's native scroll (MediaStage.tsx: the
 * worklets crash class) — and one that blocks the native responder on
 * grant, so the pager stands down for the drag. The block lands one
 * frame after touch-down (a Fabric mount item), and a first move that
 * crosses the scroll view's slop before it is taken by the pager too;
 * the deck closes that gap by disabling the pager's scroll for the
 * scrub's duration and asserting the page back at its end
 * (DeckScreen's `onScrubbingChange`). A touch that starts on the band
 * is a seek, never a page — the tester's rule (2026-09-14): nothing
 * else is reachable while seeking. */
function SeekTrack({
  progress,
  accent,
  insetBottom,
  expanded,
  onSeek,
  onScrubbing,
}: {
  progress: number;
  accent: string;
  insetBottom: number;
  expanded: boolean;
  onSeek?: (fraction: number) => void;
  /** A scrub began (true, on the grant) or ended (false, on release or
   * termination). */
  onScrubbing?: (underway: boolean, fraction?: number) => void;
}) {
  const width = useRef(0);
  /** The band's left edge in PAGE coordinates, taken at the grant: the
   * touch-down's target is the band itself (its children are never
   * targets), so pageX − locationX is exactly it. Every move maps
   * `pageX` against this edge, never `locationX`: Android re-resolves
   * the view UNDER THE FINGER on every move and reports locationX
   * relative to THAT view (JSTouchDispatcher, TouchesHelper), so a
   * finger crossing a button or the badge pill mid-scrub jumped the
   * fraction into that element's coordinates and back out (S23,
   * 2026-09-14). */
  const pageLeft = useRef(0);
  const [scrub, setScrub] = useState<number | null>(null);
  /** The last fraction the finger reached — the landing on release. */
  const landing = useRef<number | undefined>(undefined);
  const responder = useMemo(() => {
    const seekAt = (pageX: number) => {
      // The painted track is the band's full width, but the finger maps
      // the THUMB's travel — a radius in from either end — so a grab on
      // the thumb at 0 or at 1 moves nothing until the finger does
      // (codex); a touch past the travel clamps to the end.
      const travel = width.current - 2 * SEEK_THUMB_R;
      if (travel <= 0) return;
      const fraction = Math.min(1, Math.max(0, (pageX - pageLeft.current - SEEK_THUMB_R) / travel));
      landing.current = fraction;
      setScrub(fraction);
      onSeek?.(fraction);
    };
    const end = () => {
      setScrub(null);
      onScrubbing?.(false, landing.current);
      landing.current = undefined;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        pageLeft.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
        landing.current = undefined;
        onScrubbing?.(true);
        seekAt(event.nativeEvent.pageX);
      },
      onPanResponderMove: (event: GestureResponderEvent) => seekAt(event.nativeEvent.pageX),
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, [onSeek, onScrubbing]);
  const shown = scrub ?? progress;
  const [bandWidth, setBandWidth] = useState(0);
  // The thumb's centre rides the same TRAVEL the finger maps (seekAt): a
  // radius in from either end, so a grab lands where the dot is painted
  // and the dot stays whole at 0 and at 1. The fill beneath is the full
  // width, so its end and the dot's centre part by up to a radius.
  const thumbLeft = SEEK_THUMB_R + shown * Math.max(0, bandWidth - 2 * SEEK_THUMB_R);
  if (!expanded) {
    return (
      <View style={[styles.seekHairline, { bottom: insetBottom }]} pointerEvents="none">
        <View style={[styles.seekFill, { width: `${shown * 100}%`, backgroundColor: accent }]} />
      </View>
    );
  }
  return (
    <View
      {...responder.panHandlers}
      style={[styles.seekBand, { bottom: insetBottom }]}
      onLayout={(event: LayoutChangeEvent) => {
        width.current = event.nativeEvent.layout.width;
        setBandWidth(event.nativeEvent.layout.width);
      }}
      accessibilityLabel="Seek"
    >
      {/* Never touch targets: the grant's page-edge arithmetic above
          needs the band itself to be what the touch lands on. */}
      <View style={styles.seekTrack} pointerEvents="none">
        {/* The fill's FRONT is the dome's front (the tester, 2026-09-28):
            it ends at the dome's leading edge the whole way, so at 0 it
            sits under the whole dome and at 1 it reaches the end. */}
        <View
          style={[styles.seekFill, { width: thumbLeft + SEEK_THUMB_R, backgroundColor: accent }]}
        />
      </View>
      <View
        style={[styles.seekThumb, { left: thumbLeft, backgroundColor: accent }]}
        pointerEvents="none"
      />
    </View>
  );
}

/** The hairline's height; the expanded track is 3× and its thumb 9×.
 * The expanded track sits a thumb's radius up from the stage edge and
 * is inset by it at both ends, so the whole circle stays inside the
 * stage's clipped box — the hairline thickens (nearly) in place. */
const SEEK_LINE = 2;
const SEEK_THUMB_R = (SEEK_LINE * 9) / 2;
/** The touch band: from the stage edge up, twice the thumb's diameter,
 * so a touch aimed at the thumb lands inside it up to a thumb's
 * diameter high. Its lower part is where the hairline lives — the
 * touch form is the hairline's own place (the tester, 2026-09-14: the
 * earlier float read as a jump away from it). */
// The band is exactly the line and the dome standing on it: the
// buttons' row sits a few dp above it (the tester, 2026-09-27/28), and
// a touch that starts on the band still seeks, never pages or presses —
// so the band and the buttons never overlap (codex).
const SEEK_BAND_HEIGHT = SEEK_LINE * 3 + SEEK_THUMB_R;
/** The chrome's buttons (speaker, expand) sit ABOVE the band, never on
 * it: a later sibling wins any shared strip, and a band whose edge ran
 * into the buttons' row put a thumb-aimed touch that landed low near
 * the right end on the Fullscreen button — its press flipped immersive
 * and its drag, unblocked, paged (S23, 2026-09-14). */
const BUTTON_SIZE = 40;
/** The bottom edge of EVERYTHING at the stage's foot: the buttons, the
 * deck's badge pill and the stage's zoom notice all rest on this line,
 * a few dp above the dome's top, so nothing overlaps the track and the
 * foot reads as one row close to the bar (the tester's calls,
 * 2026-09-14 and 2026-09-28). The band beneath still owns any touch
 * that starts on it. */
export const STAGE_BOTTOM_ROW = SEEK_BAND_HEIGHT + 4;
/** The row's right end the buttons take (speaker at 10, expand at 58,
 * each BUTTON_SIZE wide, plus a gap): what the deck's badge pill must
 * leave free so a full badge set wraps upward instead of running under
 * the Fullscreen button on a narrow stage (codex, 2026-09-14). */
export const STAGE_BOTTOM_ROW_BUTTONS = 106 + BUTTON_SIZE + 8;

const styles = StyleSheet.create({
  centre: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -36,
    marginTop: -36,
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: scrim.mark,
  },
  button: {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: scrim.mark,
  },
  seekBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: SEEK_BAND_HEIGHT,
    // The track's bottom on the stage edge, like the hairline's.
    justifyContent: 'flex-end',
  },
  seekHairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: SEEK_LINE,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  seekTrack: { height: SEEK_LINE * 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  seekFill: { height: '100%' },
  seekThumb: {
    position: 'absolute',
    // A half disc standing ON the line: its flat side on the track's
    // top edge, so the whole dome reads and takes the finger; no rim —
    // the dome and the fill's front are one shape (the tester,
    // 2026-09-27/28). It overlaps the fill by 1 dp: at a density that
    // puts 9 dp on a half pixel (the S23 at 560 dpi) the two edges
    // otherwise anti-alias into a seam under the dome (Tristan,
    // 2026-10-09); the fill under the dome is the dome's own colour.
    bottom: SEEK_LINE * 3 - 1,
    marginLeft: -SEEK_THUMB_R,
    width: SEEK_THUMB_R * 2,
    height: SEEK_THUMB_R,
    borderTopLeftRadius: SEEK_THUMB_R,
    borderTopRightRadius: SEEK_THUMB_R,
  },
});
