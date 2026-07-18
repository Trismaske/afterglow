import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INDEX_FILENAME,
  buildIndex,
  diffIndex,
  indexFromJSON,
  indexToJSON,
  loadIndex,
  mapLimit,
  saveIndex,
  type FileStat,
  type IndexEntry,
} from '../src/main/indexer';

function entry(p: string, mtimeMs: number, size: number, timestampMs = 1000): IndexEntry {
  return { path: p, mtimeMs, size, timestampMs, source: 'exif' };
}

function stat(p: string, mtimeMs: number, size: number): FileStat {
  return { path: p, mtimeMs, size };
}

function asMap(entries: IndexEntry[]): Map<string, IndexEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

describe('diffIndex', () => {
  it('reuses unchanged entries without re-extraction', () => {
    const prev = asMap([entry('/a.jpg', 100, 5), entry('/b.jpg', 200, 6)]);
    const { reused, toExtract } = diffIndex(prev, [stat('/a.jpg', 100, 5), stat('/b.jpg', 200, 6)]);
    expect(reused.map((e) => e.path).sort()).toEqual(['/a.jpg', '/b.jpg']);
    expect(toExtract).toEqual([]);
  });

  it('re-extracts when mtime changed', () => {
    const prev = asMap([entry('/a.jpg', 100, 5)]);
    const { reused, toExtract } = diffIndex(prev, [stat('/a.jpg', 101, 5)]);
    expect(reused).toEqual([]);
    expect(toExtract).toEqual([stat('/a.jpg', 101, 5)]);
  });

  it('re-extracts when size changed', () => {
    const prev = asMap([entry('/a.jpg', 100, 5)]);
    const { toExtract } = diffIndex(prev, [stat('/a.jpg', 100, 6)]);
    expect(toExtract).toEqual([stat('/a.jpg', 100, 6)]);
  });

  it('extracts new files and drops deleted ones', () => {
    const prev = asMap([entry('/gone.jpg', 100, 5), entry('/kept.jpg', 100, 5)]);
    const { reused, toExtract } = diffIndex(prev, [
      stat('/kept.jpg', 100, 5),
      stat('/new.jpg', 300, 9),
    ]);
    expect(reused.map((e) => e.path)).toEqual(['/kept.jpg']);
    expect(toExtract.map((s) => s.path)).toEqual(['/new.jpg']);
    // deleted file appears in neither bucket
    const all = [...reused.map((e) => e.path), ...toExtract.map((s) => s.path)];
    expect(all).not.toContain('/gone.jpg');
  });

  it('handles an empty previous index (first run: extract everything)', () => {
    const { reused, toExtract } = diffIndex(new Map(), [
      stat('/a.jpg', 1, 1),
      stat('/b.jpg', 2, 2),
    ]);
    expect(reused).toEqual([]);
    expect(toExtract.length).toBe(2);
  });
});

describe('indexFromJSON / indexToJSON', () => {
  it('round-trips entries', () => {
    const entries = [entry('/b.jpg', 2, 2, 999), entry('/a.jpg', 1, 1, 111)];
    const parsed = indexFromJSON(JSON.parse(JSON.stringify(indexToJSON(entries))));
    expect(parsed.size).toBe(2);
    expect(parsed.get('/a.jpg')?.timestampMs).toBe(111);
    expect(parsed.get('/b.jpg')?.timestampMs).toBe(999);
  });

  it('serializes in stable path order', () => {
    const json = indexToJSON([entry('/z.jpg', 1, 1), entry('/a.jpg', 1, 1)]);
    expect(json.entries.map((e) => e.path)).toEqual(['/a.jpg', '/z.jpg']);
  });

  it('rejects wrong versions and non-objects', () => {
    expect(indexFromJSON(null).size).toBe(0);
    expect(indexFromJSON(42).size).toBe(0);
    expect(indexFromJSON({ version: 99, entries: [entry('/a.jpg', 1, 1)] }).size).toBe(0);
    expect(indexFromJSON({ entries: [entry('/a.jpg', 1, 1)] }).size).toBe(0);
  });

  it('drops malformed rows but keeps good ones', () => {
    const parsed = indexFromJSON({
      version: 1,
      entries: [
        entry('/good.jpg', 1, 1),
        { path: '/bad.jpg', mtimeMs: 'x', size: 1, timestampMs: 1, source: 'exif' },
        { path: '', mtimeMs: 1, size: 1, timestampMs: 1, source: 'exif' },
        { path: '/bad2.jpg', mtimeMs: 1, size: 1, timestampMs: 1, source: 'guess' },
        'garbage',
        null,
      ],
    });
    expect([...parsed.keys()]).toEqual(['/good.jpg']);
  });
});

