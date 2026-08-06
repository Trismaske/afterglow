# Photo state model & visual language

**Status:** shipped in m0.8.2; reachability scoping added in m0.8.3 (schema v20). This is the contract, not a proposal — the code implements it and the tests hold it there.
**Audience:** anyone adding a surface that shows what has happened to a photo.
**Why it exists:** three unrelated ideas were being drawn in one visual vocabulary, so "in a group" (a scan fact) was painted like a decision and counted as progress. This document is the single answer, so it never has to be re-derived.

## The three layers

A photo carries exactly one **verdict**, any number of **actions**, and any number of **annotations**.
Conflating them is the mistake this model exists to prevent.

### 1. Verdict — one per photo, mutually exclusive

The answer to "have you decided about this photo, and what did you decide?"

| Verdict | `photos.state` | Meaning | Permanent? |
|---|---|---|---|
| unreviewed | `unreviewed` | No decision yet | — |
| kept | `kept` | You are keeping it | yes |
| staged cull | `culled` | Decided to delete, not yet executed | resolves to trashed |
| trashed | `trashed` | Sent to the system trash | yes (restorable by the OS) |

**Reviewed = has a verdict** = kept, staged cull, or trashed.
Every "X of Y reviewed" number in the app means exactly this.

**Vocabulary: "keep" is the verb, "kept" is the state.**
There is no separate "done".
Pre-m0.8 there was a distinct `kept` state that later became `done`; m0.8.2 renames it back to `kept` so the button and the stored value finally use the same word.

**`to_edit` is not a verdict.**
It used to be one, which is why "keep vs done vs to-edit" was confusing: a photo flagged for editing is simply **kept, with an edit pending**.

**A compare duel writes verdicts only when it is the whole table** (m0.8.2): any singles duel, or a group duel whose two endpoints include EVERY undecided member (zero undecided — a browse duel between kept members — is vacuously covered). A count alone is not the test: kept endpoints are legal duelists, so a kept-vs-kept duel with an undecided member watching from outside stays triage. The store re-validates the claim inside the write transaction against a racing scan.
There, the dialog's "Keep both" marks both participants kept, and "Cull" stages the loser while leaving the winner untouched — a cull judgment says nothing about keeping.
A duel with three or more alive is triage: best star and duel history only, no verdict, because repeatedly duelling through a burst picks best/worst — it does not keep.

### 2. Actions — independent, any combination

The answer to "what has been asked of this photo, and did it happen?"
Four actions, **one shape**, no per-action model:

```
photo_actions(photo_id, kind, state, target, queued_at, resolved_at)
  kind   = edit | favourite | organize | share
  state  = queued | applied | error
  target = album path (organize) | 0/1 (favourite direction) | null
```

- **In a queue** = `state IN ('queued', 'error')` **and the photo is still live work** — present, and not staged for deletion or already trashed (`livePhotoClause`, db/actions.ts). Never infer queue membership from timestamp nullness.
  - `error` counts because a retryable failure is still work waiting on you: Android refused to apply a favourite, or a move failed. Dropping it from the queue would hide work the app has already accepted, which is the silent data loss the state is there to prevent. Errored rows are **visibly marked as needing a retry** on their queue screen — otherwise they are indistinguishable from work that simply has not run yet, and the alert that announced the failure is long dismissed.
  - A photo you are about to delete is not waiting for you, however it is flagged; its action rows survive untouched, so un-staging the cull puts it back in every queue it was in.
- **Carried** = `resolved_at IS NOT NULL` and not waiting again. This survives the queue being cleared, which is what makes base rates, turnaround times and forecasts possible — and it is a permanent property of the photo, not a chore.
  An action queued and then abandoned leaves **no row at all** (`leaveQueue` deletes the never-resolved one), so changing your mind really does erase it; only work that actually happened is carried.
- Actions never replace each other and never replace the verdict: a kept photo can be queued to edit, favourite and share at once.
  Clearing a verdict does not clear them either — undoing a keep says nothing about the edit you still want, and neither does the re-decide sheet's explicit "Keep". Only the edit's own control retires an edit.
- All four drain to empty. A queue with nothing in it is the normal resting state.

**The ground principle: the four actions align.**
Where edit, favourite, organize and share can behave the same way, they must — one shape, one predicate, one badge language. Divergence needs a reason inherent to the action itself, and there is exactly one: **favourite is the only action that can point backwards**. A verified un-favourite is an `applied` row whose target is false, so the heart alone must read `target` (`favouriteBadgeWeight`, lib/favouriteState.ts). Direction gives the favourite badge a THIRD state: a queued removal renders the **heart-off glyph** in the favourite hue at the live weight — waiting work, read apart from queued-apply (heart, live) and applied (heart, carried); only a *verified* removal drops the badge entirely. Lifetime "favourites applied" reads the VERIFIED direction (`applied_target` first): a merely queued reversal has not changed what the gallery holds. The other three actions cannot be undone, so they never need direction. When a future change touches one of the four, the default is to change all four.

