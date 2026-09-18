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
 * Each cell SUBSCRIBES to its own playback (`useCellPlayback`): the
 * list's props never change when the playing set does. They must not —
 * React Native resets a list's viewability whenever `data` or
 * `extraData` changes (VirtualizedList.componentDidUpdate), and an
 * `extraData` that followed the playing set made a feedback loop: every
 * change emptied the visible set, which regrew row by row, handing
 * sixteen players back and re-borrowing them within a second (the
 * S10e's sink, 2026-09-18).
 *
 * The app in the BACKGROUND empties the playing set (expo-video pauses
 * attached players there and nothing would restart them — codex round
 * 1): every cell hands its player back, and the foreground return
 * lets the settled cells borrow and play again.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
import type { AnimatedThumbRow } from '../lib/animatedThumbRow';
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
  /** The list is being dragged or flung: a playing cell HOLDS its frame
   * (the player pauses, the view and the borrow stay) until it stops. */
  held: boolean;
  /** One at a time: a new key restarts the spotlight's player. */
  spotKey: number;
  loop: boolean;
  onEnd?: () => void;
}

/** The controller a list hands its cells: STABLE for the list's life, so
 * handing it down never re-renders a cell or resets viewability. */
export interface AnimatedCells {
  listProps: {
    viewabilityConfig: typeof VIEWABILITY;
    onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScrollBeginDrag: () => void;
    onScrollEndDrag: () => void;
    onMomentumScrollBegin: () => void;
    onMomentumScrollEnd: () => void;
    onTouchEnd: () => void;
  };
  subscribe: (listener: () => void) => () => void;
  /** A thumbnail's playback as a primitive snapshot, by its item's index
   * AND identity (a replacement row at a settled index plays only after
   * its own settle) and its place inside the item (`sub`: 0 for a grid
   * cell or a row, the position in a card's row of thumbnails). */
  snapshotFor: (index: number, key: string, sub: number) => string;
  /** For a host WITHOUT a virtualized list (a header's cards, the deck's
   * strip): the items any part of which is on screen, from the host's
   * own scroll geometry (lib/animatedCells `visibleRange`). */
  reportVisible: (cells: readonly VisibleCell[]) => void;
  /** The same motion signal a list's scroll callbacks give. */
  reportMoving: (moving: boolean) => void;
  advance: (turn: number) => void;
  pool: () => PlayerPool | null;
}

const IDLE = '0:0:1:0';
/** A drag's end waits this long for a fling to begin before the list
 * counts as still. */
const DRAG_END_MS = 120;

/** A cell's own playback: re-renders THIS cell only when its answer
 * changes. */
export function useCellPlayback(
  cells: AnimatedCells,
  index: number,
  key: string,
  sub = 0,
): CellPlayback {
  const snapshot = useSyncExternalStore(cells.subscribe, () => cells.snapshotFor(index, key, sub));
  return useMemo(() => {
    const [playing, spotKey, loop, held] = snapshot.split(':');
    const turn = Number(spotKey);
    return {
      playing: playing === '1',
      held: held === '1',
      spotKey: turn,
      loop: loop === '1',
      onEnd: loop === '1' ? undefined : () => cells.advance(turn),
    };
  }, [snapshot, cells]);
}

