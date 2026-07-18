import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isImageFile, isMediaFile, isVideoFile, scanMedia } from '../src/main/scan';

async function makeTree(spec: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afterglow-scan-test-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

describe('isImageFile / isVideoFile / isMediaFile', () => {
  it('accepts jpg/jpeg/png/webp images case-insensitively', () => {
    for (const p of ['a.jpg', 'b.JPEG', 'c.Png', 'd.WEBP', '/x/y/e.jpeg']) {
      expect(isImageFile(p), p).toBe(true);
      expect(isVideoFile(p), p).toBe(false);
      expect(isMediaFile(p), p).toBe(true);
    }
  });

  it('accepts mp4/webm/mov videos case-insensitively (v0.4)', () => {
    for (const p of ['a.mp4', 'b.MP4', 'c.webm', 'd.MOV', '/x/y/e.mov']) {
      expect(isVideoFile(p), p).toBe(true);
      expect(isImageFile(p), p).toBe(false);
      expect(isMediaFile(p), p).toBe(true);
    }
  });

  it('rejects everything else — explicitly no AVI/MKV/HEIC/GIF', () => {
    for (const p of [
      'a.gif',
      'b.heic',
      'c.avi',
      'd.mkv',
      'e.txt',
      'f',
      'g.jpg.exe',
      'h.cr2',
      'i.mp4.part',
    ]) {
      expect(isImageFile(p), p).toBe(false);
      expect(isVideoFile(p), p).toBe(false);
      expect(isMediaFile(p), p).toBe(false);
    }
  });
});

describe('scanMedia', () => {
  it('finds images and videos recursively, ignores everything else', async () => {
    const root = await makeTree({
      'a.jpg': 'x',
      'sub/b.png': 'x',
      'sub/deep/c.webp': 'x',
      'sub/notes.txt': 'x',
      'd.mp4': 'x',
      'sub/e.mov': 'x',
      'f.avi': 'x',
      'g.mkv': 'x',
    });
    const result = await scanMedia([root]);
    expect(result).toEqual([
      path.join(root, 'a.jpg'),
      path.join(root, 'd.mp4'),
      path.join(root, 'sub/b.png'),
      path.join(root, 'sub/deep/c.webp'),
      path.join(root, 'sub/e.mov'),
    ]);
  });

  it('skips hidden files and directories', async () => {
    const root = await makeTree({
      'visible.jpg': 'x',
      '.hidden.jpg': 'x',
      '.thumbnails/thumb.jpg': 'x',
    });
    expect(await scanMedia([root])).toEqual([path.join(root, 'visible.jpg')]);
  });

  it('deduplicates overlapping/nested folders', async () => {
    const root = await makeTree({ 'sub/a.jpg': 'x' });
    const result = await scanMedia([root, path.join(root, 'sub'), root]);
    expect(result).toEqual([path.join(root, 'sub/a.jpg')]);
  });

  it('reports unreadable folders through onError and keeps going', async () => {
    const root = await makeTree({ 'a.jpg': 'x' });
    const errors: string[] = [];
    const result = await scanMedia([path.join(root, 'does-not-exist'), root], {
      onError: (dir) => errors.push(dir),
    });
    expect(result).toEqual([path.join(root, 'a.jpg')]);
    expect(errors).toEqual([path.join(root, 'does-not-exist')]);
  });

  it('skips symlinks', async () => {
    const root = await makeTree({ 'real/a.jpg': 'x' });
    const outside = await makeTree({ 'secret.jpg': 'x' });
    await fs.symlink(path.join(outside, 'secret.jpg'), path.join(root, 'link.jpg'));
    await fs.symlink(outside, path.join(root, 'linkdir'));
    expect(await scanMedia([root])).toEqual([path.join(root, 'real/a.jpg')]);
  });

  it('returns empty for no folders', async () => {
    expect(await scanMedia([])).toEqual([]);
  });
});
