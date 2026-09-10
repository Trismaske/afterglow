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
 *
 * The lifecycle, the player view and its tap rule, and the chrome are
 * the shared ones (usePlaybackPlayer, PlaybackLayer, PlaybackChrome) —
 * identical to VideoPage by construction.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { SurfaceType } from 'expo-video';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { extractMotionClip } from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf, volumeOf } from '../lib/mediaIdentity';
import { PlaybackChrome } from './PlaybackChrome';
import { PlaybackLayer } from './PlaybackLayer';
import { usePlaybackPlayer } from './usePlaybackPlayer';
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

  // Resolve the clip file once per volume + id + version; the shared
  // lifecycle swaps it in place (props only).
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

  const playback = usePlaybackPlayer({ source: sourceUri, active, mode });

  // The clip layer shows while playing (once → the still returns at the
  // end) and, in the expanded stage, whenever the page is active so the
  // native transport has something to operate; never while zoomed.
  const playingVisible = playback.isPlaying && !playback.ended;
  const layerVisible = playingVisible || (immersive && active && sourceUri !== null);
  // ONE opacity source: the zoom test runs on the UI thread, the visible
  // flag is captured as a dependency (JS → worklet closure, safe).
  const visibility = useAnimatedStyle(
    () => ({ opacity: layerVisible && zoomScale.value <= 1.001 ? 1 : 0 }),
    [layerVisible],
  );

  return (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, visibility]}
        // An invisible layer never takes a tap; a visible one follows the
        // shared rule inside (inert on the deck stage, the transport in
        // the expanded stage).
        pointerEvents={layerVisible ? 'auto' : 'none'}
      >
        <PlaybackLayer player={playback.player} immersive={immersive} surfaceType={surfaceType} />
      </Animated.View>
      {!immersive && active && sourceUri !== null && (
        <PlaybackChrome
          {...playback.chrome}
          showPlayControl={!playingVisible}
          playLabel="Play motion photo"
        />
      )}
    </>
  );
}
