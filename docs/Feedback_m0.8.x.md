# Tester feedback — the m0.8.x line

Round of 2026-07-31 (Tristan, S23 + S10e on shipped m0.8.4): twenty items, organised into three releases with the TODO work each one naturally carries.
Every item keeps its round number (F1–F20) for traceability; the release sections are the authoritative grouping.
This doc covers three releases, so it is named for the LINE rather than one version — delete it when m0.8.7 ships.

Evidence tiers are marked per claim: **reported** (tester saw it), **read** (established from the code, not yet reproduced), **measured** (run on a device).
An item whose cause is only **read** must be reproduced before its fix is written — a fix aimed at the wrong cause passes review and fails on the phone.

---

## The releases

| | Release | What it is | Items |
|---|---|---|---|
| **m0.8.5** | the review loop | Everything you touch while actually reviewing: the deck, the goal moment, and the accent that four of those surfaces misuse | F1 F3 F4 F5 F6 F7 F13 F17 · TODO "accent", "non-review celebration counter" |
| **m0.8.6** | the browsing surfaces | Going back to look at something: Timeline, Progress, History, and editing a photo's state from any of them | F2 F8 F9 F16 · TODO "rescued-date scope", "tombstone rows", the star/Compare knot |
| **m0.8.7** | sources, badges, and the queues | Where photos come from, what they wear, and the four queue screens behaving alike | F10 F11 F12 F14 F15 F18 F19 F20 · TODO "action-layer coherence", "type-scale and token pass" · [Errors_design.md](Errors_design.md) |

Each release is one subsystem, so each gets one device pass and one review cycle rather than three overlapping ones.
m0.9 (Videos) is unchanged and follows.

---

## Decisions settled before planning (2026-07-31 grilling)

| # | Decision | Choice | Why |
|---|---|---|---|
| L1 | The line's shape | **Three releases**, subsystem-aligned | Two releases would put the Timeline, the state editor, the badge family and the deck refactor into one review cycle; four would isolate the Timeline at the cost of an extra tag's ceremony for a screen that shares its query family with Progress. |
| L2 | The regroup boundary vs un-reviewing (F9) | **Un-reviewing UNFREEZES**: the freeze follows a photo's CURRENT state, not its state history | This is m0.8 decision 5 reopened in the narrow direction only. Without it F9 ships the buttons and not the outcome: setting two kept photos back to `unreviewed` would still leave them frozen, so a looser threshold could never regroup them. Accepted cost: un-reviewing one member of a finished group makes that group rebuildable — which is arguably what un-reviewing means. |
| L3 | Source scope vs the queues (F18) | **Scope, not state — everywhere** | m0.8.3 already answered this for cards (docs/STATE_MODEL.md); source selection is the second scope axis and gets the same rule, so the app has ONE answer instead of one per queue. Deselecting a folder writes nothing; re-adding restores byte-for-byte. |
| L4 | The deck's navigation model (F6) | **One deck, unit as state** | `navigation.replace('Deck', …)` per unit is the remount. Removing it kills the flicker, the image re-decode, the strip reset and the celebration race in one change. Needs its own back-stack pass (Android back must still exit through Home). |
| L5 | Gallery favourites (F20) | **Reconcile only — read, don't log** | The scan reads `IS_FAVORITE` and projects it as a CARRIED favourite action. No schema change. The favourite EVENT LOG stays parked, narrowed to what the reconcile does not answer. |
| L6 | Badge configurability (F19) | **One global toggle, no per-badge settings** | The two new badges join the shared vocabulary and a single control hides all badges for a clean look at the photo. Per-badge switches were rejected as a settings row earned by a guess; if the cluster still feels noisy afterwards, that is a complaint with evidence behind it. |
| L7 | What the Timeline opens on (F2) | **Remember the last filter**; first launch opens Unfinished | No fixed default survived scrutiny — "unfinished" hides the thing F2 exists to expose, "everything" buries the daily list. The screen restores what you last chose, and "Continue reviewing" anchors to the first PENDING unit regardless of filter. |
| L8 | Parked design passes | **Accent → m0.8.5; the star/Compare knot → m0.8.6** | Both land where their surfaces are already open: the accent's six sites are inside m0.8.5's blast radius, and the star's regroup-freeze role has to be re-decided in the same release as L2 anyway. |

