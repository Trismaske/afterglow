// Phase-10 replay harness (m0.9): the built core engine over a device's
// own vectors, scored against Tristan's judged partitions.
//
//   node docs/grouping-study/replay_device.mjs data/s10e-device.jsonl data/device-labels-round1.json
//
// For every judged card the engine runs over the card's maximal merge
// window (bursts and adjacent bursts form as on the phone), once per
// variant, and is scored at two levels: GROUP (membership: a must pair
// shares a group, a cannot pair does not) and PART (the unit the deck
// shows contiguous: a must pair shares a part). A card is satisfied when
// every pair agrees; pair agreement is the partial credit. Round 1
// judged groups, round 2 judged partitions, so read round 1 at the
// group level and round 2 at the part level. The 'current' variant is
// the sanity line: it must reproduce the device's grouping on round 1's
// correct cards. The whole-library line counts groups and large groups
// per variant so a candidate's churn is visible.
import { readFileSync } from 'node:fs';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding } from '../../packages/core/dist/index.js';

// Usage: replay_device.mjs <device.jsonl> <labels.json>... [--sweep]
// Several label files score together (round 1's constraints beside
// round 2's); --sweep adds the sub-group grid to the variants.
const argv = process.argv.slice(2);
const sweep = argv.includes('--sweep');
const [rowsPath, ...labelPaths] = argv.filter((a) => a !== '--sweep');
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const labels = labelPaths.flatMap((p, i) =>
  JSON.parse(readFileSync(p, 'utf8')).cards.map((c) => ({ ...c, round: i + 1 })),
);
const WINDOW_MS = ADJACENT_MERGE_MAX_GAP_MS;

const byId = new Map();
for (const r of rows) {
  const buf = Buffer.from(r.vec, 'base64');
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  byId.set(r.id, { ...r, vec });
}
const byUri = new Map(rows.map((r) => [r.uri, r.id]));
const sortedRows = [...rows].sort((a, b) => a.ts - b.ts);

// The shipped defaults are the 60-minute window with the far bar; the
// window-only variants disable the bar by pushing its gap to the
// window's edge, so the plan's comparison (widening alone vs with the
// bar) stays reproducible.
const MIN = 60_000;
const noFar = (gapMs) => ({ adjacentMergeMaxGapMs: gapMs, farMergeGapMs: gapMs });
const VARIANTS = {
  current: {},
  'gap15 (the pre-phase-10 window)': noFar(15 * MIN),
  'gap30 alone': noFar(30 * MIN),
  'gap60 alone': noFar(60 * MIN),
  'gap30+far≥0.85': { adjacentMergeMaxGapMs: 30 * MIN },
  'gap60+far≥0.88': { farMergeMinBestPair: 0.88 },
};

function run(items, options) {
  const groups = groupByEmbedding(
    items.map((r) => ({ id: r.id, timestamp: r.ts, uri: r.uri, kind: r.kind })),
    (id) => byId.get(id)?.vec ?? null,
    (id) => byId.get(id)?.hash ?? null,
    options,
  );
  const groupOf = new Map();
  const partOf = new Map();
  groups.forEach((g, gi) => {
    g.items.forEach((it) => groupOf.set(it.id, gi));
    g.parts.forEach((part, pi) => part.forEach((id) => partOf.set(id, `${gi}/${pi}`)));
  });
  return { groups, groupOf, partOf };
}

// The card's MAXIMAL merge window (codex): the chain of consecutive
// rows with gaps within the merge window that contains the card's members —
// what the scan accumulator hands the engine.
function windowItems(memberIds, gapMs = WINDOW_MS) {
  const ts = memberIds.map((id) => byId.get(id).ts);
  let lo = sortedRows.findIndex((r) => r.ts >= Math.min(...ts));
  let hi = sortedRows.findIndex((r) => r.ts > Math.max(...ts));
  if (hi === -1) hi = sortedRows.length;
  hi -= 1;
  while (lo > 0 && sortedRows[lo].ts - sortedRows[lo - 1].ts <= gapMs) lo--;
  while (hi < sortedRows.length - 1 && sortedRows[hi + 1].ts - sortedRows[hi].ts <= gapMs) hi++;
  return sortedRows.slice(lo, hi + 1);
}

