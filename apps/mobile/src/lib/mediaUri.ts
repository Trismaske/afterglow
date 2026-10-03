/**
 * MediaStore URI classification (m0.9 phase 9, pure): which collection a
 * provider notification names. The notice layer (scan/scanNotices.ts)
 * reacts only to the images and video collections — the provider also
 * notifies for every other row in its files table, the app's own
 * diagnostics sink among them (the measured self-fed loop).
 */

/** The collection segment of `content://media/<volume>/<collection>/…`,
 * or 'root' for the bare authority. */
export function mediaUriCollection(uri: string): string {
  const match = /^content:\/\/media\/[^/]+\/([^/?#]+)/.exec(uri);
  return match ? match[1] : 'root';
}

/** Does this URI name a photo or video row? */
export function isMediaCollectionUri(uri: string): boolean {
  const collection = mediaUriCollection(uri);
  return collection === 'images' || collection === 'video';
}
