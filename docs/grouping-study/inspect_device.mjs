// Phase-10 card inspector (m0.9): the built engine over one card's maximal
// merge window on a device's own vectors — the groups and parts it forms
// for the named photos, plus their pairwise cosines. For Tristan's
// example folders (~/PhoneSync/Not In Group, In Group But Shouldn't Be).
//
//   node docs/grouping-study/inspect_device.mjs <device.jsonl> <basename>...
import { readFileSync } from 'node:fs';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding } from '../../packages/core/dist/index.js';

const [rowsPath, ...names] = process.argv.slice(2);
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byId = new Map();
for (const r of rows) {
  const buf = Buffer.from(r.vec, 'base64');
  byId.set(r.id, { ...r, vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
}
const sortedRows = [...rows].sort((a, b) => a.ts - b.ts);
const base = (uri) => uri.split('/').pop();
const WINDOW_MS = ADJACENT_MERGE_MAX_GAP_MS;
const wanted = sortedRows.filter((r) => names.includes(base(r.uri)));
if (wanted.length !== names.length) console.log(`found ${wanted.length} of ${names.length}:`, wanted.map((r) => base(r.uri)));
const ts = wanted.map((r) => r.ts);
let lo = sortedRows.findIndex((r) => r.ts >= Math.min(...ts));
let hi = sortedRows.findIndex((r) => r.ts > Math.max(...ts));
if (hi === -1) hi = sortedRows.length;
hi -= 1;
while (lo > 0 && sortedRows[lo].ts - sortedRows[lo - 1].ts <= WINDOW_MS) lo--;
while (hi < sortedRows.length - 1 && sortedRows[hi + 1].ts - sortedRows[hi].ts <= WINDOW_MS) hi++;
const window = sortedRows.slice(lo, hi + 1);
console.log(`window: ${window.length} photos, ${new Date(window[0].ts).toISOString()} → ${new Date(window[window.length - 1].ts).toISOString()}`);
const groups = groupByEmbedding(
  window.map((r) => ({ id: r.id, timestamp: r.ts, uri: r.uri, kind: r.kind })),
  (id) => byId.get(id)?.vec ?? null,
  (id) => byId.get(id)?.hash ?? null,
);
const wantedIds = new Set(wanted.map((r) => r.id));
for (const g of groups) {
  if (!g.items.some((it) => wantedIds.has(it.id))) continue;
  console.log(`group of ${g.items.length}: ${g.items.map((it) => base(it.uri)).join(' ')}`);
  g.parts.forEach((p, i) => console.log(`  part ${i + 1}: ${p.map((id) => base(byId.get(id).uri)).join(' ')}`));
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
console.log('pairwise cosines:');
for (let i = 0; i < wanted.length; i++)
  for (let j = i + 1; j < wanted.length; j++)
    console.log(`  ${base(wanted[i].uri)} ~ ${base(wanted[j].uri)}: ${dot(byId.get(wanted[i].id).vec, byId.get(wanted[j].id).vec).toFixed(3)}  gap ${((wanted[j].ts - wanted[i].ts) / 1000).toFixed(0)} s`);
