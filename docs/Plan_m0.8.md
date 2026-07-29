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

**Gate 1 — grouping engine in core (pure TS).**
`packages/core` gains embedding grouping: burst gating by timestamp gap, centroid linkage (Float32Array vectors via injected lookup, like `hashOf`), adjacent-burst merge, near-dup annotation from dHash. Pure functions, no platform APIs. Unit tests run the committed labeled fixture (see Regression suite) and pin the baseline. Core `similarity.ts` keeps `dhash64`/`hammingDistance`; `groupBySimilarity`'s corpus-scale use is retired.

**Gate 2 — continuous scan pipeline in the app.**
On app open: page MediaStore newest→oldest; for photos without a current embedding, decode+embed via the module (concurrency tuned; decode cap lowered toward the 224-px embedder input — S10e must land ≤100 ms/photo end-to-end, from 142 ms measured at the 1024-px cap); persist embeddings as SQLite BLOBs keyed by asset id + `mod_time`, with the model file's SHA-256 stored once (model swap = explicit re-embed event). Grouping runs incrementally per closed burst; groups land in the durable grouping tables. Interrupt-safe by construction (per-photo persistence — validated the hard way when a dump run was frozen mid-flight by the OS). Battery/thermal sanity check on a 5k batch rides this gate's device validation.

**Gate 3 — DB-backed deck + `kept` removal.**
The deck reads groups from SQLite and writes decisions directly (decisions 1–2 above). Deletes: `SessionContext` machinery, snapshot persistence queue, `sessions` table, banking paths, core `deck.ts`/`cull.ts` + their tests (~2,070 lines), scope machinery (decision 3). Group stability invariant (decision 5) enforced at the regroup boundary. All state-machine edge paths (un-cull, Restore, `reviewed_at`, needs_edit interplay) covered by tests against the real SQLite schema.
**Rehome, don't lose, the 0.7.1/0.7.2 hardening** that currently lives in or around `SessionContext`: the trash-attempt lifecycle (verification, recovery, reconciliation) and edit-lifecycle coherence (cycle-keyed detection/completion, copy-match resolution on restore) are durable-truth behaviors that move to the new DB-backed context intact, with their tests. Session-specific hardening (done-state reconciliation with the live session, membership gating during session restore, serialized session install/replacement) becomes structurally moot once decisions write the DB directly — retire it deliberately, mapping each behavior to its no-session equivalent or to "impossible by construction".

**Gate 4 — Home navigation redesign + copy/terminology (tester round, `Feedback_m0.8.md`).**
Bottom tabs **Home · Edit · Favourite · Share · Organize** (count-badged); Cull list from Home; History as settings-adjacent icon. Home above the fold: scan/embed status, daily goal ring, continue-reviewing, live corpus stats (total, groups found, % reviewed, reclaimable estimate). Summary becomes daily/milestone-based; streaks = goal-reached days; Sessions settings section replaced by Daily goal. The dHash similarity chips/slider are replaced by a single simplified grouping-strictness control mapped to the cosine threshold around the 0.50 default (decision 8), and the legacy time-only toggle is removed **(autonomous: exact control UI decided at this gate; the regression suite bounds how far the control may stray)**.
Copy & terminology (testers): review-flow copy says *review*, never just *cull* (the old "Start culling" CTA dies with sessions; its successor is continue-reviewing); the "Clear your photos down to the keepers." tagline is removed — corpus stats and the daily goal carry the message; the edit-queue's two buttons become self-explanatory (editor-that-can-save vs view-only gallery — descriptive labels/subtitles, exact copy at implementation).
**App convergence (PLAN.md decision):** the app renames to **"Afterglow"** — `app.json` name/display name, launcher label, in-app and README/release-note surfaces; the application id stays `com.afterglow.companion` for now — it aligns to the new name at the pre-v1 identity break (PLAN.md "After m0.9": keystore + id + versionCode reset in one tester disruption). The terminology audit aligns mobile vocabulary with desktop's where concepts match (queues, organize, review states; PLAN.md as canonical glossary), as the first step of one-product-two-surfaces convergence; deeper queue UI-UX convergence rides desktop organizer (v0.7) and later mobile releases.

**Gate 5 — deck/viewer rework** (unchanged scope from the roadmap): culled photos stay badged in the live deck; one standard full-screen viewer for deck browse, progress, history, queues; completed days re-show groups in browse/re-decide mode; staged culls re-enter the feed badged with prior verdict; recent days = 3 recent + 2 unreviewed + older-days indicator; day-count audit with kept/done merged into "reviewed".

**Gate 6 — release.**
Per-ABI APK splits (the universal APK grew 106→162 MB with MediaPipe; splits reclaim most of it — verify the release workflow and manifest handle multiple APKs, else ship universal and note the size). Version 0.8.0 / versionCode 7; destructive DB reset (fresh-baseline policy); README/release notes tell testers what changed (sessions gone, first-open backfill expectations per device class); preflight + tag `mobile-m0.8`.

## Grouping regression suite (quality can never silently drop)

- **Committed to the repo:** `docs/grouping-study/labels-v1.json` (698 hard pairs — 503 link / 195 apart — plus 96 soft and 7 deliberately retired; spans 2020–2026 and two cameras; every cross-round conflict, statistical outlier, and conversion-interpreted label human-adjudicated in the validation round) and `docs/grouping-study/embeddings-labeled-v1.json` (428 labeled photos × 1280-dim base64 float32, ~2.9 MB, no image content; model SHA-256 embedded). Personal photos and full-corpus data stay gitignored/local.
- **Core test tier (CI):** replays the Gate-1 engine over the fixture and asserts pinned floors — must-link kept ≥ baseline, must-not-link violations ≤ baseline, largest component ≤ bound. Any algorithm or threshold change that degrades the score fails the build; improving it means deliberately re-pinning.
- **Local full-corpus harness:** `docs/grouping-study/` tooling (embed/eval/sheet scripts) stays for corpus-scale sweeps and future judged rounds; each new round appends labels and re-pins the baseline (as v2 — v1 is frozen).
- **Soft pairs** score separately (neither rewarded nor penalized) — human raters disagree on most near-duplicate boundaries; ambiguity is resolved by the inclusive policy, not chased with thresholds.
- **Fixture hygiene:** before the fixture is first committed, a validation round adjudicates every cross-round conflict, re-confirms the statistical outliers (lowest-sim links, highest-sim aparts), and confirms all conversion-interpreted labels; pairs Tristan retires become soft. The result freezes as `labels-v1`; later changes happen only through new judged rounds producing `labels-v2`, never by editing v1 in place. The freeze includes a transitivity audit on the final merged set (apart edges inside link-connected components) — contradictions get human adjudication before the fixture is consumed.

## Deferred / adjacent

- Videos enter review + Android ≤10 permanent-delete path: m0.9 (moved out of m0.8).
- Panorama-family grouping quirk (extreme aspect ratios; one recurring composition failure in both judged rounds): revisit only if testers hit it.
- Battery/thermal long-run profile beyond the Gate-2 sanity check: only if testers report drain.
- Desktop reuse of the grouping engine (organizer v0.7): consumes the same core module; no mobile-side accommodation needed now.

## Autonomous decisions appendix

Pre-implementation decisions were all human-vetted on 2026-07-24 (see Decisions). Implementation-time judgment calls get numbered entries here as they happen.
