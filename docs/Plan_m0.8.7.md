# Plan — m0.8.7: sources, badges, and the queues

**Status:** ready to build.
Every design gate is cleared: Errors §6 (grilled 2026-08-21), the regroup retirement ([Regroup_design.md](Regroup_design.md), grilled 2026-08-21), the stats audit ([STATS_ACCURACY.md](STATS_ACCURACY.md), slotted 2026-08-21).
**Scope sources:** [Feedback_m0.8.x.md](Feedback_m0.8.x.md) (m0.8.7 section: F10 F11 F12 F14 F15 F18 F19 F20 + TODO promotions), [Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md) (riders: F21 F27-fix F30 + the share-before-edit confirm + the stats sweep), [Errors_design.md](Errors_design.md), [Regroup_design.md](Regroup_design.md).
This plan adds no new decisions; it sequences settled ones.
**Versioning:** app.json `version` 0.8.6 → 0.8.7, `android.versionCode` 13 → 14, package.json 0.8.6 → 0.8.7; tag `mobile-m0.8.7`.
Schema v21 → **v22** (destructive rebuild; testers reinstall, per pre-v1 policy).
Delete this doc when the release ships; durable behavior distills into PLAN.md, STATE_MODEL.md, STATS_ACCURACY.md, and code headers.

**Running since 2026-08-21 (no code):** the S23 `[scan]` logcat capture.
Check the writer is alive at every phase boundary and after any phone reboot (commands in [Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md) step zero).
Its accumulating evidence is read back in phase 2 and again at close-out.

---

## Phases

Each phase lands with its tests and doc updates before the next starts.
Order is a dependency chain; the flags marked **(autonomous)** are the pre-implementation log — number each in the appendix as it is implemented.

### Phase 1 — Foundations: schema v22 + core cannot-link

Regroup_design §9 phase 1, verbatim, plus the stats sweep's schema rider:

- v22 destructive rebuild: `duels` loses `group_id` (endpoints nullable, endpoint indexes); `not_related(ejected_id, partner_id, at)` with partner index; `photo_group_assignments.user_single` dropped; `photos.decided_first_at` added (immutable first-decision stamp, [STATS_ACCURACY.md](STATS_ACCURACY.md) gap 8).
- Cannot-link constraints in `@afterglow/core`'s embedding grouping (injected pair set; merge refusal; the A→B dissolution scenarios as unit tests).
- `npm run build -w @afterglow/core` after every core edit.

### Phase 2 — The scan: groups land as truth, deltas stay deltas

- Regroup_design §9 phases 2–3: delete `regroupBoundary.ts`, the freeze/reconcile/append machinery, and the reset carve-outs; exclusions filter grouping input and revalidate in the write transaction; the duels contract (no deleters; forget-erase anonymizes; D5 apparatus removed — un-review loses its confirm).
- F27's two-leg fix: the changed set filters to the source scope (keyed on each row's current path, so moves *into* a source still register), and in-source undated changes land without a corpus walk.
  Invariant landed with it: **every planner fallback logs its reason; none returns silently.**
  Read the capture log first — if it has named any further full-pass reason since 2026-08-21, fix it here too.
