# Error surfacing across the platform boundaries: design

**Status:** decision-complete.
§6's five decisions were settled in a grilling (Tristan, 2026-08-21).
Ready to implement.
**Release:** m0.8.7 (Tristan, 2026-08-04).
Three of its four boundaries are queue screens, which is that release's subject.
See [Feedback_m0.8.x.md](Feedback_m0.8.x.md).
**Audience:** Tristan and the implementing agent.
**Deliverable:** one contract for what the app says when Android refuses, applied at every boundary where an OS refusal can be systematic rather than transient.

This doc grew out of m0.8.4, which fixed exactly one instance of the problem (`lib/organizeFailures.ts`) and left the general question open.
That fix is the worked example throughout.
Read it first. This doc mostly generalises it.

---

## 1. Overview

### The problem, stated once

The app talks to Android at several boundaries.
When Android refuses, the app currently does one of two things: it repeats a count ("3 failed"), or it passes Android's raw exception through.
Neither tells the user whether to retry, wait, or give up.
For a *systematic* refusal, a retry is an infinite loop with no exit.

m0.8.4 found the worst case on device: a photo in another app's storage failed every move forever, with a red badge and "retried on the next move" as the only feedback.
The app had Android's explanation and discarded it.

### What is already settled (m0.8.4, do not re-litigate)

m0.8.4 decided and shipped three things.
This doc builds on them and does not reopen them:

- **The three-tier shape** (§2). Proven end to end on the S10e.
- **The retry test for toast-vs-dialog** (§3). The sweep found the codebase already passes it everywhere except the case that was fixed.
- **Not persisting failure reasons.** Error rows stay queued and the next attempt regenerates the reason, so a dialog raised from the run is the whole fix.
  A `message` column would be a schema bump, hence a destructive reset (~30 min re-embed on a 27k corpus, measured).
  Ruled out unless a boundary appears where the reason genuinely cannot be regenerated (§6, D3).

### Scope

**In:** the four boundaries where an OS refusal can be systematic: trash, favourite, share dispatch, edit launch (§4).
**Out:** SQLite write failures.
There are ~6 alert sites that pass a raw DB error through, and they are *correct*: the cause is opaque, nothing changed, and a retry is the whole answer.
Classification would add a sentence and no information.
To name this out-of-scope is the point. The sweep's value was to rule them out.
**Out:** the queue-time refusal for unmovable photos (`docs/TODO.md`, "Organize accepts photos Android will never let it move").
Related, but it is a prevention feature, not an explanation contract.

---

## 2. The three-tier contract

Copied from `lib/organizeFailures.ts`, which is the reference implementation.

| Tier | Content | Source |
|---|---|---|
| 1 | A specific, actionable sentence | A cause **proven from facts we own** |
| 2 | An honest generic line | Everything else |
| 3 | The platform's own words, **verbatim and unparsed** | Always, last |

**Tier 1 never reads the platform's error text.** Exception wording is not an API.
It varies by OS version and OEM skin, so a matcher silently stops matching and the explanation degrades to nothing.
Classify from the item's own path, our own status codes, and our own verification results. (`docs/REVIEW_CLASSES.md` 45.)

**Tier 3 is what makes tiers 1-2 safe to be wrong.** Our reading sits above the ground truth, never instead of it.
A misclassification therefore costs a confusing sentence rather than a false explanation, and a tester's screenshot stays diagnosable.
Measured payoff on the S10e: the classifier diagnosed "another app's storage" from the uri, and Android independently said *"Changing ownership … not allowed"*.

**A rule that becomes wrong must go quiet, not lie.** If a future Android permits what tier 1 forbids, the operation succeeds and the copy simply stops appearing.

**Sentinels we author are fair game.** `"verification failed"` is compared by string because *we* write it in our own Kotlin.
Both sides carry a note to change together. That is the round-trip rule from `AGENTS.md`.

---