**THREE questions, one vocabulary.** Two is the intuitive answer and it is wrong; the third row is where every mistake in this area has come from.

| Question | Predicate | Who asks |
|---|---|---|
| *What is waiting for me?* | `state IN ('queued','error')` **and** live (`livePhotoClause`) | tab badges, queue screens, the deck's action buttons |
| *What does this photo carry?* | the above, **or** `resolved_at IS NOT NULL` | per-photo badges only |
| *What is in this grid?* | `state IN ('queued','error')` and the photo is not trashed | Progress action chips **and** the grid they filter |

The first is a to-do count, so it excludes a photo you are about to delete — that is not work waiting for you.
The second describes the photo itself, which is why a staged cull still shows the edit it kept: *carrying* an action and *waiting* on one are different things, and a cancelled trash attempt restores it to exactly that.
The third exists because **a filter's number must equal what tapping it shows**. Progress is a browse surface that deliberately lists staged culls under their own verdict chip; if its "To edit · 8" chip used the queue rule while the grid below used the browse rule, the page would contradict itself one tap apart. The chip and `GRID_FILTER_SQL` therefore share one predicate, by construction.

The consequence to expect, not to fix: **Progress's "To edit" and the Edit tab badge can differ**, by exactly the photos you have staged to cull. That is two surfaces answering two different questions, which is correct; a filter that did not describe its own grid would not be.

Counts never answer question two — a to-do number that only grows is not a to-do.
Badges answer it at **two weights**: `live` for waiting, `carried` for done.

**Share additionally keeps `share_batches` / `share_batch_members`.**
Not an exception to the uniform model — the action row behaves exactly like the other three.
The batch tables are an **event log**, because "these six photos went to Mum together" is a fact about a *batch*, not about a photo, and three shipped behaviours depend on it: per-cycle pass badges, next-pass auto-selection of the not-yet-sent, and History's share stream.

### 3. Annotations — facts, never decisions

| Annotation | Source | User-facing? |
|---|---|---|
| in a group | the scan clustered it | **yes** |
| time-attached | joined its group by timestamp because its embedding was not ready | no — scan-quality internal; the scan rewrites these once embeddings land, and since m0.8.2 no surface draws it |
| best of group | the user's starred pick; also freezes the group against regrouping | unchanged for now; its future is a separate decision |

**"In a group" is not a review state.**
It answers "has the scan clustered this yet" — a scan fact the user cannot act on differently, since grouped and ungrouped unreviewed photos are both simply undecided.
It was previously drawn as a filled segment in the accent colour, which made unreviewed photos count visually as progress.

## Reachability is scope, not state (m0.8.3)

A photo is **unreachable** iff its `volume_name` is not in the currently
mounted volume set — an SD card ejected with its photos' rows intact.
This is a **derived, query-time predicate** (`volume_name IN (mounted)`
beside `is_present = 1` on every review-scope read), never a stored flag:
mount and unmount write **nothing**, so the three layers above survive an
eject byte-for-byte — verdict, actions, annotations, group membership,
embeddings — and remount restores them exactly, no re-ingestion.

`is_present` keeps its exact meaning: gone from MediaStore **while its
volume was mounted** — a real deletion. The scan may only conclude
deletions on mounted volumes; an unmounted volume is skipped whole
(the m0.8.3 per-volume scan contract — lib/volumeScan.ts and the scanRunner headers carry its invariants).

