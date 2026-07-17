import { describe, expect, it } from 'vitest';
import { isInside, isInsideAny } from '../src/main/containment';

describe('isInside', () => {
  it('accepts files strictly inside the folder', () => {
    expect(isInside('/media/photos/a.jpg', '/media/photos')).toBe(true);
    expect(isInside('/media/photos/deep/nested/b.png', '/media/photos')).toBe(true);
  });

  it('rejects the folder itself', () => {
    expect(isInside('/media/photos', '/media/photos')).toBe(false);
  });

  it('rejects siblings and parents', () => {
    expect(isInside('/media/other/a.jpg', '/media/photos')).toBe(false);
    expect(isInside('/media', '/media/photos')).toBe(false);
    expect(isInside('/etc/passwd', '/media/photos')).toBe(false);
  });

  it('rejects prefix-sharing folders (photos vs photos-backup)', () => {
    expect(isInside('/media/photos-backup/a.jpg', '/media/photos')).toBe(false);
  });

  it('rejects traversal attempts', () => {
    // These would only reach isInside pre-resolved, but be paranoid anyway.
    expect(isInside('/media/photos/../../etc/passwd', '/media/photos')).toBe(false);
  });
});

describe('isInsideAny', () => {
  it('accepts membership in any root, rejects otherwise', () => {
    const roots = ['/a', '/b/c'];
    expect(isInsideAny('/a/x.jpg', roots)).toBe(true);
    expect(isInsideAny('/b/c/d/y.jpg', roots)).toBe(true);
    expect(isInsideAny('/b/x.jpg', roots)).toBe(false);
    expect(isInsideAny('/a/x.jpg', [])).toBe(false);
  });
});
