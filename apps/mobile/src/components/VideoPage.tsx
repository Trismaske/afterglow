/**
 * VideoPage — the deck pager's page for a VIDEO (m0.9 phase 5, M26
 * option B): the player IS the page, with the item's OS frame
 * (OsThumbnail) as its instant first paint underneath. A player exists
 * only while the page is NEAR (the current page or a neighbour — the
 * M26 bound, enforced here rather than trusted to FlatList's window).
 *
 * The playback lifecycle and the two chrome tiers are the SHARED ones
 * (usePlaybackPlayer, PlaybackLayer, PlaybackChrome) — a motion photo's
 * clip overlay uses the same three, so the kinds cannot drift apart. On
 * the deck stage this page wraps itself in the deck's press (single tap
 * → immersive, double tap → zoom) with the player layer inert beneath
 * it; in the expanded stage the layer owns every tap and this page
 * renders no press surface of its own. The chrome is exempt from the
 * eye (M21's "functional labels never hideable").
 */
import React from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import type { SurfaceType } from 'expo-video';
import { OsThumbnail } from './OsThumbnail';
import { PlaybackChrome } from './PlaybackChrome';
import { PlaybackLayer } from './PlaybackLayer';
import { usePlaybackPlayer } from './usePlaybackPlayer';
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
  /** The expanded stage: native transport, no page press. */
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
  if (immersive || !onPress) return body;
  return (
    <Pressable style={{ width, height: '100%' }} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** The player's whole lifetime — mounted only while the page is near. */
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
  const playback = usePlaybackPlayer({ source, active, mode });
  return (
    <>
      <PlaybackLayer player={playback.player} immersive={immersive} surfaceType={surfaceType} />
      {!immersive && <PlaybackChrome {...playback.chrome} />}
    </>
  );
}
