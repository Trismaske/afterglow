import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [kind, directory] = process.argv.slice(2);
if (!['desktop', 'mobile'].includes(kind) || !directory) {
  throw new Error('Usage: node scripts/release-artifacts.mjs <desktop|mobile> <directory>');
}

const files = readdirSync(directory).filter((name) => {
  if (kind === 'mobile') return name.endsWith('.apk');
  if (process.platform === 'win32') return name.endsWith('.exe');
  return name.endsWith('.AppImage') || name.endsWith('.deb');
});

if (kind === 'mobile' && files.length !== 1) {
  throw new Error(`Expected exactly one release APK in ${directory}; found ${files.length}`);
}
if (kind === 'desktop' && files.length === 0) {
  throw new Error(`No ${process.platform} desktop installers found in ${directory}`);
}
if (kind === 'desktop' && process.platform !== 'win32') {
  for (const extension of ['.AppImage', '.deb']) {
    if (!files.some((name) => name.endsWith(extension))) {
      throw new Error(`Missing required Linux ${extension} artifact in ${directory}`);
    }
  }
}

const lines = files.sort().map((name) => {
  const sha = createHash('sha256')
    .update(readFileSync(join(directory, name)))
    .digest('hex');
  return `${sha}  ${name}`;
});
const suffix = kind === 'mobile' ? 'mobile' : process.platform;
const output = join(directory, `SHA256SUMS-${suffix}.txt`);
writeFileSync(output, `${lines.join('\n')}\n`);
console.log(`Verified ${files.length} artifact(s); wrote ${output}`);
