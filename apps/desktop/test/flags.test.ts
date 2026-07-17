import { describe, expect, it, vi } from 'vitest';
import { UNDO_WINDOW_MS, createFlagController, flagTypeForKey, isShowHotkey } from '../src/renderer/flags';

describe('flagTypeForKey', () => {
  it('maps D/E/M/R case-insensitively', () => {
    expect(flagTypeForKey('d')).toBe('delete');
    expect(flagTypeForKey('D')).toBe('delete');
    expect(flagTypeForKey('e')).toBe('edit');
    expect(flagTypeForKey('M')).toBe('move');
    expect(flagTypeForKey('r')).toBe('review');
  });

  it('maps the v0.5 keys: N = rename, T = date', () => {
    expect(flagTypeForKey('n')).toBe('rename');
    expect(flagTypeForKey('N')).toBe('rename');
    expect(flagTypeForKey('t')).toBe('date');
    expect(flagTypeForKey('T')).toBe('date');
  });

  it('returns null for everything else', () => {
    for (const key of ['x', 'Escape', 'Enter', ' ', 'ArrowRight', 'q', 'o']) {
      expect(flagTypeForKey(key)).toBeNull();
    }
  });
});

describe('isShowHotkey', () => {
  it('exempts flag keys plus O, Q and S, both cases', () => {
    for (const key of ['d', 'e', 'm', 'r', 'n', 't', 'o', 'q', 's', 'D', 'E', 'M', 'R', 'N', 'T', 'O', 'Q', 'S']) {
      expect(isShowHotkey(key)).toBe(true);
    }
  });

  it('exempts the v0.5 arrow nav keys', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(isShowHotkey(key)).toBe(true);
    }
  });

  it('does not exempt exit keys', () => {
    for (const key of ['Escape', 'Enter', ' ', 'a', 'PageDown']) {
      expect(isShowHotkey(key)).toBe(false);
    }
  });
});

function make(startMs = 1000) {
  let now = startMs;
  const add = vi.fn();
  const remove = vi.fn();
  const toast = vi.fn();
  const controller = createFlagController({ now: () => now, add, remove, toast });
  return {
    controller,
    add,
    remove,
    toast,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('flag controller', () => {
  it('flags the current item and toasts with undo hint', () => {
    const { controller, add, toast } = make();
    expect(controller.keyPressed('e', 'item-1')).toBe(true);
    expect(add).toHaveBeenCalledExactlyOnceWith('item-1', 'edit');
    expect(toast).toHaveBeenCalledExactlyOnceWith('Flagged for edit — E again to undo');
  });

  it('same key within the undo window un-flags instead', () => {
    const { controller, add, remove, toast, tick } = make();
    controller.keyPressed('d', 'item-1');
    tick(UNDO_WINDOW_MS - 1);
    expect(controller.keyPressed('d', 'item-1')).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith('item-1', 'delete');
    expect(toast).toHaveBeenLastCalledWith('Delete flag removed');
  });

  it('after the undo window expires the same key re-flags', () => {
    const { controller, add, remove, tick } = make();
    controller.keyPressed('r', 'item-1');
    tick(UNDO_WINDOW_MS + 1);
    controller.keyPressed('r', 'item-1');
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it('undo → third press flags again (toggle round-trip)', () => {
    const { controller, add, remove } = make();
    controller.keyPressed('m', 'item-1');
    controller.keyPressed('m', 'item-1'); // undo
    controller.keyPressed('m', 'item-1'); // flag again
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('a different flag key on the same item flags separately (no undo)', () => {
    const { controller, add, remove } = make();
    controller.keyPressed('d', 'item-1');
    controller.keyPressed('e', 'item-1');
    expect(add).toHaveBeenNthCalledWith(1, 'item-1', 'delete');
    expect(add).toHaveBeenNthCalledWith(2, 'item-1', 'edit');
    expect(remove).not.toHaveBeenCalled();
  });

  it('slide advance clears the pending undo — same key flags the NEW item', () => {
    const { controller, add, remove } = make();
    controller.keyPressed('e', 'item-1');
    controller.itemChanged();
    controller.keyPressed('e', 'item-2');
    expect(add).toHaveBeenNthCalledWith(2, 'item-2', 'edit');
    expect(remove).not.toHaveBeenCalled();
  });

  it('ignores non-flag keys and null items', () => {
    const { controller, add, toast } = make();
    expect(controller.keyPressed('x', 'item-1')).toBe(false);
    expect(controller.keyPressed('e', null)).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('uppercase keys work and the toast echoes the pressed key', () => {
    const { controller, toast } = make();
    controller.keyPressed('R', 'item-1');
    expect(toast).toHaveBeenCalledExactlyOnceWith('Flagged for review — R again to undo');
  });

  it('v0.5 flags toast with their labels and undo like the others', () => {
    const { controller, add, remove, toast } = make();
    controller.keyPressed('n', 'item-1');
    expect(add).toHaveBeenCalledExactlyOnceWith('item-1', 'rename');
    expect(toast).toHaveBeenLastCalledWith('Flagged for rename — N again to undo');
    controller.keyPressed('t', 'item-1');
    expect(add).toHaveBeenLastCalledWith('item-1', 'date');
    expect(toast).toHaveBeenLastCalledWith('Flagged for date fix — T again to undo');
    controller.keyPressed('t', 'item-1'); // undo within the window
    expect(remove).toHaveBeenCalledExactlyOnceWith('item-1', 'date');
    expect(toast).toHaveBeenLastCalledWith('Date fix flag removed');
  });
});
