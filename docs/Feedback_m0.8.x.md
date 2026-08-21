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
| **m0.8.6** | the browsing surfaces | Going back to look at something: Timeline, Progress, History, and editing a photo's state from any of them | F2 F8 F9 F16 · N1 (a changed decision advances) N2 (the finish button dims on every write) · TODO "rescued-date scope", "tombstone rows", the star/Compare knot · zoom: the two-thumb walking pan stutters on every finger change (m0.8.5 device pass, parked — momentum covers most of its use; the fix is porting react-native-zoom-toolkit's touch-position pinch/pan math into the worklets — it cannot be adopted wholesale: host `GestureDetector` + `runOnJS`, both forbidden here) · deck: a singles finish flashes the browse control row for one frame before the advance (`finishing`'s escape clause fires while the post-write rows are still stale — emulator probe; the human pass reads it as fine, so it rides with the browse-swap unify) |
| **m0.8.7** | sources, badges, and the queues | Where photos come from, what they wear, and the four queue screens behaving alike | F10 F11 F12 F14 F15 F18 F19 F20 · TODO "action-layer coherence", "type-scale and token pass" · [Errors_design.md](Errors_design.md) · 2026-08-20 riders ([Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md)) |

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

## m0.8.6 — the browsing surfaces (shipped)

Shipped; the release's distilled record lives in PLAN.md's roadmap entry, and the settled behavior in the code headers.

## m0.8.7 — sources, badges, and the queues

Where photos come from, what they wear, and the four queue screens behaving like one another.
Riders from the 2026-08-20 round also land here — specs in [Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md): F21 (per-kind action suspension + cull-confirm guard), F27's undated-fallback fix (the measured cause of the daily full corpus scans), F30 (the state editor keeps stale facts dimmed across writes), the share-dispatch-with-pending-edit confirm, and the step-zero S23 scan-log capture.

### Retire the regroup freeze (design-complete — [Regroup_design.md](Regroup_design.md))

The m0.8.6 closing grilling agreed the direction; the design grilling (2026-08-21, five questions) settled the rest.
The design doc is the authoritative spec (decisions R1–R9): grouping becomes pure presentation; duels become a pair-keyed **append-only event log** (deleted by nothing short of the schema reset; forget-erase anonymizes); "Not related" becomes **directional cannot-link pairs** with a dissolution rule, undoable from the state editor via a targeted window rescan; exclusions persist at every strictness; the strictness confirm survives with re-copied honesty.
Two earlier sub-decisions were superseded there and are recorded in its table: the "scan deletes duels whose pair separates" clause (R3 — no sweep at all), and the m0.8.6 "un-review deletes only that photo's duels" first-prize (R3 — un-review deletes no duels and loses its confirm; the rejected cascade option stays rejected).
Schema v22 destructive rebuild; existing duels and ejection flags are lost by explicit decision.

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
**Gate cleared:** its §6 decisions were settled in a grilling (2026-08-21) — the doc is decision-complete and its §7 phases are firm.
One tie to this release's other work: the `plural()` helper (D5) lands via F15's copy audit, and the error copy consumes it.

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
A fourth instance (Tristan, 2026-08-19, m0.8.6 device pass): UnitCard thumbnails size inversely to member count — a 1-2 photo group renders the biggest thumbs, a 6-photo group the smallest — so card heights vary widely down the Timeline.
Decide there whether thumbs take a fixed size (consistent card heights), keep the dynamic fill, or become a setting; Tristan leans "probably okay as is" but wants it weighed.
Lift it back out if the release runs long: nothing else here depends on it.

---

## Cross-release dependencies

One place where a shipped release constrains the next, recorded so it is not re-litigated mid-build:

1. **F20 → F9.**
   F9 (m0.8.6, shipped) made an applied favourite removable from the state editor.
   F20 (m0.8.7) makes an externally-set favourite visible to it.
   Shipping F20 first would have had the editor showing a favourite it could not remove.
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
