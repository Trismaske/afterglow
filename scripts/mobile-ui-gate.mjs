#!/usr/bin/env node
/**
 * Afterglow Companion pre-release UI gate: drives the INSTALLED app on a
 * connected Android device or emulator over plain adb (no extra tools)
 * and walks every main surface and interaction, asserting presence AND
 * that no action gets stuck busy. Run it before tagging a mobile
 * release, after installing the release APK on a test target with a
 * photo corpus.
 *
 *   node scripts/mobile-ui-gate.mjs [--serial SERIAL] [--report-dir DIR]
 *
 * ⚠️ The gate makes REAL review decisions (it keeps/culls/flags photos
 * and queues favourite/share intents) — run it on a test device or a
 * seeded emulator, never on a phone whose review state matters.
 *
 * Mechanism: UI state is read with `uiautomator dump` and elements are
 * located by their visible text (resolution-independent). IMPORTANT:
 * uiautomator waits for UI idle, so one dump can take 5-10 s while the
 * scan animates the Home card — wall-clock is therefore NOT a fair
 * responsiveness metric here. Presence checks get generous timeouts;
 * the stuck-busy regression signal (the m0.8 multi-second "Saving…"
 * class) is waitGone: a dump captured AFTER the deadline that still
 * shows the busy label fails, however long dumps take — and a label
 * long gone passes regardless of dump latency. Frame-level latency
 * stays a manual pass (screenrecord + per-frame analysis, see
 * docs/MOBILE_UI_GATE.md).
 *
 * Every step records PASS/FAIL (+ ms). Failures capture a screenshot
 * into the report dir, which is cleared of prior screenshots at startup
 * so it always shows exactly one run. Exit code 1 when anything failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_ID = 'com.afterglow.companion';
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const REPORT_DIR = argOf('--report-dir') ?? 'mobile-ui-gate-report';
mkdirSync(REPORT_DIR, { recursive: true });
// Clear this run's slate: screenshots are named fail-<step index>-<step
// name>, so a file left by an earlier run survives a green run and reads
// as a current failure. Only our own fail-*.png are removed — --report-dir
// is caller-supplied, so a blanket recursive wipe is not ours to make.
for (const entry of readdirSync(REPORT_DIR))
  if (/^fail-.*\.png$/.test(entry)) rmSync(join(REPORT_DIR, entry));

// ---------------------------------------------------------------- adb
function adbRaw(list, opts = {}) {
  return execFileSync('adb', list, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
const SERIAL =
  argOf('--serial') ??
  (() => {
    const lines = adbRaw(['devices'])
      .split('\n')
      .slice(1)
      .filter((l) => l.trim().endsWith('device'));
    if (lines.length === 0) throw new Error('no adb device connected');
    if (lines.length > 1)
      throw new Error('multiple devices connected — pass --serial (see `adb devices`)');
    return lines[0].split('\t')[0];
  })();
const adb = (...a) => adbRaw(['-s', SERIAL, ...a]);
const shell = (cmd) => adb('shell', cmd);

// ------------------------------------------------------------- ui dump
/** Parse `uiautomator dump` XML into flat nodes (regex — no deps). */
function dumpUi() {
  // Delete first: a dump that fails to reach UI idle writes NOTHING,
  // and reading the previous file back would poison every wait with
  // stale state (observed: the gate "stuck" on a tab it had left).
  shell(
    'rm -f /sdcard/ag-ui-gate.xml; uiautomator dump /sdcard/ag-ui-gate.xml >/dev/null 2>&1 || true',
  );
  let xml = '';
  try {
    xml = adb('exec-out', 'cat', '/sdcard/ag-ui-gate.xml');
  } catch {
    return []; // dump failed (busy UI) — caller polls again
  }
  const nodes = [];
  for (const tag of xml.match(/<node[^>]*>/g) ?? []) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : '';
    };
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    // Detached (inactive-tab) screens leave ghost nodes with zero-area
    // bounds in the dump; matching one sends taps to (0,0).
    if (Number(b[3]) <= Number(b[1]) || Number(b[4]) <= Number(b[2])) continue;
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      enabled: attr('enabled') === 'true',
      x: (Number(b[1]) + Number(b[3])) / 2,
      y: (Number(b[2]) + Number(b[4])) / 2,
      x1: Number(b[1]),
    });
  }
  return nodes;
}

let cachedSize = null;
/** Physical screen size, cached — the gate runs on phones of two sizes. */
function screenSize() {
  if (cachedSize) return cachedSize;
  const out = shell('wm size');
  const m = out.match(/(\d+)x(\d+)/);
  cachedSize = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2280 };
  return cachedSize;
}

const matches = (node, re) => re.test(node.text) || re.test(node.desc);
const findNode = (nodes, re) => nodes.find((n) => matches(n, re));

/** Scroll the current page down one screenful. */
function scrollDown() {
  shell('input swipe 540 1700 540 600 300');
}

/** Scroll the current page up one screenful. */
function scrollUp() {
  shell('input swipe 540 600 540 1700 300');
}

/** Wait for Home, scrolling BACK UP to find it.
 *
 * "Daily goal" is Home's first card, so several steps use it to mean "we
 * are on Home" — matched as a PREFIX, because the card renames itself to
 * "Daily goal reached 🎉" once today's count passes the goal, and this
 * walk makes ~50 decisions of its own. Anchored exactly, the gate stopped
 * recognising Home the moment its own reviewing crossed the S23's goal of
 * 53, and every later step timed out on a perfectly healthy screen.
 *
 * The other half: the gate itself scrolls Home down to reach the
 * Progress row, and on a phone with many day cards Home stays where it
 * was left. The card is then merely off-screen, and every later step
 * inherits the misreading: the deck step concluded "no unreviewed photos
 * on target" on an S10e whose Home was showing "27 to review" one
 * screenful below (2026-08-04). Being on Home and being at the TOP of
 * Home are different claims; this asserts the first by restoring the
 * second. */
