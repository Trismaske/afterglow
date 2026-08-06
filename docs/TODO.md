# TODO — open questions (not yet planned work)

Parking lot for questions that need their own investigation before they
become plan items. Keep entries short; promote them into a release plan or
PLAN.md (roadmap / trigger-based backlog) once decided, and DELETE one the
moment it is answered — a closed question left here reads as open work.

Two sections, and the split is the whole point: the first holds work that
is waiting on **us** to decide something, the second work waiting on **the
world** to produce a trigger. An entry that names a trigger belongs below;
one that names a design pass belongs above. Nothing is scheduled here —
released work lives in PLAN.md's roadmap and the current release docs.

Numbers renumber whenever an item closes, so **cross-references from code
or other docs quote the title, never the number**.

## Open questions — a decision or a design pass, with no trigger to wait for

1. **In-app recovery-grade data reset (danger zone)** (Tristan,
   2026-07-24; reworded 2026-07-29). A persistently failing startup
   recovery currently escalates its error copy toward Android's
   Clear-data escape hatch after 3 consecutive failures. Decide whether
   Settings should gain an in-app "reset app data" row so the remedy
   lives inside the app. Scope narrowed by m0.8.3: the volume-scoped
   "Forget this card" flow covers healthy-DB data hygiene, so what
   remains here is the RECOVERY case — the DB itself is broken, so the
   reset must work at the file/schema level (not through row deletes)
   and be reachable from the failure path (typed/strong confirmation,
   photos untouched). A destructive flow like this deserves its own
   design pass.

2. **Upstream expo-image-manipulator native leak report** (m0.8 device
   testing, 2026-07-25). The scan's thumbnail decode path observed a
   native-memory leak in `expo-image-manipulator` (worked around — the
   embedder module decodes natively instead). File a minimal-repro issue
   upstream so the workaround can eventually be dropped.

3. **Group a detected edited copy with its original** (Tristan,
    2026-07-28). The de-dupe case is obvious — an editor that saves a
    copy leaves you holding two near-identical photos — but the scan
    cannot pair them today, and the blocker is specific: the regroup
    boundary (`lib/regroupBoundary.ts`, m0.8 decision 5) freezes any
    photo whose state has left `unreviewed`, and freezes a whole group if
    ANY member has. By the time a copy is detected the original is either
    kept-with-an-edit or staged to cull, so both ends are frozen and no
    group can form. The copy itself is now written `unreviewed`
    (m0.8.2), so the one case that DOES pair is flagging an edit while
    the original is still undecided — both stay unfrozen and the scan
    groups them normally.
    Deciding this means reopening decision 5: either an explicit
    "detected copy joins its original's group" write that bypasses the
    freeze, or a narrower freeze that permits ADDING a member to a
    reviewed group without rewriting it. **Re-read this once m0.8.6
    lands** (docs/Feedback_m0.8.x.md, L2): that release reopens decision
    5 in a different narrow direction — the freeze follows a photo's
    CURRENT state rather than its history — which changes this blocker's
    shape without answering it, since a detected copy's original is
    still kept-with-an-edit or staged at detection time. Worth doing alongside the
    question of what the copy prompt should offer — Tristan notes the
    use case for copy-saving editors is unclear in the first place, and
    a substantially cropped copy may genuinely be a different photo.

4. **Field diagnostics: persistent capture + user-shareable export**
    (Tristan, m0.8.3 grilling). Today every field diagnostic —
    `[scan]`/`[perf]` lines, count tripwires, fallback warnings — is a
    plain console line, visible only over adb and gone with the
    process. Wanted: users run the app in the field for weeks, then
    share a diagnostics bundle we can analyze for weirdness they never
    noticed (silent-safe events like tripwire full-passes, fallback
    badges, hash-collision symptoms are exactly the class that needs
    this). Needs its own design pass: persistent ring buffer (size- and
    time-bounded), what gets captured (log lines vs structured events),
    privacy (paths/filenames in lines — scrub or disclose), a Settings
    "Share diagnostics" row via the share sheet, and how this composes
    with the v1 re-gating of the `[perf]` lines.

5. **History event streams for actions, and a duel-history surface**
    (Tristan, m0.8.3 matrix). History's two streams are photo VERDICTS
    and SHARE events — favourite/organize/edit activity appears only as
    badges on verdict rows, and duel records have NO browse surface at
    all (they exist as data: star provenance, whole-table revalidation,
    the Q13 permanence split protects them for exactly this future).
    Wanted: action events in the History feed (queued/applied, with the
    same keyset paging discipline) and somewhere to SEE a group's
    Compare history. Needs its own design pass: which actions are
    events vs noise, feed volume, and where duel history lives (viewer
    decision panel vs group sheet).

