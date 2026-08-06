# Mobile UI release gate

`scripts/mobile-ui-gate.mjs` is the automated pre-release walk of Afterglow Companion's UI: it drives the installed app on a connected Android device or emulator over plain adb (no extra tools) and asserts that every main surface renders, every interaction works, and nothing regresses into a stuck busy state.
`scripts/mobile-ui-gate-all.mjs` fans it out over every connected device in parallel — one child gate per phone, output tagged per device, reports under `mobile-ui-gate-report/<serial>/`, non-zero exit when any device fails — so the release gate's wall clock is the slowest phone, not the sum.
Run it — plus the short manual pass below — before tagging any `mobile-m*` release.

## Running

```bash
# Install the release build on the target first, then:
node scripts/mobile-ui-gate.mjs                 # one connected device
node scripts/mobile-ui-gate.mjs --serial R5CW20KBA2W
node scripts/mobile-ui-gate.mjs --report-dir /tmp/gate   # failure screenshots land here
node scripts/mobile-ui-gate-all.mjs             # ALL connected devices AT ONCE (m0.8.2)
node scripts/mobile-ui-gate-all.mjs SERIAL1 SERIAL2      # or exactly these
```

Exit code 0 = gate passed; any FAIL line exits 1 and captures a screenshot. Each run clears the report dir's `fail-*.png` first, so what's in there is always exactly the last run — a green run leaves it empty. The dir is gitignored throwaway evidence; nothing there needs keeping.

⚠️ **The gate makes real review decisions** (keeps, culls, edit flags, favourite/share intents) on the target's corpus. Run it on a test device or emulator, never on a phone whose review state matters.

## What it covers

- Home: goal card, "N to review"/zero-state copy, the library totals line, cull-list row after a cull.
- Bottom bar: tab order Edit · Favourite · Home · Organize · Share, raised Home button navigates, and per-tab count badges both **register** a deck action and **release** it when the same photo is staged to cull (a staged cull is not waiting work — docs/STATE_MODEL.md).
- Every queue tab opens within budget and shows its heading.
- Stats: all THREE tabs. Each loads its own query set on first open, so each is walked separately — a tab that only renders after another one loaded would otherwise pass unnoticed. Activity (30-day chart + shooting-vs-reviewing), Forecast (a finish line or an explicit refusal, never a blank card), Habits (rhythm + the turnaround-carrying queue rows).
- Progress: both chip rows on screen — verdicts AND pending actions — with the grid header, which is what proves the two layers still render as two rows.
- Deck: all four action chips (Edit / Favourite / Organize / Share — Organize is a pure toggle, m0.8.2 F5) respond without a lingering "Saving…", a swipe advances the pager, Cull advances the pager (decided photos stay in the deck badged), Keep completes — all while any background scan runs. The choreography unit is chosen from the timeline overview by its truthful pending count, so the walk never depends on the head unit's shape.
- Deck ZOOM, asserted through the pager because the zoom overlay has no text to read: a double tap zooms, a horizontal drag while zoomed must NOT page (the overlay is taking touches), a second double tap resets, and the drag must page again. One chain, four claims — and it is the step that catches a gesture stack where either the pager or the overlay has stopped receiving touches.
- Compare: tapping the stage flips between the two photos (its stage is a `Pressable` under the gesture detector — a different arrangement from the deck's, which can break on its own), through the opponent picker when more than two candidates are eligible. Leaves via "Close — no verdict", so the step decides nothing.
- The standard viewer's own pager: opened from a History row, swiped, asserting the position advances. It is a second pager under a second gesture stack, and the deck's swipe passing says nothing about it.
- Organize queue: hosts the album picker (open and cancel, mutation-free), where album assignment lives now.

Responsiveness budgets are wall-clock from tap to the expected UI state appearing in a `uiautomator` dump (~0.3–0.8 s per dump), so they are deliberately coarse (1.5–3 s): they catch the stuck-busy class of regression (m0.8's multi-second "Saving…" under scan load), not frame-level latency.

## Target requirements

- The **release** APK installed (`adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk`) with photo permission granted once by hand. A dev-client build fails every step: the gate relaunches the app through the launcher intent, which a dev client answers with its "connect to a development server" screen rather than the app.
- A photo corpus with unreviewed photos (the deck steps hard-fail without one).
  Physical test phones qualify as-is. To seed the bundled emulator (`scripts/run-emulator.sh`):

  ```bash
  adb shell mkdir -p /sdcard/DCIM/Camera
  adb push test-photos/. /sdcard/DCIM/Camera/       # any local JPEGs
  adb shell content call --uri content://media/none/ --method scan_volume --arg external_primary
  ```

## Manual pass (what automation cannot judge)

- Frame-level responsiveness when it matters (a perceived-latency complaint): `adb shell screenrecord`, tap the action, pull the video and inspect frames around the tap (`ffmpeg -i clip.mp4 -vsync 0 frames/f_%05d.png` + `ffprobe -show_entries frame=best_effort_timestamp_time`). m0.8.1 reference numbers: edit/favourite/share chips ≤ 100 ms, cull→advance ≤ 200 ms.
- OS consent flows the gate deliberately cancels or avoids: trash confirmation, favourite/organize write requests, the share sheet.
- Visual taste: the raised Home circle (filled on Home, outlined elsewhere), goal-ring arc vs its label, badge/cradle rendering on both test DPIs.
- **PINCH, on all three zoom surfaces** (deck, viewer, Compare) — `adb` drives one finger only, so no multi-touch gesture can be automated at all. Pinch to zoom, pan while zoomed, double-tap to reset; then the two-pinch case: zoom, lift both fingers, pinch again — the zoom must keep responding rather than freeze. In Compare, both photos must zoom together. Everything single-touch around these (double-tap zoom and its reset, the flip, both pagers) is now in the automated walk above; pinch is the remainder.
