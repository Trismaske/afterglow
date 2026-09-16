/**
 * The animated-thumbnail SPIKE's probe screen (m0.9 phase 6, M29–M30):
 * a hidden screen behind Settings › Diagnostics that renders N real
 * grid cells (the Progress grid's 3-column tile) over the library's
 * newest videos, motion photos and GIFs in a SCROLLING list, so the
 * sustained protocol (docs/ANDROID_DEVICE_TESTING.md §6) can sample
 * CPU, memory, frame health and thermals on both phones — and so the
 * tester can judge the look and the scroll rules by eye. PROBE-ONLY:
 * this screen, its Settings row, its store query and the module's
 * frame-strip extractor leave with the spike once the plan holds the
 * numbers.
 *
 * THE RULES UNDER TEST (Tristan, 2026-09-15/16): only cells FULLY on
 * screen play, and a cell ENTERING the screen plays only once the list
 * has been still for the settle — while a cell LEAVING it stops the
 * instant it is no longer fully visible (a deep scroll plays nothing
 * and loads nothing until it settles; the lag of 2026-09-16 was players
 * running on inside the list's mounted window after scrolling off); a
 * cell at rest off screen shows its OS thumbnail, the still every cell
 * shows today; and a player never shows BLACK: the still stays on top until
 * the view's first frame has rendered (`onFirstFrameRender`), a GIF's
 * until its image has loaded. Two arms:
 *  - Players: every fully visible video or motion cell holds a muted,
 *    looping expo-video player (a motion photo's clip through the
 *    module's extraction, like the deck) with the deck's buffer bound.
 *    The players are a POOL made once per run: a cell entering borrows
 *    one and swaps its source, a cell leaving pauses it and hands it
 *    back — nothing is created or destroyed during a scroll (Tristan,
 *    2026-09-16: releasing nine players as their cells scrolled off was
 *    the lag spike that lost the scroll's place).
 *  - One at a time: a single player walks the fully visible video and
 *    motion cells, handing over when its clip ends or at DWELL_MS, the
 *    others still; GIF cells play on their own.
 * A GIF cell is expo-image over the file, autoplay while visible — the
 * native GIF playback the thumbnail surfaces had before phase 3.
 *
 * The frame-strip arm (M30's second mechanism) was measured and judged
 * OUT by the tester: faithful to the clip's speed it needed 2–7 s of
 * extraction per item on the S10e, far too slow to render.
 *
 * The population cycles when the library holds fewer animating items
 * than N — the cost under measurement is per cell, not per file.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  PixelRatio,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewToken,
} from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { Image } from 'expo-image';
import { VideoView, createVideoPlayer, type VideoPlayer } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SegmentedControl } from '../components/SegmentedControl';
import { OsThumbnail } from '../components/OsThumbnail';
import { fetchAnimatedProbeRows, type AnimatedProbeRow } from '../db/store';
import { extractMotionClip } from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf, volumeOf } from '../lib/mediaIdentity';
import { versionedUri } from '../lib/imageKeys';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { colors } from '../theme';

type Arm = 'players' | 'one';
const ARMS = [
  { id: 'players', label: 'All visible' },
  { id: 'one', label: 'One at a time' },
] as const;
type Kinds = 'all' | 'noGifs' | 'gifsOnly';
const KINDS = [
  { id: 'all', label: 'All kinds' },
  { id: 'noGifs', label: 'No GIFs' },
  { id: 'gifsOnly', label: 'GIFs only' },
] as const;
type Count = '12' | '24' | '60' | '100' | '200' | '300';
const COUNTS = [
  { id: '12', label: '12' },
  { id: '24', label: '24' },
  { id: '60', label: '60' },
  { id: '100', label: '100' },
  { id: '200', label: '200' },
  { id: '300', label: '300' },
] as const;

/** One-at-a-time: the single player's dwell CAP on a cell — a clip that
 * ends sooner hands over at its end; the cap only bounds long ones. */
const DWELL_MS = 5000;
/** The players' buffer bound, the deck's (Playback.tsx). */
const PLAYER_BUFFER_S = 4;
const PLAYER_BUFFER_BYTES = 16 * 1024 * 1024;
/** The pool is sized from the list's OWN geometry (Tristan, 2026-09-16:
 * a constant cannot know every surface): the cells that can be fully
 * visible at once — columns × the rows the list's height holds — plus
 * one row of margin for the settle's overlap. */
