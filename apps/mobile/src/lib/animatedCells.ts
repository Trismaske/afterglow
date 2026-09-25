/**
 * Animated thumbnails — the pure rules (m0.9 phase 6). Every thumbnail
 * surface animates the clips on screen through real players; these are
 * the rules that decide WHICH cells play, sized and sequenced without a
 * view in sight. The impure partner is components/useAnimatedCells.ts.
 *
 *  - The playing set is the SETTLED set ∩ the VISIBLE set: a cell that
 *    entered the screen plays only once the visible set has held for
 *    the settle, a cell that left stops at once (the tester's feel
 *    on both phones: entering may wait, leaving may not).
 *  - The pool is sized from the list's geometry, never a constant:
 *    the cells a screen can hold with any part visible.
 *  - One at a time walks the playing set's video and motion cells in
 *    order; GIFs play on their own.
 */
import type { StoredMediaKind } from './mediaIdentity';

/** What a thumbnail can animate as; null = a plain photo. */
export type AnimatedKind = 'video' | 'motion' | 'gif';

/** The Settings row: Off · One · All (the short labels — the row's
 * explanation says what One and All mean; Tristan, 2026-09-18). */
export type AnimatedThumbsMode = 'off' | 'one' | 'all';
export const ANIMATED_THUMBS_KEY = 'animated_thumbnails';
export const ANIMATED_THUMBS_MODES: readonly { id: AnimatedThumbsMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'one', label: 'One' },
  { id: 'all', label: 'All' },
];
export const DEFAULT_ANIMATED_THUMBS_MODE: AnimatedThumbsMode = 'all';
/** A stored value → mode; anything unrecognised (a missing row too) is
 * the default, so a corrupt row never silences the grids by accident. */
export function parseAnimatedThumbsMode(raw: string | null): AnimatedThumbsMode {
  return raw === 'off' || raw === 'one' || raw === 'all' ? raw : DEFAULT_ANIMATED_THUMBS_MODE;
}

/** The tunables the tester settled on the probe (2026-09-16). */
export const SETTLE_MS = 500;
export const DWELL_MS = 5000;
/** Any part of a cell on screen counts. */
export const VIEWABILITY = { itemVisiblePercentThreshold: 1, minimumViewTime: 100 } as const;

/** What a row animates as, from the facts every row carries. */
export function animatedKindOf(row: {
  kind: StoredMediaKind;
  mimeType: string | null;
  hasMotion: boolean;
}): AnimatedKind | null {
  if (row.kind === 'video') return 'video';
  if (row.hasMotion) return 'motion';
  if (row.mimeType === 'image/gif') return 'gif';
  return null;
}

/** A cell on screen: its list index AND its row's identity (id +
 * version) — a replacement row at the same index is a new cell, which
 * earns its own settle and starts a new walk. */
export interface VisibleCell {
  index: number;
  key: string;
}

/** Settled ∩ visible (by identity), in index order. The viewport is the
 * only bound (2026-09-18, Tristan): with any part of a cell counting,
 * the set can never exceed the list's geometry — columns × the rows on
 * screen plus the two cut rows — which is what the pool is sized from;
 * a ceiling on top would only restate the pool's size. */
export function playingSet(
  settled: readonly VisibleCell[],
  visible: readonly VisibleCell[],
): readonly VisibleCell[] {
  const seen = new Set(visible.map((c) => `${c.index}:${c.key}`));
  return settled.filter((c) => seen.has(`${c.index}:${c.key}`));
}

/** The cells a list can hold with any part visible: its columns times
 * the rows its height holds, plus a cut row at the top AND the bottom,
 * plus one row of settle overlap. */
export function poolSizeFor(columns: number, listHeight: number, tileDp: number): number {
  if (!(tileDp > 0)) return columns;
  const rows = Math.max(1, Math.floor(listHeight / tileDp));
  return columns * (rows + 3);
}

/** One thumbnail inside a visible ITEM: a grid cell or a list row holds
 * one (sub 0); a timeline card holds a row of them. */
export interface SpotCell extends VisibleCell {
  sub: number;
}

/** The spotlight's walk: the playing items' video and motion thumbnails,
 * item by item and left to right within one. `kindsAt` lists an item's
 * thumbnails' kinds. */
export function spotWalk(
  playing: readonly VisibleCell[],
  kindsAt: (index: number) => readonly (AnimatedKind | null)[],
): readonly SpotCell[] {
  const walk: SpotCell[] = [];
  for (const cell of playing) {
    kindsAt(cell.index).forEach((kind, sub) => {
      if (kind === 'video' || kind === 'motion') walk.push({ ...cell, sub });
    });
  }
  return walk;
}

/** Which of a list's items a scrolled viewport shows any part of, for a
 * host WITHOUT a virtualized list (a header's cards, the deck's strip):
 * items laid out one after another from `start`, each `extent` long with
 * `gap` between. */
export function visibleRange(
  count: number,
  start: number,
  extent: number,
  gap: number,
  offset: number,
  viewport: number,
): readonly number[] {
  if (!(extent > 0) || !(viewport > 0)) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = start + i * (extent + gap);
    if (from + extent > offset && from < offset + viewport) out.push(i);
  }
  return out;
}

/** Whether two cell lists are the same cells in the same order. */
export function sameCells(a: readonly VisibleCell[], b: readonly VisibleCell[]): boolean {
  return a.length === b.length && a.every((v, i) => v.index === b[i].index && v.key === b[i].key);
}
