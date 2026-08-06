# Afterglow (Android)

Drive every phone photo to a reviewed end-state.
The app scans your library continuously and groups lookalike shots with an on-device image model.
It hands you one live review queue.
Work through cull groups as a swipe deck (cull, keep, flag for editing, compare candidates full-screen), sweep the singles, then delete the staged cull list to the system trash with one confirmation.
Photos that need editing wait in an in-app queue that launches your editor.
Usually those are keepers, but you can flag one before you have decided about it, when the edit is what tells you whether to keep it.
A daily goal ring and per-day progress views carry you to inbox zero.

> **What changed in 0.8.4:** Afterglow now requires **Android 11 or later**.
> On an older device the install is refused: the installer says only "App not installed", and `adb install` names the cause, `INSTALL_FAILED_OLDER_SDK`.
> See Compatibility below for why.
> Day labels always show the year, so two "17 Aug" rows a year apart read differently.
> A failed organize move now tells you why: the app's own explanation first, Android's exact words last.
> The album picker no longer offers app-owned albums (WhatsApp Images and similar) that Android refuses moves into.
> Panning a zoomed photo with two fingers no longer zooms it back out.
> Your review data survives this upgrade (no schema change).

> **What changed in 0.8.2 (for testers on 0.8.1):** the app now tells you **when this ends**.
> The Progress row on Home carries a finish line ("3 523 photos left · ≈ 29 Sep at this pace"), computed from the pace you actually review at.
> When you shoot faster than you review, it refuses to invent a date and shows the growth rate and the pace that would hold the line instead.
>
> **Stats is now three tabs:**
>
> - **Activity**: today, the 30-day chart, Keeping up, and shooting vs reviewing side by side.
> - **Forecast**: the finish line, what is probably still in the backlog as ranges, and roughly how many hours of tapping that is.
> - **Habits**: when you actually review, how long your sittings run, what happens to the work you queue ("3 queued · oldest 9 days · usually done within 2 days"), how your culling standards are moving, and your all-time records: longest goal streak, most photos in one day.
>
> **Review is one timeline now:** the review screen interleaves groups and runs of singles in capture order, newest first.
> Your recent singles come up right where they were taken instead of behind every group, and a finished group flows into the singles beside it.
> "Continue reviewing" jumps straight into the next thing to review (the queue overview is one tap away on the numbers beneath it).
> Decided singles stay in place badged, so you can scroll back and share or re-decide one exactly like in a group.
>
> **Compare decides now:** you can compare against a photo you already kept, and "Keep both" really keeps both.
> All four actions (edit · favourite · organize · share) sit on the compare screen like they do in the deck.
>
> **Organize is two taps:** the deck button just queues the photo (tap again to un-queue), and the Organize tab assigns albums in batches.
> Select photos, pick one album, done.
> Two albums that share a name now show their folder paths.
>
> When you cross your daily goal, the app **celebrates right in the deck** instead of waiting for you to notice on Home.
> The back button exits through Home (not the Edit queue).
> A cold start holds its layout instead of repainting chaotically.
> A running scan shows its **percentage** again, on Home and in Settings, with the library total finally agreeing everywhere it appears.
>
> **Progress is rebuilt:** the state rows are compact chips you can tap to filter, and a capture histogram by month lets you jump straight to where the backlog sits.
> Behind all of it, "to edit" stopped being a *state* and became a *flag on a keeper*.
> A photo is simply kept or culled, and any of edit / favourite / organize / share can be pending on it at once.
> Bars now fill with exactly what you have decided, so the colour always matches the percentage beside it.
>
> **The app also stops re-reading your whole library.**
> Until now, one new WhatsApp image or screenshot was enough to make the next open re-walk every photo you own.
> On a 27 000-photo phone that is over four minutes of the CPU working flat out.
> It now asks Android what actually changed and only re-reads that: the same phone, the same result, in a quarter of a second.
> The app picks up a photo deleted in your gallery the same way.
> Swiping between a group's photos (broken since 0.8) works again: **double-tap now zooms** (tap-point centred, double-tap again resets) in the deck and the full-screen viewer, alongside pinch.
> A queued **un-favourite now shows a slashed heart**, so you can tell "removing" apart from "favourited" and "queueing" at a glance.
> Compare's "Don't ask again" now sticks with **whichever choice you make**: always cull, or always keep both.
>
> **Installing 0.8.2 resets the app's local database** (review history, queues, settings) and re-analyzes the library once.
> Your photos are untouched.
> **That one-off analysis takes a while**: measured at about **25 minutes on a 27 000-photo phone**, less on a smaller one.
> It runs in the background and you can keep reviewing while it works, but expect the phone to be busy and warm until it finishes.
> After that, opens are near-instant.
>
> **What changed in 0.8.1 (for testers on 0.8):** decisions now save instantly, even mid-scan (no lingering "Saving…").
> Re-opening the app no longer re-analyzes an unchanged library.
> It checks one Android counter and skips straight to the queue, so an open takes seconds instead of minutes, and the battery cost of a re-open is gone.
> Cold start to a usable Home is ~3-4 s (was ~40 s on an S10e-era phone), and the first full scan is roughly twice as fast.
> The daily-goal ring now counts every photo you decide *today*, whenever it was taken, and you can now set any custom number as that target.
> New: a second goal, **Keeping up**, which asks that nothing be left unreviewed from the last day or two (or your whole library, if you want the 100% version).
> It has its own Home card and its own Stats chart, and it runs alongside the daily count.
> Also new: a Stats page, queue badges on every photo, a searchable album picker, and a reordered bottom bar (Edit · Favourite · **Home** · Organize · Share) with Home as the raised center button.
> Installing 0.8.1 over 0.8 keeps your review data (an additive database upgrade).
>
> **Coming from 0.7.x:** review sessions are gone.
> There is nothing to start, end, or apply.
> The app scans on open, groups by image similarity (a bundled MobileNetV3 model, hence the ~163 MB APK), and every swipe saves immediately.
> Installing over 0.7.x resets the app's local database (review history, queues, settings).
> Your photos are untouched.
> The first scan analyzes every photo once.
> Expect roughly 10–15 minutes on a recent phone for ~25 k photos, longer on hardware from the S10e era.
> Progress shows live on Home, the app stays usable throughout, and later scans reuse the stored analysis.

