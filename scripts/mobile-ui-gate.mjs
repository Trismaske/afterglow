#!/usr/bin/env node
/**
 * Afterglow Companion pre-release UI gate: drives the INSTALLED app on a
 * connected Android device or emulator over plain adb (no extra tools)
 * and walks every main surface and interaction, asserting presence AND
 * that no action gets stuck busy. Run it before tagging a mobile
 * release, after installing the release APK on a test target with a
 * photo corpus.
 *
 *   node scripts/mobile-ui-gate.mjs [--serial SERIAL] [--report-dir DIR] [--font-scale X]
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
import { adbRaw, createDriver, resolveSerial } from './lib/ui-driver.mjs';
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
// The device hands live in scripts/lib/ui-driver.mjs, shared with the
// accessibility walk (m0.9.1); the rules learnt on the phones are in its
// header.
const SERIAL = resolveSerial(argOf('--serial'));
/** The gate runs at any OS font scale (the grilling, 2026-10-11): its
 * Home searches scroll like the walk's and a tab's count is read from
 * its accessibility label, which survives the dot. `--font-scale X`
 * sets the device's font scale for the run and restores the device's own
 * value on every exit path, like the walk; without it the run takes the
 * device as it is. */
const FONT_SCALE = argOf('--font-scale');
if (
  args.includes('--font-scale') &&
  !(Number(FONT_SCALE) > 0 && Number.isFinite(Number(FONT_SCALE)))
) {
  console.error(`--font-scale needs a positive number (got ${JSON.stringify(FONT_SCALE ?? '')})`);
  process.exit(2);
}
const {
  adb,
  shell,
  dumpUi,
  screenSize,
  findNode,
  scrollDown,
  scrollUp,
  waitForHome,
  swipeDeckLeft,
  swipeDeckRight,
  tapStage,
  doubleTapStage,
  pagerPosition,
  waitFor,
  waitGone,
  tap,
  tapText,
  foregroundPackage,
  dismissPipOverlays,
  ensureForeground,
} = createDriver(SERIAL, APP_ID);
const startingFont = FONT_SCALE ? shell('settings get system font_scale').trim() : null;
const restoreFont = () => {
  if (startingFont === null) return;
  shell(
    startingFont === 'null' || startingFont === ''
      ? 'settings delete system font_scale'
      : `settings put system font_scale ${startingFont}`,
  );
  console.log(`restored ${SERIAL}: font_scale ${startingFont}`);
};
if (FONT_SCALE) {
  shell(`settings put system font_scale ${FONT_SCALE}`);
  console.log(`font_scale ${FONT_SCALE} for this run (was ${startingFont})`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      restoreFont();
      process.exit(130);
    });
  process.on('exit', restoreFont);
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
  // The tab's accessibility label carries the count ("Edit, 3 waiting")
  // at every font scale, including those where the disc shows a dot.
  const counted = nodes.find((n) => new RegExp(`^${label}, (\\d+) waiting$`).test(n.desc));
  if (counted) return Number(/, (\d+) waiting$/.exec(counted.desc)[1]);
  if (nodes.some((n) => n.desc === label)) return 0;
  // Custom-bar badges render as a small numeric Text near the tab icon;
  // uiautomator has no hierarchy here, so take the numeric node closest
  // to the label's x. Anchor on text OR content-desc: some devices
  // (S10e) intermittently report the label Text with zero bounds, but
  // the item Pressable's content-desc always has real bounds.
  const anchor = nodes.find((n) => n.text === label || isTabDesc(n.desc, label));
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
/** Find a Home row by its text, scrolling in short steps until it is
 * whole and clear of the status bar and the tab bar (the walk's rule):
 * at large text the queue line and the review button sit below the
 * fold, and the dump lists a sliver clipped by the scroll view's edge. */
