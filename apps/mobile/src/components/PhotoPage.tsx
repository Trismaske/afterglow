/**
 * PhotoPage — the deck pager's page for a PHOTO (m0.9 phase 5, the
 * mirror of VideoPage): the item's OS thumbnail as its instant first
 * paint UNDER the full decode, and — for a motion photo — the clip
 * overlay above both. Per page, like a video's poster, so a neighbour
 * is painted before it is swiped to and nothing of another page can
 * show through a contained page's margins (the stage-level underlay
 * this replaces drew the CURRENT item under the whole pager and stayed
 * up under a video page, which never reports a decode — the S23 saw the
 * video's frame standing still behind a swipe and the landscape photo
 * flash at settle, 2026-09-13).
 *
 * The poster LEAVES once this page's full decode has painted (its own
 * `onLoad`, keyed by the versioned source so an edited file brings it
 * back until the new decode lands): a PNG, WebP or GIF with alpha must
 * composite over the stage, not over a thumbnail of itself.
 *
 * This page is the deck's press surface in both stages (single tap →
 * the deck's stage-tap rule, double tap → zoom): a plain Pressable, not
 * a tap gesture — presses fire on the JS thread with no worklets
 * bridge (MediaStage.tsx's crash class), and a horizontal drag hands
 * over to the pager's scroll exactly like any list row.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, type GestureResponderEvent, View } from 'react-native';
import { Image } from 'expo-image';
import type { SurfaceType } from 'expo-video';
import type { SharedValue } from 'react-native-reanimated';
import { OsThumbnail } from './OsThumbnail';
import { MotionClipOverlay } from './MotionClipOverlay';
import type { PlaybackStage } from './Playback';
import type { PlaybackMode } from '../lib/playbackPrefs';
import type { MotionClipRow } from '../db/store';
import { imageCacheKey, versionedUri } from '../lib/imageKeys';

export function PhotoPage({
  id,
  uri,
  version,
  motion,
  width,
  inset,
  posterPx,
  near,
  active,
  mode,
  stage,
  surfaceType,
  zoomScale,
  onClipAvailability,
  onPress,
}: {
  id: string;
  uri: string;
  version: number;
  /** The motion clip riding the row, or null for a plain photo. */
  motion: MotionClipRow | null;
  width: number;
  /** The deck stage's gutter, drawn INSIDE the page: a page is the
   * window's width in both stages (DeckScreen's `pageW`). */
  inset: number;
  /** The poster's OS-thumbnail bucket (the stage's first-paint size). */
  posterPx: number;
  /** The current page or its neighbour (M26): only then does a motion
   * clip's player exist. */
  near: boolean;
  /** The pager has settled on this page and the deck is visible. */
  active: boolean;
  /** The Motion photos mode. */
  mode: PlaybackMode;
  stage: PlaybackStage;
  surfaceType: SurfaceType;
  /** The stage's zoom scale (1 = unzoomed) — read on the UI thread. */
  zoomScale: SharedValue<number>;
  onClipAvailability: (id: string, available: boolean) => void;
  /** The deck's stage tap (immersive or chrome toggle / double-tap zoom). */
  onPress: (event: GestureResponderEvent) => void;
}) {
  // The version-carrying source (item 3): an in-place edit lands fresh
  // pixels on the next scan, never Glide's pre-edit entry.
  const source = versionedUri(uri, version);
  const [decoded, setDecoded] = useState<string | null>(null);
  return (
    <Pressable style={{ width, height: '100%' }} onPress={onPress}>
      <View style={{ flex: 1, marginHorizontal: inset }}>
        {decoded !== source && (
          <OsThumbnail
            assetId={id}
            kind="photo"
            uri={uri}
            version={version}
            px={posterPx}
            contentFit="contain"
            style={StyleSheet.absoluteFill}
          />
        )}
        <Image
          source={{ uri: source }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          // The version is part of the recycling identity (DeckItem's
          // doc): an edited photo is a NEW image to expo-image.
          recyclingKey={imageCacheKey(id, version)}
          transition={40}
          onLoad={() => setDecoded(source)}
        />
        {motion !== null && (
          // The motion photo's clip over its still (F25/G6) — mounted
          // WITH the page (the clip rides the row), props-only handoff.
          <MotionClipOverlay
            id={id}
            clip={motion}
            near={near}
            active={active}
            mode={mode}
            stage={stage}
            surfaceType={surfaceType}
            zoomScale={zoomScale}
            onClipAvailability={onClipAvailability}
          />
        )}
      </View>
    </Pressable>
  );
}