What the predicate scopes: review queues and the timeline, the four
action queues and their badges (the action ROWS survive; only the lists
hide them), the cull queue and its confirm flow, counts, coverage and
clear streaks (a "clear" day earned by ejecting a card is asterisked by
the Home banner's presence), the forecast's remaining pool, and the
browse grids. What it never touches: decision HISTORY and lifetime
stats — completed work is fact, whichever volume it lives on now.

**What a WRITE may touch while a card is out (the M5 rule, vetted
m0.8.3):** explicitly targeted actions — deck verdicts, viewer edits,
selected queue removals — act on their targets regardless of mount
state: the user asked for exactly those rows and would have gotten the
same result before the eject. UNTARGETED bulk writes (keep-rest,
share-all, queue clears, move/remove-all) bind to the rendered set
intersected with a fresh reachable read — a re-read may SHRINK the
write, never widen it into photos the user never saw. Physical
operations (share dispatch, album moves, trash) always bind to
reachable, because they need the bytes. Groups frozen by an unreachable
member still GROW: a new photo the engine clusters with their reachable
members joins the group — existing member rows stay byte-for-byte —
while review-frozen groups never grow.

The state is **named, never silent** (D5): Home carries "SD card not
mounted — N photos waiting on it", the Settings source row a "not
mounted" tag, the picker greys the root, and a deck showing a
partially-reachable group names the hidden members ("N on unmounted SD
card").

## The visual language

Six rules. They apply to every surface that paints a state.

1. **Fill = reviewed.** The coloured part of any bar is exactly the photos carrying a verdict, so the filled fraction always equals the percentage printed beside it. Unreviewed is the empty track.
2. **One fixed hue per verdict and per action**, from the static palette — keep-green, cull-red, edit-blue, favourite-pink, share-teal, organize-amber. Never the accent. The hue identifies the *kind* and never varies; only its strength does (rule 6).

   **A kind's hue is reserved for that kind.** Edit-blue may only appear where editing is the subject; share-teal only for sharing; and so on for all six. Anything else — a primary button, a selected chip, a confirm, a link, a generic badge — takes the **accent**. Borrowing an action's colour because it looked good says the element carries that action, and a reader who has learnt the palette will believe it. This is the rule that catches the largest class of drift: a *share* screen painted in *edit*-blue, or a green tick that has nothing to do with the keep verdict.

   **The one named exception is red.** `cull` doubles as the destructive/error colour (failed rows, error text, delete affordances), because a palette with no danger colour would push errors onto the accent, and an error must never be user-recolourable. Red therefore means *"cull, or something has gone wrong"* — the only hue carrying two meanings, and it is not a licence for the others.
3. **The accent means interaction only** — selection, links, chevrons, primary buttons, tab state. It is user-chosen (Material You), so it can never carry meaning that must stay stable. Six sites still break this (goal ring, Keeping-up bar, coverage markers, activity bars, milestone fills, the best star) and are fixed in **m0.8.5** — [Feedback_m0.8.x.md](Feedback_m0.8.x.md), "The accent must stop carrying meaning", carries the measurements showing why curating the accent picker cannot be the answer. The star is the exception: it is decided in m0.8.6 with the rest of its knot, because whether it survives at all is open.

   **A data series takes the hue of what it counts.** Heat over reviewing is keep-green; the reviewed series in a chart is keep-green. If the counted thing has no hue of its own — photos *arriving*, which is not an action you took — it takes **near-white** (`colors.text`), the one strong colour that means nothing else. Never the accent: a series drawn opposite a fixed hue must stay distinguishable under every accent the user can choose, and one of the presets is a green.
4. **Selection is an outline, never a fill.** A selected item must never adopt a colour that also means a state.
5. **Annotations live on a separate plane.** Grouping is drawn as a rule *under* the bar marking its extent, never as a shade inside a verdict's colour — a lighter green inside "kept" reads as a different decision, not as an annotation.
6. **Strength = lifecycle, and only for actions.** A `live` action badge is the full hue on its tinted disc; a `carried` one is the *same* hue at ~65% on a plain disc. Loud badges are your to-do list, quiet ones are the photo's history. Never desaturate toward grey: a greyed action reads as disabled — a queued un-favourite says "switching off" with the heart-off *glyph*, never with grey. **Suspension demotes to quiet:** a staged cull's retained actions are off every to-do list, so their would-be live badges render carried (a suspended queued removal shows the carried heart — the gallery favourite still stands), and the deck's action chips disable on a staged cull entirely — its retained rows are exactly what un-staging restores. Verdicts and the best star have no lifecycle and always render at full strength.

### What this means per surface

- **Progress / Stats bars** — kept and staged cull filled; unreviewed is the track; a grouped underline beneath. Actions are *not* in the bar: they have the tab-bar queues.
- **Progress chips** — two rows: verdicts (Unreviewed · Kept · Staged cull), then actions (Edit · Favourite · Organize · Share). They answer the **grid** question (third row of the table above), never the queue one: their count is the grid's population by construction, so tapping a chip always shows exactly the number it printed.
- **Grid dots and badges** — verdict first, then actions, in the one order `photoBadges.ts` defines. Annotations draw no badge: time-attachment is internal (below), and the best star renders through its own glyph beside the verdict.
  Badges answer "what does this photo carry", which is why they show a staged cull's pending edit even though the queues do not, and why a finished edit keeps its pencil at the `carried` weight: *carrying* an action and *waiting* on one are different questions.
  The deck's action **buttons** are not badges — they offer work, so they light on waiting only.
- **Histogram** — reviewed share shaded per month; the selected month is outlined, not filled.
- **Filter chips and multi-select** (History filters, Progress chips, ShareQueue photo selection) — an **accent outline over a neutral lift**, never a coloured fill. Borrowing an action's hue for "this is picked" says the item carries that action.
- **Home day rows** — kept and staged fill the bar; a queued edit appears only in the hint line beneath it. Adding it as a third segment counted the same photo twice, since a flagged photo is already kept.
- **Goal ring and coverage bar** — unaffected. They show *progress over time*, not photo state, and correctly use the accent until complete, then keep-green.

## Deliberately not states

Recorded so they are not re-invented:

- **in a group / time-attached** — scan facts (annotations).
- **edit / favourite / organize / share** — actions, orthogonal to the verdict, each either waiting or carried.
- **"done"** — retired wording; the verdict is *kept*.
- **unreachable** — scope, not state (m0.8.3, D5b): derived at query time from the mounted-volume set, stored nowhere, and gone the moment the card returns.
