import { describe, expect, it } from 'vitest';
import { launchMimeType, shareMimeType } from './editActions';

describe('launchMimeType (the EDIT / VIEW intent type)', () => {
  it('declares the kind Android resolves handlers by', () => {
    expect(launchMimeType('photo')).toBe('image/*');
    expect(launchMimeType('video')).toBe('video/*');
  });
});

describe("shareMimeType (the batch's declared type)", () => {
  it('names the one kind a batch carries, and the wildcard for a mixed batch', () => {
    expect(shareMimeType(['photo'])).toBe('image/*');
    expect(shareMimeType(['photo', 'photo'])).toBe('image/*');
    expect(shareMimeType(['video'])).toBe('video/*');
    expect(shareMimeType(['photo', 'video'])).toBe('*/*');
  });
  it('an empty batch declares image/* (callers never dispatch one)', () => {
    expect(shareMimeType([])).toBe('image/*');
  });
});
