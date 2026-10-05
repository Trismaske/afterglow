// Phase-10 device fixture (m0.9): freeze every judged device round as one
// versioned core regression fixture, `device-rounds-v1.json`.
//
//   node docs/grouping-study/make_device_fixture.mjs <device.jsonl> <out.json> <labels.json>...
//
// The fixture holds every photo inside the judged cards' maximal merge
// windows (at the engine's shipped window) — id, capture time, hash and
// the DEVICE vector as base64 float32 — and every card's constraints
// (must-link and cannot-link pairs by id) with its round, kind and
// verdict. Windows re-form over the fixture alone: a window's neighbours
// outside it are beyond the merge gap by construction, so the chains the
// core test rebuilds are the device's. The script prints the engine's
// score per class at shipped defaults — what the test pins.
import { readFileSync, writeFileSync } from 'node:fs';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding } from '../../packages/core/dist/index.js';

const [rowsPath, outPath, ...labelPaths] = process.argv.slice(2);
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byUri = new Map(rows.map((r) => [r.uri, r]));
const sorted = [...rows].sort((a, b) => a.ts - b.ts);
const W = ADJACENT_MERGE_MAX_GAP_MS;
function windowRows(uris) {
  const ts = uris.map((u) => byUri.get(u).ts);
  let lo = sorted.findIndex((r) => r.ts >= Math.min(...ts));
  let hi = sorted.findIndex((r) => r.ts > Math.max(...ts));
  if (hi === -1) hi = sorted.length;
  hi -= 1;
  while (lo > 0 && sorted[lo].ts - sorted[lo - 1].ts <= W) lo--;
  while (hi < sorted.length - 1 && sorted[hi + 1].ts - sorted[hi].ts <= W) hi++;
  return sorted.slice(lo, hi + 1);
}
const photos = new Map();
const cards = [];
labelPaths.forEach((p, i) => {
  const round = p.match(/round(\w+)\.json$/)?.[1] ?? String(i + 1);
  for (const c of JSON.parse(readFileSync(p, 'utf8')).cards) {
    const uris = c.members ?? Object.keys(c.parts);
    if (!uris.every((u) => byUri.has(u))) continue;
    for (const r of windowRows(uris)) photos.set(r.id, r);
    const id = (u) => byUri.get(u).id;
    cards.push({
      round,
      card: c.card,
      kind: c.type ?? c.kind,
      verdict: c.verdict,
      members: uris.map(id),
      must: c.must.map(([a, b]) => [id(a), id(b)]),
      cannot: c.cannot.map(([a, b]) => [id(a), id(b)]),
    });
  }
});
const fixture = {
  version: 'device-rounds-v1',
  source: 'S10e rounds 1, 2, 3a, 3b (2026-10-05), windows at the shipped merge gap',
  mergeGapMs: W,
  photos: [...photos.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ id: r.id, ts: r.ts, hash: r.hash ?? null, vec: r.vec })),
  cards,
};
writeFileSync(outPath, JSON.stringify(fixture));
console.log(`${fixture.photos.length} photos, ${cards.length} cards → ${outPath}`);

// The score at shipped defaults, the way the core test computes it.
const byId = new Map();
for (const p of fixture.photos) {
  const buf = Buffer.from(p.vec, 'base64');
  byId.set(p.id, { ...p, vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
}
const groupOf = new Map();
const partOf = new Map();
let window = [];
let gi = 0;
const flush = () => {
  if (window.length === 0) return;
  const groups = groupByEmbedding(
    window.map((p) => ({ id: p.id, timestamp: p.ts, uri: p.id, kind: 'photo' })),
    (id) => byId.get(id)?.vec ?? null,
    (id) => byId.get(id)?.hash ?? null,
  );
  for (const g of groups) {
    const key = gi++;
    g.items.forEach((it) => groupOf.set(it.id, key));
    g.parts.forEach((part, pi) => part.forEach((id) => partOf.set(id, `${key}/${pi}`)));
  }
  window = [];
};
for (const p of fixture.photos) {
  if (window.length > 0 && p.ts - window[window.length - 1].ts > W) flush();
  window.push(p);
}
flush();
const tally = {};
for (const c of cards) {
  for (const level of ['group', 'part']) {
    const unit = level === 'group' ? groupOf : partOf;
    const same = (a, b) => unit.get(a) === unit.get(b);
    const agreed =
      c.must.filter(([a, b]) => same(a, b)).length + c.cannot.filter(([a, b]) => !same(a, b)).length;
    const pairs = c.must.length + c.cannot.length;
    const k = `${level} r${c.round} ${c.kind}/${c.verdict}`;
    tally[k] ??= { n: 0, exact: 0, agree: 0 };
    tally[k].n++;
    if (agreed === pairs) tally[k].exact++;
    tally[k].agree += pairs ? agreed / pairs : 1;
  }
}
for (const [k, t] of Object.entries(tally).sort()) {
  console.log(k.padEnd(34), `${t.exact}/${t.n}`.padStart(6), `${(100 * t.agree / t.n).toFixed(1)}%`.padStart(7));
}
