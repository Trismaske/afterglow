/**
 * MotionClipOverlay — a MOTION PHOTO's embedded clip over its still (m0.9
 * phase 5, F25/G6). The page stays the photo page (expo-image on the JPEG
 * primary, the region-zoom pipeline on the same bytes); this overlay is
 * the video half of the dual identity, and the whole of its playback —
 * lifecycle, view, chrome, the tap rule — is the shared Playback
 * component, identical to a video's by construction. The still is the
 * resting frame: the player view shows only while a play is underway
 * (`restsOnStill`), and zoom always shows the still (G6, structural: the
 * opacity is driven from the stage's zoom scale on the UI thread).
 *
 * THE PLAYER BOUND (M26): like VideoPage, a native player exists only
 * while the page is NEAR (current or a neighbour) — the inner
 * `MotionClipPlayer` owns the player's lifetime and mounts when the
 * pager settles, never mid-touch.
 *
 * The clip plays from a run-scoped cache file (the module's
 * `extractMotionClip`: the last `length` bytes of the photo, copied once
 * per volume + id + version, swept at every process start). Extraction
 * failing leaves the still in place and logs once per item — the photo
 * is complete without its clip. The resolved source is TAGGED with the
 * identity it was extracted for: an in-place edit keeps this component
 * (the page is keyed by id) and must never play the previous version's
 * clip.
 */
import React, { useEffect, useState } from 'react';
import type { SurfaceType } from 'expo-video';
import type { SharedValue } from 'react-native-reanimated';
import { motionClipKey, resolveMotionClip } from '../lib/motionClips';
import { Playback, type PlaybackStage } from './Playback';
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
  stage: PlaybackStage;
  surfaceType: SurfaceType;
  /** The stage's zoom scale (1 = unzoomed) — read on the UI thread. */
  zoomScale: SharedValue<number>;
  /** The page is HELD (hold-to-peek): the still shows over the playing
   * clip until the finger lifts. */
  peek: boolean;
  /** Whether the clip file exists to play: false after a failed
   * extraction (the page is a plain photo to the deck's tap rule),
   * true again once a retry or a new version extracts. */
  onClipAvailability: (id: string, available: boolean) => void;
}) {
  if (!props.near) return null;
  return <MotionClipPlayer {...props} />;
}

function MotionClipPlayer({
  id,
  clip,
  active,
  mode,
  stage,
  surfaceType,
  zoomScale,
  peek,
  onClipAvailability,
}: {
  id: string;
  clip: MotionClipRow;
  active: boolean;
  mode: PlaybackMode;
  stage: PlaybackStage;
  surfaceType: SurfaceType;
  zoomScale: SharedValue<number>;
  peek: boolean;
  onClipAvailability: (id: string, available: boolean) => void;
}) {
  const [source, setSource] = useState<{ key: string; uri: string } | null>(null);
  const clipKey = motionClipKey(id, clip);
  const sourceUri = source !== null && source.key === clipKey ? source.uri : null;

  // Resolve the clip file once per volume + id + version (the shared
  // resolver, one extraction in flight per key across the stage and the
  // animated thumbnails); a new version re-extracts and remounts
  // Playback on the new file.
  useEffect(() => {
    let cancelled = false;
    void resolveMotionClip(id, clip).then(
      (fileUri) => {
        if (cancelled) return;
        setSource({ key: clipKey, uri: fileUri });
        onClipAvailability(id, true);
      },
      (error) => {
        if (cancelled) return;
        onClipAvailability(id, false);
        if (warnedIds.has(id)) return;
        warnedIds.add(id);
        console.warn(`[motion] clip extraction failed for ${id}: ${String(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, clip, clipKey, onClipAvailability]);

  // Playback mounts only once the file is known (its header: a player
  // is never prepared empty); the still stands alone until then.
  if (sourceUri === null) return null;
  return (
    <Playback
      // A new version's file is a new instance (Playback's header).
      key={sourceUri}
      source={sourceUri}
      active={active}
      mode={mode}
      stage={stage}
      surfaceType={surfaceType}
      restsOnStill
      peek={peek}
      zoomScale={zoomScale}
      playLabel="Play motion photo"
    />
  );
}
