# Stats accuracy — the living contract

**What this is:** the record of whether every user-visible statistic is **lifetime-true** (counts what happened, immune to later cleanup) or **current-state** (recomputed from rows that deletion, scoping, or regrouping can change), the exact scenarios where each number moves for reasons other than reviewing, and the tradeoff a fix would cost.
Born from the 2026-08-21 audit (design phase of m0.8.7, prompted by the duels append-only decision — [Regroup_design.md](Regroup_design.md) R3/R9).
**The organizing principle (Tristan, 2026-08-21):** Afterglow's stats track **actions performed in Afterglow**; library-state figures are welcome but must be labeled as library facts, never presented as behavior.
A number that cannot yet be stated truthfully under that principle rests until it can (the "keep 1 of X" clause, the favourites figure) rather than shipping as a quiet lie.
**Update discipline:** re-assess a row whenever a stat, a deleter, or a scope predicate is added or changed; move a gap to "fixed" only when its fix ships.

## The three durability tiers

| Tier | Storage | Survives | Killed by |
|---|---|---|---|
| **T1 — durable stamp** | `photos.reviewed_at`/`culled_at`/`decided_at`, kept on tombstones ([trashStore.ts:244-255](../apps/mobile/src/db/trashStore.ts#L244-L255)) | culls, external deletion, unmount, source deselection | forget-card **erase**, schema reset |
| **T2 — durable satellite row** | `trash_batch_members.measured_bytes`, resolved `photo_actions`, `duels` | photo deletion/tombstoning | targeted sweeps (each named below); forget-card cascades |
| **T3 — live-row recompute** | any query with `is_present = 1`, `reachClause`, or `sourceClause` | nothing — it is a snapshot | every deleter, every unmount, every source change |

Two silent scope shrinkers: `reachClause` ([store.ts:168-178](../apps/mobile/src/db/store.ts#L168-L178), mounted volumes) and `sourceClause` ([store.ts:141-157](../apps/mobile/src/db/store.ts#L141-L157), selected folders).
Deliberately **unscoped** ("what you DID", [statsLoad.ts:11-25](../apps/mobile/src/lib/statsLoad.ts#L11-L25)): `getLifetimeStats`, `lifetimeReclaimedBytes`, `getDuelSummary`, the finished half of `getQueueTurnaround`, the History feed.

## Per-surface verdicts

Full query citations live in the audit rows below; "moves on" lists only non-reviewing movers.

### Home

| Stat | Feed | Verdict | Moves on |
|---|---|---|---|
| Goal ring "N of M today" | `getReviewedCountsByDay` ([store.ts:1690-1717](../apps/mobile/src/db/store.ts#L1690-L1717)) | T1 for today | re-deciding old photos re-stamps `decided_at` into today ([store.ts:483-491](../apps/mobile/src/db/store.ts#L483-L491)); source deselection; erase |
| Goal streak / longest (120-day window) | `goalStreaks` ([dailyGoal.ts:124-149](../apps/mobile/src/lib/dailyGoal.ts#L124-L149)) | T1, window-truncated, judged vs CURRENT goal | goal changes re-colour history; disagrees with Stats' unbounded "longest" (gap 9) |
| "N pictures total" | MediaStore count | T3 by design | deletion, unmount, source change |
| "To review · in M groups · singles" | `countReviewQueueIn` ([store.ts:1579-1597](../apps/mobile/src/db/store.ts#L1579-L1597)) | T3 | deletion, unmount, source change, regroup |
| Cull row "N staged · ~X reclaimable" | `countStagedCulls`/`getStagedCullBytes` | T3; **ignores the source filter** (gap 10) | unmount; external deletion |
| Keeping-up bar | `getCoverageByDay` ([store.ts:1655-1682](../apps/mobile/src/db/store.ts#L1655-L1682)) | T3 | deleting/unmounting unreviewed photos "clears" days (gap 5) |
| Coverage streak "most recent N days…" | `coverageStreak` ([coverageGoal.ts:153-163](../apps/mobile/src/lib/coverageGoal.ts#L153-L163)) | T3, **non-monotonic** | emptied days are *skipped*, so deletion/unmount can join streaks (gap 5) |
| Recent-day rows "R/T · P%" | `getDaySummariesForDays` ([store.ts:3509-3552](../apps/mobile/src/db/store.ts#L3509-L3552)) | mixed: trashed half T1, live half T3 | unmount shrinks totals but keeps trashed → % jumps |
| Forecast headline | `finishLine` over MediaStore − `getCorpusStats.reviewed` | T3 both sides | housekeeping moves the ETA; mixed populations (gap 6) |

### Summary

| Stat | Feed | Verdict | Moves on |
|---|---|---|---|
| Today tiles (reviewed/keepers/staged/culled) | `getDayReviewSummary` ([store.ts:3457-3486](../apps/mobile/src/db/store.ts#L3457-L3486)) | T1 population, **T3 classification** | deleting a kept photo externally re-files it under "culled to trash" (gap 4) |
| All-time "reviewed" | `getLifetimeStats` ([store.ts:4292-4314](../apps/mobile/src/db/store.ts#L4292-L4314)) | **T1 — genuinely lifetime** | erase, reset only |
| All-time "culled" | same, `culled_at IS NOT NULL` | T1, label over-claims | first-stamps at *staging*; restore never clears it — means "ever staged" |
| All-time "edits completed" | resolved `photo_actions` count | T2 | one row per photo (five edits count once); erase cascade |
| All-time **"favourites applied"** | [store.ts:4304-4312](../apps/mobile/src/db/store.ts#L4304-L4312) | **current-state wearing an all-time label** | a verified un-favourite decrements it (gap 2) |
| "Reclaimed all-time" | `lifetimeReclaimedBytes` ([trashStore.ts:564-569](../apps/mobile/src/db/trashStore.ts#L564-L569)) | **T2 — lifetime-true** | erase, reset only |

### Stats (Activity · Forecast · Habits)

| Stat | Feed | Verdict | Moves on |
|---|---|---|---|
| Decided today / 30-day chart / rhythm / sittings | decision maps ([statsLoad.ts:139-189](../apps/mobile/src/lib/statsLoad.ts#L139-L189)) | T1 | `decided_at` re-stamps drain old bars (gap 8); source deselection |
| Personal best day / "new personal best" | `personalRecords` ([habits.ts:240-263](../apps/mobile/src/lib/habits.ts#L240-L263)) | T1 | re-stamps erode a historical best; a "new best" can fire because history shrank (gap 8) |
| "goalDays reached it" + streaks | `activityWindow` | T1, judged vs CURRENT goal | raising the goal un-reaches past days |
| Coverage chart | `getCoverageByDay` | T3 | as Home (gap 5) |
| Shooting vs reviewing | `intakeWindow` ([stats.ts:105-126](../apps/mobile/src/lib/stats.ts#L105-L126)) | **mixed populations** | captured is reach-scoped, decided is not — unmount reads as "suddenly ahead" (gap 6) |
| Forecast projections | `getForecastBaseRates` ([store.ts:3797-3855](../apps/mobile/src/db/store.ts#L3797-L3855)) | T1 population, T3 classification | external deletions inflate the projected cull rate (gap 4); erase cascades thin shared/edit history |
| "N head-to-head compares · kept both P%" | `getDuelSummary` ([store.ts:4048-4059](../apps/mobile/src/db/store.ts#L4048-L4059)) | T2 with four deleters today | **fixed by Regroup_design R3** (gap 3) |
| Decisiveness "cull X% lately vs Y% all-time" | `getDecisionOutcomesSince` ([store.ts:4064-4078](../apps/mobile/src/db/store.ts#L4064-L4078)) | T1 population, T3 classification | gallery cleanups read as "culling harder lately" (gap 4) |
| Queue "waiting" / "finished · median" | `getQueueTurnaround` ([store.ts:3986-4018](../apps/mobile/src/db/store.ts#L3986-L4018)) | waiting T3 (deliberate), finished **T2 lifetime** | erase cascade only |

### Progress / DayProgress

| Stat | Feed | Verdict | Moves on |
|---|---|---|---|
| "R of T reviewed · P%" + chips | `getStateCountsInScope` ([store.ts:2996-3086](../apps/mobile/src/db/store.ts#L2996-L3086)) | mixed (trashed T1, live T3) | unmount inflates %; external deletion raises reviewed % |
| Capture histogram | `getCaptureHistogram` ([store.ts:4106-4130](../apps/mobile/src/db/store.ts#L4106-L4130)) | **T3** | executed culls vanish from the chart (`is_present=1` makes the `'trashed'` arm dead); unmount empties years (gap 7 family) |
| Frontier "reviewed back to …" | `getBacklogFrontier` ([store.ts:4142-4168](../apps/mobile/src/db/store.ts#L4142-L4168)) | **T3** | deleting oldest reviewed photos walks the frontier forward (gap 7) |
| Storage breakdown | `getStorageBreakdown` ([store.ts:4179-4212](../apps/mobile/src/db/store.ts#L4179-L4212)) | T3 (correct for storage) | any deletion/unmount; `kept`'s trashed arm unreachable (gap 11) |
| **Burst tax "you keep 1 of X"** | `getBurstStats` ([store.ts:4231-4275](../apps/mobile/src/db/store.ts#L4231-L4275)) | **T3 — self-destroying** | confirming culls removes members, dissolves groups; the ratio converges on "1 of 1" (gap 1) |

### Other counters

Queue badges, Timeline/Deck chrome, CullList: T3 by deliberate design (they mirror what is actionable now).
Share pass counts: T2 but cycle-scoped — a trash confirm can close the cycle and zero them.
History "Shared · N photos": T2; forget-erase can shrink or drop past events.
Forget-**keep** toast "review history for N photos kept": misleading today — the same transaction deletes the volume's duels ([volumeLifecycle.ts:109-113](../apps/mobile/src/db/volumeLifecycle.ts#L109-L113)); fixed by R3 (no duel deleters remain; erase anonymizes).

## The gaps, ranked by user surprise — with fix shapes and status

Every slotting below was settled 2026-08-21 (grilled); the stats sweep rides m0.8.7 unless a row says otherwise.

| # | Gap | Fix shape | Tradeoff | Status |
|---|---|---|---|---|
| 1 | **Burst tax destroys itself** — the "you keep 1 of X" ratio decays as culls confirm | Split the line: the redundancy half ("N near-duplicate frames in M groups") is honestly current-state and stays; the behavior half needs event history | A dedicated table for one line was rejected as sprawl | **Retired m0.8.7** (the redundancy half stays); the durable version is owned by the **event-log design** (post-m0.9, below) |
| 2 | **"Favourites applied" decrements** — current-state under an "All-time" heading | It is a **library fact, not an Afterglow-actions stat** (the organizing principle): the figure **retires in m0.8.7** (both sites), like the "keep 1 of X" clause | A relabel ("current favourites") was considered and rejected — it fixes the lie but abandons the feature's purpose (counting applies) | **Retired m0.8.7** (both sites); the favourite event log revives the true stat in the event-log design |
| 3 | **Duel counts shrink** (editor un-review, external permanent removal, forget-card *both levels*) | Append-only duels, forget-erase anonymizes | Settled | **Shipped m0.8.7** (Regroup_design R3) |
| 4 | **External deletions read as culls** — three readers classify `state IN ('culled','trashed')` ([store.ts:3473](../apps/mobile/src/db/store.ts#L3473), [:3820](../apps/mobile/src/db/store.ts#L3820), [:4072](../apps/mobile/src/db/store.ts#L4072)) | The distinguishing fact **already exists**: app-staged culls stamp `culled_at`, external removals never do ([trashStore.ts:296-302](../apps/mobile/src/db/trashStore.ts#L296-L302)) — classify culls as `culled_at IS NOT NULL` | Decided in-build: an externally-deleted decided photo counts as what was DECIDED (`culled` ⇔ `culled_at IS NOT NULL`; a stampless trashed row files under its keep; unreviewed-then-removed counts as nothing) — Plan appendix #16 | **Shipped m0.8.7** |
| 5 | **Coverage streaks move with deletion/unmount** (emptied days are skipped) | — | — | **CLOSED as designed behavior** (2026-08-21): a day whose remaining photos are all reviewed *is* fully reviewed, and reach/source scoping is the app's one scope model applied consistently. The unmount flap is the reach axis re-widening honestly. No code change; this row is the documentation. |
| 6 | **Intake chart mixes populations** (captured reach-scoped, decided not) | Both series reach+source scoped — the intake chart gets its own scoped decided map; every other decided read stays reach-unscoped (appendix #18) | One-line predicate | **Shipped m0.8.7** |
| 7 | **Frontier walks backwards on deletion** | Frontier over durable stamps (tombstones count as reviewed); histogram's dead trashed arm is the same family | Cheap predicate change | **Shipped m0.8.7** (frontier over `decided_first_at`, tombstones included; the histogram's dead arm removed with gap 11) |
| 8 | **Past days are not immutable** — `decided_at` re-stamps on every re-decision | Add `decided_first_at` (immutable) alongside `decided_at` (activity); history charts read the first stamp | Decided in-build: day-bucketed reads take `decided_first_at`, timing/ordering keep `decided_at`, and the ring credits only FIRST decisions (appendix #17) | **Shipped m0.8.7** |
| 9 | **Two "longest streak" definitions** (120-day vs unbounded) + goal-relative re-scoring | Unify on one window; goal-relativity is already a recorded PLAN.md decision for the all-time stat | Trivial | **Shipped m0.8.7** (`longestGoalRun`, one all-time definition — appendix #19) |
| 10 | **Cull count ignores the source filter** while neighbours honour it | Source-scope the three staged-cull reads | Covered by F18's audit rule (source is a scope axis, everywhere) | **Shipped m0.8.7** (count, list and bytes take both axes; the confirm loop binds to the scoped list) |
| 11 | Minor: `groupsFound` queried but never rendered; two unreachable `'trashed'` CASE arms | Delete the dead read; fix or delete the dead arms | Trivial | **Rides m0.8.7** |

## The event-log design (post-m0.9, one round)

A generic append-only event log was assessed (2026-08-21) and deliberately **not** built piecemeal: the event-shaped data in today's tables is operational (queue membership, recovery, cycles) and cannot move out, so a log is additive dual-write machinery whose taxonomy deserves one design-and-grilling round covering all members at once: group completions (gap 1), favourite events (gap 2), the parked History action streams, the lifetime-counter pattern, and whether duels stay standalone.
That round also owns the **actions-vs-library stats audit**: classifying every stat under the organizing principle, deciding which come from the log, and the copy pass that labels library facts as such.
Recorded in PLAN.md's roadmap.

## Corrections the audit made to prior claims

- The app's **own cull confirm and the 30-day purge never delete duels** — `resolveTrashBatch` passes `permanent=false` and tombstoned rows leave the reconcile candidate set ([trashStore.ts:452-457](../apps/mobile/src/db/trashStore.ts#L452-L457), [store.ts:1924-1925](../apps/mobile/src/db/store.ts#L1924-L1925)).
  The duel deleters were: editor un-review, **external** permanent removal, forget-card (both levels).
  The append-only decision (R3) stands unchanged — it removes all three.
