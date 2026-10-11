/**
 * The adb UI driver the mobile UI gate and the accessibility walk share:
 * one device's shell, uiautomator dumps parsed to flat nodes, waits and
 * taps by text, Home recovery, stage gestures in device coordinates,
 * foreground recovery and screenshots. Everything here was the gate's own
 * (scripts/mobile-ui-gate.mjs) until the m0.9.1 accessibility walk needed
 * the same hands; the rules learnt on the phones travel with the code:
 *
 * - A dump that fails to reach UI idle writes NOTHING, so the file is
 *   deleted before every dump and a failed read returns [] for the caller
 *   to poll again — never a stale hierarchy.
 * - Zero-area nodes (detached inactive-tab screens) are dropped: matching
 *   one sends taps to (0,0).
 * - Home is asserted at its TOP ("Daily goal" as a prefix, scrolling up):
 *   being on Home and being at the top of Home are different claims.
 * - A double tap is two `input` processes started together on the
 *   device; two adb round trips land past the app's 300 ms window.
 * - Foreground theft is detected and named; PiP-capable offenders are
 *   force-stopped outright, since a PiP window steals taps without
 *   taking the foreground.
 */
import { execFileSync } from 'node:child_process';

export function adbRaw(list, opts = {}) {
  return execFileSync('adb', list, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** The serial to drive: the one given, else the single connected device. */
export function resolveSerial(given) {
  if (given) return given;
  const lines = adbRaw(['devices'])
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().endsWith('device'));
  if (lines.length === 0) throw new Error('no adb device connected');
  if (lines.length > 1)
    throw new Error('multiple devices connected — pass --serial (see `adb devices`)');
  return lines[0].split('\t')[0];
}

const PIP_OFFENDERS = [
  'com.google.android.youtube',
  'com.android.chrome',
  'com.sec.android.app.sbrowser', // Samsung Internet
  'org.videolan.vlc',
  'com.netflix.mediaclient',
  'com.google.android.apps.tachyon', // Google Meet
  'com.mxtech.videoplayer.ad', // MX Player
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDriver(serial, appId) {
  const adb = (...a) => adbRaw(['-s', serial, ...a]);
  const shell = (cmd) => adb('shell', cmd);

  /** The raw `uiautomator dump` XML, or '' when the UI never idled. */
  function dumpRaw() {
    shell(
      'rm -f /sdcard/ag-ui-gate.xml; uiautomator dump /sdcard/ag-ui-gate.xml >/dev/null 2>&1 || true',
    );
    try {
      return adb('exec-out', 'cat', '/sdcard/ag-ui-gate.xml');
    } catch {
      return '';
    }
  }

  /** Parse `uiautomator dump` XML into flat nodes (regex — no deps). */
  function dumpUi(xml = dumpRaw()) {
    if (xml === '') return []; // dump failed (busy UI) — caller polls again
    const nodes = [];
    for (const tag of xml.match(/<node[^>]*>/g) ?? []) {
      const attr = (name) => {
        const m = tag.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : '';
      };
      const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) continue;
      if (Number(b[3]) <= Number(b[1]) || Number(b[4]) <= Number(b[2])) continue;
      nodes.push({
        text: attr('text'),
        desc: attr('content-desc'),
        enabled: attr('enabled') === 'true',
        selected: attr('selected') === 'true',
        x: (Number(b[1]) + Number(b[3])) / 2,
        y: (Number(b[2]) + Number(b[4])) / 2,
        x1: Number(b[1]),
        y1: Number(b[2]),
        x2: Number(b[3]),
        y2: Number(b[4]),
      });
    }
    return nodes;
  }

  let cachedSize = null;
  /** Physical screen size, cached per driver. */
  function screenSize() {
    if (cachedSize) return cachedSize;
    const out = shell('wm size');
    const m = out.match(/Physical size: (\d+)x(\d+)/) ?? out.match(/(\d+)x(\d+)/);
    cachedSize = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2280 };
    return cachedSize;
  }

  const matches = (node, re) => re.test(node.text) || re.test(node.desc);
  const findNode = (nodes, re) => nodes.find((n) => matches(n, re));

  /** The gate's scroll gestures in screen proportions: the gate's fixed
   * 540,1700 → 540,600 on the 1080 × 2280 phones, as fractions of the
   * height around its midpoint, so the 720 × 1280 emulator scrolls too
   * (its y=1700 start lay below the screen, and the walk saw a Settings
   * that never scrolled). `fraction` is the swipe's length as a share of
   * the height; a search for a row below the fold takes short steps so
   * it cannot scroll past the row. */
  function scrollDown(fraction = 0.482) {
    const { width, height } = screenSize();
    const x = Math.round(width / 2);
    const from = Math.round(height * (0.504 + fraction / 2));
    const to = Math.round(height * (0.504 - fraction / 2));
    shell(`input swipe ${x} ${from} ${x} ${to} 300`);
  }
  function scrollUp(fraction = 0.482) {
    const { width, height } = screenSize();
    const x = Math.round(width / 2);
    const from = Math.round(height * (0.504 - fraction / 2));
    const to = Math.round(height * (0.504 + fraction / 2));
    shell(`input swipe ${x} ${from} ${x} ${to} 300`);
  }

  /** Home's top anchor: the brand title WITH its Settings button on
   * screen and no back button — Settings' About card says "Afterglow"
   * too, and that word alone passed a scrolled-down Settings as Home
   * (the r19 walks). The goal line is NOT the top: at large text it
   * stays on screen with the brand row scrolled off above it, and the
   * gate's next tap on History or Settings then found nothing (the
   * emulator at 2.0, r23). Null when the dump is not Home's top. */
  function homeTop(nodes) {
    const brand = findNode(nodes, /^Afterglow$/);
    return brand && findNode(nodes, /^Settings$/) && !findNode(nodes, /^Navigate up$/)
      ? brand
      : null;
  }

  /** Wait for the TOP of Home, scrolling back up to find it: the brand
   * title or the goal line (at huge text on a narrow screen only the
   * title and the ring fit the first screen), clear of the status bar
   * (a line under it took a tap meant for the row). */
  async function waitForHome(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    const statusBar = screenSize().height * 0.035;
    for (let scrolls = 0; ; scrolls += 1) {
      const nodes = dumpUi();
      const top = nodes.length > 0 && homeTop(nodes);
      if (top && top.y1 > statusBar) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the top of Home');
      // An empty dump is a list still flinging (the S10e at 2.0): let it
      // settle rather than throw another swipe into the fling, which
      // never let the dump idle (the r23 gate's History step).
      if (nodes.length === 0) {
        await sleep(600);
        continue;
      }
      // A downward swipe at the top of Home pulled the S10e's quick
      // panel over the app once (r16 walk): fold it before each scroll.
      shell('cmd statusbar collapse');
      // Long strides, and enough of them for a Home that lists sixty
      // day cards at 2.0 (the S10e): eight half-screen scrolls fell short.
      if (scrolls < 24) scrollUp(0.8);
      await sleep(700);
    }
  }

  /** The pager swipes run at the measured stage's height (codex round
   * 5: at 2.0× the stage sits lower than the fixed 38 % point). */
  function swipeDeckLeft() {
    const { width } = screenSize();
    const { y } = stagePoint();
    shell(`input swipe ${Math.round(width * 0.8)} ${y} ${Math.round(width * 0.12)} ${y} 250`);
  }
  function swipeDeckRight() {
    const { width } = screenSize();
    const { y } = stagePoint();
    shell(`input swipe ${Math.round(width * 0.12)} ${y} ${Math.round(width * 0.8)} ${y} 250`);
  }
  /** The deck's stage box from a dump: the smallest near-full-width node
   * holding the position line ("3/12"). Null when no deck is up. */
  function stageRect(nodes = dumpUi()) {
    const pos = findNode(nodes, /^\d+\/\d+$/);
    if (!pos) return null;
    const { width } = screenSize();
    const area = (n) => (n.x2 - n.x1) * (n.y2 - n.y1);
    const holders = nodes.filter(
      (n) =>
        n.x2 - n.x1 > width * 0.85 &&
        n.y2 - n.y1 > (n.x2 - n.x1) * 0.15 &&
        n.x1 <= pos.x &&
        pos.x <= n.x2 &&
        n.y1 <= pos.y &&
        pos.y <= n.y2,
    );
    if (holders.length === 0) return null;
    return holders.reduce((a, b) => (area(b) < area(a) ? b : a));
  }
  /** A point on the stage no corner box covers: right of the metadata
   * box's 56 % and below it — at 2.0 on the S10e its four lines reach
   * 58 % of the stage, and a pager swipe that STARTS on that box (a
   * sibling above the pager) pages nothing (the r23 gate stuck at 3/5)
   * — so 70 % down, above the bottom marks at about 88 %. Without a
   * deck dump, the gate's old fixed point (mid-width, 38 % down). */
  function stagePoint() {
    const { width, height } = screenSize();
    // A dump that did not idle (the pager still settling) is retried,
    // not read as "no deck": the fallback point is a guess.
    let nodes = dumpUi();
    for (let attempt = 0; attempt < 2 && nodes.length === 0; attempt += 1) nodes = dumpUi();
    const stage = stageRect(nodes);
    if (!stage) return { x: Math.round(width / 2), y: Math.round(height * 0.38) };
    // The row of the stage the gestures run on: the first of these
    // shares, 70 % first, whose span from 12 % to 80 % of the width meets
    // no overlay node (a text or labelled box inside the stage — the
    // metadata box, the position, the marks). On a 320 dp window at 2.0
    // the boxes cover 6 % to 90 % of the stage and the free row is at
    // its foot (codex round 18); on the phones 70 % is free.
    const overlays = nodes.filter(
      (n) =>
        (n.text || n.desc) &&
        n !== stage &&
        n.x1 >= stage.x1 &&
        n.x2 <= stage.x2 &&
        n.y1 >= stage.y1 &&
        n.y2 <= stage.y2 &&
        n.y2 - n.y1 < (stage.y2 - stage.y1) * 0.9,
    );
    const spanX1 = width * 0.12;
    const spanX2 = width * 0.8;
    const rowFree = (y) =>
      !overlays.some((n) => n.y1 <= y && y <= n.y2 && n.x1 < spanX2 && n.x2 > spanX1);
    const shares = [0.7, 0.8, 0.9, 0.6, 0.5, 0.95, 0.4, 0.3];
    const share = shares.find((f) => rowFree(stage.y1 + (stage.y2 - stage.y1) * f)) ?? 0.7;
    return {
      x: Math.round(stage.x1 + (stage.x2 - stage.x1) * 0.62),
      y: Math.round(stage.y1 + (stage.y2 - stage.y1) * share),
    };
  }
  function tapStage() {
    const { x, y } = stagePoint();
    shell(`input tap ${x} ${y}`);
  }
  function doubleTapStage() {
    const { x, y } = stagePoint();
    shell(`input tap ${x} ${y} & (sleep 0.12; input tap ${x} ${y}); wait`);
  }

  /** The deck pager position as [current, total], or null. */
  function pagerPosition(nodes = dumpUi()) {
    const node = findNode(nodes, /^\d+\/\d+$/);
    if (!node) return null;
    const [pos, total] = node.text.split('/').map(Number);
    return [pos, total];
  }

  /** Poll until a node matching `re` appears; returns { node, ms }. */
  async function waitFor(re, timeoutMs, label = String(re)) {
    const start = Date.now();
    for (let attempts = 0; ; attempts += 1) {
      const node = findNode(dumpUi(), re);
      if (node) return { node, ms: Date.now() - start };
      if (attempts >= 1 && Date.now() - start > timeoutMs)
        throw new Error(`timed out waiting for ${label}`);
      await sleep(150);
    }
  }

  /** Poll until NO node matches `re`; only a successful dump counts. */
  async function waitGone(re, timeoutMs, label = String(re)) {
    const start = Date.now();
    for (;;) {
      const nodes = dumpUi();
      if (nodes.length > 0 && !findNode(nodes, re)) return { ms: Date.now() - start };
      if (Date.now() - start > timeoutMs) throw new Error(`${label} still visible`);
      await sleep(150);
    }
  }

  const tap = (node) => shell(`input tap ${Math.round(node.x)} ${Math.round(node.y)}`);
  async function tapText(re, timeoutMs = 20000) {
    const { node } = await waitFor(re, timeoutMs);
    tap(node);
  }

  function foregroundPackage() {
    const focus = shell(
      'dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp" | head -2',
    );
    const match = /([A-Za-z][\w.]+)\/[\w.]+/.exec(focus);
    return match ? match[1] : null;
  }

  function dismissPipOverlays() {
    for (const pkg of PIP_OFFENDERS) shell(`am force-stop ${pkg} 2>/dev/null || true`);
  }

  async function ensureForeground() {
    const front = foregroundPackage();
    if (front === null || front === appId) return;
    console.warn(`  … ${front} took the foreground; returning to Afterglow`);
    dismissPipOverlays();
    shell(`am start -n ${appId}/.MainActivity >/dev/null`);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (foregroundPackage() === appId) return;
      await sleep(500);
    }
    throw new Error(`${front} holds the foreground — Afterglow would not come back`);
  }

  /** A PNG screenshot as a Buffer. */
  const screenshot = () =>
    adbRaw(['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' });

  return {
    serial,
    adb,
    shell,
    dumpRaw,
    dumpUi,
    screenSize,
    findNode,
    matches,
    scrollDown,
    stageRect,
    homeTop,
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
    screenshot,
    sleep,
  };
}
