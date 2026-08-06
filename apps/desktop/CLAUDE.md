# Afterglow Desktop — map

Electron app in vanilla TS, built with esbuild, no framework.
Three processes: **main** (Node), **preload** (contextBridge), **renderer** (DOM).
The IPC surface and the `Settings`/`SettingsPatch` types live in `src/shared/api.ts`.
To add a capability: extend api.ts → handle in `main/index.ts` → expose in `preload/index.ts` → consume in renderer.
One renderer window swaps between the settings screen, the message screen, and the slideshow stage.
The flag-queue window is separate (`queue-window.ts` + `queue.*`).

## Behavior contracts (do not regress)

- **Launch modes** (`main/launch.ts`).
  A plain launch opens the settings screen ("Start slideshow" button) in an ordinary resizable window, where close/minimize work.
  The window goes fullscreen only while the show runs.
  `--show` starts the show directly, fullscreen and frameless for the whole run.
  Win32 screensaver args: `/s`=show, `/p`=quit, `/c`=settings.
  Exit semantics: after a manual launch, any non-shortcut input returns to the windowed settings screen.
  Under `--show`, it quits.
  Non-exiting keys: O Q S, the D/E/M/R/N/T flags, and the arrows.
  App icon: `build/icon.png` (chevron on dark slate).
  Mobile has the matching dark set in `assets/`.
- **Arrow nav**: ←/→ = previous (from history) / next.
  ↑ restarts the moment.
  ↓ skips the moment.
  Shuffle mode: ↑ restarts the slide, ↓ = next.
  History records what the show actually displayed (200 entries).
- **Settings clamps** (`main/settings.ts`): slide 2–3600 s, gap 1–720 min, clusterCap 2–100, videoMaxSeconds **0 (= full length)** or 2–600.
- The show starts in shuffle and hot-swaps to smart when the index lands.
  A warm start serves the persisted index immediately and rescans in the background.

## src/main/

| File | Contents |
|---|---|
| index.ts | Entry: windows, single-instance, LAUNCH_MODE, IPC handlers, powerSaveBlocker on show, warm-start playlist, `startIndexing`, smoke harness hooks |
| launch.ts | Pure argv+platform → 'settings'\|'show'\|'preview-quit' |
| settings.ts | Atomic JSON settings store at `<userData>/settings.json` + normalization/clamps |
| scan.ts | Recursive media scan; only Chromium-decodable extensions (jpg/jpeg/png/webp; mp4/webm/mov) |
| indexer.ts | Background EXIF index → `<userData>/index.json` (path, mtime, size, capture time) |
| metadata.ts | Per-item overlay dates: EXIF via exifr, mtime fallback, never throws |
| containment.ts | Realpath containment check for the `afterglow://` protocol |
| flagstore.ts | Flag queue persistence (`core` model + atomic `<userData>/flags.json`) |
| queue-window.ts | The windowed flag-queue window (same sandbox model, own preload) |
| screensaver.ts | Windows-only: register/status/unregister HKCU `SCRNSAVE.EXE` via `reg.exe` execFile; `.scr` = exe copy installed by NSIS (`build/installer.nsh`). Untestable on Linux — pure parts unit-tested, rest platform-guarded |

## src/renderer/

| File | Contents |
|---|---|
| index.ts | Screen switching (settings/show/message), hotkey wiring, settings form DOM, screensaver UI row |
| slideshow.ts | Crossfade engine + seek API (`next/previous/restartMoment/skipMoment`); step counter serializes rapid keys |
| navigator.ts | Pure history/seek state machine (buffer, candidate/commit, forward-replay, moment ops) |
| playlist.ts | Endless Fisher–Yates shuffle epochs; optional `clusterOf` for moment nav |
| smart.ts | Story-engine playlist (core clustering + mix) with shuffle→smart hot-swap |
| video.ts | Video slide watch: natural end or cap, whichever first; cap ≤0 → no timer |
| exit.ts | Single exit arbiter (keys/clicks/mouse-move >24 px), mode-aware, re-armable |
| flags.ts | `KEY_TO_FLAG` D/E/M/R/N/T, flag/undo handling, `isShowHotkey` |
| overlay.ts | Path/date overlay + shortcut legend (flashed at show start) |
| toast.ts / format.ts | Reused toast element; locale-stable formatting helpers |
| queue.ts/.html/.css | Flag-queue window UI (badges per flag type, reveal/open/remove) |
| index.html / styles.css | The single window's markup/styles (hints, legend, screensaver row) |

## Verify

Run `npm run typecheck|test|build -w afterglow-desktop`.
Headless e2e: `xvfb-run -a npx electron apps/desktop --smoke --show` (env knobs `AFTERGLOW_SMOKE_*`, see main/index.ts).
Packaging: `electron-builder.yml`, with NSIS include `build/installer.nsh`.
The deb target requires the `package.json` `homepage` field.
`electronVersion` is pinned in `electron-builder.yml` because electron is hoisted to the workspace root.
Whenever you upgrade electron, bump `electronVersion` in sync.
Tests live in `test/*.test.ts`, one file per module.