## Supported photo formats (the honest list)

The app reviews what Android's MediaStore indexes as a photo on your device.
Everything your gallery treats as a picture (JPEG, PNG, WebP, HEIC, GIF) reviews normally.
Videos are not reviewable yet.

**RAW**, measured on real hardware.
The "measured on" column says which devices we ran each row on: Samsung S23 (Android 16), Samsung S10e (Android 12), and an Android 11 emulator, which is the supported floor.

| Format | Status | Measured on |
|---|---|---|
| DNG (incl. Samsung Expert RAW) | **Fully supported** — grouped, rendered, reviewable like any photo | S23 only |
| NEF (Nikon) | **Fully supported** — Android does not extract its capture date, so Afterglow reads it from the file's own EXIF header at ingestion (0.8.3) and files the photo under its real day | S23, S10e, Android 11 |
| ARW (Sony) | **Supported**, with one known wrinkle: Android dates these by the file's modification time rather than its EXIF capture time, so an ARW copied off a card can sort under the copy date. Afterglow shows what Android reports; the EXIF rescue above cannot correct it, because the photo arrives dated — just wrongly | S23, S10e, Android 11 |
| CR3 (Canon) | **Not supported** — Android does not classify CR3 as an image, so these files are invisible to the app (they are not shown, counted, or touched) | S23, S10e, Android 11 |
| Other RAW formats | Untested — the app shows whatever MediaStore indexes as an image | — |

Format handling is the OS's.
Results can vary by device and Android version.
The table above is what we measured, not a promise about every phone.

**Where photos can live (0.8.3):** internal storage and a card in the phone's **own SD slot** are both fully supported.
You pick SD folders like any other folder (they wear an "SD card" tag), and culling, favouriting, editing and sharing work on SD photos.
Moving photos between albums (Organize) stays primary-storage-only this release, and the app says so on the affordance rather than failing later.
Ejecting the card never loses anything.
Its photos leave the queues and counts while the card is out ("SD card not mounted — N photos waiting on it" on Home), and they return exactly as they were on remount.
A card that is gone for good has a designed exit, **Settings → Forget this card**, with a choice between keeping your review history and erasing it.
Cards in **USB/OTG readers** and USB drives are not supported at all.
Android never indexes them for gallery apps, so they are invisible to Afterglow.
Use your file manager to copy them onto the phone first.

**Upgrading to 0.8.3:** the database resets on first launch (pre-1.0 policy).
The app rebuilds review states from a fresh scan, which re-analyses the library once (roughly 25 minutes on a 27,000-photo phone, faster on smaller libraries).

## What a photo carries

A photo has exactly one **verdict**, plus any number of independent **pending actions**.
The two are different questions, and 0.8.2 stopped mixing them.

```
verdict (one, always):
  unreviewed ──review─┬─▶ kept
                      └─▶ culled ─▶ (system trash) ─▶ trashed

pending actions (any combination, on top of the verdict):
  edit · favourite · organize · share
```

