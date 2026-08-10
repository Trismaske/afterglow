# m0.8.5 — the review loop

The release you feel while reviewing: the deck, the goal moment, and the accent that five surfaces misuse.
Answers F1, F3, F4, F5, F6, F7, F13 and F17 from [Feedback_m0.8.x.md](Feedback_m0.8.x.md), plus two TODO promotions.

Delete this doc when m0.8.5 ships, after distilling anything durable into PLAN.md, STATE_MODEL.md and the code headers.

## 1. Overview

### What changes

- The deck stops remounting per unit. One route, the unit held in state (L4).
- The goal moment survives the advance, and a raised goal can be celebrated again.
- Goal crossings are counted from the write, so every verdict path celebrates — not just the deck and Compare.
- Five progress surfaces stop using the user-chosen accent to carry meaning.
- Four copy defects: the two streaks that read alike, the false "All reviewed" during a scan, the deck badge with no date, and Compare's chips on a staged cull.

### What does not change

- The trash path, the scan contract, the state model's three layers, and the queue screens.
- `destinationAfterUnit` keeps deciding **where** the deck goes. Only the mechanism of getting there changes.
- The `GoalCelebration` overlay keeps the accent: rule 3 permits it as transient interaction feedback, and its header already argues the case.
- The **best star** keeps the accent for now. It is the sixth accent site and its fate belongs to m0.8.6's knot.
- `pinchFrame` is not built. See §7.

### Why now

L4 is the largest piece and everything else rides its device pass.
F4 is not implementable before L4, because the advance tears down the overlay with the screen it is drawn on.
The accent's five sites sit inside surfaces F1, F3, F4 and F5 already open.

## 2. Agreed decisions

L1–L8 are in [Feedback_m0.8.x.md](Feedback_m0.8.x.md) and are not repeated.
The eight below were settled with Tristan in a grilling on 2026-08-07, before any code was written.
An approved decision is not an assumption, so nothing here needs re-deciding — read it before you reopen anything.

| # | Decision | Choice | Why |
|---|---|---|---|
| A1 | The F4 hold | **Fixed**, at the celebration's existing `TOTAL_MS` | Tap-to-dismiss reverses the overlay's `pointerEvents="none"` invariant and puts a live host view over the deck's gesture stack, which is the documented SIGSEGV trap. Requiring an input to continue is a worse interruption than 1.7 s, for something that fires once a day. |
| A2 | Where the hold lives | The deck's **one** internal advance point. Compare gets none | Compare never advances a unit — every terminal path calls `navigation.goBack()`. The moment is a consume-once ref in the context, so the deck it returns to claims it. |
| A3 | Counting crossings | **From the write**, not the caller | Noting is currently a caller's responsibility, so every new verdict path must remember. The three paths that forgot are the defect; making the write count its own unreviewed→decided rows removes the class. Covers m0.8.6's F9 before F9 exists. |
| A4 | A crossing with no review surface mounted | **Toast**, immediately | The durable marker is written before the moment arms, so an unclaimed crossing marks the day celebrated and shows nothing — and the pending ref then fires stale hours later. Hosts register while focused; no host means a toast and no pending ref. |
| A5 | Re-celebrating a raised goal | **No cap** | Nothing in the app counts celebrations. Every goal figure is derived per day from reviewed counts (`goalDays`, both streaks), so repeated crossings cannot inflate any statistic. Each fire still costs the work of reaching a higher number. |
| A6 | The accent | **Rule 3 wins**; STATE_MODEL's per-surface exemption is deleted | The standard contradicted itself: rule 3 lists the goal ring as a violation, the surface table calls it correct and exempt. Progress displays take keep-green throughout, completeness carried by the geometry each site already has. |
| A7 | `pinchFrame` | **Closed out**, becomes a device-pass check | It answers a symptom nobody has reported, on a platform that may already handle it. Its tests were written before the code; building to satisfy them is backwards. |
| A8 | The streak copy family | **"days with photos"**, 📅 for coverage, 🔥 stays with effort | The two streaks sit on different axes — decision days versus capture days — and both render as `🔥 N-day streak`. The tester's own suggestion ("last 25 days") is the same lie reworded: a fortnight with no photos neither breaks nor extends the run. |