function poolSizeFor(
  columns: number,
  listHeight: number,
  tileDp: number,
  partial: boolean,
): number {
  const rows = Math.max(1, Math.floor(listHeight / tileDp));
  // A partial-visibility rule can hold a cut row at the top AND the
  // bottom beyond the full rows.
  return columns * (rows + (partial ? 3 : 1));
}

type Pool = { all: VideoPlayer[]; free: VideoPlayer[]; released: boolean };
function makePool(size: number): Pool {
  const all = Array.from({ length: size }, () => {
    const p = createVideoPlayer(null);
    p.muted = true;
    p.timeUpdateEventInterval = 0;
    p.bufferOptions = {
      preferredForwardBufferDuration: PLAYER_BUFFER_S,
      minBufferForPlayback: 1,
      maxBufferBytes: PLAYER_BUFFER_BYTES,
      prioritizeTimeOverSizeThreshold: false,
    };
    return p;
  });
  return { all, free: [...all], released: false };
}
/** The playing set — both arms' — updates this long after the visible
 * set last changed: the scroll's settle (Tristan, 2026-09-16: two
 * seconds read as too long, half a second as a little lag — a control
 * to find the feel); players already playing keep going meanwhile. */
type Settle = '250' | '300' | '400' | '500' | '1000' | '1500' | '2000';
const SETTLES = [
  { id: '250', label: '.25' },
  { id: '300', label: '.3' },
  { id: '400', label: '.4' },
  { id: '500', label: '.5 s' },
  { id: '1000', label: '1 s' },
  { id: '1500', label: '1.5' },
  { id: '2000', label: '2 s' },
] as const;
/** How much of a cell must be on screen for it to count as visible
 * (Tristan, 2026-09-16: pushing past fully visible). */
type Reach = '100' | '50' | '1';
const REACHES = [
  { id: '100', label: 'Fully visible' },
  { id: '50', label: 'Half visible' },
  { id: '1', label: 'Any part' },
] as const;

type Cell = { key: string; index: number; row: AnimatedProbeRow };

