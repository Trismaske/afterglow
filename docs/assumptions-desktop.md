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

## desktop-v0.3

*(This version was started by an agent that was interrupted mid-flight; the
work was reviewed line-by-line, two renderer defects were fixed — stage
`<img>` layers accumulating across settings↔show cycles, and a stale
`currentUrl` surviving into the settings/message screens — and the version
was completed and verified from there. Decisions below cover the whole
release, inherited and new.)*

1. **Settings screen = the first-run screen, reachable with S mid-show.**
   The plan left "Q-window or settings screen" open; a dedicated settings
   screen keeps the queue window single-purpose and gives folders + duration
   + ordering one home. S stops the show (exit arbiter disarmed so controls
   are clickable), Start re-persists the form via a whitelisted
   `SettingsPatch` (main revalidates/clamps everything with
   `normalizeSettings` — a hostile renderer can't corrupt settings.json or
   touch `mediaFolders` through this channel) and rescans.
2. **`orderMode` defaults to `'smart'` unconditionally** rather than
   "smart once index exists": the show *always* starts in shuffle order and
   hot-swaps only when the index push arrives, so "smart before the index
   exists" degrades to exactly the old shuffle behavior — a separate
   "index exists yet?" state would add nothing.
3. **Index lives at `userData/index.json`** (`{version: 1, entries: [...]}`,
   path-keyed, atomic temp+rename writes like settings.json, entries sorted
   by path for stable diffs). Corrupt file or wrong version → rebuilt from
   scratch; malformed rows dropped individually. mtime **and** size are the
   change detectors; either changing re-extracts that file.
4. **Indexing is fire-and-forget per scan with a generation counter:** every
   `getPlaylist` (i.e. every show start) bumps a generation; an in-flight
   build from an older scan cancels itself instead of publishing stale
   results. Extraction runs at concurrency 8 (`mapLimit`), stat + exifr only
   for new/changed files. EXIF `DateTimeOriginal` → `CreateDate` → file
   mtime (recorded as `source: 'exif' | 'mtime'`), timezone-naive local time
   per the plan's risk note.
5. **Hot-swap via a SwappablePlaylist wrapper:** the Slideshow keeps a single
   `Playlist` reference for its lifetime; smart order arrives by swapping the
   delegate inside the wrapper, so the running show (timers, crossfade state)
   is never interrupted. In shuffle mode the push is simply ignored.
6. **Smart order treats only 2+ item clusters as moments**; singletons stay
   ordinary pool members. Clustering happens in the renderer from the pushed
   `{url, timestampMs}` list, so a settings change only needs a restart of
   the show, not a re-index. Mix weights stay at core's default 1:1
   (cluster:single) — configurable weights are v0.7 polish per the plan.
7. **Settings bounds:** momentGapMinutes clamped 1–720, clusterCap 2–100,
   both rounded to integers; unknown orderMode values fall back to 'smart'.
8. **`clusterCap` beyond core's even-sampling semantics is unchanged** —
   capping selects first + last + evenly sampled interior shots, so an
   8-burst at cap 8 plays complete and in order (the release's done-when
   bar, asserted in `test/smart.test.ts` with a seeded rng).
9. **Smoke test extended, not forked:** with `AFTERGLOW_SMOKE_MEDIA` set the
   existing E/Q keypress harness now also requires `index.json` on disk with
   ≥1 entry, every entry carrying a finite `timestampMs`. Verified locally
   against a fixture containing 4 EXIF-dated burst JPEGs + 2 EXIF-less PNGs:
   the run logs "smart order engaged: 2 moments across 6 photos" and the
   persisted index shows `source: "exif"` with the correct capture dates for
   the burst and mtime fallback for the PNGs.
10. **The queue window cannot reach `updateSettings`** (its preload doesn't
    expose it), and the channel carries no paths, so no sender guard beyond
    the existing pattern was added.

## desktop-v0.4

