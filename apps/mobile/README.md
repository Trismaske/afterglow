# Afterglow (Android)

Drive every phone photo to a reviewed end-state. The app scans your
library continuously, groups lookalike shots with an on-device image
model, and hands you one live review queue: work through cull groups as
a swipe deck (cull, keep, flag for editing, compare candidates full-screen),
sweep the singles, then delete the staged cull list to the system trash
with one confirmation. Photos that need editing wait in an in-app queue
that launches your editor — usually keepers, but you can flag one before
you have decided about it, when the edit is what tells you whether to
keep it; a daily goal ring and per-day progress views
carry you to inbox zero.

> **What changed in 0.8.2 (for testers on 0.8.1):** the app now tells you
> **when this ends**. The Progress row on Home carries a finish line —
> "3 523 photos left · ≈ 29 Sep at this pace" — computed from the pace
> you actually review at. When you shoot faster than you review it
> refuses to invent a date and shows the growth rate and the pace that
> would hold the line instead. **Stats is now three tabs:** Activity
> (today, the 30-day chart, Keeping up, and shooting vs reviewing side by
> side), Forecast (the finish line, what is probably still in the
> backlog as ranges, and roughly how many hours of tapping that is), and
> Habits (when you actually review, how long your sittings run, what
> happens to the work you queue — "3 queued · oldest 9 days · usually
> done within 2 days" — how your culling standards are moving, and your
> all-time records: longest goal streak, most photos in one day).
> **Review is one timeline now:** the review screen interleaves groups
> and runs of singles in capture order, newest first — your recent
> singles come up right where they were taken instead of behind every
> group, and finishing a group flows into the singles beside it.
> "Continue reviewing" jumps straight into the next thing to review
> (the queue overview is one tap away on the numbers beneath it), and
> decided singles stay in place badged, so you can scroll back and
> share or re-decide one exactly like in a group. **Compare decides
> now:** you can compare against a photo you already kept, "Keep both"
> really keeps both, and all four actions (edit · favourite · organize
> · share) sit on the compare screen like they do in the deck.
> **Organize is two taps:** the deck button just queues the photo (tap
> again to un-queue) and the Organize tab assigns albums in batches —
> select photos, pick one album, done; two albums sharing a name now
> show their folder paths. Crossing your daily goal **celebrates right
> in the deck** instead of waiting for you to notice on Home, the back
> button exits through Home (not the Edit queue), a cold start holds
> its layout instead of repainting chaotically, and a running scan
> shows its **percentage** again — on Home and in Settings — with the
> library total finally agreeing everywhere it appears.
> **Progress is
> rebuilt:** the state rows are compact chips you can tap to filter, and
> a capture histogram by month lets you jump straight to where the
> backlog sits. Behind all of it, "to edit" stopped being a *state* and
> became a *flag on a keeper* — so a photo is simply kept or culled, and
> any of edit / favourite / organize / share can be pending on it at
> once. Bars now fill with exactly what you have decided, so the colour
> always matches the percentage beside it. **The app also stops
> re-reading your whole library.** Until now, one new WhatsApp image or
> screenshot was enough to make the next open re-walk every photo you
> own — on a 27 000-photo phone that is over four minutes of the CPU
> working flat out. It now asks Android what actually changed and only
> re-reads that: the same phone, the same result, in a quarter of a
> second. Deleting a photo in your gallery is picked up the same way.
> And swiping between a group's photos — broken since 0.8 — works
> again: **double-tap now zooms** (tap-point centred; double-tap again
> resets) in the deck and the full-screen viewer, alongside pinch.
> A queued **un-favourite now shows a slashed heart** so you can tell
> "removing" apart from "favourited" and "queueing" at a glance, and
> Compare's "Don't ask again" now sticks with **whichever choice you
> make** — always cull, or always keep both.
>
> **Installing 0.8.2 resets the app's local database** (review history,
> queues, settings — your photos are untouched) and re-analyzes the
> library once. **That one-off analysis takes a while** — measured at
> about **25 minutes on a 27 000-photo phone**, less on a smaller one.
> It runs in the background and you can keep reviewing while it works,
> but expect the phone to be busy and warm until it finishes. After
> that, opens are near-instant.
>
> **What changed in 0.8.1 (for testers on 0.8):** decisions now save
> instantly even mid-scan (no lingering "Saving…"), and re-opening the
> app no longer re-analyzes an unchanged library — it checks one Android
> counter and skips straight to the queue, so opening is seconds instead
> of minutes and the battery cost of a re-open is gone. Cold start to a
> usable Home is ~3-4 s (was ~40 s on an S10e-era phone), and the first
> full scan is roughly twice as fast. The daily-goal ring now counts
> every photo you decide *today*, whenever it was taken, and you can now
> set any custom number as that target. New: a second goal — **Keeping
> up**, which asks that nothing be left unreviewed from the last day or
> two (or your whole library, if you want the 100% version); it has its
> own Home card and its own Stats chart, and runs alongside the daily
> count. Also new: a Stats page, queue badges on every photo, searchable
> album picker, and a reordered bottom bar (Edit · Favourite · **Home**
> · Organize · Share) with Home as the raised center button. Installing 0.8.1 over 0.8 keeps
> your review data (an additive database upgrade).
>
> **Coming from 0.7.x:** review sessions are gone — there is nothing to
> start, end, or apply. The app scans on open, groups by image similarity
> (a bundled MobileNetV3 model — hence the ~163 MB APK), and every swipe
> saves immediately. Installing over 0.7.x resets the app's local
> database (review history, queues, settings — your photos are
> untouched). The first scan analyzes every photo once: expect roughly
> 10–15 minutes on a recent phone for ~25 k photos, longer on hardware
> from the S10e era — progress shows live on Home, the app stays usable
> throughout, and later scans reuse the stored analysis.

