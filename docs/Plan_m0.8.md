# Plan m0.8 — Sessions removed: continuous scan, embedding groups, navigation redesign

*The release plan for mobile 0.8.0 (versionCode 7 — 0.7.1/0.7.2 shipped as 5/6). Every product decision below was settled with Tristan on 2026-07-24 (session-removal decision rounds + the grouping quality study with two human-judged rounds); none are open. Evidence lives in the git history of `docs/Sessions_m0.8.md` and `docs/Grouping_study_m0.8.md` (deleted when this plan landed); the durable product statements are in PLAN.md.*

## What this release is

Sessions disappear as a concept. The app continuously scans the configured folder (newest→oldest), embeds and groups photos into the durable tables as results land, and the deck is always available — no ranges, no draws, no "End session & apply". A presentational daily goal replaces the session cap; grouping switches from dHash-similarity to on-device image embeddings with time-gated centroid linkage; the Home screen becomes bottom-tab navigation centered on scan status, daily goal, and continue-reviewing.

## Decisions (all human-vetted 2026-07-24 — none are assumptions)

**Sessions & state:**
1. DB-backed deck cursor replaces core `DeckSession` + the JSON snapshot; decisions write `photos` directly. Core `deck.ts`/`cull.ts` are deleted (desktop organizer builds its own compare model in v0.7).
2. The `kept` state is removed everywhere: a keep writes `done` at swipe time; `'kept'` leaves `PHOTO_STATES`; re-decide works on `done` (done→culled, done→unreviewed); un-staging a cull lands on `done` (CullList "Restore" keeps landing on `unreviewed`); `reviewed_at` stamps on the done/culled write (else lifetime stats undercount); Progress loses its "Kept" segment; day summaries complete as you swipe.
3. Review scopes (rolling + named ranges) are dropped; re-add as browse filters only if testers ask.
4. Daily goal (chips 25/50/100/200/500, default 50) is purely presentational: drives the progress ring, celebrations, and streaks (streak day = goal reached); gates nothing.
5. Regrouping rebuilds only all-unreviewed groups; settings changes offer an explicit opt-in "regroup everything not yet done".
6. No scan-size limit (measured: full 28k-photo metadata scan in 11.5 s; embedding backfill ~33 min sequential on the S23, ~15 min for the S10e's corpus).

**Grouping (purpose: de-duplication aid — PLAN.md):**
7. Feature: MediaPipe Image Embedder, MobileNetV3-large float32, L2-normalized — the `modules/image-embedder` local module (built and benchmarked). Chosen over DINOv2/MobileCLIP on measured quality (AUC 0.946 vs 0.910/0.888 on the 570-pair human label set), cost (15/35 ms infer S23/S10e), integration, and license (Apache-2.0).
8. Algorithm (final, from four judged rounds + a validation round; labels-v1 = 698 adjudicated hard pairs): 3-min burst gate → greedy centroid linkage, **default cosine 0.50 with a time-decay bonus for pairs ≤60 s apart** — Tristan's round-4 insight, calibrated on labels-v1 (measured 90%-link floors by gap band: ≤5 s → 0.56, 5–20 s → 0.49 at zero violations, 20–60 s → 0.42 with trade-offs; no bonus beyond 60 s — violations dominate). The smooth curve is fit at Gate 1 against the frozen suite. Round 3 measured older-camera photos sitting systematically lower in cosine space; 0.50 + bonus covers them. → adjacent-burst centroid merge (≤15 min) **only between internally tight groups** (round 4: loose stage-1 groups produced bad merges even at centroid 0.84; round 2 on tight groups was 11/12 correct — initial params: both groups' weakest internal link ≥0.55, centroid ≥0.70, re-validated at Gate 1) → dHash retained only as a time-gated exact/near-duplicate floor (≤8/64 within bursts). Never global pairwise linking at any threshold (measured: chains into mega-groups at every strictness).
9. Boundary policy: err inclusive (false inclusion costs one eject swipe; false exclusion costs a navigation loop — singles can never be promoted into a group by design).
10. Thresholds are recalibrated on device-computed vectors during Gate 2 (desktop↔device cosine deltas measured at ±0.02 typical, 0.067 max); the committed regression suite is the arbiter.

