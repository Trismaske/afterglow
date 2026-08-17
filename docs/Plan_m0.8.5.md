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

Run on the S10e (0.8.5 is installed, versionCode 12).
Every check names its screen, the steps, and what pass looks like.
"Machine-checked" means a screen recording on the emulator already showed it working — confirm it by eye and feel, don't re-prove it.

Terms used below:
**the deck** = the review screen you reach from Home's green *Continue reviewing* button;
**the finish button** = the wide green *Keep remaining (N)* button at the deck's bottom;
**the Review list** = the card list behind Home's "N to review" breakdown (tap the numbers, not the green button);
**today's count / the ring** = Home's goal ring, "X of Y today".
Set the daily goal via Settings (gear, top right of Home) → DAILY GOAL → *Custom* → type a number → *Set goal*.

### The deck (L4 / F6 / F7)

1. **No blank frame between units** *(machine-checked)*.
   In the deck, press the finish button and watch the transition to the next unit.
   Pass: the header, photo area, thumbnail strip and buttons all stay on screen; only their contents swap.
   Fail: any flash of empty dark screen — 0.8.4 showed ~300 ms of it.
2. **The finish button never vanishes.**
   While its write runs it stays in place, greys, and reads *Saving…*; the buttons around it must not reflow.
3. **A cross-kind advance never blanks the stage.**
   Finish a unit whose successor is the other kind (a group followed by singles, or the reverse — the Review list shows the order).
   Pass: during the advance the *outgoing* photo may linger under the already-updated header for a beat; the stage is never empty.
4. **The photo and the position badge agree after an advance.**
   Finish a unit while NOT standing on its first photo (swipe forward a few, then press the finish button).
   In the next unit, swipe forward once and back once.
   Pass: the "x/N" badge (top right of the photo) and the visible photo move together.
   This guards the review finding where the pager could keep the old unit's page while the buttons targeted the new unit's first photo.
5. **Android back exits through Home.**
   From any deck, press the system back button.
   Pass: you land on Home — never on an Edit/Favourite/Organize/Share tab.
6. **Opening a specific unit opens THAT unit.**
   In the Review list, pick a card mid-list and tap it; compare the deck's header line and time badge with the card you tapped.
   Repeat from a day page: Home → a day row → a group under "Groups this day".
7. **A day deck returns to its day page.**
   Home → a day row → the day page's own review CTA → finish the deck.
   Pass: you are back on the day page, not on the timeline or Home.
8. **The thumbnail strip follows you (F7).**
   Open a singles run of 10+ photos (the Review list names sizes) and decide or swipe forward past the 7th photo.
   Pass: the highlighted thumbnail is always visible, moving before it would slide off-screen.
   Then hand-scroll the strip somewhere else and swipe the big photo once.
   Pass: your strip position is left alone unless the current thumbnail had left the view (the F8 histogram trap, not repeated).
9. **Pinch across finger changes (A7 — the `pinchFrame` decision).**
   Zoom a photo deep, then pan with both thumbs while letting fingers land and lift alternately.
   Pass: the zoom level holds.
   Fail: the photo creeps out of zoom — then `pinchFrame` is the fix, and its five tests come back from git history (`f376d5a`).

### The goal moment (F4 / F5)