## Supported photo formats (the honest list)

The app reviews what Android's MediaStore indexes as a photo on your
device — everything your gallery treats as a picture (JPEG, PNG, WebP,
HEIC, GIF) reviews normally. Videos are not reviewable yet.

**RAW**, measured on real hardware (Samsung S23 / Android 16, 2026-07):

| Format | Status |
|---|---|
| DNG (incl. Samsung Expert RAW) | **Fully supported** — grouped, rendered, reviewable like any photo |
| NEF (Nikon) | **Supported, one caveat** — reviews and renders fine, but Android does not extract its capture date, so NEF photos land under *Unknown day* and sort by file date |
| ARW (Sony) | **Fully supported** |
| CR3 (Canon) | **Not supported** — Android does not classify CR3 as an image, so these files are invisible to the app (they are not shown, counted, or touched) |
| Other RAW formats | Untested — the app shows whatever MediaStore indexes as an image |

Format handling is the OS's: results can vary by device and Android
version; the table above is what we measured, not a promise about every
phone.

**Where photos can live:** internal storage is fully supported. A card
in the phone's **own SD slot** currently *appears* in the app but is not
reliably actionable (deleting or favouriting from it can fail) — proper
SD-card support is the next release (0.8.3). Cards in **USB/OTG
readers** and USB drives are not supported at all: Android never indexes
them for gallery apps, so they are invisible to Afterglow (use your
file manager to copy them onto the phone first).

## What a photo carries

A photo has exactly one **verdict**, plus any number of independent
**pending actions** — the two are different questions, and 0.8.2
stopped mixing them.

```
verdict (one, always):
  unreviewed ──review─┬─▶ kept
                      └─▶ culled ─▶ (system trash) ─▶ trashed

pending actions (any combination, on top of the verdict):
  edit · favourite · organize · share
```

**Reviewed means "has a verdict"** — that one definition is behind every
"X of Y reviewed" number and every filled bar in the app. Flagging a
photo for editing does not change the verdict: it is simply a keeper
with an edit waiting, which is why the same photo can be kept, queued to
edit AND queued to share at once. Culls stage into a durable global
queue and stay **badged in the deck** until the final trash confirmation
— every decision is reversible until then, and a staged cull quietly
steps out of its other queues (you are about to delete it) and steps
back in if you un-stage it. Photos deleted outside Afterglow drop out;
photos restored from the system trash re-enter review automatically.

> **Pre-1.0 testers:** a 0.x upgrade resets the app's local database
> whenever the release changes the schema baseline (0.8 and 0.8.2 both
> do). Point releases that only add to the schema keep your data. Your
> photos are never touched either way.

