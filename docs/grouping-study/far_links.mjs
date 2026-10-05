// Phase-10 far look-alikes (m0.9): the candidates the merge
// window keeps apart. Over a device's own vectors the built engine forms
// the library's units (groups and singles, as on the phone); every unit
// is then compared with every other unit on the same day by centroid
// cosine, and the pairs beyond the merge gap are counted by gap bucket
// and similarity bar — the population a wider window or a far-link tier
// would join, and the pool a judged round samples from.
//
//   node docs/grouping-study/far_links.mjs <device.jsonl> [out.json] [--window-min N]
//
// --window-min forms the units with THAT merge window and no far bar (15
// = the pre-phase-10 engine), so a round can judge the pairs the shipped
// 60-minute window with the far bar now decides; every pair carries the
// centroid cosine, the best and the mean member pair, and the unit sizes.
import { readFileSync, writeFileSync } from 'node:fs';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding } from '../../packages/core/dist/index.js';

const argv = process.argv.slice(2);
const windowArg = argv.indexOf('--window-min');
const windowMin = windowArg === -1 ? null : Number(argv[windowArg + 1]);
const positional = argv.filter((a, i) => a !== '--window-min' && i !== windowArg + 1);
const [rowsPath, outPath] = positional;
const unitOptions =
  windowMin === null
    ? {}
    : { adjacentMergeMaxGapMs: windowMin * 60_000, farMergeGapMs: windowMin * 60_000 };
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byId = new Map();
for (const r of rows) {
  const buf = Buffer.from(r.vec, 'base64');
  byId.set(r.id, { ...r, vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
}
const sortedRows = [...rows].sort((a, b) => a.ts - b.ts);
// Grouped window by window — the maximal merge-gap chains the scan
// accumulator hands the engine (lib/scanWindows.ts): identical output,
// and the only tractable way over a 31k-photo library (one engine call
// over everything spends its merge stage on 15k groups at once).
const MERGE_GAP_MS = windowMin === null ? ADJACENT_MERGE_MAX_GAP_MS : windowMin * 60_000;
const groups = [];
let window = [];
const flush = () => {
  if (window.length === 0) return;
  groups.push(
    ...groupByEmbedding(
      window.map((r) => ({ id: r.id, timestamp: r.ts, uri: r.uri, kind: r.kind })),
      (id) => byId.get(id)?.vec ?? null,
      (id) => byId.get(id)?.hash ?? null,
      unitOptions,
    ),
  );
  window = [];
};
for (const r of sortedRows) {
  if (window.length > 0 && r.ts - window[window.length - 1].ts > MERGE_GAP_MS) flush();
  window.push(r);
}
flush();
const units = groups.map((g) => {
  const vs = g.items.map((it) => byId.get(it.id).vec);
  const c = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  let n = 0;
  for (let i = 0; i < c.length; i++) n += c[i] * c[i];
  n = Math.sqrt(n);
  for (let i = 0; i < c.length; i++) c[i] /= n;
  return { items: g.items, start: g.start, end: g.end, centroid: c, day: new Date(g.start).toDateString() };
});
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const MIN = 60_000;
const buckets = [
  ['15–30 min', 15 * MIN, 30 * MIN],
  ['30–60 min', 30 * MIN, 60 * MIN],
  ['1–3 h', 60 * MIN, 180 * MIN],
  ['3–12 h', 180 * MIN, 720 * MIN],
  ['12–24 h', 720 * MIN, 1440 * MIN],
];
const bars = [0.7, 0.75, 0.8, 0.85, 0.9];
// The gap between two units is the silence between them (end to start).
const pairs = [];
for (let a = 0; a < units.length; a++) {
  for (let b = a + 1; b < units.length; b++) {
    const gap = units[b].start - units[a].end;
    if (gap <= MERGE_GAP_MS) continue;
    if (gap > 1440 * MIN) break;
    const sim = dot(units[a].centroid, units[b].centroid);
    if (sim < 0.7) continue;
    let best = -Infinity;
    let total = 0;
    let n = 0;
    for (const x of units[a].items) {
      const va = byId.get(x.id).vec;
      for (const y of units[b].items) {
        const s = dot(va, byId.get(y.id).vec);
        if (s > best) best = s;
        total += s;
        n++;
      }
    }
    pairs.push({ a, b, gap, sim, best, mean: total / n });
  }
}
console.log(`units ${units.length} (groups ≥2: ${units.filter((u) => u.items.length >= 2).length}); candidate pairs beyond the merge window at ≥0.70: ${pairs.length}`);
console.log('pairs by gap bucket (rows) and similarity bar (columns, ≥):');
console.log(''.padEnd(12) + bars.map((b) => String(b).padStart(8)).join(''));
for (const [name, lo, hi] of buckets) {
  const inB = pairs.filter((p) => p.gap > lo && p.gap <= hi);
  console.log(name.padEnd(12) + bars.map((b) => String(inB.filter((p) => p.sim >= b).length).padStart(8)).join(''));
}
// How many units would a far link touch: a unit's BEST partner beyond
// the window, by bar — the join count a far-link tier would make.
console.log('\nunits whose best far partner (≤ 24 h) clears the bar:');
const best = new Map();
for (const p of pairs) {
  for (const [u, o] of [[p.a, p.b], [p.b, p.a]]) {
    if (!best.has(u) || best.get(u).sim < p.sim) best.set(u, { other: o, sim: p.sim, gap: p.gap });
  }
}
console.log(''.padEnd(12) + bars.map((b) => String(b).padStart(8)).join(''));
console.log('units'.padEnd(12) + bars.map((b) => String([...best.values()].filter((x) => x.sim >= b).length).padStart(8)).join(''));
console.log('singles'.padEnd(12) + bars.map((b) => String([...best.entries()].filter(([u, x]) => x.sim >= b && units[u].items.length === 1).length).padStart(8)).join(''));
if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify(
      pairs
        .sort((x, y) => y.sim - x.sim)
        .map((p) => ({
          sim: p.sim,
          best: p.best,
          mean: p.mean,
          gap_s: p.gap / 1000,
          a: units[p.a].items.map((it) => it.uri),
          b: units[p.b].items.map((it) => it.uri),
        })),
      null,
      1,
    ),
  );
}
