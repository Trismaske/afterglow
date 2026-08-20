# m0.8.6 — the browsing surfaces

Going back to look at something you already reviewed: the full Timeline, a state editor that can touch everything, and the freeze/star knot untangled.
Answers F2, F8, F9 and F16 from [Feedback_m0.8.x.md](Feedback_m0.8.x.md), the post-ship deck notes N1–N2, and three TODO promotions (the rescued-date scope, History tombstones, the star knot).

Delete this doc when m0.8.6 ships, after distilling anything durable into PLAN.md, STATE_MODEL.md and the code headers.

## 1. Overview

### What changes

- The review overview becomes the **Timeline**: every unit browsable, three filters, the last choice remembered.
- The state editor becomes the state model made touchable: one verdict, every action addable and removable.
- The regroup freeze follows current state with no contagion: any unreviewed member makes its group rebuildable.
- The **best star is retired**. Compare's triage duels gain a real keep.
- Share resolution moves from "the sheet opened" to "an app was chosen"; History's chip finally says **Shared** and means it.
- History shows tombstones: forgotten-card and trashed photos return as placeholder tiles, with a Trashed chip.
- The rescued-date defect's six agreed changes land, with both regression pins.
- The deck: a changed decision advances (N1), the finish button stops dimming on other writes (N2), and the two control rows unify (killing the singles-finish flash).

### What does not change

