/**
 * useAnimatedCells — one per thumbnail LIST (m0.9 phase 6,
 * docs/AnimatedThumbnails_design.md §2): the impure half of the
 * animated-thumbnail rules in lib/animatedCells.ts. It feeds the list's
 * own viewability into the settle-and-stop rule, walks the spotlight
 * for One at a time, and owns the list's player pool, which it makes
 * lazily at the first borrow (sized from the layout by then) and
 * releases when the mode turns off or the list unmounts.
 *
 * The host list passes `listProps` to its FlatList — the viewability
 * config is fixed at mount, so a rule change would need a new list; the
 * rule never changes, the MODE does, and the mode only gates the cells.
 * Each cell asks `cellFor(index)` what to do.
 *
 * The app in the BACKGROUND empties the playing set (expo-video pauses
 * attached players there and nothing would restart them — codex round
 * 1): every cell hands its player back, and the foreground return
 * lets the settled cells borrow and play again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent, type ViewToken } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import {
  ANIMATED_THUMBS_KEY,
  DWELL_MS,
  SETTLE_MS,
  VIEWABILITY,
  parseAnimatedThumbsMode,
  playingSet,
  poolSizeFor,
  sameCells,
  spotWalk,
  type AnimatedKind,
  type AnimatedThumbsMode,
  type VisibleCell,
} from '../lib/animatedCells';
import { makePlayerPool, type PlayerPool } from '../lib/playerPool';
import { getSetting } from '../db/store';

/** The Settings row's value, re-read on every focus (a mode saved in
 * Settings can never be overtaken by a stale copy); null until read,
 * and a null mode animates nothing. */
export function useAnimatedThumbsMode(): AnimatedThumbsMode | null {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const [mode, setMode] = useState<AnimatedThumbsMode | null>(null);
  useEffect(() => {
    if (!focused) {
      setMode(null);
      return;
    }
    let cancelled = false;
    void getSetting(db, ANIMATED_THUMBS_KEY).then(
      (raw) => {
        if (!cancelled) setMode(parseAnimatedThumbsMode(raw));
      },
      (error) => console.warn('[thumbs] mode read failed:', String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [db, focused]);
  return mode;
}

export interface CellPlayback {
  playing: boolean;
  /** One at a time: a new key restarts the spotlight's player. */
  spotKey: number;
  loop: boolean;
  onEnd?: () => void;
}

export interface AnimatedCells {
  listProps: {
    viewabilityConfig: typeof VIEWABILITY;
    onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    /** Hand this to `extraData`: the cells re-render on it. */
    extraData: readonly unknown[];
  };
  /** A cell's playback, by its index AND its row's identity (id:version):
   * a replacement row at a settled index plays only after its own settle. */
  cellFor: (index: number, key: string) => CellPlayback;
  pool: () => PlayerPool | null;
}

export function useAnimatedCells({
  mode,
  columns,
  tileDp,
  kindAt,
  rows,
  cellOf,
}: {
  mode: AnimatedThumbsMode | null;
  columns: number;
  tileDp: number;
  /** What the cell at an index animates as (null = a photo). */
  kindAt: (index: number) => AnimatedKind | null;
  /** The list's data: its identity re-reads the kinds (a re-decided
   * cull can change what an index holds without moving the indices). */
  rows: readonly unknown[];
  /** A viewable token's cell: its list index and its row's identity
   * (id + version) — a replacement row at the same index is a new cell. */
  cellOf: (token: ViewToken) => VisibleCell;
}): AnimatedCells {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);
  const active = mode !== null && mode !== 'off' && foreground;

  // The visible set, from the list's viewability (any part on screen),
  // each cell carrying its row's identity.
  const [visible, setVisible] = useState<readonly VisibleCell[]>([]);
  const cellOfRef = useRef(cellOf);
  cellOfRef.current = cellOf;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const next = viewableItems
      .map((token) => cellOfRef.current(token))
      .sort((a, b) => a.index - b.index);
    setVisible((previous) => (sameCells(previous, next) ? previous : next));
  }).current;

  // The settled set: the visible set once it has held for the settle.
  const [settled, setSettled] = useState<readonly VisibleCell[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(visible), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  const playing = useMemo(
    () => (active ? playingSet(settled, visible) : []),
    [active, settled, visible],
  );
  // The sink line the release gate asserts on (design §8), once per
  // change of a non-empty set.
  const playingKey = playing.map((c) => c.index).join(',');
  useEffect(() => {
    if (playingKey !== '') console.log(`[thumbs] playing: ${playingKey}`);
  }, [playingKey]);

  // One at a time: the walk over the playing set's clips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const walk = useMemo(() => spotWalk(playing, kindAt), [playing, kindAt, rows]);
  // The spot is a step WITHIN a walk: a new walk starts at its first
  // cell in the same render (a reset from an effect would let the old
  // step's cell borrow a player for one commit — codex round 2), and
  // each turn hands over exactly once, whichever of the clip's end and
  // the dwell cap comes first.
  // The walk's key carries the cells' identities: a replacement row at
  // a walked index is a new walk.
  const walkKey = walk.map((c) => `${c.index}:${c.key}`).join(',');
  const [step, setStep] = useState({ walkKey, index: 0 });
  const spot = step.walkKey === walkKey ? step.index : 0;
  // One hand-over per turn: the clip's end and the dwell timer both
  // name the turn they end, and only the current turn advances.
  const advance = useCallback(
    (turn: number) => {
      setStep((current) => {
        const currentIndex = current.walkKey === walkKey ? current.index : 0;
        return currentIndex === turn ? { walkKey, index: turn + 1 } : current;
      });
    },
    [walkKey],
  );
  const spotting = mode === 'one' && walk.length > 0;
  useEffect(() => {
    if (!spotting) return;
    const timer = setTimeout(() => advance(spot), DWELL_MS);
    return () => clearTimeout(timer);
  }, [spotting, spot, advance]);
  const spotCell = spotting ? walk[spot % walk.length] : null;

  // The pool: lazy, sized from the layout at the first borrow.
  const [listHeight, setListHeight] = useState(0);
  const geometry = useRef({ columns, tileDp, listHeight });
  geometry.current = { columns, tileDp, listHeight };
  const poolRef = useRef<PlayerPool | null>(null);
  const pool = useCallback(() => {
    if (poolRef.current === null) {
      const g = geometry.current;
      poolRef.current = makePlayerPool(poolSizeFor(g.columns, g.listHeight, g.tileDp));
    }
    return poolRef.current;
  }, []);
  useEffect(() => {
    if (active) return;
    poolRef.current?.release();
    poolRef.current = null;
  }, [active]);
  useEffect(
    () => () => {
      poolRef.current?.release();
      poolRef.current = null;
    },
    [],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setListHeight(event.nativeEvent.layout.height);
  }, []);

  const cellFor = useCallback(
    (index: number, key: string): CellPlayback => {
      if (!active || !playing.some((c) => c.index === index && c.key === key)) {
        return { playing: false, spotKey: 0, loop: true };
      }
      const kind = kindAt(index);
      if (mode === 'one' && kind !== 'gif') {
        return {
          playing: spotCell !== null && spotCell.index === index && spotCell.key === key,
          spotKey: spot,
          loop: false,
          onEnd: () => advance(spot),
        };
      }
      return { playing: true, spotKey: 0, loop: true };
    },
    [active, playing, kindAt, mode, spotCell, spot, advance],
  );

  return {
    listProps: {
      viewabilityConfig: VIEWABILITY,
      onViewableItemsChanged,
      onLayout,
      extraData: [playing, spotCell, spot],
    },
    cellFor,
    pool,
  };
}
