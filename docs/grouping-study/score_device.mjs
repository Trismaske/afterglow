// Gate-2 device recalibration scorer (Plan_m0.8.md decision 10): score the
// core engine over DEVICE-computed vectors for the labels-v1 photos and
// compare against the committed-fixture baseline, plus per-photo cosine
// drift (device vs fixture vector). The committed regression suite is the
// arbiter — if the pinned floors fail on device vectors, the thresholds
// (or the pins) change deliberately.
//
// Input: JSONL {name, b64} pulled from the phone (lib/spike.ts 'dump'
// phase). Usage: node score_device.mjs <device-vectors.jsonl>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groupByEmbedding } from '../../packages/core/dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const input = process.argv[2];
if (!input) {
  console.error('usage: node score_device.mjs <device-vectors.jsonl>');
  process.exit(1);
}

const labels = JSON.parse(readFileSync(`${HERE}labels-v1.json`, 'utf8'));
const emb = JSON.parse(readFileSync(`${HERE}embeddings-labeled-v1.json`, 'utf8'));

const toVec = (b64) => {
  const raw = Uint8Array.prototype.slice.call(Buffer.from(b64, 'base64'));
  return new Float32Array(raw.buffer);
};

const fixture = new Map(Object.entries(emb.photos).map(([n, p]) => [n, toVec(p.vec)]));
const device = new Map();
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const { name, b64 } = JSON.parse(line);
  device.set(name, toVec(b64));
}
console.log(`device vectors: ${device.size} / fixture photos: ${fixture.size}`);

// Per-photo drift: cosine(device, fixture) — 1.0 means identical.
const drifts = [];
for (const [name, vec] of device) {
  const ref = fixture.get(name);
  if (!ref || ref.length !== vec.length) continue;
  let dot = 0;
  for (let i = 0; i < vec.length; i++) dot += vec[i] * ref[i];
  drifts.push(dot);
}
drifts.sort((a, b) => a - b);
const pct = (p) => drifts[Math.min(drifts.length - 1, Math.floor((p / 100) * drifts.length))];
console.log(
  `drift cos(device, fixture): min ${drifts[0]?.toFixed(4)} p5 ${pct(5).toFixed(4)} ` +
    `p50 ${pct(50).toFixed(4)} max ${drifts[drifts.length - 1]?.toFixed(4)}`,
);

const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const deliberate = new Set(labels.deliberate_nontransitive_apart.map((p) => key(p.a, p.b)));
const links = labels.hard.filter((p) => p.rel === 'link');
const aparts = labels.hard.filter((p) => p.rel === 'apart' && !deliberate.has(key(p.a, p.b)));

function score(vecs, label) {
  const items = Object.entries(emb.photos)
    .filter(([name]) => vecs.has(name))
    .map(([name, p]) => ({ id: name, timestamp: p.ts, uri: name, kind: 'photo' }));
  const groups = groupByEmbedding(items, (id) => vecs.get(id) ?? null);
  const groupOf = new Map();
  groups.forEach((g, i) => g.items.forEach((item) => groupOf.set(item.id, i)));
  const both = (p) => groupOf.has(p.a) && groupOf.has(p.b);
  const together = (p) => both(p) && groupOf.get(p.a) === groupOf.get(p.b);
  const scoredLinks = links.filter(both);
  const scoredAparts = aparts.filter(both);
  const kept = scoredLinks.filter(together).length;
  const viol = scoredAparts.filter(together).length;
  const largest = Math.max(...groups.map((g) => g.items.length));
  console.log(
    `${label.padEnd(18)} kept ${kept}/${scoredLinks.length}  viol ${viol}/${scoredAparts.length}  largest ${largest}`,
  );
  return { kept, viol };
}

// Fixture-vector reference restricted to the same photo subset the device
// covered, so the two rows are directly comparable.
const fixtureSubset = new Map([...fixture].filter(([name]) => device.has(name)));
score(fixtureSubset, 'fixture vectors');
score(device, 'device vectors');
