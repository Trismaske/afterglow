#!/usr/bin/env node
/**
 * The OS baseline for text and icon scaling (m0.9.1, Tristan's screenshot
 * review 2026-10-09): what do the platform's own screens do when the OS
 * font-size setting changes? The walk measures OUR text; this measures
 * the reference — the Android Settings app, and any launchable app named
 * with --apps (Google Photos, YouTube) — at each font scale: every text
 * node's box height (the line box, which is what grows with the font)
 * and every image node's box (icons: do they grow with the font at all?).
 * Read-only on the apps; it sets `font_scale` like the walk and restores
 * the device's own value in a finally.
 *
 * Usage: node scripts/os-text-baseline.mjs --serial SERIAL
 *          [--fonts 1.0,1.3,2.0] [--apps settings,photos,youtube]
 * Prints, per app and scale, the text heights seen (px, most frequent
 * first, with an example text each) and the icon boxes seen, plus the
 * growth of each against the first scale. Compare with the walk's dumps
 * of our screens on the same device (docs/accessibility-audit.md, "The
 * OS baseline").
 */
import { createDriver, resolveSerial } from './lib/ui-driver.mjs';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const SERIAL = resolveSerial(argOf('--serial'));
const FONTS = argOf('--fonts', '1.0,1.3,2.0').split(',').map(Number);
const APPS = argOf('--apps', 'settings,photos').split(',');

const LAUNCH = {
  settings: 'am start -a android.settings.SETTINGS >/dev/null',
  photos:
    'monkey -p com.google.android.apps.photos -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1',
  youtube:
    'monkey -p com.google.android.youtube -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1',
};
const PACKAGE = {
  settings: 'com.android.settings',
  photos: 'com.google.android.apps.photos',
  youtube: 'com.google.android.youtube',
};

const d = createDriver(SERIAL, 'com.android.settings');
const { shell, sleep, dumpRaw } = d;

/** Every node with a class, text and bounds, from the raw dump. */
function nodesOf(xml) {
  const out = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const attr = (k) => (m[0].match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
    const b = attr('bounds').match(/\d+/g);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({
      cls: attr('class'),
      text: attr('text'),
      desc: attr('content-desc'),
      w: x2 - x1,
      h: y2 - y1,
    });
  }
  return out;
}

/** Heights of one node class, most frequent first, with an example. */
function histogram(nodes, pick) {
  const by = new Map();
  for (const n of nodes) {
    if (!pick(n)) continue;
    const key = n.h;
    const entry = by.get(key) ?? { h: key, count: 0, example: n.text || n.desc || '' };
    entry.count += 1;
    by.set(key, entry);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

const startingFont = shell('settings get system font_scale').trim();
const restoreFont = () =>
  shell(
    startingFont === 'null' || startingFont === ''
      ? 'settings delete system font_scale'
      : `settings put system font_scale ${startingFont}`,
  );
// An interrupted run restores the phone too: a finally does not run on
// SIGINT/SIGTERM (codex round 8; the walk does the same).
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    restoreFont();
    console.log(`\n${signal}: restored ${SERIAL}: font_scale ${startingFont}`);
    process.exit(130);
  });
const results = {};
const incomplete = [];
try {
  for (const font of FONTS) {
    shell(`settings put system font_scale ${font}`);
    await sleep(1500);
    for (const app of APPS) {
      if (!LAUNCH[app]) throw new Error(`unknown app ${app}: ${Object.keys(LAUNCH).join(', ')}`);
      shell(`am force-stop ${PACKAGE[app]}`);
      await sleep(500);
      shell(LAUNCH[app]);
      await sleep(4000);
      let xml = '';
      for (let attempt = 0; attempt < 3 && xml === ''; attempt += 1) xml = dumpRaw();
      if (xml === '') {
        // No evidence is not a measurement (codex round 8): the run says
        // so and fails at the end, like the walk's INCOMPLETE.
        incomplete.push(`${app} at font ${font}: no UI dump (the UI never idled)`);
        console.log(`\n== ${app} at font ${font}: INCOMPLETE — no UI dump`);
        shell(`am force-stop ${PACKAGE[app]}`);
        continue;
      }
      const nodes = nodesOf(xml);
      const texts = histogram(nodes, (n) => n.cls === 'android.widget.TextView' && n.text);
      const icons = histogram(nodes, (n) => /ImageView|ImageButton/.test(n.cls) && n.w <= 200);
      results[`${app}@${font}`] = {
        texts,
        icons,
        allTexts: nodes.filter((n) => n.cls === 'android.widget.TextView' && n.text),
      };
      console.log(`\n== ${app} at font ${font} (${nodes.length} nodes)`);
      console.log(
        '  text line boxes (px): ' +
          texts
            .slice(0, 6)
            .map((t) => `${t.h}×${t.count} "${t.example.slice(0, 18)}"`)
            .join(' · '),
      );
      console.log(
        '  icon boxes (px):      ' +
          icons
            .slice(0, 5)
            .map((t) => `${t.h}×${t.count}`)
            .join(' · '),
      );
      shell(`am force-stop ${PACKAGE[app]}`);
    }
  }
  // Growth against the first scale, text by text: the SAME text at both
  // scales (a settings row title is stable), its line box then over now,
  // grouped by the base line box so small and large text read apart
  // (Android 14+ scales them differently); icons by their box, since the
  // same icon keeps its box when icons do not scale.
  const base = FONTS[0];
  for (const app of APPS) {
    const b = results[`${app}@${base}`];
    if (!b) continue;
    console.log(`\n== ${app}: growth against font ${base}, the same text at both scales`);
    for (const font of FONTS.slice(1)) {
      const r = results[`${app}@${font}`];
      if (!r) {
        console.log(`  ${font}: no capture`);
        continue;
      }
      const pairs = [];
      for (const t of b.allTexts)
        for (const u of r.allTexts)
          if (u.text === t.text && !pairs.some((q) => q.text === t.text))
            pairs.push({ text: t.text, from: t.h, to: u.h });
      const line = (label, rows) =>
        rows.length &&
        console.log(
          `  ${font} ${label}: ` +
            rows
              .slice(0, 4)
              .map(
                (q) =>
                  `${q.from}→${q.to} px (×${(q.to / q.from).toFixed(2)}) "${q.text.slice(0, 16)}"`,
              )
              .join(' · '),
        );
      const small = pairs.filter((q) => q.from < 60);
      const mid = pairs.filter((q) => q.from >= 60 && q.from < 90);
      const large = pairs.filter((q) => q.from >= 90);
      line('small text', small);
      line('medium text', mid);
      line('large text', large);
      const iconBoxes = (x) =>
        x.icons
          .map((i) => i.h)
          .sort((a, c) => a - c)
          .join(',');
      console.log(`  ${font} icon boxes: ${iconBoxes(b)} → ${iconBoxes(r)}`);
    }
  }
} finally {
  restoreFont();
  console.log(`\nrestored ${SERIAL}: font_scale ${startingFont}`);
}
if (incomplete.length > 0) {
  console.log(`INCOMPLETE (${incomplete.length}): ${incomplete.join(' | ')}`);
  process.exit(1);
}
