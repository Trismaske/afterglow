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

  /** The gate's scroll gestures, exactly as they were (fixed
   * coordinates: both test phones scroll fine with them). */
  function scrollDown() {
    shell('input swipe 540 1700 540 600 300');
  }
  function scrollUp() {
    shell('input swipe 540 600 540 1700 300');
  }

  /** Wait for the TOP of Home, scrolling back up to find it. */
  async function waitForHome(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    for (let scrolls = 0; ; scrolls += 1) {
      const nodes = dumpUi();
      if (nodes.length > 0 && findNode(nodes, /^Daily goal/)) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the top of Home');
      if (scrolls < 8) scrollUp();
      await sleep(400);
    }
  }

  function swipeDeckLeft() {
    const { width, height } = screenSize();
    const y = Math.round(height * 0.38);
    shell(`input swipe ${Math.round(width * 0.8)} ${y} ${Math.round(width * 0.12)} ${y} 250`);
  }
  function swipeDeckRight() {
    const { width, height } = screenSize();
    const y = Math.round(height * 0.38);
    shell(`input swipe ${Math.round(width * 0.12)} ${y} ${Math.round(width * 0.8)} ${y} 250`);
  }
  function tapStage() {
    const { width, height } = screenSize();
    shell(`input tap ${Math.round(width / 2)} ${Math.round(height * 0.38)}`);
  }
  function doubleTapStage() {
    const { width, height } = screenSize();
    const x = Math.round(width / 2);
    const y = Math.round(height * 0.38);
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