## 3. L4 — one deck, unit as state

### 3.1 What the remount costs, measured

Screen recording on the S10e (0.8.4, *Keep remaining* on a two-shot group, sampled at 10 fps):

| t | What is on screen |
|---|---|
| 0 | `Keep remaining (2)` |
| +0.1 s | `Saving…`, greyed |
| +0.2 s to +0.4 s | **the entire content area is blank** — header bar alone |
| +0.5 s | cross-fade, the replacement sliding in |
| +0.6 s | the next group, complete |

The dominant defect is **~300 ms of blank screen**, not a reflow.
The feedback doc's "the button vanishes and the stage grows into the space" never paints, because the replace fires first.
Both fixes still land, but F6's acceptance criterion is **no blank frame between units**, which is checkable.

### 3.2 The change

`navigation.replace('Deck', …)` appears at six sites in `DeckScreen.tsx` (:195, :578, :591, :640, :649, :706).
The deck holds the current unit in state and advances internally.
The app enters the deck route once.

- A destination that leaves the deck entirely (`CullList`, a day page) still navigates. Only same-surface advances become state.
- *Keep remaining* stays mounted and disables rather than disappearing.
- The thumbnail strip, zoom overlay and pager reset deliberately on a unit change, not incidentally through unmount.

### 3.3 What this must not break

Each has an acceptance check in §10:

1. Android back still exits through Home (`backBehavior="initialRoute"`, m0.8.2 F1).
2. Browse and re-decide entry from the Timeline and DayProgress still land on the right unit.
3. A day deck (no range) still returns to its day page when finished.
4. `releaseBrowseIds` still fires on Home focus.

## 4. The goal moment

### 4.1 The hold (F4, A1, A2)

On the crossing decision, the deck holds the completed unit until `GoalCelebration`'s `onDone` fires, then advances.
Every other unit completion advances as it does now.
The overlay is unchanged: still `pointerEvents="none"`, still self-dismissing on its own timer.

The hold has **two** gates, not one.
`celebrating` covers the moment while it plays; `celebrationSettling` covers the window before it, between the write committing and its goal evaluation finishing.
Without the second the hold is unarmable in exactly the case F4 is about: the write resolves first, so the deck would advance while the crossing was still being decided.

### 4.2 Counting from the write (A3, A4)

Today `noteDecisions` has four call sites, all in the deck and Compare, and each computes its own fresh count from a local `priorState` helper.
`ReDecideSheet` and the state editor write verdicts and note nothing.

- `applyReviewDecisions` reports the day's fresh work, and `write` notes that count. Callers pass nothing and can forget nothing.
- Freshness is judged on the row's prior `decided_at`, not on its prior verdict, so the counter agrees with `getReviewedCountsByDay` exactly: one row per photo stamped that day, a clear keeps the stamp, and an earlier day's stamp does count because that row moves into today's bucket. Judging on the verdict counted a decide→clear→decide twice against a ring showing one.
- Both `priorState` helpers and the caller-side `fresh` arguments are deleted.
- Review surfaces register as celebration hosts while **mounted**; consuming stays focus-scoped. Mount-scoped because opening Compare unfocuses the deck without removing the surface that will draw the moment. With no host registered anywhere a crossing shows a toast, and the last host to leave takes any unclaimed moment with it — as the same toast.
- Compare hosts but never draws: every decision path there navigates away within a frame or two.

### 4.3 Re-celebrating a raised goal (F5, A5)

`goal_celebrated_day` stores a day string, so once today is marked no later crossing can fire.
It becomes one settings row carrying **day and goal value**, parsed with the codebase's parse-with-fallback pattern.
One row, not two: two rows can tear and leave a day marked at no value.

