import { describe, expect, it } from 'vitest';
import { imageCacheKey } from './imageKeys';

describe('imageCacheKey', () => {
  it('changes with the version and only with it', () => {
    expect(imageCacheKey('external_primary/42', 7)).toBe('external_primary/42:7');
    expect(imageCacheKey('external_primary/42', 8)).not.toBe(
      imageCacheKey('external_primary/42', 7),
    );
    expect(imageCacheKey('external_primary/42', 7)).toBe(imageCacheKey('external_primary/42', 7));
  });
});
