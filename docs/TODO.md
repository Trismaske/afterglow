# TODO — open questions (not yet planned work)

Parking lot for questions that need their own investigation before they
become plan items. Keep entries short; promote them into a release plan or
PLAN.md (roadmap / trigger-based backlog) once decided, and DELETE one the
moment it is answered — a closed question left here reads as open work.

Numbers renumber whenever an item closes, so **cross-references from code
or other docs quote the title, never the number**.

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

2. **Restore CI audit gate to `--audit-level=high`** (2026-07-25;
   re-checked 2026-07-29). Temporarily at `critical` in
   `.github/workflows/ci.yml`. One blocker:
   **brace-expansion** CVE-2026-14257 (GHSA-mh99-v99m-4gvg) flags every
   copy `<=5.0.7` under eslint/electron-builder/expo (dev tooling only,
   our own patterns — no real exposure; the advisory widened on
   2026-07-29 to cover 5.0.7 too). Still no backport: `npm audit`
   offers only semver-MAJOR downgrades, which are not fixes. The
   fast-uri fix landed in m0.8.2's lockfile; the gate returns to `high`
   once brace-expansion backports.

3. **Documentation standards for shipped releases** (Tristan, 2026-07-23).
   Should there be a per-release document recording what actually shipped
   (a `docs/Release_*.md` or a curated CHANGELOG)? Unclear whether it adds
   value or just duplicates the GitHub Releases page, which already
   carries notes and artifacts per tag. Investigate separately: what the
   GitHub Release notes currently capture, what gets lost when
   Feedback/Plan docs are deleted after shipping, and whether a
   lightweight standard (or none) fits.

4. **Upstream expo-image-manipulator native leak report** (m0.8 device
   testing, 2026-07-25). The scan's thumbnail decode path observed a
   native-memory leak in `expo-image-manipulator` (worked around — the
   embedder module decodes natively instead). File a minimal-repro issue
   upstream so the workaround can eventually be dropped.

5. **Confirm the real distribution of per-user median review deltas**
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

6. **Does "best of group" still earn its place?** (m0.8.2, parked
    deliberately.) The star is an ANNOTATION under
    [STATE_MODEL.md](STATE_MODEL.md), but it also FREEZES its group
    against regrouping (`lib/regroupBoundary.ts`), and it is drawn in
    the accent — the one colour the visual language reserves for
    interaction. Removing it would change the regroup boundary, so it
    needs its own pass rather than a rename: decide whether the freeze
    should hang off the star at all, and if it stays, whether the star
    gets a fixed hue like every other meaning-bearing colour.

