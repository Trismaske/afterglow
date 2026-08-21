import { describe, expect, it } from 'vitest';
import { createRepeatSuppressor, formatDiagLine, joinConsoleArgs } from './diagShape';

const T = 1_800_000_000_000;

describe('formatDiagLine', () => {
  it('stamps ISO time, level letter, message', () => {
    expect(formatDiagLine('W', '[scan] failed: x', T)).toBe(
      `${new Date(T).toISOString()} W [scan] failed: x`,
    );
  });
});

describe('joinConsoleArgs', () => {
  it('keeps strings, stringifies objects, and takes an Error stack', () => {
    const error = new Error('boom');
    const joined = joinConsoleArgs(['[scan] delta:', 3, { a: 1 }, error]);
    expect(joined).toContain('[scan] delta: 3 {"a":1}');
    expect(joined).toContain('boom');
    // The stack is the crash hook's whole value.
    expect(joined).toContain(error.stack ? error.stack.split('\n')[1].trim() : 'boom');
  });

  it('never throws on a cyclic object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(joinConsoleArgs([cyclic])).toBe('[object Object]');
  });
});

describe('createRepeatSuppressor', () => {
  it('lets the first three identical lines through, then suppresses', () => {
    const s = createRepeatSuppressor(60_000, 3);
    expect(s.offer('echo', T).emit).toBe(true);
    expect(s.offer('echo', T + 1).emit).toBe(true);
    expect(s.offer('echo', T + 2).emit).toBe(true);
    expect(s.offer('echo', T + 3).emit).toBe(false);
    expect(s.offer('echo', T + 4).emit).toBe(false);
  });

  it('distinct messages never mask each other — root causes always land', () => {
    const s = createRepeatSuppressor(60_000, 1);
    expect(s.offer('cause A', T).emit).toBe(true);
    expect(s.offer('cause B', T + 1).emit).toBe(true);
    expect(s.offer('cause C', T + 2).emit).toBe(true);
  });

  it('a new window emits a summary naming the suppressed volume', () => {
    const s = createRepeatSuppressor(60_000, 3);
    for (let i = 0; i < 8; i += 1) s.offer('echo', T + i);
    const next = s.offer('echo', T + 60_000);
    expect(next.emit).toBe(true);
    expect(next.summary).toBe('echo [repeated 5× more in 60 s]');
  });

  it('a window that closes with nothing suppressed has no summary', () => {
    const s = createRepeatSuppressor(60_000, 3);
    s.offer('quiet', T);
    const next = s.offer('quiet', T + 60_000);
    expect(next).toEqual({ emit: true, summary: null });
  });

  it('sweep closes expired windows so a stopped burst still reports', () => {
    const s = createRepeatSuppressor(60_000, 3);
    for (let i = 0; i < 10; i += 1) s.offer('burst', T + i);
    s.offer('other', T);
    expect(s.sweep(T + 30_000)).toEqual([]); // nothing expired yet
    expect(s.sweep(T + 60_000)).toEqual(['burst [repeated 7× more in 60 s]']);
    // Idempotent: a swept window is gone.
    expect(s.sweep(T + 120_000)).toEqual([]);
  });

  it('caps its key map by resetting rather than growing forever', () => {
    const s = createRepeatSuppressor(60_000, 1, 5);
    for (let i = 0; i < 5; i += 1) s.offer(`key ${i}`, T);
    expect(s.offer('key 0', T + 1).emit).toBe(false); // suppressed, map full but key known
    // A NEW key past the cap clears the map; everything emits again.
    expect(s.offer('key new', T + 2).emit).toBe(true);
    expect(s.offer('key 0', T + 3).emit).toBe(true);
  });
});