1. **Format lists moved to `shared/api.ts`** (pure, no Node APIs) because
   three layers route on the same truth: the scanner collects the
   extensions, the afterglow:// protocol allowlists them, and the renderer
   picks `<img>` vs `<video>` per URL (`mediaKindFromPath`/`mediaKindFromUrl`,
   final-extension only, case-insensitive). `scan.ts` keeps thin
   `isImageFile`/`isVideoFile`/`isMediaFile` wrappers; `scanImages` was
   renamed `scanMedia` (internal API, both callers updated).
2. **Video timestamps are always file mtime** (`source: 'mtime'`): exifr
   does not parse MP4/WebM/MOV containers, so `getImageDates` short-circuits
   for videos (no wasted container reads on index builds, overlay shows the
   date labeled "(file date)"). Container-metadata creation dates are a
   possible later refinement; PLAN.md only promises "EXIF/mtime as indexed".
3. **A `.mov` is scanned/indexed optimistically and skipped at play time**
   if Chromium can't decode it (the `<video>` element errors on load →
   "skipping unloadable video", show advances; verified in smoke with a
   garbage .mov). There is no up-front codec sniffing — the decoder is the
   only honest oracle, and failures cost one skipped slide, never a hang.
4. **Slideshow structure: two slots × (one `<img>` + one `<video>`)**,
   created once and reused forever (soak safety as before); per slide
   exactly one element of the incoming slot gets the `visible` class, so
   photo↔video crossfades are identical to photo↔photo. The outgoing
   video is paused at crossfade (its last frame fades out) and its `src` is
   detached on slot reuse to free the decoder.
5. **Video slide lifetime** = natural `ended` OR `videoMaxSeconds` cap OR
   playback error, whichever first, firing exactly once — the arbitration is
   a pure helper (`renderer/video.ts`, `createVideoWatch`) with unit tests.
   The cap timer starts when `play()` is initiated (not at load). `play()`
   rejection is treated like a playback error → immediate graceful advance.
   Videos ignore `slideDurationSeconds` entirely.
6. **`videoMaxSeconds` bounds: 2–600 s, default 30**, integer-rounded,
   normalized in main like every other setting; editable on the settings
   screen ("Video cap") and via the whitelisted SettingsPatch.
7. **Videos are full citizens of the story engine:** LibraryItem now carries
   `kind` (computed in main from the path), the renderer maps it into
   core's `MediaItem.kind`, and clustering/mix treat videos exactly like
   photos (unit-tested: a clip shot mid-burst plays in chronological
   position inside the moment). Overlay and D/E/M/R flag keys work on
   videos unchanged — flag containment now validates against media (not
   just image) extensions.
8. **Protocol forwards request headers to `net.fetch`** so `<video>` Range
   requests stream partial content instead of re-buffering whole files;
   CSP gained `media-src afterglow:`. Containment rules are unchanged
   (absolute path + allowed extension + realpath inside a configured root).
9. **Smoke harness (v0.4):** `AFTERGLOW_SMOKE_EXPECT_VIDEO=1` fails the run
   unless the renderer logged `video started` AND `video ended`/`video
   capped`; smoke-only env knobs `AFTERGLOW_SMOKE_VIDEO_CAP_S` (cap
   override, still normalized) and `AFTERGLOW_SMOKE_OK_MS` (longer
   observation window) exist so the cap path and a full mixed-folder epoch
   are provable headlessly. `SMOKE_OK_MS` default went 3s → 4s to fit a ~1s
   fixture clip's load→play→end; ffmpeg was available on this machine, so
   real H.264 MP4s (1s and 10s) were generated and played in xvfb — the
   mixed run (4 photos + 2 MP4s + capped long video) is captured in the
   release verification.
10. **`autoplay` is not set on the `<video>` element** despite the plan's
    `<video muted autoplay playsinline>` shorthand: the show controls timing
    explicitly (`play()` at crossfade), which is the same user-visible
    behavior without racing the crossfade. muted/playsinline/
    disablePictureInPicture are set both as properties and attributes.

## desktop-v0.5

