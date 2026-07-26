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

Final-review round 8 fixes, same pending vetting:

56. **Staged culls are fully fenced out of Compare** (neither endpoint may be culled — a compare verdict could re-star a cull; the live Compare button disables on a culled current card), and the live deck's Keep on a staged cull takes the state-aware `redecideDecided` path (flag cleared, matches resolved).
57. **The edited-copy stage-and-reserve transition clears stars too** (`prepareTrashBatch stageToEditMembers` — every transition to `culled` shares the hygiene), and rejected off-page group loads settle as terminal ('missing') in both the deck and Compare instead of stranding blank screens.

Final-review round 9 fixes, same pending vetting:

58. **Browse-mode Best gates only on the culled state** — a completed group's done/to_edit keepers stay starrable (the aliveness check had disabled Best for every browsed member).
59. **Off-page groups return to their origin on completion/dissolution** (DayProgress-opened groups outside the bounded queue page — the page cannot name their successor), and the deck header drops the meaningless "Group 0 of N" position for them.

Final-review round 10 fixes, same pending vetting:

60. **The viewer anchors to the PHOTO, not a position**: a host reload that reorders items (History reorders on `activity_at`) re-finds the anchored id and moves the pager with it — the numeric cursor was silently switching photos.
61. **Write rejections are caught at every UI boundary**: the provider's `writeError` alert is the surface; deck `run()`, Compare handlers (which also skip their success toast/navigation on failure), the re-decide sheet (stays open), and the viewer/queue `onChanged` reloads all swallow the re-thrown rejection instead of leaking unhandled promise rejections.

Final-review round 11 fixes, same pending vetting:

62. **The viewer anchor updates only on user navigation** (mount, swipe) — the round-10 render-time assignment re-derived it from the already-reordered list, defeating the fix; a photo that left the list re-anchors to the clamped position. History's viewer `onChanged` reload also gained the boundary catch.

Final-review round 12 fixes, same pending vetting:

63. **Home's scan-driven refreshes are coarsened to every 250 grouped windows + phase changes** (per-window refreshes meant thousands of redundant MediaStore counts on a 27k first scan), and the day-rows loader now refreshes on the same coarse key — the still-to-review rows no longer stay stale for the whole scan.
64. **StateEditorSheet surfaces its own write failures** (Alert + sheet stays open) — its direct SQLite transitions bypass `ReviewContext.write`, so the provider alert could never fire for them.

Final-review round 13 fixes, same pending vetting:

65. **Undated photos enter the scan**: a 0 lower bound now OMITS `createdAfter` in every MediaStore query (the legacy query rendered it as `DATE_TAKEN > 0`, silently excluding photos with null/zero DATE_TAKEN from the scan — the only review ingress — and from every all-photos count).
66. **The strictness reset immediately refreshes the rendered queue** (a decision on a stale reset group would permanently lose its whole-group boundary), and Home's edit-detection effect depends on the STABLE `review.refresh` callback instead of the whole context object (scan-driven refreshes were cancelling in-flight detection and discarding its copy prompts).

Final-review round 14 fixes, same pending vetting:

