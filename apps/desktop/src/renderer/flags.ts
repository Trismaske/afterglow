/**
 * Flag-capture keyboard logic, kept pure (time injected, effects via deps)
 * so it is unit-testable without a DOM.
 *
 * Semantics (PLAN.md v0.2):
 * - D / E / M / R (case-insensitive) flag the *current* photo; the slideshow
 *   never stops.
 * - Pressing the SAME key again within the undo window — while the same
 *   photo is still on screen — un-flags it. Once the slide advances, keys
 *   apply to the new photo (undo intent can't outlive its photo).
 * - Every action shows an unobtrusive toast.
 */

import type { FlagType } from '@afterglow/core';

export const UNDO_WINDOW_MS = 4000;

const KEY_TO_FLAG: Readonly<Record<string, FlagType>> = {
  d: 'delete',
  e: 'edit',
  m: 'move',
  r: 'review',
};

const FLAG_LABEL: Readonly<Record<FlagType, string>> = {
  delete: 'delete',
  edit: 'edit',
  move: 'move',
  review: 'review',
};

/** FlagType for a keyboard key, or null if it isn't a flag key. */
export function flagTypeForKey(key: string): FlagType | null {
  return KEY_TO_FLAG[key.toLowerCase()] ?? null;
}

/** Hotkeys that must never exit the show: flag keys + O (overlay) + Q (queue). */
export function isShowHotkey(key: string): boolean {
  const k = key.toLowerCase();
  return k === 'o' || k === 'q' || flagTypeForKey(k) !== null;
}

export interface FlagControllerDeps {
  now(): number;
  /** Persist a flag (fire-and-forget from the controller's perspective). */
  add(item: string, flagType: FlagType): void;
  /** Remove a flag. */
  remove(item: string, flagType: FlagType): void;
  /** Show a toast. Should stay up for roughly UNDO_WINDOW_MS. */
  toast(message: string): void;
}

export interface FlagController {
  /** Call when the slideshow advances — clears any pending undo. */
  itemChanged(): void;
  /**
   * Handle a keypress against the item currently on screen (any opaque id —
   * the renderer uses the media URL). Returns true if the key was a flag key
   * and was acted on (the caller must then NOT forward it to the exit path).
   */
  keyPressed(key: string, currentItem: string | null): boolean;
}

export function createFlagController(deps: FlagControllerDeps): FlagController {
  let pending: { item: string; flagType: FlagType; until: number } | null = null;

  return {
    itemChanged() {
      pending = null;
    },
    keyPressed(key, currentItem) {
      const flagType = flagTypeForKey(key);
      if (!flagType || currentItem === null) return false;
      const now = deps.now();

      if (pending && pending.item === currentItem && pending.flagType === flagType && now <= pending.until) {
        pending = null;
        deps.remove(currentItem, flagType);
        deps.toast(`${capitalize(FLAG_LABEL[flagType])} flag removed`);
        return true;
      }

      pending = { item: currentItem, flagType, until: now + UNDO_WINDOW_MS };
      deps.add(currentItem, flagType);
      deps.toast(`Flagged for ${FLAG_LABEL[flagType]} — ${key.toUpperCase()} again to undo`);
      return true;
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
