import { describe, expect, it } from 'vitest';
import { encode as encodeJpeg } from 'jpeg-js';
import { hammingDistance } from '@afterglow/core';
import {
  base64ToBytes,
  DHASH_GRID_COLS,
  DHASH_GRID_ROWS,
  dhashFromJpegBase64,
  lumaGridFromRgba,
} from './dhashDecode';

/** RGBA buffer for a width×height image, gray level from f(x, y) (0-255). */
function rgba(width: number, height: number, f: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y))));
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Base64 of a JPEG encoding of the given grayscale image (quality 100). */
function jpegBase64(width: number, height: number, f: (x: number, y: number) => number): string {
  const jpeg = encodeJpeg({ width, height, data: rgba(width, height, f) }, 100);
  // Buffer exists in vitest's node environment (tests only — the module
  // under test never uses it).
  return Buffer.from(jpeg.data).toString('base64');
}

describe('base64ToBytes', () => {
  it('decodes padded, unpadded and wrapped base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 77]);
    const b64 = Buffer.from(bytes).toString('base64'); // "AAEC+vv8TQ=="
    expect([...base64ToBytes(b64)]).toEqual([...bytes]);
    expect([...base64ToBytes(b64.replace(/=+$/, ''))]).toEqual([...bytes]);
    expect([...base64ToBytes(`${b64.slice(0, 4)}\r\n ${b64.slice(4)}`)]).toEqual([...bytes]);
  });

  it('handles every remainder length', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6]) {
      const bytes = new Uint8Array(Array.from({ length: len }, (_, i) => i * 40));
      expect([...base64ToBytes(Buffer.from(bytes).toString('base64'))]).toEqual([...bytes]);
    }
  });

  it('throws on characters outside the alphabet', () => {
    expect(() => base64ToBytes('ab!c')).toThrow(/invalid character/);
    expect(() => base64ToBytes('äbcd')).toThrow(/invalid character/);
  });
});

describe('lumaGridFromRgba', () => {
  it('maps a 9x8 image one pixel per cell', () => {
    const data = rgba(9, 8, (x, y) => x * 20 + y);
    const grid = lumaGridFromRgba(data, 9, 8);
    expect(grid).toHaveLength(DHASH_GRID_ROWS);
    expect(grid[0]).toHaveLength(DHASH_GRID_COLS);
    // Gray pixels: luma == gray level (0.299+0.587+0.114 = 1).
    expect(grid[0][0]).toBeCloseTo(0, 5);
    expect(grid[3][5]).toBeCloseTo(5 * 20 + 3, 5);
  });

  it('box-averages larger images to the same ordering', () => {
    const small = lumaGridFromRgba(rgba(9, 8, (x) => x * 20), 9, 8);
    const large = lumaGridFromRgba(rgba(90, 80, (x) => Math.floor(x / 10) * 20), 90, 80);
    for (let r = 0; r < DHASH_GRID_ROWS; r++) {
      for (let c = 0; c < DHASH_GRID_COLS; c++) {
        expect(large[r][c]).toBeCloseTo(small[r][c], 3);
      }
    }
  });

  it('rejects images smaller than the grid and short buffers', () => {
    expect(() => lumaGridFromRgba(rgba(8, 8, () => 0), 8, 8)).toThrow(/smaller than/);
    expect(() => lumaGridFromRgba(new Uint8Array(10), 9, 8)).toThrow(/too small/);
  });

  it('weights color channels by Rec.601 luma', () => {
    const data = new Uint8Array(9 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 1] = 100; // pure green
    const grid = lumaGridFromRgba(data, 9, 8);
    expect(grid[0][0]).toBeCloseTo(58.7, 1);
  });
});

describe('dhashFromJpegBase64', () => {
  it('horizontal gradient hashes to all ones, flat image to all zeros', () => {
    expect(dhashFromJpegBase64(jpegBase64(9, 8, (x) => x * 28))).toBe('f'.repeat(16));
    expect(dhashFromJpegBase64(jpegBase64(9, 8, () => 128))).toBe('0'.repeat(16));
    // Vertical gradient: rows are flat → no ascending comparisons.
    expect(dhashFromJpegBase64(jpegBase64(9, 8, (_, y) => y * 30))).toBe('0'.repeat(16));
  });

  it('is resolution-stable: 9x8 and 90x80 of the same scene agree closely', () => {
    const scene = (gx: number, gy: number) => ((gx * 37 + gy * 71) % 5) * 50;
    const small = dhashFromJpegBase64(jpegBase64(9, 8, (x, y) => scene(x, y)));
    const large = dhashFromJpegBase64(
      jpegBase64(90, 80, (x, y) => scene(Math.floor(x / 10), Math.floor(y / 10))),
    );
    expect(hammingDistance(small, large)).toBeLessThanOrEqual(6);
  });

  it('distinguishes unrelated scenes but tolerates small changes', () => {
    const a = dhashFromJpegBase64(jpegBase64(9, 8, (x, y) => ((x * 37 + y * 71) % 5) * 50));
    const aShifted = dhashFromJpegBase64(
      jpegBase64(9, 8, (x, y) => ((x * 37 + y * 71) % 5) * 50 + 8),
    );
    const b = dhashFromJpegBase64(jpegBase64(9, 8, (x, y) => ((x * 13 + y * 29) % 7) * 36));
    expect(hammingDistance(a, aShifted)).toBeLessThanOrEqual(4);
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
  });

  it('tolerates a data-URI prefix', () => {
    const plain = jpegBase64(9, 8, (x) => x * 28);
    expect(dhashFromJpegBase64(`data:image/jpeg;base64,${plain}`)).toBe(
      dhashFromJpegBase64(plain),
    );
  });

  it('throws on non-JPEG bytes and garbage base64', () => {
    expect(() => dhashFromJpegBase64(Buffer.from('not a jpeg').toString('base64'))).toThrow();
    expect(() => dhashFromJpegBase64('!!!')).toThrow();
  });
});
