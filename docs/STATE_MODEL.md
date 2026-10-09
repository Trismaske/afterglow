# Photo state model & visual language

**Status:** shipped in m0.8.2. Reachability scoping was added in m0.8.3 (schema v20).
This is the contract, not a proposal. The code implements it and the tests hold it there.
**Audience:** anyone who adds a surface that shows what has happened to a photo.
**Why it exists:** surfaces drew three unrelated ideas in one visual vocabulary.
"In a group" (a scan fact) was painted like a decision and counted as progress.
This document is the single answer, so no one has to re-derive it.

## The three layers

A photo carries exactly one **verdict**, any number of **actions**, and any number of **annotations**.
Do not conflate them. This model exists to prevent that mistake.

### 1. Verdict: one per photo, mutually exclusive

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
Before m0.8 the state was named `kept`, and it later became `done`.
m0.8.2 renames it back to `kept`, so the button and the stored value use the same word.

**`to_edit` is not a verdict.**
It was once a verdict, which caused the "keep vs done vs to-edit" confusion.
A photo flagged for editing is simply **kept, with an edit pending**.

**A compare duel opens the verdict DIALOG only when it is the whole table** (m0.8.2).
That means any singles duel, or a group duel whose two endpoints include EVERY undecided member.
A duel with zero undecided members (a browse duel between kept members) is vacuously covered.
A count alone is not the test.
Kept endpoints are legal duelists, so a kept-vs-kept duel with an undecided member outside it stays triage.
The store re-validates the claim inside the write transaction against a racing scan.
In that dialog, "Keep both" marks both participants kept.
"Cull" stages the loser and leaves the winner untouched, because a cull judgment says nothing about keeping.
A duel with three or more alive is TRIAGE, and its positive act is a targeted keep (m0.8.6 D7): "Keep this one" writes `kept` on that photo alone — a narrow, explicitly-targeted verdict, never a whole-table claim — and records the duel row.
The loser is untouched; the direct Cull chip stages it when that is what is meant.
In a burst walked through repeated duels, each round's keep stands (a keep can still be culled later); the duel rows remain the history.

### 2. Actions: independent, any combination

The answer to "what has been asked of this photo, and did it happen?"
Four actions, **one shape**, no per-action model:

```
photo_actions(photo_id, kind, state, target, queued_at, resolved_at)
  kind   = edit | favourite | organize | share
  state  = queued | applied | error
  target = album path (organize) | 0/1 (favourite direction) | null
```

- **In a queue** = `state IN ('queued', 'error')` **and the photo is still live work**: present, not staged for deletion, and not already trashed (`livePhotoClause`, db/actions.ts).
  Never infer queue membership from timestamp nullness.
  - `error` counts because a retryable failure is still work that waits on you: Android refused a favourite, or a move failed.
    A queue that drops it would hide work the app has already accepted. That is the silent data loss this state prevents.
    Errored rows are **visibly marked as needing a retry** on their queue screen.
    Without the mark they look identical to work that has not run yet, and the alert that announced the failure is long dismissed.
  - A photo you are about to delete is not waiting for you, however it is flagged.
    Its action rows survive untouched, so when you un-stage the cull, the photo returns to every queue it was in.
- **Carried** = `resolved_at IS NOT NULL` and not waiting again.
  A carried action survives a cleared queue, which makes base rates, turnaround times, and forecasts possible.
  It is a permanent property of the photo, not a chore.
  An action queued and then abandoned leaves **no row at all** (`leaveQueue` deletes the never-resolved one).
  A changed mind really does erase it. Only work that happened is carried.
- Actions never replace each other and never replace the verdict: a kept photo can be queued to edit, favourite, and share at once.
  A cleared verdict does not clear them either.
  An undone keep says nothing about the edit you still want, and neither does the re-decide sheet's explicit "Keep".
  Only the edit's own control retires an edit.
- All four drain to empty. A queue with nothing in it is the normal resting state.

