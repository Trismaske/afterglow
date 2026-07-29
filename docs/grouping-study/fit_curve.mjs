// Gate-1 fit harness: replays the CORE grouping engine (packages/core dist —
// build first) over the frozen labels-v1 fixtures and scores parameter
// variants, to fit the time-decay threshold curve and re-validate the
// adjacent-merge params (Plan_m0.8.md decision 8 / Gate 1). The chosen
// constants are hardcoded in packages/core/src/grouping.ts and pinned by
// test/grouping.test.ts; re-run this only when deliberately re-pinning.
//
// Usage: node fit_curve.mjs            (score the shipped defaults + sweeps)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groupByEmbedding } from '../../packages/core/dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const labels = JSON.parse(readFileSync(`${HERE}labels-v1.json`, 'utf8'));
const emb = JSON.parse(readFileSync(`${HERE}embeddings-labeled-v1.json`, 'utf8'));
if (labels.model.sha256 !== emb.model_sha256) throw new Error('fixture model SHA mismatch');

const vecs = new Map();
const items = [];
for (const [name, { ts, vec }] of Object.entries(emb.photos)) {
  // True copy (Uint8Array.prototype.slice, not Buffer's view-returning
  // slice) so the Float32Array view starts 4-byte aligned at offset 0.
  const raw = Uint8Array.prototype.slice.call(Buffer.from(vec, 'base64'));
  vecs.set(name, new Float32Array(raw.buffer));
  items.push({ id: name, timestamp: ts, uri: name, kind: 'photo' });
}
const vecOf = (id) => vecs.get(id) ?? null;

const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const deliberate = new Set(labels.deliberate_nontransitive_apart.map((p) => key(p.a, p.b)));
const links = labels.hard.filter((p) => p.rel === 'link');
const aparts = labels.hard.filter((p) => p.rel === 'apart' && !deliberate.has(key(p.a, p.b)));

function score(options, label) {
  const groups = groupByEmbedding(items, vecOf, undefined, options);
  const groupOf = new Map();
  groups.forEach((g, i) => g.items.forEach((item) => groupOf.set(item.id, i)));
  const together = (p) => groupOf.get(p.a) !== undefined && groupOf.get(p.a) === groupOf.get(p.b);
  const kept = links.filter(together).length;
  const viol = aparts.filter(together).length;
  const largest = Math.max(...groups.map((g) => g.items.length));
  const softTogether = labels.soft.filter(together).length;
  console.log(
    `${label.padEnd(58)} kept ${kept}/${links.length}  viol ${viol}/${aparts.length}  ` +
      `largest ${largest}  (soft together ${softTogether}/${labels.soft.length})`,
  );
  return { kept, viol, largest };
}

// Least-squares exponential fit A + B*exp(-g/tau) through the measured
// 90%-link floors by gap band (10th-percentile link cosine at band centers).
const anchors = [
  [5, 0.547],
  [20, 0.495],
  [60, 0.424],
];
let best = null;
for (let tau = 5; tau <= 120; tau += 0.5) {
  // linear least squares for A, B given tau
  const xs = anchors.map(([g]) => Math.exp(-g / tau));
  const ys = anchors.map(([, y]) => y);
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const B = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const A = (sy - B * sx) / n;
  const err = anchors.reduce((a, [g, y]) => a + (A + B * Math.exp(-g / tau) - y) ** 2, 0);
  if (!best || err < best.err) best = { tau, A, B, err };
}
console.log(
  `exponential floor fit: f(g) = ${best.A.toFixed(3)} + ${best.B.toFixed(3)}*exp(-g/${best.tau}s)` +
    `  (rms ${Math.sqrt(best.err / anchors.length).toFixed(4)})` +
    `  → floorFar ${best.A.toFixed(3)}, floorNear ${(best.A + best.B).toFixed(3)}, tau ${best.tau}s`,
);
console.log();

console.log('— time-decay curve (merge at initial params 0.55/0.70) —');
score({ bonusWindowMs: 0 }, 'flat 0.50, no bonus');
const fitted = {
  floorNear: best.A + best.B,
  floorFar: best.A,
  floorTauMs: best.tau * 1000,
};
score(fitted, `fitted curve (near/far/tau ${fitted.floorNear.toFixed(3)}/${fitted.floorFar.toFixed(3)}/${best.tau}s)`);
score({}, 'shipped defaults');

console.log('\n— adjacent-merge sweep (fitted curve) —');
score({ ...fitted, adjacentMergeMaxGapMs: 0 }, 'merge off');
for (const internal of [0.5, 0.55, 0.6]) {
  for (const centroid of [0.65, 0.7, 0.75]) {
    score(
      { ...fitted, adjacentMergeMinInternal: internal, adjacentMergeMinCentroid: centroid },
      `merge internal ${internal} centroid ${centroid}`,
    );
  }
}

console.log('\n— bonus-window sanity (fitted curve, merge 0.55/0.70) —');
for (const windowMs of [30_000, 60_000, 120_000, 180_000]) {
  score({ ...fitted, bonusWindowMs: windowMs }, `bonus window ${windowMs / 1000}s`);
}
