// The CI dependency-audit gate: `npm audit` at high severity, with a
// SELF-PRUNING allowlist for advisories that are out of our hands
// (transitive pins owned by a direct dependency, no fix available
// without breaking its version contract).
//
// The gate fails in BOTH directions:
// - any high/critical advisory NOT on the allowlist fails the build
//   (unchanged strictness), and
// - any allowlisted advisory that NO LONGER fires at high/critical
//   fails the build with "stale entry — remove it", so the list is
//   structurally unable to grow stale: upstream fixing the advisory
//   turns into a one-line deletion on the next push.
//
// Every entry must name its reason and its removal condition.
import { execSync } from 'node:child_process';

const ALLOW = [
  {
    id: 'GHSA-w3rx-r6r6-pgpr',
    pkg: 'image-size',
    reason:
      'DoS via infinite loop in the ICNS parser. BUILD-TIME ONLY: image-size parses our own assets during Metro bundling; nothing ships in the APK.',
    removeWhen:
      'Expo bumps metro to >=0.85 (metro 0.84.5, pinned by Expo SDK 57, requires image-size ^1.x; the fix is in the 2.x major).',
  },
  {
    id: 'GHSA-5p2g-fcmc-qvqq',
    pkg: 'image-size',
    reason:
      'DoS via infinite loops in the JXL/HEIF parsers. Same build-time-only exposure as its sibling entry.',
    removeWhen: 'Same metro >=0.85 condition as its sibling entry.',
  },
];

let report;
try {
  report = JSON.parse(
    execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
} catch (error) {
  // npm audit exits non-zero when vulnerabilities exist — the JSON on
  // stdout is still the report. Anything unparseable is a real failure.
  if (!error.stdout) throw error;
  report = JSON.parse(error.stdout.toString());
}
if (typeof report?.auditReportVersion !== 'number' || typeof report?.vulnerabilities !== 'object') {
  // A broken audit (missing lockfile, registry failure) must never
  // read as "clean" — fail closed on anything that is not a report.
  console.error(
    'audit-gate: npm audit did not produce a report:',
    JSON.stringify(report).slice(0, 300),
  );
  process.exit(1);
}

// Collect the GHSA ids of every advisory currently firing at >= high.
const firing = new Set();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue;
    const match = /GHSA-[a-z0-9-]+/.exec(via.url);
    if (match) firing.add(match[0]);
  }
}

const allowed = new Set(ALLOW.map((entry) => entry.id));
const unexpected = [...firing].filter((id) => !allowed.has(id));
const stale = ALLOW.filter((entry) => !firing.has(entry.id));

if (unexpected.length > 0) {
  console.error('audit-gate: high/critical advisories NOT on the allowlist:');
  for (const id of unexpected) console.error(`  https://github.com/advisories/${id}`);
  console.error(
    'Fix them (npm audit fix / upstream bump), or allowlist them here WITH a reason and removal condition.',
  );
  process.exit(1);
}
if (stale.length > 0) {
  console.error(
    'audit-gate: STALE allowlist entries — the advisory no longer fires at high/critical. Remove them:',
  );
  for (const entry of stale)
    console.error(`  ${entry.id} (${entry.pkg}) — removal condition was: ${entry.removeWhen}`);
  process.exit(1);
}
console.log(
  `audit-gate: clean — no unallowed high/critical advisories (${ALLOW.length} allowlisted, all still firing, each with a removal condition).`,
);