async function findHomeRow(re, timeoutMs = 20000) {
  const { height } = screenSize();
  const deadline = Date.now() + timeoutMs;
  // From the TOP: a step before may have left Home scrolled past the row
  // (the S10e at 2.0 searched downward for a Cull list card already above
  // the viewport); the search scrolls down only, so it starts at the top.
  await waitForHome().catch(() => {});
  for (;;) {
    const nodes = dumpUi();
    const node = findNode(nodes, re);
    if (node && node.y1 > height * 0.05 && node.y2 < height * 0.86 && node.y2 - node.y1 > 20)
      return node;
    if (Date.now() > deadline) return null;
    // Scroll only while the tab bar is on screen: Home is the only tab
    // screen with these rows, and a scroll anywhere else (a deck that
    // opened late after a retried tap) could land the next tap on a
    // verdict chip. Off a tab screen, wait for Home to come back.
    if (hasTab(nodes, 'Home')) scrollDown(0.25);
    await new Promise((r) => setTimeout(r, 400));
  }
}
/** Wait for a marker on the CURRENT screen, scrolling in short steps
 * when it is below the fold (a Stats card or a Progress chip row at
 * large text — codex round 12), and returning it whole. Scrolling here
 * is safe: the screens that use it (Stats, Progress) decide nothing on
 * a scroll. */
async function waitOnScreen(re, timeoutMs, label) {
  const { height } = screenSize();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nodes = dumpUi();
    const node = findNode(nodes, re);
    if (node && node.y1 > height * 0.05 && node.y2 < height * 0.95 && node.y2 - node.y1 > 20)
      return { node, ms: 0 };
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    if (nodes.length > 0) scrollDown(0.25);
    await new Promise((r) => setTimeout(r, 400));
  }
}
/** Back to the top of the current screen (its tab strip or title row). */
async function scrollToTop() {
  for (let i = 0; i < 8; i += 1) {
    scrollUp(0.6);
    await new Promise((r) => setTimeout(r, 300));
  }
}
/** Tap a Home row and wait for what it opens, re-finding and re-tapping
 * when a tap is eaten (device-observed on the emulator: a tap landing
 * during Home's settle after a scroll does nothing). Three tries, each
 * with its own wait; the last failure is the step's. */
async function openFromHome(rowRe, expectRe, label, waitMs = 8000) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A slow screen that opened after the last wait is the result, not a
    // reason to tap again.
    if (attempt > 0) {
      const late = findNode(dumpUi(), expectRe);
      if (late) return { node: late, ms: 0 };
    }
    const row = await findHomeRow(rowRe, 20000);
    if (!row) throw new Error(`${label} never came into view`);
    tap(row);
    try {
      return await waitFor(expectRe, waitMs, label);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
const hasTab = (nodes, label) => nodes.some((n) => n.text === label || isTabDesc(n.desc, label));
/** The tab's accessibility label is its title, with its count after a
 * comma when work waits ("Edit, 2 waiting" — m0.9.1): both name the tab. */
const isTabDesc = (desc, label) => desc === label || desc.startsWith(`${label}, `);
/** A tab by its label text or its counted accessibility label: on the S10e
 * the label Text intermittently has zero bounds, so the desc is the anchor. */
const tabPattern = (label) => new RegExp(`^${label}(, \\d+ waiting)?$`);

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
  // queue read commits (~7 s on the 27k device) — wait it out; at large
  // text the line sits below the fold, so the wait scrolls for it
  // (codex round 11) and Home's top is restored for the steps after.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (await findHomeRow(/to review|Everything reviewed/, 5000)) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for queue copy');
  }
  home = dumpUi();
  await waitForHome();
});
await step('home library totals line', null, async () => {
  // Round 4: the card states the corpus total; the scan line below the
  // CTA exists only WHILE a scan runs (or after one failed), so it is
  // not an unconditional assertion any more. At large text the line can
  // sit below the fold: scroll for it, then restore Home's top.
  if (!findNode(home, /items? total/) && !(await findHomeRow(/items? total/, 10000)))
    throw new Error('totals line missing');
  await waitForHome();
});
/** Select `chip` ("Off", "All visible", …) on the Playback row titled
 * `label`, on the Settings screen, and prove it committed. The row's own
 * chip is the one NEAREST its title by vertical distance (the rows are
 * ~170 px apart on the S10e; a two-line title such as "Animated
 * thumbnails" centres its text slightly BELOW its chips, so "below the
 * title" is not the rule — nearest is). The chip reports selected only
 * after the optimistic state lands, and a failed write rolls it back,
 * so a selected chip is the durable value. */
