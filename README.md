# afterglow

Two apps:

- **Afterglow Desktop** — an Electron fullscreen ambient slideshow with smart "moments" ordering, muted video, and flag-to-queue photo capture.
  RAW with sidecar edits applied is the roadmap flagship, coming in v0.6.
- **Afterglow** for Android — a photo-culling app that drives every phone photo to a reviewed end-state.

See [PLAN.md](PLAN.md) for the product plan and release roadmap.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full developer setup, including the one-command Android toolchain and emulator install (`npm run setup:android`).

**Working on the code (human or agent)? Start at [CLAUDE.md](CLAUDE.md)** — a token-lean orientation map of the whole repo, with per-package file maps in `apps/desktop/CLAUDE.md`, `apps/mobile/AGENTS.md`, and `packages/core/CLAUDE.md`.
Read those instead of scanning the tree.

## Afterglow Desktop quickstart

A fullscreen ambient photo display.
It shows photos and muted videos from folders you pick, recursively scanned, with crossfade transitions.
Any mouse movement, click, or keypress leaves the show (back to the settings screen on a manual launch).
The exception is the keys below, which navigate or quietly capture organization work while you watch.

### Supported formats (the honest list)

- **Images:** JPEG, PNG, WebP.
  **HEIC is not supported on desktop for now.**
  Chromium has no HEIC decoder.
  HEIC works in the Android app.
  GIF and RAW come in later releases per the roadmap.
- **Videos:** MP4, WebM, MOV — always muted.
  These are the containers Chromium can decode natively.
  **AVI and MKV are not supported** and never will be claimed.
  A `.mov` (or anything else) that holds a codec Chromium lacks, such as HEVC or ProRes, is skipped with a console note, and the show advances.
  It never hangs the slideshow.

A video slide plays until the video ends, or until the per-video cap, whichever comes first.
The cap is **Video cap** on the settings screen (default 30 seconds, `videoMaxSeconds` in `settings.json`).
A playback error mid-video advances immediately.
Videos join moments and clusters like photos, ordered by their file date (video containers are not EXIF-parsed).
The overlay and the flag keys (D/E/M/R) work on videos exactly as on photos.

The show is smart-ordered by default.
A background EXIF index (capture dates, persisted to `index.json` and refreshed incrementally on every start) feeds the story engine.
A burst of shots taken within a few minutes of each other plays back-to-back as one "moment" instead of being scattered across the night, with random singles interleaved between moments.
The show starts immediately in shuffle order and hot-swaps to smart order the moment the index is ready.
There is no waiting on a library scan.
A photo without EXIF falls back to its file date.
If you prefer pure shuffle, set **Ordering** to Shuffle on the settings screen (press **S** during the show).

### Keys during the show

| Key | Action | Leaves the show? |
|---|---|---|
| **D** | Flag current photo/video for **delete** (same key again within the toast window undoes) | no |
| **E** | Flag for **edit** | no |
| **M** | Flag as **move**/misfiled | no |
| **R** | Flag for **review** | no |
| **N** | Flag as **needs rename** | no |
| **T** | Flag as **needs date fix** | no |
| **←** / **→** | Previous / next photo (← replays your history, videos included) | no |
| **↑** | Restart the current moment (or the current slide outside a moment) | no |
| **↓** | Skip to the next moment | no |
| **O** | Toggle the path/date overlay + shortcut legend (persisted) | no |
| **Q** | Open the flag-queue window (Esc or Q closes it) | no |
| **S** | Stop the show and open the settings screen | no |
| any other key | Leave the show | yes |
| mouse move (more than a nudge) / click | Leave the show | yes |

"Leave the show" depends on how Afterglow started.
A normal (manual) launch returns to the settings screen.
When started with `--show`, or running as the Windows screensaver, the app quits.
A shortcut legend flashes for a few seconds when the show starts, and stays up while the overlay is on.