7. **Group a detected edited copy with its original** (Tristan,
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
    reviewed group without rewriting it. Worth doing alongside the
    question of what the copy prompt should offer — Tristan notes the
    use case for copy-saving editors is unclear in the first place, and
    a substantially cropped copy may genuinely be a different photo.

8. **The accent must stop carrying meaning** (Tristan, 2026-07-28;
    m0.9 pass). Rule 3 says the accent is interaction only, because it is
    user-chosen and cannot hold a stable meaning. Six sites break it, and
    the collisions are measured, not suspected — CIE76 ΔE between each
    accent preset and its nearest reserved hue:

    | preset | nearest fixed hue | ΔE |
    |---|---|---|
    | amber `#e8a54b` | organize `#d9a13c` | **6.5** |
    | violet `#a49bef` | edit `#5f8fe8` | 16.6 |
    | rose `#e589b4` | fav `#e668a7` | 16.5 |
    | coral `#ee8570` | cull `#e05252` | 21.0 |
    | green `#74c69d` | keep `#3fb96a` | 25.4 |
    | sky `#6fb3e8` | edit `#5f8fe8` | 26.3 |

    Every preset is within ΔE 26 of a reserved hue and one is within 7,
    before "system" (the default) follows an arbitrary wallpaper. The six
    fixed hues span the whole hue circle, so **curating the picker cannot
    fix this** — only removing meaning from the accent can.

    The sites: the goal ring (HomeScreen, StatsScreen), the Keeping-up
    bar, the Stats coverage markers, the 30-day activity bars — all one
    pattern, *accent until the goal is reached, then keep-green*, which
    nearly merges on the Green accent — plus the Habits milestone fills,
    and the **best-of-group star**, which is worst because it sits inside
    a badge cluster beside the organize badge at ΔE 6.5 on Amber.

    Proposed shape: progress displays go keep-green throughout with
    completeness shown by STRENGTH rather than hue (rule 6 applied to
    progress instead of actions); the activity bars lean on the grey goal
    line the card already draws and explains; the star takes a fixed hue
    of its own (see "Does 'best of group' still earn its place?", which
    asks whether the star survives at all — settle that first). Deferred out of m0.8.2 deliberately: it touches
    the most-looked-at surfaces in the app and wants a device pass, not a
    late edit at the end of a release that already carried a state-model
    refactor and a visual sweep.

9. **Type-scale and token pass** (m0.8.1 UI sweep, parked; wants
    before/after screenshots, not piecemeal edits). Headings are 28 or
    24; subtitles range 12-16; thumbnail radii are 8, 9 and 10; chip
    radii 10-20; scrim opacities 0.55-0.7; root paddings 12-20. Two
    smaller items belong with it: empty-state grammar has three
    phrasings, and Summary still has a blank loading view.

10. **Two measured SQL costs, deliberately parked** (m0.8.1 rounds
    5-7; each has evidence, none is currently hot).
    - `getStateCountsInScope` evaluates a correlated EXISTS per row in
      scope (~22 ms whole-corpus, once per Progress open). A LEFT JOIN
      rewrite is straightforward but unmeasured against real device
      latency.
    - `sourceClause`'s leading-wildcard LIKE can never use an index.
      Only a normalized `source_root` column would fix it, and today it
      is always a secondary filter on index-fetched rows.

11. **Re-gate the `[perf]` logs at v1** (Tristan, 2026-07-28; trigger:
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

12. **Revisit the weekly full pass once the delta has field time**
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

13. **Coalesce tiny singles runs?** (m0.8.2 build, settled as keep-as-is
    by Tristan 2026-07-29; trigger: tester complaints about ceremony.)
    A sparse-photo stretch produces one timeline card and one one-photo
    deck per day (device-observed: dozens at the head on both phones).
    Honest capture-order review, and auto-advance chains through them —
    but if testers find it tedious, the option is merging adjacent
    small runs across day boundaries until they reach a minimum size,
    at the cost of blurring the day-scoped run model (the full trade
    was recorded in the shipped m0.8.2 plan's appendix 34 — git
    history).

14. **Verify the UI gate's PiP dismissal against a live PiP**
    (2026-07-29). A YouTube picture-in-picture window ate the Stats tap
    without taking the foreground; the gate now force-stops known PiP
    apps at start (`dismissPipOverlays`), but Tristan closed the live
    PiP manually before the logic ever ran against one — it is untested
    in anger. Next time a PiP is up anyway, run the gate before closing
    it.

15. **Should non-review surfaces feed the goal celebration counter?**
    (m0.8.2, 2026-07-29). `noteDecisions` is wired to every deck and
    Compare decision path, so a crossing there celebrates instantly.
    Verdicts written from the PhotoViewer's state editor, History
    re-decides, or Home's detection flows do NOT note — a goal crossed
    there celebrates on the NEXT deck/Compare decision instead. Rare
    paths, and wiring them means auditing each for its fresh-decision
    count; decide whether the latency matters before adding plumbing.

16. **Measure `k`, the delta scan's per-range cost** (2026-07-28;
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

17. **Compare: keeping photos in TRIAGE mode** (Tristan, 2026-07-29
    device pass). With 3+ undecided members a duel is verdict-free by
    design, so Compare offers no way to KEEP a photo there — "N is
    better" stars and records only, and the keep-both/cull dialog
    appears once the pair covers the undecided remainder. Tristan found
    the pull-toward-culling flow acceptable but wants a keep path from
    Compare. Needs design: a direct "Keep N" chip mirroring "Cull N"
    (plain verdict, no whole-table claim)? Or fold into "Retire 'best
    of group' in favour of a plain Keep?" below.

18. **Retire "best of group" in favour of a plain Keep?** (Tristan,
    2026-07-29). The star may be confusing things: marking best is the
    only "positive" act a triage duel offers, and it drags the user
    toward the cull dialog rather than a keep. Deciding whether best
    survives at all (it also freezes groups against regrouping — that
    role needs a new home if it goes) is its own design pass; the
    m0.8.2 state model deliberately left the star's future open
    (docs/STATE_MODEL.md, annotations). Further motivation (grilling
    Q11): the star keeps generating hue/semantics confusion — "N is
    better" wore keep-green while able to cull (fixed to accent), and
    the star is the accent-as-data offender TODO's accent entry already
    tracks. Issues like these are why Tristan leans toward removal.

19. **Action-layer coherence pass: favourite event log, one queue
    action language, full grid action hydration** (Tristan, 2026-07-29
    grilling — three merged items, one next-minor work package).
    (a) FAVOURITE EVENT LOG + external IS_FAVORITE reconciliation: the
    favourite surfaces are directional current-state projections of one
    photo_actions row — the honest reading of that model, but lifetime
    "favourites applied" is really *current verified favourites*,
    History shows favourite state rather than events (an Afterglow-side
    un-favourite erases an unreviewed photo's only trace once
    verified), and external gallery favourite changes never reach
    Afterglow (IS_FAVORITE is read only during our own apply
    verification). An event log mirroring share's batch log, plus a
    scan-hook reconcile, answers all three. Until then the directional
    predicates (FAVOURITE_HELD, the lifetime COALESCE(applied_target,
    target) read, the heart-off 'removing' badge) are settled behavior.
    (b) ONE QUEUE ACTION LANGUAGE: the four queue screens share their
    grid substrate (QueueGrid/QueueViewer/useQueueRows) but the ACTIONS
    drifted — Share has a confirmed bottom "Clear queue" (+ never-
    shared warning), Organize an unconfirmed "Remove all N" chip, Edit
    and Favourite no removal affordance at all. Build the action bar as
    one shared component (confirmation semantics included — probably:
    confirm any whole-queue destructive action, matching Share) so the
    queues stay aligned BY DESIGN, the ActionChip/UnitCard reasoning.
    (c) FULL GRID ACTION HYDRATION (the review cycle's one parked
    finding): Progress grids show only PENDING action dots and
    only on DB-backed filters — no carried dots anywhere, and the
    MediaStore-backed All/Unreviewed paths hydrate no action data at
    all. Hydrate both paths with the weighted set (live/carried/
    removing), and solve the dot-scale design question (dots cannot
    render the heart-off glyph).

20. **"N-day clear streak" reads like the goal streak** (tester
    feedback, 2026-07-29; next feedback release). Home's Keeping-up
    card renders `🔥 N-day clear streak` (HomeScreen.tsx) — the same
    emoji and sentence shape as the count-goal card's `🔥 N-day streak`
    a screen above, and the tester could not tell what distinguishes
    them. Tester suggestion: something like "last 25 days fully
    reviewed" with a DIFFERENT emoji. Copy caveat: the coverage streak
    counts consecutive cleared SHOOTING days — empty days pass through
    (`lib/coverageGoal.ts` `coverageStreak`) — so "last N days" is not
    literally true; the new copy must convey shooting days without a
    lecture. Stats' coverage caption already says "N of M days fully
    reviewed" — align the family while touching it.

21. **The review overview hides fully reviewed units** (tester
    feedback, 2026-07-29; next feedback release). Flow that surfaced
    it: "Continue reviewing" → review a group → want to revisit it →
    Home → overview chevron — and the just-reviewed unit is gone. The
    overview renders the PENDING timeline: `listReviewGroups` requires
    a group to still hold an unreviewed member (db/store.ts, the
    EXISTS on `state = 'unreviewed'`), and the singles feed keeps only
    pending rows — staged culls stay badged, which is why cull-only
    units still show while fully KEPT units vanish. Day pages do list
    completed groups, but that door is not discoverable from the flow.
    Wanted: the FULL timeline — every group and singles run, newest-
    first, paged — with a filter that can hide fully reviewed units,
    and probably rename the screen "Timeline". Needs its own design
    pass: a full-timeline query is a different, bigger query than the
    bounded pending feed (paging + perf on 27k corpora), the filter's
    default state, and what "Continue reviewing" anchors to when the
    list shows everything.

22. **Field diagnostics: persistent capture + user-shareable export**
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

23. **History event streams for actions, and a duel-history surface**
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

24. **History feed: tombstone rows with a placeholder tile** (Tristan,
    m0.8.3 grilling F5/C11). The feed requires `is_present = 1` (rows
    render thumbnails), so Forget-keep tombstones keep every STAT but
    drop out of the scrollable feed. Wanted: absent decided photos stay
    in the feed as a placeholder tile (grey "photo removed" cell,
    verdict badge, original date) so the feed is the complete record.
    Design: tile treatment, whether trashed rows join too (they have
    the same gap), and the filter story.

25. **Capture-time truth: DST-normalized times, and photos shot in
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
    second one. Related: entry 26 below (the read-source half of the same
    family, already designed).

26. **A D15-rescued photo's date does not reach the Progress library
    scope** (found 2026-07-30 during the m0.8.4 spikes; scoped out of
    that release to keep it a pure deletion). **Fully investigated and
    the fix is agreed — this is ready to implement, not to re-design.**

    **Symptom.** A photo MediaStore reports as undated, whose real
    capture date the D15 EXIF rescue recovers, shows its file
    MODIFICATION time on the Progress library grid and is absent from
    its own capture-month filter. Sharpest form, measured: Progress
    filtered to one month prints THREE different numbers on one screen —
    header `0 of 1 photos reviewed`, chips `7 Unreviewed`, grid
    rendering `1` tile.

    **Who it hits.** Every rescued photo, not just RAW — measured on an
    emulator where 7 of 9 photos were rescued and all 7 misbehaved. But
    the README states NEF capture dates come ONLY from the rescue, so
    for the RAW workflow it advertises, every NEF is affected.

    **The DB is correct; this is a read-source defect.** The rescue sets
    `item.timestamp` and clears `undated` (`scanRunner.ts:1112-1114`), so
    the upsert persists the right `taken_at` AND `day`. Only surfaces
    that re-read dates from MediaStore are wrong.

    **The fix already exists in this codebase, on Home**
    (`HomeScreen.tsx:648-663`): a disjoint union of MediaStore's range
    count and the DB's `rescued` rows, floored at the DB population, with
    the `rescued` count exposed at `db/store.ts:3111-3130`. m0.8.3's D16
    moved DAY scopes to SQLite but deliberately left library RANGE scopes
    on MediaStore ("untracked photos have no DB row yet"), and the
    rescue's DB-only truth falls through that carve-out.

    **Decisive isolation:** under the SAME month scope, switching the
    state filter to KEPT renders the photo correctly, because that filter
    routes the grid to the SQLite engine. The scope is innocent; the
    engine is the defect. Fixing display alone would not make the photo
    appear.

    **Scope vs display splits on bounded vs unbounded.** Bounded ranges
    query MediaStore on `DATE_TAKEN`, and a NULL-`datetaken` row matches
    NO month — so the photo is missing from its true month AND from its
    mtime's month; it lands in none. Unbounded returns every row, so the
    photo is present but wears the mtime and sorts by it.

    **Reproduced identically on API 30 (emulator), API 31 (S10e) and API
    36 (S23), on shipped 0.8.3** — not version-dependent, and neither
    created nor cured by the m0.8.4 floor change. Everything reading
    `photos.day` / `photos.taken_at` is correct: Home day rows (and not
    double-counted), the capture histogram, state chips, DayProgress,
    the review timeline and deck, History, the Edit queue, Stats, and
    `StateEditorSheet` — which self-heals by re-reading `facts.taken_at`
    (`PhotoViewer.tsx:528`) instead of trusting its caller.

    **The agreed fix — six changes** (Tristan, 2026-07-30; change 5
    widened and change 6 added 2026-07-31 by the S10e never-rescued
    measurement). A seventh, always showing the year in day labels, was
    independent of this defect and went into m0.8.4 on its own; it is
    what makes changes 1-4 verifiable by eye outside Progress, so do that
    first if it has not shipped yet.

    1. **Bounded month grid** (`progress/PhotoStateGrid.tsx:262`) — page
       SQLite, D16's already-proven day-scope pattern, instead of
       `fetchPhotoPageDesc`'s `DATE_TAKEN` range. Fixes the missing photo
       and the wrong order together.
    2. **Unbounded library grid** (`PhotoStateGrid.tsx:217`) — take
       `takenAt` from the DB state join already happening beside it
       (`getStateRowsForAssets`), not `p.item.timestamp` (which is
       `creationTime || modificationTime`, `media.ts:104`). PhotoViewer
       needs no change: it renders what the grid hands it.
    3. **Header denominator** (`ProgressView.tsx:414`, printing at
       `:499`) — apply Home's disjoint union. This is a SEPARATE site
       from the grid; fixing only the grid leaves the header printing
       "No photos here." above a rendered photo. It must keep counting
       not-yet-ingested photos, which have no DB row — that is why the
       MediaStore path exists and why two patterns are needed, not one.
    4. **Ordering** — union the DB's rescued rows into `progressPager` as
       one more merge source sorted by `taken_at` descending. Change 2
       fixes the displayed date but not the position: a slot is decided
       inside the k-way merge over MediaStore cursors before any DB join
       exists. Rejected: paging SQLite for the unbounded scope
       (dismantles the carve-out and hides un-ingested photos);
       re-sorting each loaded window (wrong across page boundaries);
       accepting mis-ordering (trades a wrong date for a wrong position).
    5. **The undated-and-unrescued surfaces must not lie — TWO sites,
       not one.** A photo with no EXIF date is filed under "Unknown day"
       and then shown as `Today · <mtime>` one screen later, in BOTH the
       PhotoViewer and the StateEditorSheet. Reproduced on the S23 and
       the S10e (2026-07-30/31), different clock values, same shape.
       `StateEditorSheet` cannot self-heal here the way it does for a
       RESCUED photo: `getPhotoQueueFacts` (`db/store.ts:2212-2229`)
       selects `asset_id, uri, taken_at` and never `day`, and for an
       honestly-undated photo `taken_at` IS the mtime — `scanRunner.ts:1243`
       writes `day: p.undated ? null : dayKey(...)` while `takenAt` keeps
       the fallback, which `store.ts:88` states outright ("`taken_at` is
       NOT NULL (the mtime fallback) even when their `day` is"). So the
       fix needs `day` carried alongside `taken_at` to these surfaces,
       not just a display change. A third, softer site: the review deck's
       overlay clock prints the mtime time-of-day — it never names a day,
       so it is not the same confident lie, but it is still a time claim
       about a photo with no known time.

    6. **Bounded month scopes must key on `day`, not `taken_at`** —
       otherwise change 1 makes things WORSE. The DB range predicate is
       `taken_at BETWEEN ? AND ?` (`store.ts:106`), which deliberately
       INCLUDES undated photos by their mtime; that is right for the
       open-ended whole-corpus range it was written for and wrong for a
       month. So the never-rescued population produces the same
       three-numbers contradiction in the OPPOSITE direction — the DB
       chip over-counts while the MediaStore header/grid correctly
       excludes. Measured on the S10e under `PHOTOS · UNREVIEWED`:
       July 2026 header `0 of 2`, chip `3`, grid 2 tiles; December 2022
       header `0 of 283`, chip `288` — a delta of exactly 5, matching
       five pre-existing undated GIFs, so this is NOT an artefact of a
       test fixture. Changes 1-4 move the grid and header toward DB
       truth, which would import this over-count unless the bounded scope
       keys on `day`. The design question the earlier draft did not
       contain: may an undated photo appear in a month scope at all? The
       honest answer is no — `photos.day IS NULL` means the app does not
       know the month, and the Unknown-day pseudo-day already exists as
       its home.

    **Regression pins, both taken from real screens:** the month view
    printing three different numbers must print one, across header, chips
    and grid; and a month view must render the same photo under
    `Unreviewed` as it does under `Kept`.

    **Device fixtures left in place for this work:** S23
    `/sdcard/DCIM/SpikeRAW/NOEXIF_undated.jpg` (the only
    undated-and-unrescuable photo in scope — exactly what change 5
    needs); the S23 NEF with mtime touched to 2026-07-30 23:16 so "Today"
    versus "17 Aug 2024" is unambiguous on every screen; and an
    `afterglow-api30` AVD that boots in under a minute. Related: entry 25
    (the ingestion half of the same family) and
    `docs/REVIEW_CLASSES.md` 43.

27. **Organize accepts photos Android will never let it move**
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

## Discovered, waiting for a real trigger

Items found during implementation whose fix has a known shape but whose
value is unproven — deliberately parked until a real user or tester hits
them (Tristan, m0.8.3 grilling). Same hygiene as above: promote on
trigger, delete when answered.

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