## Gates

**Gate 0 — feasibility + quality study: DONE.** Artifacts: `modules/image-embedder` (permanent), `docs/grouping-study/` (frozen labels-v1 fixtures + eval/sheet tooling; corpora/photos gitignored), Phase A/B numbers above.

**Gate 1 — grouping engine in core (pure TS): DONE.**
`packages/core` gains embedding grouping: burst gating by timestamp gap, centroid linkage (Float32Array vectors via injected lookup, like `hashOf`), adjacent-burst merge, near-dup annotation from dHash. Pure functions, no platform APIs. Unit tests run the committed labeled fixture (see Regression suite) and pin the baseline. Core `similarity.ts` keeps `dhash64`/`hammingDistance`; `groupBySimilarity`'s corpus-scale use is retired (the app-side switch lands with Gates 2–3; the function stays exported until then).
Artifacts: `packages/core/src/grouping.ts` (`groupByEmbedding` + `effectiveLinkThreshold`), `packages/core/test/grouping.test.ts` (unit tier + pinned labels-v1 regression: must-link kept ≥ 412/503, violations ≤ 37/176, largest group ≤ 12), `docs/grouping-study/fit_curve.mjs` (the fit/re-pin harness). Implementation judgment calls vetted 2026-07-26 (see appendix). Unembedded photos time-attach to their nearest embedded neighbour within the burst, badged `timeAttached` (Tristan's decision-5 revision at vetting).

**Gate 2 — continuous scan pipeline in the app: DONE (device-validated on both phones 2026-07-25).**
On app open: page MediaStore newest→oldest; for photos without a current embedding, decode+embed via the module (concurrency tuned; decode cap lowered toward the 224-px embedder input — S10e must land ≤100 ms/photo end-to-end, from 142 ms measured at the 1024-px cap); persist embeddings as SQLite BLOBs keyed by asset id + `mod_time`, with the model file's SHA-256 stored once (model swap = explicit re-embed event). Grouping runs incrementally per closed burst; groups land in the durable grouping tables. Interrupt-safe by construction (per-photo persistence — validated the hard way when a dump run was frozen mid-flight by the OS). Battery/thermal sanity check on a 5k batch rides this gate's device validation.
Artifacts: schema v9 (`photo_embeddings`, 'continuous' grouping provenance + one-run index), `db/embeddingStore.ts` (BLOB store + model pin), `lib/embeddings.ts` (embed+hash backfill, adaptive 2–4 workers), `lib/scanWindows.ts` + `lib/regroupBoundary.ts` (pure, unit-tested), `scan/scanRunner.ts` (orchestrator + observable ScanStatus), `writeContinuousGroups` in `db/store.ts` (real-SQLite tested), `embed(uri, decodeCap, withDhash)` + `dhash(uri)` + `MODEL_SHA256` in the module. Home starts the scan once permission lands. Implementation judgment calls vetted 2026-07-26 (see appendix); schema v11 adds the `time_attached` assignment badge and the hash `source` column (scan trusts only native-produced hashes).
Device validation (2026-07-25): decision-10 recalibration — pinned suite floors HOLD on device vectors, no threshold change (S23 full set: device 376 kept/21 violations vs fixture 372/37 on the same subset; S10e older-camera subset: 185/11 vs 182/11; per-vector drift p50 cos ≈ 0.94 is absorbed by the engine). Throughput: S10e ≈ 40 ms/photo effective, S23 well under (adaptive overlap; cap stays 1024). First-open backfill: S10e 5,786 photos ≈ 18 min; S23 27,027 photos with 4,913 windows, peak 346 MB PSS, thermal status 0 throughout, no measurable battery drain on charge. Warm rescan (all cached, background): S10e ≈ 90 s, S23 ≈ 4.6 min, byte-identical window counts. Interrupt safety proven by a real lmkd kill + resume (decision 14).

**Gate 3 — DB-backed deck + `kept` removal: DONE.**
The deck reads groups from SQLite and writes decisions directly (decisions 1–2 above). Deleted: `SessionContext` + snapshot persistence queue, `sessions` table, banking paths, core `deck.ts`/`cull.ts` + tests, scope machinery (decision 3), session prefs/loader, the dHash similarity prefs + manipulator hash pipeline (`similarityHashes`/`dhashDecode`/jpeg-js — fully retired here rather than lingering to Gate 4; the module-native hash is the only producer left). Schema v13: no sessions, no `photos.group_id`/`session_day`, no `kept` state, duels keyed by group alone, single continuous grouping run.
Architecture: `review/ReviewContext.tsx` + `db/store.ts applyReviewDecisions` (one awaited transaction per decision; decision-2 verdict semantics with `reviewed_at` first-stamps and edit-cycle resets), `listReviewGroups`/`listUnreviewedSingles` as the queue reads, derived deck cursor (first unreviewed member; screens keep transient browse position). Group stability (decision 5) enforced at the regroup boundary incl. durable `user_single`.
**Hardening rehomed intact:** trash-attempt lifecycle + startup recovery (now in the provider, once per process), edit-lifecycle coherence (cycle-keyed detection/completion, copy-match resolution on restore/un-stage), share/organize durable queues — with their tests (215 mobile + 101 core green). **Session-specific hardening retired, mapped:** done-state reconciliation with the live session → impossible by construction (durable rows ARE the display truth; screens re-read on focus/version); membership gating during session restore → moot (nothing restores); serialized session install/replacement + carry policy → moot (decisions never move between containers); the FIFO persistence barrier → replaced by awaited per-decision transactions with a loud non-blocking failure alert; snapshot mirrors (`reconcileTrashed`/`reconcileMovedUris`/`reconcileEditsDone`) → durable-truth re-reads.

**Gate 4 — Home navigation redesign + copy/terminology: DONE.**
Artifacts: `@react-navigation/bottom-tabs` `MainTabs` in `App.tsx` (five count-badged tabs; the bar exists only on those surfaces — review screens live in the parent stack); `lib/dailyGoal.ts` + `components/GoalRing.tsx` (pure-RN ring; goal chips 25/50/100/200/500, default 50; streaks = goal-reached days, Home + Summary share the math); `lib/groupingPrefs.ts` + Settings sections (goal chips; 5-step strictness → baseThreshold 0.42–0.58 with the decision-5 regroup opt-in via `resetUnreviewedGroups` + `requestRescan`); Home goal card (ring, queue counts, continue-reviewing, scan status line with corpus stats incl. staged-cull reclaimable estimate); History as a title-row icon; edit-queue buttons "Edit here"/"View only" with an explanatory subtitle; display name "Afterglow" (id unchanged). Original scope for reference:
Bottom tabs **Home · Edit · Favourite · Share · Organize** (count-badged); Cull list from Home; History as settings-adjacent icon. Home above the fold: scan/embed status, daily goal ring, continue-reviewing, live corpus stats (total, groups found, % reviewed, reclaimable estimate). Summary becomes daily/milestone-based; streaks = goal-reached days; Sessions settings section replaced by Daily goal. The dHash similarity chips/slider are replaced by a single simplified grouping-strictness control mapped to the cosine threshold around the 0.50 default (decision 8), and the legacy time-only toggle is removed **(autonomous: exact control UI decided at this gate; the regression suite bounds how far the control may stray)**.
Copy & terminology (testers): review-flow copy says *review*, never just *cull* (the old "Start culling" CTA dies with sessions; its successor is continue-reviewing); the "Clear your photos down to the keepers." tagline is removed — corpus stats and the daily goal carry the message; the edit-queue's two buttons become self-explanatory (editor-that-can-save vs view-only gallery — descriptive labels/subtitles, exact copy at implementation).
**App convergence (PLAN.md decision):** the app renames to **"Afterglow"** — `app.json` name/display name, launcher label, in-app and README/release-note surfaces; the application id stays `com.afterglow.companion` for now — it aligns to the new name at the pre-v1 identity break (PLAN.md "After m0.9": keystore + id + versionCode reset in one tester disruption). The terminology audit aligns mobile vocabulary with desktop's where concepts match (queues, organize, review states; PLAN.md as canonical glossary), as the first step of one-product-two-surfaces convergence; deeper queue UI-UX convergence rides desktop organizer (v0.7) and later mobile releases.

**Gate 5 — deck/viewer rework: DONE.**
Artifacts: gate-5 store queries (`listSinglesFeed` — unreviewed + staged culls; `getReviewGroup`/`ReviewContext.loadGroup` — completed groups reopen in browse/re-decide; `listGroupsForDay` + DayProgress "Groups this day" section; `getUnreviewedDayRows`/`getDaySummariesForDays` — Home's 3-recent + 2-unreviewed + expandable older-days layout; `getPhotoFacts`); `components/PhotoViewer.tsx` — THE standard full-screen viewer (paging, pinch-zoom, per-photo decision-detail panel incl. time-attached and superseded-organize explanations, hosts StateEditorSheet) wired into deck browse (stage tap), progress grids, History rows, and all four queue screens (share: long-press — tap keeps toggling pass selection); live deck keeps culled members badged (Cull re-tap un-culls; the 4-second undo banner retired — the badge is the undo); day-count audit: reviewed = done + to-edit + staged everywhere (`reviewedOf`/`reviewedPct`; session-era `streakStats`/`previousDayKey`/`getReviewedDays` deleted). Real-DB tests cover every new query. Original scope for reference: culled photos stay badged in the live deck; one standard full-screen viewer for deck browse, progress, history, queues; completed days re-show groups in browse/re-decide mode; staged culls re-enter the feed badged with prior verdict; recent days = 3 recent + 2 unreviewed + older-days indicator; day-count audit with kept/done merged into "reviewed".

**Gate 6 — release.**
Per-ABI APK splits (the universal APK grew 106→162 MB with MediaPipe; splits reclaim most of it — verify the release workflow and manifest handle multiple APKs, else ship universal and note the size). Version 0.8.0 / versionCode 7; destructive DB reset (fresh-baseline policy); README/release notes tell testers what changed (sessions gone, first-open backfill expectations per device class); preflight + tag `mobile-m0.8`.

## Grouping regression suite (quality can never silently drop)

- **Committed to the repo:** `docs/grouping-study/labels-v1.json` (698 hard pairs — 503 link / 195 apart — plus 81 soft and 7 deliberately retired; spans 2020–2026 and two cameras; every cross-round conflict, statistical outlier, and conversion-interpreted label human-adjudicated in the validation round) and `docs/grouping-study/embeddings-labeled-v1.json` (428 labeled photos × 1280-dim base64 float32, ~2.9 MB, no image content; model SHA-256 embedded). Personal photos and full-corpus data stay gitignored/local.
- **Core test tier (CI):** replays the Gate-1 engine over the fixture and asserts pinned floors — must-link kept ≥ baseline, must-not-link violations ≤ baseline, largest component ≤ bound. Any algorithm or threshold change that degrades the score fails the build; improving it means deliberately re-pinning.
- **Local full-corpus harness:** `docs/grouping-study/` tooling (embed/eval/sheet scripts) stays for corpus-scale sweeps and future judged rounds; each new round appends labels and re-pins the baseline (as v2 — v1 is frozen).
- **Soft pairs** score separately (neither rewarded nor penalized) — human raters disagree on most near-duplicate boundaries; ambiguity is resolved by the inclusive policy, not chased with thresholds.
- **Fixture hygiene:** before the fixture is first committed, a validation round adjudicates every cross-round conflict, re-confirms the statistical outliers (lowest-sim links, highest-sim aparts), and confirms all conversion-interpreted labels; pairs Tristan retires become soft. The result freezes as `labels-v1`; later changes happen only through new judged rounds producing `labels-v2`, never by editing v1 in place. The freeze includes a transitivity audit on the final merged set (apart edges inside link-connected components) — contradictions get human adjudication before the fixture is consumed.

## Deferred / adjacent

- Warm rescan regroups every window (background; measured ≈ 4.6 min on the 28k S23, ≈ 90 s on the S10e): a skip-unchanged-window optimization only if testers notice the background work.
- Visual vet of live groups (Tristan, decision-1 vetting): render a contact sheet from a device DB's actual continuous groups to eyeball the fitted curve's real-world behavior — before or during the Gate 4/5 tester round.
- expo-image-manipulator native memory leak (autonomous decision 13): search the upstream issue tracker and file/endorse a report — the session flow still uses the path at small scale until Gate 3.
- Videos enter review + Android ≤10 permanent-delete path: m0.9 (moved out of m0.8).
- Panorama-family grouping quirk (extreme aspect ratios; one recurring composition failure in both judged rounds): revisit only if testers hit it.
- Battery/thermal long-run profile beyond the Gate-2 sanity check: only if testers report drain.
- Desktop reuse of the grouping engine (organizer v0.7): consumes the same core module; no mobile-side accommodation needed now.

## Autonomous decisions appendix

Pre-implementation decisions were all human-vetted on 2026-07-24 (see Decisions). Implementation-time judgment calls get numbered entries here as they happen and are PRUNED once human-vetted (assumptions discipline).

All Gate 1–2 entries (1–14) were vetted with Tristan on 2026-07-26: thirteen approved as implemented; **decision 5 was revised** — unembedded photos now attach BY TIME to the group of their nearest embedded neighbour within the burst (a burst with no embedded photo stays intact as one group), carrying a durable `time_attached` badge for the UI (surfaced at Gate 5) and rewritten to a real embedding decision once the vector lands (inclusive policy: ejecting is one tap, promotion into a group is impossible). Full entry texts live in this file's git history; the settled behavior is documented where it lives — core `grouping.ts`, `scan/scanRunner.ts`, `db/embeddingStore.ts`, `lib/embeddings.ts`, the module README, and the gate artifact notes above.

Gate-3 implementation judgment calls (pending the end-of-build vetting round Tristan requested):

15. **Deck cursor is derived, not persisted.** The next photo = first unreviewed member; screens keep transient browse position locally. A stored cursor would add a table for state the DB already implies.
16. **The singles deck lists unreviewed singles only.** A decided single leaves the deck on refresh (re-decide via CullList/History/Progress); Gate 5's feed rework re-admits staged culls badged.
17. **`to_edit` stamps `reviewed_at` too.** Decision 2 names done/culled; but a to_edit later completed via markEditDone would otherwise NEVER earn its review stamp — flagging is the review moment.
18. **Re-flagging from done always starts a fresh edit cycle** (unconditional `to_edit_at` stamp + baseline reset), matching m0.7's markDoneToEdit; first-entry-wins still applies within a cycle.
19. **Summary is day-based interim** (today's day-summary + lifetime + reviewed-day streak) until Gate 4's daily goal defines streaks as goal-reached days.
20. **DayProgress's CTA navigates to the review queue** (day-scoped draws died with scopes; the day's photos are already grouped in the queue).
21. **The manipulator hash path retired at Gate 3, not Gate 4** — its last consumer (session flow) died here; jpeg-js and FineSlider dropped with it. photo_hashes keeps the source column ('native' is the only producer).
22. **Progress state editor lost its active-session read-only gating** — everything durable is editable per the transition audit (no snapshot to desync).
23. **Duels keep TEXT group_id** (numeric continuous group ids stringified) — compare history stays mineable without churn.
24. **redecideStaged (cull-list sheet): keep/to_edit resolve pending copy matches** — un-staging answers the copy prompt's question (C#12 preserved sessionless).

Gate-4/5 implementation judgment calls (same pending vetting round):

25. **Streaks re-color history against the CURRENT goal.** A goal change retroactively re-evaluates past days (no per-day goal journal); an unfinished today never breaks the streak it is about to extend.
26. **Strictness steps are ±0.04/±0.08 around 0.50** (five labeled steps, band-clamped to the calibrated 0.42–0.58 range). A change is a confirm/cancel dialog stating honestly that not-yet-reviewed photos regroup on the next scan — an "only new photos" opt-out is impossible without per-photo threshold provenance (the continuous scan re-derives every unfrozen group each pass), so it is not offered (final-review round 1).
27. **Tab badges poll**: queue counts refresh on review-version changes plus a 15-second interval (queues mutate outside the review write path — e.g. share passes).
28. **The undo banner is gone** (gate 5): a culled photo stays in the deck badged and re-decidable — strictly more capable than the 4-second banner it replaced.
29. **Reviewed = done + to-edit + staged** in every day/percentage count (matches the `reviewed_at` stamp; "done" alone under-counted days whose remaining work is edits or cull confirmation).
30. **Reclaimable estimate stats staged culls synchronously, capped at 500** (per-file `File.size`; above the cap the figure is hidden rather than wrong).
31. **Share-queue viewer opens on long-press** — a plain tap keeps toggling pass selection (the queue's primary gesture).
32. **`listGroupsForDay` returns whole groups** — members outside a midnight-spanning day ride along (the deck always shows complete groups).
33. **Older-days expander is inline and capped at 60 days** (an all-days browse already lives in Progress); "still to review" rows list the 2 newest older days with unreviewed photos.
34. **Compare stays alive-only** (deck + singles feed): staged culls re-decide via chips, never via Compare verdicts.

Final-review round 1 (full-m0.8 codex pass) fixes, same pending vetting:

35. **The scan reconciles externally RESTORED photos**: a row still marked trashed that reappears in a MediaStore scan gets the standard restore transition (back to unreviewed, generation bump, fresh edit-cycle baseline) inside the window write — Gate 3 had orphaned `markPhotoRestored`.
36. **Queue reads are source-scoped at read time** (groups/singles/counts/day groups): rows from excluded folders stay frozen in SQLite and are filtered out by the roots clause; a group queues only for a pending IN-SOURCE member but always shows whole.
37. **Corpus % counts CURRENT verdicts** (`state IN done/to_edit/culled/confirmed/trashed`); `reviewed_at` stays the lifetime/goal metric — clearing a verdict returns the photo to the pending pool.
38. **Compare verdicts are atomic**: duel, loser verdict, and the winner's star land in one `applyReviewDecisions` transaction (`extras.setBest`); the viewer's state edits also refresh ReviewContext directly.

Final-review round 2 fixes, same pending vetting:

39. **Regroup reset spares MIXED groups**: a group with any reviewed member is frozen whole (deleting its unreviewed members would dissolve it and lose best/membership) — only fully-unreviewed groups and non-ejected singles reset.
40. **Source resolution fails CLOSED in queue reads**: a resolution error falls back to the last successfully resolved roots, or skips the refresh before any success — `null` means "all folders" to the store and must never be a silent error fallback.
41. **The active cull chip on the re-decide sheet restores to unreviewed** (the sheet's promised tap-to-clear; same semantics as CullList Restore, resolving no copy match).
42. **Linear-flow routing counts PENDING singles** (a feed holding only badged staged culls routes to CullList, not an already-complete Singles screen); completing an out-of-order group advances from its stored former index.
43. **Summary "today" is DECISION-day accounting** (`getDayReviewSummary` over `reviewed_at` localtime; keepers = current `done` only) — capture-day rollups missed older photos reviewed today and double-counted trashed ones. Corpus % likewise excludes trashed rows from the numerator (its denominator is the MediaStore total, which no longer contains them).
44. **A complete scan reconciles external removals**: tracked present rows the full in-source pass never met get the tri-state presence check; only verified trashed/absent rows converge (capped at 500/run, loudly). The native CI job now fetches the pinned embedder model like the release workflow.

Final-review round 3 fixes, same pending vetting:

45. **Pair ejection is durable for BOTH photos**: the survivor of a group the ejection shrinks to one member is marked `user_single` inside the same transaction ("not related" judged both; the bare dissolve left the survivor silently regroupable — the session flow had persisted both ids).
46. **Flow routing counts the DB queue, not the feed page**: pending-singles predicates (deck linear flow, Groups continue-CTA, singles auto-advance) read `queueCounts.singles` — the 500-row feed page can hold only staged culls while older unreviewed singles remain.
47. **Every corpus/day surface shares the queue's source scope and fails closed**: Home corpus stats resolve sources (MediaStore denominator and verdict/group numerators count the same photos; resolution errors keep the last stats), and DayProgress hides its groups section on resolution failure instead of broadening to all folders.

Final-review round 4 fixes, same pending vetting:

48. **Group-level metadata freezes the whole group**: a starred best or recorded duels freeze an all-unreviewed group against regroup rewrites (`ReconcileMaps.metadataGroups`, applied at both freeze sites incl. the in-transaction revalidation) — a rebuild would discard the star and orphan the duels.
49. **Every return to `unreviewed` resets the full edit-cycle baseline** (`to_edit_at`/`mod_time`/`content_hash`, from culled too) — stale evidence could auto-complete a later re-flag; `restoreCarriedCull` does the same.
50. **The re-decide sheet's tap-to-clear PRESERVES pending copy matches** (`restoreCarriedCull(…, resolvePendingMatches=false)`) — returning to unreviewed answers nothing; CullList's explicit Restore still resolves (the user handled it).
51. **Groups dissolve on lost PRESENT membership**: `repairGroupMembership` counts present members and runs inside both removal-reconciliation transactions — a pair whose member was trashed/externally removed becomes a plain single, never a 1-photo deck group. Corpus numerators likewise require `is_present = 1`; Home's still-to-review discovery fails closed on source-resolution errors.

Final-review round 5 fixes, same pending vetting:

52. **The strictness reset also spares metadata groups** (starred best / recorded duels — the same exclusions as the regroup boundary), and Home fails closed on MediaStore COUNT failures too: a failed corpus count keeps the last rendered stats (never an authoritative-looking "0 photos · 0%"), and a failed per-day count keeps the previous day rows instead of making days disappear.

Final-review round 6 fixes, same pending vetting:

53. **Re-decisions are state-aware** (`applyRedecision`, used by deck browse and the cull-list sheet): Keep on a flagged photo lands on `done` with the flag CLEARED (the initial-decision verdict path would bounce it back to `to_edit`), To edit from `done`/`culled` starts a FRESH cycle (unconditional `to_edit_at` + baseline reset), and both targets resolve pending copy matches (C#12). Initial decisions on unreviewed photos keep the flag-honoring verdict path.
54. **Off-page groups work everywhere**: `keepRest` fetches an explicitly opened group absent from the 100-group queue page instead of silently no-opping, and Compare loads such a group directly (same `loadGroup` mechanism as the deck).

Final-review round 7 fixes, same pending vetting:

55. **Best-star hygiene**: culling the starred photo clears the star in the same transaction (a compare winner's `extras.setBest` may star a replacement); the orphaned-best repair also requires the best photo to be PRESENT (an externally removed best no longer freezes its surviving group forever); Compare waits for an off-page group fetch before treating a missing pair as terminal.