async function waitForHome(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (let scrolls = 0; ; scrolls += 1) {
    const nodes = dumpUi();
    if (nodes.length > 0 && findNode(nodes, /^Daily goal/)) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the top of Home');
    // Scroll unconditionally rather than testing "are we on Home first?":
    // Home's own "Afterglow" title scrolls away with its content, so the
    // obvious marker is absent in exactly the case this exists to fix.
    // A scroll on some other screen is harmless — the deadline still
    // reports the real failure, that Home never appeared.
    if (scrolls < 8) scrollUp();
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Swipe the deck's pager one photo to the left, in DEVICE coordinates
 * (the two test phones differ by 1080 vs 1440 wide). */
function swipeDeckLeft() {
  const { width, height } = screenSize();
  const y = Math.round(height * 0.38); // inside the photo stage
  shell(`input swipe ${Math.round(width * 0.8)} ${y} ${Math.round(width * 0.12)} ${y} 250`);
}

/** Swipe the deck's pager one photo back to the right. */
function swipeDeckRight() {
  const { width, height } = screenSize();
  const y = Math.round(height * 0.38);
  shell(`input swipe ${Math.round(width * 0.12)} ${y} ${Math.round(width * 0.8)} ${y} 250`);
}

/** Double-tap the middle of the photo stage.
 *
 * Two separate `adb shell input tap` calls land ~500 ms apart — past the
 * app's 300 ms DOUBLE_TAP_MS window, so they read as two single taps and
 * nothing zooms (measured on the API 30 emulator). The two `input`
 * processes are therefore started TOGETHER on the device, the second
 * delayed by a fraction of the window, so the gap is the sleep rather
 * than two JVM start-ups. */
function doubleTapStage() {
  const { width, height } = screenSize();
  const x = Math.round(width / 2);
  const y = Math.round(height * 0.38);
  shell(`input tap ${x} ${y} & (sleep 0.12; input tap ${x} ${y}); wait`);
}

/** The deck/viewer pager position as [current, total], or null when no
 * indicator is on screen. */
function pagerPosition(nodes = dumpUi()) {
  const node = findNode(nodes, /^\d+\/\d+$/);
  if (!node) return null;
  const [pos, total] = node.text.split('/').map(Number);
  return [pos, total];
}

/** Poll until a node matching `re` appears; returns { node, ms }. */
async function waitFor(re, timeoutMs, label = String(re)) {
  const start = Date.now();
  // At least two inspections before declaring a timeout — a single
  // idle-blocked dump can outlast any reasonable deadline on its own.
  for (let attempts = 0; ; attempts += 1) {
    const node = findNode(dumpUi(), re);
    if (node) return { node, ms: Date.now() - start };
    if (attempts >= 1 && Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Poll until NO node matches `re` (e.g. a stuck "Saving…" label).
 * Only a SUCCESSFUL dump counts as evidence of absence — a failed dump
 * returns [] and once made waitGone declare a still-open sheet "gone"
 * (the next tap then hit its backdrop). */
async function waitGone(re, timeoutMs, label = String(re)) {
  const start = Date.now();
  for (;;) {
    const nodes = dumpUi();
    if (nodes.length > 0 && !findNode(nodes, re)) return { ms: Date.now() - start };
    if (Date.now() - start > timeoutMs) throw new Error(`${label} still visible`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const tap = (node) => shell(`input tap ${Math.round(node.x)} ${Math.round(node.y)}`);
async function tapText(re, timeoutMs = 20000) {
  const { node } = await waitFor(re, timeoutMs);
  tap(node);
}

// ------------------------------------------------------------- results
/**
 * A phone in real use interrupts: an update prompt, an incoming call, a
 * notification tapped by nobody. When another app takes the foreground
 * mid-walk, every following assertion fails against ITS screen — and the
 * messages lie ("no unreviewed photos on target" on a phone with
 * thousands waiting). Detect the theft, name the thief, and put us back.
 */
function foregroundPackage() {
  const focus = shell('dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp" | head -2');
  const match = /([A-Za-z][\w.]+)\/[\w.]+/.exec(focus);
  return match ? match[1] : null;
}

/** Media apps on the test phones can leave a picture-in-picture window
 * floating over the title-row icons — it steals taps WITHOUT taking the
 * foreground (device-observed: a YouTube PiP over the Stats icon failed
 * four steps). Dismiss every known PiP-capable offender outright:
 * force-stopping a package that is not installed or not running is
 * harmless (`|| true`), so the list errs wide. */
function dismissPipOverlays() {
  for (const pkg of [
    'com.google.android.youtube',
    'com.android.chrome',
    'com.sec.android.app.sbrowser', // Samsung Internet
    'org.videolan.vlc',
    'com.netflix.mediaclient',
    'com.google.android.apps.tachyon', // Google Meet
    'com.mxtech.videoplayer.ad', // MX Player
  ]) {
    shell(`am force-stop ${pkg} 2>/dev/null || true`);
  }
}

async function ensureForeground() {
  const front = foregroundPackage();
  if (front === null || front === APP_ID) return;
  console.warn(`  … ${front} took the foreground; returning to Afterglow`);
  dismissPipOverlays();
  shell(`am start -n ${APP_ID}/.MainActivity >/dev/null`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (foregroundPackage() === APP_ID) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${front} holds the foreground — Afterglow would not come back`);
}

const results = [];
let failures = 0;
async function step(name, budgetMs, fn) {
  let start = Date.now();
  try {
    // A PiP window steals taps WITHOUT taking the foreground, so
    // ensureForeground alone can never see one that appeared mid-run —
    // clear the known offenders before every step's first tap.
    dismissPipOverlays();
    await ensureForeground();
    // Recovering from an interruption is not part of the step's latency
    // budget — those budgets are responsiveness claims about the app.
    start = Date.now();
    await fn();
    const ms = Date.now() - start;
    const over = budgetMs !== null && ms > budgetMs;
    results.push({ name, ok: !over, ms, note: over ? `over ${budgetMs} ms budget` : '' });
    if (over) failures += 1;
  } catch (error) {
    const ms = Date.now() - start;
    results.push({ name, ok: false, ms, note: String(error.message ?? error) });
    failures += 1;
    const shot = join(REPORT_DIR, `fail-${results.length}-${name.replace(/\W+/g, '_')}.png`);
    try {
      writeFileSync(
        shot,
        adbRaw(['-s', SERIAL, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' }),
      );
      console.error(`  FAIL ${name}: ${error.message} (screenshot: ${shot})`);
    } catch {
      console.error(`  FAIL ${name}: ${error.message}`);
    }
  }
}

const badgeOf = (nodes, label) => {
  // Custom-bar badges render as a small numeric Text near the tab icon;
  // uiautomator has no hierarchy here, so take the numeric node closest
  // to the label's x. Anchor on text OR content-desc: some devices
  // (S10e) intermittently report the label Text with zero bounds, but
  // the item Pressable's content-desc always has real bounds.
  const anchor = nodes.find((n) => n.text === label || n.desc === label);
  if (!anchor) return 0;
  const numeric = nodes.filter((n) => /^\d+$/.test(n.text) && Math.abs(n.y - anchor.y) < 200);
  numeric.sort((a, b) => Math.abs(a.x - anchor.x) - Math.abs(b.x - anchor.x));
  return numeric.length > 0 && Math.abs(numeric[0].x - anchor.x) < 150
    ? Number(numeric[0].text)
    : 0;
};

/** True when a dump actually shows the given tab (text or content-desc).
 * badgeOf silently reads 0 without this anchor, so every badge read must
 * first prove the anchor is present — a failed/partial dump otherwise
 * satisfies badge assertions with synthetic zeroes. */
const hasTab = (nodes, label) => nodes.some((n) => n.text === label || n.desc === label);

// ------------------------------------------------------------ the walk
console.log(`Afterglow UI gate → ${SERIAL}`);
shell(`am force-stop ${APP_ID}`);
// Unconditional: a PiP overlay never shows up in the foreground check.
dismissPipOverlays();
shell('input keyevent KEYCODE_WAKEUP');
shell('wm dismiss-keyguard 2>/dev/null || true');
shell(`am start -n ${APP_ID}/.MainActivity >/dev/null`);

await step('home renders (goal card)', 20000, () => waitFor(/^Daily goal/, 20000));
// Give the startup refresh a moment so queue-dependent steps see truth.
await new Promise((r) => setTimeout(r, 3000));

let home = dumpUi();
await step('home queue copy (to review / everything reviewed)', null, async () => {
  // The card legitimately shows "Loading your queue…" until the first
  // queue read commits (~7 s on the 27k device) — wait it out.
  await waitFor(/to review|Everything reviewed/, 30000, 'queue copy');
  home = dumpUi();
});
await step('home library totals line', null, async () => {
  // Round 4: the card states the corpus total; the scan line below the
  // CTA exists only WHILE a scan runs (or after one failed), so it is
  // not an unconditional assertion any more.
  if (!findNode(home, /pictures? total/)) throw new Error('totals line missing');
});
await step('tab order Edit · Favourite · HOME · Organize · Share', null, async () => {
  // Poll: right after launch a dump can land before the bar lays out.
  const deadline = Date.now() + 20000;
  for (;;) {
    const nodes = dumpUi();
    const labels = ['Edit', 'Favourite', 'Organize', 'Share'].map((t) =>
      nodes.find((n) => n.text === t || n.desc === t),
    );
    const homeBtn = findNode(nodes, /^Home$/);
    if (labels.every(Boolean) && homeBtn) {
      const xs = labels.map((n) => n.x);
      if (!(xs[0] < xs[1] && xs[1] < homeBtn.x && homeBtn.x < xs[2] && xs[2] < xs[3]))
        throw new Error(`bad order: ${xs.join(',')} home=${homeBtn.x}`);
      home = nodes;
      return;
    }
    if (Date.now() > deadline) throw new Error('bar labels/home button missing');
    await new Promise((r) => setTimeout(r, 500));
  }
});

// Every tab opens fast and carries its heading (the "am I lost?" fix).
for (const [label, heading] of [
  ['Edit', /^Edit queue$/],
  ['Favourite', /^Favourite queue$/],
  ['Organize', /^Organize queue$/],
  ['Share', /^Share queue$/],
]) {
  await step(`tab ${label} opens with heading`, null, async () => {
    await tapText(new RegExp(`^${label}$`), 20000);
    await waitFor(heading, 20000, `${label} heading`);
  });
}
await step('home button returns home', null, async () => {
  await tapText(/^Home$/, 20000);
  await waitForHome();
});

// Stats (m0.8.2): three tabs, opening on Activity. Each tab loads its own
// query set on first open, so each has to be walked — a tab that only
// ever renders when another one loaded first is exactly the regression
// the lazy loading could introduce.
await step('stats page opens on the Activity tab', null, async () => {
  await tapText(/^Stats$/, 20000);
  await waitFor(/^Last 30 days$/, 20000, 'stats activity card');
  // The intake chart is the LAST card on the tab, so it needs scrolling
  // to: an accessibility dump only carries what is laid out.
  for (let i = 0; i < 4; i += 1) {
    if (findNode(dumpUi(), /^Shooting vs reviewing$/)) return;
    scrollDown();
    await new Promise((r) => setTimeout(r, 600));
  }
  await waitFor(/^Shooting vs reviewing$/, 8000, 'intake vs review card');
});
await step('stats Forecast tab loads its own numbers', null, async () => {
  await tapText(/^Forecast$/, 20000);
  // Either a finish line or an explicit refusal — never a blank card.
  await waitFor(/^Finish line$/, 20000, 'forecast card');
});
await step('stats Habits tab loads its own numbers', null, async () => {
  await tapText(/^Habits$/, 20000);
  await waitFor(/^Rhythm$/, 20000, 'rhythm card');
  // m0.8.2 terminology: the card is "Queues" ("waiting" → "queued").
  await waitFor(/^Queues$/, 20000, 'queue turnaround rows');
});
await step('stats returns to Home', null, async () => {
  shell('input keyevent KEYCODE_BACK');
  await waitForHome();
});

// Progress (m0.8.2 redesign): the chips are the bar's legend and the grid
// is the point of the page, so both must be on screen without scrolling
// past a state card that used to eat the first screenful.
await step('progress page opens with both chip rows', null, async () => {
  // Tap on POSITIVE EVIDENCE (the cull step's rule): the Progress row
  // sits at the tab bar's edge on the shorter phone, where a tap can be
  // eaten with nothing to show for it, and its title Text shares the
  // S10e's intermittent zero-bounds quirk (see badgeOf) — so anchor on
  // the title OR its subtitle, re-tap until the chip row appears, and
  // scroll the row clear of the bar when two taps in a row do nothing
  // (device-observed: one eaten tap failed this step with Home still on
  // screen).
  const deadline = Date.now() + 30000;
  let taps = 0;
  for (;;) {
    const nodes = dumpUi();
    if (nodes.length > 0 && findNode(nodes, /^Unreviewed$/)) break;
    const anchor =
      nodes.length > 0
        ? (findNode(nodes, /^Progress$/) ??
          findNode(nodes, / left · | at this pace$|^All photos · state browsing$/))
        : null;
    if (anchor) {
      if (taps >= 2) {
        scrollDown();
        await new Promise((r) => setTimeout(r, 800));
        taps = 0;
        continue;
      }
      tap(anchor);
      taps += 1;
    }
    if (Date.now() > deadline)
      throw new Error('the Progress row would not open (taps eaten or row occluded)');
    await new Promise((r) => setTimeout(r, 1000));
  }
  await waitFor(/^Unreviewed$/, 20000, 'verdict chips');
  await waitFor(/^Staged cull$/, 20000, 'verdict chips');
  // Row 2 is the ACTION layer — its presence is what proves the two
  // layers render as two rows rather than one merged vocabulary.
  await waitFor(/^To edit$/, 20000, 'action chips');
  await waitFor(/^Share$/, 20000, 'action chips');
  await waitFor(/^PHOTOS · /, 20000, 'grid header');
  shell('input keyevent KEYCODE_BACK');
  await waitForHome();
});

// Deck flow — requires unreviewed photos on the target.
await ensureForeground();
// Restore Home's top BEFORE reading the CTA: absent, the else-branch
// below reports "no unreviewed photos on target — seed the target
// first", which is a claim about the corpus made from a scroll position.
await waitForHome().catch(() => {});
const cta = await waitFor(/^Continue reviewing$|^All reviewed$/, 20000, 'review CTA').catch(
  () => null,
);
// The `before` badge snapshot feeds the v18 equality — an unanchored
// dump would record synthetic zeroes and let that equality pass
// vacuously, so only a dump showing all four tab labels may be read.
// A target that never anchors is a hard stop, not a quiet zero.
{
  const deadline = Date.now() + 20000;
  for (;;) {
    home = dumpUi();
    if (['Edit', 'Favourite', 'Organize', 'Share'].every((t) => hasTab(home, t))) break;
    if (Date.now() > deadline)
      throw new Error(
        `tab bar never anchored for the badge snapshot — cannot trust any badge read ` +
          `(foreground: ${foregroundPackage() ?? 'unknown'})`,
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}
// No `edit` entry: the v18 step explains why the edit half is asserted
// elsewhere.
const before = {
  favourite: badgeOf(home, 'Favourite'),
  organize: badgeOf(home, 'Organize'),
  share: badgeOf(home, 'Share'),
};
if (cta && findNode(home, /^Continue reviewing$/)) {
  await step('continue reviewing → deck (direct, m0.8.2 F8)', null, async () => {
    // The CTA goes STRAIGHT into the next timeline unit — group deck or
    // singles run, both carry the same unified controls.
    await tapText(/^Continue reviewing$/);
    await waitFor(/^Keep remaining/, 20000, 'deck');
  });
  // The deck flow below (toggle chips → cull the toggled photo → assert
  // the badges) needs a unit with a PENDING photo after the one it culls.
  // Pager arithmetic on the CTA-entered unit cannot prove that: `total ≥
  // 2 && pos < total` also holds when everything after the first pending
  // photo is already DECIDED — the "Edit on the surviving photo, then
  // Keep" step would then land on a decided photo, where Keep CLEARS a
  // verdict (re-decide semantics) instead of writing one. Only the
  // overview's card subtitles state truthful queue counts, so the
  // choreography unit is ALWAYS chosen there; the CTA step above keeps
  // proving the direct door itself.
  let deckStart;
  let deckStartOk = false;
  await step('deck start position (choreography unit chosen on the overview)', null, async () => {
    // Any unit with ≥ 2 PENDING photos serves the choreography — with
    // two pendings the FIRST pending can never be the last photo, so
    // the cull always has a following page to advance to; a
    // multi-photo singles run reviews exactly like a group in the
    // unified deck. Pending, not the photo count: a run of staged
    // culls lists many photos, zero pending, and opens in BROWSE mode
    // with no "Keep remaining" (device-observed on the S10e — the
    // whole flow cascaded). The timeline's head can be a LONG stretch
    // of one-photo and reviewed run cards (both phones), hence the
    // deep scroll cap. The status node renders beside its card title —
    // find a big-enough "N pending" and tap the title next to it.
    await waitFor(/^\d+\/\d+$/, 20000, 'pager indicator'); // the CTA landed in a deck
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
    await tapText(/\d+ to review$/, 20000);
    await waitFor(/^Review$/, 20000, 'overview heading');
    const bigCard = () => {
      const nodes = dumpUi();
      for (let i = 0; i < nodes.length; i += 1) {
        const pending = /^(\d+) pending$/.exec(nodes[i].text ?? '');
        if (!pending || Number(pending[1]) < 2) continue;
        // A four-node window, not two: one extra node between title and
        // status (a future UnitCard tweak) must not break the lookup.
        const title = nodes
          .slice(Math.max(0, i - 4), i)
          .find((n) => /^(?:Group|Singles) · /.test(n.text ?? ''));
        if (title) return title;
      }
      return null;
    };
    let card = bigCard();
    for (let i = 0; i < 30 && !card; i += 1) {
      scrollDown();
      await new Promise((r) => setTimeout(r, 600));
      card = bigCard();
    }
    if (!card) throw new Error('no unit with ≥ 2 pending photos in reach on the overview');
    tap(card);
    await waitFor(/^Keep remaining/, 20000, 'deck');
    const { node } = await waitFor(/^\d+\/\d+$/, 20000, 'pager indicator');
    const [pos, total] = node.text.split('/').map(Number);
    if (total < 2 || pos >= total)
      throw new Error(`chosen unit still unsuitable (${pos}/${total})`);
    deckStart = pos;
    deckStartOk = true;
  });
  // The choreography steps write REAL review decisions on the photo the
  // start step selected. When it failed, the deck may not even be open —
  // running them would decide whatever is on screen at an unknown
  // position and then fail with misleading diagnoses. Record them as
  // failed-skipped instead: loud, named, counted, bodies never run.
  const dependentStep = (name, budgetMs, fn) => {
    if (deckStartOk) return step(name, budgetMs, fn);
    results.push({
      name,
      ok: false,
      ms: 0,
      note: 'skipped: deck-start step failed — refusing to act on an unknown photo',
    });
    failures += 1;
    console.error(`  FAIL ${name}: skipped (deck-start step failed)`);
    return Promise.resolve();
  };
  // THE regression this gate exists for: a decision must never pin the
  // deck in a busy/"Saving…" state (m0.8 froze here for many seconds
  // while a scan held the database).
  //
  // The tab bar is HIDDEN on the full-screen review surfaces, so no badge
  // can be read from in here — what these taps actually wrote is asserted
  // back on Home, once the flow leaves the deck.
  // m0.8.2 F5: Organize is a pure toggle like Share — no album picker in
  // the deck (albums are assigned in the Organize queue, batch-wise), so
  // it joins the plain-chip loop. Tapped once, it queues target-less;
  // the queue-screen picker is exercised in its own step below.
  for (const chip of ['Edit', 'Favourite', 'Organize', 'Share']) {
    await dependentStep(`deck ${chip} responds without lingering Saving…`, null, async () => {
      await tapText(new RegExp(`^${chip}$`), 20000);
      await waitGone(/^Saving…$/, 2500, 'Saving…');
    });
  }
  // SWIPING between photos is the deck's primary interaction, and it was
  // BROKEN from m0.8 until m0.8.2 without anyone noticing — because the
  // only pager test used the Cull button (touching the photo froze the
  // pager via React zoom state, since removed from the gesture path).
  // Assert the gesture itself, not just that the pager CAN advance.
  await dependentStep('deck swipe advances the pager', null, async () => {
    const { node: pager } = await waitFor(
      new RegExp(`^${deckStart}/\\d+$`),
      20000,
      'pager indicator',
    );
    const total = Number(pager.text.split('/')[1]);
    const advanced = new RegExp(`^(?!${deckStart}/)\\d+/${total}$`);
    const deadline = Date.now() + 20000;
    let swipes = 0;
    for (;;) {
      swipeDeckLeft();
      swipes += 1;
      await new Promise((r) => setTimeout(r, 1200));
      const nodes = dumpUi();
      if (nodes.length > 0 && findNode(nodes, advanced)) return;
      if (swipes >= 3 || Date.now() > deadline)
        throw new Error(
          `pager stuck at ${deckStart}/${total} after ${swipes} swipes — the deck cannot be swiped`,
        );
    }
  });

  // ZOOM, asserted through the pager rather than through pixels. The
  // zoom overlay is always mounted and its touchability is an animated
  // `pointerEvents` prop, so "is it zoomed?" has no text to read — but
  // it has a BEHAVIOUR: while zoomed the overlay swallows the stage, so
  // a horizontal drag pans the photo instead of paging. That makes one
  // chain prove four things without a pixel or a testID: the double-tap
  // zoomed (or the swipe would have paged), the overlay is taking
  // touches, the second double-tap reset it (the reset is a real tap
  // GESTURE — the migrated `useTapGesture`), and paging came back.
  //
  // Gesture Handler 3 is why this earns a step: its detector became a
  // host component, and the first migration attempt silently broke both
  // halves — the pager could not be swiped at all, and an overlay
  // detector wrapped outside the animated prop ate every stage touch.
  await dependentStep(
    'deck double-tap zooms, and the zoomed stage swallows the pager',
    null,
    async () => {
      const before = pagerPosition();
      if (!before) throw new Error('no pager indicator on the deck');
      const [pos, total] = before;
      if (total < 2) throw new Error(`deck has ${total} photo(s) — need 2+ to detect paging`);
      // Page AWAY from whichever end we are on. The step before this one
      // leaves the pager wherever its swipes ended — on the S23 that was
      // the last photo, where a leftward swipe cannot advance and the
      // final assertion could never have passed.
      const swipeAway = pos >= total ? swipeDeckRight : swipeDeckLeft;

      doubleTapStage();
      await new Promise((r) => setTimeout(r, 1200));
      swipeAway();
      await new Promise((r) => setTimeout(r, 1200));
      const zoomed = pagerPosition();
      if (!zoomed) throw new Error('pager indicator vanished while zoomed');
      if (zoomed[0] !== pos)
        throw new Error(
          `zoomed stage still paged (${pos}/${total} → ${zoomed[0]}/${zoomed[1]}) — the double tap did not zoom, or the overlay is not taking touches`,
        );

      doubleTapStage(); // reset — the overlay's own double-tap gesture
      await new Promise((r) => setTimeout(r, 1200));
      swipeAway();
      await new Promise((r) => setTimeout(r, 1200));
      const after = pagerPosition();
      if (!after) throw new Error('pager indicator vanished after the zoom reset');
      if (after[0] === pos)
        throw new Error(
          `pager still stuck at ${pos}/${total} after the reset — the zoom never returned to 1x, so the deck is frozen behind the overlay`,
        );
    },
  );

  // COMPARE's tap-to-flip. The stage there is a Pressable and the flip
  // rides the JS responder path UNDER the gesture detector, which is a
  // different arrangement from the deck's and broke independently under
  // Gesture Handler 3's host detector. Run before the cull, so every
  // member is still an eligible candidate and the opponent PICKER is on
  // the path too (it opens whenever more than two are eligible); the
  // cull step below re-finds its own position afterwards.
  await dependentStep('compare flips between the two photos', null, async () => {
    // The button reads "Compare with…" once more than two candidates are
    // eligible (it then opens the opponent picker) and plain "Compare"
    // otherwise — the walk must accept whichever this unit renders.
    await tapText(/^Compare( with…)?$/, 20000);
    const { node: landed } = await waitFor(
      /^(Actions apply to photo \d+|Compare with…)$/,
      20000,
      'compare screen or opponent picker',
    );
    if (landed.text === 'Compare with…') {
      // Thumbnails are labelled with their DECK position; take the first
      // one below the picker's title.
      const thumb = dumpUi()
        .filter((n) => /^\d+$/.test(n.text) && n.y > landed.y)
        .sort((a, b) => a.y - b.y || a.x - b.x)[0];
      if (!thumb) throw new Error('opponent picker showed no numbered candidate');
      tap(thumb);
    }
    const { node: first } = await waitFor(/^Actions apply to photo \d+$/, 20000, 'compare screen');
    const { width, height } = screenSize();
    shell(`input tap ${Math.round(width / 2)} ${Math.round(height * 0.38)}`);
    const deadline = Date.now() + 8000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const now = findNode(dumpUi(), /^Actions apply to photo \d+$/);
      if (now && now.text !== first.text) break;
      if (Date.now() > deadline)
        throw new Error(`compare stage tap did not flip (still "${first.text}")`);
    }
    // Leave without writing a verdict — this step must not decide anything.
    await tapText(/^Close — no verdict$/, 20000);
    await waitFor(/^\d+\/\d+$/, 20000, 'back on the deck');
  });

  await dependentStep('deck Cull advances the pager', null, async () => {
    // The swipe step above legitimately leaves the pager past the start,
    // but the v18 badge assertion below depends on culling the START
    // photo — the one the Edit/Favourite/Organize/Share toggles landed
    // on — so return to it first. The start step guaranteed a following
    // page (deckStart < total).
    const first = await waitFor(/^\d+\/\d+$/, 20000, 'pager indicator');
    const total = Number(first.node.text.split('/')[1]);
    let pos = Number(first.node.text.split('/')[0]);
    const backDeadline = Date.now() + 20000;
    while (pos !== deckStart) {
      if (Date.now() > backDeadline)
        throw new Error(`could not return to ${deckStart}/${total} (at ${pos}/${total})`);
      // Below deckStart the loop recovers FORWARD — proceeding from any
      // earlier position would cull the wrong photo (the `advanced`
      // regex below accepts any position ≠ deckStart).
      if (pos > deckStart) swipeDeckRight();
      else swipeDeckLeft();
      await new Promise((r) => setTimeout(r, 1200));
      // Decide the next swipe only on an OBSERVED pager: a failed dump
      // used to leave `pos` stale, the loop re-swiped past deckStart,
      // and the wrong photo got culled while the step passed.
      for (;;) {
        const node = findNode(dumpUi(), /^\d+\/\d+$/);
        if (node) {
          pos = Number(node.text.split('/')[0]);
          break;
        }
        if (Date.now() > backDeadline)
          throw new Error(
            `pager unobservable returning to ${deckStart}/${total} (last seen ${pos}/${total})`,
          );
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    // Re-tap ONLY on positive evidence: a SUCCESSFUL dump still showing
    // the start position with the Cull button present. Blind re-taps
    // after failed dumps culled the NEXT photo and then hunted for a
    // stale pager value (device-observed); any advanced pager counts as
    // success.
    const advanced = new RegExp(`^(?!${deckStart}/)\\d+/${total}$`);
    const notAdvanced = new RegExp(`^${deckStart}/${total}$`);
    const deadline = Date.now() + 30000;
    let taps = 0;
    await tapText(/^Cull$/, 20000);
    taps += 1;
    for (;;) {
      const nodes = dumpUi();
      if (nodes.length > 0) {
        if (findNode(nodes, advanced)) return;
        if (findNode(nodes, notAdvanced) && findNode(nodes, /^Cull$/)) {
          if (taps >= 3) throw new Error('pager never advanced after 3 evidenced cull taps');
          await tapText(/^Cull$/, 20000);
          taps += 1;
        }
      }
      if (Date.now() > deadline) throw new Error('pager state unobservable within 30 s');
      await new Promise((r) => setTimeout(r, 400));
    }
  });
  // The Edit button writes BOTH layers in one transaction (keep the photo
  // AND queue the edit) and once regressed to writing the verdict alone —
  // no spinner, no error, the edit simply never queued. Tapped here on
  // the photo the cull advanced PAST, so it survives to carry its edit.
  await dependentStep('deck Edit on the surviving photo, then Keep', null, async () => {
    await tapText(/^Edit$/, 20000);
    await waitGone(/^Saving…$/, 2500, 'Saving…');
    await tapText(/^Keep$/, 20000);
    await waitGone(/^Saving…$/, 2500, 'Saving…');
  });
  // The gate's ONE measured, frame-level check (m0.8.5 §10 checks 1/3):
  // the deck advances IN PLACE, so no frame of a finish-button advance
  // may blank the stage or drop the control block. uiautomator cannot
  // see frames; this records the advance with `screenrecord` (which
  // emits frames only while pixels change, so the clip IS the
  // transition) and reads per-frame region statistics from raw RGB via
  // ffmpeg on the host. The clip lands in the report dir either way.
  await dependentStep(
    'finish advance never blanks the stage or drops the controls',
    null,
    async () => {
      try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      } catch {
        throw new Error(
          'ffmpeg not found on this host — install it; the transition probe reads frames with it',
        );
      }
      // The tap point is resolved BEFORE recording: a uiautomator dump can
      // take seconds, and taken mid-recording it would push the tap out of
      // the clip (observed on the emulator).
      // Same stance as the deck-flow guard: an unmeasurable probe FAILS
      // with the fix in its note — a release pass must not silently skip
      // its one frame-level check.
      const finish = findNode(dumpUi(), /^Keep remaining \(\d+\)$/);
      if (!finish)
        throw new Error(
          'no finish button on screen — the walk consumed the corpus before the probe; seed the target deeper and re-run',
        );
      const clipDevice = '/sdcard/ag-gate-advance.mp4';
      const clipHost = join(REPORT_DIR, 'finish-advance.mp4');
      const rec = spawn('adb', [
        '-s',
        SERIAL,
        'shell',
        `screenrecord --time-limit 6 ${clipDevice}`,
      ]);
      await new Promise((r) => setTimeout(r, 1000));
      shell(`input tap ${Math.round(finish.x)} ${Math.round(finish.y)}`);
      await new Promise((resolve) => rec.on('close', resolve));
      adb('pull', clipDevice, clipHost);
      shell(`rm -f ${clipDevice}`);
      // Only a deck-to-deck advance is measurable: landing on the cull
      // list swaps the green finish button for the trash affordance, which
      // would fail the green-presence read for a legitimate reason.
      const after = dumpUi();
      if (!findNode(after, /^\d+\/\d+$/))
        throw new Error(
          `the finish left review (corpus consumed) — clip saved to ${clipHost}; seed the target deeper and re-run so the probe measures a deck-to-deck advance`,
        );
      // Decode small (216 px wide) raw RGB frames and read two regions:
      // the stage interior and the bottom control band. Thresholds were
      // calibrated on emulator probe clips (2026-08-10): the dimmed
      // (disabled) finish button still reads ~97% of the steady green
      // count; a vanished control block reads ~0%.
      const W = 216;
      const [pw, ph] = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          clipHost,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split(',')
        .map(Number);
      const H = Math.round((ph / pw) * W) & ~1;
      const raw = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          clipHost,
          '-vf',
          `scale=${W}:${H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-',
        ],
        { maxBuffer: 1024 * 1024 * 1024 },
      );
      const frameBytes = W * H * 3;
      const frames = Math.floor(raw.length / frameBytes);
      if (frames < 3) throw new Error(`clip decoded to ${frames} frame(s) — recording failed`);
      let minStageMax = 255;
      let minGreen = Infinity;
      let maxGreen = 0;
      for (let f = 0; f < frames; f += 1) {
        const base = f * frameBytes;
        let stageMax = 0;
        for (let y = Math.round(H * 0.18); y < Math.round(H * 0.52); y += 1)
          for (let x = Math.round(W * 0.05); x < Math.round(W * 0.95); x += 1) {
            const i = base + (y * W + x) * 3;
            const v = Math.max(raw[i], raw[i + 1], raw[i + 2]);
            if (v > stageMax) stageMax = v;
          }
        let green = 0;
        for (let y = Math.round(H * 0.78); y < Math.round(H * 0.97); y += 1)
          for (let x = 0; x < W; x += 1) {
            const i = base + (y * W + x) * 3;
            if (raw[i + 1] > 45 && raw[i + 1] > raw[i] * 1.35 && raw[i + 1] > raw[i + 2] * 1.35)
              green += 1;
          }
        if (stageMax < minStageMax) minStageMax = stageMax;
        if (green < minGreen) minGreen = green;
        if (green > maxGreen) maxGreen = green;
      }
      if (maxGreen < 500)
        throw new Error(
          `no green control band found in any frame (max ${maxGreen}px) — inspect ${clipHost}`,
        );
      if (minGreen < maxGreen * 0.3)
        throw new Error(
          `controls vanished mid-advance: a frame held ${minGreen}px of keep-green vs ${maxGreen}px steady — inspect ${clipHost}`,
        );
      if (minStageMax < 60)
        throw new Error(
          `stage read as blank in at least one frame (max channel ${minStageMax}) — inspect ${clipHost} before trusting this: an all-black photo (pocket shot) inside the transition can trip this probe`,
        );
    },
  );

  await dependentStep('back home: the badges tell both halves of the v18 rule', null, async () => {
    for (let i = 0; i < 4; i += 1) {
      if (findNode(dumpUi(), /^Daily goal/)) break;
      shell('input keyevent KEYCODE_BACK');
      await new Promise((r) => setTimeout(r, 700));
    }
    await waitFor(/^Cull list$/, 20000, 'cull list row');
    // THE LIVE RULE, and the only place it is observable: the first photo
    // was favourited and shared and THEN staged to cull, so both badges
    // must be back exactly where they started — a photo you are about to
    // delete is not work waiting for you. Its action rows still exist
    // (un-staging restores them); they just stop counting.
    // Badges recount asynchronously after navigation, so this polls.
    // The EDIT badge is deliberately absent from this equality: the deck
    // chips are TOGGLES, so across repeat gate runs the edit deltas of
    // the culled and the surviving photo can legitimately sum to zero —
    // the edit wiring is asserted by the "completing an edit updates its
    // tab badge" step instead.
    const deadline = Date.now() + 25000;
    for (;;) {
      const after = dumpUi();
      // Equality only counts on a dump that actually contains both tab
      // anchors — badgeOf reads 0 for a missing anchor, and two synthetic
      // zeroes on a failed dump would pass this vacuously (codex r50).
      const anchored =
        after.length > 0 &&
        hasTab(after, 'Favourite') &&
        hasTab(after, 'Organize') &&
        hasTab(after, 'Share');
      const favourite = badgeOf(after, 'Favourite');
      const organize = badgeOf(after, 'Organize');
      const share = badgeOf(after, 'Share');
      if (
        anchored &&
        favourite === before.favourite &&
        organize === before.organize &&
        share === before.share
      )
        return;
      if (Date.now() > deadline)
        throw new Error(
          `staged cull still counted: favourite ${favourite} (expected ${before.favourite}), ` +
            `organize ${organize} (expected ${before.organize}), ` +
            `share ${share} (expected ${before.share})`,
        );
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  // Completing work from a QUEUE SCREEN must move its tab badge. The
  // review-queue refresh cannot deliver that on its own — it commits
  // nothing when the deck's snapshot is unchanged, and queue screens act
  // on photos the deck never loaded — so this is the only place the
  // wiring is observable. Device-observed regression: the Edit badge sat
  // on its old number until the app was backgrounded.
  if (!deckStartOk) {
    // The skipped v18 step is what normally navigates back to Home —
    // best-effort return so the deck-independent steps below still start
    // from a known screen instead of cascading misleading timeouts.
    for (let i = 0; i < 4; i += 1) {
      if (findNode(dumpUi(), /^Daily goal/)) break;
      shell('input keyevent KEYCODE_BACK');
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  await step('completing an edit updates its tab badge', null, async () => {
    // A FAILED dump reads as badge 0 — the absent-anchor default — and
    // the early return would then pass having asserted nothing. Only a
    // dump that actually shows the Edit tab may report the start badge.
    let start;
    const anchorDeadline = Date.now() + 20000;
    for (;;) {
      const nodes = dumpUi();
      if (hasTab(nodes, 'Edit')) {
        start = badgeOf(nodes, 'Edit');
        break;
      }
      if (Date.now() > anchorDeadline)
        throw new Error('Edit tab never anchored in a dump — cannot read its badge');
      await new Promise((r) => setTimeout(r, 500));
    }
    if (start === 0) {
      console.log(
        '  … Edit badge anchored at 0 — nothing queued to complete, step asserts nothing',
      );
      return;
    }
    await tapText(/^Edit$/, 20000); // the TAB
    await waitFor(/^Edit queue$/, 20000, 'edit queue');
    const done = findNode(dumpUi(), /^Done$/);
    if (!done) throw new Error(`Edit badge says ${start} but the queue lists nothing to finish`);
    tap(done); // ✓ Done applies straight away — the confirmation prompt
    // belongs to the return-from-editor path, not this button.
    const deadline = Date.now() + 25000;
    for (;;) {
      const nodes = dumpUi();
      if (nodes.length > 0 && badgeOf(nodes, 'Edit') === start - 1) break;
      if (Date.now() > deadline)
        throw new Error(`Edit badge stuck at ${badgeOf(dumpUi(), 'Edit')}, expected ${start - 1}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Home is the raised CENTER BUTTON, not a back target.
    await tapText(/^Home$/, 20000);
    await waitForHome();
  });

  // The timeline overview is reached through the queue-breakdown link
  // now (m0.8.2 F8) — assert the door works and shows the merged list.
  await step('queue breakdown opens the timeline overview', null, async () => {
    await tapText(/\d+ to review$/, 20000);
    await waitFor(/^Review$/, 20000, 'overview heading');
    await waitFor(/^(Group|Singles) ·/, 20000, 'timeline cards');
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
  });

  // The album picker moved from the deck to the Organize queue (m0.8.2
  // F6) — exercise it there, mutation-free: open the sheet, close it.
  // The queue may legitimately be empty (the toggled photo above was
  // culled away), in which case the empty-state copy is the assertion.
  await step('organize queue hosts the album picker', null, async () => {
    await tapText(/^Organize$/, 20000); // the TAB
    await waitFor(/^Organize queue$/, 20000, 'organize queue');
    const nodes = dumpUi();
    if (findNode(nodes, /^Choose album for/)) {
      await tapText(/^Choose album for/);
      await waitFor(/^Move to album$/, 20000, 'album picker');
      await tapText(/^Cancel$/);
      await waitGone(/^Move to album$/, 8000, 'album picker');
    } else {
      await waitFor(/assign albums here/, 8000, 'organize empty state');
    }
    await tapText(/^Home$/, 20000);
    await waitForHome();
  });

  await step('cull list opens', null, async () => {
    await tapText(/^Cull list$/);
    await waitFor(/\d+ staged ·/, 20000, 'cull list screen');
    shell('input keyevent KEYCODE_BACK');
  });

  // The STANDARD VIEWER's own pager (PhotoViewer — the one every grid,
  // queue and History row opens). It is a second pager under a second
  // gesture stack, and nothing else in this walk touches it: the deck's
  // swipe passing says nothing about it. Reached through History because
  // its rows are addressable by their date text, and by this point the
  // walk's own decisions have put rows there.
  await step('the standard viewer pages between photos', null, async () => {
    await tapText(/^History$/, 20000);
    await waitFor(/^History$/, 20000, 'history screen');
    // Match the row by its "· HH:MM" tail, never by the date's word
    // order: `formatDayClock` builds the date half with
    // `toLocaleDateString(undefined, …)`, so it follows the DEVICE
    // locale — "Aug 4 · 9:18 AM" on the emulator, "04 Aug · 10:32" on
    // the S23. Anchoring on the month-first spelling failed the S23 on a
    // feed that was plainly full of rows.
    const row = findNode(dumpUi(), / · \d{1,2}:\d{2}/);
    if (!row) throw new Error('history feed showed no photo rows');
    tap(row);
    const opened = await waitFor(/^\d+\/\d+$/, 20000, 'viewer pager indicator');
    const [pos, total] = opened.node.text.split('/').map(Number);
    if (total >= 2) {
      const { width, height } = screenSize();
      const y = Math.round(height * 0.4);
      const deadline = Date.now() + 15000;
      for (let swipes = 0; ; swipes += 1) {
        shell(`input swipe ${Math.round(width * 0.85)} ${y} ${Math.round(width * 0.15)} ${y} 250`);
        await new Promise((r) => setTimeout(r, 1000));
        const now = pagerPosition();
        if (now && now[0] !== pos) break;
        if (swipes >= 2 || Date.now() > deadline)
          throw new Error(`viewer stuck at ${pos}/${total} — its pager cannot be swiped`);
      }
    }
    shell('input keyevent KEYCODE_BACK');
    await new Promise((r) => setTimeout(r, 600));
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
  });
} else {
  // Distinguish "the target is fully reviewed" (a real seeding problem)
  // from "we are not even looking at Home" (an interrupted run) — the
  // two need opposite responses from whoever reads this.
  const front = foregroundPackage();
  results.push({
    name: 'deck flow',
    ok: false,
    ms: 0,
    note:
      front === APP_ID || front === null
        ? 'no unreviewed photos on target ("Continue reviewing" absent) — seed the target first'
        : `Home never rendered: ${front} holds the foreground — re-run on an undisturbed device`,
  });
  failures += 1;
}

// ------------------------------------------------------------- report
console.log('\n== Afterglow UI gate report ==');
for (const r of results) {
  console.log(` ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.note ? ` — ${r.note}` : ''}`);
}
console.log(failures === 0 ? '\nGATE PASSED' : `\nGATE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
