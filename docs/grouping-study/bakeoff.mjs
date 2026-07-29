// Feature bake-off on curated cases: 64-bit (9x8) vs 256-bit (17x16) dHash.
// Per case, do within-group and cross-group distances separate?
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// luma grids are generated from the curated photos via ImageMagick (see git
// history of the study for the exact convert flags); regenerate into data/luma
const DATA = fileURLToPath(new URL('data/', import.meta.url));
const PHONESYNC = '/home/tristan/PhoneSync';

function readPgm(path) {
  const buf = readFileSync(path);
  // P5\n<w> <h>\n255\n or with comment lines
  let pos = 0; const tokens = [];
  while (tokens.length < 4) {
    let line = '';
    while (buf[pos] !== 10) line += String.fromCharCode(buf[pos++]);
    pos++;
    if (line.startsWith('#')) continue;
    tokens.push(...line.trim().split(/\s+/));
  }
  const w = parseInt(tokens[1]), h = parseInt(tokens[2]);
  return { w, h, data: buf.subarray(buf.length - w * h) };
}
function dhashBits(pgm) {
  const bits = [];
  for (let y = 0; y < pgm.h; y++)
    for (let x = 0; x < pgm.w - 1; x++)
      bits.push(pgm.data[y * pgm.w + x] < pgm.data[y * pgm.w + x + 1] ? 1 : 0);
  return bits;
}
const dist = (a, b) => a.reduce((s, v, i) => s + (v ^ b[i]), 0);

const hashes = new Map(); // name -> {h64, h256}
for (const f of readdirSync(join(DATA, 'luma'))) {
  if (f.endsWith('.small.pgm')) continue;
  const name = f.replace(/\.pgm$/, '.jpg');
  const h256 = dhashBits(readPgm(join(DATA, 'luma', f)));
  const h64 = dhashBits(readPgm(join(DATA, 'luma', f.replace(/\.pgm$/, '.small.pgm'))));
  hashes.set(name, { h64, h256 });
}

let sep64 = 0, sep256 = 0, tot = 0;
const rows = [];
for (const dir of ["In Group But Shouldn't Be", 'Not In Group']) {
  for (const sub of readdirSync(join(PHONESYNC, dir))) {
    const f = join(PHONESYNC, dir, sub, 'expected.json');
    if (!existsSync(f)) continue;
    const exp = JSON.parse(readFileSync(f, 'utf8'));
    const groups = exp.groups.map((g) => g.filter((n) => hashes.has(n)));
    const within = [], cross = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) within.push([g[x], g[y]]);
      for (let gj = gi + 1; gj < groups.length; gj++) for (const a of g) for (const b of groups[gj]) cross.push([a, b]);
    }
    if (within.length === 0 && cross.length === 0) continue;
    tot++;
    const d = (pairs, key) => pairs.map(([a, b]) => dist(hashes.get(a)[key], hashes.get(b)[key]));
    const w64 = d(within, 'h64'), c64 = d(cross, 'h64');
    const w256 = d(within, 'h256'), c256 = d(cross, 'h256');
    // separable = max(within) < min(cross): some threshold groups all within-pairs and no cross-pair
    const s64 = (w64.length ? Math.max(...w64) : -1) < (c64.length ? Math.min(...c64) : 65);
    const s256 = (w256.length ? Math.max(...w256) : -1) < (c256.length ? Math.min(...c256) : 257);
    if (s64) sep64++;
    if (s256) sep256++;
    const pct = (arr, n) => arr.map((v) => Math.round((100 * v) / n) + '%').join(',');
    rows.push(`${dir === 'Not In Group' ? 'NIG' : 'BAD'}/${sub}  64bit w:[${pct(w64, 64) || '-'}] c:[${pct(c64, 64) || '-'}] ${s64 ? 'SEP' : 'X'}   256bit w:[${pct(w256, 256) || '-'}] c:[${pct(c256, 256) || '-'}] ${s256 ? 'SEP' : 'X'}`);
  }
}
console.log('per-case distances as % of hash bits (w=must-link, c=must-not-link), SEP = a per-case separating threshold exists');
for (const r of rows.sort()) console.log(r);
console.log(`\ncases separable: 64-bit ${sep64}/${tot}, 256-bit ${sep256}/${tot}`);