export function useAnimatedCells({
  mode,
  columns,
  tileDp,
  kindsAt,
  rows,
  cellOf,
}: {
  mode: AnimatedThumbsMode | null;
  /** Thumbnails across the list: a grid's columns, a card's row. */
  columns: number;
  /** An item's extent along the scroll: a tile, a row, a card. */
  tileDp: number;
  /** What the thumbnails of the item at an index animate as (null = a
   * photo): one entry for a grid cell or a row, a card's row of them. */
  kindsAt: (index: number) => readonly (AnimatedKind | null)[];
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
  const playerCount = playing.reduce(
    (n, c) => n + kindsAt(c.index).filter((k) => k === 'video' || k === 'motion').length,
    0,
  );
  useEffect(() => {
    if (playingKey !== '') console.log(`[thumbs] playing: ${playingKey} (players ${playerCount})`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingKey]);

  // One at a time: the walk over the playing set's clips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const walk = useMemo(() => spotWalk(playing, kindsAt), [playing, kindsAt, rows]);
  // The spot is a step WITHIN a walk: a new walk starts at its first
  // cell in the same render (a reset from an effect would let the old
  // step's cell borrow a player for one commit — codex round 2), and
  // each turn hands over exactly once, whichever of the clip's end and
  // the dwell cap comes first.
  // The walk's key carries the cells' identities: a replacement row at
  // a walked index is a new walk.
  const walkKey = walk.map((c) => `${c.index}:${c.key}:${c.sub}`).join(',');
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
  // The dwell does not run while the list MOVES (held cells keep their
  // view, their borrow and their turn — codex 2026-09-19); it starts over
  // when the list stops.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!spotting || moving) return;
    const timer = setTimeout(() => advance(spot), DWELL_MS);
    return () => clearTimeout(timer);
  }, [spotting, moving, spot, advance]);
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

  // The list in MOTION (a drag or its fling): playing cells hold their
  // frame. Seventeen live video textures cost the S10e's render thread
  // 18.9 % janky frames under a drag against 0 % with one (2026-09-18);
  // a held player updates no texture, and resumes when the list stops.
  const dragEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDragEnd = useCallback(() => {
    if (dragEnd.current !== null) clearTimeout(dragEnd.current);
    dragEnd.current = null;
  }, []);
  const onScrollBeginDrag = useCallback(() => {
    clearDragEnd();
    setMoving(true);
  }, [clearDragEnd]);
  const onScrollEndDrag = useCallback(() => {
    clearDragEnd();
    dragEnd.current = setTimeout(() => setMoving(false), DRAG_END_MS);
  }, [clearDragEnd]);
  const onMomentumScrollBegin = useCallback(() => {
    clearDragEnd();
    setMoving(true);
  }, [clearDragEnd]);
  const onMomentumScrollEnd = useCallback(() => {
    clearDragEnd();
    setMoving(false);
  }, [clearDragEnd]);
  // A finger that STOPS a fling with a tap gets no momentum-end event
  // (React Native cancels it on ACTION_DOWN) and begins no drag: the
  // touch's end is then the only signal, and it releases the hold like a
  // drag's end does unless a fling follows (codex 2026-09-19).
  const onTouchEnd = onScrollEndDrag;
  // A list that is not animating holds nothing over for its return.
  useEffect(() => {
    if (active) return;
    clearDragEnd();
    setMoving(false);
  }, [active, clearDragEnd]);
  useEffect(() => clearDragEnd, [clearDragEnd]);

  // The store the cells subscribe to: the current answer lives in a ref,
  // and a change notifies the listeners — the list itself is untouched.
  // PUBLISHED AT COMMIT, never during render (codex, 2026-09-18): a
  // concurrent render can be abandoned after it ran, and the cells must
  // only ever read an answer React committed — so the ref is written and
  // the listeners told in one layout effect.
  const answer = useRef({ active, playing, kindsAt, mode, spotCell, spot, advance, moving });
  const listeners = useRef(new Set<() => void>()).current;
  useLayoutEffect(() => {
    answer.current = { active, playing, kindsAt, mode, spotCell, spot, advance, moving };
    for (const listener of listeners) listener();
  }, [listeners, active, playing, kindsAt, mode, spotCell, spot, advance, moving]);
  const subscribe = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [listeners],
  );
  const snapshotFor = useCallback((index: number, key: string, sub: number): string => {
    const now = answer.current;
    if (!now.active || !now.playing.some((c) => c.index === index && c.key === key)) return IDLE;
    if (now.mode === 'one' && now.kindsAt(index)[sub] !== 'gif') {
      const spotted =
        now.spotCell !== null &&
        now.spotCell.index === index &&
        now.spotCell.key === key &&
        now.spotCell.sub === sub;
      return `${spotted ? 1 : 0}:${now.spot}:0:${now.moving ? 1 : 0}`;
    }
    return `1:0:1:${now.moving ? 1 : 0}`;
  }, []);
  const advanceTurn = useCallback((turn: number) => answer.current.advance(turn), []);
  const reportVisible = useCallback((next: readonly VisibleCell[]) => {
    setVisible((previous) => (sameCells(previous, next) ? previous : next));
  }, []);
  const reportMoving = useCallback(
    (next: boolean) => {
      clearDragEnd();
      setMoving(next);
    },
    [clearDragEnd],
  );

  return useMemo(
    () => ({
      listProps: {
        viewabilityConfig: VIEWABILITY,
        onViewableItemsChanged,
        onLayout,
        onScrollBeginDrag,
        onScrollEndDrag,
        onMomentumScrollBegin,
        onMomentumScrollEnd,
        onTouchEnd,
      },
      subscribe,
      snapshotFor,
      reportVisible,
      reportMoving,
      advance: advanceTurn,
      pool,
    }),
    [
      onViewableItemsChanged,
      onLayout,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      onTouchEnd,
      subscribe,
      snapshotFor,
      reportVisible,
      reportMoving,
      advanceTurn,
      pool,
    ],
  );
}

/** The common host: a FlatList of rows with ONE thumbnail each (a grid
 * cell or a list row). Spread `listProps` on the FlatList and render
 * `<AnimatedThumb row={thumbRows[index]} index={index} cells={cells} />`.
 * `thumbOf` must be stable (a module-level function). */
export function useAnimatedList<T>({
  rows,
  thumbOf,
  columns,
  tileDp,
}: {
  rows: readonly T[];
  thumbOf: (row: T) => AnimatedThumbRow;
  columns: number;
  tileDp: number;
}): { cells: AnimatedCells; thumbRows: readonly AnimatedThumbRow[] } {
  const mode = useAnimatedThumbsMode();
  const thumbRows = useMemo(() => rows.map(thumbOf), [rows, thumbOf]);
  const current = useRef(thumbRows);
  current.current = thumbRows;
  const kindsAt = useCallback((index: number) => [current.current[index]?.animated ?? null], []);
  const cellOf = useCallback((token: ViewToken) => {
    const index = token.index ?? -1;
    const row = current.current[index];
    return { index, key: row ? `${row.id}:${row.version}` : String(index) };
  }, []);
  const cells = useAnimatedCells({ mode, columns, tileDp, kindsAt, rows: thumbRows, cellOf });
  return { cells, thumbRows };
}
