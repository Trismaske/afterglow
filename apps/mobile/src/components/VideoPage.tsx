/**
 * VideoPage — the deck pager's page for a VIDEO (m0.9 phase 5, M26
 * option B): the player IS the page, with the item's OS frame
 * (OsThumbnail) as its instant first paint underneath. A player exists
 * only while the page is NEAR (the current page or a neighbour — the
 * M26 bound, enforced here rather than trusted to FlatList's window).
 *
 * The whole of playback — lifecycle, view, chrome, the tap rule — is
 * the shared Playback component; a motion photo's overlay uses the same
 * one, so the kinds cannot drift. This page is the deck's press surface
 * in BOTH stages, and its press is a plain single tap (the deck's
 * stage-tap rule, with no double-tap window: a video has no zoom, so
 * the photo pages' double-tap hook must not run here — it would zoom
 * the stage overlay over the playing view). The same tree across the
 * immersive flip is what keeps a playing video playing through it.
 */
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { SurfaceType } from 'expo-video';
import { OsThumbnail } from './OsThumbnail';
import { Playback, type PlaybackStage } from './Playback';
import type { PlaybackMode } from '../lib/playbackPrefs';
import { versionedUri } from '../lib/imageKeys';

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
  stage,
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
  stage: PlaybackStage;
  surfaceType: SurfaceType;
  /** The deck's stage tap (the chrome toggle) — no double-tap window. */
  onPress: () => void;
}) {
  return (
    <Pressable style={{ width, height: '100%' }} onPress={onPress}>
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
        <Playback
          // The version rides the uri so an edited file is a new source
          // (item 3's rule, same as expo-image) — and, by the key, a new
          // instance (Playback's header).
          key={versionedUri(uri, version)}
          source={versionedUri(uri, version)}
          active={active}
          mode={mode}
          stage={stage}
          surfaceType={surfaceType}
        />
      )}
    </Pressable>
  );
}
