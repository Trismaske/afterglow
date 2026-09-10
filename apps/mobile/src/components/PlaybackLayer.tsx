/**
 * PlaybackLayer — THE player view (m0.9 phase 5), shared by a video page
 * and a motion photo's clip overlay. One rule decides who owns a tap on
 * the playing surface, for both kinds:
 *
 *  - On the DECK stage the layer is inert (`pointerEvents="none"`): the
 *    page's own press handles single tap (immersive toggle) and double
 *    tap (zoom), and the deck-tier chrome's buttons — siblings above
 *    this layer — take their own presses. A native player view otherwise
 *    consumes touches itself (Media3's PlayerView), which is why a video
 *    page's tap never reached the deck on the S23 (2026-09-09) while a
 *    motion photo's, wrapped inert, did.
 *  - In the EXPANDED (immersive) stage the layer owns every tap: the
 *    native controller is the full transport (M4's second tier), and the
 *    Back gesture exits immersive (P2-7).
 *
 * `surfaceType` is the M27 measurement's knob; it must not change at
 * runtime (expo-video's contract), so it is fixed per build.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { VideoView, type SurfaceType, type VideoPlayer } from 'expo-video';

export function PlaybackLayer({
  player,
  immersive,
  surfaceType,
}: {
  player: VideoPlayer;
  immersive: boolean;
  surfaceType: SurfaceType;
}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={immersive ? 'auto' : 'none'}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={immersive}
        surfaceType={surfaceType}
        fullscreenOptions={{ enable: false }}
      />
    </View>
  );
}
