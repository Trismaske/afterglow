import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isImageFile, scanImages } from '../src/main/scan';

async function makeTree(spec: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afterglow-scan-test-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

describe('isImageFile', () => {
  it('accepts jpg/jpeg/png/webp case-insensitively', () => {
    for (const p of ['a.jpg', 'b.JPEG', 'c.Png', 'd.WEBP', '/x/y/e.jpeg']) {
      expect(isImageFile(p), p).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const p of ['a.gif', 'b.heic', 'c.mp4', 'd.txt', 'e', 'f.jpg.exe', 'g.cr2']) {
      expect(isImageFile(p), p).toBe(false);
    }
  });
});

describe('scanImages', () => {
  it('finds images recursively and ignores non-images', async () => {
    const root = await makeTree({
      'a.jpg': 'x',
      'sub/b.png': 'x',
      'sub/deep/c.webp': 'x',
      'sub/notes.txt': 'x',
      'd.mp4': 'x',
    });
    const result = await scanImages([root]);
    expect(result).toEqual([
      path.join(root, 'a.jpg'),
      path.join(root, 'd.mp4'),
      path.join(root, 'sub/b.png'),
      path.join(root, 'sub/deep/c.webp'),
    ].filter(isImageFile).sort());
    expect(result).toHaveLength(3);
  });

  it('skips hidden files and directories', async () => {
    const root = await makeTree({
      'visible.jpg': 'x',
      '.hidden.jpg': 'x',
      '.thumbnails/thumb.jpg': 'x',
    });
    expect(await scanImages([root])).toEqual([path.join(root, 'visible.jpg')]);
  });

  it('deduplicates overlapping/nested folders', async () => {
    const root = await makeTree({ 'sub/a.jpg': 'x' });
    const result = await scanImages([root, path.join(root, 'sub'), root]);
    expect(result).toEqual([path.join(root, 'sub/a.jpg')]);
  });

  it('reports unreadable folders through onError and keeps going', async () => {
    const root = await makeTree({ 'a.jpg': 'x' });
    const errors: string[] = [];
    const result = await scanImages([path.join(root, 'does-not-exist'), root], {
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
    expect(await scanImages([root])).toEqual([path.join(root, 'real/a.jpg')]);
  });

  it('returns empty for no folders', async () => {
    expect(await scanImages([])).toEqual([]);
  });
});