async function selectPlaybackChip(label, chip) {
  // The option belongs to the row whose title is the nearest ABOVE it
  // and before the next Playback title: at large text the pill is a
  // vertical list and an option sits hundreds of pixels under its title,
  // so no fixed distance can bind them (codex round 10).
  const TITLES = /^(Videos|Motion photos|Animated thumbnails)$/;
  const nearest = (nodes, row, wantSelected) => {
    const nextTitleY = Math.min(
      Infinity,
      ...nodes.filter((n) => TITLES.test(n.text) && n.y > row.y).map((n) => n.y),
    );
    return (
      nodes
        .filter((n) => n.text === chip && (!wantSelected || n.selected))
        // At or below the title's centre: a title beside its pill (a
        // narrow row at a small scale) shares the centre line.
        .filter((n) => n.y >= row.y - 8 && n.y < nextTitleY)
        .sort((a, b) => a.y - b.y)[0] ?? null
    );
  };
  // The Playback rows sit below the fold, and the cards are taller than
  // a phone screen holds at once — the row is found on its own,
  // scrolling in HALF screens (a full-screen fling overshoots).
  let nodes = [];
  for (let i = 0; i < 16; i += 1) {
    nodes = dumpUi();
    if (findNode(nodes, label)) break;
    scrollDown(0.45);
    await new Promise((r) => setTimeout(r, 900));
  }
  let row = findNode(nodes, label);
  if (!row) throw new Error(`Playback row ${label} not on screen`);
  // A title that just entered the screen has its chips still below the
  // fold — nudge a quarter screen and look again.
  let target = null;
  for (let i = 0; i < 4 && !target; i += 1) {
    target = nearest(nodes, row, false);
    if (target) break;
    scrollDown(0.3);
    await new Promise((r) => setTimeout(r, 900));
    nodes = dumpUi();
    row = findNode(nodes, label) ?? row;
  }
  if (!target) throw new Error(`no ${chip} chip beside ${label}`);
  tap(target);
  const deadline = Date.now() + 8000;
  let committed = false;
  while (Date.now() < deadline && !committed) {
    await new Promise((r) => setTimeout(r, 400));
    const now = dumpUi();
    const again = findNode(now, label);
    committed = !!again && nearest(now, again, true) !== null;
  }
  if (!committed) throw new Error(`${chip} did not commit beside ${label}`);
}

await step('playback off for the walk', null, async () => {
  // A PLAYING video never lets the UI reach idle, and `uiautomator dump`
  // writes nothing until it does — every deck assertion after a video
  // page then reads an empty dump and times out (phase 5 finding,
  // 2026-09-09: page 3 of 4 on screen, the dump still saying 1 of 4).
  // The walk parks the Playback rows on Off through the same Settings
  // rows a tester uses; a test device keeps the setting. The third row
  // (m0.9 phase 6): animated thumbnails play in every grid, which keeps
  // the UI from idling just as a stage video does.
  await tapText(/^Settings$/, 10000);
  // A marker that exists ONLY on the Settings screen: Home's own header
  // icon carries the desc "Settings", so waiting for that word would
  // pass before the screen has changed.
  await waitFor(/^Photo source$/, 15000, 'settings screen');
  try {
    for (const label of [/^Videos$/, /^Motion photos$/, /^Animated thumbnails$/]) {
      await selectPlaybackChip(label, 'Off');
    }
  } finally {
    // Whatever happened, the walk continues from Home.
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
    home = dumpUi();
  }
});

