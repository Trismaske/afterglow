/**
 * MotionClipOverlay — a MOTION PHOTO's embedded clip over its still (m0.9
 * phase 5, F25/G6). The page stays the photo page (expo-image on the JPEG
 * primary, the region-zoom pipeline on the same bytes); this overlay is
 * the video half of the dual identity, and it is ALWAYS MOUNTED once the
 * page renders — the still ↔ playing handoff is props only (opacity and
 * the player's source), never a host view mounted mid-touch under the
 * stage's intercepting detector (MediaStage's rule).
 *
 * The clip plays from a run-scoped cache file (the module's
 * `extractMotionClip`: the last `length` bytes of the photo, copied once
 * per id + version, swept at every process start). Extraction failing
 * leaves the still in place and logs once per item — the photo is
 * complete without its clip.
 *
 * Modes (M5, the Motion photos row): `once` plays muted on page settle
 * and rests on the still (the overlay fades out at the clip's end —
 * the still IS the chosen frame); `loop` keeps playing until the page
 * leaves; `off` shows the still with a play control. Always muted (F25).
 * Zoom always shows the still (G6, structural): the overlay's opacity
 * is driven from the stage's zoom scale on the UI thread — no bridge
 * crossing — so a pinch reveals the JPEG under the playing clip at once,
 * and the clip simply continues invisibly (muted) until it ends.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useEvent } from 'expo';
import { VideoView, useVideoPlayer, type SurfaceType } from 'expo-video';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { extractMotionClip } from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf } from '../lib/mediaIdentity';
import { colors } from '../theme';
import type { PlaybackMode } from '../lib/playbackPrefs';
import type { MotionClipRow } from '../db/store';

const warnedIds = new Set<string>();

export function MotionClipOverlay({
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
  /** The stage's zoom scale (1 = unzoomed) — read on the UI thread. */
  zoomScale: SharedValue<number>;
}) {
  const [source, setSource] = useState<string | null>(null);
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.loop = mode === 'loop';
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    // A looping player emits playToEnd on every wrap — only a Once play
    // has actually ended.
    const sub = player.addListener('playToEnd', () => {
      if (!player.loop) setEnded(true);
    });
    return () => sub.remove();
  }, [player]);

  // Resolve the clip file once per id + version; swap the source in
  // place (props only).
  useEffect(() => {
    let cancelled = false;
    void extractMotionClip(
      canonicalContentUri(id, 'photo'),
      clip.offset,
      clip.length,
      `${rawIdOf(id)}-${clip.version}`,
    ).then(
      (fileUri) => {
        if (!cancelled) setSource(fileUri);
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
  }, [id, clip.offset, clip.length, clip.version]);
  useEffect(() => {
    if (source !== null) player.replace({ uri: source });
  }, [player, source]);
  useEffect(() => {
    player.loop = mode === 'loop';
  }, [player, mode]);

  useEffect(() => {
    if (active && source !== null) {
      if (mode !== 'off') {
        setEnded(false);
        player.play();
      }
      return;
    }
    player.pause();
    player.currentTime = 0;
    setEnded(false);
  }, [player, active, mode, source]);

  // Visible only while the clip is playing (once → the still returns at
  // the end), and never while zoomed.
  const playingVisible = isPlaying && !ended;
  // ONE opacity source: the zoom test runs on the UI thread, the playing
  // flag is captured as a dependency (JS → worklet closure, safe).
  const visibility = useAnimatedStyle(
    () => ({ opacity: playingVisible && zoomScale.value <= 1.001 ? 1 : 0 }),
    [playingVisible],
  );
  const showPlayControl =
    !immersive && active && source !== null && mode === 'off' && !playingVisible;

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, visibility]} pointerEvents="none">
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          surfaceType={surfaceType}
          fullscreenOptions={{ enable: false }}
        />
      </Animated.View>
      {showPlayControl && (
        <Pressable
          style={styles.playControl}
          onPress={() => {
            setEnded(false);
            player.replay();
          }}
          accessibilityLabel="Play motion photo"
        >
          <MaterialCommunityIcons name="play" size={44} color={colors.text} />
        </Pressable>
      )}
    </>
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
});
