import { describe, expect, it } from 'vitest';
import { fromMediaUrl, toMediaUrl } from '../src/shared/api';

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
