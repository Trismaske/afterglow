import { describe, expect, it } from 'vitest';
import { fromMediaUrl, mediaKindFromPath, mediaKindFromUrl, toMediaUrl } from '../src/shared/api';

describe('media URL round-trip', () => {
  const paths = [
    '/home/user/Pictures/a.jpg',
    '/home/user/My Photos/summer #1/IMG 0001.jpeg',
    '/home/user/фото/日本/emoji 🌅.png',
    '/home/user/100%/tricky?&=.webp',
    'C:\\Users\\tris\\Pictures\\a.jpg',
  ];

  for (const p of paths) {
    it(`round-trips ${JSON.stringify(p)}`, () => {
      expect(fromMediaUrl(toMediaUrl(p))).toBe(p);
    });
  }

  it('rejects foreign URLs', () => {
    expect(fromMediaUrl('https://example.com/a.jpg')).toBeNull();
    expect(fromMediaUrl('file:///etc/passwd')).toBeNull();
    expect(fromMediaUrl('afterglow://other/x')).toBeNull();
    expect(fromMediaUrl('not a url')).toBeNull();
  });
});

describe('mediaKindFromPath (v0.4 extension routing)', () => {
  it('routes images to photo', () => {
    for (const p of ['/x/a.jpg', 'b.JPEG', 'c.png', 'd.WebP', 'C:\\pics\\e.jpeg']) {
      expect(mediaKindFromPath(p), p).toBe('photo');
    }
  });

  it('routes mp4/webm/mov to video', () => {
    for (const p of ['/x/a.mp4', 'b.WEBM', 'c.Mov', 'C:\\vids\\d.MP4']) {
      expect(mediaKindFromPath(p), p).toBe('video');
    }
  });

  it('returns null for undisplayable formats (AVI, MKV, HEIC, GIF, RAW, none)', () => {
    for (const p of [
      'a.avi',
      'b.mkv',
      'c.heic',
      'd.gif',
      'e.cr2',
      'f',
      'g.',
      '.jpg/h',
      '/dir.mp4/i.txt',
    ]) {
      expect(mediaKindFromPath(p), p).toBeNull();
    }
  });

  it('only honors the final extension', () => {
    expect(mediaKindFromPath('trap.mp4.exe')).toBeNull();
    expect(mediaKindFromPath('movie.jpg.mp4')).toBe('video');
  });
});

describe('mediaKindFromUrl', () => {
  it('routes through the media-URL decoding', () => {
    expect(mediaKindFromUrl(toMediaUrl('/x/holiday clip #1.mp4'))).toBe('video');
    expect(mediaKindFromUrl(toMediaUrl('/x/photo.jpg'))).toBe('photo');
    expect(mediaKindFromUrl(toMediaUrl('/x/notes.txt'))).toBeNull();
    expect(mediaKindFromUrl('https://example.com/a.mp4')).toBeNull();
    expect(mediaKindFromUrl('not a url')).toBeNull();
  });
});