A crossing fires when the day differs, **or** the goal exceeds the highest value celebrated today.
Falls out of that rule without further work: lowering never re-arms, and raising to a number below today's count never fires, because `before < goal` fails.
The streak half already behaves correctly — `goalStreaks` scores every day against the current goal, so today drops out the moment the goal moves above it.

## 5. The accent pass (A6)

### 5.1 The contradiction being resolved

[STATE_MODEL.md](STATE_MODEL.md) rule 3 lists six sites that break "the accent means interaction only" and assigns them to m0.8.5.
Its per-surface table then says the goal ring and coverage bar are "unaffected" and "correctly use the accent until complete, then keep-green".
Rule 3 wins. The table's exemption is deleted.

### 5.2 The five sites

All run one pattern — accent below the goal, keep-green at it:

| Site | Where |
|---|---|
| Home goal ring | `HomeScreen.tsx:864` |
| Stats today ring | `StatsScreen.tsx:307` |
| 30-day activity bars | `StatsScreen.tsx:837` |
| Coverage markers | `StatsScreen.tsx:910` |
| Milestone fills | `StatsScreen.tsx:748` |

Home's Keeping-up bar takes the same treatment.
The precedent is four lines of comment in the same file, at `StatsScreen.tsx:794`: *"Keep-green, NOT the accent: heat is a quantity, and rule 3 reserves the user-chosen accent for…"*.
The rhythm grid was converted; these were missed.

### 5.3 The replacement

Keep-green throughout.
Completeness is carried by the geometry each site already has: the ring closes, the milestone bar fills, the coverage marker tops out, and the activity bars read against the grey goal line the card already draws.
No new token. Rule 6's strength axis stays reserved for action lifecycle.
The completion signal then reads identically under all seven accents, including Green, where accent and keep-green nearly merge (CIE76 ΔE measured 6.5–26.3 from the reserved hues).

## 6. Copy and small fixes

### 6.1 F1 — the two streaks

| Where | Now | Becomes |
|---|---|---|
| Home, Keeping-up (`HomeScreen.tsx:1079`) | `🔥 25-day clear streak` | `📅 25 days with photos fully reviewed in a row` |
| Stats coverage caption (`StatsScreen.tsx:389-394`) | `24 of 30 days fully reviewed` | `24 of 30 days with photos fully reviewed` |
| Goal streak (`HomeScreen.tsx:951`, `StatsScreen.tsx:325`) | `🔥 25-day streak` | unchanged |

### 6.2 F3 — Home during a scan

Two sites, not one. The feedback doc cites the button; the card line above it makes the same claim more strongly.

- Button (`HomeScreen.tsx:959-964`): `Scanning…`, disabled, when the queue is empty and `scan.phase === 'scanning'`. `Scan incomplete`, disabled, on `scan.phase === 'error'`.
- Card line (`HomeScreen.tsx:912-915`): `Nothing to review yet — the scan is still running.`

Both branches sit before the existing `All reviewed`, so the completeness claim survives only where earned.
F15's audit re-checks this copy in m0.8.7.

### 6.3 F17 — the deck badge names a day

The badge prints `formatClockPrecise(current.timestamp)` only (`DeckScreen.tsx:1092-1096`), verified on device as `19:40:01`.
`ReviewMemberRow` already carries `day` (`store.ts:753-769`), so no new plumbing.

**Render from `day`, never from `taken_at`.**
For an undated photo `taken_at` is the mtime fallback, and printing it would turn a soft claim into a confident lie.
The null case reads **`Unknown day`** — the phrase the Review timeline already uses for undated units.
This device's corpus holds 2 504 undated photos, so the null path is the common case, not an edge.

### 6.4 F7 — the strip follows the photo

The strip is a plain `ScrollView` with no ref and no programmatic scroll (`DeckScreen.tsx:1107`), while the pager does scroll to the cursor (:725, :742).
Scroll the strip to keep the current thumbnail visible, moving **before** it would leave the viewport.
It must not fight a manual scroll — the trap F8 fell into.
**(autonomous)** the lead distance and the manual-scroll suppression window are set during implementation and stated in the appendix.