**The ground principle: the four actions align.**
Where edit, favourite, organize and share can behave the same way, they must: one shape, one predicate, one badge language.
Divergence needs a reason inherent to the action itself, and there is exactly one: **favourite is the only action that can point backwards**.
A verified un-favourite is an `applied` row whose target is false, so the heart alone must read `target` (`favouriteBadgeWeight`, lib/favouriteState.ts).
Direction gives the favourite badge a THIRD state.
A queued removal renders the **heart-off glyph** in the favourite hue at the live weight: waiting work, read apart from queued-apply (heart, live) and applied (heart, carried).
Only a *verified* removal drops the badge entirely.
Lifetime "favourites applied" reads the VERIFIED direction (`applied_target` first): a merely queued reversal has not changed what the gallery holds.
The other three actions cannot be undone, so they never need direction.
When a future change touches one of the four, the default is to change all four.

**THREE questions, one vocabulary.**
Two is the intuitive answer, and it is wrong.
The third row is where every mistake in this area has come from.

| Question | Predicate | Who asks |
|---|---|---|
| *What is waiting for me?* | `state IN ('queued','error')` **and** live for its kind (`livePhotoClause`) | tab badges, queue screens, the deck's action buttons |
| *What does this photo carry?* | the above, **or** `resolved_at IS NOT NULL` | per-photo badges only |
| *What is in this grid?* | `state IN ('queued','error')` and the photo is not trashed | Progress action chips **and** the grid they filter |

The first is a to-do count, and since m0.8.7 (F21) its suspension is **per kind**:

- **Share and edit stay live on a staged cull.** "Delete it, but share it first" is a real flow, and an edit you asked for is still wanted while the photo waits in the cull queue — they list, count, dispatch, and stay addable from the deck.
- **Favourite and organize suspend on a staged cull.** Decorating or filing a photo you are about to delete makes no sense; the rows survive (un-staging restores them), the lists hide them, and additions are refused.
- **A trashed photo suspends everything** — the file is the OS's now.

The cull confirm names the never-sent share and edit intents its cleanup would delete ("N photos still have an unsent share request"), so proceeding is a knowing choice; sent intents keep their History proof either way.
Dispatching a share whose photo still has a queued edit gets its own confirm — the unedited file is about to go out.
The second question describes the photo itself, which is why a suspended favourite still badges the heart it kept.
To *carry* an action and to *wait* on one are different things, and a cancelled trash attempt restores the photo to exactly that.
The third exists because **a filter's number must equal what a tap on it shows**.
Progress is a browse surface that deliberately lists staged culls under their own verdict chip.
If its "To edit · 8" chip used the queue rule while the grid below used the browse rule, the page would contradict itself one tap apart.
The chip and `GRID_FILTER_SQL` therefore share one predicate, by construction.

Since m0.8.7 the Edit tab and Progress's "To edit" agree again — edit is live on a staged cull, so both count it.
The gap that remains is favourite/organize: their Progress chips include staged culls (browse rule) while their queues do not (suspension), which is two surfaces answering two different questions, correctly.
A filter that did not describe its own grid would not be.

Counts never answer question two. A to-do number that only grows is not a to-do.
Badges answer it at **two weights**: `live` for waiting, `carried` for done.

**Share additionally keeps `share_batches` / `share_batch_members`.**
This is not an exception to the uniform model. The action row behaves exactly like the other three.
The batch tables are an **event log**, because "these six photos went to Mum together" is a fact about a *batch*, not about a photo.
Three shipped behaviours depend on it: per-cycle pass badges, next-pass auto-selection of the not-yet-sent, and History's share stream.
A pass RESOLVES on the chooser's chosen-target callback (m0.8.6 D10): "Shared" means the user handed the batch to an app — the strongest fact Android offers, never a delivery claim.
A sheet opened and dismissed leaves no record: the abandoned batch is discarded whole and the photos stay queued.

### 3. Annotations: facts, never decisions

| Annotation | Source | User-facing? |
|---|---|---|
| in a group | the scan clustered it | **yes** |
| time-attached | joined its group by timestamp because its embedding was not ready | no — scan-quality internal; the scan rewrites these once embeddings land, and since m0.8.2 no surface draws it |

