# Assumptions log

Decisions made autonomously during the 2026-07-17 build (core v0.1.0, desktop v0.1–v0.4,
mobile m0.1–m0.3). This file is the **review shortlist** — the calls most worth Tristan's
attention. The complete per-train logs are in
[assumptions-core.md](assumptions-core.md), [assumptions-desktop.md](assumptions-desktop.md),
and [assumptions-mobile.md](assumptions-mobile.md).

## Needs your eyes most

1. **Nothing mobile has run on a device.** No adb/emulator on this machine, so m0.1–m0.3
   are verified by typecheck, 29 unit tests, and Metro bundle exports only. First real run:
   `npx expo run:android` (dev build — Expo Go won't do; media permissions need it).
   Gesture feel (pinch-zoom, A/B flip) and ACTION_EDIT behavior per editor/OEM are the
   biggest unknowns.
2. **CI workflows are authored but unproven** until you push a `desktop-v*` tag / PR to
   GitHub. Windows installer has never been built (Linux-only sanity check of
   electron-builder ran clean).
3. **Everything is on branch `initial`** with local tags (`core-v0.1.0`,
   `desktop-v0.1`…`v0.4`, `mobile-m0.1`…`m0.3`). Nothing pushed. Merge to `main` via PR
   when ready.
4. **Delete-path conservatism (mobile):** the only call that deletes anything is
   `MediaLibrary.deleteAssetsAsync` behind the cull-list confirm (and, since m0.3, the
   explicit "cull the original" prompt). A rejected system dialog is treated as user
   cancel. If the app dies between the system delete and the SQLite write, the batch
   resumes staged.

## Tooling & architecture

5. Desktop renderer is **vanilla TS + esbuild, no React/Vite** — a slideshow is DOM-light;
   mobile keeps React via Expo (SDK 57 / RN 0.86 / React 19.2).
6. `@afterglow/core` compiles to `dist/` (tsc, ESM with `.js` import extensions); all
   randomness/time is injected (no `Math.random`/`Date.now` defaults). Apps consume the
   built output.
7. Mobile `to_edit`/`done` states live **in SQLite only**, not in core's session model
   (m0.2 kept core untouched while the desktop train ran). m0.3's "Reconsider" culls use a
   snapshot-rewrite escape hatch because core has no `kept→culled` transition — worth
   promoting to a real core API in m0.4.
8. Duel history has two stores by design: core's session snapshot is authoritative
   in-session; the `duels` SQLite table is the durable cross-session archive (same
   transaction, can't diverge).

## v0.5 / m0.5 (2026-07-18 feedback release) — needs your eyes

25. **Windows screensaver integration has never run on Windows.** The `.scr` is a
    NSIS-installed copy of the app exe (renamed Electron exe; main handles `/s`,
    `/p` quits, `/c` opens settings), registered via HKCU `SCRNSAVE.EXE` by the
    settings button. Registry parsing is unit-tested; everything else is
    platform-guarded and first exercised by the v0.5 CI installer + a Windows
    tester. Full details: assumptions-desktop.md "desktop-v0.5".
26. **Session "never discard decisions" rule (mobile):** replacing an unfinished
    session banks kept→done first, but interim staged culls are NOT carried — a
    delete list must be re-earned in a live session (conservative delete-path
    rule). Reworded dialog says so.
27. **"Don't split groups" extends the cap along the time-gap cluster boundary**
    (not the similarity-refined one; refinement only splits, so no final group is
    ever cut), bounded at +200 photos.
28. **Similarity scale shifted looser** (12/16/20/26/32, default 20 = old Loose-ish;
    old Normal 12 is the new Strictest) + a 0–64 slider. Stored values re-map
    without migration. The new scale is untested against a real photo library.
29. **Deck pinch-zoom shipped** as a two-pointer overlay that freezes the pager;
    known seam: a two-finger touch that starts as a scroll can nudge the pager a
    few px before the pinch takes over. Needs the on-device pass (assumptions-
    mobile.md m0.5 #19 lists everything device-only).
30. **mobile-release.yml is new and unproven**: on `mobile-m*` tags CI runs
    `expo prebuild` + Gradle and uploads the APK to a GitHub Release, signed with
    the standard shared debug keystore — same signature as the locally-built
    m0.4 APK (verified by fingerprint), so in-place upgrades work. Neither it nor
    desktop-release.yml had ever run before the v0.5 tags.

## Notable UX calls

9. Desktop exit-on-input: mouse must move >24 px from a baseline; keys/clicks exit
   immediately; `O` (overlay), `Q` (queue), `S` (settings), and flag keys `D/E/M/R` are
   excepted. Exit is paused while the queue window is open. `S` stops the show and opens
   settings (order mode, moment gap, cluster cap, video cap live there).
10. Flag undo = press the same flag key again within the 4 s toast, same photo only;
    afterwards use the queue window.
11. Smart order default: show always starts in shuffle and hot-swaps to smart when the
    background EXIF index lands; only clusters of ≥2 count as moments; mix weights fixed
    at 1:1 until v0.7.
12. Desktop video (v0.4): timestamps are file mtime (exifr can't read containers);
    undecodable files (HEVC .mov etc.) are skipped at play time rather than sniffed
    up-front; cap default 30 s.
13. Mobile edit detection is a convenience layer per the plan: in-place edits trust a
    moved `modificationTime` (lazy SHA-256 baselines, ≤5 file reads per run); copy
    detection uses filename kinship or creation-time ±2 s, and skips anything already
    tracked (kills burst false-positives). Misses are covered by manual mark-done.
14. Mobile convergence rule: unflagged keepers become `done` when a session is finished
    via Summary; abandoned sessions get re-reviewed.

## Dev environment (added 2026-07-17, emulator setup session)

19. **Android package ID is now `com.afterglow.companion`** (was Expo's default
    `com.anonymous.afterglowcompanion` for the very first emulator build; nothing
    had shipped, so the rename was free). Mirrors desktop's `com.afterglow.desktop`.
20. **Toolchain installs are user-local, no sudo**: Temurin JDK 21 + Android SDK
    under `~/Android`, pinned + checksum-verified in `scripts/setup-android-env.sh`.
    apt-based JDK install was rejected to keep the script sudo-free and the JDK
    version exactly pinned. Google's site lists SHA-1 for cmdline-tools; the SHA-256
    pin was computed from a download verified against that SHA-1.
21. **AVD**: Pixel 7, Android 16 (API 36, Google APIs, x86_64), named
    `afterglow-pixel7`, 4 GB RAM / 8 GB storage. KVM present via login ACL.
22. **Emulator media-scanner quirk** (worth knowing for fixture-based testing):
    EXIF dates on adb-pushed JPEGs got inconsistent `datetaken` values, and
    MediaStore rejects direct `datetaken` updates from the adb shell. App-level
    grouping was verified with an 8-photo cull group; per-timestamp clustering
    fidelity is better tested on a real phone.
23. The app was verified live on the emulator: Home → permission grant → session
    (8 to review, 1 group) → duel screen with A/B flip → bracket advance after
    "A is better". Screenshots in the session scratchpad, not committed.

## Smaller code decisions

15. `electronVersion` pinned to 37.10.3 in electron-builder.yml (hoisted workspace dep
    isn't resolvable from apps/desktop) — bump manually on upgrades.
16. Unsigned Windows builds will trip SmartScreen — README tells testers
    "More info → Run anyway" per the plan.
17. Desktop indexReady pushes the whole library over IPC — revisit at 100k+ photos.
18. Home screen (mobile) does one MediaStore count query per recent day on focus —
    revisit if it feels laggy on-device.
