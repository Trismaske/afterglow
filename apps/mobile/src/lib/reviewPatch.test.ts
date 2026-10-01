import { describe, expect, it } from 'vitest';
import {
  badgeStateEqualsWithin,
  queueEquals,
  sameIdsWithin,
  verdictChangesOf,
  type ReviewSnapshot,
} from './reviewPatch';
import type { ReviewMemberRow } from '../db/store';

describe('verdictChangesOf (phase 8: the rows a decision patches in place)', () => {
  it('maps every verdict-bearing action to the state applyLocalAction lands on', () => {
    expect(verdictChangesOf({ kind: 'verdict', assetId: 'a', verdict: 'culled' })).toEqual([
      { assetId: 'a', state: 'culled' },
    ]);
    expect(
      verdictChangesOf({ kind: 'verdict', assetId: 'a', verdict: 'kept', queueEdit: true }),
    ).toEqual([{ assetId: 'a', state: 'kept', needsEdit: true }]);
    expect(verdictChangesOf({ kind: 'redecide', assetId: 'a', target: 'to_edit' })).toEqual([
      { assetId: 'a', state: 'kept' },
    ]);
    expect(verdictChangesOf({ kind: 'unstage', assetId: 'a' })).toEqual([
      { assetId: 'a', state: 'kept' },
    ]);
    expect(verdictChangesOf({ kind: 'restore', assetId: 'a' })).toEqual([
      { assetId: 'a', state: 'unreviewed' },
    ]);
    expect(verdictChangesOf({ kind: 'duel', groupId: 1, winnerId: 'w', loserId: 'l' })).toEqual([
      { assetId: 'w', state: 'kept' },
    ]);
    expect(verdictChangesOf({ kind: 'keepMany', assetIds: ['a', 'b'] })).toEqual([
      { assetId: 'a', state: 'kept' },
      { assetId: 'b', state: 'kept' },
    ]);
  });

  it('carries no verdict for the flag, favourite and eject actions', () => {
    expect(verdictChangesOf({ kind: 'flag', assetId: 'a', needsEdit: true })).toEqual([]);
    expect(
      verdictChangesOf({
        kind: 'favourite',
        intent: { assetId: 'a', state: 'queued_apply', target: true },
      }),
    ).toEqual([]);
    expect(verdictChangesOf({ kind: 'makeSingle', assetId: 'a', groupId: 1 })).toEqual([]);
  });
});

describe('scoped badge equality (m0.8.6 codex closing: hydrated extras are not drift)', () => {
  it('an entry OUTSIDE the read universe never breaks equality; inside it does', () => {
    const ids = ['a', 'b'];
    const current = new Set(['a', 'deep-browse-id']);
    const next = new Set(['a']);
    expect(sameIdsWithin(ids, current, next)).toBe(true);
    expect(sameIdsWithin(['a', 'deep-browse-id'], current, next)).toBe(false);
    expect(sameIdsWithin(ids, new Set(['b']), next)).toBe(false);
  });

  it('badgeStateEqualsWithin judges needsEdit and favourites per read id only', () => {
    const fav = (state: string) => ({ state, target: '1' }) as never;
    const current = {
      needsEdit: new Set(['x', 'deep']),
      favourites: new Map([['deep', fav('queued_apply')]]),
    };
    const next = { needsEdit: new Set(['x']), favourites: new Map() };
    expect(badgeStateEqualsWithin(['x'], current, next)).toBe(true);
    expect(badgeStateEqualsWithin(['x', 'deep'], current, next)).toBe(false);
  });
});

describe('queueEquals (the refresh no-op rule)', () => {
  const member = (id: string, image_version: number): ReviewMemberRow => ({
    asset_id: id,
    uri: `file://${id}`,
    image_version,
    kind: 'photo',
    mime_type: 'image/jpeg',
    motion_offset: null,
    motion_length: null,
    motion_presentation_us: null,
    taken_at: 1000,
    day: '2026-09-08',
    state: 'kept',
    needs_edit: 0,
    time_attached: 0,
  });
  const snapshot = (v: number): ReviewSnapshot => ({
    groups: [],
    singles: [member('a', v)],
    counts: { grouped: 0, singles: 1, groups: 0 },
    needsEdit: new Set(),
    favourites: new Map(),
  });
  it('treats a changed image version as a change — an in-place edit must commit', () => {
    expect(queueEquals(snapshot(1), snapshot(1))).toBe(true);
    expect(queueEquals(snapshot(1), snapshot(2))).toBe(false);
  });
});
describe('queueEquals — the motion facts are read state (phase 5)', () => {
  const member = (id: string, motion_offset: number | null): ReviewMemberRow => ({
    asset_id: id,
    uri: `file://${id}`,
    image_version: 7,
    kind: 'photo',
    mime_type: 'image/jpeg',
    motion_offset,
    motion_length: motion_offset === null ? null : 4_444_568,
    motion_presentation_us: null,
    taken_at: 1000,
    day: '2026-09-09',
    state: 'unreviewed',
    needs_edit: 0,
    time_attached: 0,
  });
  const snapshot = (motion_offset: number | null): ReviewSnapshot => ({
    groups: [],
    singles: [member('m', motion_offset)],
    counts: { grouped: 0, singles: 1, groups: 0 },
    needsEdit: new Set(),
    favourites: new Map(),
  });
  it('a per-file read that completes later for the same version is a change', () => {
    // The first pass's read failed (no clip known); the retry found the
    // clip at the same image version — the deck must mount its overlay.
    expect(queueEquals(snapshot(null), snapshot(1_524_709))).toBe(false);
    expect(queueEquals(snapshot(1_524_709), snapshot(1_524_709))).toBe(true);
  });
});
