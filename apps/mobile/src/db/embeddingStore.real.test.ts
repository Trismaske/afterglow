/**
 * Embedding-store contract tests on real SQLite (m0.8 gate 2): BLOB
 * round-trips, stale-row replacement, and the destructive model-pin
 * re-embed event.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  countPhotoEmbeddings,
  ensureEmbeddingModel,
  getPhotoEmbeddings,
  setPhotoEmbedding,
} from './embeddingStore';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];

function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function fresh(): Promise<SQLiteDatabase> {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(asExpo(d));
  return asExpo(d);
}

function vecBytes(seed: number): Uint8Array {
  const vec = new Float32Array(1280);
  for (let i = 0; i < vec.length; i++) vec[i] = Math.sin(seed + i);
  return new Uint8Array(vec.buffer.slice(0));
}

describe('photo embeddings', () => {
  it('round-trips vector bytes and reports staleness via mod_time', async () => {
    const db = await fresh();
    const bytes = vecBytes(1);
    await setPhotoEmbedding(db, 'external_primary/1', bytes, 111);

    const rows = await getPhotoEmbeddings(db, ['external_primary/1', 'external_primary/2']);
    expect(rows.size).toBe(1);
    const row = rows.get('external_primary/1')!;
    expect(row.modTime).toBe(111);
    expect(new Uint8Array(row.vec)).toEqual(bytes);
    expect(row.vec.byteLength).toBe(1280 * 4);
  });

  it('replaces the stored vector when the photo is re-embedded', async () => {
    const db = await fresh();
    await setPhotoEmbedding(db, 'external_primary/1', vecBytes(1), 111);
    const updated = vecBytes(2);
    await setPhotoEmbedding(db, 'external_primary/1', updated, 222);

    const row = (await getPhotoEmbeddings(db, ['external_primary/1'])).get('external_primary/1')!;
    expect(row.modTime).toBe(222);
    expect(new Uint8Array(row.vec)).toEqual(updated);
    expect(await countPhotoEmbeddings(db)).toBe(1);
  });

  it('pins the model on first call; a matching pin is a no-op', async () => {
    const db = await fresh();
    const result = await ensureEmbeddingModel(db, 'sha-one');
    expect(result).toEqual({ cleared: false, discarded: 0 });
    await setPhotoEmbedding(db, 'external_primary/1', vecBytes(1), 111);
    expect(await ensureEmbeddingModel(db, 'sha-one')).toEqual({ cleared: false, discarded: 0 });
    expect(await countPhotoEmbeddings(db)).toBe(1);
  });

  it('discards vectors stored without a pin (unknown provenance)', async () => {
    const db = await fresh();
    await setPhotoEmbedding(db, 'external_primary/1', vecBytes(1), 111);
    expect(await ensureEmbeddingModel(db, 'sha-one')).toEqual({ cleared: true, discarded: 1 });
    expect(await countPhotoEmbeddings(db)).toBe(0);
  });

  it('a model swap clears every stored vector, atomically, and re-pins', async () => {
    const db = await fresh();
    await ensureEmbeddingModel(db, 'sha-one');
    await setPhotoEmbedding(db, 'external_primary/1', vecBytes(1), 111);
    await setPhotoEmbedding(db, 'external_primary/2', vecBytes(2), 222);

    const result = await ensureEmbeddingModel(db, 'sha-two');
    expect(result).toEqual({ cleared: true, discarded: 2 });
    expect(await countPhotoEmbeddings(db)).toBe(0);
    // The new pin holds.
    expect(await ensureEmbeddingModel(db, 'sha-two')).toEqual({ cleared: false, discarded: 0 });
  });
});
