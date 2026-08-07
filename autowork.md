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
