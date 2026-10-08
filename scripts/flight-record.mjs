#!/usr/bin/env node
/**
 * Records the deck's immersive flip both ways (m0.9.1 phase 4): opens the
 * deck through the gate's own driver, starts `screenrecord`, taps the
 * stage to enter immersive and again to leave it, pulls the clip and
 * dumps its frames at 30 fps so the flight can be read frame by frame.
 * Read-only on review state (a stage tap decides nothing).
 *
 * Usage: node scripts/flight-record.mjs --serial SERIAL --out DIR [--page video]
 * With --page video the walk swipes until a page with the play control
 * shows and uses its expand button instead of the stage tap.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDriver, resolveSerial } from './lib/ui-driver.mjs';

const APP_ID = 'com.afterglow.companion';
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const SERIAL = resolveSerial(argOf('--serial'));
const OUT = argOf('--out') ?? 'flight-record';
mkdirSync(OUT, { recursive: true });
const d = createDriver(SERIAL, APP_ID);
const { shell, sleep, dumpUi, findNode } = d;

shell('cmd statusbar collapse; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard');
shell(`am force-stop ${APP_ID}`);
await sleep(800);
shell(`monkey -p ${APP_ID} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
await d.waitFor(/^Daily goal/, 60000, 'home');
await d.waitForHome();
const PAGE = argOf('--page') ?? 'photo';
if (PAGE === 'photo') {
  // A group deck (photos): Home's queue row → the Timeline → the first
  // group card.
  await d.tapText(/\d+ to review$/, 20000);
  await d.waitFor(/^Unfinished$|^Everything$/, 20000, 'timeline filters');
  await sleep(800);
  await d.tapText(/^Group · /, 20000);
} else {
  // The clip is the newest item and the gate has usually decided it, so
  // it is History's first row; the deck opens on it in list mode.
  await d.tapText(/^History$/, 20000);
  await d.waitFor(/^All$/, 20000, 'history filters');
  await sleep(1000);
  const { width, height } = d.screenSize();
  shell(`input tap ${Math.round(width / 2)} ${Math.round(height * 0.3)}`);
}
await d.waitFor(/^\d+\/\d+$/, 30000, 'deck position');
await sleep(1500);
if (PAGE === 'video') {
  // History's list deck: swipe until a page wears the Video or Motion chip.
  let found = false;
  for (let i = 0; i < 12 && !found; i += 1) {
    found = Boolean(findNode(dumpUi(), /^Video$|^Motion$/));
    if (!found) {
      d.swipeDeckLeft();
      await sleep(1200);
    }
  }
  if (!found) throw new Error('no clip within twelve pages of History: seed one');
}

const { width, height } = d.screenSize();
const stage = { x: Math.round(width / 2), y: Math.round(height * 0.38) };
const clip = '/sdcard/flight.mp4';
const rec = spawn('adb', ['-s', SERIAL, 'shell', `screenrecord --time-limit 14 ${clip}`], {
  stdio: 'ignore',
});
// Registered BEFORE the choreography: exit events are not replayed, and a
// slow phone's dumps can outlast the recording (codex round 3).
const recorded = new Promise((resolve) => rec.on('exit', resolve));
await sleep(2000);
if (PAGE === 'photo') {
  shell(`input tap ${stage.x} ${stage.y}`); // enter immersive
  await sleep(5000);
  shell(`input tap ${stage.x} ${stage.y}`); // leave it
} else {
  // A video's tap shows its chrome; the Fullscreen button is its flight.
  if (!findNode(dumpUi(), /^Fullscreen$/)) shell(`input tap ${stage.x} ${stage.y}`);
  await d.tapText(/^Fullscreen$/, 5000);
  await sleep(4000);
  // The chrome stays up after the flight when nothing plays: a stage tap
  // would HIDE it, so tap only when the control is not already there.
  if (!findNode(dumpUi(), /^Exit fullscreen$/)) shell(`input tap ${stage.x} ${stage.y}`);
  await d.tapText(/^Exit fullscreen$/, 5000);
}
await recorded;
execFileSync('adb', ['-s', SERIAL, 'pull', clip, join(OUT, 'flight.mp4')], { stdio: 'ignore' });
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  join(OUT, 'flight.mp4'),
  '-vf',
  'fps=30,scale=360:-1',
  join(OUT, 'f_%04d.png'),
]);
console.log(`RECORDED ${join(OUT, 'flight.mp4')} (${PAGE}: enter at 2 s, leave at ~7 s)`);
