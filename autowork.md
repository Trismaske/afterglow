# Auto-work log — m0.8.5 (the review loop)

Session opened 2026-08-07.
Every judgment call made without Tristan present, numbered as it happened.
Each entry: context, options, research, evidence tier, the choice and why.

The seven decisions settled in the pre-session grilling are NOT here — they are human-approved and live in `docs/Plan_m0.8.5.md`.
This file holds only what was decided in his absence, and it is deleted once every entry is vetted.

Device: S10e `RF8M72Q4FGE`, wireless adb, Afterglow 0.8.4 (the build the F1–F20 round was reported against).
Its corpus at session start: 8 998 photos, 8 950 to review, 1 620 groups, 2 772 singles, 8 staged culls, 45 kept, goal 7/50 today.

## Decisions

### 1 · Reproduce against 0.8.4 before installing anything

**Context.** The feedback doc's own rule (lines 10-11) says an item whose cause is only **read** must be reproduced before its fix is written.
**Options.** Reproduce on the shipped 0.8.4 already on the phone; or build m0.8.5 first and reproduce against a dev build.
**Chosen.** Reproduce on 0.8.4 first, before any install.
**Why.** A symptom observed on a build that is not the reported one proves nothing about the report. This also preserves the option of a clean before/after comparison for the device pass.
**Tier:** procedure, not a claim.

### 2 · Do NOT wipe the S10e database to reproduce F3

**Context.** F3 ("All reviewed" during a scan) needs an empty queue while a scan runs. On this phone that state only exists after `pm clear`.
**Options.** Wipe the app data and watch a fresh scan; or reproduce on the `afterglow-api30` emulator with a small corpus; or trust the code.
**Research.** The predicate is unambiguous and single-sourced: `queueTotal === 0` alone drives both the button and its label (`HomeScreen.tsx:959-964`). A scan filling the queue in bursts is enough to explain the reported randomness.
**Chosen.** No wipe. Reproduce on the emulator during the verification pass.
**Why.** The S10e's 8 998-photo corpus with real groups, undated photos and staged culls is the most valuable test fixture we have, and it is the one Tristan does his hands-on pass against. Destroying it to confirm a one-line predicate is a bad trade. Memory says test devices are disposable, which makes this permitted — it does not make it wise.
**Tier:** cause is **read** and unambiguous; symptom will be **measured** on the emulator.

### 3 · F13's Compare gap is real in code but was not reachable on device — fix it anyway, as parity

**Context.** F13 says Edit/Favourite/Organize/Share stay live on a photo staged for cull. The doc asks which surface the report came from, and whether PhotoViewer's panel shares the defect.
**Research (all measured on the S10e, 0.8.4, read from the uiautomator `enabled` attribute):**