const classes = (c) => `r${c.round} ${c.type ?? c.kind}/${c.verdict}`;
if (sweep) {
  for (const minSize of [2, 3, 4, 6, 8, 12]) {
    for (const t of ['relative', 0.62, 0.65]) {
      VARIANTS[`parts(${minSize},${t})`] = { subgroupMinSize: minSize, subgroupThreshold: t };
    }
  }
}
const LEVELS = ['group', 'part'];
const results = { group: {}, part: {} };
const flips = { group: {}, part: {} };
for (const [name, options] of Object.entries(VARIANTS)) {
  for (const level of LEVELS) {
    results[level][name] = {};
    flips[level][name] = {};
  }
  for (const card of labels) {
    const ids = card.members.map((u) => byUri.get(u)).filter(Boolean);
    if (ids.length !== card.members.length) continue;
    const { groupOf, partOf } = run(windowItems(ids, options.adjacentMergeMaxGapMs ?? WINDOW_MS), options);
    for (const level of LEVELS) {
      const unitOf = level === 'group' ? groupOf : partOf;
      const same = (a, b) => unitOf.get(byUri.get(a)) === unitOf.get(byUri.get(b));
      const mustOk = card.must.filter(([a, b]) => same(a, b)).length;
      const cannotOk = card.cannot.filter(([a, b]) => !same(a, b)).length;
      const pairs = card.must.length + card.cannot.length;
      const ok = mustOk === card.must.length && cannotOk === card.cannot.length;
      const k = classes(card);
      const tally = results[level][name];
      tally[k] ??= { ok: 0, n: 0, agree: 0 };
      tally[k].n++;
      if (ok) tally[k].ok++;
      tally[k].agree += pairs ? (mustOk + cannotOk) / pairs : 1;
      flips[level][name][`r${card.round}#${card.card}`] = ok;
    }
  }
}

const keys = [...new Set(labels.map(classes))];
for (const level of LEVELS) {
  console.log(`\n${level.toUpperCase()} level — cards satisfied (ok/n) · mean pair agreement %`);
  console.log(''.padEnd(22) + keys.map((k) => k.padStart(26)).join(''));
  for (const [name, tally] of Object.entries(results[level])) {
    console.log(
      name.padEnd(22) +
        keys
          .map((k) => {
            const c = tally[k];
            return c ? `${c.ok}/${c.n} · ${Math.round((100 * c.agree) / c.n)}%` : '-';
          })
          .map((x) => x.padStart(26))
          .join(''),
    );
  }
}

console.log('\nwhole library (4 943 vectors): groups ≥2 · groups ≥12 · largest');
for (const [name, options] of Object.entries(VARIANTS)) {
  const { groups } = run(sortedRows, options);
  const multi = groups.filter((g) => g.items.length >= 2);
  const big = multi.filter((g) => g.items.length >= 12);
  const largest = Math.max(...groups.map((g) => g.items.length));
  console.log(`${name.padEnd(46)} ${String(multi.length).padStart(5)} ${String(big.length).padStart(5)} ${String(largest).padStart(6)}`);
}

for (const level of LEVELS) {
  const base = flips[level].current;
  for (const name of Object.keys(VARIANTS)) {
    if (name === 'current') continue;
    const f = flips[level][name];
    const gained = Object.keys(f).filter((c) => f[c] && !base[c]);
    const lost = Object.keys(f).filter((c) => !f[c] && base[c]);
    console.log(`${level} ${name}: gained cards ${gained.join(',') || '-'} · lost cards ${lost.join(',') || '-'}`);
  }
}
