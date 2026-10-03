import { describe, expect, it } from 'vitest';
import { isMediaCollectionUri, mediaUriCollection } from './mediaUri';

describe('the notice layer classifies MediaStore URIs by collection', () => {
  it('names the collection segment, and the bare authority as root', () => {
    expect(mediaUriCollection('content://media/external/images/media/154468')).toBe('images');
    expect(mediaUriCollection('content://media/external_primary/video/media/12')).toBe('video');
    expect(mediaUriCollection('content://media/external/file/99')).toBe('file');
    expect(mediaUriCollection('content://media/external/audio/media')).toBe('audio');
    expect(mediaUriCollection('content://media/')).toBe('root');
    expect(mediaUriCollection('')).toBe('root');
  });

  it('only the images and video collections are photo or video changes', () => {
    expect(isMediaCollectionUri('content://media/external/images/media/1')).toBe(true);
    expect(isMediaCollectionUri('content://media/0a91-e18d/video/media/1')).toBe(true);
    // The app's own diagnostics sink: a files-table row under the
    // external files dir (the measured self-fed loop).
    expect(isMediaCollectionUri('content://media/external/file/1234')).toBe(false);
    expect(isMediaCollectionUri('content://media/external/downloads/5')).toBe(false);
    expect(isMediaCollectionUri('content://media/')).toBe(false);
  });
});