- The pending review feed, its optimistic patches, and the horizon-truncation machinery — the Unfinished filter renders them byte-for-byte as today.
- The trash path, the scan pipeline, the M5 rule, and the queue screens (m0.8.7's territory).
- Duel rows stay permanent **except** under one deliberate act: the state editor's set-to-unreviewed (D5).
- `sheet_opened` remains a real state in the share lifecycle; it stops being the *terminal* one.

### Why now

F2 and F9 are the two halves of "going back": finding the thing, then editing it.
The freeze change (D4) is what makes F9's regroup use case real, and the star's freeze role had to be re-decided in the same release (L8) — retiring it (D6) resolves the last accent-rule violation by deletion.
The rescued-date changes are five-sixths Progress-surface work, and this is the Progress release.

## 2. Agreed decisions

L1–L8 are in [Feedback_m0.8.x.md](Feedback_m0.8.x.md) and are not repeated.
The twelve below were settled with Tristan in a grilling on 2026-08-17, before any code was written.
An approved decision is not an assumption — read this before you reopen anything.

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Timeline browse data | **Separate DB-paged keyset read path** for Everything and Unreviewed-only; Unfinished keeps the pending feed untouched | The patch model mirrors pending-only predicates and the horizon tails exist because the read is bounded; extending them to reviewed units re-opens the codex-r7 horizon-jump problem at every page boundary. A browse surface tolerates refetch-on-return. |
| D2 | Sparse one-photo days under Everything | **Render exactly as when pending** — one card per unit, no collapse | Consistency: a reviewed unit looks the way it did when it was pending. If dozens of cards feel tedious on device, the parked "Coalesce tiny singles runs?" trigger fires honestly. |
| D3 | "Unreviewed only" rule | Units with ≥1 unreviewed member; **staged-cull singles hidden** inside runs; group cards render whole | Pure not-yet-decided work. An all-staged run vanishes (it has none). Hiding members of a group card would contradict how group cards work everywhere else. |
| D4 | The regroup freeze | **Literal derived rule**: any unreviewed member ⇒ the whole group is rebuildable; the contagion rule is deleted | The freeze follows current state with nothing stored. Accepted knowingly: this also applies mid-review — deciding 1 of 5 leaves the group reshapeable until all are decided (m0.8 decision 5's contagion reversed). The in-transaction assignment guards keep the writes safe. L2's "un-reviewing one member makes that group rebuildable" is now literally true. |
| D5 | The metadata freeze | The rule **stands**, but the state editor's set-to-unreviewed **deletes the group's entire duel history** (editor-only trigger, group-wide scope, named in the confirm copy) | Guaranteed rebuildability needs all duels gone (any surviving pair keeps `EXISTS duels` true). Deck undo and CullList Restore never delete — the metadata freeze keeps guarding transient states, so a mis-tap cannot destroy Compare work. |
| D6 | The best star | **Retired** — column, verbs, badges, orderings, accent ring, favourite handoff, and the freeze's star half all swept | Its own feedback framed it as an accent violation, a freeze complication, and a wrong-way pull in duels. With D7's keep path, its unique value shrank to the badge. Deletion resolves the last rule-3 violation without solving a hue. |
| D7 | Triage's positive act | The button becomes **"Keep this one"**: a targeted keep on that photo (narrow assignment guard, loser untouched, duel row still recorded), keep-green per rule 2 | Post-star, a record-only act has no visible outcome. A targeted keep is not a whole-table claim — `decideCull` set the template. Accepted wrinkle: in a burst, each round's winner stays kept (a keep can still be culled later). |
| D8 | State-editor action scope | **All four actions addable and removable** (organize add queues the target-less move — the album is assigned on the Organize screen, the m0.8.2 queue-then-assign model, G2; share routes through the share-queue writers) | "The four actions align" — organize's target is a parameter, not an inherent inability. Refusals stay the honest three: trashed (the OS's), an applied organize, a resolved share. |
| D9 | History tombstones | **Forget-keep AND trashed rows** join as placeholder tiles (grey cell, verdict badge, original date); a **Trashed chip** completes the verdict-chip family | History's charter is completed work as fact. Executed culls are the most common completed act; dropping only the SD case leaves the same class open. Kept/Staged/Trashed mirrors the verdict table. |
| D10 | Share resolution | Resolution binds to the chooser's **chosen-component** signal (`EXTRA_CHOSEN_COMPONENT`, API 22+). An abandoned sheet leaves **no record** and the photos stay queued. History's chip reads **"Shared"**; pass badges and next-pass auto-selection follow | The back-button heuristic is a guess; the chosen-component callback is a fact Android owns. "An action queued and then abandoned leaves no row at all" — the batch follows the same principle. The claim is "handed to an app", the strongest fact available. |
| D11 | N1's advance rule | **Advance iff the verdict changed to a different decided verdict** (or was fresh) | One predicate, no special cases: kept↔culled and culled→to_edit advance; undo and kept→to_edit stay (queuing work on a photo should not yank the pager off it). |
| D12 | The zoom walking-pan port | **Final phase, explicitly liftable** if the release runs long | Feel-tuning is open-ended (m0.8.5's pinch took five rounds) and nothing else depends on it. The design (§10) survives a lift intact. |

Two composition notes, on record so nobody re-derives them:

- **D4 + D5 give Compare accidental stability.** A triage session's first duel row makes its group a metadata group, so Compare sessions self-freeze against mid-session reshaping. Only plain deck sessions carry D4's accepted instability.
- **D6 makes D5 duels-only in practice.** No stars will exist; `getMetadataGroupIds` loses its star half and keeps duels.

## 3. The Timeline (F2, D1–D3, L7)

`GroupsScreen` is renamed **Timeline** (screen, title, and route — **(autonomous)** the route-rename mechanics and any deep-link fallout are settled during implementation).

### 3.1 Filters

| Filter | Data source | Shows |
|---|---|---|
| Unfinished | the existing pending feed, untouched | today's behaviour: units with pending work, staged culls badged |
| Everything | the new browse read (§3.2) | every unit, reviewed included, rendered exactly as when pending (D2) |
| Unreviewed only | the Unfinished feed, display-filtered | units with ≥1 unreviewed member; staged-cull singles hidden (D3) |

Unreviewed-only is a **client-side subset of the Unfinished data** — no third query.
The last choice persists via the canonical settings-row pattern (`getSetting` parse-with-fallback); first launch opens Unfinished (L7).
*Continue reviewing* keeps anchoring to `firstPendingUnit` of the pending feed, whatever the filter shows.
The subtitle counts stay pending-only DB counts on every filter — they describe work, not the view.

### 3.2 The browse read

A new store read, keyset-paged, newest-first, serving Everything:

- Two keyset streams — groups (anchored on the newest present member's `taken_at`, no unreviewed-EXISTS requirement) and ungrouped singles — merged into units page by page, reusing `buildTimeline`'s day-boundary and interleave rules for run assembly.
- A run straddling a page boundary stays **open**: the assembler holds the tail run and the next page's rows append to it before new units form. **(autonomous)** page size and the exact cursor shape are set during implementation against the 27k corpus and stated in the appendix.
- Staleness: refetch page 1 on review `version` bump and on external invalidation (foreground return, volume mount — the reviewed-only changes a version bump cannot see). A version-silent focus deliberately does NOT reset: nothing changed, and the reset would discard the reading position the filter memory keeps (codex r1 reconciliation of this line with the round-3 position work — grilling item). No optimistic patches, no horizon tails.
- Perf gate: `taken_at` deliberately has no index (+116 ms scan writes when measured). The browse page query is **measured on the S10e** before the design is called done; if it crawls, the index is re-measured as its own decision, not assumed.

Tapping a reviewed unit opens the browse deck exactly as completed units open today.

## 4. The state editor (F9, D8)

`editorActions` and `StateEditorSheet` are rebuilt as the state model made touchable:

- **One verdict control** — unreviewed / kept / culled. All three writes exist: `applyReviewDecisions` (kept, culled, unreviewed), `unstageCullDirect` (culled→kept), `restoreCarriedCull` (culled→unreviewed). Every verdict write routes through the ReviewContext provider so goal credit stays by construction (m0.8.5 A3; the sheet's un-cull already learned this the hard way).
- **Four action rows**, each addable and removable: edit (queue / complete / remove), favourite (directional, applied is reversible via target `'0'` — the heart-off badge already models it), share (through `addToShareQueue`/`removeFromShareQueue` — cycle semantics live there), organize (add queues the target-less move, assigned on the Organize screen — queue-then-assign, G2).
- **The honest refusals, and nothing more**: trashed is the OS's; an applied organize move happened; a resolved share left the device. Each refusal keeps its explanatory hint line.
- **Set-to-unreviewed on a grouped photo** triggers D5: the confirm copy names the deletion when the group has duels ("also clears this group's Compare history"), and the write deletes all the group's duel rows in the same transaction.
- The date line renders from `day`, never `taken_at` (§7 change 5): an undated photo reads **Unknown day** with no confident clock.

## 5. The freeze and the star (D4–D7, L2)

### 5.1 The new freeze predicate

`windowFreeze` simplifies to: a photo is frozen iff it is `user_single`, its group carries duels, its group holds an unreachable member (grow-only, unchanged), or **its own state left `unreviewed` and it is ungrouped or every groupmate has too**.
Equivalently: a group with any unreviewed member is rebuildable whole.
The contagion walk is deleted — net code goes down, and the tests rewrite to the new table.
STATE_MODEL.md's freeze paragraphs and the `regroupBoundary.ts` header follow.
The parked TODO "Group a detected edited copy with its original" re-reads against this rule, as it already says it must.

### 5.2 The star retirement sweep

Everything the star was the sole setter of goes, per the removal-sweep rule: `photo_groups.best_photo_id` (column, partial index, FK — dropped; schema changes are free pre-v1), `setGroupBest`, `markBest`, `toggleBest` and its favourite-handoff offer, `extras.setBest`, the cull/trash/reconcile star-clearing sweeps, the `best` patch kinds in `reviewPatch`, `is_best` in `PhotoFacts` and the viewer's "Best of its group." line, best-first ordering and accent rings on Timeline and DayProgress cards, the `best` badge kind, and Compare's star copy and toasts.
STATE_MODEL.md: the annotation table's star row is deleted; rule 3's "one site still breaks this" paragraph resolves; rule 6's "verdicts and the best star" sentence trims.

### 5.3 Compare's keep (D7)

In a triage duel the per-side button reads **"Keep this one"**, takes keep-green, writes a targeted keep through the narrow assignment guard (`decideCull`'s template — never the whole-table claim), records the duel row, toasts, and returns.
Whole-table duels are unchanged.
STATE_MODEL.md's "repeated duels through a burst pick best and worst — they do not keep" rewrites to the new contract.

## 6. Share resolution (F16, D10)

The native share launch adopts `Intent.createChooser` with an `IntentSender`; the receiver records the chosen component and time on the batch.
The lifecycle becomes: `launching` → `sheet_opened` → **`shared`** (component chosen) or **discarded** (no choice by the time Afterglow is foregrounded again, or at startup recovery — the sweep that already demotes stranded `launching` rows extends to this).
**(autonomous)** the foreground-return grace window is set during implementation and stated in the appendix.

- Action rows resolve (`resolved_at`) at `shared`, not at sheet-open. Photos in an abandoned batch stay queued: the intent stands, only the attempt evaporates.
- A discarded batch leaves no rows — batch and members deleted, no History event.
- History's chip reads **Shared** and filters to chosen batches; the row copy follows.
- Per-cycle pass badges and next-pass auto-selection key on `shared`.
- The Samsung share sheet's callback behaviour is verified on device before this phase is called done.

## 7. The rescued-date scope and Progress (six changes + F8)

Designed and agreed in full before this release ([Feedback_m0.8.x.md](Feedback_m0.8.x.md) carries the design; the sites below are current):

1. Bounded month scopes route to the SQLite grid engine (`PhotoStateGrid`'s `dbEngine` gains month scopes; D16's proven day-scope pattern).
2. The MediaStore-engine grid takes `takenAt` (and `day`) from the `getStateRowsForAssets` join for tracked rows.
3. The header denominator is `dbAlive`, exactly as day scopes (D16): the month grid pages SQLite exclusively, so a MediaStore-fed total would advertise photos the grid cannot render during ingestion — breaking "one month, one number" (codex r2; the disjoint union `max(msTotal + rescued, dbAlive)` was the earlier shape). The ingestion gap shows as the day scopes' "still being analyzed" line.
4. `progressPager` gains one more fetcher: the DB's rescued rows (`exif_checked_mod_time IS NOT NULL AND day IS NOT NULL`, alive) sorted `taken_at DESC`, de-duplicated against the MediaStore streams' undated-tail copies.
5. `day` (nullable) travels alongside `taken_at` through `PhotoFacts`, `getPhotoQueueFacts`, `GridPhotoRow` and `ViewerItem`; the viewer top bar and the editor date line render **Unknown day** on NULL, never `Today · <mtime>`.
6. Bounded month scopes key on the indexed `day` column (`substr(day,1,7)`, the histogram's own pattern); `day IS NULL` matches no month — the Unknown-day pseudo-day is its home.

**The LEFT JOIN rewrite of `getStateCountsInScope` rides along**: its agreed condition ("take it only if the counts work touches this query") is now a verified fact — change 6 rewrites that query's WHERE head.
Its before/after is measured on device, per the original entry.

**Both regression pins land as tests**: one month scope prints one number across header, chips and grid; and the same photo renders under `Unreviewed` as under `Kept`.
Device fixtures are already in place (S23 `NOEXIF_undated.jpg`, the mtime-touched NEF, the `afterglow-api30` AVD).

**F8**: the histogram's binary settled/scroll-to-end guard is replaced by two branches that both run on remount: no selection → scroll to recent; selection → scroll to keep the selected bar visible.
Bar positions are pure arithmetic (fixed 14 dp columns, 16 dp undated gap, 2 dp padding); the viewport arrives via `onLayout`.
**(autonomous)** centering vs minimal-scroll and animation choice are settled on device and stated in the appendix.

## 8. History tombstones (D9)

The feed's photo stream opens to decided `is_present = 0` rows and trashed rows.
They render as placeholder tiles: grey cell, verdict badge, original date — no thumbnail load attempted.
The **Trashed** chip joins Kept and Staged; tombstones also appear under All and any applicable filters.
Two implementation guards: the per-page MediaStore reconcile (which drops externally-gone rows fail-closed) must **skip placeholders** — they are expected-gone; and tapping a placeholder opens no viewer (there is nothing to show) — **(autonomous)** what a tap does instead (a facts sheet, or nothing) is settled during implementation.

## 9. The deck notes (N1, N2, the unify)

- **N1 (D11)**: `decideCurrent`'s advance predicate becomes "the verdict changed to a different decided verdict, or was fresh". `redecide` is untouched.
- **N2**: `BigButton` gains the `dimmed`/`disabled` split `ActionChip` got in m0.8.5. The finish button's **look** tracks durable state only (`finishCount === 0`, `inert`, its own `finishing`); the shared `busy` stays in the invisible press lock.
- **The browse-swap unify**: the two control-row branches merge into one block whose per-control state (visible, dimmed, disabled, label) derives from the unit's view state.
  The `finishing` escape-clause flash dies with the swap: there is no longer a whole-row swap to flash.

## 10. The zoom port (D12 — built; the lift was reversed in the closing grilling)

A provisional lift was reversed by Tristan in the closing grilling (2026-08-18): the port ships in m0.8.6.
The design: port react-native-zoom-toolkit's touch-position math — translation derived from the fingers' absolute focal position each frame, continuous across finger-set changes — into the existing inline worklets on all three zoom surfaces (deck, PhotoViewer, Compare).
Hard constraints stand: no host `GestureDetector`, no `runOnJS`, callbacks inline in the gesture configs, state in shared values.
The engagement rule (one contiguous two-finger stretch) and momentum decay are kept; only the pan's translation source changes.
Feel acceptance is §13 check 22, on human thumbs.

## 11. Implementation phases

Each phase lands with its tests and its doc edits, and is committed on `initial`.

| # | Phase | Contents |
|---|---|---|
| 1 | Rescued dates and Progress | §7: the six changes, the LEFT JOIN rewrite with its measurement, both regression pins, F8. |
| 2 | The freeze | §5.1: the new predicate, deleted contagion, rewritten tests, doc updates. |
| 3 | The star retirement and Compare's keep | §5.2–5.3: the sweep, the schema drop, "Keep this one". |
| 4 | The state editor | §4: verdict control, four action rows, refusals, the D5 duel deletion, the day-honest date line (needs phase 1's `day` plumbing). |
| 5 | The Timeline | §3: rename, filters, the browse read path, the perf measurement. |
| 6 | History tombstones | §8: feed predicates, placeholder tiles, the Trashed chip. |
| 7 | Share resolution | §6: the native callback, the schema, discard semantics, the Shared chip. |
| 8 | The deck notes | §9: N1, N2, the browse-swap unify. |
| 9 | The zoom port | §10. Built — the provisional lift was reversed in the closing grilling. |

## 12. Testing strategy

Top-down, per the repo's standard.

**Unit (pure logic).**
The new `windowFreeze` table (every rule, the D4 whole-group cases, the duels-only metadata set).
The browse-unit assembler: run assembly across page boundaries, day splits, group interleaves, cursor round-trips.
N1's advance predicate over all prior-state × target pairs.
The Timeline filter pref parse (unset, garbage, each value).
`editorActions`' new matrix: every verdict × action-state combination offers exactly the honest set.
The share lifecycle transitions, discard included.

**Integration (seeded DB).**
The two rescued-date regression pins, as SQL-level assertions against the shared fixture corpus: one number per month scope; engine-independent membership.
The D5 deletion: an editor un-review removes all the group's duel rows in one transaction, and the next `windowFreeze` reports the group rebuildable.
Editor verdict writes route through the provider and credit the goal exactly once (the once-per-day rule).
Browse-read pagination: deep pages keep global newest-first order with no duplicate and no dropped unit.
Tombstone feed: forget-keep and trashed rows appear with their verdicts; the reconcile skips them.
The star sweep: no test asserts the removed interface stays unsupported — the star's tests are deleted with it.

**Emulator (`afterglow-api30`).**
The rescued-date fixtures walk (the NOEXIF photo, the touched NEF): Unknown day in viewer and editor, one number per month.
Fresh-install Timeline first-launch state (Unfinished).

**Device (S10e, S23).**
The §13 acceptance list, the browse-query and LEFT JOIN measurements, and the Samsung share-sheet callback check.

## 13. Human acceptance pass — the m0.8.6 checklist

Run on the S10e unless a check names another device.
Every check names its screen, the steps, and what pass looks like; no check requires reading any other document.

Terms used below:
**the Timeline** = the card list behind Home's "N to review" breakdown (tap the numbers under the green button; this release renames it from "Review");
**the deck** = the review screen the green *Continue reviewing* button opens;
**the state editor** = the sheet that opens from a photo's tile in Progress or History (tap a photo, then the state row in the panel);
**Progress** = Home → the Progress card; **History** = Home → the History card;
**a placeholder tile** = a grey cell with a verdict badge and a date, standing in for a photo whose bytes are gone.

### The Timeline (F2)

1. **A finished group can be found again** *(machine-checked: reviewed units render under Everything on the S10e; confirm by eye)*.
   Timeline → review any group to fully kept → Home → reopen the Timeline → switch the filter to *Everything*.
   Pass: the group you just finished is in the list, rendered like any other card.
   Fail: the group is gone (0.8.5's behaviour — the original F2 report).
2. **The filter is remembered** *(machine-checked: the browse pager re-fired under a fresh process after a force-stop)*.
   Set the filter to *Everything*, force-close the app (Recents → swipe away), reopen, return to the Timeline.
   Pass: *Everything* is still selected.
3. **Unreviewed only hides queued work.**
   Stage a cull on a single (deck: Cull), then set the filter to *Unreviewed only*.
   Pass: that photo's row is absent; units that are nothing but staged culls are absent; every visible unit contains at least one undecided photo.
4. **Deep scroll under Everything** *(machine-checked: pages load on scroll, 40 items in 60 ms each on the S10e)*.
   With *Everything* selected, scroll down through at least three screens of history.
   Pass: cards keep loading, dates run strictly newest-first, no card appears twice, no visible jump or reshuffle as pages arrive.
5. **Continue reviewing ignores the filter.**
   With *Everything* selected and reviewed units at the top, press Home's *Continue reviewing*.
   Pass: the deck opens on undecided work, not on a reviewed unit.

### The state editor (F9)

6. **The regroup round-trip — the release's reason to exist.**
   Pick a group of 2 kept photos (reviewed earlier, no Compare involvement) plus a third similar photo left unreviewed.
   Progress → open each kept photo → state editor → set the verdict to *Unreviewed* (both photos).
   Settings → GROUPING → loosen strictness one step → let the scan run (Home shows it).
   Pass: the Timeline now shows the photos regrouped (possibly all three together); no error, no stuck frozen group.
7. **Un-reviewing a compare'd group warns, then works.**
   Pick a group that went through Compare (its members were decided via a duel).
   State editor → set one member to *Unreviewed*.
   Pass: the confirm names the Compare-history deletion before writing; after confirming and a rescan, the group is rebuildable (check 6's behaviour).
8. **Every action is addable and removable** *(machine-checked on the S10e: favourite add/cancel round-trip, all four rows render with honest statuses; walk the rest by hand)*.
   On a kept photo, in the state editor: add an edit, remove it; add a favourite, remove it; add it to the share queue, remove it; add an organize move (the album picker opens), remove it.
   Pass: each add shows its badge/queue effect immediately; each remove returns to the prior state; the four queue tabs' counts follow.
9. **An applied favourite is removable.**
   On a photo whose favourite was applied (heart badge at the quiet weight), state editor → remove the favourite.
   Pass: the heart-off badge appears (queued removal); after the queue processes, the gallery no longer shows the heart.
10. **The refusals are the honest three.**
    Open the state editor on: a trashed photo (History → a trashed row), a photo with an applied organize move, a photo already shared.
    Pass: each shows its explanation and no control that would claim the impossible; everything else on those photos stays editable.
11. **An undated photo never claims Today (change 5)** *(the pin is test-locked at the store layer; the S23 eyes-on walk stayed manual — the fixture card sits deep in the timeline)*.
    On the S23: open `NOEXIF_undated.jpg` (DCIM/SpikeRAW) in the Progress grid's viewer and its state editor.
    Pass: both read *Unknown day* — no date, no confident clock derived from file times.

### Progress numbers (the rescued-date pins, F8)

12. **One month, one number.**
    On the S23: Progress → tap the NEF fixture's real capture month in the histogram.
    Pass: the header count, the chip counts and the number of grid tiles agree — one story, not three.
13. **The engine cannot hide a photo.**
    Same month scope: flip the state filter between *Unreviewed* and *Kept*.
    Pass: the rescued NEF renders under both exactly when its state matches — never present under one filter and missing under the other.
14. **The histogram keeps your month (F8).**
    Progress → tap a month near the middle of the chart.
    Pass: the tapped bar stays visible (the chart may scroll to keep it so).
    Leave Progress, return with the month still selected.
    Pass: the selected bar is visible again — not stranded far left (0.8.4's behaviour).

### History (D9, D10)

15. **Trashed work stays on the record** *(machine-checked: two executed culls appear under the Trashed chip; confirm the tile look by eye)*.
    Cull a photo, confirm the trash. History → *Trashed* chip.
    Pass: the photo appears as a placeholder tile — grey cell, its verdict badge, its original date.
16. **A forgotten card's work stays too** *(only if a disposable SD card is at hand — test data only)*.
    Settings → the card's source row → *Forget this card* (keep stats).
    Pass: its decided photos appear in History as placeholder tiles with their verdicts and dates; lifetime stats are unchanged.
17. **"Shared" means an app was chosen** *(machine-checked on BOTH Samsung sheets: a Drive pick fired the chosen broadcast and made the one Shared row on each phone; the S10e's dismissed sheet was swept — "1 abandoned share sheet(s) discarded" — with the photo still queued)*.
    Share queue → share a photo → pick any app in the sheet (e.g. Gmail; sending can be cancelled inside the app).
    Pass: History's *Shared* chip shows the batch.
    Then share another photo and dismiss the share sheet with Back instead of choosing.
    Pass: no History row appears, and the photo is still in the share queue.
    Run this check on the S23 as well (Samsung's share sheet must fire the same signal).

### The deck (N1, N2, the unify) and Compare (D7)

18. **A changed decision advances; an undone one stays (N1)** *(machine-checked: fresh keep 1/13→2/13, undo stays at 1/13, kept→cull advances 1/13→2/13)*.
    In a deck: Keep a photo, swipe back to it, tap Cull.
    Pass: the pager advances to the next photo.
    Then on another photo: Keep, then tap Keep again (undo).
    Pass: the pager stays put.
19. **The finish button minds its own business (N2).**
    In a group deck, watch *Keep remaining (N)* while tapping an action chip (e.g. Favourite) and while deciding another photo.
    Pass: the big button never dims or flickers for work that is not its own; it still dims when the remainder is empty and greys during its own write.
20. **A singles finish never flashes the browse row** *(machine-checked: the gate's frame-level finish-advance probe passed against the unified block)*.
    In a singles deck, press the finish button and watch the control area during the advance.
    Pass: the controls swap once, cleanly, to the next unit's; no one-frame appearance of the browse Keep/Cull row.
21. **Triage keeps, without a star.**
    In a group with 3+ undecided members, open Compare.
    Pass: the per-side button reads *Keep this one* in green; tapping it keeps that photo (its badge shows in the deck), the other photo is untouched, and no star appears anywhere in the app — deck, cards, viewer or Compare.

### The zoom port (only if phase 9 ran)

22. **A walking two-thumb pan is smooth.**
    Zoom deep into a photo, then shove it around with both thumbs, letting fingers land and lift alternately.
    Pass: the pan follows continuously through finger changes — no hiccup at each land/lift.
    Fail: the stutter of 0.8.5 — then say so; the phase is liftable and the release ships without it.

## 14. Autonomous decisions

Judgment calls made without Tristan.
Planning-stage flags are marked **(autonomous)** inline above (route-rename mechanics §3.1; browse page size and cursor §3.2; F8 centering §7; placeholder tap §8; share grace window §6).
Each becomes a numbered entry here as it is implemented, alongside any new judgment calls made mid-build; getting entries vetted is a top priority, and an approved entry is pruned per the assumptions discipline.

| # | Call | Tier |
|---|---|---|
| 5 | §3.1: the route renamed `Groups` → `Timeline` outright (type, App.tsx, both HomeScreen doors; no alias — pre-v1, no deep links exist). | Read |
| 6 | §3.2: browse page sizes — 40 merged items per list batch, singles fetched 120/page, groups 40/page; cursors are (taken_at, asset_id) for singles and the SQL-minted (anchor, group id) for groups. First page measured 270 ms on the 27k S23, ~223 ms per later fetch round, buffered pages ~1 ms. | Measured |
| 7 | §6: the abandonment sweep runs 2 s after foreground return and only discards sheets opened ≥ 5 s ago; startup recovery is unbounded. Vetted as G7 in the closing grilling. | Approved (G7) |
| 8 | §7: F8's scroll is minimal-scroll (null when the bar is visible), un-animated. Vetted as G1. | Approved (G1) |
| 9 | §8: a tombstone row is inert — disabled, outside the viewer's item list. Vetted as G6. | Approved (G6) |
| 1 | §10: the pan focal reads the touches' ABSOLUTE (window) coordinates, not view-local x/y — the gesture's view is carried by the very translation the pan drives, so local coordinates move under a motionless finger (a feedback loop). Deltas are frame-independent, so the window frame serves. | Assumed (from RNGH's TouchData shape; not device-measured) |
| 2 | §10: touch-set changes are detected by `onTouchesDown`/`onTouchesUp` forcing a re-anchor (tracking reset to `PAN_TRACKING_START`), with `panFrame`'s per-move-frame touch-count comparison as the safety net for a lift-and-land swap between two move frames. Mirrors `pinchFrame`'s count rule. | Assumed |
| 3 | §10: translation only applies while the pan handler is ACTIVE (`event.state` on the touch event) AND the photo is zoomed; every other move frame re-anchors continuously, so the activation threshold and a mid-stream zoom engage without a jump. | Assumed |
| 4 | §10: `averageTouches: true` stays on all three pans — it no longer feeds translation, but the release `velocityX/Y` the decay keeps (per the design) is still computed over the averaged pointer. | Assumed |