await step('tab order Edit · Favourite · HOME · Organize · Share', null, async () => {
  // Poll: right after launch a dump can land before the bar lays out.
  const deadline = Date.now() + 20000;
  for (;;) {
    const nodes = dumpUi();
    const labels = ['Edit', 'Favourite', 'Organize', 'Share'].map((t) =>
      nodes.find((n) => n.text === t || isTabDesc(n.desc, t)),
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
    await tapText(tabPattern(label), 20000);
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
  await waitOnScreen(/^Last 30 days$/, 20000, 'stats activity card');
  // The intake chart is the LAST card on the tab, so it needs scrolling
  // to: an accessibility dump only carries what is laid out.
  for (let i = 0; i < 4; i += 1) {
    if (findNode(dumpUi(), /^Shooting vs reviewing$/)) return;
    scrollDown();
    await new Promise((r) => setTimeout(r, 600));
  }
  await waitOnScreen(/^Shooting vs reviewing$/, 8000, 'intake vs review card');
});
await step('stats Forecast tab loads its own numbers', null, async () => {
  await scrollToTop();
  await tapText(/^Forecast$/, 20000);
  // Either a finish line or an explicit refusal — never a blank card.
  await waitOnScreen(/^Finish line$/, 20000, 'forecast card');
});
await step('stats Habits tab loads its own numbers', null, async () => {
  await scrollToTop();
  await tapText(/^Habits$/, 20000);
  await waitOnScreen(/^Rhythm$/, 20000, 'rhythm card');
  // m0.8.2 terminology: the card is "Queues" ("waiting" → "queued").
  await waitOnScreen(/^Queues$/, 20000, 'queue turnaround rows');
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
          findNode(nodes, / left · | at this pace$|^All items · state browsing$/))
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
    } else if (nodes.length > 0) {
      // Below the fold at large text: a short step, like findHomeRow.
      scrollDown(0.25);
      await new Promise((r) => setTimeout(r, 400));
    }
    if (Date.now() > deadline)
      throw new Error('the Progress row would not open (taps eaten or row occluded)');
    await new Promise((r) => setTimeout(r, 1000));
  }
  await waitFor(/^Unreviewed$/, 20000, 'verdict chips');
  await waitOnScreen(/^Staged cull$/, 20000, 'verdict chips');
  // Row 2 is the ACTION layer — its presence is what proves the two
  // layers render as two rows rather than one merged vocabulary.
  await waitOnScreen(/^To edit$/, 20000, 'action chips');
  await waitOnScreen(/^Share$/, 20000, 'action chips');
  await waitOnScreen(/^ITEMS · /, 20000, 'grid header');
  shell('input keyevent KEYCODE_BACK');
  await waitForHome();
});