Flags land in a persistent queue (`flags.json` next to `settings.json`) that survives restarts.
The queue window lists every flagged photo with its file name, its flag type, and when you flagged it.
Each row has **Reveal in folder**, **Open** (the OS default app), and **Remove**.
The slideshow keeps playing behind the window.
Exit-on-input pauses while the queue window is open, so you can reach the window with the mouse.
Close it (Esc, Q, or the window's close button) to hand control back to the show.

The overlay (bottom-left) shows the photo's file name, its folder, and the EXIF capture date.
When there is no EXIF, it shows the file's modified date, labeled "(file date)".
Toggle the overlay with **O**.
The default is on (`"overlayEnabled"` in `settings.json`).

### For testers (installers)

Download the latest `desktop-v*` release from GitHub Releases:

- **Windows:** download the `.exe` (NSIS installer or portable).
  The build is unsigned for now, so SmartScreen warns.
  Click **More info → Run anyway**.
  This is expected until we buy a signing certificate.
- **Linux:** download the `.AppImage` (make it executable, then run it) or the `.deb`.

Launching Afterglow lands on the settings screen.

1. Pick your Pictures folder(s) with **Choose folders…**.
2. Optionally adjust the slide duration, the ordering (Smart/Shuffle), the moment gap (default 3 minutes), the cluster cap (default 8 photos per moment, max 100), and the video cap (default 30 seconds per video, where 0 plays full length).
3. Press **Start slideshow**.

Press **S** during the show, or move the mouse, to come back to this screen at any time.
Every setting persists in `settings.json` in the app's user-data directory (`%APPDATA%/Afterglow` on Windows, `~/.config/Afterglow` on Linux).
The EXIF index lives beside it as `index.json` and rebuilds itself if deleted.
Launching with `--show` skips settings and starts the slideshow directly.
Input then exits the app.

**Windows screensaver:** the installer places an `Afterglow.scr` next to the app.
The settings screen (Windows only) has a **Set as default screensaver** button that registers it for your user account and shows the current status.
The screensaver uses the same settings as the app.
While a slideshow runs, Afterglow also keeps the display awake, so no other screensaver interrupts it.

### For developers

```bash
npm install                # from the repo root
npm run build -w @afterglow/core
npm start -w afterglow-desktop      # build + launch
npm test -w afterglow-desktop       # unit tests
npm run typecheck -w afterglow-desktop
```

Headless smoke test (used by CI): `npx electron apps/desktop --smoke --show`.
It starts the app, loads the renderer, and exits 0 on a clean load within about 4 seconds.
It exits nonzero on any load failure or renderer console error.
The `--show` flag matters: a manual launch sits on the settings screen.
Set `AFTERGLOW_SMOKE_MEDIA=<dir>` to point the smoke run at a fixture folder.
Add `AFTERGLOW_SMOKE_EXPECT_VIDEO=1` to also require that a video in the fixture started playing and finished (natural end or cap).
Smoke-only knobs: `AFTERGLOW_SMOKE_VIDEO_CAP_S` overrides the per-video cap, and `AFTERGLOW_SMOKE_OK_MS` stretches the observation window (for example, to let a mixed photo and video fixture play a full epoch).

Build installers per platform with `npm run dist -w afterglow-desktop` (electron-builder, config in `apps/desktop/electron-builder.yml`).
CI builds Windows and Linux artifacts on every `desktop-v*` tag.

## Afterglow for Android quickstart

The mobile app clears your camera roll down to keepers.
A continuous scan groups lookalike shots with an on-device image model.
The live review queue works through them as a swipe deck: cull, keep, flag to-edit, or A/B-compare with synchronized zoom.
Staged culls are deleted in confirmed batches to the system trash.
See [apps/mobile/README.md](apps/mobile/README.md) for the flow and how to run it.
It needs an Android development build (`npx expo run:android`), **not Expo Go**.

Dev-environment setup (JDK, Android SDK, emulator) is one command from the repo root.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md):

```bash
npm run setup:android        # installs everything under ~/Android, no sudo
source scripts/android-env.sh
npm run emulator             # boot the afterglow-pixel7 AVD
npm run mobile:android       # build + install + launch the app
```

Run Expo commands from `apps/mobile`, or through the root aliases above.
Running them from the repo root scaffolds a junk project into the root.