1. **Launch-arg parsing (`src/main/launch.ts`):** `--show` is honored on
   every platform; the Windows screensaver switches `/s`, `/p`, `/c` are
   honored **only on win32** (on POSIX a literal `/s` argument is far more
   likely to be a path), case-insensitively, with `/` or `-` prefix and an
   optional `:hwnd` suffix (`/c:5551212`). `/p <hwnd>` (preview) quits
   immediately — rendering into the preview pane is out of scope, and a
   quiet exit shows a black preview box instead of an error. `--show` with
   zero configured folders falls back to the settings screen (there is
   nothing to show).
2. **Single-instance lock in all modes** (`requestSingleInstanceLock`): the
   losing process just quits — in screensaver mode that's exactly the "OS
   re-fires the saver" case, and deliberately nothing is focused. The
   surviving instance focuses its window on `second-instance`, which gives
   manual double-launches the expected behavior for free.
3. **Exit semantics per mode:** the one exit arbiter still sees all input,
   but its `onExit` now branches — manual launch → back to the settings
   screen (show stopped cleanly), `--show`/screensaver → quit as before.
   Message screens (no images / all failed) follow the same rule and their
   text adapts ("return to settings" vs "exit"). The arbiter's `arm()` now
   resets its fired-latch and pointer baseline so settings ↔ show round
   trips re-arm cleanly (previously `fired` latched forever because firing
   always meant process exit).
4. **History buffer: 200 entries of successfully *shown* items** (unloadable
   files never enter it; a history entry that later fails to load falls out
   of the buffer and the step continues past it). Browser-history model:
   showing a fresh playlist item while the cursor is behind truncates the
   forward tail. ← at the oldest entry is a no-op (current slide and timer
   keep running). Auto-advance and → both replay forward history first, so
   the auto-advance walks back up the same trail after a ←.