### 6.5 F13 — Compare's chips

Compare gates its four chips on `busy` alone (`CompareScreen.tsx:706-786`); the deck gates on `busy || currentState === 'culled'` (`DeckScreen.tsx:1201-1219`).
Compare takes the deck's rule.

Measured on device: the deck is already correct, and **PhotoViewer's panel has no action chips on a staged cull** — it shows the verdict and a single `Change decision` row, so the rule does not extend there. That surface inherits it in m0.8.6 with F9.
Also measured, completed on the S10e during the closing grilling: **no path enters Compare with a staged-cull participant**.
The deck disables Compare on a culled photo in 2-shot and 12-shot groups alike, and the "Compare with…" picker in a 12-shot group with one staged cull offers only the alive members — the culled photo is excluded from the candidate list.
The fix is therefore deliberately defensive parity: two surfaces drawing identical chips answer identically, so the divergence cannot resurface when navigation changes again (it changed in this very release, and F9 adds cull paths next).

## 7. `pinchFrame` — closed out (A7)

The shipped fix is `pinchEngaged`/`pinchGain` with `PINCH_ENGAGE_DELTA = 0.15`, answering a reproduced defect (S23, 2026-08-04).
The drafted `pinchFrame` answers a different one: the pointer count changing mid-gesture.

That can happen — RNGH's `PinchGestureHandler` ends only on `ACTION_UP`, the last finger lifting, so a 2→1→2 sequence is one continuous gesture.
But its `scale` accumulates from Android's `ScaleGestureDetector`, which re-anchors its span when the pointer set changes.
So the residual may not exist at all, and it has never been reported.

No code this release.
§10 carries a human two-finger check instead — adb cannot drive multi-touch, so a negative automated result would prove nothing.
If it reproduces, the design and its five tests are one `git show f376d5a` away, and the fix then aims at a defect we have seen.

## 8. Implementation phases

Each phase lands with its tests and its doc edits, and is committed on `initial`.

| # | Phase | Contents |
|---|---|---|
| 1 | The deck holds its unit | L4 / F6. The largest change; everything else builds on it. |
| 2 | The goal moment | F4's hold, the write-sourced count, host registration, the toast fallback. |
| 3 | The raised goal | F5's day-and-value row. |
| 4 | The strip | F7. |
| 5 | Badge and chips | F17, F13. |
| 6 | Copy | F3 (both sites), F1 (both surfaces). |
| 7 | The accent | Five sites plus Home's Keeping-up bar, and STATE_MODEL's rule 3 and surface table. |

## 9. Testing strategy

Top-down, per the repo's standard: broad scenarios carry the bulk, lower tiers cover only what the higher cannot reach.

**Unit (pure logic).**
`shouldCelebrateGoal` against the day-and-value row: new day fires, higher goal fires, lower goal does not, equal goal does not, and a goal raised below today's count does not.
The strip-scroll target function, given a cursor, a viewport and a content offset.
The celebrated-row parser, including a torn or absent value.

**Component and integration.**
The write-sourced count: a verdict write over mixed prior states notes exactly the unreviewed→decided rows, and re-deciding an already-decided photo notes zero.
Host registration: arming with no host produces a toast and leaves no pending ref.

**Device (emulator `afterglow-api30`).**
F3's three button states, driven by a scan over a small corpus — the state the S10e cannot show without a wipe.
F1 and F17's copy, including `Unknown day`.

**Device (S10e).**
The §10 acceptance list.

**No test asserts that a removed interface stays unsupported.**
The `priorState` helpers and the caller-side `fresh` argument are deleted, and nothing tests their absence.

## 10. Human acceptance pass — the m0.8.5 checklist

Run against a **release** build on the S10e.

**The deck (L4/F6/F4/F7)**