describe('loadIndex / saveIndex', () => {
  async function tmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'afterglow-index-test-'));
  }

  it('round-trips through disk atomically (no temp files left)', async () => {
    const dir = await tmpDir();
    await saveIndex(dir, [entry('/a.jpg', 1, 1, 123)]);
    await saveIndex(dir, [entry('/a.jpg', 1, 1, 123), entry('/b.jpg', 2, 2, 456)]);
    expect(await fs.readdir(dir)).toEqual([INDEX_FILENAME]);
    const loaded = await loadIndex(dir);
    expect(loaded.size).toBe(2);
    expect(loaded.get('/b.jpg')?.timestampMs).toBe(456);
  });

  it('yields an empty index for missing or corrupt files', async () => {
    const dir = await tmpDir();
    expect((await loadIndex(dir)).size).toBe(0);
    await fs.writeFile(path.join(dir, INDEX_FILENAME), '{oops', 'utf8');
    let warned = false;
    expect((await loadIndex(dir, () => (warned = true))).size).toBe(0);
    expect(warned).toBe(true);
  });
});

describe('mapLimit', () => {
  it('preserves order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles empty input', async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
  });
});

describe('buildIndex', () => {
  const statsByPath = new Map<string, FileStat>([
    ['/a.jpg', stat('/a.jpg', 100, 5)],
    ['/b.jpg', stat('/b.jpg', 200, 6)],
    ['/c.jpg', stat('/c.jpg', 300, 7)],
  ]);
  const deps = {
    statFile: async (p: string) => statsByPath.get(p) ?? null,
    extract: async (s: FileStat) => ({ timestampMs: s.mtimeMs * 1000, source: 'exif' as const }),
  };

  it('extracts only new/changed files and keeps reused timestamps', async () => {
    const prev = asMap([entry('/a.jpg', 100, 5, 42)]); // unchanged → timestamp 42 survives
    const extractedPaths: string[] = [];
    const result = await buildIndex(['/a.jpg', '/b.jpg', '/c.jpg'], prev, {
      ...deps,
      extract: async (s) => {
        extractedPaths.push(s.path);
        return deps.extract(s);
      },
    });
    expect(result).not.toBeNull();
    const byPath = asMap(result!);
    expect(byPath.get('/a.jpg')?.timestampMs).toBe(42);
    expect(byPath.get('/b.jpg')?.timestampMs).toBe(200_000);
    expect(byPath.get('/c.jpg')?.timestampMs).toBe(300_000);
    expect(extractedPaths.sort()).toEqual(['/b.jpg', '/c.jpg']);
  });

  it('skips files that vanish or fail extraction, and warns', async () => {
    const warnings: string[] = [];
    const result = await buildIndex(['/a.jpg', '/vanished.jpg', '/broken.jpg'], new Map(), {
      statFile: async (p) => (p === '/vanished.jpg' ? null : stat(p, 1, 1)),
      extract: async (s) => {
        if (s.path === '/broken.jpg') throw new Error('boom');
        return { timestampMs: 7, source: 'mtime' as const };
      },
      onWarn: (msg) => warnings.push(msg),
    });
    expect(result!.map((e) => e.path)).toEqual(['/a.jpg']);
    expect(warnings.some((w) => w.includes('/broken.jpg'))).toBe(true);
  });

  it('returns null when cancelled', async () => {
    let calls = 0;
    const result = await buildIndex(['/a.jpg', '/b.jpg'], new Map(), {
      ...deps,
      isCancelled: () => ++calls > 1,
    });
    expect(result).toBeNull();
  });
});
