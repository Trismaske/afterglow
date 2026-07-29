/**
 * Run the mobile UI gate on EVERY test device AT ONCE (m0.8.2 — running
 * the phones one after another doubled the release gate's wall clock).
 *
 *   node scripts/mobile-ui-gate-all.mjs [SERIAL...]
 *
 * No serials → every device `adb devices` reports. Each device gets its
 * own child gate process (the gate itself stays single-device), its own
 * report directory (`mobile-ui-gate-report/<serial>/`), and its output
 * lines prefixed with a short device tag so the interleaved log stays
 * readable. Exit code is non-zero when ANY device fails — same contract
 * as the single gate.
 */
import { execFileSync, spawn } from 'node:child_process';

const requested = process.argv.slice(2);

function connectedSerials() {
  const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('device'))
    .map((line) => line.split(/\s+/)[0]);
}

const serials = requested.length > 0 ? requested : connectedSerials();
if (serials.length === 0) {
  console.error('no devices — connect one or pass serials (see `adb devices`)');
  process.exit(2);
}

/** Short, readable tag: the serial's last chunk ("R5CW20KBA2W", or the
 * host part of a wireless mDNS name). */
const tagOf = (serial) => {
  const host = serial.split('.')[0];
  return host.length <= 14 ? host : host.slice(0, 14);
};

/** Filesystem-safe report subdirectory per device. */
const dirOf = (serial) => `mobile-ui-gate-report/${serial.replace(/[^A-Za-z0-9_-]+/g, '_')}`;

console.log(`Afterglow UI gate ×${serials.length}: ${serials.map(tagOf).join(' · ')}`);

const runs = serials.map(
  (serial) =>
    new Promise((resolve) => {
      const tag = tagOf(serial);
      const child = spawn(
        process.execPath,
        ['scripts/mobile-ui-gate.mjs', '--serial', serial, '--report-dir', dirOf(serial)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const forward = (stream) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) console.log(`[${tag}] ${line}`);
        });
        stream.on('end', () => {
          if (buffer.trim() !== '') console.log(`[${tag}] ${buffer}`);
        });
      };
      forward(child.stdout);
      forward(child.stderr);
      child.on('close', (code) => resolve({ serial, tag, code: code ?? 1 }));
      child.on('error', (error) => {
        console.log(`[${tag}] failed to spawn: ${String(error)}`);
        resolve({ serial, tag, code: 1 });
      });
    }),
);

const results = await Promise.all(runs);
console.log('\n== All devices ==');
for (const { serial, tag, code } of results) {
  console.log(` ${code === 0 ? 'PASS' : 'FAIL'}  ${tag}  (${serial}) → ${dirOf(serial)}/`);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
