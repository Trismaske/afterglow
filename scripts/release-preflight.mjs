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
  // P4#5 (m0.7): patch zero keeps the historical short tag; a non-zero
  // patch carries it — 0.7.0 → mobile-m0.7, 0.7.1 → mobile-m0.7.1.
  const expected = patch === 0 ? `mobile-m${major}.${minor}` : `mobile-m${major}.${minor}.${patch}`;
  if (tag !== expected) throw new Error(`Mobile tag ${tag} must exactly match ${expected}`);

  const versionCode = app.expo.android?.versionCode;
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error(`Invalid Android versionCode ${String(versionCode)}`);
  }

  // m0.8.4 floor: the APK's minSdkVersion comes from the expo-build-properties
  // plugin config, which prebuild writes into the merged manifest. Asserting it
  // here is redundant with the workflow's aapt check on the built APK — the
  // point is that this one fails locally, before a tag is pushed, where the
  // artifact gate can only fail afterwards. expo.plugins mixes bare strings
  // with [name, config] pairs, so match both shapes.
  const MIN_SDK_FLOOR = 30;
  const plugins = Array.isArray(app.expo.plugins) ? app.expo.plugins : [];
  const buildProperties = plugins.find(
    (plugin) =>
      plugin === 'expo-build-properties' ||
      (Array.isArray(plugin) && plugin[0] === 'expo-build-properties'),
  );
  if (!buildProperties) {
    throw new Error(
      'apps/mobile/app.json: expo.plugins has no expo-build-properties entry — the APK would ' +
        `fall back to Expo's default minSdkVersion. Add ["expo-build-properties", { "android": ` +
        `{ "minSdkVersion": ${MIN_SDK_FLOOR} } }] to expo.plugins.`,
    );
  }
  const minSdkVersion = Array.isArray(buildProperties)
    ? buildProperties[1]?.android?.minSdkVersion
    : undefined;
  if (!Number.isInteger(minSdkVersion) || minSdkVersion < MIN_SDK_FLOOR) {
    throw new Error(
      `apps/mobile/app.json: expo-build-properties android.minSdkVersion is ` +
        `${JSON.stringify(minSdkVersion) ?? 'undefined'}; set it to an integer >= ${MIN_SDK_FLOOR} ` +
        `(Android 11), the floor every removal path depends on.`,
    );
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
  console.log(
    `Mobile release version OK: ${tag} (versionCode ${versionCode}, minSdkVersion ${minSdkVersion})`,
  );
}