**Reviewed means "has a verdict".**
That one definition is behind every "X of Y reviewed" number and every filled bar in the app.
Flagging a photo for editing does not change the verdict.
The photo is simply a keeper with an edit waiting, which is why the same photo can be kept, queued to edit AND queued to share at once.
Culls stage into a durable global queue and stay **badged in the deck** until the final trash confirmation.
Every decision is reversible until then.
A staged cull quietly steps out of its other queues (you are about to delete it) and steps back in if you un-stage it.
Photos deleted outside Afterglow drop out.
Photos restored from the system trash re-enter review automatically.

> **Pre-1.0 testers:** a 0.x upgrade resets the app's local database whenever the release changes the schema baseline (0.8, 0.8.2, and 0.8.3 all do).
> A release that leaves the schema unchanged (0.8.4) keeps your data.
> Your photos are never touched either way.

## Running it (dev build required — NOT Expo Go)

Media permissions, SQLite and the local native modules (image embedder, Material You, MediaStore actions) do not work in Expo Go.
You need a development build on a real Android device:

```bash
cd apps/mobile
npx expo run:android        # device connected with USB debugging enabled
```

The embedder model is a pinned, SHA-verified download (see `modules/image-embedder/README.md`).
The build fails loudly without it.
Testers get the release APK from the latest `mobile-m*` GitHub Release.

**Afterglow requires Android 11 or later.**
Every removal in the app goes through Android's system trash, which does not exist below Android 11.
From m0.8.4 the APK declares that floor, and older devices refuse to install it.
The on-device installer says only "App not installed".
`adb install` names the cause: `INSTALL_FAILED_OLDER_SDK`.

## The flow

1. **Home**: grant photo access and the continuous scan starts.
   It pages your library newest-first, analyzes each photo once with the on-device model, and fills the review queue live (scan progress shows under the goal card).
   Above the fold:
   - the **daily goal ring** (target photos reviewed per day: purely motivational, gates nothing)
   - streaks
   - the **Keeping up** card (how much of the last day or two is still unreviewed, and your clear streak)
   - live corpus stats (photos · groups found · % reviewed · exact reclaimable bytes for staged culls)
   - **Continue reviewing**

   Below:
   - the cull list (when culls are staged)
   - the all-photos Progress entry
   - the 3 most recent days
   - a **Still to review** section: the 2 most recent older days with unreviewed photos, an **Unknown day** row for photos without a capture date, and an expandable older-days list

   History and Settings live as icons in the title row.
2. **Bottom tabs**: **Edit · Favourite · Home · Organize · Share**, count-badged, with **Home as the raised center button**.
   The bar stays off the full-screen review surfaces.
3. **Review queue**: cull groups (thumbnail strips, decision badges) plus the singles bucket, newest first.
   Enter any group in any order, or let **Review groups** walk you through linearly.
   Groups form by **image similarity**: the same subject seconds apart lands together, and a strictness control in Settings tunes how tight.
   Photos whose analysis failed attach by time only (badged with a clock).
4. **Group review (swipe deck)**: swipe through the group.
   The big three are **Keep / Compare / Cull**.
   Culled shots **stay in the deck badged**, and the deck advances past them.
   The badge is the undo: tap the outlined Cull again to un-cull, with no time limit.
   Below: the queue row **Edit · Favourite · Organize · Share**, then **Best** and **Not related**.
   **Not related** ejects a mis-grouped photo to singles, durably: the scan never regroups it.
   **Keep remaining (N)** finishes the group.
   Pinch or double-tap to zoom in place (double-tap again resets).
   Completed groups reopen in browse/re-decide mode, where a tap opens the full-screen viewer.
5. **Compare**: two candidates full-screen.
   Tap anywhere to flip between them, and pinch to zoom.
   The transform applies to both photos identically, so a flip while zoomed compares the exact same crop.
   A duel decides verdicts only when it settles the whole table: any singles duel, or a group down to its last two undecided photos.
   There, "is better" asks whether to keep both or cull the loser.
   A duel with more photos still alive is triage: it stars the best-of-group and records the outcome, with no verdict.
   Every duel records as compare history.
6. **Singles**: the same deck over ungrouped photos.
   Staged culls stay in the feed badged.
   **Keep remaining** sweeps the rest.
