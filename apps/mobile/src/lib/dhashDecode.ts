/**
 * Pure decode → luma → grid → dHash pipeline (m0.4).
 *
 * The impure half (similarityHashes.ts) uses expo-image-manipulator to
 * shrink a photo to a tiny JPEG and hands the base64 payload to
 * {@link dhashFromJpegBase64}; everything from base64 onward is plain TS
 * (jpeg-js decoder, no platform APIs) so it runs identically under vitest
 * and Hermes. Grayscale isn't available from the manipulator, so the
 * RGB→luma conversion happens here.
 */
import { decode as decodeJpeg } from 'jpeg-js';
import { dhash64 } from '@afterglow/core';

/** dHash sampling grid: 8 rows × 9 columns → 8×8 = 64 comparisons. */
export const DHASH_GRID_ROWS = 8;
export const DHASH_GRID_COLS = 9;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode standard base64 (padding optional, whitespace tolerated) into
 * bytes. Hermes gained atob() only recently and Buffer doesn't exist in
 * RN, so this stays hand-rolled — and unit-testable. Throws on characters
 * outside the base64 alphabet.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const chars: number[] = [];
  for (let i = 0; i < b64.length; i++) {
    const code = b64.charCodeAt(i);
    if (code === 61 /* '=' */) break; // padding — nothing follows but padding
    // Skip whitespace/newlines (some encoders wrap lines).
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    const value = code < 128 ? B64_LOOKUP[code] : -1;
    if (value === -1) throw new Error(`base64ToBytes: invalid character at index ${i}`);
    chars.push(value);
  }
  const out = new Uint8Array(Math.floor((chars.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < chars.length; i += 4) {
    const n =
      (chars[i] << 18) | (chars[i + 1] << 12) | ((chars[i + 2] ?? 0) << 6) | (chars[i + 3] ?? 0);
    out[o++] = (n >> 16) & 0xff;
    if (i + 2 < chars.length && o < out.length) out[o++] = (n >> 8) & 0xff;
    if (i + 3 < chars.length && o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/**
 * Rec.601 luma from RGBA pixel data, box-sampled down to a rows × cols
 * grid. When the source is already exactly cols × rows (the expected case
 * — the manipulator resized to 9×8) each cell is one pixel; larger inputs
 * average each cell's pixel block, so the function tolerates a platform
 * resizer that refuses tiny targets.
 */
export function lumaGridFromRgba(
  data: Uint8Array,
  width: number,
  height: number,
  rows: number = DHASH_GRID_ROWS,
  cols: number = DHASH_GRID_COLS,
): number[][] {
  if (width < cols || height < rows) {
    throw new Error(`lumaGridFromRgba: image ${width}x${height} smaller than grid ${cols}x${rows}`);
  }
  if (data.length < width * height * 4) {
    throw new Error('lumaGridFromRgba: pixel buffer too small for dimensions');
  }
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
      }
      row.push(sum / ((y1 - y0) * (x1 - x0)));
    }
    grid.push(row);
  }
  return grid;
}

/**
 * The whole pure pipeline: base64 JPEG → bytes → RGBA → luma grid →
 * 16-char hex dHash. A `data:image/...;base64,` prefix is tolerated.
 * Throws on malformed input — the impure caller maps failures to null.
 */
export function dhashFromJpegBase64(b64: string): string {
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  const bytes = base64ToBytes(comma >= 0 ? b64.slice(comma + 1) : b64);
  const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
  const grid = lumaGridFromRgba(image.data, image.width, image.height);
  return dhash64(grid);
}