## Running it (dev build required — NOT Expo Go)

Media permissions, SQLite and the local native modules (image embedder,
Material You, MediaStore actions) don't work in Expo Go. You need a
development build on a real Android device:

```bash
cd apps/mobile
npx expo run:android        # device connected with USB debugging enabled
```

The embedder model is a pinned, SHA-verified download — see
`modules/image-embedder/README.md` (the build fails loudly without it).
Testers grab the release APK from the latest `mobile-m*` GitHub Release.

## The flow

1. **Home** — grant photo access and the continuous scan starts: it
   pages your library newest-first, analyzes each photo once with the
   on-device model, and fills the review queue live (scan progress shows
   under the goal card). Above the fold: the **daily goal ring**
   (target photos reviewed per day — purely motivational, gates
   nothing), streaks, the **Keeping up** card (how much of the last day
   or two is still unreviewed, and your clear streak), live corpus stats (photos · groups found ·
   % reviewed · exact reclaimable bytes for staged culls), and
   **Continue reviewing**. Below: the cull list
   (when culls are staged), the all-photos Progress entry, the 3 most
   recent days, and a **Still to review** section — the 2 most recent
   older days with unreviewed photos, an **Unknown day** row for photos
   without a capture date, and an expandable older-days list. History
   and Settings live as icons in the title row.
2. **Bottom tabs** — **Edit · Favourite · Home · Organize · Share**,
   count-badged, with **Home as the raised center button**. The bar
   stays off the full-screen review surfaces.
3. **Review queue** — cull groups (thumbnail strips, decision badges)
   plus the singles bucket, newest first. Enter any group in any order
   or let **Review groups** walk you through linearly. Groups are formed
   by **image similarity** (same subject seconds apart lands together;
   a strictness control in Settings tunes how tight), with time-only
   attachment for photos whose analysis failed (badged with a clock).
4. **Group review (swipe deck)** — swipe through the group. The big
   three are **Keep / Compare / Cull**; culled shots **stay in the deck
   badged** (the badge is the undo — tap the outlined Cull again to
   un-cull, no time limit), and the deck advances past them. Below: the
   queue row **Edit · Favourite · Organize · Share**, then **Best** and
   **Not related** (ejects a mis-grouped photo to singles — durable, the
   scan never regroups it). **Keep remaining (N)** finishes the group.
   Pinch or double-tap to zoom in place (double-tap again resets);
   completed groups reopen in browse/re-decide mode where a tap opens
   the full-screen viewer.
5. **Compare** — two candidates full-screen: tap anywhere to flip
   between them and pinch to zoom (the transform applies to both photos
   identically, so flipping while zoomed compares the exact same crop).
   **★ is better** stars the best-of-group; in a two-photo group it
   offers to cull the other. Verdicts record as compare history.
6. **Singles** — the same deck over ungrouped photos; staged culls stay
   in the feed badged. **Keep remaining** sweeps the rest.
7. **Cull list** — the durable global staging queue. Tap any photo to
   change its verdict (the sheet's chips re-decide; tapping the active
   Cull chip restores to unreviewed). On Android 11+ the system dialog
   moves batches to the system trash with verified results, dialog by
   dialog until done. Below Android 11 there is no permanent-delete
   fallback — deliberately.
8. **Standard photo viewer** — one full-screen viewer everywhere
   (deck browse, progress grids, History, all queue tabs; share uses
   long-press): paging, pinch or double-tap zoom, and a decision-detail
   panel that
   explains each badge — state, best/favourite/share/organize facts,
   "grouped by time" for clock-badged photos — plus **Change decision**.
9. **Edit queue** — every photo with an edit waiting, decided or not.
   Finishing an edit clears it from the queue and changes nothing about
   the verdict, so a photo you flagged before judging returns to the
   review queue still awaiting your decision. **Edit here** asks Android
   for write access once, then opens an editor that can save over the
   original; **View only** opens the photo read-only (your gallery's own
   edit button takes over from there). Returning asks whether to mark it
   done; **✓ Done** is always available.
10. **Favourite / Share / Organize queues** — verified, retryable
    batches for gallery favourites; a persistent multi-pass share
    working set (✓ badges count passes, optional label per pass); album
    moves with one system confirm per batch.
