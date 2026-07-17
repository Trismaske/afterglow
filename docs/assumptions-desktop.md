# Assumptions — desktop train

Judgment calls made while building Afterglow Desktop, per version. Merged
into `ASSUMPTIONS.md` at the end of the build.

## desktop-v0.1

1. **Exit-on-input threshold:** the first mousemove after arming only records
   a baseline (Chromium can emit a synthetic move on window show); the app
   exits once the pointer moves **more than 24 CSS px** (Euclidean distance)
   from that baseline. Keys and clicks exit immediately. All input funnels
   through one arbiter (`src/renderer/exit.ts`) with an `isExemptKey` hook so
   v0.2 flag keys (D/E/M/R) slot in without restructuring.
2. **First-run screen does not exit on input** — the user has to click
   "Choose folders…", so the arbiter stays disarmed until a show (or an
   error/no-images message screen) is up. Message screens *do* exit on input.
3. **Scan rules:** only `.jpg/.jpeg/.png/.webp` (what Chromium decodes
   natively); dot-entries (hidden files/dirs like `.thumbnails`) skipped;
   **symlinks skipped entirely** — the media protocol refuses anything whose
   realpath escapes the configured folders, so following links would only
   yield images that fail containment later. Unreadable directories are
   logged and skipped. Nested/overlapping folder picks are de-duplicated.
4. **Protocol containment:** `afterglow://media/<encodeURIComponent(abs path)>`;
   the handler requires an absolute path with an allowed image extension,
   realpath-resolves it, and serves it only if it lies strictly inside one of
   the realpath-resolved configured media folders (checked via
   `path.relative`, immune to `/photos` vs `/photos-backup` prefix tricks).
5. **Slide duration is clamped to 2–3600 s** on load/save; corrupt or missing
   `settings.json` silently falls back to defaults rather than crashing the
   show. Duration is only editable via the JSON file in v0.1 (per roadmap —
   settings UI comes later).
6. **Playlist looping:** when the shuffled order is exhausted the renderer
   reshuffles (Fisher–Yates from `@afterglow/core`) and guarantees the new
   epoch doesn't open with the photo that just played.
7. **Soak safety:** exactly two `<img>` elements are created once and reused;
   load/error handlers are assigned (not accumulated) and cleared after each
   load; timers are a single `setTimeout` chain. Nothing grows with runtime.
8. **Smoke mode (`--smoke`)** redirects `userData` to a fresh temp dir (never
   touches real settings) and honors `AFTERGLOW_SMOKE_MEDIA=<dir>` so CI/dev
   can exercise the full scan → protocol → crossfade path headlessly.
   Verified locally: exits 0 on the first-run path and the slideshow path,
   exits 1 when the renderer bundle is missing.
9. **`electronVersion` is pinned in `electron-builder.yml` (37.10.3)**
   because electron is hoisted to the workspace root and electron-builder
   cannot resolve the `^37` range from `apps/desktop` alone. Must be kept in
   sync with the installed electron on upgrades.
10. **Kiosk style = `fullscreen: true` + `frame: false`**, not Electron's
    `kiosk: true` (which can fight window managers and complicates dev/smoke
    runs). Cursor is hidden via CSS while the show runs.
11. **`author` field added to `apps/desktop/package.json`** (electron-builder
    needs a maintainer for the `.deb`).
12. **Root `package-lock.json` is NOT staged with this commit.** The working
    tree's lockfile currently mixes the `@afterglow/core` workspace links
    (needed by this commit's `apps/desktop/package.json`) with the mobile
    train's in-flight dependency installs, and desktop ran no install of its
    own. The mobile train (or the final consolidation commit) must land the
    lockfile; until it does, `npm ci` at this commit alone would not resolve
    `@afterglow/core` for the desktop workspace. Harmless for local dev
    (workspaces link it) and resolved as soon as the lock lands on the
    branch — do not push the `desktop-v0.1` tag before that.
13. **CI (`.github/workflows/desktop-release.yml`) is untested until pushed**
    — it builds Windows NSIS+portable and Linux AppImage+deb on `desktop-v*`
    tags and uploads to a GitHub Release; PRs run typecheck+tests+build only.
    Local sanity check done via `electron-builder --dir --linux` (packaged
    binary passed the smoke test).
14. **Videos, RAW, HEIC, GIF are out of scope for v0.1** per the plan;
    non-image files are simply never scanned. Unreadable/undecodable images
    are skipped with a console warning and the show advances; if *nothing*
    displayable exists the app shows a message and still exits on input.