- **In-app diagnostics log** (`diagLog` — the field-diagnostics TODO's first slice, Tristan 2026-08-21): a rotating file sink in the app's external-files directory (**50 MB total, ~ten 5 MB segments**, own timestamps per line) — survives locks and reboots, readable by `adb pull`, no UI, device-local only (never transmitted; export stays with the parked field-diagnostics design).
  Routed in (per the 2026-08-21 log-site audit, all 85 sites reviewed — the app has no dev-noise logging at all): **every curated line routes** — all 28 `[scan]` kinds, all 7 `[perf]` sites, the source-resolution and keep-last query failures, the user-action outcomes, the correctness tripwires, and the four preference-save failures (a cluster of failing cheap writes is a storage-layer early warning).
  Shape rules: root causes route unconditionally, screen-level echoes dedup, paging-loop classes rate-limit, the timeline perf line aggregates per session.
  New lines this slice adds: the global JS error hook, an error boundary at the provider stack that logs before dying, and a `diagLog` call on the **decision-write failure path** (today alerted but never logged — the app's most important failure leaves no trace).
  Privacy stance: no scrubbing in this slice — every routed line already prints to logcat, so the sink adds device-local persistence, not new exposure; scrub-or-disclose is a named gate of the parked field-diagnostics **export** design.
  The ~44 silent `.catch(() => {})` swallows stay as-is, noted as a class the sink makes cheap to instrument case-by-case.
  Behavioral/usage analytics is explicitly **not** this — diagnostics means faults and timings, never user actions (PLAN.md backlog holds the analytics trigger).
  The fragile adb logcat writer retires when this ships.
- F20: the scan reads `IS_FAVORITE` on rows it already walks and projects it as a CARRIED favourite action; a cleared flag clears the carried action; **queued rows are never touched**.

### Phase 3 — Sources and badges

- F18/L3: source selection becomes the second scope axis — the audit over every queue read and bulk-action binding under the M5 rule (a fresh read may only shrink).
  This also delivers STATS_ACCURACY gap 10 (the three staged-cull reads).
  **Measure the queue reads on the S10e before and after** — `sourceClause`'s leading-wildcard LIKE joins reads that skip it today; if it bites, the `source_root` column fix is a known shape but **its own decision, not this release's** (schema change).
- F19+F14/L6: source-folder and SD-card badges join the shared vocabulary; ONE control hides all badges — a **durable persisted setting** (vetted 2026-08-21).
- F10 (tag misalignment) and F11 (selection outline shifts rows): **reproduce on the S10e first** — F10's cause is not yet located; F11's fix shape (reserve the outline's width in both states) is read, not measured.
- F12 (picker shows nothing before folders arrive): reproduce, then make loading the DEFAULT state rather than a state entered on the way.
- `docs/STATE_MODEL.md` gains the second scope axis.

### Phase 4 — Queue semantics and the state editor

- F21's four-point contract: share and edit intents stay live on a staged cull (visible, dispatchable, addable from deck and editor); favourite and organize stay suspended and refused as additions; the cull-confirm names never-sent share/edit intents with proceed/cancel; the suspension tests and STATE_MODEL section are rewritten deliberately.
  The un-stage resurface machinery deletes.
- The share-before-edit dispatch confirm (any photo whose edit intent is still queued, at dispatch time).
- Action-layer coherence: the four queue screens share one action bar (confirmation semantics included); Progress grids hydrate the weighted action set (live/carried/removing) on BOTH paths, solving the dot-scale question (a dot cannot render the heart-off glyph) **(autonomous on the chosen glyph treatment)**.
- F30: dimmed-stale-facts during re-reads, both sites (StateEditorSheet + PhotoViewer facts panel).

### Phase 5 — The error contract (Errors_design §7)

- First the `plural()` helper via F15's copy audit (one pass over user-visible strings for count agreement; fallback: fewer than ~5 count-bearing sites → local ternaries, record the count).
  The audit re-checks F3's scanning state and F16's *Sheet opened* chip rather than assuming them; empty-state grammar aligns here if cheap, else explicitly deferred to phase 7.
- Then the boundary classifiers, in order: **favourite** (D4's partial-success sentence, both counts singular+plural), **trash**, **share** (expected tiers 2+3; a tier-1 sentence only if a provable cause is found **(autonomous)**), **edit launch** (classifier over `editMatrix` probe facts).
- Testing per Errors_design §8: pure classifiers, deliberately-unrecognisable platform messages, tier 3 always after tier 1.

### Phase 6 — Regroup UX

Regroup_design §9 phases 4–5:

- Eject records pairs (dissolve-then-insert ordering) against **all present members of the group** (vetted 2026-08-21 — hidden unreachable members included; the dissolution rule is the over-reach safety valve) and triggers the targeted window rescan.
- Un-eject row in the state editor (clears the photo's own pairs, same rescan); viewer fact copy updated.
- The Settings strictness/source confirm re-copied: "Regroups your whole library (takes a few minutes). Review decisions and 'not related' judgments are never touched."
- STATE_MODEL's freeze section becomes the exclusions section.

### Phase 7 — The stats sweep + type-scale pass

- STATS_ACCURACY riders, all vetted 2026-08-21: gap 4 — **classification from verdict stamps only** (`culled` = `culled_at IS NOT NULL`; external removal never reclassifies; unreviewed-then-removed counts as nothing); gap 6 — **both intake series reach+source scoped** (the decided series gains the reach clause); gap 7 (frontier over durable stamps; the histogram's dead arm with it); gap 8 readers — **day-bucketed counts read `decided_first_at`, timing and ordering read `decided_at`** (the goal ring counts only first decisions); gap 9 (one "longest streak" definition); gap 11 (dead read, dead arms); and two figures retire until the event log can back them truthfully — the "you keep 1 of X" clause (redundancy line stays) and the **favourites figure** (both sites — a library fact, not an Afterglow-actions stat, per STATS_ACCURACY's organizing principle).
- The type-scale and token pass, with before/after screenshots from this release's device pass: headings, subtitles, radii, scrims, paddings; Summary's blank loading view; empty-state grammar if phase 5 deferred it; the UnitCard thumbnail-size question decided with screenshots in hand (Tristan leans "probably okay as is") **(autonomous)**.
  Lift the pass back out if the release runs long: nothing else depends on it.

### Phase 8 — Close-out

- Docs distillation: Regroup_design.md and this plan's durable content into PLAN.md/STATE_MODEL/headers, then both deleted; Errors_design.md distilled and deleted; Feedback_m0.8.x.md deleted (its own instruction); STATS_ACCURACY statuses flipped to "shipped".
- Full gates: `npm run lint && npm run format:check`, core build+test, both typechecks, mobile tests, `npx expo export` bundle proof, prebuild+gradle release build.
- The UI gate (`node scripts/mobile-ui-gate.mjs`) against the installed release build; then the manual device pass (below).
- `codex-review` rounds until clean (self-review against docs/REVIEW_CLASSES.md first).
- Version bumps, tag `mobile-m0.8.7`.

## Device pass (both phones; the release-specific gate list)

1. F18: deselect a folder — its photos leave every queue, count, grid, and the forecast pool; re-add restores byte-for-byte. Measure the S10e queue-read timings (phase 3).
2. F21: share-then-cull end-to-end (queue shows the staged cull badged; dispatch works; confirm names unsent intents; History proof survives).
3. F27: with the fix installed, drop a WhatsApp image (out-of-source) and a stripped-EXIF file (in-source) — neither may trigger a corpus walk; the capture log shows the reasons.
4. Regroup: the A→B double-ejection scenario on device; un-eject and watch the regroup land; mid-review re-mint walk (Regroup_design §7); the strictness confirm's full pass completes with decisions intact.
5. Errors: force one failure per boundary (the m0.8.4 WhatsApp-photo method) — tier order and n=1 copy verified on screen.
6. Badges: both new badges on every surface; the hide control; F10/F11/F12 verified fixed on the S10e.
7. Stats: after confirming culls, the histogram/frontier/summary figures move only as STATS_ACCURACY says they should; "favourites applied" wears its new label.
8. Screenshots for the type-scale before/after set.

## Autonomous decisions (appendix)

Numbered as implemented; each entry names the call, the choice, and why.
Getting these human-vetted is a top priority; an approved entry is pruned per the assumptions discipline.

*(none yet)*
