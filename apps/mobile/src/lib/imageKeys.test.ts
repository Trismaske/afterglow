import { describe, expect, it } from 'vitest';
import { imageCacheKey, versionedUri } from './imageKeys';

describe('image cache identity', () => {
  it('imageCacheKey changes with the version and only with it', () => {
    expect(imageCacheKey('external_primary/42', 7)).toBe('external_primary/42:7');
    expect(imageCacheKey('external_primary/42', 8)).not.toBe(
      imageCacheKey('external_primary/42', 7),
    );
  });
  it('versionedUri keeps the file path and carries the version as a query', () => {
    expect(versionedUri('file:///storage/emulated/0/DCIM/a.jpg', 7)).toBe(
      'file:///storage/emulated/0/DCIM/a.jpg?v=7',
    );
    expect(versionedUri('file:///a.jpg?x=1', 7)).toBe('file:///a.jpg?x=1&v=7');
    expect(versionedUri('file:///a.jpg', 8)).not.toBe(versionedUri('file:///a.jpg', 7));
  });
});
