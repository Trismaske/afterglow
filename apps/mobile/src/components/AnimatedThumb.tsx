/**
 * AnimatedThumb — a thumbnail that PLAYS its clip while its list says so
 * (m0.9 phase 6). The still is a
 * stable base layer that never remounts — the OS thumbnail every cell
 * shows today (OsThumbnail) — with the playing layer laid OVER it: a
 * VideoView over a POOLED player kept invisible until its first frame
 * has rendered, or a GIF image until it has loaded, so a cell never
 * shows black or blank between its still and its motion (the
 * S10e recording: no flat tile in 140 frames across a start and a
 * scroll). A video plays its content URI; a motion photo its clip
 * through the shared resolver (lib/motionClips); a GIF through
 * expo-image's native playback.
 *
 * THE KIND MARK: every clip thumbnail carries its kind — video,
 * motion photo, GIF — playing or not, in the StateDots corner language
 * (top-left; the dots sit bottom-right). A plain photo carries none.
 * Exempt from the eye like every thumbnail mark.
 *
 * Memoised: only a cell whose playback changed re-renders when the
 * list's playing set moves.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { OsThumbnail } from './OsThumbnail';
import { useCellPlayback, type AnimatedCells, type CellPlayback } from './useAnimatedCells';
import type { AnimatedKind } from '../lib/animatedCells';
import type { AnimatedThumbRow } from '../lib/animatedThumbRow';
import type { PlayerPool } from '../lib/playerPool';
import type { StoredMediaKind } from '../lib/mediaIdentity';
import type { MotionClipRow } from '../db/store';
import { motionClipKey, resolveMotionClip } from '../lib/motionClips';
import { versionedUri } from '../lib/imageKeys';
import { radius, scrim } from '../theme';

/** The kind glyphs — the vocabulary phase 7's stage chips share. */
const KIND_ICON: Record<
  AnimatedKind,
  'play-circle-outline' | 'motion-play-outline' | 'file-gif-box'
> = {
  video: 'play-circle-outline',
  motion: 'motion-play-outline',
  gif: 'file-gif-box',
};

export const AnimatedThumb = React.memo(function AnimatedThumb({
  row,
  px,
  index,
  cellKey,
  sub = 0,
  cells,
  style,
  markSize = 14,
}: {
  row: AnimatedThumbRow;
  /** The OS-thumbnail bucket the surface renders at. */
  px: number;
  /** The ITEM's list index and identity to the controller: a grid cell's
   * or a row's is its own `id:version`, a card's thumbnails share the
   * card's. Defaults to the row's own. */
  index: number;
  cellKey?: string;
  /** The thumbnail's place inside its item (a card's row); 0 otherwise. */
  sub?: number;
  /** The list's controller (useAnimatedCells) — stable, subscribed to. */
  cells: AnimatedCells;
  style?: StyleProp<ViewStyle>;
  markSize?: number;
}) {
  const cell = useCellPlayback(cells, index, cellKey ?? `${row.id}:${row.version}`, sub);
  const pool = cells.pool;
  const playing = cell.playing && row.animated !== null;
  return (
    // No touch target of its own: the native video view would swallow the
    // tap its surface's Pressable is waiting for.
    <View style={[styles.cell, style]} pointerEvents="none">
      <OsThumbnail
        assetId={row.id}
        kind={row.kind}
        uri={row.uri}
        version={row.version}
        px={px}
        style={StyleSheet.absoluteFill}
      />
      {playing &&
        (row.animated === 'gif' ? (
          <GifLayer uri={versionedUri(row.uri, row.version)} />
        ) : (
          // Keyed by the VERSION too: an in-place edit keeps the id and the
          // URI, and the layer must restart on the new bytes rather than
          // keep the old clip (codex round 1).
          <PlayerLayer
            key={`play-${row.version}-${cell.spotKey}`}
            row={row}
            cell={cell}
            pool={pool}
          />
        ))}
      {row.animated !== null && (
        <View style={styles.mark} pointerEvents="none">
          <MaterialCommunityIcons name={KIND_ICON[row.animated]} size={markSize} color="#fff" />
        </View>
      )}
    </View>
  );
});

function GifLayer({ uri }: { uri: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <Image
      source={{ uri }}
      style={[StyleSheet.absoluteFill, { opacity: loaded ? 1 : 0 }]}
      contentFit="cover"
      autoplay
      onLoad={() => setLoaded(true)}
    />
  );
}

/** Clips whose extraction FAILED, by key: a malformed clip fails every
 * time, so the still stands for it for the process's life, with one
 * warning (codex round 2) — a new version is a new key. */
const failedClips = new Set<string>();

/** Resolves the playable file: a video's content URI as is, a motion
 * photo's clip through the shared resolver. */
function usePlayableUri(row: AnimatedThumbRow): string | null {
  const [uri, setUri] = useState<string | null>(row.animated === 'video' ? row.uri : null);
  useEffect(() => {
    if (row.animated !== 'motion' || row.motion === null) return;
    const key = motionClipKey(row.id, row.motion);
    if (failedClips.has(key)) return;
    let cancelled = false;
    void resolveMotionClip(row.id, row.motion).then(
      (file) => {
        if (!cancelled) setUri(file);
      },
      (error) => {
        if (failedClips.has(key)) return;
        failedClips.add(key);
        console.warn(`[thumbs] clip for ${row.id} failed: ${String(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [row]);
  return uri;
}

function PlayerLayer({
  row,
  cell,
  pool,
}: {
  row: AnimatedThumbRow;
  cell: CellPlayback;
  pool: () => PlayerPool | null;
}) {
  const uri = usePlayableUri(row);
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [framed, setFramed] = useState(false);
  const endRef = useRef(cell.onEnd);
  endRef.current = cell.onEnd;
  const loop = cell.loop;
  useEffect(() => {
    if (uri === null) return;
    const owner = pool();
    const borrowed = owner?.borrow() ?? null;
    if (owner === null || borrowed === null) return;
    borrowed.loop = loop;
    borrowed.replace({ uri });
    borrowed.play();
    setPlayer(borrowed);
    // An empty player reports playToEnd (Playback's header): only an end
    // reached while THIS source plays hands the spotlight over.
    let live = false;
    let ended = false;
    const subs = [
      borrowed.addListener('playingChange', ({ isPlaying }) => {
        if (isPlaying) live = true;
      }),
      borrowed.addListener('playToEnd', () => {
        // One hand-over per turn: a looping player ends every wrap, and
        // a turn that already handed over must not again.
        if (!live || ended) return;
        ended = true;
        endRef.current?.();
      }),
    ];
    return () => {
      for (const sub of subs) sub.remove();
      owner.giveBack(borrowed);
      setPlayer(null);
      setFramed(false);
    };
  }, [uri, loop, pool]);
  if (player === null) return null;
  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, { opacity: framed ? 1 : 0 }]}
      contentFit="cover"
      nativeControls={false}
      surfaceType="textureView"
      fullscreenOptions={{ enable: false }}
      onFirstFrameRender={() => {
        setFramed(true);
        // Playback EVIDENCE for the UI gate (m0.9 close-out): a frame of
        // the clip reached the screen — the eligible-row count alone did
        // not prove it.
        console.log(`[thumbs] framed ${row.id}`);
      }}
    />
  );
}

const styles = StyleSheet.create({
  cell: { overflow: 'hidden' },
  mark: {
    position: 'absolute',
    top: 5,
    left: 5,
    borderRadius: radius.thumb,
    padding: 2,
    backgroundColor: scrim.mark,
  },
});
