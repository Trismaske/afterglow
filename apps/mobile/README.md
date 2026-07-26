# Afterglow (Android)

Drive every phone photo to a reviewed end-state. The app scans your
library continuously, groups lookalike shots with an on-device image
model, and hands you one live review queue: work through cull groups as
a swipe deck (cull, keep, flag to-edit, compare candidates full-screen),
sweep the singles, then delete the staged cull list to the system trash
with one confirmation. Keepers that need editing wait in an in-app queue
that launches your editor; a daily goal ring and per-day progress views
carry you to inbox zero.

> **What changed in 0.8 (for testers coming from 0.7.x):** review
> sessions are gone — there is nothing to start, end, or apply. The app
> scans on open, groups by image similarity (a bundled MobileNetV3
> model — hence the ~163 MB APK), and every swipe saves immediately.
> Installing 0.8 over 0.7.x resets the app's local database (review
> history, queues, settings — your photos are untouched). The first scan
> analyzes every photo once: expect roughly 15–25 minutes on a recent
> phone for ~25 k photos, and about an hour per ~6 k photos on hardware
> from the S10e era — progress shows live on Home, the app stays usable
> throughout, and later scans reuse the stored analysis (seconds to a
> few minutes). While a scan is actively running, an occasional decision
> may briefly show "Saving…"; it always lands.

## The state machine

```
unreviewed ──review─┬─▶ culled ─▶ (system trash) ─▶ trashed
                    ├─▶ to_edit ─▶ done
                    └─▶ done
```

SQLite (`photos.state`) is the only review state. Keep decides `done` at
swipe time; flagged keepers wait in the edit queue until marked done;
culls stage into a durable global queue and stay **badged in the deck**
until the final trash confirmation — every decision is reversible until
then. Photos deleted outside Afterglow drop out; photos restored from
the system trash re-enter review automatically.

> **Pre-1.0 testers:** a 0.x upgrade resets the app's local database
> whenever the release changes the schema baseline (0.8 does, coming
> from 0.7.x). Point releases that only add to the schema keep your
> data. Your photos are never touched either way.

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
   nothing), streaks, live corpus stats (photos · groups found ·
   % reviewed · exact reclaimable bytes for staged culls), and
   **Continue reviewing**. Below: queue cards (edit / favourite / share /
   organize / cull list), the all-photos Progress entry, the 3 most
   recent days, and a **Still to review** section — the 2 most recent
   older days with unreviewed photos, an **Unknown day** row for photos
   without a capture date, and an expandable older-days list. History
   and Settings live as icons in the title row.
2. **Bottom tabs** — **Home · Edit · Favourite · Share · Organize**,
   count-badged. The bar stays off the full-screen review surfaces.
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
   Pinch to zoom in place; completed groups reopen in browse/re-decide
   mode where a tap opens the full-screen viewer.
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
   long-press): paging, pinch-zoom, and a decision-detail panel that
   explains each badge — state, best/favourite/share/organize facts,
   "grouped by time" for clock-badged photos — plus **Change decision**.
9. **Edit queue** — every `to_edit` photo. **Edit here** asks Android
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
13. **Progress / Day progress** — inbox-zero views: per-state counts, a
    filterable photo grid, the per-photo state editor, and the day's
    groups (completed ones reopen in browse mode). "Unknown day" is a
    first-class page for photos without a capture date.

### Edit detection

On app open (throttled to once a minute) every queued `to_edit` photo is
re-checked, two heuristics because Android editors differ:

- **In-place edits** (Samsung Gallery style): MediaStore
  `modificationTime` moved past the stored baseline → auto-marked done
  with an unobtrusive notice (content-hash tiebreaker prevents
  metadata-only false positives).
- **Edited copies** (Google Photos / Snapseed style): related filename
  or cloned creation time → the copy is tracked done and a prompt asks
  whether to keep or cull the original.

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
  by canonical volume-qualified MediaStore id, `photo_groups` +
  `photo_group_assignments` (the one membership truth), `duels` compare
  history, `photo_embeddings`, `photo_hashes`, durable
  share/organize/trash-attempt tables, and key/value `settings`. Every
  group-touching write validates presence and the rendered assignment
  inside its transaction; queue reads come from single snapshots.
- The needs-edit flag is app-side state (`photos.needs_edit`); every
  verdict write remaps done + flag → `to_edit` in one CASE expression.
  Explicit re-decisions are state-aware (Keep clears the flag).
- Rendering via `expo-image`; gestures via react-native-gesture-handler
  + reanimated 4. Theming derives accent tokens from a preset or the
  Material You palette (local module `modules/material-you-accent`).
- Pure logic modules in `src/lib/` are unit-tested with vitest;
  everything touching MediaStore/SQLite stays in thin typed adapters.
  See `AGENTS.md` for the per-file map.
