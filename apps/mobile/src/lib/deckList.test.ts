import { describe, expect, it } from 'vitest';
import { deckListKey, listFromParams, type DeckListDescriptor } from './deckList';

describe('listFromParams (fail-closed param decode)', () => {
  it('round-trips every descriptor variant through JSON (navigation state)', () => {
    const variants: DeckListDescriptor[] = [
      { source: 'queue', queue: 'share' },
      { source: 'queue', queue: 'edit' },
      { source: 'history', filter: 'all' },
      { source: 'history', filter: 'favourite' },
      { source: 'grid', day: '2026-08-27', filter: 'kept' },
    ];
    for (const v of variants) {
      expect(listFromParams(JSON.parse(JSON.stringify(v)))).toEqual(v);
    }
  });

  it('rejects unknown sources, queues, and filters — never a half-valid list', () => {
    expect(listFromParams({ source: 'queue', queue: 'trash' })).toBeNull();
    expect(listFromParams({ source: 'history', filter: 'everything' })).toBeNull();
    expect(listFromParams({ source: 'grid', day: 42, filter: 'kept' })).toBeNull();
    expect(listFromParams({ source: 'timeline' })).toBeNull();
    expect(listFromParams('list:queue:share')).toBeNull();
    expect(listFromParams(null)).toBeNull();
    expect(listFromParams(undefined)).toBeNull();
  });
});

describe('deckListKey', () => {
  it('is stable and distinct per list identity', () => {
    const keys = [
      deckListKey({ source: 'queue', queue: 'share' }),
      deckListKey({ source: 'queue', queue: 'edit' }),
      deckListKey({ source: 'history', filter: 'all' }),
      deckListKey({ source: 'grid', day: '2026-08-27', filter: 'kept' }),
      deckListKey({ source: 'grid', day: '2026-08-27', filter: 'staged' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(deckListKey({ source: 'queue', queue: 'share' })).toBe(keys[0]);
  });
});
