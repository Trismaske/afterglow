# TODO — open questions (not yet planned work)

This file parks questions that need their own investigation before they become plan items.
Keep entries short.
Promote an entry into a release plan or PLAN.md (roadmap / trigger-based backlog) once it is decided.
DELETE an entry the moment it is answered: a closed question left here reads as open work.

The file has two sections, and the split is the whole point.
The first section holds work that waits on **us** to decide something.
The second holds work that waits on **the world** to produce a trigger.
An entry that names a trigger belongs below.
An entry that names a design pass belongs above.
Nothing is scheduled here.
Released work lives in PLAN.md's roadmap and the current release docs.

Numbers change whenever an item closes, so **cross-references from code or other docs quote the title, never the number**.

## Open questions — a decision or a design pass, with no trigger to wait for

1. **In-app recovery-grade data reset (danger zone)** (Tristan, 2026-07-24; reworded 2026-07-29).
   A persistently failing startup recovery escalates its error copy toward Android's Clear-data escape hatch after 3 consecutive failures.
   Decide whether Settings should gain an in-app "reset app data" row so the remedy lives inside the app.
   m0.8.3 narrowed the scope: the volume-scoped "Forget this card" flow covers healthy-DB data hygiene, so only the RECOVERY case remains here.
   In that case the DB itself is broken.
   So the reset must work at the file/schema level (not through row deletes) and must be reachable from the failure path (typed/strong confirmation, photos untouched).
   A destructive flow like this deserves its own design pass.

2. **Upstream expo-image-manipulator native leak report** (m0.8 device testing, 2026-07-25).
   The scan's thumbnail decode path observed a native-memory leak in `expo-image-manipulator`.
   A workaround is in place: the embedder module decodes natively instead.
   File a minimal-repro issue upstream so the workaround can eventually be dropped.

3. **Field diagnostics: user-shareable export** (Tristan, m0.8.3 grilling; capture slice shipped m0.8.7).
   Every console line now persists to the on-device rotating sink (`lib/diagLog.ts` + `modules/diag-log`: 50 MB, ten segments, crash hooks included), so weeks of field evidence survive — but only `adb pull` can read it.
   Wanted: users share a diagnostics bundle from the phone itself.
   The EXPORT needs its own design pass:
   - privacy: paths and filenames appear in lines, so scrub or disclose is a hard gate before anything leaves the device
   - a Settings "Share diagnostics" row via the share sheet
   - how this composes with the v1 re-gating of the `[perf]` lines
   The ~44 silent `.catch(() => {})` swallows are a noted class the sink makes cheap to instrument case-by-case when suspicion arises.

4. **History event streams for actions, and a duel-history surface** (Tristan, m0.8.3 matrix).
   History's two streams are photo VERDICTS and SHARE events.
   Favourite/organize/edit activity appears only as badges on verdict rows.
   Duel records have NO browse surface at all.
   They exist as data, and the append-only duels contract (m0.8.7) preserves every row for exactly this future.
   Wanted: action events in the History feed (queued/applied, with the same keyset paging discipline), and somewhere to SEE a group's Compare history.
   This needs its own design pass: which actions are events vs noise, feed volume, and where duel history lives (viewer decision panel vs group sheet).

5. **A favourite EVENT log** (narrowed 2026-07-31 from the m0.8.3 action-layer entry, whose other two parts went into m0.8.7).
   The favourite surfaces are directional current-state projections of one `photo_actions` row, which is the honest reading of that model.
   But two consequences survive m0.8.7's `IS_FAVORITE` reconcile, which only makes the CURRENT state readable.
   First, lifetime "favourites applied" is really *current verified favourites*.
   Second, History shows favourite state rather than events, so an Afterglow-side un-favourite erases an unreviewed photo's only trace once verified.
   A log mirroring share's batch log answers both.
   Until then the directional predicates (FAVOURITE_HELD, the lifetime COALESCE(applied_target, target) read, the heart-off 'removing' badge) are settled behavior.
   Decide it with "History event streams for actions" above: one feed, one design.