1. *Keep remaining* on a group: **no blank frame** between units. This is the measured defect, not "less jank".
2. The button stays on screen and disables. It does not vanish.
3. Android back from a deck exits through Home, never into a queue tab.
4. Enter a unit from the Timeline and from DayProgress: both land on the right unit.
5. A day deck returns to its day page when finished.
6. A long singles run: the current thumbnail stays visible past the 7th photo, and a manual strip scroll is not fought.
7. **Pinch check (A7):** zoom a photo deep, then pan with two thumbs while letting fingers land and lift alternately. The zoom must hold. If it drifts, `pinchFrame` is the fix and its tests come back.

**The goal moment (F4/F5)**

8. Set the goal just above today's count, cross it in the deck **while a scan runs**: the moment plays fully, the deck holds until it ends, and "Saving…" does not hang multi-second (the settling barrier's reads sit outside user-write priority — decision of 2026-08-10, probe before wrapping).
9. Raise the goal above the new count and cross again: it celebrates again.
10. Lower the goal below today's count: nothing fires.
11. Cross the goal from a surface with no deck open: a toast appears, and no celebration fires later on the next deck.

**What the review round added**

12. Advancing to a singles run shows the outgoing photo, never a blank stage, while its rows load.
13. Finish a unit from a NON-ZERO cursor: the next unit's visible photo must match its position badge. (The pager could keep the old page while the controls pointed at the new unit's first photo.)
14. Decide a photo, undo it, decide it again: the goal ring must rise by ONE, and the celebration must not fire early.
15. Open a duel and come back: no goal toast fires on the way, and a crossing decided in the duel plays on the deck it returns to.

**Copy and colour (F1/F3/F17/F13/accent)**

12. Home during a scan with an empty queue: the button reads `Scanning…` and the card does not claim everything is reviewed.
13. The deck badge names a day, and reads `Unknown day` on an undated photo.
14. Compare's chips are greyed on a staged-cull photo.
15. The two streak sentences on Home are distinguishable at a glance.
16. Set the accent to **Green** in Settings, then look at the goal ring, the activity bars, the coverage markers and the milestone fills. Completion must still be readable — this is the case the old design could not serve.

## 11. Autonomous decisions

Judgment calls made without Tristan during the 2026-08-07 session — **all vetted and approved in the closing grilling of 2026-08-10**, so none is an open assumption.
The table stays only as the release record; `autowork.md` and `codex-review.md` are deleted.

| # | Call | Tier |
|---|---|---|
| 1 | Reproduce against the shipped 0.8.4 before installing anything | procedure |
| 2 | Do NOT wipe the S10e database to reproduce F3; use the emulator | read |
| 3 | F13's Compare gap was not reachable on any tested path — fix it as parity anyway | measured / read |
| 4 | F6's acceptance criterion becomes "no blank frame", from the measured trace | measured |
| 5 | Two groups were completed on the S10e during reproduction and not undone | measured |
| 6 | F17's null-day case reuses the timeline's existing "Unknown day" | measured |
| 7 | One `Deck` route instead of two, rather than keeping `Singles` | read |
| 8 | `UnitDestination.screen` renamed to `kind` | naming |
| 9 | The unit/param logic lives in `lib/deckUnit.ts`, not in the screen | structure |
| 10 | Hold the browse-control swap through a finish (`finishing`) | read |
| 11 | F5's marker parses the old day-only value as "nothing celebrated" | read |
| 12 | Milestone bars take the hue of what each counts | **assumed** |
| 13 | Device verification ran on the emulator, not the S10e | measured |

The codex rounds' five assumptions were vetted in the same grilling: the once-per-day count rule (and the ring keeps counting *decided today* — first-ever-only was weighed and declined), the earlier-day re-decide, the holding frame (outgoing photo under the NEW header), Compare hosting without drawing, and the advance waiting on the goal evaluation.
The last ships unwrapped by choice: the evaluation's reads do not take user-write priority, so **check 8 doubles as the stall probe** — a multi-second "Saving…" on a crossing while a scan runs means wrapping the chain in `withUserWritePriority`, a known one-line fix.
Number 12 (milestone hues, cull-red included) was approved on a screenshot from the S10e.