## 3. The retry test: which surface a failure gets

> **A toast is enough when retrying is the whole answer.** When it is not (retry is futile, or the state is now ambiguous), the failure needs a dialog.

m0.8.4 swept this test across the app.
All five existing failure toasts pass it (`SourcePickerScreen:246`, `ShareQueueScreen:245`, `SettingsScreen:227`, `SettingsScreen:549`, `CompareScreen:542`).
Each is "nothing changed, tap again".
The organize failure was the only violation, and it is fixed.

So this section adds **no backlog**.
It exists so the next failure surface is judged rather than defaulted, and it is now `REVIEW_CLASSES.md` 44.

---

## 4. The four boundaries

For each boundary: what Android can refuse, what facts we own at that moment, and whether a tier-1 sentence is available.
**The middle column is the design work.** Tier 1 is only as good as the facts we hold.

### 4.1 Trash (`trashMedia` → `lib/trashFlow.ts`)

Statuses today: `applied` / `cancelled` / `unsupported` / `failed` / `skipped`, with `error` on failure.

Facts we own: the photo's volume (SD vs primary), its tri-state presence, whether the user cancelled or the platform refused, and the trash-attempt lifecycle's own verification outcome.

Likely tier-1 causes: an unreachable volume (the card left mid-batch), a photo already gone, and consent declined versus never shown.
**`cancelled` is already distinguished from `failed`, which is the hard half. This boundary is closest to done.**

### 4.2 Favourite (`applyFavouriteBatch`)

`FavouriteBatchResult` carries `status`, `unverifiedIds` and an optional `error`.
It is **the richest shape of the four**.
`unverifiedIds` is a fact no other boundary has: it names exactly which photos Android would not confirm.

Today the alert prints `result.error ?? 'Android did not verify them.'`.
That is tier 3 with no tier 1, and it discards `unverifiedIds` entirely.

Likely tier 1: "N were applied; Android did not confirm M".
That is a partial-success sentence the current copy cannot express.

### 4.3 Share dispatch (`shareUris`)

Returns `dispatched` / `error` + message.
The screen shows `Alert.alert('Share failed', dispatch.message)`: pure tier 3.

Facts we own: how many URIs (single vs multiple changes the intent), whether any photo is unreachable, and whether a chooser exists at all.

Honest note: this boundary resolves at *dispatch*, never at the sheet, so most real failures are "no app handled it".
That may be the whole of tier 1 here.
**The expected outcome is tiers 2+3 only, which is compliant, not exempt** (D1): an honest generic line above the platform verbatim already improves on today's raw alert, and a tier-1 sentence appears only if implementation finds a provable cause.
One failure mode disappears before this work starts: F21's per-kind suspension ([Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md)) keeps a staged cull's share intent live, so dispatch stops silently dropping culled photos from a batch.

### 4.4 Edit launch (`modules/media-store-actions` probes + `lib/editMatrix.ts`)

**Already the most developed, and the precedent worth mining.**
The gate-0 matrix probes the environment and reports structured results rather than a guess from an error.
That is the same instinct as tier 1, built a release earlier.

Open question: does `editMatrix` become the general shape for the other three, or does it stay a diagnostic tool the user opens deliberately?
It is 125 lines and reports *capabilities*. `organizeFailures` is 175 and explains *one failed run*.
Different jobs, possibly one mechanism.

---

## 5. Generated copy

Mechanical, no design decisions. It is folded in here so it lands with the rest.

**Every generated sentence that carries a count needs its `n = 1` case asserted**, verb and pronoun, not only the noun (`REVIEW_CLASSES.md` 46).
m0.8.4 shipped "1 photo **live** in another app's own storage" to a device because the plural had a test and the singular did not.

**FIXED in m0.8.4's acceptance round.**
Listed here because the class outlives the three instances.
The sites were:

