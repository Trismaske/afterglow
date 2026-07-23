# Afterglow Desktop — map

Electron, vanilla TS (no framework), esbuild. Three processes: **main** (Node), **preload** (contextBridge), **renderer** (DOM). The IPC surface and `Settings`/`SettingsPatch` types live in `src/shared/api.ts` — to add a capability: extend api.ts → handle in `main/index.ts` → expose in `preload/index.ts` → consume in renderer. One renderer window swaps between settings screen, message screen, and the slideshow stage; the flag-queue window is separate (`queue-window.ts` + `queue.*`).

## Behavior contracts (don't regress)

- **Launch modes** (`main/launch.ts`): plain launch → settings screen ("Start slideshow" button) in an ordinary resizable window (close/minimize work); the window goes fullscreen only while the show runs. `--show` → straight into the show, fullscreen+frameless for the whole run; win32 screensaver args `/s`=show, `/p`=quit, `/c`=settings. Exit semantics: manual launch → any non-shortcut input returns to (windowed) settings; `--show` → quits. Non-exiting keys: O Q S, D/E/M/R/N/T flags, arrows. App icon: `build/icon.png` (chevron on dark slate; mobile has the matching dark set in `assets/`).
- **Arrow nav**: ←/→ prev(history)/next, ↑ restart moment, ↓ skip moment (shuffle mode: ↑ restarts slide, ↓ = next). History is what was actually shown (200 entries).
- **Settings clamps** (`main/settings.ts`): slide 2–3600 s, gap 1–720 min, clusterCap 2–100, videoMaxSeconds **0 (= full length)** or 2–600.
- Show starts in shuffle and hot-swaps to smart when the index lands; warm start serves the persisted index immediately, rescans in background.

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

`npm run typecheck|test|build -w afterglow-desktop`; headless e2e: `xvfb-run -a npx electron apps/desktop --smoke --show` (env knobs `AFTERGLOW_SMOKE_*` — see main/index.ts). Packaging: `electron-builder.yml` (NSIS include `build/installer.nsh`; `package.json` `homepage` is required by the deb target; `electronVersion` is pinned there because electron is hoisted to the workspace root — bump it in sync whenever electron is upgraded). Tests live in `test/*.test.ts`, one file per module.