---

## m0.8.5 — the review loop

The release you feel while reviewing.
Its largest piece is L4; everything else is small enough to ride along, and all of it wants the same device pass.

### F6 · "Keep remaining" flickers, and every unit remounts the deck

**Reported:** pressing *Keep remaining* makes the button vanish, the layout reflows, the photo jumps larger, and the group-advance animation runs over the top — too fast to read as anything but jank.
**Read:** two independent causes.
The button is conditionally rendered, so completing the unit removes it and the stage grows into the space.
The advance itself is `navigation.replace('Deck', { groupId })` ([DeckScreen.tsx:195](../apps/mobile/src/screens/DeckScreen.tsx#L195), and again at :578, :591, :640, :649, :706) — a full unmount/remount per unit, which re-decodes the image, resets the thumbnail strip and the zoom overlay, and re-runs every load.

**Fix (L4).** The deck holds the current unit in state and advances internally; the route is entered once.
`destinationAfterUnit` keeps deciding WHERE to go — only the mechanism of getting there changes, and a destination that leaves the deck entirely (`CullList`, a day page) still navigates.
*Keep remaining* stays mounted and disables rather than disappearing.

**What this must not break** — each needs a check in the release's acceptance list:
Android back still exits through Home (`backBehavior="initialRoute"`, m0.8.2 F1); browse/re-decide entry from the Timeline and DayProgress still lands on the right unit; a day deck (no range) still returns to its day page when finished; `releaseBrowseIds` still fires on Home focus.

### F4 · The goal moment passes before you see it

**Reported:** the vibration lands, but the group finishes and the deck advances before the celebration registers.
**Read:** `GoalCelebration` is non-blocking and self-dismissing, and the advance is a `navigation.replace` — so the overlay is torn down with the screen it was drawn on.
L4 removes the teardown, which is what makes a pause implementable rather than a fight with the navigator.

**Fix.** On a crossing decision, hold the completed unit for the celebration before advancing.
Open: whether the hold is a fixed duration or dismisses on tap (a fixed hold that outlasts your reading is worse than one you can tap past — decide on the device, not on paper).
The hold applies to the crossing decision only; every other unit completion advances as it does now.

### F5 · Raising the goal past today's count does not re-celebrate

**Reported:** raising the goal to a number above today's count should drop today from the streak and celebrate again when the new number is reached.
**Read:** the streak half already behaves correctly — `goalStreaks` scores every day against the CURRENT goal ([dailyGoal.ts:124](../apps/mobile/src/lib/dailyGoal.ts#L124), and the header states the retroactive-recolour choice deliberately), so today stops counting the moment the goal moves above it.
Only the celebration is stuck: `goal_celebrated_day` stores a DAY, so once today is marked celebrated no later crossing can fire.

**Fix.** Store the goal VALUE alongside the celebrated day; a crossing fires when the day differs OR the goal is higher than the one celebrated.
Lowering the goal must NOT re-arm it — sailing past an already-reached goal was never a moment (`shouldCelebrateGoal`, m0.8.2 F14).

### F3 · "All reviewed" appears while the library is still being scanned

**Reported:** the button is disabled and reads *All reviewed* during a scan, then seems to enable at random.
**Read:** the label and the disabled state hang off `queueTotal === 0` alone ([HomeScreen.tsx:948-953](../apps/mobile/src/screens/HomeScreen.tsx#L948-L953)); a running scan fills the queue in bursts, so the button flips as each write lands.
The randomness is the scan's write cadence.

**Fix.** A scan in progress with an empty queue is not "all reviewed" — it is "not known yet".
Home already has the scan status (`ScanStatus`, with a percentage during a full pass), so the button takes a third state that says so and stays disabled without making a false claim.
Copy is part of F15's audit.

### F1 · The clear streak reads like the goal streak

**Reported:** `🔥 N-day clear streak` on the Keeping-up card is the same emoji and sentence shape as `🔥 N-day streak` one card above, and the difference is not readable.
Suggested: *last 25 days fully reviewed*, different emoji.
**Read:** both are rendered on Home ([HomeScreen.tsx:944](../apps/mobile/src/screens/HomeScreen.tsx#L944) and the Keeping-up card above it); the coverage streak counts consecutive cleared SHOOTING days, and empty days pass through without breaking or extending it (`lib/coverageGoal.ts`).

**Fix.** New copy and a distinct emoji, with the caveat that *"last N days"* is not literally true — the streak counts shooting days, so the sentence must convey that without a lecture.
Stats' coverage caption already says *"N of M days fully reviewed"*: settle one family of words across Home and Stats while both are open.

### F7 · The thumbnail strip does not follow the photo you are on

**Reported:** reviewing a long singles run, the strip stops tracking after roughly the 7th photo — the thumbnail for the current photo is off-screen.
**Read:** confirmed in the code.
The strip is a plain `ScrollView` with no ref and no programmatic scroll ([DeckScreen.tsx:1107](../apps/mobile/src/screens/DeckScreen.tsx#L1107)), while the pager itself does scroll to the cursor (:725, :742).

**Fix.** Scroll the strip to keep the current thumbnail visible, moving BEFORE it would leave the viewport rather than after.
It must not fight a manual scroll (the same trap the histogram fell into — see F8).

### F17 · The deck's time badge names a time but not a day

**Reported:** add a date, or fold the date into the existing time badge.
**Read:** the badge prints `formatClockPrecise(current.timestamp)` only ([DeckScreen.tsx:1092-1096](../apps/mobile/src/screens/DeckScreen.tsx#L1092-L1096)).

**The honesty constraint, and why it costs nothing here.** For an undated photo `taken_at` is the mtime fallback, so adding a date would turn a soft claim into a confident lie — exactly the defect TODO's rescued-date entry documents on two other surfaces (change 5, m0.8.6).
The deck is already safe: `ReviewMemberRow` carries `day` ([store.ts:753-769](../apps/mobile/src/db/store.ts#L753-L769)), so the badge can render the day key and say *Unknown day* when it is null — no new plumbing.
**Render from `day`, never from `taken_at`.** m0.8.6 then fixes the two surfaces that lack the same field.

### F13 · Action chips stay live on a photo staged for cull

**Reported:** Edit, Favourite, Organize and Share are not greyed out on a photo staged for cull.
**Read:** the deck already disables all four (`disabled={busy || currentState === 'culled'}`, [DeckScreen.tsx:1201-1219](../apps/mobile/src/screens/DeckScreen.tsx#L1201-L1219)); **Compare does not** — its chips gate on `busy` alone ([CompareScreen.tsx:706-786](../apps/mobile/src/screens/CompareScreen.tsx#L706-L786)).

**Fix.** Compare's chips take the deck's rule.
Reproduce first to confirm Compare is the surface the report came from; if the PhotoViewer's panel shows the same, it takes the rule too.
This is the visible half of a rule already in the model: a staged cull's actions demote to `carried` and leave every queue (`livePhotoClause`).

### TODO promotion · The accent must stop carrying meaning

The full entry (six sites, CIE76 ΔE 6.5–26.3 from reserved hues, measured) moves here from `docs/TODO.md` under L8.
Four of the six — the goal ring, the Keeping-up bar, the Stats coverage markers, the 30-day activity bars — are surfaces F1, F3, F4 and F5 already open, all running the same *accent until the goal, then keep-green* pattern that nearly merges on the Green accent.
Proposed shape (from the TODO): progress displays go keep-green throughout with completeness shown by STRENGTH rather than hue, and the activity bars lean on the grey goal line the card already draws.
**The star is NOT part of this release** — it is the sixth site, and its fate belongs to m0.8.6's knot.

### TODO promotion · Non-review surfaces and the celebration counter

`noteDecisions` is wired to every deck and Compare path; verdicts written from the PhotoViewer's state editor, History re-decides, or Home's detection flows do not note, so a goal crossed there celebrates on the NEXT deck decision.
Decide it here, where the celebration is already being changed — and note that m0.8.6's F9 makes the state editor a MUCH more likely place to cross a goal than it is today, which is what turns this from a curiosity into a defect.

---

## m0.8.6 — the browsing surfaces

Going back to look at something you already reviewed.
One query family (Timeline, Progress grids, History), one editing sheet over all three, and the star knot that sits in the middle of them.

### F2 · The review overview hides fully reviewed units

**Reported:** *Continue reviewing* → review a group → want to go back to it → Home → the chevron in the main card → the group is gone.
Staged culls still show; fully kept units vanish.
**Read:** the overview renders the PENDING timeline — `listReviewGroups` requires a group to still hold an `unreviewed` member, and the singles feed keeps only pending rows.
Day pages do list completed groups, but nothing in that flow points there.

**Fix.** The full timeline: every group and singles run, newest-first, paged, with filters that peel back to today's view — and the screen renamed **Timeline** (`GroupsScreen`).

| Filter | Shows |
|---|---|
| Unfinished | Today's behaviour: units with pending work, staged culls badged |
| Everything | Every unit, reviewed included |
| Unreviewed only | Hides queued items too |

**Per L7** the last choice is remembered; first launch opens Unfinished; *Continue reviewing* anchors to the first PENDING unit whatever the filter shows.
**The real work is the query.** The pending feed is bounded by construction; an unfiltered timeline over a 27k corpus is a different, bigger query, and `lib/timeline.ts`'s horizon truncation (`TimelinePageTails`, carried through optimistic patches) was built around a bounded read.
Paging and its interaction with the optimistic patches is the design risk in this release.

**Watch what "Everything" exposes.** A sparse-photo stretch produces one card and one one-photo deck per day — dozens at the head on both phones, device-observed.
Today only the pending ones are visible; showing everything multiplies them, so this filter is the surface most likely to fire the trigger on `docs/TODO.md`'s "Coalesce tiny singles runs?" (settled as keep-as-is, pending tester complaints about ceremony).
Design the filter so a run of one-photo days reads as one line of the list rather than dozens, or accept it and let the trigger fire honestly — but decide it here rather than discovering it on the device.

### F9 · A photo's state is barely editable outside review

**Reported:** selecting a photo in Progress or History hides everything behind *Change decision*, and the only decision offered is "mark edit".
Wanted: add or remove any state.
Stated use case — loosen grouping, set two kept photos back to unreviewed, and see whether they now group with the already-unreviewed one.
Accepted asymmetry: once something is queued AND actioned, there is no going back.
**Read:** `editorActions` returns one action per verdict — `culled` → un-cull, `kept` → queue-or-complete an edit, everything else read-only ([progress.ts:187-197](../apps/mobile/src/lib/progress.ts#L187-L197)).

**Fix.** The editor becomes the state model made touchable: one verdict (`unreviewed`/`kept`/`culled`) and every action independently addable and removable, on the same photo, in the same sheet.
The refusals must be the honest ones and nothing more — `trashed` is the OS's, an APPLIED organize move already happened, and a share pass already left the device.
An applied favourite is removable (the app already models a queued un-favourite with its own heart-off badge), and F20 makes that state readable from the gallery in m0.8.7.

**L2 is what makes it work.** The regroup boundary freezes on state history; setting a photo back to `unreviewed` must return it to the scan's reach, or the use case above cannot happen.
Narrow change only: the freeze predicate reads current state.
Reviewed-and-still-reviewed groups stay frozen exactly as now.
Also verify: `StateEditorSheet`'s date line reads `dayKey(photo.takenAt)` ([StateEditorSheet.tsx:118](../apps/mobile/src/components/progress/StateEditorSheet.tsx#L118)) — the same `taken_at`-not-`day` defect change 5 below fixes.

### F8 · Selecting a month scrolls the histogram away from the month you picked

**Reported:** tapping a month in Progress scrolls the chart hard left, so the selected month is off-screen.
**Read:** the guard causes it.
`settled` suppresses the open-at-recent scroll whenever a month is selected ([ProgressView.tsx:161-183](../apps/mobile/src/components/progress/ProgressView.tsx#L161-L183)) — written to stop the chart jumping back to today and stranding the selection.
On a reload the ScrollView starts at offset 0, the early return fires, and it stays there: far left.

**Fix.** Scroll to keep the SELECTED bar visible rather than choosing between "recent" and "don't move" — which satisfies both the original constraint and the report.

### F16 · "Sheet opened" is not a phrase anyone recognises

**Reported:** what is the *Sheet opened* filter in History?
**Read:** it filters to photos in a share batch that reached `sheet_opened` ([HistoryScreen.tsx:45](../apps/mobile/src/screens/HistoryScreen.tsx#L45)) — an internal state name on a user-facing chip.
The state is honest (we know the sheet opened; we cannot know what the user then did with it), but "Sheet opened" states the mechanism instead of the meaning.
**Fix.** Rewrite the label; keep the honesty.
Part of F15's audit, done here because it is a History chip.

### TODO promotion · A rescued photo's date does not reach the Progress library scope

Moves here whole from `docs/TODO.md` — **fully investigated, agreed, and ready to implement**: six changes (bounded month grid pages SQLite; unbounded grid takes `takenAt` from the DB join; header denominator takes Home's disjoint union; `progressPager` unions rescued rows; the undated-and-unrescued surfaces stop printing `Today · <mtime>` in BOTH the viewer and the state editor; bounded month scopes key on `day`, not `taken_at`).
Two regression pins, both from real screens: a month view printing three different numbers must print one; and a month view must render the same photo under `Unreviewed` as under `Kept`.
Device fixtures for it are already in place (S23 `NOEXIF_undated.jpg`, the mtime-touched NEF, the `afterglow-api30` AVD).
It belongs in this release and not m0.8.5: five of its six changes are Progress-surface changes, and change 5 is the same date-honesty rule F17 applies to the deck.

**The other parked SQL cost comes with it** (from `docs/TODO.md`, "Two measured SQL costs").
`getStateCountsInScope` evaluates a correlated EXISTS per row in scope — 22 ms whole-corpus, measured, once per Progress open.
Changes 1, 3 and 6 rewrite what Progress counts and how a month scope is keyed, so the query is open on the table anyway; the LEFT JOIN rewrite is straightforward and has simply never been measured against real device latency.
Take it only if the counts work touches this query — a rewrite bolted on separately buys 22 ms and costs a review.

### TODO promotion · History tombstone rows

The feed requires `is_present = 1`, so Forget-keep tombstones keep every stat and drop out of the scrollable feed.
Absent decided photos stay in the feed as a placeholder tile (grey cell, verdict badge, original date).
Still to design: the tile treatment, whether trashed rows join (same gap), and the filter story.

### TODO promotion · The star knot: best-of-group, and keeping from a triage duel

Three TODO entries are one decision and settle together here (L8), because the star's regroup-freeze role has to be re-decided in the same release as L2:

- **Does "best of group" still earn its place?** The star is an ANNOTATION that also freezes its group against regrouping (`lib/regroupBoundary.ts`) and is drawn in the accent — the sixth site of m0.8.5's accent problem, and the worst, sitting in a badge cluster beside the organize badge at ΔE 6.5 on Amber.
- **Retire it in favour of a plain Keep?** Marking best is the only positive act a triage duel offers, and it pulls toward the cull dialog rather than a keep.
- **Compare: keeping photos in TRIAGE mode.** With 3+ undecided members a duel is verdict-free by design, so Compare offers no way to KEEP there.
Tristan found the pull-toward-culling acceptable but wants a keep path.

If the star survives it takes a fixed hue of its own; if it goes, the freeze needs a new home — and L2 has just changed what the freeze means, so this is the cheapest moment to decide it.

---

## m0.8.7 — sources, badges, and the queues

Where photos come from, what they wear, and the four queue screens behaving like one another.

### F18 · Cull-queue photos survive their source being deselected

**Reported:** removing a folder from the sources leaves its photos in the cull queue; they should hide, the way an ejected SD card's do, and return if the folder is re-added.
**Read:** `getStagedCulls` scopes to MOUNTED volumes but takes no source predicate ([store.ts:217-236](../apps/mobile/src/db/store.ts#L217-L236)).

**Fix (L3).** Source selection becomes a scope axis exactly like mount state: deselecting writes nothing, the photos leave the cull list, all four queues, every count and the forecast pool, and re-adding restores them byte-for-byte.
History and lifetime stats stay unscoped — completed work is fact wherever it came from.
**The work is the audit, not the predicate:** every queue read and every bulk action's binding under the M5 rule (bulk actions bind to what was rendered and reachable; a fresh read may only shrink them).
`docs/STATE_MODEL.md` gains the second axis.

**One parked cost stops being parked here** (from `docs/TODO.md`, "Two measured SQL costs", m0.8.1 rounds 5-7).
`sourceClause` builds a leading-wildcard `LIKE` per root, which can never use an index (`db/store.ts:124-140`) — tolerable today because it is always a SECONDARY filter on rows an index already fetched.
This item adds it to reads that skip it today, including the cull confirm loop, so measure the queue reads on the S10e before and after; if it bites, the fix shape is known (a normalized `source_root` column) but it is a schema change and therefore its own decision.

### F19 + F14 · The badge family

**Reported:** F19 — a badge showing the source folder (last folder name only), with a way to hide badges.
F14 — Group Review needs an SD-card badge.
**Read:** badges are one shared vocabulary (`lib/photoBadges.ts` + `DecisionBadge`/`BadgeCluster`) drawn identically by deck, grids, History and queues, so both new badges are one change across every surface.
SD-card membership is named today on group cards and deck headers as a COUNT of hidden unreachable members ("· N on unmounted SD card") — F14 asks for it per photo, which is a different fact and a new badge.

**Fix (L6).** Add source-folder and SD-card badges to the shared vocabulary, and ONE control on review surfaces that hides all badges for an unobstructed look at the photo.
No per-badge settings.
Open: whether the hide control is durable or a session-level peek — decide with the control in hand.

### F10 · The SD-card tag does not align between folder rows

**Reported:** measured by eye on the S10e while scrolling the source picker — the tag sits at different horizontal positions on different rows.
**Read:** not yet located; the tag is composed from `sources.ts`' display-name helpers ([sources.ts:222-231](../apps/mobile/src/lib/sources.ts#L222-L231)) and rendered per row in `SourcePickerScreen`.
Reproduce on the S10e first — a layout defect diagnosed from source is a guess.

### F11 · Selecting a folder shifts the rows around it

**Reported:** the selection outline changes the layout of neighbouring folders.
**Read:** the STATE_MODEL selection language is an outline, never a fill — an outline added on selection adds its width to the box unless the unselected state already reserves it.
Fix by reserving the space in both states (transparent border), so selection changes colour only.

### F12 · The picker shows nothing before the folders arrive

**Reported:** show loading until folders are listed.
**Read:** the screen already has an `ActivityIndicator` and a *Listing photo folders…* line ([SourcePickerScreen.tsx:341,369](../apps/mobile/src/screens/SourcePickerScreen.tsx#L341)), so the report is about a state those two do not cover — most likely the frame before the catalog load starts.
Reproduce, then make the loading state the DEFAULT rather than a state entered on the way.

### F15 · Copy audit: singular strings in plural situations

**Reported:** the source picker says *Use this source* when several are selected ([SourcePickerScreen.tsx:432](../apps/mobile/src/screens/SourcePickerScreen.tsx#L432)) — audit the app for every other place a count makes the copy wrong.
**Fix.** One pass over user-visible strings for count agreement, sweeping the whole class rather than the one instance.
Two known members are fixed in their own releases where the surrounding work already opens the file — F3's scanning state (m0.8.5) and F16's *Sheet opened* chip (m0.8.6) — and both must be re-checked by this audit rather than assumed.
Empty-state grammar has three phrasings today (TODO, type-scale entry); align them here if it is cheap, or leave it to that pass and say so.

### F20 · Favourites set in the gallery never reach Afterglow

**Reported:** read favourites from the gallery.
**Read:** `IS_FAVORITE` is read only while verifying our own applies, so a heart set in Samsung Gallery is invisible to us and our lifetime "favourites applied" is really *current verified favourites*.

**Fix (L5).** The scan reads `IS_FAVORITE` on the rows it already walks and projects it as a CARRIED favourite action; a cleared flag clears the carried action.
**Queued rows are never touched** — a waiting intent outranks an observation, or the reconcile would silently cancel work the user asked for.
No schema change.
The favourite EVENT LOG stays parked, narrowed to what this does not answer.

### TODO promotion · Action-layer coherence: one queue language, full grid hydration

Two of the three merged parts of the TODO entry land here; the third (the favourite event log) is what F20 narrows.

- **One queue action language.** The four queue screens share their grid substrate (`QueueGrid`/`QueueViewer`/`useQueueRows`) but their ACTIONS drifted: Share has a confirmed *Clear queue*, Organize an unconfirmed *Remove all N*, Edit and Favourite no removal affordance at all.
Build the action bar as one shared component, confirmation semantics included, so the queues stay aligned by design.
- **Full grid action hydration.** Progress grids show only PENDING action dots and only on DB-backed filters — no carried dots anywhere, and the MediaStore-backed All/Unreviewed paths hydrate no action data at all.
Hydrate both paths with the weighted set (live/carried/removing) and solve the dot-scale question (a dot cannot render the heart-off glyph).

Both are queue-and-badge work, which is what this release is.

### The error-surfacing contract

[Errors_design.md](Errors_design.md) ships here (Tristan, 2026-08-04): it generalises m0.8.4's organize-failure fix into one contract across the four boundaries where an OS refusal can be systematic — trash, favourite, share dispatch, edit launch.
Three of those four are queue screens, which is why it belongs to this release and not another.
**Gate:** its §6 open decisions must be settled in a grilling BEFORE implementation — the doc says so itself and that has not happened yet.
Do that grilling early in the release, not at the end: §7's phases are provisional pending those answers, so an unsettled §6 makes the implementation order a guess.

### TODO promotion · Type-scale and token pass

Moves here from `docs/TODO.md`, because this release is where its evidence already sits.
Headings are 28 or 24; subtitles range 12-16; thumbnail radii are 8, 9 and 10; chip radii 10-20; scrim opacities 0.55-0.7; root paddings 12-20.
Two smaller items belong with it: empty-state grammar has three phrasings (F15's audit is the other half of that), and Summary still has a blank loading view.
**It wants before/after screenshots, not piecemeal edits** — which is exactly what this release's device pass provides, and F10 (a tag that does not align) and F11 (an outline that shifts its neighbours) are two more instances of the same class.
Lift it back out if the release runs long: nothing else here depends on it.

---

## Cross-release dependencies

Three places where an earlier release constrains a later one.
Each is a decision already taken, recorded here so it is not re-litigated mid-build:

1. **F17 → the rescued-date fix.**
   m0.8.5's deck badge renders from `day`, never `taken_at`.
   m0.8.6's change 5 applies the same rule to the viewer and the state editor, which need `day` carried to them first.
2. **F9 → the star knot.**
   L2 changes what the regroup freeze means; the star's freeze role is decided in the same release, after L2 lands, not before.
3. **F20 → F9.**
   F9 (m0.8.6) makes an applied favourite removable from the state editor; F20 (m0.8.7) makes an externally-set favourite visible to it.
   Shipping F20 first would have the editor removing a favourite it could not see; this order avoids that, and the reconcile's never-touch-queued rule is what keeps the two from fighting.

## What stays in TODO

Fourteen entries stay parked, split by what they are waiting on.

**Waiting on us** — a decision or a design pass: the in-app recovery-grade data reset, the upstream expo-image-manipulator report, grouping a detected edited copy with its original, field diagnostics, History event streams for actions, the narrowed favourite event log, and capture-time truth.

**Waiting on a trigger** — a user hitting it, field data arriving, or a release: the per-user review-delta distribution, re-gating the `[perf]` logs at v1, the weekly full pass, coalescing tiny singles runs, the UI gate's PiP dismissal, measuring the delta scan's `k`, the organize queue-time refusal, and the three m0.8.3 discoveries.

Two closed during this pass and are gone: the CI audit gate returned to `--audit-level=high` (the brace-expansion backports landed — 1.1.18 / 2.1.4 / 5.0.9 — and `npm audit fix` cleared every high advisory), and shipped-release documentation standards were dropped as a question Tristan does not want answered.

Three of the survivors have been touched by this pass rather than moved, and each says so in its own entry: **grouping a detected edited copy** re-reads once L2 lands, since L2 reopens the same decision 5 in a different direction; **coalescing tiny singles runs** is likeliest to fire its trigger on F2's "Everything" filter; and **the favourite event log** is what survives F20 rather than a whole entry.
