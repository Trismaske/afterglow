# Tester feedback — the m0.8.x line

Round of 2026-07-31 (Tristan, S23 + S10e on shipped m0.8.4): twenty items, organised into three releases with the TODO work each one naturally carries.
Every item keeps its round number (F1–F20) for traceability.
The release sections are the authoritative grouping.
This doc covers three releases, so it is named for the LINE rather than one version.
Delete it when m0.8.7 ships.

Each claim carries an evidence tier: **reported** (tester saw it), **read** (established from the code, not yet reproduced), or **measured** (run on a device).
Reproduce an item whose cause is only **read** before you write its fix.
A fix aimed at the wrong cause passes review and fails on the phone.

---

## The releases

| | Release | What it is | Items |
|---|---|---|---|
| **m0.8.5** | the review loop | **SHIPPED 2026-08-17** — F1 F3 F4 F5 F6 F7 F13 F17 plus the accent pass; behavior recorded in PLAN.md's shipped entry | — |
| **m0.8.6** | the browsing surfaces | Going back to look at something: Timeline, Progress, History, and editing a photo's state from any of them | F2 F8 F9 F16 · TODO "rescued-date scope", "tombstone rows", the star/Compare knot · zoom: the two-thumb walking pan stutters on every finger change (m0.8.5 device pass, parked — momentum covers most of its use; the fix is porting react-native-zoom-toolkit's touch-position pinch/pan math into the worklets — it cannot be adopted wholesale: host `GestureDetector` + `runOnJS`, both forbidden here) · deck: a singles finish flashes the browse control row for one frame before the advance (`finishing`'s escape clause fires while the post-write rows are still stale — emulator probe; the human pass reads it as fine, so it rides with the browse-swap unify) |
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

## m0.8.6 — the browsing surfaces

Going back to look at something you already reviewed.
One query family (Timeline, Progress grids, History), one editing sheet over all three, and the star knot that sits in the middle of them.

### F2 · The review overview hides fully reviewed units

**Reported:** *Continue reviewing* → review a group → want to go back to it → Home → the chevron in the main card → the group is gone.
Staged culls still show; fully kept units vanish.
**Read:** the overview renders the PENDING timeline.
`listReviewGroups` requires a group to still hold an `unreviewed` member, and the singles feed keeps only pending rows.
Day pages do list completed groups, but nothing in that flow points there.

**Fix.** The full timeline: every group and singles run, newest-first, paged, with filters that peel back to today's view.
The screen is renamed **Timeline** (`GroupsScreen`).

| Filter | Shows |
|---|---|
| Unfinished | Today's behaviour: units with pending work, staged culls badged |
| Everything | Every unit, reviewed included |
| Unreviewed only | Hides queued items too |

**Per L7** the last choice is remembered.
First launch opens Unfinished.
*Continue reviewing* anchors to the first PENDING unit whatever the filter shows.

**The real work is the query.**
The pending feed is bounded by construction.
An unfiltered timeline over a 27k corpus is a different, bigger query.
`lib/timeline.ts`'s horizon truncation (`TimelinePageTails`, carried through optimistic patches) was built around a bounded read.
Paging and its interaction with the optimistic patches is the design risk in this release.

**Watch what "Everything" exposes.**
A sparse-photo stretch produces one card and one one-photo deck per day (dozens at the head on both phones, device-observed).
Today only the pending ones are visible.
Showing everything multiplies them, so this filter is the surface most likely to fire the trigger on `docs/TODO.md`'s "Coalesce tiny singles runs?" (settled as keep-as-is, pending tester complaints about ceremony).
Design the filter so a run of one-photo days reads as one line of the list rather than dozens, or accept it and let the trigger fire honestly.
Decide it here rather than discovering it on the device.

### F9 · A photo's state is barely editable outside review

**Reported:** selecting a photo in Progress or History hides everything behind *Change decision*, and the only decision offered is "mark edit".
Wanted: add or remove any state.
Stated use case — loosen grouping, set two kept photos back to unreviewed, and see whether they now group with the already-unreviewed one.
Accepted asymmetry: once something is queued AND actioned, there is no going back.
**Read:** `editorActions` returns one action per verdict: `culled` → un-cull, `kept` → queue-or-complete an edit, everything else read-only ([progress.ts:187-197](../apps/mobile/src/lib/progress.ts#L187-L197)).

**Fix.** The editor becomes the state model made touchable: one verdict (`unreviewed`/`kept`/`culled`) and every action independently addable and removable, on the same photo, in the same sheet.
The refusals must be the honest ones and nothing more: `trashed` is the OS's, an APPLIED organize move already happened, and a share pass already left the device.
An applied favourite is removable (the app already models a queued un-favourite with its own heart-off badge), and F20 makes that state readable from the gallery in m0.8.7.

**L2 is what makes it work.**
The regroup boundary freezes on state history.
Setting a photo back to `unreviewed` must return it to the scan's reach, or the use case above cannot happen.
Narrow change only: the freeze predicate reads current state.
Reviewed-and-still-reviewed groups stay frozen exactly as now.
Also verify: `StateEditorSheet`'s date line reads `dayKey(photo.takenAt)` ([StateEditorSheet.tsx:118](../apps/mobile/src/components/progress/StateEditorSheet.tsx#L118)).
That is the same `taken_at`-not-`day` defect change 5 below fixes.

### F8 · Selecting a month scrolls the histogram away from the month you picked

**Reported:** tapping a month in Progress scrolls the chart hard left, so the selected month is off-screen.
**Read:** the guard causes it.
`settled` suppresses the open-at-recent scroll whenever a month is selected ([ProgressView.tsx:161-183](../apps/mobile/src/components/progress/ProgressView.tsx#L161-L183)).
The guard was written to stop the chart jumping back to today and stranding the selection.
On a reload the ScrollView starts at offset 0, the early return fires, and it stays there: far left.

**Fix.** Scroll to keep the SELECTED bar visible rather than choosing between "recent" and "don't move".
That satisfies both the original constraint and the report.

### F16 · "Sheet opened" is not a phrase anyone recognises

**Reported:** what is the *Sheet opened* filter in History?
**Read:** it filters to photos in a share batch that reached `sheet_opened` ([HistoryScreen.tsx:45](../apps/mobile/src/screens/HistoryScreen.tsx#L45)).
That is an internal state name on a user-facing chip.
The state is honest: we know the sheet opened, and we cannot know what the user then did with it.
But "Sheet opened" states the mechanism instead of the meaning.
**Fix.** Rewrite the label and keep the honesty.
Part of F15's audit, done here because it is a History chip.

### TODO promotion · A rescued photo's date does not reach the Progress library scope

Moves here whole from `docs/TODO.md`, **fully investigated, agreed, and ready to implement**.
Six changes:

1. bounded month grid pages SQLite
2. unbounded grid takes `takenAt` from the DB join
3. header denominator takes Home's disjoint union
4. `progressPager` unions rescued rows
5. the undated-and-unrescued surfaces stop printing `Today · <mtime>` in BOTH the viewer and the state editor
6. bounded month scopes key on `day`, not `taken_at`

Two regression pins, both from real screens.
A month view printing three different numbers must print one.
A month view must render the same photo under `Unreviewed` as under `Kept`.
Device fixtures for it are already in place (S23 `NOEXIF_undated.jpg`, the mtime-touched NEF, the `afterglow-api30` AVD).
It belongs in this release and not m0.8.5.
Five of its six changes are Progress-surface changes, and change 5 is the same date-honesty rule F17 applies to the deck.

**The other parked SQL cost comes with it** (from `docs/TODO.md`, "Two measured SQL costs").
`getStateCountsInScope` evaluates a correlated EXISTS per row in scope: 22 ms whole-corpus, measured, once per Progress open.
Changes 1, 3 and 6 rewrite what Progress counts and how a month scope is keyed, so the query is open on the table anyway.
The LEFT JOIN rewrite is straightforward and has simply never been measured against real device latency.
Take it only if the counts work touches this query.
A rewrite bolted on separately buys 22 ms and costs a review.

### TODO promotion · History tombstone rows

The feed requires `is_present = 1`, so Forget-keep tombstones keep every stat and drop out of the scrollable feed.
Absent decided photos stay in the feed as a placeholder tile (grey cell, verdict badge, original date).
Still to design: the tile treatment, whether trashed rows join (same gap), and the filter story.

### TODO promotion · The star knot: best-of-group, and keeping from a triage duel

Three TODO entries are one decision and settle together here (L8), because the star's regroup-freeze role has to be re-decided in the same release as L2:

- **Does "best of group" still earn its place?** The star is an ANNOTATION that also freezes its group against regrouping (`lib/regroupBoundary.ts`) and is drawn in the accent.
  That is the sixth site of m0.8.5's accent problem, and the worst: it sits in a badge cluster beside the organize badge at ΔE 6.5 on Amber.
- **Retire it in favour of a plain Keep?** Marking best is the only positive act a triage duel offers, and it pulls toward the cull dialog rather than a keep.
- **Compare: keeping photos in TRIAGE mode.** With 3+ undecided members a duel is verdict-free by design, so Compare offers no way to KEEP there.
  Tristan found the pull-toward-culling acceptable but wants a keep path.

If the star survives, it takes a fixed hue of its own.
If it goes, the freeze needs a new home.
L2 has just changed what the freeze means, so this is the cheapest moment to decide it.

---

## m0.8.7 — sources, badges, and the queues

Where photos come from, what they wear, and the four queue screens behaving like one another.

### F18 · Cull-queue photos survive their source being deselected

**Reported:** removing a folder from the sources leaves its photos in the cull queue; they should hide, the way an ejected SD card's do, and return if the folder is re-added.
**Read:** `getStagedCulls` scopes to MOUNTED volumes but takes no source predicate ([store.ts:217-236](../apps/mobile/src/db/store.ts#L217-L236)).

**Fix (L3).** Source selection becomes a scope axis exactly like mount state.
Deselecting writes nothing.
The photos leave the cull list, all four queues, every count and the forecast pool.
Re-adding restores them byte-for-byte.
History and lifetime stats stay unscoped: completed work is fact wherever it came from.
**The work is the audit, not the predicate:** every queue read and every bulk action's binding under the M5 rule.
The M5 rule: bulk actions bind to what was rendered and reachable, and a fresh read may only shrink them.
`docs/STATE_MODEL.md` gains the second axis.

**One parked cost stops being parked here** (from `docs/TODO.md`, "Two measured SQL costs", m0.8.1 rounds 5-7).
`sourceClause` builds a leading-wildcard `LIKE` per root, which can never use an index (`db/store.ts:124-140`).
That is tolerable today because it is always a SECONDARY filter on rows an index already fetched.
This item adds it to reads that skip it today, including the cull confirm loop.
So measure the queue reads on the S10e before and after.
If it bites, the fix shape is known (a normalized `source_root` column), but it is a schema change and therefore its own decision.

### F19 + F14 · The badge family

**Reported:** F19 — a badge showing the source folder (last folder name only), with a way to hide badges.
F14 — Group Review needs an SD-card badge.
**Read:** badges are one shared vocabulary (`lib/photoBadges.ts` + `DecisionBadge`/`BadgeCluster`) drawn identically by deck, grids, History and queues.
So both new badges are one change across every surface.
Today group cards and deck headers name SD-card membership as a COUNT of hidden unreachable members ("· N on unmounted SD card").
F14 asks for it per photo, which is a different fact and a new badge.

**Fix (L6).** Add source-folder and SD-card badges to the shared vocabulary, and ONE control on review surfaces that hides all badges for an unobstructed look at the photo.
No per-badge settings.
Open: whether the hide control is durable or a session-level peek.
Decide with the control in hand.

### F10 · The SD-card tag does not align between folder rows

**Reported:** measured by eye on the S10e while scrolling the source picker — the tag sits at different horizontal positions on different rows.
**Read:** not yet located.
The tag is composed from `sources.ts`' display-name helpers ([sources.ts:222-231](../apps/mobile/src/lib/sources.ts#L222-L231)) and rendered per row in `SourcePickerScreen`.
Reproduce on the S10e first: a layout defect diagnosed from source is a guess.

### F11 · Selecting a folder shifts the rows around it

**Reported:** the selection outline changes the layout of neighbouring folders.
**Read:** the STATE_MODEL selection language is an outline, never a fill.
An outline added on selection adds its width to the box unless the unselected state already reserves it.
Fix by reserving the space in both states (transparent border), so selection changes colour only.

### F12 · The picker shows nothing before the folders arrive

**Reported:** show loading until folders are listed.
**Read:** the screen already has an `ActivityIndicator` and a *Listing photo folders…* line ([SourcePickerScreen.tsx:341,369](../apps/mobile/src/screens/SourcePickerScreen.tsx#L341)).
So the report is about a state those two do not cover, most likely the frame before the catalog load starts.
Reproduce, then make the loading state the DEFAULT rather than a state entered on the way.

### F15 · Copy audit: singular strings in plural situations

**Reported:** the source picker says *Use this source* when several are selected ([SourcePickerScreen.tsx:432](../apps/mobile/src/screens/SourcePickerScreen.tsx#L432)) — audit the app for every other place a count makes the copy wrong.
**Fix.** One pass over user-visible strings for count agreement, sweeping the whole class rather than the one instance.
Known member (Tristan, 2026-08-17, shipped m0.8.5): Home's Keeping-up streak reads "Most recent 1 days with photos fully reviewed" — "days" stays plural at 1.
Two known members are fixed in their own releases where the surrounding work already opens the file: F3's scanning state (m0.8.5) and F16's *Sheet opened* chip (m0.8.6).
This audit must re-check both rather than assume them.
Empty-state grammar has three phrasings today (the type-scale promotion below).
Align them here if it is cheap, or leave it to that pass and say so.

### F20 · Favourites set in the gallery never reach Afterglow

**Reported:** read favourites from the gallery.
**Read:** the app reads `IS_FAVORITE` only while verifying its own applies.
So a heart set in Samsung Gallery is invisible to us, and our lifetime "favourites applied" is really *current verified favourites*.

**Fix (L5).** The scan reads `IS_FAVORITE` on the rows it already walks and projects it as a CARRIED favourite action.
A cleared flag clears the carried action.
**Queued rows are never touched**: a waiting intent outranks an observation, or the reconcile would silently cancel work the user asked for.
No schema change.
The favourite EVENT LOG stays parked, narrowed to what this does not answer.

### TODO promotion · Action-layer coherence: one queue language, full grid hydration

Two of the three merged parts of the TODO entry land here.
The third (the favourite event log) is what F20 narrows.

- **One queue action language.** The four queue screens share their grid substrate (`QueueGrid`/`QueueViewer`/`useQueueRows`), but their ACTIONS drifted.
  Share has a confirmed *Clear queue*, Organize an unconfirmed *Remove all N*, and Edit and Favourite no removal affordance at all.
  Build the action bar as one shared component, confirmation semantics included, so the queues stay aligned by design.
- **Full grid action hydration.** Progress grids show only PENDING action dots, and only on DB-backed filters.
  No carried dots appear anywhere, and the MediaStore-backed All/Unreviewed paths hydrate no action data at all.
  Hydrate both paths with the weighted set (live/carried/removing) and solve the dot-scale question (a dot cannot render the heart-off glyph).

Both are queue-and-badge work, which is what this release is.

### The error-surfacing contract

[Errors_design.md](Errors_design.md) ships here (Tristan, 2026-08-04).
It generalises m0.8.4's organize-failure fix into one contract across the four boundaries where an OS refusal can be systematic: trash, favourite, share dispatch, edit launch.
Three of those four are queue screens, which is why it belongs to this release and not another.
**Gate:** its §6 open decisions must be settled in a grilling BEFORE implementation.
The doc says so itself, and that has not happened yet.
Do that grilling early in the release, not at the end.
§7's phases are provisional pending those answers, so an unsettled §6 makes the implementation order a guess.

### TODO promotion · Type-scale and token pass

Moves here from `docs/TODO.md`, because this release is where its evidence already sits.
The measured drift:

- headings are 28 or 24
- subtitles range 12-16
- thumbnail radii are 8, 9 and 10
- chip radii 10-20
- scrim opacities 0.55-0.7
- root paddings 12-20

Two smaller items belong with it: empty-state grammar has three phrasings (F15's audit is the other half of that), and Summary still has a blank loading view.
**It wants before/after screenshots, not piecemeal edits.**
This release's device pass provides exactly that.
F10 (a tag that does not align) and F11 (an outline that shifts its neighbours) are two more instances of the same class.
Lift it back out if the release runs long: nothing else here depends on it.

---

## Cross-release dependencies

Three places where an earlier release constrains a later one.
Each is a decision already taken, recorded here so it is not re-litigated mid-build:

1. **F17 → the rescued-date fix.**
   m0.8.5's deck badge renders from `day`, never `taken_at`.
   m0.8.6's change 5 applies the same rule to the viewer and the state editor, which need `day` carried to them first.
2. **F9 → the star knot.**
   L2 changes what the regroup freeze means.
   The star's freeze role is decided in the same release, after L2 lands, not before.
3. **F20 → F9.**
   F9 (m0.8.6) makes an applied favourite removable from the state editor.
   F20 (m0.8.7) makes an externally-set favourite visible to it.
   Shipping F20 first would have the editor showing a favourite it could not remove.
   This order avoids that, and the reconcile's never-touch-queued rule is what keeps the two from fighting.

## What stays in TODO

Seventeen entries stay parked, split by what they are waiting on.

**Waiting on us** (a decision or a design pass): the in-app recovery-grade data reset, the upstream expo-image-manipulator report, grouping a detected edited copy with its original, field diagnostics, History event streams for actions, the narrowed favourite event log, and capture-time truth.

**Waiting on a trigger** (a user hitting it, field data arriving, or a release): the per-user review-delta distribution, re-gating the `[perf]` logs at v1, the weekly full pass, coalescing tiny singles runs, the UI gate's PiP dismissal, measuring the delta scan's `k`, the organize queue-time refusal, and the three m0.8.3 discoveries.

Two closed during this pass and are gone.
The CI audit gate returned to `--audit-level=high`: the brace-expansion backports landed (1.1.18 / 2.1.4 / 5.0.9) and `npm audit fix` cleared every high advisory.
Shipped-release documentation standards were dropped as a question Tristan does not want answered.

This pass touched three of the survivors rather than moved them, and each says so in its own entry.
**Grouping a detected edited copy** re-reads once L2 lands, since L2 reopens the same decision 5 in a different direction.
**Coalescing tiny singles runs** is likeliest to fire its trigger on F2's "Everything" filter.
**The favourite event log** is what survives F20 rather than a whole entry.