// Deck flow — requires unreviewed photos on the target.
await ensureForeground();
// Restore Home's top BEFORE reading the CTA: absent, the else-branch
// below reports "no unreviewed photos on target — seed the target
// first", which is a claim about the corpus made from a scroll position.
await waitForHome().catch(() => {});
const cta = await findHomeRow(/^Continue reviewing$|^All reviewed$/, 20000);
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
if (cta && (/^Continue reviewing$/.test(cta.text) || /^Continue reviewing$/.test(cta.desc))) {
  await step('continue reviewing → deck (direct, m0.8.2 F8)', null, async () => {
    // The CTA goes STRAIGHT into the next timeline unit — group deck or
    // singles run, both carry the same unified controls.
    await openFromHome(/^Continue reviewing$/, /^Keep remaining/, 'deck');
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
    await openFromHome(/\d+ to review$/, /^Timeline$/, 'overview heading');
    // The walk decides THREE photos in its unit (one cull, one keep, and
    // the finish probe needs one still pending), so the unit must hold
    // at least three — and it is looked for under the Timeline's
    // Unreviewed filter, which lists exactly the units with pending
    // photos, so a library with any is found and a library with none
    // fails for the right reason.
    await tapText(/^Unreviewed$/, 10000);
    await new Promise((r) => setTimeout(r, 1200));
    const WALK_NEEDS = 3;
    const bigCard = () => {
      const nodes = dumpUi();
      for (let i = 0; i < nodes.length; i += 1) {
        const pending = /^(\d+) pending$/.exec(nodes[i].text ?? '');
        if (!pending || Number(pending[1]) < WALK_NEEDS) continue;
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
    if (!card)
      throw new Error(
        `no unit with ≥ ${WALK_NEEDS} pending photos under Unreviewed — seed the target and re-run`,
      );
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
    // Generous: at 2.0 on the S10e a swipe, its settle and a dump take
    // several seconds each, and 20 s ran out two pages short.
    const backDeadline = Date.now() + 60000;
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
      // (1) or more: a browse deck's disabled "Keep remaining (0)" would
      // accept the tap coordinates and record steady chrome — the pixel
      // checks would then pass without any transition in the clip.
      const before = dumpUi();
      const finish = findNode(before, /^Keep remaining \([1-9]\d*\)$/);
      if (!finish)
        throw new Error(
          'no pressable finish button on screen — the walk consumed the corpus before the probe; seed the target deeper and re-run',
        );
      // Fail closed on a DISABLED finish (a write in flight): the tap
      // would no-op and the clip would show steady chrome.
      if (!finish.enabled)
        throw new Error('the finish button is disabled (a write is in flight) — probe aborted');
      // The unit's header line names the advance: it MUST read differently
      // once the finish lands (fewer groups/singles left, or another
      // kind). MANDATORY (codex round 2): without this anchor the probe
      // cannot prove a transition happened, so its absence is a failure,
      // not a skipped assertion.
      const headerBefore = findNode(before, /^(Group|Singles) · /);
      if (!headerBefore)
        throw new Error('no deck header line in the pre-tap dump — probe cannot prove an advance');
      const clipDevice = '/sdcard/ag-gate-advance.mp4';
      const clipHost = join(REPORT_DIR, 'finish-advance.mp4');
      // A clip left by an interrupted earlier run must never be analyzed
      // as this run's (codex round 2): clear the device path first.
      shell(`rm -f ${clipDevice}`);
      const rec = spawn('adb', [
        '-s',
        SERIAL,
        'shell',
        `screenrecord --time-limit 6 ${clipDevice}`,
      ]);
      // Subscribe BEFORE any waiting: screenrecord can exit immediately
      // (no storage, device drop), and a listener attached after the
      // one-shot close event would leave the gate hanging with no
      // timeout. The bound is comfortably past the 6 s recording limit.
      const recDone = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('screenrecord did not finish within 20 s — device unresponsive?')),
          20000,
        );
        const settle = (code) => {
          clearTimeout(timer);
          resolve(code);
        };
        rec.on('close', settle);
        rec.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      await new Promise((r) => setTimeout(r, 1000));
      shell(`input tap ${Math.round(finish.x)} ${Math.round(finish.y)}`);
      const recCode = await recDone;
      // A recorder that died produced no clip for THIS run — pulling
      // would analyze nothing (or fail confusingly at the pull).
      if (recCode !== 0)
        throw new Error(`screenrecord exited with code ${recCode} — no clip for this run`);
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
      // Prove the advance actually happened: a missed or refused tap
      // leaves the same unit on screen, and the pixel checks below would
      // inspect steady chrome and pass vacuously. Both anchors are
      // MANDATORY — an unreadable header proves nothing (codex round 2).
      const headerAfter = findNode(after, /^(Group|Singles) · /);
      if (!headerAfter)
        throw new Error(
          `no deck header line in the post-tap dump — probe cannot prove an advance; clip saved to ${clipHost}`,
        );
      if (headerAfter.text === headerBefore.text)
        throw new Error(
          `the deck header still reads "${headerBefore.text}" — the finish tap did not advance the unit; clip saved to ${clipHost}`,
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
      // Blank = too FEW lit pixels, not a dark maximum (codex round 3):
      // a single bright badge pixel or compression artifact must not
      // pass an otherwise-empty stage. 0.5% clears a thin moon crescent
      // (~2% lit on the emulator corpus) while any real photo clears it
      // by orders of magnitude.
      let stagePixels = 0;
      let minStageLitFrac = 1;
      let minGreen = Infinity;
      let maxGreen = 0;
      for (let f = 0; f < frames; f += 1) {
        const base = f * frameBytes;
        let stageLit = 0;
        stagePixels = 0;
        for (let y = Math.round(H * 0.18); y < Math.round(H * 0.52); y += 1)
          for (let x = Math.round(W * 0.05); x < Math.round(W * 0.95); x += 1) {
            const i = base + (y * W + x) * 3;
            stagePixels += 1;
            if (Math.max(raw[i], raw[i + 1], raw[i + 2]) >= 60) stageLit += 1;
          }
        let green = 0;
        for (let y = Math.round(H * 0.78); y < Math.round(H * 0.97); y += 1)
          for (let x = 0; x < W; x += 1) {
            const i = base + (y * W + x) * 3;
            if (raw[i + 1] > 45 && raw[i + 1] > raw[i] * 1.35 && raw[i + 1] > raw[i + 2] * 1.35)
              green += 1;
          }
        const litFrac = stageLit / stagePixels;
        if (litFrac < minStageLitFrac) minStageLitFrac = litFrac;
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
      if (minStageLitFrac < 0.005)
        throw new Error(
          `stage read as blank in at least one frame (${(minStageLitFrac * 100).toFixed(2)}% lit) — inspect ${clipHost} before trusting this: an all-black photo (pocket shot) inside the transition can trip this probe`,
        );
    },
  );

  await dependentStep(
    'back home: the badges tell the per-kind suspension rule (F21)',
    null,
    async () => {
      for (let i = 0; i < 4; i += 1) {
        if (findNode(dumpUi(), /^Daily goal/)) break;
        shell('input keyevent KEYCODE_BACK');
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!(await findHomeRow(/^Cull list$/, 20000)))
        throw new Error('the Cull list row never came into view');
      // THE LIVE RULE, and the only place it is observable: the first photo
      // was favourited and shared and THEN staged to cull. Per-kind
      // suspension (m0.8.7, F21): favourite and organize SUSPEND — those
      // badges land back where they started, because decorating or filing
      // a photo you are about to delete makes no sense — while share stays
      // LIVE (+1): share-then-delete is a real flow, so the pending share
      // keeps counting right up to the trash. Suspended rows still exist
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
          share === before.share + 1
        )
          return;
        if (Date.now() > deadline)
          throw new Error(
            `per-kind suspension (F21) not observed: favourite ${favourite} (expected ${before.favourite}), ` +
              `organize ${organize} (expected ${before.organize}), ` +
              `share ${share} (expected ${before.share + 1} — share stays live on a staged cull)`,
          );
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  );

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
  await step(
    'a tapped video or motion-photo page shows its play control (when the newest unit holds one)',
    null,
    async () => {
      // Phase 5: the playback chrome is hidden until the stage is tapped
      // (tester, 2026-09-10). With Playback parked on Off (the preflight)
      // a tapped video page shows its "Play" control and a tapped motion
      // photo "Play motion photo", and a stopped clip keeps its chrome up,
      // so the dump sees it. A PHOTO answers the same tap with immersive,
      // which a second tap undoes before the next swipe. The newest unit
      // is walked for up to eight pages; a library whose newest unit holds
      // neither passes with a note (seed one to exercise this —
      // docs/MOBILE_UI_GATE.md). Keep on the page proves the verdict path
      // takes the kind.
      await ensureForeground();
      await waitForHome();
      const indicator = await openFromHome(/^Continue reviewing$/, /^\d+\/\d+$/, 'pager indicator');
      const total = Number(indicator.node.text.split('/')[1]);
      let found = null;
      for (let page = 0; page < Math.min(total, 8) && !found; page += 1) {
        tapStage();
        // Positive evidence either way, never a bare missing control: a
        // failed dump (empty) or a motion clip still extracting also show
        // no Play. A playable page answers with an anchored Play control;
        // a photo's tap entered immersive, which drops the action row.
        let immersive = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const nodes = dumpUi();
          if (nodes.length === 0) continue;
          found = findNode(nodes, /^Play$|^Play motion photo$/) ?? null;
          if (found) break;
          if (!findNode(nodes, /^Keep$/)) {
            immersive = true;
            break;
          }
        }
        if (found) break;
        if (!immersive)
          throw new Error('the stage tap produced neither a Play control nor immersive');
        // A photo: leave immersive before moving on.
        tapStage();
        await waitFor(/^Keep$/, 8000, 'the deck after leaving immersive');
        if (page + 1 < Math.min(total, 8)) {
          swipeDeckLeft();
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      if (!found) {
        console.log(
          "   (no video or motion photo among the newest unit's first pages — control check skipped)",
        );
      } else {
        const before = (await waitFor(/^\d+\/\d+$/, 5000, 'pager indicator')).node.text;
        await tapText(/^Keep$/, 10000);
        await new Promise((r) => setTimeout(r, 1500));
        const after = dumpUi();
        // Keep either advanced the pager or, on the last page, left the
        // indicator alone with the verdict taken — the badge is not
        // dumpable, so the advance is the assertion we can make.
        const now = findNode(after, /^\d+\/\d+$/)?.text ?? null;
        if (now === null) throw new Error('deck lost after Keep on a video/motion page');
        if (now === before && Number(before.split('/')[0]) < total)
          throw new Error(`Keep on a ${found.desc} page did not advance (${before} → ${now})`);
      }
      shell('input keyevent KEYCODE_BACK');
      await waitForHome();
    },
  );

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
    await tapText(tabPattern('Edit'), 20000); // the TAB
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
    await openFromHome(/\d+ to review$/, /^Timeline$/, 'overview heading');
    await waitFor(/^(Group|Singles) ·/, 20000, 'timeline cards');
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
  });

  // The album picker moved from the deck to the Organize queue (m0.8.2
  // F6) — exercise it there, mutation-free: open the sheet, close it.
  // The queue may legitimately be empty (the toggled photo above was
  // culled away), in which case the empty-state copy is the assertion.
  await step('organize queue hosts the album picker', null, async () => {
    await tapText(tabPattern('Organize'), 20000); // the TAB
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
    {
      const row = await findHomeRow(/^Cull list$/, 20000);
      if (!row) throw new Error('the Cull list row never came into view');
      tap(row);
    }
    await waitFor(/\d+ staged ·/, 20000, 'cull list screen');
    shell('input keyevent KEYCODE_BACK');
    // Home keeps its scroll position: the next step taps History in the
    // top action row (codex round 11).
    await waitForHome();
  });

  // The deck's LIST MODE (m0.9 phase 2 — the retired standard viewer's
  // successor: every grid, queue and History row opens the deck over its
  // own list). Same pager, different list plumbing (the resolver table,
  // the anchor contract), and nothing else in this walk touches it.
  // Reached through History because its rows are addressable by their
  // date text, and by this point the walk's own decisions have put rows
  // there.
  await step('deck list mode pages between photos', null, async () => {
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
    const opened = await waitFor(/^\d+\/\d+$/, 20000, 'deck list position indicator');
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
          throw new Error(`deck list stuck at ${pos}/${total} — its pager cannot be swiped`);
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
await step('animated thumbnails play on the Progress grid', null, async () => {
  // Phase 6's validation: with
  // the row on All visible the Progress grid's clips PLAY — the
  // controller logs the playing set to the diag sink — and the row goes
  // back to Off for the phone's next walk. The grid cannot be dumped
  // while it plays (no UI idle), so the sink is the assertion.
  const since = new Date().toISOString();
  // The walk before this may have backed out of the app (a cold relaunch
  // takes seconds) or left the shade down: collapse it, bring Afterglow
  // back, and wait for Home to RENDER before any scroll — a scroll-up on
  // the launcher opens the shade.
  shell('cmd statusbar collapse');
  await ensureForeground();
  await waitFor(/^Daily goal/, 30000, 'home after relaunch');
  await waitForHome();
  // MEASURE the grid's position while playback is still Off (dumps idle):
  // how many short scrolls bring the grid header into view on THIS window
  // (its header and insights wrap at large text and on narrow screens —
  // codex round 15); the same count replays blind once playback is on.
  let gridSteps = 0;
  {
    const row = await findHomeRow(/^◔, Progress, /, 10000);
    if (!row) throw new Error('the Progress row never came into view');
    tap(row);
    await waitFor(/^Unreviewed$/, 20000, 'verdict chips');
    const { height } = screenSize();
    const deadline = Date.now() + 20000;
    for (;;) {
      const node = findNode(dumpUi(), /^ITEMS · /);
      if (node && node.y1 > height * 0.05 && node.y2 < height * 0.95) break;
      if (Date.now() > deadline) throw new Error('the grid header never came into view');
      scrollDown(0.3);
      gridSteps += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
  }
  await tapText(/^Settings$/, 10000);
  await waitFor(/^Photo source$/, 15000, 'settings screen');
  try {
    await selectPlaybackChip(/^Animated thumbnails$/, 'All');
    shell('input keyevent KEYCODE_BACK');
    await waitForHome();
    // The card's subtitle is dynamic ("All items · state browsing" or a
    // pace line): match its title only.
    {
      const row = await findHomeRow(/^◔, Progress, /, 10000);
      if (!row) throw new Error('the Progress row never came into view');
      tap(row);
    }
    // Thumbnails play only when viewable: replay the measured scrolls
    // plus one BLIND — a playing clip keeps the UI from idling and a dump
    // would wait on it (codex round 14; the step's own rule).
    for (let i = 0; i < gridSteps + 1; i += 1) {
      scrollDown(0.3);
      await new Promise((r) => setTimeout(r, 600));
    }
    // Let the grid load, its visible set settle (500 ms) and its
    // players borrow; then read the sink.
    await new Promise((r) => setTimeout(r, 6000));
    const lines = shell(
      `grep -h '\\[thumbs\\] framed' /sdcard/Android/data/${APP_ID}/files/diag/*.log 2>/dev/null || true`,
    )
      .split('\n')
      .filter((l) => l.trim() !== '' && l.slice(0, 24) >= since);
    // Evidence of PLAYBACK, not of an eligible row: a clip's first frame
    // reaching the screen is what AnimatedThumb logs (codex, m0.9
    // close-out rounds 7 and 8) — the settled-cells line counted
    // eligible rows, not borrowed players, and passed on a still-only
    // or a failing screenful.
    const framed = lines.find((l) => /\[thumbs\] framed \S+/.test(l));
    if (!framed) {
      throw new Error(
        `no [thumbs] framed line since ${since} — no clip thumbnail rendered a frame (lines: ${lines.length}); a corpus without a clip in its first screenful lands here: seed a video or a motion photo`,
      );
    }
  } finally {
    // The row goes back to Off whatever happened above; a failure HERE
    // must not mask the step's own error, so it is logged, not thrown.
    try {
      shell('cmd statusbar collapse');
      shell('input keyevent KEYCODE_BACK');
      await waitForHome();
      await tapText(/^Settings$/, 10000);
      await waitFor(/^Photo source$/, 15000, 'settings screen');
      await selectPlaybackChip(/^Animated thumbnails$/, 'Off');
      shell('input keyevent KEYCODE_BACK');
      await waitForHome();
    } catch (error) {
      console.warn(`  … could not park Animated thumbnails on Off afterwards: ${String(error)}`);
    }
  }
});

console.log(failures === 0 ? '\nGATE PASSED' : `\nGATE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
