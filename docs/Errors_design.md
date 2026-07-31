# Error surfacing across the platform boundaries — design

**Status:** DRAFT, not decision-complete. §6 lists the open decisions; none has been put to Tristan yet, and the doc should not be implemented before they are settled.
**Audience:** Tristan and the implementing agent.
**Deliverable:** one contract for what the app says when Android refuses, applied at every boundary where an OS refusal can be systematic rather than transient.

Grew out of m0.8.4, which fixed exactly one instance of the problem (`lib/organizeFailures.ts`) and left the general question open. That fix is the worked example throughout — read it first; this doc mostly generalises it.

---

## 1. Overview

### The problem, stated once

The app talks to Android at several boundaries. When Android refuses, the app currently does one of two things: repeats a count ("3 failed"), or passes Android's raw exception through. Neither tells the user whether to retry, wait, or give up — and for a *systematic* refusal, retrying is an infinite loop with no exit.

m0.8.4 found the worst case on device: a photo in another app's storage failed every move forever, with a red badge and "retried on the next move" as the only feedback. The app had Android's explanation and discarded it.

### What is already settled (m0.8.4, do not re-litigate)

Three things were decided and shipped, and this doc builds on them rather than reopening them:

- **The three-tier shape** (§2) — proven end to end on the S10e.
- **The retry test for toast-vs-dialog** (§3) — swept, and the codebase already passes it everywhere except the case that was fixed.
- **Not persisting failure reasons.** Error rows stay queued and the next attempt regenerates the reason, so a dialog raised from the run is the whole fix. A `message` column would be a schema bump, hence a destructive reset (~30 min re-embed on a 27k corpus, measured). Ruled out unless a boundary appears where the reason genuinely cannot be regenerated (§6, D3).

### Scope

**In:** the four boundaries where an OS refusal can be systematic — trash, favourite, share dispatch, edit launch (§4).
**Out:** SQLite write failures. There are ~6 alert sites passing a raw DB error through, and they are *correct*: the cause is opaque, nothing changed, retry is the whole answer. Classification would add a sentence and no information. Naming this out-of-scope is the point — the sweep's value was ruling them out.
**Out:** the queue-time refusal for unmovable photos (`docs/TODO.md`, "Organize accepts photos Android will never let it move"). Related, but it is a prevention feature, not an explanation contract.

---

## 2. The three-tier contract

Copied from `lib/organizeFailures.ts`, which is the reference implementation.

| Tier | Content | Source |
|---|---|---|
| 1 | A specific, actionable sentence | A cause **proven from facts we own** |
| 2 | An honest generic line | Everything else |
| 3 | The platform's own words, **verbatim and unparsed** | Always, last |

**Tier 1 never reads the platform's error text.** Exception wording is not an API — it varies by OS version and OEM skin, so a matcher silently stops matching and the explanation degrades to nothing. Classify from the item's own path, our own status codes, our own verification results. (`docs/REVIEW_CLASSES.md` 45.)

**Tier 3 is what makes tiers 1-2 safe to be wrong.** Our reading sits above the ground truth, never instead of it, so a misclassification costs a confusing sentence rather than a false explanation — and a tester's screenshot stays diagnosable. Measured payoff on the S10e: the classifier diagnosed "another app's storage" from the uri, and Android independently said *"Changing ownership … not allowed"*.

**A rule that becomes wrong must go quiet, not lie.** If a future Android permits what tier 1 forbids, the operation succeeds and the copy simply stops appearing.

**Sentinels we author are fair game.** `"verification failed"` is compared by string because *we* write it in our own Kotlin. Both sides carry a note to change together — the round-trip rule from `AGENTS.md`.

---

## 3. The retry test — which surface a failure gets

> **A toast is enough when retrying is the whole answer.** When it isn't — retry is futile, or the state is now ambiguous — it needs a dialog.

Swept across the app in m0.8.4. All five existing failure toasts pass it (`SourcePickerScreen:246`, `ShareQueueScreen:245`, `SettingsScreen:227`, `SettingsScreen:549`, `CompareScreen:542`) — each is "nothing changed, tap again". The organize failure was the only violation, and it is fixed.

So this section adds **no backlog**. It exists so the next failure surface is judged rather than defaulted, and it is now `REVIEW_CLASSES.md` 44.

---

## 4. The four boundaries

For each: what Android can refuse, what facts we own at that moment, and whether a tier-1 sentence is available. **The middle column is the design work** — tier 1 is only as good as the facts we hold.

### 4.1 Trash (`trashMedia` → `lib/trashFlow.ts`)

Statuses today: `applied` / `cancelled` / `unsupported` / `failed` / `skipped`, with `error` on failure.

Facts we own: the photo's volume (SD vs primary), its tri-state presence, whether the user cancelled versus the platform refusing, and the trash-attempt lifecycle's own verification outcome.

Likely tier-1 causes: an unreachable volume (the card left mid-batch); a photo already gone; consent declined versus never shown. **`cancelled` is already distinguished from `failed`, which is the hard half — this boundary is closest to done.**