6. **Type-scale and token pass** (returned from m0.8.7, which ran long — its plan's own lift-out rider).
   The measured drift: headings 28 or 24; subtitles 12–16; thumbnail radii 8, 9 and 10; chip radii 10–20; scrim opacities 0.55–0.7; root paddings 12–20.
   One pass over the type scale and spacing tokens, with before/after screenshots from a device pass; Summary's blank loading view and the UnitCard thumbnail-size question (Tristan leans "probably okay as is") ride it.

7. **Capture-time truth: DST-normalized times, and photos shot in another timezone** (Tristan, m0.8.3 grilling Q2).
   EXIF `DateTimeOriginal` is a ZONELESS wall time.
   Every consumer, Android's own `DATE_TAKEN` extraction and our D15 rescue alike, reads it in whatever zone applies at read time.
   Two consequences follow, both currently silent.
   (a) JS NORMALIZES a wall time inside a DST spring-forward gap (02:30 → 03:30, same day).
   This is deliberate: the capture DAY survives, and rejecting would demote a real photo to Unknown day.
   (b) A photo shot in a different timezone renders at device-local time.
   Near midnight this can place it on the WRONG capture day.
   That day is the key every day page, coverage streak, and day-scoped deck uses.
   Wanted: show the original local date/time (perhaps beside the device-local one), and badge times we normalized or shifted.
   Mechanism: EXIF 2.31's `OffsetTimeOriginal` recovers the true zone.
   Measured 2026-07-30: the S23's camera writes `+02:00`, and the D300s NEFs carry NO offset tag.
   So the RAW workflow's zone is unrecoverable from EXIF, and GPS timestamps are the only secondary source.
   This needs its own design pass:
   - which time `photos.day` keys on (changing it re-days existing rows and re-windows their groups)
   - whether the offset gets stored (schema) and read natively (the rescue reads only `TAG_DATETIME_ORIGINAL` today)
   - where the original zone surfaces (viewer decision panel vs deck header)
   - what an offset-less photo shows: the honest answer may be "no claim" rather than a guess

8. **Goal notes do not survive process death** (codex, m0.8.5 device-pass review round 3).
   Every `noteDecisions` call is in-memory and post-commit: a process killed between a verdict's commit and its note evaluating loses the note, on every verdict path.
   The sharpest instance is the edited-copy trash flow, where Android's consent dialog sits between the staging commit and Home's note — a kill there leaves the row in today's ring while the celebration baseline later initializes at-or-past the goal, so that day's crossing never fires.
   Damage is bounded: the ring (durable) stays correct, and the miss self-heals at the next day boundary.
   A durable fix means persisting un-noted credits and replaying them from startup recovery — its own design pass.

9. **Script the release-pass recipes into the UI gate** (from m0.8.7's agent-driven device pass).
   The eight recipes in [MOBILE_UI_GATE.md](MOBILE_UI_GATE.md) "Release-pass recipes" each ran end to end by hand-driven adb (harness: `scripts/adb-ui.sh`; techniques: [ANDROID_DEVICE_TESTING.md](ANDROID_DEVICE_TESTING.md) §6.1–6.6) — seeded media, sink-line assertions, pixel diffs, OS-dialog walks included.
   The open design questions before they join `scripts/mobile-ui-gate.mjs`: the gate is deliberately mutation-light while these recipes seed media, change sources/strictness, and trash photos (a separate `--release-pass` mode? a second script sharing the gate's helpers?); host-side deps appear (ImageMagick, exiftool, PIL); and several steps take minutes of scan time each, so the pass wants its own budget and ordering.
   Until scripted, an agent replays the recipes directly — they are written as specifications.

10. **One timestamp per decision write, carried into the goal note** (codex, m0.8.5 device-pass review).
   Every verdict path samples `Date.now()` twice: once for the write's `decided_at` (freshness judged against that day) and again inside `noteDecisions` (the note's day, captured synchronously at the call).
   A transaction that spans local midnight can therefore compute freshness against the old day while the note evaluates against the new one.
   The damage is bounded: the window is one sub-second transaction at exactly midnight, `noteDecisions` already drops notes whose chain runs on a later day than their call, and the per-day cache re-reads on the next note.
   The fix is systemic, not local — `ReviewDecisionResult` carrying its `at`, and `noteDecisions` taking it — and touches every verdict wrapper, so it wants its own small pass rather than a release-tail patch.

   **ARW is dated by file mtime, not EXIF** (measured 2026-07-30, S23 / API 36, controlled push experiment).
   The same value reproduces on an API 30 emulator and the S10e / API 31, so it is not version-specific.
   MediaStore never reads a Sony ARW's `DateTimeOriginal`:

   | File | EXIF DateTimeOriginal | file mtime | MediaStore `datetaken` |
   | --- | --- | --- | --- |
   | `DSC09576.ARW` (arrived normally) | 2026-07-30 03:00:43 | 03:00:42 | 03:00:43 — *looks* right |
   | same bytes, `adb push`ed | 2026-07-30 03:00:43 | 21:11:59 | 21:15:43 |
   | fresh A6000 ARW, never on a device | 2026-05-08 23:21:52 | 2026-05-09 01:21:52 | 2026-05-09 01:21:52 |

   The third row is the proof: `datetaken` equals the mtime exactly while the EXIF says something 2 h different.
   A normally-imported file only *looks* correct because its mtime happens to match capture time.
   So any workflow that rewrites mtime (copy, sync, backup restore) silently re-dates the photo, on the RAW formats the README advertises as fully supported.
   The D15 rescue cannot intervene: it only runs on rows MediaStore reports as UNDATED, and these carry a confident wrong date.
   Unresolved loose end: the pushed copy's `datetaken` is 224 s AFTER its mtime rather than equal to it, yet byte-identical across three devices.
   The mtime rule fits the other two rows and not this one.
   Wanted: decide whether the native EXIF read should extend to dated-but-suspect rows (RAW mime types, or `datetaken == date_modified`).
   That extension would make this the same mechanism as the D15 rescue rather than a second one.
   The read-source half of the same family is related: "A D15-rescued photo's date does not reach the Progress library scope".
   That item was designed and shipped in m0.8.6.

## Waiting for a trigger

This section holds fixes whose shape is known but whose value is unproven, and questions whose answer needs evidence that does not exist yet.
Each entry names the event that promotes it: a user hitting it, field data arriving, or an external release.
Same hygiene as above: promote on trigger, delete when answered.

- **A floor note in the GitHub Release body?** (m0.8.4; trigger: the tester group grows.)
  The Android 11 floor is documented in the README only.
  Revisit stating it in the release body itself when more testers join, so a refused install is explained where the download happened.
- **Confirm the real distribution of per-user median review deltas** (m0.8.2, 2026-07-28).
  Arithmetic settles the sitting boundary (`lib/forecast.ts`: K = 40, 60 s floor, 5 min ceiling, with the crossover table in the header).
  Every parameter follows from ONE remaining assumption: per-user median deltas run roughly 3 s at the fast end, ~5 s typical, and 45-60 s at the slow tail.
  The source is Tristan, from his own reviewing: groups of similar photos draw repeated duels and long first decisions.
  Nothing measures that yet.
  What to check once anyone has a month of real use: the median of `getRecentDecisionStamps` deltas, per device.
  If typical medians land materially below 1.5 s or above 7.5 s, the clamps govern instead of K, and the multiple needs revisiting.
  Inside that band the current values stand.
  NOTE the reconstruction is lossy: `decided_at` re-stamps on every re-decide, and the read is bounded to 2,000 stamps.
  So a durable sitting record would need its own table.
  The earlier "sweep K for a plateau" method is deliberately dropped: it tests stability, not correctness, and a plateau can sit in the wrong place.

- **Re-gate the `[perf]` logs at v1** (Tristan, 2026-07-28; trigger: the v1 release).
  m0.8.2 ungated `lib/perfLog.ts` so the field tripwires actually fire in the builds we hand to testers.
  Every on-device pass runs a release build, and a timing measured on a dev bundle is not a claim about the app.
  That trade is right while builds go to friends with a debug keystore.
  It is not right for a public v1, where `console.log` on a user's device is noise they never asked for.
  Options to weigh then:
  - `__DEV__` gating again (loses field diagnosis entirely)
  - a Settings toggle calling `setPerfLogging(true)` (honest, but earns a settings row off one use case)
  - a build flavour

  Decide with the v1 distribution model in hand, not before.

- **Revisit the weekly full pass once the delta has field time** (Tristan, 2026-07-28; trigger: a few weeks of real use).
  The delta scan runs a full reconciliation pass at least weekly.
  Its original justification, a permanent delete numerically masked by an add, largely evaporated during the build.
  That masking survives only one launch: ingesting the add lifts `tracked` above `media`, and the count tripwire fires on the next open.
  The weekly pass now guards two things.
  The first is **unknown-unknowns in a feature that is one day old**: device testing produced four defects in a single day that no amount of reasoning had surfaced.
  The second is the pathological case of a masked permanent delete recurring every session.
  That is a legitimate reason to keep it, and a bad reason to keep it forever.
  Once the delta has weeks of field evidence (no `delta left the library inconsistent` warnings, no tripwire firing unexpectedly), decide between three options.
  Lengthen it (monthly), make it opportunistic (charging + idle only), or drop it and rely on the two count checks plus the manual Rescan.
  Cost on the S23 is ~262 s of CPU per run.

  **If it stays, "idle + charging, in the background" is the wanted shape** (Tristan).
  But it is not low effort.
  These are the blockers, measured/checked 2026-07-28 rather than assumed:
  - `expo-background-task`'s `BackgroundTaskOptions` exposes **only** `minimumInterval`.
    `requiresCharging`/`requiresDeviceIdle` are WorkManager features its wrapper does not surface.
    Getting them means scheduling our own `PeriodicWorkRequest` in `media-store-actions` PLUS `expo-task-manager`/`expo-background-task` to host the JS.
    That is two new dependencies.
  - **The scan has no cross-process lock.**
    `startContinuousScan` is single-flight per PROCESS, and a headless worker is another process.
    So a background and a foreground pass could run together: two embedding engines, two walks, interleaved window writes.
    SQLite's `busy_timeout` serialises the writes rather than failing, so it is wasteful rather than corrupting.
    But it needs a DB-backed lease.
  - **A full pass may not fit.**
    WorkManager allows ~10 minutes.
    A routine pass is 262 s (fits), but the post-upgrade re-embed measured 24.5 min (does not).
    Which one is about to run is not knowable in advance, so it would have to be resumable.
  - **Samsung kills background work aggressively**, so a `requiresDeviceIdle` job may fire rarely or never on both test devices.
    That makes it hard to verify the job works at all.

  Cheap partial if something is wanted sooner: gate the EXISTING in-app weekly pass on "device is charging", deferring while on battery up to a hard cap.
  That is a few lines of BatteryManager in the native module we already ship: no new deps, no new process.
  It only helps a user who opens the app while plugged in, and it adds a deferral rule to a mechanism that may be deleted.
  So it is listed as an option rather than a recommendation.

- **Coalesce tiny singles runs?** (m0.8.2 build, settled as keep-as-is by Tristan 2026-07-29; trigger: tester complaints about ceremony.)
  A sparse-photo stretch produces one timeline card and one one-photo deck per day (device-observed: dozens at the head on both phones).
  This is honest capture-order review, and auto-advance chains through them.
  But if testers find it tedious, the option is merging adjacent small runs across day boundaries until they reach a minimum size.
  The cost is blurring the day-scoped run model.
  The shipped m0.8.2 plan's appendix 34 records the full trade (git history).
  **m0.8.6's Timeline is the likeliest trigger**: its "Everything" filter shows the completed one-photo days that the pending feed hides today.
  That multiplies what a sparse stretch puts on screen (the 2026-07-31 round, F2).

- **UI-gate scope configuration, and chart-interaction steps** (Tristan, 2026-08-19, m0.8.6 device pass).
  Two wants from one pass: histogram-interaction steps (tap a month, assert the chart holds still and the grid filters — the F8 class), and a way to run only the gate sections whose surfaces a release touched, since the full walk is slow and most releases touch a few screens.
  The counterargument to scoping: the full walk is exactly what catches cross-surface regressions nobody predicted (the m0.8.5 finish-advance probe caught a pager desync from a navigation change).
  Decide the split — perhaps named section groups with an explicit --all default — before adding more steps makes the walk slower.

- **Verify the UI gate's PiP dismissal against a live PiP** (2026-07-29).
  A YouTube picture-in-picture window ate the Stats tap without taking the foreground.
  The gate now force-stops known PiP apps at start (`dismissPipOverlays`).
  But Tristan closed the live PiP manually before the logic ever ran against one, so it is untested in anger.
  Next time a PiP is up anyway, run the gate before closing it.

- **Measure `k`, the delta scan's per-range cost** (2026-07-28; trigger: field logs from normal use).
  `lib/deltaScan.ts` charges `RANGE_COST_IN_PHOTOS = 2`: a range costs about two photos' worth of work.
  The value derives from a ranged MediaStore query being the same order as a bucket cursor (~0.5 ms, called 15 ms to be generous).
  The measured per-photo cost is 7.5 ms (S23) / 14.3 ms (S10e).
  Nobody has measured `k` directly.
  It is safe to leave: the value enters the cost formula rather than changing its shape.
  Every wrong answer degrades to a full pass, which is what shipped before the delta existed.
  To measure it, time `pageAndGroup` against `ranges.length` and `covered` across real passes.
  The `[scan] delta …` line already prints both terms.

- **Organize accepts photos Android will never let it move** (measured on the S10e, 2026-07-31).
  A photo under another package's `Android/media/<pkg>/` tree goes through queueing, album assignment, and consent like any other before the platform refuses it.
  The example is WhatsApp's `WhatsApp Images`: 858 photos on that device.
  Android's own words, captured on device:
  `IllegalArgumentException: Changing ownership from …/Android/media/com.whatsapp/… to …/DCIM/… not allowed`.

  m0.8.4 fixed the SILENCE (`lib/organizeFailures.ts`: the move run now explains itself).
  What remains is purely the wasted trip.
  The queue takes the photo, the user assigns an album and approves an OS consent dialog, and only then learns it can never work.
  The fix is a queue-time refusal, the shape m0.8.3 already used for SD photos.
  Its real cost is knowing the full set of unmovable paths.
  `Android/media/` and `Android/data/` are two, and whether that is the whole rule is unverified.
  The dialog makes this cheap to leave: it tells a user who hits it exactly what happened and what to do.

  Trigger: a tester organising app-media photos often enough that the wasted consent tap, rather than the confusion, is the complaint.

- **Rescued photos never window with same-moment dated photos** (m0.8.3 grilling Q9).
  A D15-rescued photo carries its real timestamp but pages in MediaStore's undated batch.
  So an NEF+JPEG same-moment pair reviews as two separate cards.
  In practice this means NEF (measured on the S23: NEF `datetaken` NULL, DNG and ARW both dated).
  Rescued photos group stably among themselves.
  The fix is a designed re-merge of rescued photos into the dated windowing stream (plan m0.8.3 B8 deferred real-pair grouping).
  Trigger: a tester actually reviewing RAW+JPEG pairs and wanting them on one card.

- **Bucket-id hash collision: named-folder warning** (m0.8.3 grilling Q11).
  A cross-volume BUCKET_ID hash collision (~0.005% lifetime odds, measured 0 across 643 buckets on the S10e) would over-include another folder's photos in MediaStore-paged grids.
  It would also cause repeated tripwire full-passes.
  Durable state stays correct, because ingestion stamps the true volume identity.
  Fix shape: detect at catalog load, name the two colliding folders, advise rename/deselect.
  Trigger: a tester's grid shows an unselected folder's photos, or logs show persistent tripwire full-passes with no library change.

- **EXIF-failure retry cap** (m0.8.3 grilling Q18a).
  A failed (I/O-level) EXIF rescue read withholds the scan fingerprint so the next open retries.
  That is correct and bounded for transient failures.
  But a file that stays indexed yet permanently throws on open would force a pass every open.
  Measured unreachable via file corruption: lenient EXIF parsing completes-null on truncated/garbled NEFs (S10e, 2026-07-30).
  Only a persistent open-failure could trigger it.
  Fix shape: cap consecutive identical-content retries, then stamp honestly-undated.
  Trigger: field logs (TODO "Field diagnostics" item) showing the same `exifFailed` warning across consecutive passes.
