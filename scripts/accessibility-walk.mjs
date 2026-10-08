#!/usr/bin/env node
/**
 * The accessibility walk (m0.9.1 phase 1, docs/Plan_m0.9.1.md): the same
 * screens screenshotted at every OS font-scale step and display size, so
 * the per-site text audit gets its measured break scales.
 *
 * For each (font scale × density) the walk sets the device's
 * `font_scale` and `wm density`, cold-relaunches the app, and captures
 * the screen list below into
 * `<report>/<serial>/f<font>-d<density>/<screen>.png`, with a
 * `geometry.json` beside them (the dp width the app saw). The device's
 * starting font scale and density are restored at the end, and on any
 * failure — the S23 is a personal phone whose settings must come back.
 *
 * READ-ONLY on review state: the walk taps nothing that decides,
 * queues or deletes (the deck is entered and left, immersive toggled
 * with a stage tap). It may therefore run on a phone whose review state
 * matters, unlike the UI gate.
 *
 * Usage:
 *   node scripts/accessibility-walk.mjs --serial SERIAL [--report-dir DIR]
 *        [--fonts 0.8,1.0,1.3,2.0] [--densities default,0.85,1.15]
 *        [--screens home,settings,...]
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriver, resolveSerial } from './lib/ui-driver.mjs';

const APP_ID = 'com.afterglow.companion';
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const SERIAL = resolveSerial(argOf('--serial'));
const REPORT_DIR = argOf('--report-dir') ?? 'accessibility-walk-report';
const FONTS = (argOf('--fonts') ?? '0.8,0.85,1.0,1.15,1.3,1.5,1.8,2.0').split(',').map(Number);
const DENSITIES = (argOf('--densities') ?? 'default,0.85,1.15').split(',');
const ONLY = argOf('--screens')?.split(',') ?? null;

// One walk per phone: two walks on one serial record each other's values
// as the phone's starting state and restore the wrong ones (2026-10-09).
// The lock is taken with an exclusive create (no check-then-write
// window) and released only after the restore has run.
const LOCK = join(tmpdir(), `afterglow-walk-${SERIAL.replace(/[^\w.-]+/g, '_')}.lock`);
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(LOCK, 'utf8').trim());
      let alive = false;
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive)
        throw new Error(`another walk (pid ${holder}) holds ${SERIAL}; wait for it or stop it`);
      // A dead holder's lock is taken over by RENAMING it: only one of two
      // concurrent takers can rename the same path, so the loser sees
      // ENOENT, retries the exclusive create and finds the winner's lock
      // (codex round 3). The renamed file is removed by the winner.
      const stale = `${LOCK}.stale.${process.pid}`;
      try {
        renameSync(LOCK, stale);
        rmSync(stale, { force: true });
      } catch {
        /* the other taker renamed it first; the next create tells */
      }
    }
  }
  throw new Error(`could not take the walk lock for ${SERIAL}`);
}
acquireLock();
const d = createDriver(SERIAL, APP_ID);
const { shell, sleep, dumpUi, findNode } = d;

// ------------------------------------------------------ device settings
const startingFont = shell('settings get system font_scale').trim();
/** The stay-on mask as found (`svc power stayon true` rewrites it). */
const startingStayOn = shell('settings get global stay_on_while_plugged_in').trim();
const physicalDensity = Number(shell('wm density').match(/Physical density: (\d+)/)?.[1]);
const overrideMatch = shell('wm density').match(/Override density: (\d+)/);
const startingDensity = overrideMatch ? Number(overrideMatch[1]) : null;
if (!physicalDensity) throw new Error(`could not read the physical density of ${SERIAL}`);

let restoring = false;
let restored = false;
/** Puts the phone back as found. Each setting is attempted on its own and
 * a failure is reported, never allowed to strand the next one; the lock
 * goes only once the restore has run (codex round 2). */