**"Best of group" is retired** (m0.8.6 D6).
The starred pick, its accent badge and its best-first orderings are gone; a triage duel's positive act is now a targeted keep (D7), and "this one is special" is what favourite is for.
Recorded compares (duel rows) remain as an append-only event log (m0.8.7): written by Compare, deleted by nothing — endpoints outlive removals, and "Forget this card" erase anonymizes the ids instead of deleting the rows.

**"In a group" is not a review state.**
It answers "has the scan clustered this yet": a scan fact the user cannot act on differently, since grouped and ungrouped unreviewed photos are both simply undecided.
An earlier design drew it as a filled segment in the accent colour, which made unreviewed photos count visually as progress.

## Scope is two axes, never state (m0.8.3 reachability; m0.8.7 sources)

A photo is **unreachable** if and only if its `volume_name` is not in the currently mounted volume set: an SD card ejected with its photos' rows intact.
A photo is **out of source** if and only if its current uri falls outside the selected source folders (`Settings → Photo source`; "All folders" scopes nothing).
Both are **derived, query-time predicates** (`volume_name IN (mounted)` and the volume+uri source clause beside `is_present = 1` on every review-scope and queue read), never stored flags.
Mounting, unmounting, and source edits write **nothing to photos**, so the three layers above survive both transitions byte-for-byte: verdict, actions, annotations, group membership, embeddings.
A remount — or re-selecting the folder — restores every surface exactly, with no re-ingestion.

`is_present` keeps its exact meaning: gone from MediaStore **while its volume was mounted**, a real deletion.
The scan may only conclude deletions on mounted volumes.
An unmounted volume is skipped whole (the m0.8.3 per-volume scan contract: lib/volumeScan.ts and the scanRunner headers carry its invariants).

