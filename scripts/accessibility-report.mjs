#!/usr/bin/env node
/**
 * The accessibility walk's reader (m0.9.1 phase 1): turns the walk's
 * raw UI dumps into the measured half of the per-site audit — for each
 * screen on each target, the first font scale at which something gives.
 *
 * Three signals, all read from `uiautomator` node bounds (no pixels):
 *
 *   - CLIPPED  — a text node whose bounds leave the screen horizontally.
 *   - WRAPPED  — a text node whose height grew well beyond what the scale
 *                alone explains (a one-line label that now wraps).
 *   - CLAMPED  — a short label (under half the screen wide at the base
 *                scale) that scaled up but whose width did not grow: it
 *                hit a fixed width and was cut or ellipsized. Container-
 *                wide text is excluded — its width is the container's.
 *   - INCOMPLETE — a combination or a screen without evidence (a failed
 *                relaunch, a step that failed, a dump that never idled):
 *                reported, never counted as a pass.
 *   - OVERLAP  — two text nodes whose bounds intersect by more than 2 px
 *                in both axes; a one-glyph node (a tab icon with its
 *                badge count on top) is by design and skipped.
 *
 * Nodes are keyed by their text (or content-desc) so the same label is
 * compared across scales; a label that changes with content (counts,
 * times) compares by its first word. Usage:
 *
 *   node scripts/accessibility-report.mjs <report-dir> [--md]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [reportDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!reportDir) throw new Error('usage: accessibility-report.mjs <report-dir>');
const md = process.argv.includes('--md');

function nodesOf(xml) {
  const nodes = [];
  for (const tag of xml.match(/<node[^>]*>/g) ?? []) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : '';
    };
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    const text = attr('text') || attr('content-desc');
    if (!text || attr('class') !== 'android.widget.TextView') continue;
    nodes.push({ text, x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 });
  }
  return nodes;
}

const keyOf = (text) => (/\d/.test(text) ? text.split(/\s+/)[0].replace(/\d+/g, '#') : text);

const findings = [];
for (const serial of readdirSync(reportDir)) {
  const serialDir = join(reportDir, serial);
  if (!statSync(serialDir).isDirectory()) continue;
  const combos = readdirSync(serialDir)
    .map((name) => {
      const m = name.match(/^f([\d.]+)-d(.+)$/);
      return m ? { name, font: Number(m[1]), density: m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.density.localeCompare(b.density) || a.font - b.font);
  const byDensity = new Map();
  for (const c of combos) {
    if (!byDensity.has(c.density)) byDensity.set(c.density, []);
    byDensity.get(c.density).push(c);
  }
  for (const [density, list] of byDensity) {
    // Every combination's recorded failures are findings of their own:
    // a screen with no dump is missing evidence, never a pass.
    for (const c of list) {
      const path = join(serialDir, c.name, 'geometry.json');
      if (!existsSync(path)) {
        findings.push({
          serial,
          density,
          font: c.font,
          screen: '(all)',
          signal: 'INCOMPLETE',
          detail: 'the combination never finished',
        });
        continue;
      }
      for (const failure of JSON.parse(readFileSync(path, 'utf8')).failures ?? [])
        findings.push({
          serial,
          density,
          font: c.font,
          screen: String(failure).split(':')[0],
          signal: 'INCOMPLETE',
          detail: String(failure),
        });
    }
    // The base is the smallest scale that finished; a density whose
    // combinations all failed has nothing to read and is already
    // reported as INCOMPLETE above. One finished capture is enough for
    // the standalone signals (codex round 5).
    const finished = list.filter(
      (c) =>
        existsSync(join(serialDir, c.name, 'geometry.json')) &&
        readdirSync(join(serialDir, c.name)).some((f) => f.endsWith('.xml')),
    );
    if (finished.length === 0) continue;
    // Every screen captured by any finished combination, each compared
    // against ITS OWN earliest capture: a screen the smallest scale missed
    // still gets its later evidence read (codex round 3).
    const screens = new Set();
    for (const c of finished)
      for (const f of readdirSync(join(serialDir, c.name))) if (f.endsWith('.xml')) screens.add(f);
    for (const screenFile of screens) {
      const screen = screenFile.replace(/\.xml$/, '');
      const withScreen = finished.filter((c) => existsSync(join(serialDir, c.name, screenFile)));
      if (withScreen.length === 0) continue;
      const base = withScreen[0];
      const geometry = JSON.parse(
        readFileSync(join(serialDir, base.name, 'geometry.json'), 'utf8'),
      );
      const screenW = geometry.widthDp ? Math.round((geometry.widthDp * geometry.dpi) / 160) : null;
      const baseNodes = nodesOf(readFileSync(join(serialDir, base.name, screenFile), 'utf8'));
      const baseByKey = new Map(baseNodes.map((n) => [keyOf(n.text), n]));
      // CLIPPED and OVERLAP need no comparison: every capture, the base
      // included, is checked on its own; WRAPPED and CLAMPED compare to
      // the base (codex round 4).
      for (const c of withScreen) {
        const path = join(serialDir, c.name, screenFile);
        const nodes = c === base ? baseNodes : nodesOf(readFileSync(path, 'utf8'));
        const ratio = c.font / base.font;
        for (const n of nodes) {
          const key = keyOf(n.text);
          if (screenW && (n.x1 < 0 || n.x2 > screenW))
            findings.push({
              serial,
              density,
              font: c.font,
              screen,
              signal: 'CLIPPED',
              detail: `"${n.text}" leaves the screen horizontally`,
            });
          if (c === base) continue;
          const b = baseByKey.get(key);
          if (!b || n.text.length < 3 || /^[\d\s.,%/]+$/.test(n.text) || /^&#\d+;$/.test(n.text))
            continue;
          // The stack header's title does not scale with the font at all (a
          // platform behaviour, noted in the audit): a node whose box is
          // the base's box to the pixel at another scale is that title,
          // not a clamp of ours — every text of ours at least grows in
          // height.
          if (n.x1 === b.x1 && n.y1 === b.y1 && n.x2 === b.x2 && n.y2 === b.y2) continue;
          // One line became two or more: the height outgrew the scale.
          if (n.h > b.h * ratio * 1.6)
            findings.push({
              serial,
              density,
              font: c.font,
              screen,
              signal: 'WRAPPED',
              detail: `"${n.text}" wrapped to ${Math.round(n.h / (b.h * ratio))} lines`,
            });
          // The text scaled but its box did not widen: a fixed width cut it.
          else if (ratio >= 1.2 && n.w <= b.w * 1.05 && b.w < (screenW ?? Infinity) * 0.5)
            findings.push({
              serial,
              density,
              font: c.font,
              screen,
              signal: 'CLAMPED',
              detail: `"${n.text}" kept its ${b.w} px width at ${ratio.toFixed(2)}× scale`,
            });
        }
        // Icon glyphs count: a badge on an icon's corner is by design, a
        // badge that hides the icon is not — the rule is COVERAGE: an
        // intersection over half of the smaller node (Tristan, 2026-10-09,
        // the tab badges at 2.0×).
        const multi = nodes.filter((n) => n.text.length > 0);
        for (let i = 0; i < multi.length; i += 1)
          for (let j = i + 1; j < multi.length; j += 1) {
            const a = multi[i];
            const o = multi[j];
            const ix = Math.min(a.x2, o.x2) - Math.max(a.x1, o.x1);
            const iy = Math.min(a.y2, o.y2) - Math.max(a.y1, o.y1);
            const smaller = Math.min(a.w * a.h, o.w * o.h);
            // A glyph or a one-character badge may sit on a corner by
            // design; anything else may not overlap at all.
            const corner = [a, o].some((n) => /^&#\d+;$/.test(n.text) || n.text.length === 1);
            if (ix > 2 && iy > 2 && (!corner || ix * iy > smaller * 0.5))
              findings.push({
                serial,
                density,
                font: c.font,
                screen,
                signal: 'OVERLAP',
                detail: `"${a.text}" over "${o.text}" (${ix}×${iy} px)`,
              });
          }
      }
    }
  }
}

// Collapse: the FIRST font scale per (serial, density, screen, signal, label).
const first = new Map();
for (const f of findings) {
  const label = f.detail.match(/"([^"]*)"/)?.[1] ?? f.detail;
  const k = [f.serial, f.density, f.screen, f.signal, label].join('|');
  if (!first.has(k) || first.get(k).font > f.font) first.set(k, f);
}
const rows = [...first.values()].sort(
  (a, b) =>
    a.serial.localeCompare(b.serial) ||
    a.density.localeCompare(b.density) ||
    a.screen.localeCompare(b.screen) ||
    a.font - b.font,
);
if (md) {
  console.log(
    '| Target | Density | Screen | First scale | Signal | Detail |\n|---|---|---|---|---|---|',
  );
  for (const r of rows)
    console.log(
      `| ${r.serial} | ${r.density} | ${r.screen} | ${r.font} | ${r.signal} | ${r.detail.replace(/\|/g, '/')} |`,
    );
} else {
  for (const r of rows)
    console.log([r.serial, r.density, r.screen, r.font, r.signal, r.detail].join('\t'));
}
console.error(`${rows.length} first-break findings from ${findings.length} raw signals`);
