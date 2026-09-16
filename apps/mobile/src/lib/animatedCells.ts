/**
 * Animated thumbnails — the pure rules (m0.9 phase 6,
 * docs/AnimatedThumbnails_design.md D2/D4/D5/D6). Every thumbnail
 * surface animates the clips on screen through real players; these are
 * the rules that decide WHICH cells play, sized and sequenced without a
 * view in sight. The impure partner is components/useAnimatedCells.ts.
 *
 *  - The playing set is the SETTLED set ∩ the VISIBLE set: a cell that
 *    entered the screen plays only once the visible set has held for
 *    the settle, a cell that left stops at once (D5 — the tester's feel
 *    on both phones: entering may wait, leaving may not).
 *  - The pool is sized from the list's geometry, never a constant (D6):
 *    the cells a screen can hold with any part visible.
 *  - One at a time walks the playing set's video and motion cells in
 *    order; GIFs play on their own (D4).
 */
import type { StoredMediaKind } from './mediaIdentity';

/** What a thumbnail can animate as; null = a plain photo. */
export type AnimatedKind = 'video' | 'motion' | 'gif';

/** The Settings row (D3): Off · One at a time · All visible. */
export type AnimatedThumbsMode = 'off' | 'one' | 'all';
export const ANIMATED_THUMBS_KEY = 'animated_thumbnails';
export const ANIMATED_THUMBS_MODES: readonly { id: AnimatedThumbsMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'one', label: 'One at a time' },
  { id: 'all', label: 'All visible' },
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
/** Any part of a cell on screen counts (D5). */
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

/** Settled ∩ visible (by identity), in index order. */
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

/** The spotlight's walk: the playing set's video and motion cells. */
export function spotWalk(
  playing: readonly VisibleCell[],
  kindAt: (index: number) => AnimatedKind | null,
): readonly VisibleCell[] {
  return playing.filter((c) => {
    const kind = kindAt(c.index);
    return kind === 'video' || kind === 'motion';
  });
}

/** Whether two cell lists are the same cells in the same order. */
export function sameCells(a: readonly VisibleCell[], b: readonly VisibleCell[]): boolean {
  return a.length === b.length && a.every((v, i) => v.index === b[i].index && v.key === b[i].key);
}
