import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [kind, tag] = process.argv.slice(2);
if (!['desktop', 'mobile'].includes(kind) || !tag) {
  throw new Error('Usage: node scripts/release-preflight.mjs <desktop|mobile> <tag>');
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

if (kind === 'desktop') {
  const pkg = readJson('apps/desktop/package.json');
  const expected = `desktop-v${pkg.version}`;
  if (tag !== expected) throw new Error(`Desktop tag ${tag} must exactly match ${expected}`);
  console.log(`Desktop release version OK: ${tag}`);
} else {
  const pkg = readJson('apps/mobile/package.json');
  const app = readJson('apps/mobile/app.json');
  if (pkg.version !== app.expo.version) {
    throw new Error(`Mobile package version ${pkg.version} != Expo version ${app.expo.version}`);
  }
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isInteger)) throw new Error('Invalid mobile semver');
  const expected = `mobile-m${major}.${minor}`;
  if (tag !== expected) throw new Error(`Mobile tag ${tag} must exactly match ${expected}`);

  const versionCode = app.expo.android?.versionCode;
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error(`Invalid Android versionCode ${String(versionCode)}`);
  }

  // When older mobile tags are available, prove the Android installer can
  // upgrade in place. A missing/legacy app.json is ignored; an equal or lower
  // versionCode is a hard release failure.
  try {
    const tags = execFileSync('git', ['tag', '--list', 'mobile-m*', '--sort=-version:refname'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((candidate) => candidate && candidate !== tag);
    for (const previousTag of tags) {
      try {
        const previous = JSON.parse(
          execFileSync('git', ['show', `${previousTag}:apps/mobile/app.json`], {
            encoding: 'utf8',
          }),
        );
        const previousCode = previous.expo?.android?.versionCode;
        if (Number.isInteger(previousCode) && versionCode <= previousCode) {
          throw new Error(
            `Android versionCode ${versionCode} must exceed ${previousCode} from ${previousTag}`,
          );
        }
        break;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Android versionCode')) throw error;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Android versionCode')) throw error;
  }
  console.log(`Mobile release version OK: ${tag} (versionCode ${versionCode})`);
}