11. **History** — a filterable feed of decisions on photos still
    present, newest first, share events interleaved. Tap a photo for
    the viewer; edit its state from there.
12. **Summary** — today's decisions (counted by decision date), plus
    all-time: reviewed, culled, edits completed, favourites applied,
    exact storage reclaimed, and goal-based streaks.
13. **Stats** — three tabs. **Activity**: today against the goal, the
    30-day decision chart, the Keeping-up chart, and shooting vs
    reviewing on the same days. **Forecast**: when the backlog ends (or
    an honest refusal to say), what is probably still in it as ranges,
    and the hours of tapping that implies. **Habits**: a weekday × hour
    heatmap of when you review, your typical sitting, each queue's
    turnaround, whether your standards are moving, and milestones.
14. **Progress / Day progress** — inbox-zero views: two rows of tappable
    chips (kept / staged / unreviewed, then the four pending actions), a
    composition bar whose fill is exactly what you have decided, a
    capture histogram by month that filters the grid, one-line library
    insights, a filterable photo grid, the per-photo state editor, and
    the day's groups (completed ones reopen in browse mode). "Unknown
    day" is a first-class page for photos without a capture date.

### Edit detection

On app open (throttled to once a minute) every photo waiting in the edit
queue is re-checked, two heuristics because Android editors differ:

- **In-place edits** (Samsung Gallery style): MediaStore
  `modificationTime` moved past the stored baseline → auto-marked done
  with an unobtrusive notice (content-hash tiebreaker prevents
  metadata-only false positives).
- **Edited copies** (Google Photos / Snapseed style): related filename
  or cloned creation time → the copy is recorded as kept and a prompt
  asks whether to keep or cull the original.

Both heuristics can miss — detection is a convenience layer, and manual
**Mark done** always works.

Close the app any time and nothing is lost: every decision is already
durable, and an interrupted scan resumes from the stored analysis on the
next open.

## Architecture notes

- Grouping is `@afterglow/core` `groupByEmbedding` — pure TS over
  MediaPipe MobileNetV3-large vectors (1280-dim, computed by the local
  `modules/image-embedder` Kotlin module from a single decode per photo,
  which also yields the dHash used as a near-duplicate floor). Grouping
  quality is pinned by a human-judged regression suite in CI.
- The continuous scan (`src/scan/scanRunner.ts`) pages MediaStore
  newest-first into merge windows, embeds cache-aware (per-photo BLOB
  vectors in SQLite, model-SHA pinned), groups, and lands assignments
  durably — honoring the regroup boundary: reviewed groups, user-ejected
  singles, and groups carrying stars/compares are never rewritten.
  Interactive writes take priority over scan writes (`lib/writePriority`).
- `src/lib/media.ts` is the only MediaStore adapter
  (`expo-media-library/legacy`, deliberately) and contains the app's
  single delete call. Trash and favourite operations go through the
  local `modules/media-store-actions` module (Android 11+ system
  dialogs, verified results).
- SQLite (expo-sqlite async API) is the source of truth: `photos` keyed
  by canonical volume-qualified MediaStore id, `photo_actions` (the four
  queues), `photo_groups` +
  `photo_group_assignments` (the one membership truth), `duels` compare
  history, `photo_embeddings`, `photo_hashes`, durable
  share/organize/trash-attempt tables, and key/value `settings`. Every
  group-touching write validates presence and the rendered assignment
  inside its transaction; queue reads come from single snapshots.
- Pending actions live in ONE table (`photo_actions`: photo, kind,
  state, target, queued/resolved stamps) shared by edit, favourite,
  organize and share — 0.8.2 replaced three different column shapes plus
  a bespoke share-queue table. A completed action keeps its `resolved_at`
  forever, which is what lets the app say how long your edits usually
  take to finish, long after you have emptied the queue.
- Rendering via `expo-image`; gestures via react-native-gesture-handler
  + reanimated 4. Theming derives accent tokens from a preset or the
  Material You palette (local module `modules/material-you-accent`).
- Pure logic modules in `src/lib/` are unit-tested with vitest;
  everything touching MediaStore/SQLite stays in thin typed adapters.
  See `AGENTS.md` for the per-file map.
