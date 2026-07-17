# afterglow
An Electron based cross platform screensaver app that shows RAW files (with their edits applied from sidecar XMPs) as well as videos (muted) and normal photos.

See [PLAN.md](PLAN.md) for the product plan and release roadmap.

## Afterglow Desktop — quickstart

A fullscreen ambient photo display. v0.1 shows JPEG/PNG/WebP from folders you
pick, recursively scanned, shuffled, with crossfade transitions. Any mouse
movement, click or keypress exits.

### For testers (installers)

Grab the latest `desktop-v*` release from GitHub Releases:

- **Windows:** download the `.exe` (NSIS installer or portable). The build is
  unsigned for now, so SmartScreen will warn — click **More info → Run
  anyway**. That's expected until we buy a signing certificate.
- **Linux:** download the `.AppImage` (make it executable, run it) or the `.deb`.

First run shows a dark screen with one button — **Choose folders…** — pick
your Pictures folder(s) and the show starts. Settings (folders, slide
duration) persist in `settings.json` in the app's user-data directory
(`%APPDATA%/Afterglow` on Windows, `~/.config/Afterglow` on Linux); edit
`slideDurationSeconds` there to change the default 8s per slide (a settings
UI comes later).

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