6. **A favourite EVENT log** (narrowed 2026-07-31 from the m0.8.3
    action-layer entry, whose other two parts went into m0.8.7).
    The favourite surfaces are directional current-state projections of
    one `photo_actions` row — the honest reading of that model, but two
    consequences survive m0.8.7's `IS_FAVORITE` reconcile, which only
    makes the CURRENT state readable: lifetime "favourites applied" is
    really *current verified favourites*, and History shows favourite
    state rather than events, so an Afterglow-side un-favourite erases an
    unreviewed photo's only trace once verified. A log mirroring share's
    batch log answers both. Until then the directional predicates
    (FAVOURITE_HELD, the lifetime COALESCE(applied_target, target) read,
    the heart-off 'removing' badge) are settled behavior. Decide it with
    "History event streams for actions" above — one feed, one design.

7. **Capture-time truth: DST-normalized times, and photos shot in
    another timezone** (Tristan, m0.8.3 grilling Q2). EXIF
    `DateTimeOriginal` is a ZONELESS wall time, so every consumer —
    Android's own `DATE_TAKEN` extraction and our D15 rescue alike —
    reads it in whatever zone applies at read time. Two consequences,
    both currently silent: (a) a wall time inside a DST spring-forward
    gap is NORMALIZED by JS (02:30 → 03:30, same day; deliberate — the
    capture DAY survives, and rejecting would demote a real photo to
    Unknown day); (b) a photo shot in a different timezone renders at
    device-local time, which near midnight can place it on the WRONG
    capture day — the key every day page, coverage streak, and day-scoped
    deck uses. Wanted: show the original local date/time (perhaps beside
    the device-local one) and badge times we normalized or shifted.
    Mechanism: EXIF 2.31's `OffsetTimeOriginal` recovers the true zone —
    measured 2026-07-30: the S23's camera writes `+02:00`, the D300s NEFs
    carry NO offset tag (so the RAW workflow's zone is unrecoverable from
    EXIF; GPS timestamps are the only secondary source). Needs its own
    design pass: which time `photos.day` keys on (changing it re-days
    existing rows and re-windows their groups), whether the offset gets
    stored (schema) and read natively (the rescue reads only
    `TAG_DATETIME_ORIGINAL` today), where the original zone surfaces
    (viewer decision panel vs deck header), and what an offset-less photo
    shows — the honest answer may be "no claim" rather than a guess.

    **ARW is dated by file mtime, not EXIF** (measured 2026-07-30, S23 /
    API 36, controlled push experiment; the same value reproduces on an
    API 30 emulator and the S10e / API 31, so it is not version-specific).
    MediaStore never reads a Sony ARW's `DateTimeOriginal`:

    | File | EXIF DateTimeOriginal | file mtime | MediaStore `datetaken` |
    | --- | --- | --- | --- |
    | `DSC09576.ARW` (arrived normally) | 2026-07-30 03:00:43 | 03:00:42 | 03:00:43 — *looks* right |
    | same bytes, `adb push`ed | 2026-07-30 03:00:43 | 21:11:59 | 21:15:43 |
    | fresh A6000 ARW, never on a device | 2026-05-08 23:21:52 | 2026-05-09 01:21:52 | 2026-05-09 01:21:52 |

    The third row is the proof: `datetaken` equals the mtime exactly while
    the EXIF says something 2 h different. A normally-imported file only
    *looks* correct because its mtime happens to match capture time — so
    any workflow that rewrites mtime (copy, sync, backup restore) silently
    re-dates the photo, on the RAW formats the README advertises as fully
    supported. The D15 rescue cannot intervene: it only runs on rows
    MediaStore reports as UNDATED, and these carry a confident wrong date.
    Unresolved loose end: the pushed copy's `datetaken` is 224 s AFTER its
    mtime rather than equal to it, yet byte-identical across three
    devices — the mtime rule fits the other two rows and not this one.
    Wanted: whether the native EXIF read should extend to dated-but-
    suspect rows (RAW mime types, or `datetaken == date_modified`), which
    would make this the same mechanism as the D15 rescue rather than a
    second one. Related: the read-source half of the same family, "A
    D15-rescued photo's date does not reach the Progress library scope",
    which is designed and scheduled into m0.8.6
    (docs/Feedback_m0.8.x.md).

## Waiting for a trigger

Fixes whose shape is known but whose value is unproven, and questions
whose answer needs evidence that does not exist yet. Each names the
event that promotes it — a user hitting it, field data arriving, or an
external release. Same hygiene as above: promote on trigger, delete when
answered.

