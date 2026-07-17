/**
 * Build script: three bundles + static renderer assets.
 *
 *   main     src/main/index.ts     → dist/main/index.js     (cjs, node, electron external)
 *   preload  src/preload/index.ts  → dist/preload/index.js  (cjs, node, electron external)
 *   renderer src/renderer/index.ts → dist/renderer/index.js (iife, browser)
 *   static   src/renderer/*.html|css → dist/renderer/
 */

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  logLevel: 'info',
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/main/index.ts')],
  outfile: join(root, 'dist/main/index.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(root, 'dist/preload/index.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/renderer/index.ts')],
  outfile: join(root, 'dist/renderer/index.js'),
  platform: 'browser',
  format: 'iife',
});

mkdirSync(join(root, 'dist/renderer'), { recursive: true });
for (const asset of ['index.html', 'styles.css']) {
  copyFileSync(join(root, 'src/renderer', asset), join(root, 'dist/renderer', asset));
}
