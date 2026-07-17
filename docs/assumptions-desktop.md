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

## desktop-v0.2

1. **Overlay defaults to ON** (`overlayEnabled: true`). The flag-capture
   workflow needs the path/date on screen to be useful, and O turns it off
   instantly (the toggle is persisted to `settings.json` immediately).
2. **Overlay layout:** file name (prominent), parent directory (dim, full
   path), and a date line — EXIF `DateTimeOriginal`/`CreateDate` via exifr
   when present, otherwise the file mtime explicitly labeled "(file date)".
   Bottom-left, inset ~3.5% for TV overscan, text-shadow instead of a
   background box. Date formatting is hand-rolled ("17 Jul 2026, 02:31") so
   it's locale-stable and unit-testable.
3. **Undo window = toast duration = 4 s**, and undo intent dies with the
   slide: pressing the same flag key again un-flags only while the *same
   photo* is still on screen. Once the show advances, the key flags the new
   photo — otherwise a keypress on the next photo would silently un-flag the
   previous one.
4. **Toast on re-flagging an already-queued photo** (e.g. flagged in a past
   session) still says "Flagged …" — core's addFlag dedupes, so nothing
   double-enters the queue, and the follow-up press still un-flags.
5. **Hotkeys (O/Q/D/E/M/R) are active only while the slideshow itself is on
   screen.** First-run and message screens keep v0.1 behavior (message
   screens exit on any key). Exemption is enforced both in the key handler
   and via the arbiter's `isExemptKey` hook (belt and braces).
6. **Exit-on-input pauses while the queue window is open.** The fullscreen
   slideshow window still gets mousemove events when unfocused, so traveling
   the pointer toward the queue window would otherwise kill the app
   mid-review. The show keeps playing; closing the queue (Esc, Q, or the
   close button) re-arms exit-on-input. Main notifies the renderer via a
   `queue-state` push.
7. **Queue window:** 820×520, always-on-top (floating) so it isn't swallowed
   by the fullscreen show, own minimal preload (`window.afterglowQueue`),
   same security posture (contextIsolation+sandbox, CSP, no node). Entries
   listed newest-first. Full re-render on every change — small window, small
   queue, simplicity wins.
8. **shell.\* hardening:** `showItemInFolder`/`openPath` execute only for
   IPC calls coming from the queue window's own webContents AND for paths
   currently present in the flag queue; flag add/get-item-info requests
   validate the media URL and realpath-containment against the configured
   folders (same rules as the media protocol). Flag *removal* skips the
   containment check so entries for since-moved files can still be removed.
9. **flags.json uses core's versioned FlagQueueJSON** (`{version: 1}`),
   written atomically (temp+rename) with writes serialized on a promise
   chain; a corrupt file logs a warning and starts an empty queue rather
   than crashing the show. Malformed entries are dropped individually by
   core's `flagQueueFromJSON`.
10. **Overlay metadata is fetched per slide only while the overlay is
    visible** (one IPC + EXIF parse per slide, nothing when toggled off) and
    a stale-response guard drops results that arrive after the slide
    advanced.
11. **Smoke test now drives the capture path:** with
    `AFTERGLOW_SMOKE_MEDIA` set, `--smoke` injects a synthetic E keypress
    (must produce exactly one 'edit' flag, verified in-memory AND re-read
    from flags.json on disk) and a Q keypress (queue window must open; its
    console is watched for errors too). Verified locally: exits 0; the
    first-run smoke (no env) still exits 0.
12. **Done-when bar** ("flag 10 photos, find and open every one"): flagging
    is dedup-safe and persisted synchronously before the IPC promise
    resolves, the queue window lists all entries with Reveal/Open/Remove,
    and the store round-trips restarts (unit-tested). Open failures surface
    as console warnings only in v0.2 (no in-window error UI yet).
