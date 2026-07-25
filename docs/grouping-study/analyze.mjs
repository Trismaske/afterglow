// m0.8 grouping quality study — corpus analysis over real S23 dHashes.
// Inputs: s23-hashes.jsonl (id, ts, mt, u, h) + PhoneSync expected.json labels.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const DATA = new URL('data/', import.meta.url).pathname;
const PHONESYNC = '/home/tristan/PhoneSync';
const MIN3 = 3 * 60 * 1000;

// ---- load corpus ----------------------------------------------------------
const recs = readFileSync(join(DATA, 's23-hashes.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.h !== null);
recs.sort((a, b) => a.ts - b.ts);
const n = recs.length;
const hi = new Uint32Array(n), lo = new Uint32Array(n), ts = new Float64Array(n);
for (let i = 0; i < n; i++) {
  hi[i] = parseInt(recs[i].h.slice(0, 8), 16);
  lo[i] = parseInt(recs[i].h.slice(8, 16), 16);
  ts[i] = recs[i].ts;
}
const pop = (x) => { x -= (x >> 1) & 0x55555555; x = (x & 0x33333333) + ((x >> 2) & 0x33333333); x = (x + (x >> 4)) & 0x0f0f0f0f; return (x * 0x01010101) >> 24; };
const dist = (a, b) => pop((hi[a] ^ hi[b]) >>> 0) + pop((lo[a] ^ lo[b]) >>> 0);

// ---- curated labels -------------------------------------------------------
// basename -> corpus index, preferring DCIM/Camera originals over synced copies
const byName = new Map();
for (let i = 0; i < n; i++) {
  const name = basename(recs[i].u);
  const prev = byName.get(name);
  if (prev === undefined || (!recs[prev].u.includes('/DCIM/Camera/') && recs[i].u.includes('/DCIM/Camera/'))) byName.set(name, i);
}
const cases = [];
for (const dir of ["In Group But Shouldn't Be", 'Not In Group']) {
  for (const sub of readdirSync(join(PHONESYNC, dir))) {
    const f = join(PHONESYNC, dir, sub, 'expected.json');
    if (!existsSync(f)) continue;
    const exp = JSON.parse(readFileSync(f, 'utf8'));
    const groups = exp.groups.map((g) => g.map((name) => byName.get(name)).filter((i) => i !== undefined));
    cases.push({ name: `${dir === 'Not In Group' ? 'NIG' : 'BAD'}/${sub}`, kind: dir === 'Not In Group' ? 'recall' : 'precision', groups });
  }
}
// case pair sets
for (const c of cases) {
  c.within = []; c.cross = [];
  for (let gi = 0; gi < c.groups.length; gi++) {
    const g = c.groups[gi];
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) c.within.push([g[x], g[y]]);
    for (let gj = gi + 1; gj < c.groups.length; gj++) for (const a of g) for (const b of c.groups[gj]) c.cross.push([a, b]);
  }
}

// ---- A. per-case pair distances ------------------------------------------
console.log('== A. Curated-case pair distances (d, gap) ==');
const fmtGap = (ms) => ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : ms < 86400e3 ? `${(ms / 3600e3).toFixed(1)}h` : `${(ms / 86400e3).toFixed(1)}d`;
for (const c of cases) {
  const show = (pairs) => pairs.map(([a, b]) => `${dist(a, b)}@${fmtGap(Math.abs(ts[a] - ts[b]))}`).join(' ');
  console.log(`${c.name} [${c.kind}] within: ${show(c.within) || '-'} | cross: ${show(c.cross) || '-'}`);
}

// ---- B. histogram + edge extraction (one O(n^2) pass) ---------------------
const GAPS = [MIN3, 3600e3, 86400e3, 7 * 86400e3, Infinity];
const GAPL = ['<=3min', '3m-1h', '1h-24h', '1d-7d', '>7d'];
const DTH = [8, 10, 12, 16, 20, 26];
const histLink = Array.from(GAPS, () => new Float64Array(DTH.length));
const histTotal = new Float64Array(GAPS.length);
const eA = [], eB = [], eD = [];
console.error('pairwise pass...');
const t0 = Date.now();
for (let a = 0; a < n; a++) {
  for (let b = a + 1; b < n; b++) {
    const d = dist(a, b);
    const gap = ts[b] - ts[a];
    let gi = 0; while (gap > GAPS[gi]) gi++;
    histTotal[gi]++;
    if (d <= 26) {
      for (let k = 0; k < DTH.length; k++) if (d <= DTH[k]) histLink[gi][k]++;
      // store only sweep-relevant edges: far pairs matter up to t=20, near pairs up to 20+6
      if (d <= 20 || gap <= MIN3) { eA.push(a); eB.push(b); eD.push(d); }
    }
  }
}
console.error(`pass done in ${((Date.now() - t0) / 1000).toFixed(1)}s, edges<=26: ${eA.length}`);
console.log('\n== B. P(d<=T) by time gap (real corpus, n=' + n + ') ==');
console.log('gap        pairs        ' + DTH.map((d) => `<=${d}`.padStart(9)).join(''));
for (let gi = 0; gi < GAPS.length; gi++) {
  const row = DTH.map((_, k) => (100 * histLink[gi][k] / Math.max(1, histTotal[gi])).toFixed(4).padStart(8) + '%').join('');
  console.log(GAPL[gi].padEnd(10) + String(histTotal[gi]).padStart(12) + ' ' + row);
}

// ---- C. config sweep ------------------------------------------------------
class UF {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(i) { const p = this.p; while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[Math.max(ra, rb)] = Math.min(ra, rb); }
}
function runConfig({ threshold, windowMs, strict }) {
  const uf = new UF(n);
  for (let e = 0; e < eA.length; e++) {
    const a = eA[e], b = eB[e], d = eD[e];
    const gap = ts[b] - ts[a];
    const allowed = gap <= MIN3 ? threshold + 6 : threshold;
    if ((gap <= windowMs && d <= allowed) || (strict !== null && d <= strict)) uf.union(a, b);
  }
  const size = new Map();
  for (let i = 0; i < n; i++) { const r = uf.find(i); size.set(r, (size.get(r) ?? 0) + 1); }
  const sizes = [...size.values()].sort((x, y) => y - x);
  const multi = sizes.filter((s) => s >= 2).length;
  // curated satisfaction
  let recallOk = 0, recallTot = 0, precOk = 0, precTot = 0;
  const fails = [];
  for (const c of cases) {
    const withinOk = c.within.every(([a, b]) => uf.find(a) === uf.find(b));
    const crossOk = c.cross.every(([a, b]) => uf.find(a) !== uf.find(b));
    if (c.kind === 'recall') { recallTot++; if (withinOk) recallOk++; else fails.push(c.name); }
    else { precTot++; if (crossOk && withinOk) precOk++; else fails.push(c.name + (crossOk ? '(w)' : '(x)')); }
  }
  return { multi, top: sizes.slice(0, 3).join('/'), recall: `${recallOk}/${recallTot}`, prec: `${precOk}/${precTot}`, fails: fails.join(',') };
}
console.log('\n== C. Config sweep (timeBonus +6 bits within 3min kept everywhere) ==');
console.log('threshold  window  strict |  groups>=2  top-3 sizes | precision  recall | failing cases');
const WINS = [[3600e3, '1h'], [86400e3, '24h'], [3 * 86400e3, '72h'], [Infinity, 'inf']];
for (const threshold of [10, 12, 16, 20]) {
  for (const [windowMs, wl] of WINS) {
    for (const strict of [null, 8, 10]) {
      if (windowMs === Infinity && strict !== null) continue;
      const r = runConfig({ threshold, windowMs, strict });
      console.log(`t=${String(threshold).padEnd(7)} w=${wl.padEnd(5)} s=${String(strict ?? '-').padEnd(3)}| ${String(r.multi).padStart(9)}  ${r.top.padEnd(11)} | ${r.prec.padStart(9)}  ${r.recall.padStart(6)} | ${r.fails}`);
    }
  }
}
