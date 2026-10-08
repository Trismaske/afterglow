#!/usr/bin/env node
/**
 * The static half of the per-site text audit (m0.9.1 phase 1, docs/Plan_m0.9.1.md).
 *
 * Walks every .tsx under apps/mobile/src and lists each <Text> site with
 * the style it names, the font size that style declares, and the
 * CONTAINER CLASS the surrounding code implies:
 *
 *   - `ellipsized` — the Text carries numberOfLines (growth is cut off);
 *   - `capped`     — the Text carries maxFontSizeMultiplier or
 *                    allowFontScaling={false} (growth is limited);
 *   - `fixed`      — the Text's own style, or a style named within the
 *                    enclosing five lines, declares a fixed `height`;
 *   - `free`       — none of the above: the Text grows and its container
 *                    (flex) grows with it.
 *
 * Heuristic by design: styles are resolved from the file's own
 * StyleSheet.create block (a style defined elsewhere resolves to "?"),
 * and "fixed" reads the local neighbourhood, not the layout tree. The
 * walk's screenshots supply the break scale per site; this table says
 * where to look.
 *
 * Usage: node scripts/text-audit.mjs [--md]    (tab-separated by default)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../apps/mobile/src', import.meta.url).pathname;
const md = process.argv.includes('--md');

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* tsxFiles(path);
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) yield path;
  }
}

/** The file's StyleSheet.create block as name → { fontSize, height, lineHeight }. */
function localStyles(source) {
  const styles = new Map();
  const start = source.indexOf('StyleSheet.create({');
  if (start < 0) return styles;
  const block = source.slice(start);
  const re = /^\s{2}(\w+):\s*\{([^}]*)\}/gm;
  for (const m of block.matchAll(re)) {
    const body = m[2];
    const num = (key) => {
      const mm = body.match(new RegExp(`\\b${key}:\\s*([0-9.]+)`));
      return mm ? Number(mm[1]) : null;
    };
    styles.set(m[1], {
      fontSize: num('fontSize'),
      height: num('height'),
      lineHeight: num('lineHeight'),
    });
  }
  return styles;
}

const rows = [];
for (const file of tsxFiles(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const styles = localStyles(source);
  const lines = source.split('\n');
  const re = /<Text\b([^>]*)>/g;
  for (const m of source.matchAll(re)) {
    const attrs = m[1];
    const line = source.slice(0, m.index).split('\n').length;
    const styleNames = [...attrs.matchAll(/styles\.(\w+)/g)].map((s) => s[1]);
    const inline = attrs.match(/fontSize:\s*([0-9.]+)/);
    let fontSize = inline ? Number(inline[1]) : null;
    let fixedHeight = null;
    for (const name of styleNames) {
      const s = styles.get(name);
      if (!s) continue;
      if (fontSize === null && s.fontSize !== null) fontSize = s.fontSize;
      if (s.height !== null) fixedHeight = s.height;
    }
    // The enclosing neighbourhood: a fixed-height style named on a parent
    // within five lines above the Text.
    if (fixedHeight === null) {
      const above = lines.slice(Math.max(0, line - 6), line - 1).join('\n');
      for (const s of above.matchAll(/styles\.(\w+)/g)) {
        const st = styles.get(s[1]);
        if (st && st.height !== null) fixedHeight = st.height;
      }
    }
    const cls = /numberOfLines/.test(attrs)
      ? 'ellipsized'
      : /maxFontSizeMultiplier|allowFontScaling=\{false\}/.test(attrs)
        ? 'capped'
        : fixedHeight !== null
          ? 'fixed'
          : 'free';
    rows.push({
      file: relative(ROOT, file),
      line,
      style: styleNames.join('+') || '(inline)',
      fontSize: fontSize ?? '?',
      container: cls,
      height: fixedHeight ?? '',
    });
  }
}

rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const counts = rows.reduce((acc, r) => ((acc[r.container] = (acc[r.container] ?? 0) + 1), acc), {});
if (md) {
  console.log(`| File | Line | Style | Size | Container | Height |\n|---|---|---|---|---|---|`);
  for (const r of rows)
    console.log(
      `| ${r.file} | ${r.line} | ${r.style} | ${r.fontSize} | ${r.container} | ${r.height} |`,
    );
} else {
  console.log('file\tline\tstyle\tfontSize\tcontainer\theight');
  for (const r of rows)
    console.log([r.file, r.line, r.style, r.fontSize, r.container, r.height].join('\t'));
}
console.error(`${rows.length} Text sites: ${JSON.stringify(counts)}`);