| Site | Reads at n = 1 |
|---|---|
| `SettingsScreen.tsx:217` | "review history for 1 photos kept" |
| `SettingsScreen.tsx:218` | "1 photos removed from your history" |
| `ShareQueueScreen.tsx:218` | "Clear all 1 photos from the share queue?" |

The codebase mostly gets this right already (`HomeScreen:530`, `SettingsScreen:187-188`), which is why this was three sites and not thirty.
D5 settled the consolidation question: the `plural()` helper lands via F15's app-wide copy audit (§6).

---

## 6. Decisions: settled in the 2026-08-21 grilling

| # | Decision | Settled |
|---|---|---|
| D1 | Contract scope | **Mandatory at all four boundaries; tier-1 sentences are not.** Every boundary presents failures in the three-tier shape (tier 2 + tier 3 at minimum); tier 1 appears exactly where owned facts prove a cause. A boundary shipping tiers 2+3 only — share, expectedly — is compliant, not exempt. |
| D2 | `editMatrix` vs the classifiers | **Separate mechanisms, shared shape, defined relationship.** Each boundary gets its own pure classifier in the `organizeFailures` mold; `editMatrix` stays a capability probe and doubles as the edit-launch classifier's **fact source**. A shared classifier skeleton may be proposed by the fourth classifier with evidence, not before. |
| D3 | Persisted reasons | **No.** All four boundaries pass the regeneration test (a retry re-produces the reason), so the m0.8.4 rule stands app-wide. Reopens only if a boundary appears whose reason genuinely cannot be regenerated. Post-hoc "what failed last Tuesday" diagnosis belongs to the parked field-diagnostics TODO item, not this contract. |
| D4 | Favourite partial success | **Yes**: "N were applied; Android did not confirm M" — counts only (the queue shows *which*), singular and plural asserted for **both** counts, tier 3 verbatim after, proven with a deliberately unrecognisable platform message (§8). |
| D5 | `plural()` helper | **Yes, landed by F15's copy audit** (same release), consumed here — the audit touches every count-bearing string anyway, and per-site the call is shorter than the ternary. Fallback: if the audit finds fewer than ~5 count-bearing sites, keep local ternaries and record the count as the reason. |

**D-organize is now CLOSED** (Tristan, 2026-07-31, m0.8.4 acceptance): the app keeps no allow-list of its own.
Android is the only authority on where a photo may live, and a refusal is explained in Android's own words.
A mirrored copy of the rule survives for the album PICKER only, as a convenience that can hide a legal option but never block one.
That layering (*platform is truth, validator is authority, filter is convenience*) is the shape the settled decisions adopt for the other boundaries.

---

## 7. Implementation phases

1. ~~§5's three copy fixes~~: **done** in m0.8.4's acceptance round.
2. **Favourite** (§4.2): richest facts, clearest win; D4's partial-success sentence.
3. **Trash** (§4.1): closest to done. Mostly it names causes the lifecycle already distinguishes.
4. **Share** (§4.3): expected tiers 2+3 (D1); a tier-1 sentence only if a provable cause is found in the build.
5. **Edit launch** (§4.4): a classifier over `editMatrix`'s probe facts (D2).

The `plural()` helper arrives via F15's audit (D5) before or alongside phase 2, so every sentence above consumes it.

## 8. Testing

Same tiers as `organizeFailures.test.ts`, which is the model.
The classifier is **pure**, so it takes unit tests directly, and every cause line gets **singular and plural** coverage.

Two assertions carried over as a pattern:

- Prove a tier-1 case with a **deliberately unrecognisable** platform message, so the test fails if anyone reintroduces text matching.
- Assert that tier 3 appears **after** tier 1, so the ground truth can never displace the explanation.

Device work is one walk per boundary.
Force the failure the way m0.8.4 forced the organize one (a WhatsApp photo).
No new gate steps: the UI gate deliberately avoids OS consent flows, so these stay in the plan's human acceptance pass.
