/**
 * One thumbnail-scale image (m0.9 phase 3, item 2): renders the OS
 * thumbnail from useOsThumbnail, nothing while it loads (7–23 ms — a
 * URI placeholder here would start the very Glide decode this exists
 * to avoid), and the URI path only when the store failed for the photo
 * (the hook's loud-once fallback). Used by the Progress grid tiles, the
 * deck strip, the Timeline/DayProgress cards, and the pager's at-rest
 * first paint.
 */

import React from 'react';
import { Image, type ImageContentFit, type ImageStyle } from 'expo-image';
import type { StyleProp } from 'react-native';
import { useOsThumbnail } from './useOsThumbnail';

export function OsThumbnail({
  assetId,
  uri,
  px,
  style,
  contentFit = 'cover',
}: {
  assetId: string;
  /** The file URI — the fallback source when the OS store cannot serve. */
  uri: string;
  /** A lib/thumbnailSize bucket. */
  px: number;
  style?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
}) {
  const thumb = useOsThumbnail(assetId, px);
  return (
    <Image
      source={
        thumb.status === 'ready' ? thumb.ref : thumb.status === 'failed' ? { uri } : undefined
      }
      style={style}
      contentFit={contentFit}
      recyclingKey={assetId}
      transition={0}
    />
  );
}
