import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FLAGS_FILENAME,
  createFlagStore,
  loadFlagQueue,
  openFlagStore,
} from '../src/main/flagstore';
import { createFlagQueue } from '@afterglow/core';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'afterglow-flags-test-'));
}

describe('loadFlagQueue', () => {
  it('yields an empty queue when the file is missing', async () => {
    const dir = await tmpDir();
    expect((await loadFlagQueue(dir)).entries).toEqual([]);
  });

  it('yields an empty queue and warns when the file is corrupt', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, FLAGS_FILENAME), '{oops', 'utf8');
    const onWarn = vi.fn();
    expect((await loadFlagQueue(dir, onWarn)).entries).toEqual([]);
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it('drops malformed entries but keeps good ones', async () => {
    const dir = await tmpDir();
    const payload = {
      version: 1,
      entries: [
        { path: '/p/a.jpg', flagType: 'edit', at: 123 },
        { path: 42, flagType: 'edit', at: 1 },
        { path: '/p/b.jpg', flagType: 'nonsense', at: 2 },
      ],
    };
    await fs.writeFile(path.join(dir, FLAGS_FILENAME), JSON.stringify(payload), 'utf8');
    const state = await loadFlagQueue(dir);
    expect(state.entries).toEqual([{ path: '/p/a.jpg', flagType: 'edit', at: 123 }]);
  });
});

describe('flag store', () => {
  it('persists adds and removes across a restart', async () => {
    const dir = await tmpDir();
    const store = await openFlagStore(dir);
    expect(await store.add({ path: '/p/a.jpg', flagType: 'delete', at: 1 })).toBe(true);
    expect(await store.add({ path: '/p/b.jpg', flagType: 'edit', at: 2 })).toBe(true);
    expect(await store.add({ path: '/p/c.jpg', flagType: 'review', at: 3 })).toBe(true);
    expect(await store.remove('/p/b.jpg', 'edit')).toBe(true);
    await store.flush();

    const reopened = await openFlagStore(dir);
    expect(reopened.list()).toEqual([
      { path: '/p/a.jpg', flagType: 'delete', at: 1 },
      { path: '/p/c.jpg', flagType: 'review', at: 3 },
    ]);
  });

  it('dedupes by (path, flagType) and reports it', async () => {
    const dir = await tmpDir();
    const store = await openFlagStore(dir);
    expect(await store.add({ path: '/p/a.jpg', flagType: 'edit', at: 1 })).toBe(true);
    expect(await store.add({ path: '/p/a.jpg', flagType: 'edit', at: 99 })).toBe(false);
    expect(await store.add({ path: '/p/a.jpg', flagType: 'move', at: 5 })).toBe(true); // different type is fine
    expect(store.list()).toHaveLength(2);
  });

  it('remove of an absent entry is a no-op returning false', async () => {
    const dir = await tmpDir();
    const store = await openFlagStore(dir);
    expect(await store.remove('/p/none.jpg', 'delete')).toBe(false);
  });

  it('has/hasPath answer for the current state', async () => {
    const dir = await tmpDir();
    const store = await openFlagStore(dir);
    await store.add({ path: '/p/a.jpg', flagType: 'edit', at: 1 });
    expect(store.has('/p/a.jpg', 'edit')).toBe(true);
    expect(store.has('/p/a.jpg', 'delete')).toBe(false);
    expect(store.hasPath('/p/a.jpg')).toBe(true);
    expect(store.hasPath('/p/x.jpg')).toBe(false);
  });

  it('writes atomically: only flags.json remains, contents always valid JSON', async () => {
    const dir = await tmpDir();
    const store = await openFlagStore(dir);
    // burst of overlapping mutations — the write chain must serialize them
    await Promise.all([
      store.add({ path: '/p/1.jpg', flagType: 'delete', at: 1 }),
      store.add({ path: '/p/2.jpg', flagType: 'edit', at: 2 }),
      store.add({ path: '/p/3.jpg', flagType: 'move', at: 3 }),
      store.add({ path: '/p/4.jpg', flagType: 'review', at: 4 }),
    ]);
    await store.flush();
    expect(await fs.readdir(dir)).toEqual([FLAGS_FILENAME]);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, FLAGS_FILENAME), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries).toHaveLength(4);
  });

  it('notifies onChange with the new list after every mutation', async () => {
    const dir = await tmpDir();
    const onChange = vi.fn();
    const store = createFlagStore(dir, createFlagQueue(), { onChange });
    await store.add({ path: '/p/a.jpg', flagType: 'edit', at: 1 });
    await store.add({ path: '/p/a.jpg', flagType: 'edit', at: 1 }); // dup: no notify
    await store.remove('/p/a.jpg', 'edit');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('creates the directory if needed', async () => {
    const dir = path.join(await tmpDir(), 'nested', 'deeper');
    const store = await openFlagStore(dir);
    await store.add({ path: '/p/a.jpg', flagType: 'review', at: 7 });
    await store.flush();
    expect((await openFlagStore(dir)).list()).toHaveLength(1);
  });
});