function restore() {
  if (restoring || restored) return;
  restoring = true;
  const steps = [
    [
      'font scale',
      startingFont === 'null' || startingFont === ''
        ? 'settings delete system font_scale'
        : `settings put system font_scale ${startingFont}`,
    ],
    ['density', startingDensity ? `wm density ${startingDensity}` : 'wm density reset'],
    [
      'stay-on',
      startingStayOn === 'null' || startingStayOn === ''
        ? 'settings delete global stay_on_while_plugged_in'
        : `settings put global stay_on_while_plugged_in ${startingStayOn}`,
    ],
  ];
  const failed = [];
  for (const [what, cmd] of steps) {
    try {
      shell(cmd);
    } catch (error) {
      failed.push(`${what}: ${error.message}`);
    }
  }
  restored = failed.length === 0;
  restoring = false;
  if (failed.length > 0) {
    console.error(
      `RESTORE INCOMPLETE on ${SERIAL}: ${failed.join(' | ')} — put back by hand: ${steps.map((s) => s[1]).join('; ')}`,
    );
  } else {
    console.log(
      `restored ${SERIAL}: font_scale ${startingFont}, density ${startingDensity ?? 'physical'}, stay-on ${startingStayOn}`,
    );
  }
  try {
    rmSync(LOCK, { force: true });
  } catch {
    /* the lock is best effort */
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}
// Whatever ends the process — a signal, an uncaught error, the normal
// end — the phone comes back as found (the S10e was left at a walk's
// values once, 2026-10-09; restore() runs at most once).
process.on('exit', restore);
process.on('uncaughtException', (error) => {
  console.error(error);
  restore();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(reason);
  restore();
  process.exit(1);
});

function densityFor(step) {
  if (step === 'default') return startingDensity ?? physicalDensity;
  return Math.round((startingDensity ?? physicalDensity) * Number(step));
}

async function relaunch() {
  // A phone locks between relaunches (the S10e, 2026-10-08): wake it and
  // drop the keyguard first. A scroll on the launcher opens the shade
  // (the gate's lesson); the relaunch starts from a collapsed status bar.
  shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; cmd statusbar collapse');
  shell(`am force-stop ${APP_ID}`);
  await sleep(800);
  for (let attempt = 0; ; attempt += 1) {
    shell(`monkey -p ${APP_ID} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
    try {
      await d.waitFor(/^Daily goal|Allow photo access/, 45000, 'home after relaunch');
      break;
    } catch (error) {
      if (attempt >= 1) throw error;
      shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; cmd statusbar collapse');
    }
  }
  await d.waitForHome();
}

// ------------------------------------------------------------ screens
let shots = [];
let dir = '';
let failures = [];
/** A screenshot plus the raw UI dump beside it: the dump is what the
 * overlap and clipping analysis reads (scripts/accessibility-report.mjs).
 * A dump that never idles is retried, and one still empty is RECORDED as
 * missing evidence rather than saved as an empty hierarchy (codex). */
function shot(name) {
  writeFileSync(join(dir, `${name}.png`), d.screenshot());
  let xml = '';
  for (let attempt = 0; attempt < 3 && xml === ''; attempt += 1) xml = d.dumpRaw();
  if (xml === '') failures.push(`${name}: no UI dump (the UI never idled)`);
  else writeFileSync(join(dir, `${name}.xml`), xml);
  shots.push(name);
}
async function home() {
  await d.waitForHome();
}
const backHome = async () => {
  for (let i = 0; i < 4; i += 1) {
    const nodes = dumpUi();
    if (nodes.length > 0 && findNode(nodes, /^Daily goal/)) return;
    shell('input keyevent KEYCODE_BACK');
    await sleep(700);
  }
  await d.waitForHome();
};

const SCREENS = {
  async home() {
    await home();
    shot('home');
    d.scrollDown();
    await sleep(500);
    shot('home-2');
    await d.waitForHome();
  },
  async settings() {
    await d.tapText(/^Settings$/, 10000);
    await d.waitFor(/^Photo source$/, 15000, 'settings');
    shot('settings');
    d.scrollDown();
    await sleep(500);
    shot('settings-2');
    d.scrollDown();
    await sleep(500);
    shot('settings-3');
    d.scrollDown();
    await sleep(500);
    shot('settings-4');
    await backHome();
  },
  async stats() {
    await d.tapText(/^Stats$/, 20000);
    await d.waitFor(/^Forecast$/, 20000, 'stats tabs');
    await sleep(800);
    shot('stats-activity');
    await d.tapText(/^Forecast$/, 20000);
    await sleep(800);
    shot('stats-forecast');
    await d.tapText(/^Habits$/, 20000);
    await sleep(800);
    shot('stats-habits');
    await backHome();
  },
  async history() {
    await d.tapText(/^History$/, 20000);
    await d.waitFor(/^All$/, 20000, 'history filters');
    await sleep(800);
    shot('history');
    await backHome();
  },
  async progress() {
    await d.waitForHome();
    // The Progress row sits below the fold on a long Home — further
    // down the larger the text: find it.
    for (let i = 0; i < 10; i += 1) {
      const node = findNode(dumpUi(), /^◔, Progress, /);
      if (node) {
        d.tap(node);
        break;
      }
      d.scrollDown();
      await sleep(400);
    }
    await d.waitFor(/^Unreviewed$/, 20000, 'progress chips');
    await sleep(1200);
    shot('progress');
    d.scrollDown();
    await sleep(600);
    shot('progress-2');
    await backHome();
  },
  async timeline() {
    await d.waitForHome();
    await d.tapText(/\d+ to review$/, 20000);
    await d.waitFor(/^Unfinished$|^Everything$/, 20000, 'timeline filters');
    await sleep(1000);
    shot('timeline');
    await backHome();
  },
  async deck() {
    await d.waitForHome();
    // At huge text the button sits below the fold: scroll to it.
    for (let i = 0; i < 6; i += 1) {
      if (findNode(dumpUi(), /^Continue reviewing$/)) break;
      d.scrollDown();
      await sleep(400);
    }
    await d.tapText(/^Continue reviewing$/, 20000);
    await d.waitFor(/^\d+\/\d+$/, 30000, 'deck position');
    await sleep(1200);
    shot('deck');
    d.tapStage();
    await sleep(1400);
    shot('deck-immersive');
    d.tapStage();
    await sleep(1200);
    await backHome();
  },
  async cull() {
    await d.waitForHome();
    const node = findNode(dumpUi(), /^Cull list$/);
    if (!node) return;
    d.tap(node);
    await sleep(1200);
    shot('cull-list');
    await backHome();
  },
  async tabs() {
    // The tab bar lives on the five tab surfaces, so each queue tab is
    // reached from Home and left through the Home tab (back exits
    // through Home too, but the tab is what a user taps).
    for (const tab of ['Edit', 'Favourite', 'Organize', 'Share']) {
      await d.waitForHome();
      await d.tapText(new RegExp(`^${tab}$`), 10000);
      await sleep(1000);
      shot(`tab-${tab.toLowerCase()}`);
      await d.tapText(/^Home$/, 10000);
      await sleep(600);
    }
    await d.waitForHome();
  },
};

// ---------------------------------------------------------------- run
const manifest = [];
// The screen stays on for the walk (restored with the settings): a
// phone that locks mid-walk fails every later relaunch.
shell('svc power stayon true');
try {
  for (const density of DENSITIES) {
    const dpi = densityFor(density);
    shell(density === 'default' && !startingDensity ? 'wm density reset' : `wm density ${dpi}`);
    for (const font of FONTS) {
      shell(`settings put system font_scale ${font}`);
      await sleep(600);
      dir = join(REPORT_DIR, SERIAL.replace(/[^\w.-]+/g, '_'), `f${font}-d${density}`);
      mkdirSync(dir, { recursive: true });
      // A rerun starts the combination clean: a stale dump beside a new
      // screenshot would be read as this run's evidence (codex round 2).
      for (const entry of readdirSync(dir))
        if (/\.(png|xml|json)$/.test(entry)) unlinkSync(join(dir, entry));
      shots = [];
      failures = [];
      try {
        await relaunch();
      } catch (error) {
        // One combination's relaunch failing must not end the matrix.
        failures.push(`relaunch: ${error.message}`);
        writeFileSync(
          join(dir, 'geometry.json'),
          JSON.stringify({ font, density, failures }, null, 2),
        );
        manifest.push({
          serial: SERIAL,
          fontScale: font,
          densityStep: density,
          shots: 0,
          failures,
        });
        console.log(`${SERIAL} font ${font} density ${density}: relaunch failed, skipped`);
        continue;
      }
      const size = shell('wm size').match(/(\d+)x(\d+)/);
      const geometry = {
        serial: SERIAL,
        fontScale: font,
        densityStep: density,
        dpi,
        widthDp: size ? Math.round((Number(size[1]) * 160) / dpi) : null,
        heightDp: size ? Math.round((Number(size[2]) * 160) / dpi) : null,
      };
      for (const [name, fn] of Object.entries(SCREENS)) {
        if (ONLY && !ONLY.includes(name)) continue;
        try {
          await d.ensureForeground();
          await fn();
        } catch (error) {
          failures.push(`${name}: ${error.message}`);
          try {
            shot(`fail-${name}`);
          } catch {
            /* the screenshot is best effort */
          }
          try {
            await backHome();
          } catch {
            try {
              await relaunch();
            } catch (again) {
              failures.push(`recovery relaunch: ${again.message}`);
              break;
            }
          }
        }
      }
      writeFileSync(
        join(dir, 'geometry.json'),
        JSON.stringify({ ...geometry, shots, failures }, null, 2),
      );
      manifest.push({ ...geometry, shots: shots.length, failures });
      console.log(
        `${SERIAL} font ${font} density ${density} (${dpi} dpi, ${geometry.widthDp} dp wide): ${shots.length} shots${failures.length ? `, ${failures.length} failed: ${failures.join(' | ')}` : ''}`,
      );
    }
  }
} finally {
  restore();
}
writeFileSync(
  join(REPORT_DIR, `${SERIAL.replace(/[^\w.-]+/g, '_')}-manifest.json`),
  JSON.stringify(manifest, null, 2),
);
console.log('WALK DONE');