- **Confirm the real distribution of per-user median review deltas**
  (m0.8.2, 2026-07-28). The sitting boundary is settled by arithmetic
  (`lib/forecast.ts` — K = 40, 60 s floor, 5 min ceiling, with the
  crossover table in the header), and every parameter follows from ONE
  remaining assumption: that per-user median deltas run roughly 3 s at
  the fast end, ~5 s typical, and 45-60 s at the slow tail (Tristan,
  from his own reviewing — groups of similar photos draw repeated duels
  and long first decisions). Nothing measures that yet.
  What to check once anyone has a month of real use: the median of
  `getRecentDecisionStamps` deltas, per device. If typical medians land
  materially below 1.5 s or above 7.5 s, the clamps are governing
  instead of K and the multiple needs revisiting; inside that band the
  current values stand. NOTE the reconstruction is lossy — `decided_at`
  re-stamps on every re-decide and the read is bounded to 2,000 stamps,
  so a durable sitting record would need its own table. The earlier
  "sweep K for a plateau" method is deliberately dropped: it tests
  stability, not correctness, and a plateau can sit in the wrong place.

- **Re-gate the `[perf]` logs at v1** (Tristan, 2026-07-28; trigger:
  the v1 release). m0.8.2 ungated `lib/perfLog.ts` so the field
  tripwires actually fire in the builds we hand to testers — every
  on-device pass runs a release build, and a timing measured on a dev
  bundle is not a claim about the app. That trade is right while builds
  go to friends with a debug keystore; it is not right for a public
  v1, where `console.log` on a user's device is noise they never asked
  for. Options to weigh then: `__DEV__` gating again (loses field
  diagnosis entirely), a Settings toggle calling `setPerfLogging(true)`
  (honest, but earns a settings row off one use case), or a build
  flavour. Decide with the v1 distribution model in hand, not before.

- **Revisit the weekly full pass once the delta has field time**
  (Tristan, 2026-07-28; trigger: a few weeks of real use). The delta
  scan runs a full reconciliation pass at least weekly. Its original
  justification — a permanent delete numerically masked by an add —
  largely evaporated during the build: that masking survives only one
  launch, because ingesting the add lifts `tracked` above `media` and
  the count tripwire fires on the next open. What the weekly pass
  actually guards now is **unknown-unknowns in a feature that is one
  day old** (device testing produced four defects in a single day that
  no amount of reasoning had surfaced), plus the pathological case of a
  masked permanent delete recurring every session.
  That is a legitimate reason to keep it, and a bad reason to keep it
  forever. Once the delta has weeks of field evidence — no
  `delta left the library inconsistent` warnings, no tripwire firing
  unexpectedly — decide between lengthening it (monthly), making it
  opportunistic (charging + idle only), or dropping it and relying on
  the two count checks plus the manual Rescan. Cost on the S23 is
  ~262 s of CPU per run.

  **If it stays, "idle + charging, in the background" is the wanted
  shape** (Tristan) — but it is not low effort, and these are the
  blockers, measured/checked 2026-07-28 rather than assumed:
  - `expo-background-task`'s `BackgroundTaskOptions` exposes **only**
    `minimumInterval`; `requiresCharging`/`requiresDeviceIdle` are
    WorkManager features its wrapper does not surface. Getting them
    means scheduling our own `PeriodicWorkRequest` in
    `media-store-actions` PLUS `expo-task-manager`/`expo-background-task`
    to host the JS — two new dependencies.
  - **The scan has no cross-process lock.** `startContinuousScan` is
    single-flight per PROCESS; a headless worker is another process, so
    a background and a foreground pass could run together — two
    embedding engines, two walks, interleaved window writes. SQLite's
    `busy_timeout` serialises the writes rather than failing, so it is
    wasteful rather than corrupting, but it needs a DB-backed lease.
  - **A full pass may not fit.** WorkManager allows ~10 minutes; a
    routine pass is 262 s (fits) but the post-upgrade re-embed measured
    24.5 min (does not), and which one is about to run is not knowable
    in advance. It would have to be resumable.
  - **Samsung kills background work aggressively**, so a
    `requiresDeviceIdle` job may fire rarely or never on both test
    devices — hard to verify it works at all.

  Cheap partial if something is wanted sooner: gate the EXISTING in-app
  weekly pass on "device is charging" (a few lines of BatteryManager in
  the native module we already ship — no new deps, no new process),
  deferring while on battery up to a hard cap. It only helps a user who
  opens the app while plugged in, and it adds a deferral rule to a
  mechanism that may be deleted, so it is listed as an option rather
  than a recommendation.

