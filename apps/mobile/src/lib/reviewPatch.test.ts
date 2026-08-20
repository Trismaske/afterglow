import { describe, expect, it } from 'vitest';
import { badgeStateEqualsWithin, sameIdsWithin } from './reviewPatch';

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
