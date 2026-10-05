// Phase-10 round 3b (m0.9): the shipped parts rule's proposals for a
// judged round, as JSON for sheet_device2.py.
//
//   node docs/grouping-study/parts_proposals.mjs <device.jsonl> <round2-manifest.json> <round1-manifest.json> <round1-verdicts.json> <out.json>
//
// Cards: every round-2 group card (the split cards and the large groups,
// re-proposed by the engine's own parts pass — core grouping.ts step 5,
// average linkage at the group-relative bar) plus up to 20 round-1 groups
// judged "ok" with three or more members, to learn whether parts are
// wanted where the group itself was fine. Each card is the engine's
// group over the card's maximal merge window (what the phone forms),
// so a membership that moved since the earlier round is shown as it
// stands now, with the earlier card number kept for cross-reference.
import { readFileSync, writeFileSync } from 'node:fs';
import { ADJACENT_MERGE_MAX_GAP_MS, groupByEmbedding } from '../../packages/core/dist/index.js';

const [rowsPath, round2Path, round1Path, verdicts1Path, outPath] = process.argv.slice(2);
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const round2 = JSON.parse(readFileSync(round2Path, 'utf8'));
const round1 = JSON.parse(readFileSync(round1Path, 'utf8'));
const verdicts1 = JSON.parse(readFileSync(verdicts1Path, 'utf8'));
const byId = new Map();
for (const r of rows) {
  const buf = Buffer.from(r.vec, 'base64');
  byId.set(r.id, { ...r, vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
}
const byUri = new Map(rows.map((r) => [r.uri, r.id]));
const sortedRows = [...rows].sort((a, b) => a.ts - b.ts);
const WINDOW_MS = ADJACENT_MERGE_MAX_GAP_MS;

function windowItems(ids) {
  const ts = ids.map((id) => byId.get(id).ts);
  let lo = sortedRows.findIndex((r) => r.ts >= Math.min(...ts));
  let hi = sortedRows.findIndex((r) => r.ts > Math.max(...ts));
  if (hi === -1) hi = sortedRows.length;
  hi -= 1;
  while (lo > 0 && sortedRows[lo].ts - sortedRows[lo - 1].ts <= WINDOW_MS) lo--;
  while (hi < sortedRows.length - 1 && sortedRows[hi + 1].ts - sortedRows[hi].ts <= WINDOW_MS) hi++;
  return sortedRows.slice(lo, hi + 1);
}

/** The engine's group holding most of `memberUris`, with its parts. */
function propose(memberUris) {
  const ids = memberUris.map((u) => byUri.get(u)).filter(Boolean);
  if (ids.length !== memberUris.length) return null;
  const groups = groupByEmbedding(
    windowItems(ids).map((r) => ({ id: r.id, timestamp: r.ts, uri: r.uri, kind: r.kind })),
    (id) => byId.get(id)?.vec ?? null,
    (id) => byId.get(id)?.hash ?? null,
  );
  const wanted = new Set(ids);
  let best = null;
  for (const g of groups) {
    const overlap = g.items.filter((it) => wanted.has(it.id)).length;
    if (overlap > 0 && (best === null || overlap > best.overlap)) best = { g, overlap };
  }
  if (best === null) return null;
  const uriOf = (id) => byId.get(id).uri;
  return {
    members: best.g.items.map((it) => uriOf(it.id)),
    parts: best.g.parts.map((part) => part.map(uriOf)),
    moved: best.overlap !== memberUris.length || best.g.items.length !== memberUris.length,
  };
}

const cards = [];
const seen = new Set();
for (const c of round2) {
  if (c.kind === 'exclusion') continue;
  const p = propose(c.members);
  if (p === null) continue;
  const key = p.members.join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  cards.push({ kind: c.kind, card: c.id, group_id: c.group_id, round: 2, ...p });
}
// Round-1 "ok" groups of three or more, in manifest order (the weakest
// first, then random), skipping any already above.
let okAdded = 0;
for (const [n, c] of round1.entries()) {
  if (okAdded >= 20) break;
  if (c.type !== 'group' || verdicts1[String(n)]?.v !== 'ok' || c.members.length < 3) continue;
  const p = propose(c.members);
  if (p === null) continue;
  const key = p.members.join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  cards.push({ kind: 'ok-group', card: n, group_id: c.group_id, round: 1, ...p });
  okAdded++;
}
const out = { threshold: 'relative', cards };
writeFileSync(outPath, JSON.stringify(out, null, 1));
const multi = cards.filter((c) => c.parts.length > 1).length;
console.log(
  `${cards.length} cards (${cards.filter((c) => c.round === 2).length} from round 2, ${okAdded} round-1 ok groups); ${multi} proposed with parts, ${cards.filter((c) => c.moved).length} with membership moved since their round → ${outPath}`,
);