export function AnimatedThumbProbeScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tileDp = width / 3;
  const tilePx = Math.ceil(tileDp * PixelRatio.get());
  const [arm, setArm] = useState<Arm>('players');
  const [count, setCount] = useState<Count>('24');
  const [kinds, setKinds] = useState<Kinds>('all');
  const [settle, setSettle] = useState<Settle>('500');
  const settleMs = Number(settle);
  const [reach, setReach] = useState<Reach>('100');
  const viewability = useMemo(
    () => ({ itemVisiblePercentThreshold: Number(reach), minimumViewTime: 100 }),
    [reach],
  );
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<AnimatedProbeRow[] | null>(null);
  // The player pool lives for the run, sized from the list's layout.
  // It is made IN the Running tap, before the run renders: a child's
  // effects run before its parent's, so a pool made in an effect here
  // would come after the first cells asked for players (the S10e's
  // 'pool exhausted' at every start).
  const [listHeight, setListHeight] = useState(0);
  const poolRef = useRef<Pool | null>(null);
  const dropPool = useCallback(() => {
    const pool = poolRef.current;
    if (pool === null) return;
    poolRef.current = null;
    pool.released = true;
    for (const p of pool.all) p.release();
  }, []);
  const setRun = useCallback(
    (next: boolean) => {
      dropPool();
      if (next) {
        const size = poolSizeFor(3, listHeight, tileDp, reach !== '100');
        console.log(`[probe] player pool: ${size} for a ${Math.round(listHeight)} dp list`);
        poolRef.current = makePool(size);
      }
      setRunning(next);
    },
    [dropPool, listHeight, tileDp, reach],
  );
  useEffect(() => dropPool, [dropPool]);

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
  const cells = useMemo<Cell[]>(() => {
    if (rows === null || rows.length === 0) return [];
    // Interleave the kinds so every screenful mixes them, then cycle.
    const wanted =
      kinds === 'all'
        ? ['video', 'motion', 'gif']
        : kinds === 'noGifs'
          ? ['video', 'motion']
          : ['gif'];
    const byKind = wanted.map((k) => rows.filter((r) => r.animated === k));
    const total = byKind.reduce((sum, list) => sum + list.length, 0);
    if (total === 0) return [];
    const mixed: AnimatedProbeRow[] = [];
    for (let i = 0; mixed.length < total; i += 1) {
      for (const list of byKind) if (i < list.length) mixed.push(list[i]);
    }
    return Array.from({ length: n }, (_, i) => ({
      key: `${mixed[i % mixed.length].id}:${i}`,
      index: i,
      row: mixed[i % mixed.length],
    }));
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
      `[probe] animated START arm=${arm} n=${n} kinds=${kinds} settle=${settleMs} reach=${reach} tilePx=${tilePx} ${summary}`,
    );
    return () => console.log(`[probe] animated STOP arm=${arm} n=${n}`);
  }, [running, arm, n, kinds, settleMs, reach, tilePx, summary]);

  // The fully visible cells, from the list's own viewability.
  const [visible, setVisible] = useState<readonly number[]>([]);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const next = viewableItems.map((token) => (token.item as Cell).index).sort((a, b) => a - b);
    setVisible((previous) =>
      previous.length === next.length && previous.every((v, i) => v === next[i]) ? previous : next,
    );
  }).current;
  // The SETTLED set: the visible set once it has held for the settle.
  const [settled, setSettled] = useState<readonly number[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(visible), settleMs);
    return () => clearTimeout(timer);
  }, [visible, settleMs]);
  // The PLAYING set: settled AND still fully visible — entering waits,
  // leaving stops at once.
  const playingSet = useMemo(() => settled.filter((i) => visible.includes(i)), [settled, visible]);
  useEffect(() => {
    if (!running) return;
    console.log(`[probe] playing cells: ${playingSet.join(',')}`);
  }, [running, playingSet]);

  // One at a time: the single player walks the VISIBLE non-GIF cells,
  // handing over when its clip ends or at the dwell cap.
  const spotCells = useMemo(
    () => playingSet.filter((i) => cells[i]?.row.animated !== 'gif'),
    [playingSet, cells],
  );
  const [spot, setSpot] = useState(0);
  // A new settled set starts the walk over from its first cell.
  useEffect(() => {
    setSpot(0);
  }, [spotCells]);
  const spotting = running && arm === 'one' && spotCells.length > 0;
  const advance = useCallback(() => {
    setSpot((i) => i + 1);
  }, []);
  useEffect(() => {
    if (!spotting) return;
    const timer = setTimeout(advance, DWELL_MS);
    return () => clearTimeout(timer);
  }, [spotting, spot, advance]);
  const spotCell = spotting ? spotCells[spot % spotCells.length] : -1;

  const renderItem = useCallback(
    ({ item }: { item: Cell }) => {
      const { row, index } = item;
      const shown = running && playingSet.includes(index);
      const playing = shown && (row.animated === 'gif' || arm === 'players' || index === spotCell);
      return (
        <View style={{ width: tileDp, height: tileDp, padding: 2 }}>
          <ProbeCell
            row={row}
            px={tilePx}
            playing={playing}
            playKey={arm === 'one' ? spot : 0}
            loop={arm !== 'one'}
            onEnd={arm === 'one' ? advance : undefined}
            pool={poolRef}
          />
        </View>
      );
    },
    [running, playingSet, arm, spotCell, spot, advance, tileDp, tilePx],
  );

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <View style={styles.controls}>
        <SegmentedControl
          options={ARMS}
          value={arm}
          onChange={(id) => {
            setRun(false);
            setArm(id);
          }}
          accessibilityLabel="Mechanism"
        />
        <SegmentedControl
          options={COUNTS}
          value={count}
          onChange={(id) => {
            setRun(false);
            setCount(id);
          }}
          accessibilityLabel="Cells"
        />
        <SegmentedControl
          options={KINDS}
          value={kinds}
          onChange={(id) => {
            setRun(false);
            setKinds(id);
          }}
          accessibilityLabel="Kinds"
        />
        <SegmentedControl
          options={SETTLES}
          value={settle}
          onChange={setSettle}
          accessibilityLabel="Scroll settle"
        />
        <SegmentedControl
          options={REACHES}
          value={reach}
          onChange={(id) => {
            setRun(false);
            setReach(id);
          }}
          accessibilityLabel="Plays when"
        />
        <SegmentedControl
          options={[
            { id: 'stopped', label: 'Stopped' },
            { id: 'running', label: 'Running' },
          ]}
          value={running ? 'running' : 'stopped'}
          onChange={(id) => setRun(id === 'running')}
          accessibilityLabel="Run"
        />
        <Text style={styles.summary}>{summary}</Text>
      </View>
      <FlatList
        // The viewability rule is fixed at mount: a new rule is a new list.
        key={`list-${reach}`}
        data={cells}
        keyExtractor={(cell) => cell.key}
        renderItem={renderItem}
        numColumns={3}
        extraData={[running, playingSet, spotCell, spot]}
        viewabilityConfig={viewability}
        onViewableItemsChanged={onViewableItemsChanged}
        windowSize={5}
        style={styles.list}
        onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
      />
    </View>
  );
}

