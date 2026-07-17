# afterglow
An Electron based cross platform screensaver app that shows RAW files (with their edits applied from sidecar XMPs) as well as videos (muted) and normal photos.

See [PLAN.md](PLAN.md) for the product plan and release roadmap.

## Afterglow Desktop — quickstart

A fullscreen ambient photo display. Shows JPEG/PNG/WebP from folders you
pick, recursively scanned, with crossfade transitions. Any mouse movement,
click or keypress exits — except the keys below, which quietly capture
organization work while you watch (v0.2).

Since v0.3 the show is smart-ordered by default: a background EXIF index
(capture dates, persisted to `index.json` and refreshed incrementally on
every start) feeds the story engine, so a burst of shots taken within a few
minutes of each other plays back-to-back as one "moment" instead of being
scattered across the night, with random singles interleaved between moments.
The show starts immediately in shuffle order and hot-swaps to smart order
the moment the index is ready — no waiting on a library scan. Photos without
EXIF fall back to their file date. Prefer pure shuffle? Set **Ordering** to
Shuffle on the settings screen (press **S** during the show).

### Keys during the show

| Key | Action | Exits? |
|---|---|---|
| **D** | Flag current photo for **delete** (same key again within the toast window undoes) | no |
| **E** | Flag for **edit** | no |
| **M** | Flag as **move**/misfiled | no |
| **R** | Flag for **review** | no |
| **O** | Toggle the path/date overlay (persisted) | no |
| **Q** | Open the flag-queue window (Esc or Q closes it) | no |
| **S** | Stop the show and open the settings screen | no |
| any other key | Exit | yes |
| mouse move (more than a nudge) / click | Exit | yes |

Flags land in a persistent queue (`flags.json` next to `settings.json`,
survives restarts). The queue window lists every flagged photo — its file
name, flag type and when you flagged it — with **Reveal in folder**, **Open**
(OS default app) and **Remove** per row. The slideshow keeps playing behind
it, and exit-on-input pauses while the queue window is open so you can reach
it with the mouse; close it (Esc/Q or the window's close button) to hand
control back to the show.

The overlay (bottom-left) shows the photo's file name, its folder, and the
EXIF capture date — or the file's modified date, labeled "(file date)", when
there is no EXIF. Toggle it with **O**; the default is on
(`"overlayEnabled"` in `settings.json`).

### For testers (installers)

Grab the latest `desktop-v*` release from GitHub Releases:

- **Windows:** download the `.exe` (NSIS installer or portable). The build is
  unsigned for now, so SmartScreen will warn — click **More info → Run
  anyway**. That's expected until we buy a signing certificate.
- **Linux:** download the `.AppImage` (make it executable, run it) or the `.deb`.

First run shows the settings screen: pick your Pictures folder(s) with
**Choose folders…**, optionally tweak slide duration, ordering
(Smart/Shuffle), the moment gap (default 3 minutes) and the cluster cap
(default 8 photos per moment), then hit **Start slideshow**. Press **S**
during the show to come back to this screen at any time. Everything persists
in `settings.json` in the app's user-data directory (`%APPDATA%/Afterglow`
on Windows, `~/.config/Afterglow` on Linux); the EXIF index lives beside it
as `index.json` and rebuilds itself if deleted.

To exit: move the mouse (more than a small nudge), press any key, or click.

### For developers

```bash
npm install                # from the repo root
npm run build -w @afterglow/core
npm start -w afterglow-desktop      # build + launch
npm test -w afterglow-desktop       # unit tests
npm run typecheck -w afterglow-desktop
```

Headless smoke test (used by CI): `npx electron apps/desktop --smoke` —
starts, loads the renderer, exits 0 on a clean load within ~3s, nonzero on
any load failure or renderer console error. Set `AFTERGLOW_SMOKE_MEDIA=<dir>`
to point the smoke run at a fixture folder.

Installers are built per platform with `npm run dist -w afterglow-desktop`
(electron-builder; config in `apps/desktop/electron-builder.yml`). CI builds
Windows + Linux artifacts on every `desktop-v*` tag.

## Afterglow Companion (Android) — quickstart

The mobile app clears a day's camera roll down to keepers: burst groups are
reviewed as pairwise photo duels ("cull one, or keep both and pick the
better"), staged culls are deleted in one confirmed batch to the system
trash. See [apps/mobile/README.md](apps/mobile/README.md) for the flow and
how to run it — it needs an Android development build
(`npx expo run:android`), **not Expo Go**.
