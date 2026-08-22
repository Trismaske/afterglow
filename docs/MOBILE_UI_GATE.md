# Mobile UI release gate

`scripts/mobile-ui-gate.mjs` is the automated pre-release walk of Afterglow Companion's UI.
It drives the installed app on a connected Android device or emulator over plain adb (no extra tools).
It asserts that every main surface renders, every interaction works, and nothing regresses into a stuck busy state.

`scripts/mobile-ui-gate-all.mjs` fans the gate out over every connected device in parallel:

- one child gate per phone
- output tagged per device
- reports under `mobile-ui-gate-report/<serial>/`
- a non-zero exit when any device fails

The release gate's wall clock is then the slowest phone, not the sum.
Run the gate, plus the short manual pass below, before you tag any `mobile-m*` release.

## Running

```bash
# Install the release build on the target first, then:
node scripts/mobile-ui-gate.mjs                 # one connected device
node scripts/mobile-ui-gate.mjs --serial R5CW20KBA2W
node scripts/mobile-ui-gate.mjs --report-dir /tmp/gate   # failure screenshots land here
node scripts/mobile-ui-gate-all.mjs             # ALL connected devices AT ONCE (m0.8.2)
node scripts/mobile-ui-gate-all.mjs SERIAL1 SERIAL2      # or exactly these
```

Exit code 0 means the gate passed.
Any FAIL line exits 1 and captures a screenshot.
Each run first clears the report directory's `fail-*.png` files, so the directory always holds exactly the last run.
A green run leaves it empty.
The directory is gitignored throwaway evidence.
Nothing there needs keeping.

⚠️ **The gate makes real review decisions** (keeps, culls, edit flags, favourite/share intents) on the target's corpus.
Run it on a test device or emulator, never on a phone whose review state matters.

## What it covers

- Home: the goal card, the "N to review"/zero-state copy, the library totals line, and the cull-list row after a cull.
- Bottom bar: the tab order is Edit · Favourite · Home · Organize · Share, and the raised Home button navigates.
  The per-tab count badges both **register** a deck action and **release** it when the same photo is staged to cull.
  A staged cull is not waiting work (docs/STATE_MODEL.md).
- Every queue tab opens within budget and shows its heading.
- Stats: all THREE tabs.
  Each tab loads its own query set on first open, so the walk visits each tab separately.
  A tab that only renders after another one loaded would otherwise pass unnoticed.
  Activity shows the 30-day chart and shooting-vs-reviewing.
  Forecast shows a finish line or an explicit refusal, never a blank card.
  Habits shows the rhythm and the turnaround-carrying queue rows.
- Progress: both chip rows on screen, verdicts AND pending actions, with the grid header.
  This is what proves the two layers still render as two rows.
- Deck: all four action chips (Edit / Favourite / Organize / Share) respond without a lingering "Saving…".
  Organize is a pure toggle (m0.8.2 F5).
  A swipe advances the pager.
  Cull advances the pager, and decided photos stay in the deck badged.
  Keep completes.
  All of this holds while any background scan runs.
  The walk chooses the choreography unit from the timeline overview by its truthful pending count, so it never depends on the head unit's shape.
- Deck ZOOM, asserted through the pager because the zoom overlay has no text to read.
  A double tap zooms.
  A horizontal drag while zoomed must NOT page (the overlay is taking touches).
  A second double tap resets, and the drag must page again.
  One chain, four claims.
  This is the step that catches a gesture stack where either the pager or the overlay has stopped receiving touches.
- Compare: a tap on the stage flips between the two photos, through the opponent picker when more than two candidates are eligible.
  The stage is a `Pressable` under the gesture detector, a different arrangement from the deck's, which can break on its own.
  The step leaves via "Close — no verdict", so it decides nothing.
- The standard viewer's own pager: opened from a History row and swiped, with an assertion that the position advances.
  It is a second pager under a second gesture stack, and the deck's swipe passing says nothing about it.
- Organize queue: hosts the album picker (open and cancel, mutation-free), where album assignment lives.

