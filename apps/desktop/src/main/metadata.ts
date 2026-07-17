/**
 * Per-image date metadata for the overlay: EXIF capture time via exifr
 * (DateTimeOriginal, falling back to CreateDate), file mtime as the honest
 * fallback. Never throws — a broken EXIF blob or vanished file just yields
 * nulls and the overlay shows what it can.
 */

import { promises as fs } from 'node:fs';
import exifr from 'exifr';

export interface ImageDates {
  captureDateMs: number | null;
  fileDateMs: number | null;
}

function asValidMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export async function getImageDates(filePath: string): Promise<ImageDates> {
  let fileDateMs: number | null = null;
  try {
    fileDateMs = (await fs.stat(filePath)).mtimeMs;
  } catch {
    // vanished / unreadable — overlay copes with nulls
  }

  let captureDateMs: number | null = null;
  try {
    const exif: Record<string, unknown> | undefined = await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate'],
    });
    captureDateMs = asValidMs(exif?.DateTimeOriginal) ?? asValidMs(exif?.CreateDate);
  } catch {
    // no/garbled EXIF (typical for PNG/WebP) — fall through to file date
  }

  return { captureDateMs, fileDateMs };
}