### 4.2 Favourite (`applyFavouriteBatch`)

`FavouriteBatchResult` carries `status`, `unverifiedIds` and an optional `error` — **the richest shape of the four**, and `unverifiedIds` is a fact no other boundary has: it names exactly which photos Android would not confirm.

Today the alert prints `result.error ?? 'Android did not verify them.'` — tier 3 with no tier 1, and it discards `unverifiedIds` entirely.

Likely tier 1: "N were applied; Android did not confirm M" — a partial-success sentence the current copy cannot express.

### 4.3 Share dispatch (`shareUris`)

Returns `dispatched` / `error` + message; the screen shows `Alert.alert('Share failed', dispatch.message)` — pure tier 3.

Facts we own: how many URIs (single vs multiple changes the intent), whether any photo is unreachable, whether a chooser exists at all.

Honest note: this boundary resolves at *dispatch*, never at the sheet, so most real failures are "no app handled it" — which may be the whole of tier 1 here. **Possibly the boundary where tier 2 is the right answer**, and saying so is a result.

### 4.4 Edit launch (`modules/media-store-actions` probes + `lib/editMatrix.ts`)

**Already the most developed, and the precedent worth mining.** The gate-0 matrix probes the environment and reports structured results rather than guessing from an error — the same instinct as tier 1, built a release earlier.

Open question: whether `editMatrix` becomes the general shape for the other three, or stays a diagnostic tool the user opens deliberately. It is 125 lines and reports *capabilities*; `organizeFailures` is 175 and explains *one failed run*. Different jobs, possibly one mechanism.

---

## 5. Generated copy

Mechanical, no design decisions, folded in here so it lands with the rest.

**Every generated sentence carrying a count needs its `n = 1` case asserted** — verb and pronoun, not only the noun (`REVIEW_CLASSES.md` 46). m0.8.4 shipped "1 photo **live** in another app's own storage" to a device because the plural had a test and the singular did not.

Three unguarded sites found by the sweep, all reachable with a count of 1:

| Site | Reads at n = 1 |
|---|---|
| `SettingsScreen.tsx:217` | "review history for 1 photos kept" |
| `SettingsScreen.tsx:218` | "1 photos removed from your history" |
| `ShareQueueScreen.tsx:218` | "Clear all 1 photos from the share queue?" |

The codebase mostly gets this right already (`HomeScreen:530`, `SettingsScreen:187-188`), so this is a fix-and-pin, not a redesign. Worth considering a shared `plural()` helper rather than three local ternaries — but only if it reduces net code (`AGENTS.md`).

---

## 6. Open decisions — for a grilling, in this order

Each blocks the one after it.

| # | Decision | Why it is open |
|---|---|---|
| D1 | Is the three-tier contract **mandatory** at all four boundaries, or applied where it earns its place? | §4.3 suggests share may have no real tier 1. A contract with an exception is honest; one applied uniformly is easier to review. |
| D2 | Does `editMatrix` generalise, or do the two mechanisms stay separate? | They answer different questions (capabilities vs one failed run). Merging may be an abstraction that grows total code. |
| D3 | Does any boundary need a **persisted** reason? | m0.8.4 ruled it out for organize because the retry regenerates it. If a boundary exists where it does not, that reopens the schema question — and its cost is a destructive reset. |
| D4 | Does the favourite boundary get partial-success copy? | `unverifiedIds` supports it and nothing else in the app expresses partial success. That is new behaviour, not a copy fix. |
| D5 | Shared `plural()` helper, or local ternaries? | Three sites is under the threshold where an abstraction pays. |

**Nothing here is an autonomous call.** Every row above is a genuine fork, which is why this doc stops at the table.

---

## 7. Implementation phases (provisional, pending §6)

1. **§5's three copy fixes** plus their singular tests — independent of every decision above, and the only part that could land alone.
2. **Favourite** (§4.2) — richest facts, clearest win, and D4 is the only decision it needs.
3. **Trash** (§4.1) — closest to done; mostly naming causes the lifecycle already distinguishes.
4. **Share** (§4.3) — last, because D1 may conclude it needs nothing.

Edit launch (§4.4) is deliberately unscheduled: it depends entirely on D2.

## 8. Testing

Same tiers as `organizeFailures.test.ts`, which is the model: the classifier is **pure**, so it takes unit tests directly, and every cause line gets **singular and plural** coverage.

Two assertions carried over as a pattern:

- A tier-1 case must be proven with a **deliberately unrecognisable** platform message, so the test fails if anyone reintroduces text matching.
- Tier 3 must be asserted to appear **after** tier 1, so the ground truth can never displace the explanation.

Device work is one walk per boundary, forcing the failure the way m0.8.4 forced the organize one (a WhatsApp photo). No new gate steps: the UI gate deliberately avoids OS consent flows, so these stay in the plan's human acceptance pass.
