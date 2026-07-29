/**
 * Shared PhotoViewer host for the queue screens (m0.8.1): resolves the
 * tapped id to an index over the mapped rows and mounts THE standard
 * viewer; renders nothing when the id is gone (the row left the queue
 * mid-view). Replaces four hand-rolled copies that had already begun to
 * drift stylistically.
 */
import React from 'react';
import { PhotoViewer, type ViewerItem } from './PhotoViewer';

export function QueueViewer<T>({
  rows,
  viewerId,
  toItem,
  onClose,
  onChanged,
}: {
  rows: readonly T[] | null;
  /** Tapped photo id (null = closed). */
  viewerId: string | null;
  toItem: (row: T) => ViewerItem;
  onClose: () => void;
  /** The viewer changed review state — reload the queue behind it. */
  onChanged: () => void;
}) {
  if (!rows || viewerId === null) return null;
  const items = rows.map(toItem);
  const index = items.findIndex((item) => item.id === viewerId);
  if (index < 0) return null;
  return <PhotoViewer items={items} initialIndex={index} onClose={onClose} onChanged={onChanged} />;
}