10. **The crossing holds the deck** *(machine-checked; do it on device while the scan runs — this doubles as the stall probe)*.
    Set the goal to today's count + 1, then decide one more photo in a deck.
    Pass: vibration, the edge glow, and the ring overlay play out fully (~1.7 s) over the photo you just finished; only then does the deck advance.
    Also watch the write: *Saving…* must not hang for seconds while the scan runs — if it does, say so; the fix is known and one line (the barrier's reads move under user-write priority).
11. **A raised goal celebrates again (F5)** *(machine-checked)*.
    Right after check 10, raise the goal to count + 1 again and cross it.
    Pass: a second full moment.
12. **A lowered goal does not.**
    Set the goal below today's count.
    Pass: nothing fires — no overlay, no toast, and the ring simply shows itself full.
13. **A crossing with no deck open becomes a toast.**
    Set the goal to today's count + 1.
    Home → the Cull list card → tap any staged photo → change its decision to Keep (this counts as today's work when the cull was staged on an earlier day — all 8 on this device were).
    Pass: a toast, "Daily goal reached — N today", and NO overlay fires later when you next open a deck.
14. **A crossing decided in a duel plays on the deck it returns to.**
    Set the goal to today's count + 1.
    In a deck, open *Compare with…*, pick a photo, and decide the duel so a verdict is written (the "N is better" dialog's Keep both or Cull).
    Pass: Compare closes as always, and the moment plays on the deck you land back on — Compare itself never draws it, and no stray toast fires just from opening or closing the duel.
    This is the one goal path never machine-checked, so it earns a real look.
15. **Undo does not double-count.**
    Note the ring. In a deck: Keep a photo, tap Keep again (undo), Keep once more.
    Pass: back on Home, the ring rose by exactly 1.

### Copy and colour (F1 / F3 / F17 / accent)

16. **The deck badge names the day (F17).**
    Any deck: the badge top-left of the photo reads like "06 Jun 2026 · 12:42:28".
    Open a card the Review list titles *Unknown day* (this corpus has ~2,500 undated photos).
    Pass: the badge reads "Unknown day · HH:MM:SS" — never a confident date invented from file times.
17. **The two streak lines read differently (F1).**
    Home: the goal card says "🔥 N-day streak"; the Keeping up card says "📅 N days with photos fully reviewed in a row" (needs the coverage goal on and a nonzero streak — it may be absent right now, in which case check the wording on Stats → Activity's caption instead: "N of M days with photos fully reviewed").
    Pass: you can tell at a glance which is effort and which is coverage.
18. **Home never claims "All reviewed" mid-scan (F3).**
    Only visible with an EMPTY queue while a scan runs, which this corpus cannot show without a data reset — check it if you happen to reinstall fresh; otherwise skip (the states are: button *Scanning…* / *Scan incomplete* on a failed scan, card line "Nothing to review yet — the scan is still running / did not finish").
19. **A staged cull's chips grey in the deck (F13).**
    Cull a photo, swipe back to it.
    Pass: Edit / Favourite / Organize / Share are greyed; Keep and Cull stay live (the undo).
    Compare's copy of this rule is deliberately unreachable — the picker refuses culled members (measured 2026-08-10) — so there is nothing to check there.
20. **The Green accent no longer hides completion (A6).**
    Settings → ACCENT → *Green*, then look at Home's ring, and Stats → Activity's bars and coverage blocks, and Habits' milestone bars.
    Pass: everything progress-shaped is keep-green with completion readable from geometry (a closed ring, a full bar, a bar over the grey goal line) — nothing depends on telling two greens apart.
    Set the accent back to your preference afterwards; check the ring and bars still look right under it too.

## 11. Autonomous decisions

Judgment calls made without Tristan — **none is an open assumption**: 1–13 were vetted in the closing grilling of 2026-08-10, and 14–28 in the device-pass rounds and the second closing grilling of 2026-08-17 (each device-pass entry was individually approved by the check it shipped under; the grilling settled the rest, zero rejections).
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
| 14 | Check 9's fail landed `pinchFrame` (the m0.8.4 drafted design), with two deviations from its recovered tests: the engaging frame re-anchors (keeping the shipped no-jump rule the drafted tests contradicted), and the fix went to all three pinch surfaces (deck, viewer, Compare) — same wiring, same defect | read |
| 15 | Check 13's cause: `redecideDecided` was the one verdict path that swallowed its `ReviewDecisionResult`, so cull-list/browse re-decides never credited the goal. `applyRedecision` now returns the same contract under the vetted once-per-day rule: a later-day rescue counts 1, a same-day one 0 | read |
| 16 | Check 19's chip look is a separate `dimmed` prop (staged cull only), not a look on `disabled` — the disabled expression includes the transient write lock, and tying the look to it would dim every chip on every write (the S23 "fading for a write it had nothing to do with" defect). The deck's Best control takes the same look, same rule | read |
| 17 | Checks 1/3/10 (one cause): the deck renders a FROZEN view of the previous unit while the next unit's rows load — header, strip and controls stay mounted with controls inert, and a decode underlay (always mounted, opacity-toggled, dropped on the PAGE's own paint) covers image-decode latency. During the gap the in-screen header stays the OUTGOING unit's under the incoming nav title (Q6 vetted only the nav title — the old holding frame had no in-screen header at all). Emulator-verified frame by frame: no blank, no chrome drop, celebration playable over the completed unit | measured |
| 18 | Check 2: the finish button says "Saving…" only once the write has run 400 ms — a fast finish keeps one label, a genuinely slow write still says what is happening. The instant disable stays | read |
| 19 | Check 8: the strip highlight and follow-scroll ride a display-only live pager index (updates at the page crossing); `cursor` stays the single source of truth for everything that acts | read |
| 20 | The UI gate gained the measured finish-advance probe (screenrecord → raw-RGB frame analysis): stage never blank, control band never loses its keep-green, thresholds calibrated on emulator clips; an unmeasurable probe (shallow corpus, no ffmpeg) fails loud instead of skipping | measured |
| 21 | Check 8 round 2: a decide-advance's animated scroll suppresses the live highlight (the animation's intermediate offsets round back to the OLD page first — the flip-flop); a finger interrupting the animation re-enables it | read |
| 22 | Check 9 round 3: pan release keeps the flick's momentum via Reanimated's own `withDecay`, clamped to the existing pan bounds, on all three zoom surfaces — the "moves with momentum" gallery feel with no new dependency. react-native-zoom-toolkit (the obvious library) was assessed and rejected for m0.8.5: it wraps content in the host `GestureDetector` (kills the pager + overlay pointerEvents) and uses `runOnJS` gesture callbacks (the documented SIGSEGV class); porting its touch-position pinch math into our worklets is the m0.8.6 path if the feel still falls short | read |
| 23 | Check 9 round 5: engagement now belongs to ONE CONTIGUOUS two-finger stretch — a finger change ends it and the next stretch re-proves the threshold. With engagement persisting, a walk's two-finger overlap windows still zoomed (their span genuinely changes while the hand travels; span alone cannot tell that overlap from a pinch). Cost: resuming a pinch after a finger change needs a fresh 15% movement | read |
| 24 | Round 5's decay regression: the two-finger pan runs simultaneous with the pinch, so a pinch release inherited the pan's velocity and flung the photo. A touch stream that actually changed the zoom never decays (`pinchZoomed`, cleared per stream), all three surfaces | read |
| 25 | Codex cycle (3 rounds, 14 findings, all fixed): the edited-copy "Cull original" prompt now CREDITS the daily goal — its staging stamps `decided_at` like every verdict, so `prepareTrashBatch` counts fresh work and Home routes it through `noteDecisions`, exported from the provider solely for this one out-of-provider surface | read |
| 26 | The frozen deck is fully inert: its pager is scroll-locked during the load gap (a frozen swipe could desync the native offset from the cursor — controls acting on a photo not on screen), and the hold now lasts until the successor's first-pending cursor is applied | measured |
| 27 | Two review findings parked with evidence instead of fixed in-release (docs/TODO.md 8–9): goal notes lost to process death (ring durable, miss self-heals at the day boundary), and the midnight two-`Date.now()` skew (sub-second window, bounded by the note chain's own day guard) | read |
| 28 | The grilling's reopened item, fixed inside it (Tristan's rule: a new unit opens on its first pending photo REGARDLESS of last-minute swipes): the pager FlatList is keyed per unit (native offsets/momentum die with the list), each fresh list is born scroll-disabled for a 400 ms settle window (derived at the swap render, so there is no arming gap), scroll events arriving during the settle are dropped as stale deliveries from the dying list (caught by screenshot: highlight one photo ahead of the badge), and the settle's end re-asserts position once. Ten-tap walks on the S10e before and after pin the fix | measured |

The codex rounds' five assumptions were vetted in the same grilling: the once-per-day count rule (and the ring keeps counting *decided today* — first-ever-only was weighed and declined), the earlier-day re-decide, the holding frame (outgoing photo under the NEW header), Compare hosting without drawing, and the advance waiting on the goal evaluation.
The last ships unwrapped by choice: the evaluation's reads do not take user-write priority, so **check 8 doubles as the stall probe** — a multi-second "Saving…" on a crossing while a scan runs means wrapping the chain in `withUserWritePriority`, a known one-line fix.
Number 12 (milestone hues, cull-red included) was approved on a screenshot from the S10e.