7. **Cull list**: the durable global staging queue.
   Tap any photo to change its verdict (the sheet's chips re-decide, and a tap on the active Cull chip restores to unreviewed).
   One final confirmation moves batches to the system trash with verified results, dialog by dialog until done.
   Afterglow never permanently deletes a photo.
8. **Standard photo viewer**: one full-screen viewer everywhere: deck browse, progress grids, History, and all queue tabs (share uses long-press).
   It offers paging, pinch or double-tap zoom, a decision-detail panel, and **Change decision**.
   The panel explains each badge: state, best/favourite/share/organize facts, and "grouped by time" for clock-badged photos.
9. **Edit queue**: every photo with an edit waiting, decided or not.
   A finished edit clears from the queue and changes nothing about the verdict, so a photo you flagged before judging returns to the review queue still awaiting your decision.
   **Edit here** asks Android for write access once, then opens an editor that can save over the original.
   **View only** opens the photo read-only (your gallery's own edit button takes over from there).
   When you return, the app asks whether to mark the edit done.
   **✓ Done** is always available.
10. **Favourite / Share / Organize queues**.
    Favourite applies verified, retryable batches of gallery favourites.
    Share keeps a persistent multi-pass working set (✓ badges count passes, optional label per pass).
    Organize applies album moves with one system confirm per batch.
11. **History**: a filterable feed of decisions on photos still present, newest first, with share events interleaved.
    Tap a photo for the viewer, and edit its state from there.
12. **Summary**: today's decisions (counted by decision date), plus all-time: reviewed, culled, edits completed, favourites applied, exact storage reclaimed, and goal-based streaks.
13. **Stats**: three tabs.
    **Activity**: today against the goal, the 30-day decision chart, the Keeping-up chart, and shooting vs reviewing on the same days.
    **Forecast**: when the backlog ends (or an honest refusal to say), what is probably still in it as ranges, and the hours of tapping that implies.
    **Habits**: a weekday × hour heatmap of when you review, your typical sitting, each queue's turnaround, whether your standards are moving, and milestones.
14. **Progress / Day progress**: inbox-zero views, built from:
    - two rows of tappable chips (kept / staged / unreviewed, then the four pending actions)
    - a composition bar whose fill is exactly what you have decided
    - a capture histogram by month that filters the grid
    - one-line library insights
    - a filterable photo grid and the per-photo state editor
    - the day's groups (completed ones reopen in browse mode)

    "Unknown day" is a first-class page for photos without a capture date.

### Edit detection

On app open (throttled to once a minute), the app re-checks every photo waiting in the edit queue.
It uses two heuristics, because Android editors differ:

- **In-place edits** (Samsung Gallery style): when MediaStore `modificationTime` moves past the stored baseline, the app auto-marks the edit done with an unobtrusive notice.
  A content-hash tiebreaker prevents metadata-only false positives.
- **Edited copies** (Google Photos / Snapseed style): a related filename or a cloned creation time records the copy as kept, and a prompt asks whether to keep or cull the original.

Both heuristics can miss.
Detection is a convenience layer, and manual **Mark done** always works.

Close the app any time and nothing is lost.
Every decision is already durable, and an interrupted scan resumes from the stored analysis on the next open.

## Architecture notes

- Grouping is `@afterglow/core` `groupByEmbedding`: pure TS over MediaPipe MobileNetV3-large vectors (1280-dim).
  The local `modules/image-embedder` Kotlin module computes the vectors from a single decode per photo, which also yields the dHash used as a near-duplicate floor.
  A human-judged regression suite in CI pins grouping quality.
- The continuous scan (`src/scan/scanRunner.ts`) pages MediaStore newest-first into merge windows, embeds cache-aware (per-photo BLOB vectors in SQLite, model-SHA pinned), groups, and lands assignments durably.
  It honors the regroup boundary: the scan never rewrites reviewed groups, user-ejected singles, or groups carrying stars/compares.
  Interactive writes take priority over scan writes (`lib/writePriority`).
- `src/lib/media.ts` is the only MediaStore adapter (`expo-media-library/legacy`, deliberately) and contains the app's single delete call.
  Trash and favourite operations go through the local `modules/media-store-actions` module (system dialogs, verified results).
- SQLite (expo-sqlite async API) is the source of truth: `photos` keyed by canonical volume-qualified MediaStore id, `photo_actions` (the four queues), `photo_groups` + `photo_group_assignments` (the one membership truth), `duels` compare history, `photo_embeddings`, `photo_hashes`, durable share/organize/trash-attempt tables, and key/value `settings`.
  Every group-touching write validates presence and the rendered assignment inside its transaction.
  Queue reads come from single snapshots.
- Pending actions live in ONE table (`photo_actions`: photo, kind, state, target, queued/resolved stamps) shared by edit, favourite, organize and share.
  0.8.2 replaced three different column shapes plus a bespoke share-queue table.
  A completed action keeps its `resolved_at` forever, which is what lets the app say how long your edits usually take to finish, long after you have emptied the queue.
- Rendering uses `expo-image`.
  Gestures use react-native-gesture-handler + reanimated 4.
  Theming derives accent tokens from a preset or the Material You palette (local module `modules/material-you-accent`).
- Pure logic modules in `src/lib/` are unit-tested with vitest.
  Everything touching MediaStore/SQLite stays in thin typed adapters.
  See `AGENTS.md` for the per-file map.