67. **Open-ended MediaStore queries omit BOTH date bounds** (`endMs = Infinity` is the explicit contract; a finite `createdBefore` renders as `DATE_TAKEN < x` — FALSE for SQL NULL — so round 13's lower-bound fix alone still excluded null-dated photos). The scan, Home's corpus count, and Progress "All photos" are open-ended; day/range scopes stay DATE_TAKEN-bounded by design (a dateless photo belongs to no specific day; its DB `day` uses the mtime fallback).
68. **Undated photos scan in their own ordered pass**: MediaStore sorts them at the END of the DATE_TAKEN stream while their effective timestamps are mtime-recent, violating the accumulator's descending contract — they group among themselves by effective time (capped 5,000/run, loudly; merging into the dated stream would require buffering the whole corpus).
69. **Queue refreshes carry a generation token** — only the latest refresh commits; an older scan-status refresh finishing after a decision's refresh could resurrect pre-decision groups and stale flag/favourite maps.

Final-review round 15 fixes, same pending vetting:

70. **Undated photos process in memory-bounded BATCHES of 5,000 — nothing is discarded** (the round-14 cap silently dropped the remainder forever); a batch boundary may split a would-be window, the price of not buffering an unbounded undated set (WhatsApp-style libraries commonly have null DATE_TAKEN).
71. **Compare verdicts validate group membership INSIDE the transaction** (both endpoints must still belong to the starred group; a warm scan can rebuild an all-unreviewed group between Compare's load and the write — the verdict now aborts whole and surfaces instead of committing a duel against the wrong group).
72. **Saving a photo-source change refreshes the queue immediately** (the reads are source-scoped; the queued rescan lands later — excluded photos must leave the rendered queue at save time).

Final-review round 16 fixes, same pending vetting:

73. **Release identifiers bumped to 0.8.0 / versionCode 7** (preflight would reject the `mobile-m0.8` tag against 0.7.2/6; tagging itself stays a Gate-6 human call).
74. **Undated photos persist `day = NULL`** — finite MediaStore day/range queries exclude them, so the DB day surfaces (day rows, summaries, day groups) must too; they stay fully reviewable via the queue and all-photos surfaces (no schema change: the column was already nullable).
75. **Ejection validates the DISPLAYED group in the transaction** (`makePhotoSingles(…, expectedGroupId)`; a background rescan can rebuild an all-unreviewed group between render and the "Not related" tap — ejecting from the wrong group and user_single-freezing its unseen survivor now aborts whole), and the queue's newest-first ordering ignores absent members.
76. **The source picker fails CLOSED on scope refresh**: it resolves the new scope and refreshes before navigating away; on failure it stays open with a toast (the setting is saved; the old queue must not remain actionable under the old scope).

Final-review round 17 fixes, same pending vetting:

77. **A settings change generation-fences the in-flight scan**: `requestRescan` bumps a generation and the running flight stops persisting at the next window boundary — groups written under superseded source/strictness settings would repopulate exactly what the change reset (a verdict on one would freeze it wrongly forever).
78. **Both settings flows ROLL BACK on failure**: a source save that cannot resolve+refresh the new scope restores the previous setting before staying open (header/back navigation cannot be blocked, so a half-applied narrower scope must never outlive the screen); a strictness change whose reset/refresh fails restores the previous step — "not changed" stays true.

Final-review round 18 fixes, same pending vetting:

79. **Supersession is ordered and complete**: `supersedeScan()` fires BEFORE the strictness reset/refresh (the old flight must stop writing old-threshold groups first); the undated-batch writer checks the fence per window like the dated stream.
80. **The source apply path uses a STRICT scoped refresh** (`refreshScoped(roots)` — reads under the just-resolved roots, no silent fail-open fallback; rejections reach the rollback), and a failed strictness change now also REBUILDS under the restored setting (requestRescan + refresh — assignments may already be deleted, and a restored preference with an empty queue would strand pending photos until the next launch).
81. **`setGroupBest` rejects zero-row (stale-group) writes** like the compare and ejection paths — a warm scan can rebuild an unreviewed group under a new id between render and the Best tap, and a silently ignored star must not report success.

Final-review round 19 fixes, same pending vetting:

82. **The window write itself carries the supersession fence** (`writeContinuousGroups` `abortIf` checked INSIDE the exclusive transaction) — a window superseded mid-embed could otherwise commit after the strictness reset cleared the queue; entry-time fences alone left that race open.
83. **Failed rollbacks surface honestly** in both settings flows (a restore that itself fails now says the change stuck, instead of claiming restoration), and DayProgress's group list sorts by each group's NEWEST member (members are chronologically ascending — `members[0]` was the oldest).

Final-review round 20 fixes, same pending vetting:

84. **Singles UI edge polish**: the Groups screen hides the singles row when the feed is empty (tapping it opened a blank deck the entered-complete guard deliberately kept open), and the singles compare picker renders the same unreviewed-only candidate set `openCompare` accepts (staged-cull thumbnails were rendered but silently rejected).

Final-review round 21 fixes, same pending vetting:

85. **Fallback roots move only with the LATEST refresh** (generation-guarded `lastRootsRef` writes — an older refresh resolving a superseded broader source could overwrite what `refreshScoped` just recorded); the singles Compare button's disabled state mirrors `openCompare`'s exact eligibility (two unreviewed candidates AND an unreviewed current), and the compare picker labels photos by their DECK position, matching the header and Compare's own labels.

Final-review round 22 fixes, same pending vetting:

86. **`refreshScoped` retries until it commits as the LATEST refresh** (bounded at 5, then throws into the picker's rollback) and installs the strict roots as the fallback UP FRONT — a concurrent scan-status refresh could supersede its commit and, on a transient resolution failure, fall back to the superseded broader scope. Compare labels and the picker now number GROUP candidates by live-deck position too (unreviewed + staged culls — `liveIds`), completing round 21's position fix for groups.

Final-review round 23 fix, same pending vetting:

87. **A failed `refreshScoped` reverts its eager fallback WITH the caller's setting rollback and re-renders the restored scope** — a competing refresh may already have painted the rejected scope, and the fallback roots must never outlive the setting they belonged to.

Final-review round 24 fixes, same pending vetting:

88. **Rollback re-rendering is caller-ordered**: `refreshScoped`'s failure path only reverts the fallback (a context-side refresh would resolve the still-persisted rejected source); the picker refreshes AFTER its rollback write lands. A previously UNSET source rolls back to unset (`deleteSetting`) so the dynamic Camera-folder default stays dynamic instead of freezing a resolved snapshot.
89. **The favourites tab reloads on focus** — the bottom-tab navigator keeps it mounted while blurred, so its mount-time-only load showed stale rows for intents queued later from the deck.

Final-review round 25 fixes, same pending vetting:

90. **The source picker fences the scan FIRST** (like the strictness flow): `supersedeScan()` before resolving/rendering the new scope — an old-source window completing mid-apply could repopulate a group with newly excluded photos; the rollback path rebuilds via `requestRescan` under whatever setting is durable.
91. **Re-rendering the restored scope is PART of the rollback**: a failed post-rollback refresh no longer claims "selection unchanged" — the queue may still show the rejected scope, and the toast says to reopen and retry.

Final-review round 26 fixes, same pending vetting:

92. **Decisions reject externally removed photos**: the verdict write requires `is_present = 1 AND state NOT IN ('trashed','confirmed')` — a stale deck tile deciding a reconciled photo would overwrite `trashed` and strand it from the scan's restore path. A single-photo decision surfaces the staleness; batch keeps skip reconciled members loudly (they converge on refresh).
93. **The strictness rollback COMPLETES its queue refresh before returning** (the deleted groups must leave the rendered queue before back-navigation can reach one), with the toast reflecting an un-rerendered rollback; and a failed SQLite source rollback installs and renders the DURABLE (new) scope — the reverted fallback matched nothing persisted.

Final-review round 27 fixes, same pending vetting:

94. **The presence/membership lens covers every group write**: compare endpoints must be present AND unreviewed at write time; a non-null best must be a present, reviewable member (reconciliation keeps absent assignments); ejection requires present rows (an absent `user_single` would never regroup after a Gallery restore); "Keep remaining" validates its whole member list against the displayed group inside the decision transaction (`extras.requireGroupMembership`).
95. **A source narrow resets unfrozen assignments before rendering** (same as the strictness flow) — an unreviewed cross-source group still queues via its in-source member and would render whole; deciding its excluded member pre-rescan would freeze the stale membership.

Final-review round 28 fixes, same pending vetting:

96. **The round-27 picker reset actually landed** (the fix script had aborted mid-run before writing the picker — codex re-flagged it; now verified by grep in-repo), and direct-SQLite mutations refresh the cached review queue: an organize apply with moves refreshes ReviewContext and rescans (photos.uri changed — cached rows held dead pre-move URIs), and edit detection refreshes after any auto-done or copy-state write (a stale unreviewed copy left actionable in the deck could overwrite the durable done).

Final-review round 29 fixes, same pending vetting:

97. **Queue reads use ONE snapshot**: `listReviewGroups` and `getReviewGroup` read headers + members inside one exclusive transaction (a scan window committing between the two split queries could render obsolete groups with empty member lists — a blank deck); `listGroupsForDay` fetches sequentially (parallel snapshots would nest transactions).
98. **Both remaining reconciliation paths refresh the queue**: edit detection reports `reconciled` (a deleted edited copy dissolving a cached group), and History's page reconciliation refreshes ReviewContext directly.

Final-review round 30 fixes, same pending vetting:

99. **The queue read is ONE cross-slice snapshot** (`readReviewQueue`: groups, singles feed, and counts in a single exclusive transaction — independent reads could cache a photo as both grouped and single mid-scan, with counts disagreeing with the arrays), and the ambiguous edited-copy cull branch refreshes the cached queue (the original already moved `to_edit → culled` with its star cleared before the alert).

Final-review round 31 fixes, same pending vetting:

100. **A cancelled edited-copy cull restores the star it cleared**: `prepareTrashBatch` records the stars its stage-and-reserve transition cleared (`clearedStars`, carried through the attempt result) and the definitive non-application branch restores them via the validating `setGroupBest` — a normal sheet cancellation must be a true no-op, star included.
101. **A grouping setting and its assignment reset commit ATOMICALLY** (`applyGroupingSettingChange`: setting upsert/delete + unfrozen-assignment reset in one exclusive transaction, used by both flows and their rollbacks) — a process death between the two would leave the next launch rendering old assignments under the new scope.

Final-review round 32 fixes, same pending vetting:

102. **Applying a grouping change BLOCKS every exit** (both flows: a `beforeRemove` navigation block plus a full-screen shield Modal with a spinner) — with the apply queued behind an active scan, a user backing out mid-apply could decide a cached stale group and freeze a lone member before the refresh lands.
103. **Edge hardening**: an all-probes-failed source catalog THROWS instead of resolving to an empty "all folders" default (silently broadening the previous Camera scope); the stage-and-reserve transition clears/records a star only when the staging update actually applied (a stale copy prompt would otherwise silently lose the star with no `clearedStars` to restore); the Settings About row says "Afterglow" (rename stragglers).

Final-review round 33 fixes, same pending vetting:

104. **The picker releases its exit guard before its own successful goBack** (the round-32 `beforeRemove` block was cancelling the save's navigation — a self-inflicted regression codex caught); ProgressView keeps its previously rendered scope when source resolution fails (the catalog throw would otherwise become an all-folders render there); and the cancelled-cull star restore rides IN the un-staging transaction (`unstageCullDirect(…, restoreStars)`) — a crash between separate writes would lose the star forever, `clearedStars` being memory-only.

Final-review round 34 fixes, same pending vetting:

105. **ANY failed album probe rejects the source catalog** (a partial catalog missing DCIM/Camera would make the unset default silently broaden to all folders), and a failed source-setting transaction is caught: the picker toasts, restarts the fenced scan under the unchanged durable setting, and stays open (previously an unhandled rejection with scanning stopped until an app restart).

Final-review round 35 fixes, same pending vetting:

106. **`refresh()` retries until it commits as the LATEST pass** (bounded, like `refreshScoped`) — the settings flows await it as a barrier before unlocking navigation, and a silently superseded pass could leave reset groups actionable if the newer refresh failed. Favourite intents require presence (`is_present = 1`; a lone stale toggle surfaces like a lone verdict), and the source picker catches catalog failures with a Retry state instead of a stuck loader.

Final-review round 36 fixes, same pending vetting:

107. **Every verdict carries its RENDERED assignment**: `decide` (deck, singles, Compare) validates the displayed group-or-single assignment in the transaction (`extras.requireAssignment`), and "Keep remaining (singles)" requires every target to STILL be a single — a scan reassignment between render and tap must reject, never freeze a group the user never reviewed.
108. **Remaining edges**: needs-edit toggles require presence (a reconciled row regaining the flag would turn a post-restore Keep into to_edit; lone toggles surface); DayProgress's group list reloads on review-version changes (viewer edits refresh without leave-and-return); older-day expansion catches count failures like the day-row loader.

Final-review round 37 fixes, same pending vetting:

109. **Present-but-unseen assets refresh their PATH** during scan reconciliation (a photo moved without changing MediaStore id — e.g. out of the selected source — kept its stale in-scope uri, surfacing out-of-scope with a dead file path forever), and a MISSING assignment row always fails the rendered-assignment validation (a settings reset deleting a rendered single's row coerced to the same value as a real single — a verdict would freeze a photo whose assignment can never rebuild).

Post-vetting addition (Tristan, 2026-07-26 — during the vetting round):

110. **The Unknown-day pseudo-day** (`UNDATED_DAY_KEY`): undated photos get their own always-visible "Unknown day" row in Home's still-to-review section (outside the 2-older-days slice) and a full day-progress page — state summary, DB-paged grids (MediaStore cannot be queried for missing DATE_TAKEN; the tracked rows are the population), and "Groups this day" over the undated groups. Vetted design entries 26/28/29/53 and the as-built undated treatment (65–70, 74) were approved in the same round; strictness stays the honest confirm.

111. **Write priority (Tristan: fix before release)**: interactive writes take priority over the scan — `lib/writePriority.ts` gates the scan at every window boundary and per-photo embed persist while a user write runs (bounded 10 s safety wait so a hung write can never stall the scan). Wrapped: every `ReviewContext.write` decision, StateEditorSheet transitions, EditQueue mark-done. Dialog-bearing flows (trash confirm, favourite/organize applies) are deliberately NOT wrapped — holding the gate through a native consent dialog would starve the scan instead. Fixes the observed 15–20 s "Saving…" during an active 27 k rescan; entries 41/50 (restore preserves the copy prompt) were vetted in the same round.

112. **Exact reclaimable bytes (Tristan: no capped estimates)**: schema v14 adds nullable `photos.size_bytes`, recorded by every scan upsert — the Home figure is now a single exact SUM over staged culls, with a transient per-file stat fallback for pre-v14 rows (the set empties after one scan). v13 → v14 is the one ADDITIVE migration (destroying validated review data and 27 k embeddings for a nullable column would be waste; the destructive pre-v1 policy permits, not mandates). The all-time "reclaimed" figure was always exact (verified per-photo measurements, at-most-once credit). Round-40 gate fixes rode along: a hung write's timeout opens a bypass instead of re-arming 10 s per yield, and the embed persist re-checks the gate after the native await. Limits (b) older-days 60, (c) singles display page 500, (d) whole-group source rendering were vetted as-is.
