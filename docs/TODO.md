# TODO — open questions (not yet planned work)

Parking lot for questions that need their own investigation before they
become plan items. Keep entries short; promote them into a release plan or
PLAN.md (roadmap / trigger-based backlog) once decided, and DELETE one the
moment it is answered — a closed question left here reads as open work.

Numbers renumber whenever an item closes, so **cross-references from code
or other docs quote the title, never the number**.

1. **Real volume identity at ingestion** (post-m0.7 review, 2026-07-23).
   `lib/media.ts` keys every asset as `external_primary` — an inline
   **(autonomous)** gate-1 assumption ("refined in gate 3") that gate 3
   only refined for the organize catalog, not for ingestion identity.
   With an SD card present, MediaStore's `external` query can return
   removable-volume assets: raw ids may collide across volumes, the
   organize cross-volume rejection never fires (every row claims
   primary), and the synthetic content-URI fallback can address the wrong
   volume. Needs its own investigation: derive per-asset volume natively
   (bucket→volume via `listImageAlbums`, or a native id lookup) vs.
   excluding non-primary volumes from ingestion until multi-volume
   support is designed.

2. **In-app data reset (danger zone)** (Tristan, 2026-07-24; m0.8
   candidate). A persistently failing startup recovery currently
   escalates its error copy toward Android's Clear-data escape hatch
   after 3 consecutive failures. Decide whether Settings should gain an
   in-app "reset app data" row (typed/strong confirmation, photos
   untouched) so the remedy lives inside the app; a destructive flow
   like this deserves its own design pass.

3. **Restore CI audit gate to `--audit-level=high`** (2026-07-25;
   re-checked 2026-07-29). Temporarily at `critical` in
   `.github/workflows/ci.yml`. One blocker:
   **brace-expansion** CVE-2026-14257 (GHSA-mh99-v99m-4gvg) flags every
   copy `<=5.0.7` under eslint/electron-builder/expo (dev tooling only,
   our own patterns — no real exposure; the advisory widened on
   2026-07-29 to cover 5.0.7 too). Still no backport: `npm audit`
   offers only semver-MAJOR downgrades, which are not fixes. The
   fast-uri fix landed in m0.8.2's lockfile; the gate returns to `high`
   once brace-expansion backports.

4. **Documentation standards for shipped releases** (Tristan, 2026-07-23).
   Should there be a per-release document recording what actually shipped
   (a `docs/Release_*.md` or a curated CHANGELOG)? Unclear whether it adds
   value or just duplicates the GitHub Releases page, which already
   carries notes and artifacts per tag. Investigate separately: what the
   GitHub Release notes currently capture, what gets lost when
   Feedback/Plan docs are deleted after shipping, and whether a
   lightweight standard (or none) fits.

5. **Upstream expo-image-manipulator native leak report** (m0.8 device
   testing, 2026-07-25). The scan's thumbnail decode path observed a
   native-memory leak in `expo-image-manipulator` (worked around — the
   embedder module decodes natively instead). File a minimal-repro issue
   upstream so the workaround can eventually be dropped.

6. **Confirm the real distribution of per-user median review deltas**
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

7. **Does "best of group" still earn its place?** (m0.8.2, parked
    deliberately.) The star is an ANNOTATION under
    [STATE_MODEL.md](STATE_MODEL.md), but it also FREEZES its group
    against regrouping (`lib/regroupBoundary.ts`), and it is drawn in
    the accent — the one colour the visual language reserves for
    interaction. Removing it would change the regroup boundary, so it
    needs its own pass rather than a rename: decide whether the freeze
    should hang off the star at all, and if it stays, whether the star
    gets a fixed hue like every other meaning-bearing colour.

8. **Group a detected edited copy with its original** (Tristan,
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

9. **The accent must stop carrying meaning** (Tristan, 2026-07-28;
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

10. **Type-scale and token pass** (m0.8.1 UI sweep, parked; wants
    before/after screenshots, not piecemeal edits). Headings are 28 or
    24; subtitles range 12-16; thumbnail radii are 8, 9 and 10; chip
    radii 10-20; scrim opacities 0.55-0.7; root paddings 12-20. Two
    smaller items belong with it: empty-state grammar has three
    phrasings, and Summary still has a blank loading view.

11. **Two measured SQL costs, deliberately parked** (m0.8.1 rounds
    5-7; each has evidence, none is currently hot).
    - `getStateCountsInScope` evaluates a correlated EXISTS per row in
      scope (~22 ms whole-corpus, once per Progress open). A LEFT JOIN
      rewrite is straightforward but unmeasured against real device
      latency.
    - `sourceClause`'s leading-wildcard LIKE can never use an index.
      Only a normalized `source_root` column would fix it, and today it
      is always a secondary filter on index-fetched rows.

12. **Re-gate the `[perf]` logs at v1** (Tristan, 2026-07-28; trigger:
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

13. **Revisit the weekly full pass once the delta has field time**
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

14. **Coalesce tiny singles runs?** (m0.8.2 build, settled as keep-as-is
    by Tristan 2026-07-29; trigger: tester complaints about ceremony.)
    A sparse-photo stretch produces one timeline card and one one-photo
    deck per day (device-observed: dozens at the head on both phones).
    Honest capture-order review, and auto-advance chains through them —
    but if testers find it tedious, the option is merging adjacent
    small runs across day boundaries until they reach a minimum size,
    at the cost of blurring the day-scoped run model (Plan_m0.8.2.md
    appendix 34 has the full trade).

15. **Verify the UI gate's PiP dismissal against a live PiP**
    (2026-07-29). A YouTube picture-in-picture window ate the Stats tap
    without taking the foreground; the gate now force-stops known PiP
    apps at start (`dismissPipOverlays`), but Tristan closed the live
    PiP manually before the logic ever ran against one — it is untested
    in anger. Next time a PiP is up anyway, run the gate before closing
    it.

16. **Should non-review surfaces feed the goal celebration counter?**
    (m0.8.2, 2026-07-29). `noteDecisions` is wired to every deck and
    Compare decision path, so a crossing there celebrates instantly.
    Verdicts written from the PhotoViewer's state editor, History
    re-decides, or Home's detection flows do NOT note — a goal crossed
    there celebrates on the NEXT deck/Compare decision instead. Rare
    paths, and wiring them means auditing each for its fresh-decision
    count; decide whether the latency matters before adding plumbing.

17. **Measure `k`, the delta scan's per-range cost** (2026-07-28;
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