- **Coalesce tiny singles runs?** (m0.8.2 build, settled as keep-as-is
  by Tristan 2026-07-29; trigger: tester complaints about ceremony.)
  A sparse-photo stretch produces one timeline card and one one-photo
  deck per day (device-observed: dozens at the head on both phones).
  Honest capture-order review, and auto-advance chains through them —
  but if testers find it tedious, the option is merging adjacent
  small runs across day boundaries until they reach a minimum size,
  at the cost of blurring the day-scoped run model (the full trade
  was recorded in the shipped m0.8.2 plan's appendix 34 — git
  history). **m0.8.6's Timeline is the likeliest trigger**: its
  "Everything" filter shows the completed one-photo days that the
  pending feed hides today, multiplying what a sparse stretch puts on
  screen (docs/Feedback_m0.8.x.md, F2).

- **Verify the UI gate's PiP dismissal against a live PiP**
  (2026-07-29). A YouTube picture-in-picture window ate the Stats tap
  without taking the foreground; the gate now force-stops known PiP
  apps at start (`dismissPipOverlays`), but Tristan closed the live
  PiP manually before the logic ever ran against one — it is untested
  in anger. Next time a PiP is up anyway, run the gate before closing
  it.

- **Measure `k`, the delta scan's per-range cost** (2026-07-28;
  trigger: field logs from normal use). `lib/deltaScan.ts` charges
  `RANGE_COST_IN_PHOTOS = 2` — a range costs about two photos' worth of
  work — derived from a ranged MediaStore query being the same order as
  a bucket cursor (~0.5 ms, called 15 ms to be generous) against the
  measured per-photo cost of 7.5 ms (S23) / 14.3 ms (S10e). It has
  never been measured directly.
  It is safe to leave: the value enters the cost formula rather than
  changing its shape, and every wrong answer degrades to a full pass,
  which is what shipped before the delta existed. To measure it, time
  `pageAndGroup` against `ranges.length` and `covered` across real
  passes — the `[scan] delta …` line already prints both terms.

- **Organize accepts photos Android will never let it move**
  (measured on the S10e, 2026-07-31). A photo under another package's
  `Android/media/<pkg>/` tree — WhatsApp's `WhatsApp Images`, 858
  photos on that device — is queued, album-assigned, and consented to
  like any other before the platform refuses it. Android's own words,
  captured on device:
  `IllegalArgumentException: Changing ownership from …/Android/media/com.whatsapp/… to …/DCIM/… not allowed`.

  m0.8.4 fixed the SILENCE (`lib/organizeFailures.ts` — the move run
  now explains itself), so what remains is purely the wasted trip: the
  queue takes the photo, the user assigns an album and approves an OS
  consent dialog, and only then learns it can never work. The fix is a
  queue-time refusal, the shape m0.8.3 already used for SD photos, and
  its real cost is knowing the full set of unmovable paths —
  `Android/media/` and `Android/data/` are two, and whether that is the
  whole rule is unverified. The dialog makes this cheap to leave: a
  user who hits it is told exactly what happened and what to do.

  Trigger: a tester organising app-media photos often enough that the
  wasted consent tap, rather than the confusion, is the complaint.

- **Rescued photos never window with same-moment dated photos**
  (m0.8.3 grilling Q9). A D15-rescued photo (in practice: NEF —
  measured on the S23: NEF `datetaken` NULL, DNG and ARW both dated)
  carries its real timestamp but pages in MediaStore's undated batch,
  so an NEF+JPEG same-moment pair reviews as two separate cards.
  Rescued photos group stably among themselves; the fix is a designed
  re-merge of rescued photos into the dated windowing stream (plan
  m0.8.3 B8 deferred real-pair grouping). Trigger: a tester actually
  reviewing RAW+JPEG pairs and wanting them on one card.

- **Bucket-id hash collision: named-folder warning** (m0.8.3 grilling
  Q11). A cross-volume BUCKET_ID hash collision (~0.005% lifetime odds,
  measured 0 across 643 buckets on the S10e) would over-include another
  folder's photos in MediaStore-paged grids and cause repeated tripwire
  full-passes; durable state stays correct (true volume identity is
  stamped at ingestion). Fix shape: detect at catalog load, name the two
  colliding folders, advise rename/deselect. Trigger: a tester's grid
  shows an unselected folder's photos, or logs show persistent tripwire
  full-passes with no library change.

- **EXIF-failure retry cap** (m0.8.3 grilling Q18a). A failed (I/O-level)
  EXIF rescue read withholds the scan fingerprint so the next open
  retries — correct and bounded for transient failures, but a file that
  stays indexed yet permanently throws on open would force a pass every
  open. Measured unreachable via file corruption (lenient EXIF parsing
  completes-null on truncated/garbled NEFs — S10e, 2026-07-30); only a
  persistent open-failure could trigger it. Fix shape: cap consecutive
  identical-content retries, then stamp honestly-undated. Trigger: field
  logs (TODO "Field diagnostics" item) showing the same `exifFailed`
  warning across consecutive passes.
