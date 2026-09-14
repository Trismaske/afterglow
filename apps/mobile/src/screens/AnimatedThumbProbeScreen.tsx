/**
 * The animated-thumbnail SPIKE's probe screen (m0.9 phase 6, M29–M30):
 * a hidden screen behind Settings › Diagnostics that renders N real
 * grid cells (the Progress grid's 3-column tile) over the library's
 * newest videos, motion photos and GIFs, animating concurrently under
 * one of two arms, so the sustained 1/3/5/10-minute protocol
 * (docs/ANDROID_DEVICE_TESTING.md §6) can sample CPU, memory, frame
 * health and thermals per arm on both phones. PROBE-ONLY: this screen,
 * its Settings row, its store query and the native frame strip's
 * cell leave with the spike once the plan holds the numbers.
 *
 * THE ARMS:
 *  - Players: every video or motion cell is a muted, looping expo-video
 *    player (a motion photo's clip through the module's extraction,
 *    like the deck) drawn through a VideoView — the M26/M27 cost, N-fold.
 *  - Strip: every video or motion cell is ONE bitmap of STRIP_FRAMES
 *    square frames side by side (the module's `extractFrameStrip`, a
 *    motion clip read in place through its byte range), stepped on the
 *    UI thread: one frame callback advances a shared clock, and each
 *    cell's animated style derives its frame from it — no bridge
 *    crossing per frame, no decoder at play time; the memory is the
 *    strips (frames × px² × 2 bytes each, RGB_565).
 *  In both arms a GIF cell is expo-image over the file, autoplay: the
 *  native GIF playback the thumbnail surfaces had before phase 3.
 *
 * The population cycles when the library holds fewer animating items
 * than N (a 24-cell run over 5 videos shows each five times) — the
 * cost under measurement is per cell, not per distinct file.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SegmentedControl } from '../components/SegmentedControl';
import { fetchAnimatedProbeRows, type AnimatedProbeRow } from '../db/store';
import {
  extractFrameStrip,
  extractMotionClip,
  type RegionBitmap,
} from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf, volumeOf } from '../lib/mediaIdentity';
import { versionedUri } from '../lib/imageKeys';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { colors } from '../theme';

type Arm = 'players' | 'strip';
const ARMS = [
  { id: 'players', label: 'Players' },
  { id: 'strip', label: 'Strip' },
] as const;
type Kinds = 'all' | 'noGifs' | 'gifsOnly';
const KINDS = [
  { id: 'all', label: 'All kinds' },
  { id: 'noGifs', label: 'No GIFs' },
  { id: 'gifsOnly', label: 'GIFs only' },
] as const;
type Count = '6' | '12' | '24';
const COUNTS = [
  { id: '6', label: '6' },
  { id: '12', label: '12' },
  { id: '24', label: '24' },
] as const;

/** The strip's tunables (M30): a dozen frames at 8 fps reads as motion
 * on a thumbnail (a 3 s motion clip plays in 1.5 s, a 20 s video in a
 * 1.5 s flick-book); both are the spike's to adjust. */
const STRIP_FRAMES = 12;
const STRIP_FPS = 8;
/** The players' buffer bound, the deck's (Playback.tsx). */
const PLAYER_BUFFER_S = 4;
const PLAYER_BUFFER_BYTES = 16 * 1024 * 1024;

