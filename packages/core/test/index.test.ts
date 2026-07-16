import { describe, it, expect } from 'vitest';
import type { MediaItem } from '../src/index';

describe('core scaffold', () => {
  it('MediaItem shape compiles and is usable', () => {
    const item: MediaItem = {
      id: '1',
      timestamp: Date.now(),
      uri: '/photos/a.jpg',
      kind: 'photo',
    };
    expect(item.kind).toBe('photo');
  });
});
