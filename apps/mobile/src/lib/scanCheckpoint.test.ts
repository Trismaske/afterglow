import { describe, expect, it } from 'vitest';
import {
  advance,
  canResume,
  changesAboveBoundary,
  checkpointScope,
  parseCheckpoint,
  type ScanCheckpoint,
} from './scanCheckpoint';

const scope = checkpointScope({
  roots: [{ volume: 'external_primary', dir: 'DCIM/Camera' }],
  strictness: null,
  modelSha: 'abc',
  rules: 'r1',
});
const gens = { 'external_primary|v1': 100 };
const cp: ScanCheckpoint = {
  scope,
  boundary: 1_700_000_000_000,
  scanned: 1200,
  generations: gens,
  reason: 'weekly',
};

describe('checkpointScope', () => {
  it('binds sources, strictness, model and rules — never generations', () => {
    expect(scope).toBe('src:external_primary:DCIM/Camera|strict:default|model:abc|rules:r1');
    expect(
      checkpointScope({ roots: null, strictness: 'strict', modelSha: 'abc', rules: 'r2' }),
    ).toBe('src:*|strict:strict|model:abc|rules:r2');
    expect(scope).not.toContain('gen');
  });
});

describe('parseCheckpoint', () => {
  it('round-trips a checkpoint and rejects anything malformed', () => {
    expect(parseCheckpoint(JSON.stringify(cp))).toEqual(cp);
    // A checkpoint written without a reason, or with a word the set
    // does not know, parses without one (the line then says "Resuming
    // last scan").
    const { reason: _dropped, ...bare } = cp;
    expect(parseCheckpoint(JSON.stringify(bare))).toEqual(bare);
    expect(parseCheckpoint(JSON.stringify({ ...cp, reason: 'bogus' }))).toEqual(bare);
    expect(parseCheckpoint(null)).toBeNull();
    expect(parseCheckpoint('not json')).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...cp, boundary: 'x' }))).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...cp, scanned: -1 }))).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...cp, generations: { a: 'b' } }))).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...cp, generations: null }))).toBeNull();
  });
});

describe('canResume', () => {
  it('needs the same scope and a since-generation for every mounted volume', () => {
    expect(canResume(cp, { scope, generationKeys: ['external_primary|v1'] })).toBe(true);
    expect(canResume(cp, { scope: 'other', generationKeys: ['external_primary|v1'] })).toBe(false);
    // A card inserted since has no generation to re-page from.
    expect(canResume(cp, { scope, generationKeys: ['external_primary|v1', 'abcd-1234|v1'] })).toBe(
      false,
    );
    // A provider rebuild moves the version into every key.
    expect(canResume(cp, { scope, generationKeys: ['external_primary|v2'] })).toBe(false);
    expect(canResume(cp, { scope, generationKeys: [] })).toBe(false);
    // A volume the checkpoint covered is away now: its lower part is
    // still owed, and a pass over the rest must not spend the checkpoint.
    const two = { ...cp, generations: { ...gens, 'abcd-1234|v1': 7 } };
    expect(canResume(two, { scope, generationKeys: ['external_primary|v1'] })).toBe(false);
    expect(canResume(two, { scope, generationKeys: ['external_primary|v1', 'abcd-1234|v1'] })).toBe(
      true,
    );
    expect(canResume(null, { scope, generationKeys: ['external_primary|v1'] })).toBe(false);
  });
});

describe('advance', () => {
  it("moves the boundary to the closed window's oldest member", () => {
    const next = advance(null, {
      scope,
      generations: gens,
      windowTimesMs: [1_700_000_010_000, 1_700_000_005_000, 1_700_000_001_000],
      scanned: 200,
      reason: 'first',
    });
    expect(next).toEqual({
      scope,
      boundary: 1_700_000_001_000,
      scanned: 200,
      generations: gens,
      reason: 'first',
    });
  });

  it("only ever decreases within a scope (a resume's above-boundary windows do not move it back up)", () => {
    const at = (windowTimesMs: number[], scanned: number) =>
      advance(cp, { scope, generations: gens, windowTimesMs, scanned, reason: 'weekly' });
    expect(at([cp.boundary + 5_000], 1)).toBeNull();
    expect(at([cp.boundary], 1)).toBeNull();
    expect(at([cp.boundary - 1], 1300)).toEqual({
      ...cp,
      boundary: cp.boundary - 1,
      scanned: 1300,
    });
  });

  it('an empty window advances nothing', () => {
    expect(
      advance(cp, { scope, generations: gens, windowTimesMs: [], scanned: 1, reason: 'weekly' }),
    ).toBeNull();
  });
});

describe('changesAboveBoundary', () => {
  it('keeps dated, non-trashed rows at or above the boundary', () => {
    const rows = [
      { id: 'above', dateTakenMs: 2000, isTrashed: false },
      { id: 'at', dateTakenMs: 1000, isTrashed: false },
      { id: 'below', dateTakenMs: 999, isTrashed: false },
      { id: 'undated', dateTakenMs: null, isTrashed: false },
      { id: 'trashed', dateTakenMs: 3000, isTrashed: true },
    ];
    expect(changesAboveBoundary(rows, 1000).map((r) => r.id)).toEqual(['above', 'at']);
  });
});