export function AnimatedThumbProbeScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tileDp = width / 3;
  // The strip is drawn at the tile's EXACT pixel size (not the OS
  // thumbnail bucket, whose coarseness serves retention keys): its
  // memory is the arm's cost, so it must be the honest figure.
  const tilePx = Math.ceil(tileDp * PixelRatio.get());
  const [arm, setArm] = useState<Arm>('strip');
  const [count, setCount] = useState<Count>('6');
  /** Which kinds fill the cells: the GIF cells are the same in both
   * arms, so their share of an arm's cost is measured apart. */
  const [kinds, setKinds] = useState<Kinds>('all');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<AnimatedProbeRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void mountedVolumeSet()
      .then((mounted) => fetchAnimatedProbeRows(db, mounted, { videos: 8, motion: 8, gifs: 8 }))
      .then((found) => {
        if (!cancelled) setRows(found);
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const n = Number(count);
  const cells = useMemo(() => {
    if (rows === null || rows.length === 0) return [];
    // Interleave the kinds so every screenful mixes them, then cycle.
    const wanted =
      kinds === 'all'
        ? ['video', 'motion', 'gif']
        : kinds === 'noGifs'
          ? ['video', 'motion']
          : ['gif'];
    const byKind = wanted.map((k) => rows.filter((r) => r.animated === k));
    if (byKind.every((list) => list.length === 0)) return [];
    const mixed: AnimatedProbeRow[] = [];
    const total = byKind.reduce((sum, list) => sum + list.length, 0);
    for (let i = 0; mixed.length < total; i += 1) {
      for (const list of byKind) if (i < list.length) mixed.push(list[i]);
    }
    return Array.from({ length: n }, (_, i) => mixed[i % mixed.length]);
  }, [rows, n, kinds]);

  const summary =
    rows === null
      ? 'Reading the library…'
      : `${rows.filter((r) => r.animated === 'video').length} videos · ${rows.filter((r) => r.animated === 'motion').length} motion · ${rows.filter((r) => r.animated === 'gif').length} GIFs available`;

  // The run marker in the diag sink: the sampling script's timeline is
  // aligned to these lines.
  useEffect(() => {
    if (!running) return;
    console.log(
      `[probe] animated START arm=${arm} n=${n} kinds=${kinds} tilePx=${tilePx} ${summary}`,
    );
    return () => console.log(`[probe] animated STOP arm=${arm} n=${n}`);
  }, [running, arm, n, kinds, tilePx, summary]);

  // One clock for every strip cell (ms since the run started). The
  // callback is registered once and switched with the run: the hook's
  // autostart flag is read at registration only (the first build's
  // strip cells never stepped — zero frames rendered without GIFs).
  const clock = useSharedValue(0);
  const tick = useCallback(
    (frame: { timeSinceFirstFrame: number }) => {
      'worklet';
      clock.value = frame.timeSinceFirstFrame;
    },
    [clock],
  );
  const frameCallback = useFrameCallback(tick, false);
  const stepping = running && arm === 'strip';
  useEffect(() => {
    frameCallback.setActive(stepping);
  }, [frameCallback, stepping]);

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <View style={styles.controls}>
        <SegmentedControl
          options={ARMS}
          value={arm}
          onChange={(id) => {
            setRunning(false);
            setArm(id);
          }}
          accessibilityLabel="Mechanism"
        />
        <SegmentedControl
          options={COUNTS}
          value={count}
          onChange={(id) => {
            setRunning(false);
            setCount(id);
          }}
          accessibilityLabel="Cells"
        />
        <SegmentedControl
          options={KINDS}
          value={kinds}
          onChange={(id) => {
            setRunning(false);
            setKinds(id);
          }}
          accessibilityLabel="Kinds"
        />
        <SegmentedControl
          options={[
            { id: 'stopped', label: 'Stopped' },
            { id: 'running', label: 'Running' },
          ]}
          value={running ? 'running' : 'stopped'}
          onChange={(id) => setRunning(id === 'running')}
          accessibilityLabel="Run"
        />
        <Text style={styles.summary}>{summary}</Text>
      </View>
      <View style={styles.grid}>
        {running &&
          cells.map((row, i) => (
            <View key={`${row.id}:${i}`} style={{ width: tileDp, height: tileDp, padding: 2 }}>
              {row.animated === 'gif' ? (
                <GifCell row={row} />
              ) : arm === 'players' ? (
                <PlayerCell row={row} />
              ) : (
                <StripCell row={row} px={tilePx} clock={clock} />
              )}
            </View>
          ))}
      </View>
    </View>
  );
}

function GifCell({ row }: { row: AnimatedProbeRow }) {
  return (
    <Image
      source={{ uri: versionedUri(row.uri, row.version) }}
      style={styles.tile}
      contentFit="cover"
      autoplay
    />
  );
}

/** One in-flight extraction per clip: cycled cells share a key, and two
 * concurrent extractions of one key could rewrite the cache file under
 * a player preparing it (codex round 1). */