/** ONE cell, its still a stable base layer that never remounts: the
 * OS thumbnail every cell shows today, with the playing layer laid OVER
 * it — a player view kept invisible until its first frame has rendered,
 * a GIF image until it has loaded — so a cell never shows black or
 * blank between its still and its motion (Tristan, 2026-09-16). */
const ProbeCell = React.memo(function ProbeCell({
  row,
  px,
  playing,
  playKey,
  loop,
  onEnd,
  pool,
}: {
  row: AnimatedProbeRow;
  px: number;
  playing: boolean;
  /** One-at-a-time: a new key restarts the spotlight's player. */
  playKey: number;
  loop: boolean;
  onEnd?: () => void;
  pool: React.RefObject<Pool | null>;
}) {
  return (
    <View style={styles.tile}>
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
          <GifLayer row={row} />
        ) : (
          <PlayerLayer key={`play-${playKey}`} row={row} loop={loop} onEnd={onEnd} pool={pool} />
        ))}
    </View>
  );
});

function GifLayer({ row }: { row: AnimatedProbeRow }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <Image
      source={{ uri: versionedUri(row.uri, row.version) }}
      style={[StyleSheet.absoluteFill, { opacity: loaded ? 1 : 0 }]}
      contentFit="cover"
      autoplay
      onLoad={() => setLoaded(true)}
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

function PlayerLayer({
  row,
  loop,
  onEnd,
  pool,
}: {
  row: AnimatedProbeRow;
  loop: boolean;
  onEnd?: () => void;
  pool: React.RefObject<Pool | null>;
}) {
  const uri = usePlayableUri(row);
  if (uri === null) return null;
  return <PlayerTile uri={uri} loop={loop} onEnd={onEnd} pool={pool} />;
}

function PlayerTile({
  uri,
  loop,
  onEnd,
  pool,
}: {
  uri: string;
  loop: boolean;
  onEnd?: () => void;
  pool: React.RefObject<Pool | null>;
}) {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [framed, setFramed] = useState(false);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    const current = pool.current;
    const borrowed = current?.free.pop();
    if (current === null || current === undefined || borrowed === undefined) {
      console.warn('[probe] player pool exhausted');
      return;
    }
    borrowed.loop = loop;
    borrowed.replace({ uri });
    borrowed.play();
    setPlayer(borrowed);
    // An empty player reports playToEnd (Playback's header): only an end
    // reached while this source plays hands over.
    let live = false;
    const subs = [
      borrowed.addListener('playingChange', ({ isPlaying }) => {
        if (isPlaying) live = true;
      }),
      borrowed.addListener('playToEnd', () => {
        if (live) endRef.current?.();
      }),
    ];
    return () => {
      for (const sub of subs) sub.remove();
      borrowed.pause();
      // Back to the pool it came from; a pool released with the run
      // (its players gone) takes nothing back.
      if (!current.released) current.free.push(borrowed);
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
      onFirstFrameRender={() => setFramed(true)}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  controls: { padding: 12, gap: 10 },
  summary: { color: colors.textDim, fontSize: 13 },
  list: { flex: 1 },
  tile: { flex: 1, borderRadius: 8, backgroundColor: colors.surface, overflow: 'hidden' },
});