Responsiveness budgets are wall-clock from the tap to the expected UI state appearing in a `uiautomator` dump (~0.3–0.8 s per dump).
The budgets are therefore deliberately coarse (1.5–3 s).
They catch the stuck-busy class of regression (m0.8's multi-second "Saving…" under scan load), not frame-level latency.

One step IS frame-level: the finish-advance transition probe (m0.8.5).
It records the finish-button advance with `screenrecord`, decodes the clip to raw RGB via ffmpeg on the host (ffmpeg is a hard requirement of this step), and asserts per frame that the stage never reads blank and the control band never loses its keep-green button — the deck advances in place, and no frame may unmount the chrome.
The clip lands in the report dir as `finish-advance.mp4` either way.
A corpus too shallow to leave a next deck after the finish fails the step with a re-seed note rather than skipping silently.
Caveat in a failure: an all-black photo (pocket shot) inside the transition can trip the blank-stage read — inspect the clip before acting on it.

## Target requirements

- The **release** APK installed (`adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk`), with photo permission granted once by hand.
  A dev-client build fails every step.
  The gate relaunches the app through the launcher intent, which a dev client answers with its "connect to a development server" screen rather than the app.
- A photo corpus with unreviewed photos (the deck steps hard-fail without one).
  Physical test phones qualify as-is.
- A **fresh app state** (`adb shell pm clear`, re-grant permission, let the scan finish).
  The deck chips are toggles and the F21 badge step asserts exact deltas from the run's start, so a photo carrying queued actions from an earlier run flips chips OFF and inverts the arithmetic — repeat runs on used state fail the step against a healthy app (observed 2026-08-21).
  To seed the bundled emulator (`scripts/run-emulator.sh`):

  ```bash
  adb shell mkdir -p /sdcard/DCIM/Camera
  adb push test-photos/. /sdcard/DCIM/Camera/       # any local JPEGs
  adb shell content call --uri content://media/none/ --method scan_volume --arg external_primary
  ```

## Release-pass recipes (proven by hand in m0.8.7; fold into the script — docs/TODO.md)

The m0.8.7 release-specific pass ran end to end as an agent-driven adb session using the §6.1–6.6 techniques in [ANDROID_DEVICE_TESTING.md](ANDROID_DEVICE_TESTING.md) (`scripts/adb-ui.sh` + generated media + the diag sink as the assertion surface).
Each recipe below is one working automated walk: seed → drive → assert.
They are the specification for extending this gate script; until then, an agent can replay them directly.

1. **Source-scope round trip (F18).**
   Picker: add a folder → assert the forced pass ran (`sink 'full pass: forced rescan'`) and Home's totals grew by exactly the folder's count; deselect → totals shrink by the same number and the day rows re-scope; re-add → totals return **with `embedded 0 fresh`** in the done line (byte-for-byte restore, nothing re-analyzed).
2. **Delta discipline (F27).**
   Push one EXIF-stripped JPEG in-source and one image into another app's folder (out-of-source), `scan_volume`, background+foreground the app, then assert the sink shows: `out-of-source change(s) ignored`, `DELTA wins`, `undated changed photo(s) landed by direct fetch`, and NO full-pass line.
3. **Grouping truth: eject, dissolve, un-eject, re-mint.**
   Seed a 5-variant burst (§6.3) → it must group as one unit.
   Eject two members ("Not related" ×2): each fires `sink 'targeted rescan'`, and the Timeline must then show BOTH a 3-shot core and a 2-shot group of the ejected pair (the dissolution rule).
   Viewer facts must read "not related to N photos"; the editor's Un-mark clears it and the targeted rescan lands a legal regroup.
   Land a 6th variant while the deck is open: the delta regroups beneath it, the deck holds its unit, and a verdict tap still writes cleanly.
4. **Strictness confirm (R8).**
   Tap a strictness chip → the dialog must carry the exact copy ("Regroups your whole library… never touched"); confirm → full pass; afterwards every count that encodes a decision (ring, day rows, staged culls) must be unchanged.
5. **Share-then-cull (F21).**
   Queue share on a photo, cull it → it must stay listed in the Share queue; dispatch via a direct-share target (Drive) → the label prompt is the dispatch proof, the receiver's "Uploaded N items" notification the physical one, and History must show `Shared · N photos · "label"`.
   Then queue an UNSENT share + edit on another photo, cull it, and the trash confirm must name both intents with correct n=1 copy before the OS consent.
6. **Error boundary on screen.**
   Queue an organize move on a photo whose MediaStore row is OWNED by another app → apply → the three-tier dialog must show our fact first ("lives in another app's own storage") and "Android said: …not allowed" verbatim last.
   (Favourite on the same photo legitimately succeeds — metadata is writable cross-app; do not read that as a missing failure.)
7. **Stats immutability around the trash.**
   Record the ring before confirming culls; after the OS consent and verification the ring must be UNCHANGED (credit happened at staging) and the day row must keep the trashed decisions counted.
8. **Badges and the eye.**
   With an SD folder in scope, one deck frame must show the SD glyph on stage and thumbnails, the folder pill on the stage only, and any gallery-flag hearts (F20).
   The header eye must empty the badge cluster from the dump and flip its own label; a picker row-select must pixel-diff to nothing outside the tapped row (§6.6).

## Manual pass (what automation cannot judge)

- Frame-level responsiveness when it matters (a perceived-latency complaint).
  Run `adb shell screenrecord`, tap the action, pull the video, and inspect the frames around the tap (`ffmpeg -i clip.mp4 -vsync 0 frames/f_%05d.png` + `ffprobe -show_entries frame=best_effort_timestamp_time`).
  m0.8.1 reference numbers: edit/favourite/share chips ≤ 100 ms, cull→advance ≤ 200 ms.
- OS consent flows the gate deliberately cancels or avoids: the trash confirmation, organize write requests, and the share sheet.
  Favourites do NOT prompt on any tested API (30/31/36): the platform decides, and the app's verify-after re-read is the safeguard. A missing favourite dialog is correct behavior, not a defect.
- Trash cancel: cancelling the system trash dialog keeps the photos staged, and the copy says nothing was touched.
- Upgrade in place: `adb install -r` of the new APK over the previous release must succeed (CI only ever installs onto a clean device).
- For a release touching mount or scan code: walk one SD eject/remount cycle (Home banner with counts, frozen groups, remount restores state byte-for-byte).
- Visual taste: the raised Home circle (filled on Home, outlined elsewhere), the goal-ring arc against its label, and badge/cradle rendering on both test DPIs.
- **PINCH, on all three zoom surfaces** (deck, viewer, Compare).
  `adb` drives one finger only, so no multi-touch gesture can be automated at all.
  Pinch to zoom, pan while zoomed, and double-tap to reset.
  Then test the two-pinch case: zoom, lift both fingers, and pinch again.
  The zoom must keep responding rather than freeze.
  In Compare, both photos must zoom together.
  Everything single-touch around these gestures (double-tap zoom and its reset, the flip, both pagers) is in the automated walk above.
  Pinch is the remainder.