- The **deck** is correct. On a staged-cull photo all four chips report `enabled="false"`, and so does Compare. Keep and Cull stay enabled, which is what makes the verdict undoable.
- **PhotoViewer's panel has no action chips at all** on a staged cull — it shows the verdict `Staged cull` and a single `Change decision` row. So there is nothing there to gate, and F13's rule does not extend to it. (That surface grows chips in m0.8.6's F9, which is when it inherits the rule.)
- **Compare could not be entered with a staged-cull participant** along any path tested: the deck disables the Compare chip on a culled photo, and in a two-shot group a staged cull leaves one alive member, which disables Compare entirely (`enabled="false"`, measured). Compare's own cull paths call `navigation.goBack()` immediately (`CompareScreen.tsx:440,465,493`), so a cull made inside Compare cannot be observed there either.
- Not tested: the "Compare with…" picker in a group of 3+ members, where two alive members remain after a cull. That is the one route that could still offer a culled member.

**Options.** Drop F13 as unreproducible; fix Compare defensively; or hunt the 3+ member path first.
**Chosen.** Fix Compare to the deck's rule (`busy || currentState === 'culled'`), and record the unreached path rather than claim it does not exist.
**Why.** The divergence is real in the code (`CompareScreen.tsx:706-786` gates on `busy` alone), the fix is a one-line parity change, and two surfaces that must behave alike currently do not. Leaving a known divergence because today's navigation happens to hide it is how a defect returns the moment navigation changes — and L4 changes navigation in this very release.
**Tier:** **measured** for the deck and PhotoViewer; **read** for Compare's divergence; the unreachability is **measured over the paths tested only**, which is weaker than "unreachable".

### 4 · F6 reproduced, and the measured symptom refines the doc's first cause

**Context.** F6 blames two causes: a conditionally-rendered button, and `navigation.replace` per unit.
**Research.** Screen recording of *Keep remaining* on a two-shot group (S10e, 0.8.4, 6 s at 8 Mbit, sampled at 10 fps — `scratchpad/f6b.mp4`). The measured sequence:

1. t≈0 — the button reads `Keep remaining (2)`.
2. t≈+0.1 s — it becomes **`Saving…`, greyed**. A disabled state already exists for the in-flight write.
3. t≈+0.2 s to +0.4 s — **the entire content area goes blank**, header bar alone surviving. This is the unmount.
4. t≈+0.5 s — a cross-fade as the replacement screen slides in.
5. t≈+0.6 s — the next group renders complete.

**Finding.** The dominant visible defect is **~300 ms of blank screen**, not a subtle reflow. The doc's "the button vanishes and the stage grows into the space" is not what a user sees, because the `navigation.replace` fires before that layout ever paints — the button's own transition is already `Saving…`.
**Chosen.** Keep both fixes (L4 plus a stays-mounted disabled button), but state in the plan that the acceptance check for F6 is **no blank frame between units**, which is the measurable thing.
**Why.** A fix aimed at the reflow alone would leave the blank frame; an acceptance criterion phrased as "less jank" is not checkable. "No blank frame" is.
**Tier:** **measured**.

### 5 · Device state changed during reproduction, and what was restored

**Context.** Reproduction required writing real verdicts to Tristan's test corpus.
**What happened.** Two staged culls were made and both were **undone** (verified: the singles run returned to `0 of 3 reviewed`, the group to `0 of 2 reviewed`, staged-cull count back to 8). Two groups were then **completed with *Keep remaining*** while recording F6 — four photos moved from `unreviewed` to `kept`, and those are **not** undone: the units left the pending timeline, and chasing them would cost more than it is worth on a disposable corpus.
**Chosen.** Leave the four kept photos; log it rather than quietly absorb it.
**Why.** Memory records both phones as disposable test data until v1, so the write is permitted. But a corpus that silently drifts under a tester is how a later "wait, I didn't review that" becomes a bug hunt. Group count went 1 620 → 1 618.
**Tier:** **measured**.

### 6 · F17 gets its null-day wording from the timeline, not a new phrase

**Context.** F17 needs the deck badge to print a day and to say something honest when `day` is null.
**Research.** The Review timeline already renders undated units as `Singles · 3 photos · Unknown day` and `Group · 2 shots · Unknown day 19:06` (measured on device). The deck badge today prints time only — `19:40:01` — which is F17 reproduced.
**Chosen.** Reuse **`Unknown day`** verbatim for the deck badge's null case.
**Why.** The phrase is already in the product for exactly this fact, so a second wording would be a second vocabulary for one thing. This device's corpus has 2 504 undated photos, so the null path is the common case here, not an edge case.
**Tier:** **measured**.

### 7 · One `Deck` route instead of two, rather than keeping `Singles`

**Context.** L4 makes the unit state. The route then names only the unit the deck OPENED on, and the two routes (`Deck`, `Singles`) can no longer express a cross-kind advance.
**Research.** A concrete defect, not a tidiness argument: `navigation.navigate('Deck', {groupId})` to a route already on the stack pops back to it and merges params. With the deck advanced internally to another unit, re-entering on the unit the route was opened on is a no-op param change — so the deck would stay where it had advanced to, and tapping a group on the Timeline would open the wrong one.
**Options.** (a) Keep both routes and accept param drift on cross-kind advances. (b) One route with a flat param shape, kept in step by `setParams` on every advance.
**Chosen.** (b). Params are `{groupId?, day?, from?, to?}`, read through one function.
**Why.** (a) leaves a known-wrong route state and cannot express half the advances at all. Pre-v1 policy allows breaking route changes, we own all four call sites, and AGENTS.md says migrate everything once with no shims. The header title was per-route, so the screen now sets it per unit — which also fixes a title that would otherwise have gone stale on every advance.
**Tier:** the re-entry defect is **read** from React Navigation's documented `navigate` semantics, not reproduced on device. §10's check 4 exercises it.

### 8 · `UnitDestination.screen` renamed to `kind`

**Context.** The field's values were `'Deck' | 'Singles' | 'CullList'` — route names. After decision 7, `Singles` is not a route.
**Chosen.** Rename to `kind: 'group' | 'run' | 'cullList'`, matching `UnitRef`'s existing vocabulary. Six test assertions updated with it.
**Why.** A field naming a screen that does not exist sends the next reader looking for it. AGENTS.md: sweep for everything a removed subsystem was the sole setter of, and name things for a reader without the author's context.
**Tier:** naming.

### 9 · The unit/param logic lives in `lib/deckUnit.ts`, not in the screen

**Context.** L4 introduced a unit type, an identity key, and a two-direction param mapping. They started inside `DeckScreen.tsx`.
**Chosen.** Moved to `src/lib/deckUnit.ts` with 15 tests.
**Why.** The repo's rule is to split pure logic from impure bindings, and the round-trip rule wants both directions tested together — which a screen full of React Native imports cannot be. The tests pin the two traps the design has: a run must not share an identity key with the whole day it sits in, and `paramsForUnit` must spell out `undefined` for the other kind's fields, because `setParams` merges.
**Tier:** structure; the traps are **read** and now test-pinned.

### 10 · Hold the browse-control swap through a finish (`finishing`)

**Context.** Completing a unit flips `browse`, which swaps the whole live control block for the browse one. Before L4 nobody saw it — the `navigation.replace` had already blanked the screen.
**Research.** `useEffect` runs after paint, so with the advance now a state update in an effect, the completed-unit render WOULD paint for one frame before the advance lands.
**Options.** Accept the frame; freeze on `busyOwner === 'finish'` alone (too short — it clears when the write resolves, before the advance); or hold from the start of the finish until the unit actually changes.
**Chosen.** The third. `finishing` is set when a finish write starts and cleared by the unit change it causes — or, if the write left the unit incomplete after all (a scan adding rows mid-write), by the deck settling back out of browse.
**Why.** The reported symptom is "the layout reflows", and this is the reflow. The second clearing rule is what stops a finish that does not advance from stranding the deck on live controls.
**Tier:** **read**; §10's check 2 is the device confirmation.

### 11 · F5's celebrated marker parses the old day-only value as "nothing celebrated"

**Context.** `goal_celebrated_day` changes shape from `2026-08-07` to `2026-08-07:50`.
**Options.** Migrate the old value (treat a bare day as celebrated at the current goal); or parse-with-fallback to null.
**Chosen.** Fallback to null — nothing celebrated.
**Why.** The cost is exactly one extra moment, on upgrade day only, for a user who had already crossed their goal that day. The alternative silently swallows a goal the user did reach, which is the worse lie in a feature whose whole point is acknowledgement. Pre-v1 policy carries no back-compat constraint, so a migration would be code earned by nothing. The parse test documents the old shape by name.
**Tier:** **read**.

### 12 · Milestone bars take the hue of what each counts, rather than one shared colour

**Context.** The accent pass had to give the three Stats milestone bars (photos reviewed, culled, edits completed) a non-accent colour.
**Options.** One shared hue (near-white, rule 3's "no hue of its own" fallback); or per-bar hues from the reserved palette.
**Chosen.** Per-bar: keep-green, cull-red, edit-blue.
**Why.** Rule 3 says a series takes the hue of what it counts, and these are three separate bars with three subjects rather than one series. Near-white would have been defensible only if the family were heterogeneous in a way the palette cannot name — it is not; each subject has a reserved hue already. The reservation I set aside: a cull-red progress bar could read as alarm rather than as "cull", and that is a judgment about taste, not about the rule. Worth a look during the device pass.
**Tier:** **assumed** (visual judgment, unverified on a screen).

### 13 · Device verification ran on the emulator, not the S10e

**Context.** L4 and F17 needed a real run. Tristan was asked, but not answered, whether m0.8.5 builds may replace 0.8.4 on the S10e.
**Chosen.** Install and verify on the `afterglow-api30` emulator only; leave the S10e on 0.8.4.
**Why.** The question touches his device rather than the repo, so it stays his. The emulator answers the structural questions (does the advance stay in place, does the badge render a day, does the merged route keep a per-unit title); it cannot answer the feel questions, and those are on the acceptance list for him anyway.
**Result (measured, release build of the pre-review-fix tree):** a run-to-run advance keeps the header, badge, control rows and finish button on screen throughout — no blank frame, against 0.8.4's ~300 ms of black. The badge reads `Jul 16, 2026 · 09:05:00`. The header title still switches per unit after the route merge.
**Tier:** **measured** for those three; the rest of §10 stays human.

### 14 · The goal crossing was verified on the emulator, by moving the goal rather than reviewing 50 photos

**Context.** The celebration hand-off was rewritten twice during the codex rounds, both times against reasoning about React's effect ordering, and had never been seen running. It was the session's largest unverified risk.
**Options.** Leave it to Tristan's device pass; seed enough photos to reach a goal of 50; or move the goal to meet the count.
**Chosen.** Move the goal. Set it to 2 (today's count was already 2, so the ring read "Daily goal reached" and correctly refused to fire — sailing past is not a moment), then raise it to 3 and keep one more photo.
**Why.** It exercises F5's re-arm and F4's hold in ONE crossing, and it is the only way to reach a crossing on a corpus of eight photos.
**Result (measured):** the ring dropped its reached state when the goal rose above the count; the crossing fired at 3; the moment played over the COMPLETED unit with its header, badge and 3/3 position intact; the next group appeared only after the overlay faded.
**Tier:** **measured**. Acceptance checks 8 and 9 are answered; 10 (lowering the goal) and 11 (a crossing with no review surface open) are not.