5. **↑ (restart moment) rewinds through history**, to the earliest entry of
   the contiguous same-cluster run ending at the current item — i.e. it
   replays exactly what was shown (respecting the cluster-cap sampling)
   rather than re-queuing the cluster from core's mix, which would have
   required core API changes. With no cluster (singles, shuffle mode, or
   already at the run's first shown item) it restarts the current slide:
   photos get a fresh full timer, videos rewind to 0 with a fresh cap
   clock.
6. **↓ (skip moment) consumes live playlist items** until the cluster id
   changes (bounded by playlist size); the skipped items are discarded, not
   recorded. On singles/in shuffle mode ↓ degrades to → per the plan. Moment
   identity comes from a URL → cluster-index map built alongside the smart
   playlist (2+ item clusters only, same clustering pass the mix uses);
   core's mix engine is untouched.
7. **Rapid keypresses are serialized by a step sequence counter** in the
   Slideshow: every nav/advance step bumps it, and an in-flight step that
   lost the race abandons itself after its (async) load instead of touching
   the DOM — no double-crossfades, no orphan timers. Every successful nav
   resets the auto-advance timer (photos) or the video watch.
8. **videoMaxSeconds 0 = "play full length":** values that *round* to 0
   count as the sentinel, negatives still clamp up to 2, and non-numeric
   input falls back to the default 30. A blank form field would read as 0
   via `Number('')`, so the renderer sends NaN for blank — blank can never
   silently mean "uncapped". With cap 0 `createVideoWatch` schedules no
   timer at all (ended/error/cancel still advance).
9. **powerSaveBlocker (`prevent-display-sleep`)** is driven by a
   renderer → main "show state" IPC: started when the slideshow is on
   screen (both launch modes), stopped on the settings and message screens.
   Display-sleep blocking also keeps the OS screensaver away, per the
   Electron docs and the plan's intent.
10. **Warm start plays the persisted index verbatim** (no existence
    filtering, per the plan — a deleted file fails to load and the show
    advances; the background rescan's `indexReady` push then replaces the
    playlist). If the media folders changed since the index was written,
    the first items can 403 against the protocol's containment check until
    the rescan lands — same graceful skip path, worst case a few seconds
    of black. New in v0.5: `indexReady` refreshes the playlist in shuffle
    mode too (it used to be smart-only), otherwise a warm start from a
    stale index would never pick up new files.
11. **The `.scr` is a full copy of the installed exe**, not the plan's
    "thin wrapper" stub: a renamed Electron exe next to its own resources
    is already a valid screensaver (Windows launches it with `/s`, which
    launch.ts handles), while a real stub would mean building and shipping
    a second binary. NSIS `customInstall` does the copy;
    `customUnInstall` deletes it and deregisters **only** if
    `SCRNSAVE.EXE` currently points at our path. Cost: one duplicated exe
    on disk (the Electron exe is not small); the resources beside it
    (asar, dlls) are shared, and a stub can still replace the copy in a
    later release without touching the registration logic.
12. **Registration is per-user via `reg.exe`** (execFile with an argument
    vector, never a shell string): `HKCU\Control Panel\Desktop\SCRNSAVE.EXE`
    plus `ScreenSaveActive=1`; status = `reg query` parsed by a pure,
    unit-tested function (REG_SZ and REG_EXPAND_SZ, case-insensitive value
    name, path comparison case-insensitive). "Unset" only ever deletes the
    value when it points at us. Registering without the `.scr` present
    (unpackaged run) is refused with a helpful message. **All of this is
    untested on real Windows** — this machine is Linux; everything is
    guarded by `process.platform === 'win32'` and the UI row is hidden
    elsewhere. The NSIS include relies on electron-builder-provided
    `${APP_EXECUTABLE_FILENAME}` and LogicLib — verified against
    electron-builder 26's templates, not against a live installer build.
13. **Shortcut legend is a separate `#legend` element** (bottom-right,
    overlay-styled) rather than a fourth line inside `#overlay`: it must be
    able to flash at show start even when the overlay is toggled off, and
    the overlay element's visibility is all-or-nothing. Flash duration 6 s,
    then visibility follows the overlay toggle.
14. **Smoke harness launches with `--show` now** (manual-launch smoke would
    sit on the settings screen); the exercised path additionally injects
    ArrowRight/ArrowLeft before E/Q — if any hotkey wrongly exited, the app
    would quit before the assertions and the "[smoke] OK" line would never
    print. Verified on xvfb with a mixed fixture (4 EXIF burst JPEGs,
    2 PNGs, 1 s + 10 s H.264 MP4s): nav visible in the log, flag + queue +
    index assertions green, video ended and capped paths green. Warm start
    verified separately with a seeded `XDG_CONFIG_HOME`: run 1 builds
    index.json, run 2 logs "warm start from persisted index (8 files)".
15. **New flag keys N/T map to core's `rename`/`date`** with toast labels
    "rename" and "date fix" (the queue badge shows the raw type). The queue
    window got badge colors and updated key lists; it has no filter UI to
    extend (the plan's "labels/filters" reduces to labels here).

## post-v0.5 feedback tweaks (2026-07-18, unreleased)

16. **Manual launches are now an ordinary window** (980×820, resizable,
    native frame — close/minimize work; no more Alt+F4). The window goes
    fullscreen only while the show runs (showState IPC toggles
    `setFullScreen`); `--show`//s launches stay fullscreen+frameless for
    their whole lifetime. The settings subtitle line was removed.
17. **Moment gap copy** now states the real semantics (core `clusterByGap`):
    a shot joins the current moment when it is within the gap *of the
    previous shot* — chains can span longer than the gap in total.
18. **App icon**: `build/icon.png` (1024, rounded-tile) — the Companion's
    chevron glyph composited on dark slate `#0F172A`, generated with
    ImageMagick from `apps/mobile/assets/android-icon-foreground.png`.
    electron-builder picks it up by convention (the "default Electron icon"
    warning is gone); Windows .ico is derived by the builder. The matching
    mobile dark set (`icon-dark.png`, `android-icon-background-dark.png`,
    adaptive background `#0F172A`) is wired in `app.json` and takes effect
    on the next APK build. Light originals remain in the repo.
