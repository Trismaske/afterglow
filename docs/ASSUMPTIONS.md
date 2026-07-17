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

## Smaller code decisions

15. `electronVersion` pinned to 37.10.3 in electron-builder.yml (hoisted workspace dep
    isn't resolvable from apps/desktop) — bump manually on upgrades.
16. Unsigned Windows builds will trip SmartScreen — README tells testers
    "More info → Run anyway" per the plan.
17. Desktop indexReady pushes the whole library over IPC — revisit at 100k+ photos.
18. Home screen (mobile) does one MediaStore count query per recent day on focus —
    revisit if it feels laggy on-device.