const clipExtractions = new Map<string, Promise<string>>();
function extractClipOnce(row: AnimatedProbeRow, key: string): Promise<string> {
  const pending = clipExtractions.get(key);
  if (pending !== undefined) return pending;
  const motion = row.motion!;
  const extraction = extractMotionClip(
    canonicalContentUri(row.id, 'photo'),
    motion.offset,
    motion.length,
    key,
  ).finally(() => clipExtractions.delete(key));
  clipExtractions.set(key, extraction);
  return extraction;
}

/** Resolves a cell's playable file: a video's content URI as is, a
 * motion photo's clip through the deck's extraction. */
function usePlayableUri(row: AnimatedProbeRow): string | null {
  const [uri, setUri] = useState<string | null>(row.animated === 'video' ? row.uri : null);
  useEffect(() => {
    if (row.animated !== 'motion' || row.motion === null) return;
    let cancelled = false;
    const key = `${volumeOf(row.id)}-${rawIdOf(row.id)}-${row.motion.version}`;
    void extractClipOnce(row, key).then(
      (file) => {
        if (!cancelled) setUri(file);
      },
      (error) => console.warn(`[probe] clip extraction failed for ${row.id}: ${String(error)}`),
    );
    return () => {
      cancelled = true;
    };
  }, [row]);
  return uri;
}

function PlayerCell({ row }: { row: AnimatedProbeRow }) {
  const uri = usePlayableUri(row);
  if (uri === null) return <View style={styles.tile} />;
  return <PlayerTile uri={uri} />;
}

function PlayerTile({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.muted = true;
    p.loop = true;
    p.timeUpdateEventInterval = 0;
    p.bufferOptions = {
      preferredForwardBufferDuration: PLAYER_BUFFER_S,
      minBufferForPlayback: 1,
      maxBufferBytes: PLAYER_BUFFER_BYTES,
      prioritizeTimeOverSizeThreshold: false,
    };
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={styles.tile}
      contentFit="cover"
      nativeControls={false}
      surfaceType="textureView"
      fullscreenOptions={{ enable: false }}
    />
  );
}

function StripCell({
  row,
  px,
  clock,
}: {
  row: AnimatedProbeRow;
  px: number;
  clock: SharedValue<number>;
}) {
  const [strip, setStrip] = useState<RegionBitmap | null>(null);
  const stripRef = useRef<RegionBitmap | null>(null);
  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    const motion = row.animated === 'motion' ? row.motion : null;
    // The canonical content URI for both kinds (a video row's `uri` is
    // its file path; the module takes content URIs only).
    void extractFrameStrip(
      canonicalContentUri(row.id, row.kind),
      motion?.offset ?? 0,
      motion?.length ?? 0,
      STRIP_FRAMES,
      px,
    ).then(
      (bitmap) => {
        if (cancelled) {
          bitmap.release?.();
          return;
        }
        console.log(
          `[probe] strip ${row.animated} ${row.id}: ${STRIP_FRAMES}×${px} in ${Date.now() - started} ms`,
        );
        stripRef.current = bitmap;
        setStrip(bitmap);
      },
      (error) => console.warn(`[probe] strip failed for ${row.id}: ${String(error)}`),
    );
    return () => {
      cancelled = true;
      stripRef.current?.release?.();
      stripRef.current = null;
    };
  }, [row, px]);
  // The tile is `px` device pixels wide in dp terms of the layout: the
  // strip image is laid out at STRIP_FRAMES tiles wide and stepped by
  // one tile per frame, all on the UI thread.
  const tileDp = px / PixelRatio.get();
  const style = useAnimatedStyle(() => {
    const frame = Math.floor((clock.value * STRIP_FPS) / 1000) % STRIP_FRAMES;
    return { transform: [{ translateX: -frame * tileDp }] };
  }, [tileDp]);
  if (strip === null) return <View style={styles.tile} />;
  return (
    <View style={[styles.tile, { overflow: 'hidden' }]}>
      <Animated.View style={[{ width: tileDp * STRIP_FRAMES, height: '100%' }, style]}>
        <Image source={strip} style={StyleSheet.absoluteFill} contentFit="fill" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  controls: { padding: 12, gap: 10 },
  summary: { color: colors.textDim, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { flex: 1, borderRadius: 8, backgroundColor: colors.surface },
});