What the two predicates scope (identically — m0.8.7's F18 audit brought the queue reads onto both axes):

- review queues and the timeline
- the four action queues, their tab badges, and their bulk-action bindings (the action ROWS survive, only the lists hide them)
- the cull queue, its badge, its reclaimable-bytes figure, and its confirm flow (the loop attempts only what the scoped list showed)
- counts, coverage, and clear streaks (the Home banner's presence asterisks a "clear" day earned by an ejected card)
- the forecast's remaining pool
- the browse grids

What they never touch: decision HISTORY and lifetime stats.
Completed work is fact, whichever volume it lives on now, and whatever folders are currently selected: achievement and habit stats (the goal ring, streaks, records, activity, rhythm, sittings, decisiveness) read decision history unscoped on BOTH axes (vetted 2026-08-21).
The one scoped decided read is the intake chart's decided series, which must describe the same population as its captured partner (STATS_ACCURACY gap 6).

**What a WRITE may touch while a card is out (the M5 rule, vetted m0.8.3):**
Explicitly targeted actions (deck verdicts, deck action chips, selected queue removals) act on their targets regardless of mount state.
The user asked for exactly those rows and would have gotten the same result before the eject.
UNTARGETED bulk writes (keep-rest, share-all, queue clears, move/remove-all) bind to the rendered set intersected with a fresh reachable read.
A re-read may SHRINK the write. It may never widen the write into photos the user never saw.
Physical operations (share dispatch, album moves, trash) always bind to reachable, because they need the bytes.
An unreachable member's assignment row stays byte-for-byte: the membership repair defers dissolving its group, and a remount re-windows it through the normal scan.

## Grouping is presentation; "not related" is the one membership judgment (m0.8.7)

Groups re-form freely on every scan pass — decided members included.
Photos own their review state; membership is a scan fact, so nothing about a verdict pins it, and un-review is fully non-destructive (no confirm, no Compare-history loss).
The in-transaction decision-write guards protect verdicts against stale renders; nothing protects membership, because membership is not state.

The one durable user judgment about membership is the **"not related" pair**: ejecting a photo records a cannot-link pair against every present member of its group (hidden unreachable members included) and clears its assignment.
Enforcement is symmetric — the pair never shares a group in either direction, at any strictness — in the grouping engine and again inside the scan's write transaction.
Two lifecycle rules give the pairs their direction:

- **Dissolution**: ejecting a photo first deletes every pair in which it is the *partner* — its own ejection revokes its standing as a proxy for the cluster it was ejected from, so photos ejected from the same group can reunite elsewhere.
- **Un-eject** (the deck's "Not related · N" un-mark): deletes the pairs where the photo is the *ejected* side — its own judgments — never those naming it as a partner, then a targeted rescan re-places it.

Pairs are membership constraints, never state: verdicts, actions and stats are untouched by recording or clearing them.

The unreachable state is **named, never silent** (D5).
Home carries "SD card not mounted — N photos waiting on it".
The Settings source row carries a "not mounted" tag.
The picker greys the root.
A deck that shows a partially-reachable group names the hidden members ("N on unmounted SD card").

## The visual language

Seven rules. They apply to every surface that paints a state.

1. **Fill = reviewed.** The coloured part of any bar is exactly the photos that carry a verdict.
   The filled fraction therefore always equals the percentage printed beside it.
   Unreviewed is the empty track.
2. **One fixed hue per verdict and per action**, from the static palette: keep-green, cull-red, edit-blue, favourite-pink, share-teal, organize-amber.
   Never the accent.
   The hue identifies the *kind* and never varies. Only its strength does (rule 6).

   **A kind's hue is reserved for that kind.** Edit-blue may only appear where editing is the subject, share-teal only for sharing, and so on for all six.
   Everything else takes the **accent**: a primary button, a selected chip, a confirm, a link, a generic badge.
   To borrow an action's colour because it looked good says the element carries that action, and a reader who has learnt the palette will believe it.
   This rule catches the largest class of drift: a *share* screen painted in *edit*-blue, or a green tick that has nothing to do with the keep verdict.

   **The one named exception is red.** `cull` doubles as the destructive/error colour (failed rows, error text, delete affordances).
   A palette with no danger colour would push errors onto the accent, and an error must never be user-recolourable.
   Red therefore means *"cull, or something has gone wrong"*.
   It is the only hue that carries two meanings, and it is not a licence for the others.
3. **The accent means interaction only**: selection, links, chevrons, primary buttons, tab state.
   The user chooses it (Material You), so it can never carry meaning that must stay stable.
   No site breaks this any more: five (goal ring, Keeping-up bar, coverage markers, activity bars, milestone fills) were fixed in m0.8.5, and the sixth — the best star's accent badge — was retired with the star itself (m0.8.6 D6).
   The m0.8.5 accent pass measured why a curated picker cannot be the answer: any user-chosen hue can collide with a data hue, so no palette guarantees the distinction — only the rule does.

   **A data series takes the hue of what it counts.** Heat over reviewing is keep-green. The reviewed series in a chart is keep-green.
   If the counted thing has no hue of its own, it takes **near-white** (`colors.text`), the one strong colour that means nothing else.
   Photos *arriving* are the example: arrival is not an action you took.
   Never the accent: a series drawn opposite a fixed hue must stay distinguishable under every accent the user can choose, and one of the presets is a green.
4. **Selection is an outline, never a fill.** A selected item must never adopt a colour that also means a state.
5. **Annotations live on a separate plane.** Draw grouping as a rule *under* the bar that marks its extent, never as a shade inside a verdict's colour.
   A lighter green inside "kept" reads as a different decision, not as an annotation.
6. **Strength = lifecycle, and only for actions.** A `live` action badge is the full hue on its tinted disc.
   A `carried` one is the *same* hue at ~65% on a plain disc.
   Loud badges are your to-do list. Quiet ones are the photo's history.
   Never desaturate toward grey: a greyed action reads as disabled.
   A queued un-favourite says "switching off" with the heart-off *glyph*, never with grey.
   **Suspension demotes to quiet, per kind (F21):** a staged cull's suspended favourite/organize render carried; its share and edit stay LIVE — they are dispatchable work.
   A suspended queued removal shows the carried heart: the gallery favourite still stands.
   The deck's favourite and organize chips disable on a staged cull; edit and share stay active (the browse-mode edit chip flag-toggles there, so queueing the edit never silently rescues the cull).
   Verdicts have no lifecycle and always render at full strength.
7. **One box per corner.** Everything a stage corner says shares one backdrop, and every line in it aligns to the corner's side.
   Text facts **stack**: one line per kind of fact (when, where, what in the top-left; position, part in the top-right), facts of one kind joined by ` · `, and a line never wraps.
   Marks **flow**: the kind chip first, then the verdict and action discs, on one line when they fit before the playback buttons, otherwise the chip on its own line above the discs.
   A second box in a corner, or content drawn outside its backdrop, is drift.

### What this means per surface

- **Progress / Stats bars** — kept and staged cull fill the bar, unreviewed is the track, and a grouped underline sits beneath.
  Actions are *not* in the bar. They have the tab-bar queues.
- **Progress chips** — two rows: verdicts (Unreviewed · Kept · Staged cull), then actions (Edit · Favourite · Organize · Share).
  They answer the **grid** question (third row of the table above), never the queue one.
  Their count is the grid's population by construction, so a tapped chip always shows exactly the number it printed.
- **Grid dots and badges** — the one quiet annotation first (the kind chip: Video · Motion · GIF, near-white, m0.9; it leads the stage cluster and never reaches a thumbnail), then the verdict, then actions, in the one order `photoBadges.ts` defines.
  The folder and the SD card are facts of the stage's metadata corner (`lib/stageMeta.ts`), never badges, and a small square carries no annotation at all.
  Time-attachment stays internal and draws nothing.
  A clip thumbnail (video, motion photo, GIF) wears its kind mark top-left on every surface, playing or not — an annotation, exempt from the eye; a plain photo carries none.
  Badges answer "what does this photo carry", and a finished edit keeps its pencil at the `carried` weight.
  To *carry* an action and to *wait* on one are different questions.
  The deck's action **buttons** are not badges. They offer work, so they light on waiting only.
- **Histogram** — the reviewed share is shaded per month. The selected month is outlined, not filled.
- **Filter chips and multi-select** (History filters, Progress chips, ShareQueue photo selection) — an **accent outline over a neutral lift**, never a coloured fill.
  A borrowed action hue for "this is picked" says the item carries that action.
- **Home day rows** — kept and staged fill the bar. A queued edit appears only in the hint line beneath it.
  A third segment for it counted the same photo twice, since a flagged photo is already kept.
- **Progress displays** (goal rings, the Keeping-up bar, coverage markers, the 30-day activity bars) — **keep-green throughout**.
  They show progress over time rather than photo state, but what they count is *reviewing*, so rule 3's "a series takes the hue of what it counts" governs them like anything else.
  Completeness is carried by the GEOMETRY each already has — the ring closes, the bar fills, the marker tops out, a day's bar rises against the grey goal line — never by changing hue.
  They used to run accent-until-complete, then keep-green: a two-state pattern that could not send its one signal under the Green accent, where the two nearly merge.
- **Milestone bars** — the hue of what each one counts: reviewed keep-green, culled cull-red, edits completed edit-blue.
  Three bars with three subjects, so one shared colour would have claimed they measured the same thing.

## Media kinds are annotations (m0.9)

A photo, a video, a motion photo or a GIF is a **kind**, read from MIME, and a kind is an annotation: it changes what the stage plays and what the chip says, never the verdict or the actions.
A video takes every verdict and all four actions, and sits out Compare; a motion photo is a photo for grouping, zoom and Compare and a video while its clip plays; a GIF is a photo that animates.
The display name renders the extension (uppercase, no dot) and MIME classifies, and the two may disagree — each layer claims only what it read.
Copy says "items" wherever a count can include videos.

## Text scales; layouts stack (m0.9.1)

Every text in the app scales with the OS font size, at every step, with no cap: a user who asked for larger text gets it everywhere.
What changes with the scale is layout, and the layout decides from ITS OWN TEXT: every rearranging surface watches the lines its labels rendered (`components/useTextOverflow`, React Native's onTextLayout) and rearranges when a label needed a line it is not allowed — exact for any width, font or language. The thresholds in `lib/textScale.ts` (the font scale relative to the window width, 1.3 and 1.6 effective, measured on the accessibility walk) are only the FIRST GUESS applied before anything has measured, so the walked phones never show a frame of the old arrangement; a scale or width change starts from the guess again.

- **Free text wraps** and its container grows. Nothing else is needed for most of the app.
- **A side-by-side pairing of a fixed-size element and a text column STACKS** when a line beside the element needs a second line (Home's goal ring and its numbers, Stats' Today ring and its copy, the Settings rows that put a title beside a pill); a row of a title and its actions WRAPS the actions under the title by layout alone (Home's brand row); a row of labelled chips drops its labels to icons when a chip label wraps (the deck's Edit · Favourite · Organize · Share: the deck has no vertical room for a second row, which put two chips behind the finish button); a segmented pill stays one row while its labels fit and becomes a vertical radio list, one option per full-width row, once a segment label wraps — never a pill broken across rows (Tristan, 2026-10-09: stretched segments and gaps). The pill is the one surface with NO first guess: it starts on one row at every scale, because a wrong guess (three-plus-two rows at 1.3 when one row fit) is a layout the lever cannot undo, while a wrong start costs one frame.
- **A label beside an icon in a slot that cannot grow DROPS** when it needs a second line, and the icon carries the meaning with its accessibility label (the tab bar); dense chip grids wrap two per row when a chip label wraps (the Progress chips).
- **Exact-geometry surfaces grow by the scale, deterministically**: the Timeline's unit card, the goal ring's diameter and the histogram's axis rows are sizes COMPUTED from the font scale, never measured, so the Timeline's exact landings, the ring's centre text and the chart's geometry hold at every scale.
- **Nothing overlaps by accident.** A badge sits on its icon's corner only while it is small enough to leave the icon readable: the tab badge is a work indicator, not reading text, so its 16 dp disc never grows — it keeps its count while the scaled digit fits the disc and becomes a plain dot on the same corner past that, the count staying in the queue's title and the tab's accessibility label (Tristan, 2026-10-09); the walk's report counts an icon or a one-character badge covered by more than half as an overlap, and any other intersecting pair of texts as one.
- A fixed width is never a text's; it is a row layout's, and the stacked layout drops it.
- **Icons keep their size; only text scales with the font setting.** Every icon is a font glyph and scaled with the font while its frame (the tab's circle, a chip's slot, a mark's disc) did not (Tristan, 2026-10-09: the tab icon pressed its circle at 1.3). `components/Icon` pins every icon at its dp size, as Android's own icons are (measured: the Settings app's icons on Android 12 and 16, and YouTube's, keep their boxes from 1.0 to 2.0 — docs/accessibility-audit.md, "The OS baseline"); the display-size setting is what scales them, and the walk covers it. A dump boxes a glyph by its frame, so the walk cannot read an icon's growth; the rule is held by the wrapper and its lint rule, and by the platform measurement.
- **Every text keeps its size relative to every other.** That is the type scale's one invariant, and a text that ignores the font size breaks it for its whole screen: the stack header's title did (React Navigation's native title), so it is our text now (`components/HeaderTitle` through `headerTitle`), and the walk's report flags any text whose height did not grow with the scale (STATIC), with no exclusions. The title is the app's one ellipsized text: the OS toolbar's height is fixed. The invariant is that nothing of ours pins a size; the ratios themselves follow the OS: Android 14 and later scale large text less than small (non-linear font scaling — on the Android 16 emulator at the 2.0 setting a 15 sp line grew 1.6×, a 22 sp title 1.3× and a 28 sp display line 1.2×, while Android 12 scales everything linearly), which is the platform keeping titles from outrunning the screen, and the report judges STATIC at 1.5 and above for that reason.

The `type` tokens in `theme.tsx` give every text one of six sizes with a line height that scales with it (React Native scales both), so a wrapped line and a stacked row keep their rhythm.

## Deliberately not states

Recorded here so no one re-invents them:

- **in a group / time-attached**: scan facts (annotations).
- **edit / favourite / organize / share**: actions, orthogonal to the verdict, each either waiting or carried.
- **"done"**: retired wording. The verdict is *kept*.
- **unreachable**: scope, not state (m0.8.3, D5b).
  Derived at query time from the mounted-volume set, stored nowhere, and gone the moment the card returns.
