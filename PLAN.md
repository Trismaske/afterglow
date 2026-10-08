# Afterglow — Product Plan & Roadmap

*The living product plan: vision, locked decisions, the full 1.0 feature picture, and the release roadmap.
Tester feedback folds into the roadmap each round.*

## Vision

Two apps, one shared brain:

1. **Afterglow Desktop** — a fullscreen ambient photo display ("screensaver") for a media PC or desktop.
   It shows your *edited* photos and videos with intelligent ordering.
   It also quietly doubles as a photo-organization capture tool: see a photo that needs attention, flag it with one keypress, deal with it later.
2. **Afterglow on Android** — an app that drives every phone photo to a reviewed end-state.
   It groups shots taken in quick succession, and walks you through each group two photos at a time (cull one, or keep both and pick the better).
   It stages deletions for one confirmed batch, and it tracks which photos still need editing.

They are separate apps with separate release trains.
The shared intelligence (time-based clustering, ordering strategies, the flag and culling session model) lives in one TypeScript package that both apps consume.

## Decisions locked in

| Question | Decision |
|---|---|
| Platforms | Windows, Linux, macOS. **Windows is the first priority** (the media PC). Dev machines run Ubuntu/Mint. |
| Desktop stack | **Electron + TypeScript**, with the proper security model (preload + `contextBridge`) from day one. Chosen over Tauri for reliable bundled video codecs, and over Flutter for web-tech slideshow strengths plus TS code sharing with React Native. |
| Mobile stack | **React Native (Expo), Android first.** iOS later. |
| App split | Two apps sharing a core package. Desktop = screensaver + organizer modes in one app. |
| RAW strategy | Keep it. It is the differentiator. **darktable XMPs rendered faithfully** via `darktable-cli`. **Lightroom via tiered fallbacks**: preview-cache extraction, DNG/embedded previews (see below). Per-image routing by sniffing XMP namespaces (`darktable:` vs `crs:`). JPEG-only libraries work fine regardless. |
| App naming & convergence | **Both apps are "Afterglow"** (the mobile display name renamed in m0.8; the Android application id stays `com.afterglow.companion` so testers do not end up with two installs). One product, two surfaces: organize/queue UI-UX patterns converge as the desktop organizer (v0.7+) and mobile mature, with shared vocabulary throughout. |
| Mobile workflow | Three-layer photo state model: verdict · actions · annotations (see below). Swipe-deck group review. Stored compare/duel history instead of full ranking. Completed groups advance directly to the next unfinished group. The to-edit queue lives in-app with `ACTION_EDIT` launch. |
| Distribution | GitHub Releases, CI-built installers per tag. Auto-update later. |

## The Lightroom reality (verified 2026-07-17)

**There is no local or headless Lightroom API.**
Lightroom Classic's only extensibility is the Lua plugin SDK, which runs *inside* a running Lightroom instance.
Nothing external can ask it to render a photo.
Adobe's cloud REST API exists, but it covers only cloud-synced Lightroom CC libraries and is gated to approved partner integrations.
So "use Lightroom if installed" works only indirectly, and RAW support has honest tiers:

1. **darktable users:** pixel-faithful rendering via `darktable-cli` with the sidecar XMP.
   The flagship feature.
2. **Lightroom Classic users — preview-cache extraction:** `Previews.lrdata` beside the catalog holds JPEG previews *with edits applied* (a SQLite index plus `.lrprev` files).
   The format is unofficial and could break with a Lightroom update, but it works offline and shows the real edit.
   Quality depends on the user's preview-size setting.
   The user points Afterglow at their catalog once.
3. **Lightroom + DNG users** who enable "Update DNG Preview & Metadata": the DNG's embedded preview *includes their edits*.
   Extract and show it.
4. **Lightroom + proprietary RAW (CR2/NEF/ARW…), no catalog access:** the embedded preview is the *camera's* rendition, not the edit.
   Show it, but label it honestly ("camera preview").
5. **Anyone:** exported JPEGs always work.
   When a JPEG sits next to its RAW, prefer the JPEG and do not show the photo twice.
6. **Later (1.0+):** an optional companion Lightroom plugin (official Lua SDK) that auto-exports edited photos to an Afterglow cache folder.
   Faithful and supported, but it requires Lightroom running and a plugin install.

**Per-image renderer routing:** sidecar XMPs self-identify.
darktable writes `darktable:` namespaces (its history stack).
Lightroom writes `crs:` (Camera Raw Settings).
Sniff the XMP, then route to `darktable-cli` or the Lightroom tiers.
If only one path is available, use it (darktable can best-effort import basic `crs:` settings as a last resort).
The UI and the README must state these tiers plainly, so Lightroom users are not promised fidelity we cannot deliver.

---

## Full feature picture at 1.0

### Afterglow Desktop

**Display**
- Fullscreen slideshow: JPEG/PNG/WebP (later GIF, and HEIC via optional codec work), crossfade transitions, optional Ken Burns pan and zoom.
- Muted video playback (MP4/WebM/MOV, the honest list only, no AVI/MKV claims), with a per-video duration cap.
- RAW via the tiers above, with a background pre-render queue and a bounded, hash-keyed cache.
- Multi-monitor: all displays covered (mirrored or independent streams).
- De-duplication: RAW+JPEG pairs shown once.

**Story engine (smart ordering)** — the big differentiator over "shuffle":
- *Moments:* photos taken within a configurable gap (for example ≤3 minutes apart) form a cluster shown consecutively, capped at N photos (evenly sampled over the cap).
- *Sessions:* looser clusters (for example 10 photos across half an hour, or a day's shoot) played as a sequence to "take you back to that day."
- *Retrospectives:* this-day-in-history, one-photo-per-day-of-a-month, one-per-month-of-a-year.
- A mix engine interleaves cluster playback with random singles, avoids near-term repeats, and exposes mode weights in settings.
- All of this needs a **library index** (EXIF `DateTimeOriginal`, path, dimensions) built in a background scan and persisted.

**Overlay & capture**
- Path/metadata overlay: file location, date, optionally camera/GPS.
  Subtle, toggleable, positioned for TV viewing.
- Flag-to-queue: a single keypress while watching (**D**elete, **E**dit, **M**ove/misfiled, **R**eview) with an unobtrusive confirmation toast.
  The slideshow never stops.
  The queue persists across sessions.

**Organizer mode** (windowed, not fullscreen)
- Work through the flag queue: preview, then act (send to OS trash, reveal in file manager, open in editor, move to another folder).
  Each action clears the item.
- Culling assistant: surface bursts and near-duplicates from the index (time proximity first, perceptual-hash similarity later), side-by-side compare, pick the keeper.

**Platform & ops**
- Settings UI: media folders (multiple), durations, transition, story-mode weights, cache size cap plus a clear button.
  Persisted (`electron-store`).
- Exit on mouse-move/key/click through one code path (flag keys excepted).
- Idle/screensaver integration, per platform, in priority order: Windows `.scr` wrapper or Task Scheduler idle trigger, then Linux (systemd/X11 idle hooks), then macOS (Electron cannot produce a `.saver`, so use hot-corner plus launcher guidance).
- CI: lint, tests, tagged releases building Windows NSIS/portable, Linux AppImage/deb, macOS dmg.

### Afterglow (Android)

**The state model (m0.8.2).**
Three layers, spelled out in full in [docs/STATE_MODEL.md](docs/STATE_MODEL.md).
Read that before touching any surface that shows what has happened to a photo.
A photo carries exactly ONE verdict, any number of independent ACTIONS (each either waiting for you or carried), and any number of ANNOTATIONS.
The app's goal is inbox zero for the camera roll, achievable day by day: every photo eventually carries a verdict.

```
                                              ┌─▶ kept
(no state) ──in a cull group──▶ group review ─┤
                                              └─▶ culled ─▶ trashed
(no state) ──not in a group──▶ single review ─┴─▶ (same three)

pending actions, orthogonal to all of the above and to each other:
    edit · favourite · organize · share
```

Reviewed = has a verdict.
That one definition drives every "X of Y reviewed" number in the app.
Flagging a photo for editing is a pending action on a KEPT photo, not a fourth verdict.
Every verdict stays revisable until the final cull confirmation.

- **Cull groups — purpose (Tristan, 2026-07-24):** a group is a **de-duplication aid**: visually similar photos that could substitute for each other, from which a human keeps the best.
  Visual similarity decides membership.
  Time proximity may narrow candidates but never adds members (temporally close, dissimilar photos must NOT group).
  UNKNOWN similarity is different from known-dissimilar (Tristan, 2026-07-26): a photo whose embedding is unavailable attaches by time to its nearest embedded neighbour in the burst, until its embedding lands.
  That is the inclusive policy applied to missing signal.
  (Internal scan bookkeeping since m0.8.2: the user cannot act on it, so no surface draws it.)
  Byte-identical duplicates are the floor.
  Boundary calls err **inclusive**: ejecting a wrongly-grouped photo is one tap, while singles can never be promoted into a group (by design).
  A false inclusion costs a swipe, but a false exclusion costs a navigation loop.
  This is a different concept from desktop *moments*, even where machinery is shared.
  The same grouping engine is intended for desktop organizer culling (v0.7+), so investment here pays twice.
  The algorithm (m0.8, widened m0.9): on-device image embeddings (MediaPipe MobileNetV3-large) with a 3-min burst gate, centroid linkage, and adjacent-burst merges ≤60 min — beyond 15 min only for the same shot again (one member pair across the units at cosine ≥ 0.85), never merely the same place.
  Validated against a committed suite of human-judged pairs.
  dHash survives only as a time-gated exact/near-duplicate annotation.
  Groups persist, so completed days re-show them.
  **Parts (m0.9 phase 10):** a group is also cut into its looks — average-linkage parts at a bar relative to the group's own mean similarity, floored at 0.60 — and the deck shows the group part by part with a divider at each boundary and, under the Parts Overlay row (off by default), a "Part 2 of 4 · 5 photos" line in the position box; the Everything and day-page cards carry the same divider.
  Membership is untouched: a part is presentation, so Everything, History and the counts never see it.
  **Known limit (m0.9 phase 10, measured):** look-alikes beyond the hour, and a same-place pair that is not the same shot, stay apart — the embedding does not tell the same vantage from the same place (the trigger backlog's "Far look-alike links").
  1-photo groups are singles.
- **Review order — one timeline (m0.8.2):** the review queue is a single newest-first timeline of units: groups (anchored at their newest member) interleaved with runs of ungrouped singles, split at day boundaries.
  Recent singles come up where they were taken, instead of behind every group.
  The overview renders exactly the order the flow walks.
  Completing any unit advances to the next one in time.
  "Continue reviewing" on Home jumps straight into the next unit (the overview is one tap away, on the queue-breakdown numbers).
  Crossing the daily goal celebrates in the deck, at the crossing decision, once per day.
- **Group review — swipe deck:** each unit is a swipeable deck.
  Keep or cull any photo, keep the rest, flag to-edit, star a best (groups), or eject an unrelated photo ("Not related", groups).
  Every deck pages newest-photo-first and opens on its first pending photo.
  A decided photo stays in place wearing its badges: the verdict plus any of edit/favourite/organize/share, none hiding another.
  Re-tapping the active verdict clears it, in groups and singles runs alike (m0.8.2 unification: one deck, one behavior).
  Units can be entered in any order, and every decision is reversible until the final cull confirmation.
  Deliberately reopening a completed unit stays in browse/re-decide mode.
- **Compare:** any two undecided-or-KEPT deck photos go full-screen A/B.
  Tap to flip (better than side-by-side on a phone), with synchronized pinch-zoom for sharpness and eye checks.
  Labels keep the photos' deck numbers, and all four action chips ride along.
  A duel writes verdicts only when it IS the whole table (m0.8.2): any singles duel, or a group whose undecided remainder it settles (≤ 2 alive).
  There, "X is better" raises the keep-both/cull dialog.
  "Keep both" marks BOTH kept.
  "Cull" stages the loser and leaves the winner untouched.
  A persisted don't-ask preference auto-culls.
  A duel with 3+ alive is triage: star plus history, no verdict.
  Comparing against an already-kept photo is a legitimate re-decide.
  Every duel is stored cheaply as compare history (no extra comparisons), so later features can mine it.
- **Cull list:** a durable global queue.
  Staged culls persist, badged with their verdict wherever they resurface, until the final confirmation.
  The list is reviewable.
  One final confirmation then batch-moves the photos into the **system trash** (the recovery duration is gallery-managed, with one system dialog per bounded batch).
  **Afterglow never permanently deletes a photo.**
  The Android 11 floor guarantees a system trash exists, so the invariant is unconditional and there is no fallback to design.
- **Single review:** photos outside any group review through the SAME deck as groups (m0.8.2): as day-split runs on the timeline, or as a whole day's singles from its day page.
  Identical controls, identical decided-stays-badged behavior.
- **Media kinds (m0.9):** photos, videos, motion photos and GIFs review in the same deck.
  A video pages like a photo, muted, playing on settle under Settings › Playback (Once · Loop · Off per kind), with one chrome set revealed by a stage tap: play, pause, replay, the speaker, a seek track and expand.
  A motion photo is a photo for grouping, zoom and Compare and a video while its clip plays; a GIF animates natively with no chrome.
  Videos take every verdict and every action and sit out Compare.
  Kind chips (GIF · Motion · Video) are annotations, and every clip thumbnail wears its kind mark on every surface.
- **The deck is the one surface (m0.9):** there is no standalone viewer.
  Queues, History, the Progress grids and the day pages open their photos in the deck in list mode, in the host's order, with zoom, an expand button to the edge-to-edge stage and a details corner that names the day and time, the format, the resolution and a video's duration.
  Settings › Overlay switches each on-stage badge, and the eye hides the whole set.
- **Animated thumbnails (m0.9):** every thumbnail surface plays the clips on screen through pooled players over the OS thumbnail, bounded by the viewport; Settings › Playback offers Off · One · All.
- **The queue family:** every queue is a durable, reviewable in-app list.
  **To-edit** is per-photo: the Edit button fires `ACTION_EDIT` into the user's editor, and a manual "mark done" is always available.
  **Favourite** applies in one batch via `MediaStore.createFavoriteRequest` and surfaces as the gallery's heart.
  **Organize** is two-step (since m0.8.2): the deck button just queues the photo (a toggle, like share).
  The queue screen assigns albums in batches over a selectable grid, then applies verified `createWriteRequest` + `RELATIVE_PATH` moves per target.
  Duplicate album names show their folder paths.
  A failed move explains itself in three tiers, classified from facts the app owns, and the album picker offers only targets Android accepts (DCIM/Pictures).
  **Share** is a persistent working set, shared in multiple sharesheet passes over chosen subsets.
- **External media (m0.8.3):** removable volumes are first-class photo sources.
  Every photo id, source folder, and content URI is volume-qualified, so an SD folder is its own picker row wearing an "SD card" tag.
  **Reachability is scope, not state** (docs/STATE_MODEL.md).
  Ejecting a card writes nothing.
  Its photos simply leave every queue, count, grid, and forecast pool until remount restores them byte-for-byte.
  Decision HISTORY and lifetime stats keep counting them (completed work is fact wherever its pixels live).
  The unreachable state is always named: a Home banner with counts pressing through to Settings, "N on unmounted SD card" on group cards and deck headers, a Settings source tag, and greyed picker rows.
  This is live, via OS mount broadcasts, not only on refocus.
  Writes follow the **M5 rule**: explicitly targeted actions work regardless of mount state.
  Untargeted bulk actions bind to what was rendered and reachable (a fresh read only shrinks them).
  Physical operations require the bytes.
  The scan runs a per-volume contract (per-volume baselines and tripwires).
  An unmounted volume is skipped whole.
  Groups holding an unreachable member are frozen, though they still GROW when a new photo clusters with their reachable members.
  **"Forget this card"** (Settings, per unmounted volume) retires a card two ways.
  Keep review history: decisions and stats survive as tombstones, and a returning card re-ingests state-intact.
  Or erase everything: all-time counts visibly drop, and the confirmation names the number.
  Undated photos get a one-time **EXIF date rescue** (a native header read).
  Found dates become the real capture day, so NEFs land on their shot date.
  The RAW policy is binary per format: DNG/NEF/ARW are fully reviewable, and CR3 is invisible to Android and dropped.
- **History:** a re-decidable, filterable current-state feed of photos still present, plus share-sheet events.
- **Edit detection on app open:** two heuristics, because Android editors differ.
  Samsung Gallery (and similar) edit **in place**: same file, changed content.
  Detection is a MediaStore generation, `date_modified`, or hash change, and the edit action then resolves itself.
  Other editors (Google Photos, Snapseed) save a **copy**, detected via sibling-name and timestamp sniffing.
  The copy is recorded as kept, and the app asks whether to keep or cull the original.
- **Continuous scan & progress (m0.8):** on app open, a chunked scan pages the configured folder newest→oldest, hashing and grouping incrementally.
  The deck fills as results land and is enterable within seconds.
  Two independent, presentational goals drive Home and Stats, each with its own indicator and chart.
  The **count** goal (photos reviewed per day: chips 25/50/100 plus any custom whole number, default 50) is scored on DECISION days.
  The **coverage** goal ("leave nothing unreviewed from the last N capture days": Off/Today/2 days/7 days/All, default 2 days) is scored on CAPTURE days.
  All time is the 100%-of-library goal and the only mode that counts undated photos.
  Streaks: a count-goal streak day is a day the goal was reached.
  A coverage streak day is a shooting day that ended fully reviewed (days with no photos neither break nor extend it).
  Home shows live corpus stats (total, groups found, % reviewed, reclaimable estimate) plus per-day and global progress browsing.
- Later: iOS (deferred post-1.0 until there are iOS users/testers).

### Shared core — `@afterglow/core`

Pure TypeScript, with no filesystem or platform APIs.
Both apps feed it `MediaItem[]` (id, timestamp, path/uri, kind) through their own adapters:
- Gap-based time clustering (moments/sessions) with configurable gap, cap, and sampling.
- Embedding cull grouping (`groupByEmbedding`): the m0.8 engine behind mobile cull groups, intended for desktop organizer culling too (v0.7+).
- Playlist/mix engine and retrospective selectors.
- Flag-queue state model (flag types, staged actions, undo, serialization).
  Mobile review state is DB-backed since m0.8, which retired the culling/deck session models there.
  The desktop organizer (v0.7) brings its own compare model.

---

## Repository layout

Monorepo (this repo), npm workspaces:

```
afterglow/
├── packages/core/        # @afterglow/core — shared pure-TS logic + its tests
├── apps/desktop/         # Electron app (main, preload, renderer)
├── apps/mobile/          # Expo React Native app
├── docs/                 # development setup, release plans, open-question TODO
└── .github/workflows/    # CI: lint/test + release builds
```

---

## Release roadmap

Two trains.
v0.1–v0.5 and m0.1–m0.8.8 have shipped.
Next up: the desktop RAW pipeline (v0.6) and mobile m0.9.

### Desktop train

**Shipped**
- **v0.1** — fullscreen crossfade slideshow (JPEG/PNG/WebP) from user-picked folders, persisted settings, exit on input, preload+contextBridge security, CI-built Windows/Linux releases.
- **v0.2** — path/date overlay.
  D/E/M/R flag capture with a persisted queue plus the queue window.
- **v0.3** — story engine v1: background EXIF indexing, moments clustering plus the mix engine from `@afterglow/core`.
- **v0.4** — muted video (MP4/WebM/MOV) in the rotation, with a per-video duration cap.
- **v0.5** — feedback release: settings-first launch (the show exits back to settings; `--show` goes straight in), arrow-key navigation with history, the shortcut legend, N/T flags (rename, date fix), video cap 0 = full length, display-sleep suppression, warm start from the persisted index, and the Windows "Set as default screensaver" button (`.scr` via the NSIS installer, same settings store).

**v0.6 — The RAW pipeline (next)**
An `execFile`-based `darktable-cli` wrapper (never shell strings).
A cache keyed on hash(path + XMP mtime + output size).
A background pre-render queue with a concurrency limit that stays ahead of playback.
A cache size cap, LRU eviction, and settings UI.
Per-image renderer routing by XMP namespace (`darktable:` vs `crs:`).
Embedded-preview extraction for the Lightroom tiers, with `Previews.lrdata` catalog extraction as the stretch goal (or a v0.6.x follow-up).
RAW+JPEG pair de-dup.
*This is the release where it becomes Afterglow.
Budget a real week.
It is the hardest engineering in the app.*

**v0.7 — Organizer mode**
Queue actions: OS trash, move, open in editor, including the rename and date-fix flag actions.
A burst-culling compare UI over the index.

**v0.8 — Retrospectives + multi-monitor + polish**
This-day-in-history and month/year modes.
All-displays support.
Overlay and settings polish.

**v0.9 — Screensaver: Linux + macOS, auto-update** (Windows shipped in v0.5)
Linux idle hooks (systemd/X11).
macOS hot-corner plus launcher guidance (no `.saver` from Electron).
Auto-update (electron-updater) lands here too.

**v1.0** — hardening, docs, code signing (a Windows certificate and macOS notarization — until then, SmartScreen "More info → Run anyway" stays the documented tester path), and whatever the testers demanded loudest.

### Mobile train

**Shipped**
- **m0.1** — trip-ready duel culler: time-clustered cull groups, pairwise duels, staged cull → one confirmation → system trash, SQLite state.
- **m0.2** — the full state machine: `to-edit` in duel and single review, the in-app to-edit queue with `ACTION_EDIT`, day-scoped inbox-zero progress.
- **m0.3 / m0.3.1** — edit detection on app open, auto-cull hints, A/B flip compare plus synchronized zoom, source folders.
- **m0.4** — perceptual-similarity grouping (dHash), **swipe-deck group review replacing the duel bracket**, progress browsing, Material You theming.
- **m0.5** — feedback release: editor launch fallback (`ACTION_EDIT` → `ACTION_VIEW`), a looser similarity scale (12/16/20/26/32) plus a 0–64 fine-tune slider, decisions reversible until the final confirm, session flow freedom (any order, banked decisions, "End session & apply"), Sessions settings (cap 50 default, group-boundary softness, oldest/newest first), compare fixes (best-of-group semantics, the "Compare with…" picker, group-number labels), deck pinch-zoom, and the gear icon.
- **m0.6** — feedback + feature-completion release: decision indicators everywhere with re-tap-to-clear, group cards reopen the group, singles unified into the deck as a pseudo-group, completed groups advance immediately, the favourites queue (♥, batched `createFavoriteRequest` native module), lifetime stats plus streaks, the progress-bar fix, a startup/analysis perf pass, the Material icon language, and editor-launch diagnostics (the fix itself carried to m0.7, below).
- **m0.7** — feedback release.
  Editor launch fixed at the root: request MediaStore write access first, then `ACTION_EDIT`, with a two-button edit queue (✎ Edit plus a read-only Gallery button).
  Similarity-first grouping v2: time proximity only ever helps, never excludes.
  Groups are always ≥ 2 photos, with a legacy time-only toggle.
  Durable SQLite group membership.
  The deck relayout: Keep / Compare / Cull, plus the queue row Edit · Favourite · Organize · Share.
  The **share queue** with multi-pass sharing: overlapping subsets across repeated sharesheet passes, pass badges plus labels, and the honest `sheet_opened` state.
  The **organize queue**: verified `RELATIVE_PATH` moves to primary-volume albums.
  The **Favourite queue** rename plus atomic batches.
  Silent lossless session replacement with the **durable global cull list** (kept, edit, and staged-cull decisions all survive).
  The crash-safe trash-attempt lifecycle: verified per-photo outcomes, at-most-once reclaimed-bytes credit.
  The **History** feed.
  Canonical volume-qualified photo ids.
  The fresh-baseline schema policy: destructive DB reset between 0.x versions, with migrations returning at v1.
- **m0.8** — sessions removed.
  A continuous newest→oldest scan feeds the durable tables.
  Nothing to start or apply: decisions save at swipe.
  Embedding groups: the MediaPipe MobileNetV3-large local module, burst gate, centroid linkage, adjacent merge, and the human-judged CI regression suite.
  Bottom tabs **Home · Edit · Favourite · Share · Organize**, with the goal-ring Home: a presentational daily goal plus goal streaks, live corpus stats including exact reclaimable bytes, and the 3-recent plus still-to-review day layout with the **Unknown day** pseudo-day for undated photos.
  Culled photos stay badged in the deck (the badge is the undo).
  One standard full-screen viewer with per-photo decision detail.
  State-aware re-decisions.
  "Reviewed" = every verdict.
  Write priority: user decisions outrank scan writes.
  The app renamed to **"Afterglow"** (id unchanged).
  Schema v14, where v13→v14 is the one additive migration.
  42-round adversarial review hardening: every group write validates presence plus rendered assignment in-transaction, fail-closed source scoping everywhere, atomic settings flows with honest rollbacks, and snapshot-consistent queue reads.
- **m0.8.1** — feedback + performance release.
  Decision writes resolve at commit, with parity-tested optimistic queue patches (no more scan-blocked "Saving…").
  The goal-ring arc geometry fixed, and the ring now counts today's review WORK (`decided_at`, re-stamped per verdict).
  A Home copy and layout pass: tab-duplicated queue rows removed, a per-line breakdown.
  The bottom bar **Edit · Favourite · Home · Organize · Share**, with a raised center Home button and an active-tab indicator.
  Queue-screen headings plus the shared shell (`useQueueRows`/`QueueViewer`).
  Album-picker search.
  A UI-consistency sweep: one title per screen, insets, bottom sheets.
  Scan status shows a real percentage.
  **Performance and battery:** the unchanged-library scan skip (a MediaStore generation fingerprint — an unchanged library costs one native call, not a ~6 min re-walk).
  The review-queue query de-quadratified (15 s → 0.4 s, with the plan pinned in CI).
  The source catalog from one native cursor walk instead of a probe per bucket (35 s → 0.5 s on an 895-bucket device).
  Scoped group repair (previously unbounded per scan window).
  Four measured indexes plus `ANALYZE`/`PRAGMA optimize` (schema v16).
  No-change refreshes commit nothing.
  Badge polling removed.
  Bounded-parallel native round trips.
  Cold start to usable Home: 39.7 s → ~4 s (S10e) and 6.6 s → ~3 s (S23).
  Full 27k scan: ~390 s → ~204 s.
  New: the Stats page, queue badges on every photo, the `scripts/mobile-ui-gate.mjs` pre-release UI gate, and the second **coverage** goal ("Keeping up") with its own Home card and Stats chart, alongside a custom count-goal value.
- **m0.8.2** — forecast, the Progress redesign, and the photo STATE MODEL straightened out.
  **The app learns to look forward:** a finish-line date from your actual trailing pace, with the goal pace beside it.
  It refuses to print a date when intake outpaces reviewing, and shows the growth rate and break-even pace instead.
  Projected culls/edits/favourites/shares as ranges from your own chunked base rates.
  "Hours of tapping left", gated on a split-half stability check, with a sitting rhythm derived from your own pace.
  Its headline IS the Home Progress row's subtitle.
  **Progress, redesigned from scratch:** state chips that double as the composition-bar legend (the grid now starts 58% down the screen, not 72%), a horizontally scrolling capture histogram by month that *filters* the grid, the backlog frontier, storage by state, and the burst tax.
  **Stats becomes Activity · Forecast · Habits**, each tab loading its own query set on first open: intake vs review, reviewing rhythm (weekday × hour), per-queue turnaround ("3 waiting · oldest 9 days · usually done within 2 days" — no completion RATE, because queues built to drain make any such rate read ~100% for everyone), the decisiveness trend, and milestones.
  These spend `duels`, share batches, and the queue timestamp pairs, which no screen read before.
  **The state model (docs/STATE_MODEL.md):** one verdict per photo (`unreviewed`/`kept`/`culled`/`trashed`).
  `to_edit` stops being a verdict, and `done` is spelled `kept`.
  Any number of ACTIONS live in one `photo_actions` table, replacing three column shapes plus the share-queue table.
  Annotations are never states.
  The four actions align by rule, and each badges at two weights: loud while it waits for you, quiet once the photo merely carries it.
  Fill = reviewed everywhere.
  Grouping moves to an underline, selection becomes an outline, each kind's hue is reserved for that kind (red doubles as the danger colour, nothing else doubles), and the accent means interaction only.
  Also: the day page's "Continue reviewing" is day-scoped on both legs, so it can no longer open a different day's photos.
  **And the scan stops re-walking the library:** a DELTA pass asks MediaStore which rows changed since the last per-volume generation, walks the real merge-window bounds around each one, and re-pages only those.
  262 s → 0.25 s on a 27k corpus, with byte-identical grouping (a full pass is the same code over one unbounded range).
  Deletions arrive as trashed rows, since an Android 11+ gallery delete keeps the row with `IS_TRASHED` set; a delete that bypasses the system trash (Samsung Gallery's Recycle bin deletes the row outright) shows only as a volume count that fell, and an ids-only MediaStore enumeration names the missing rows in seconds (m0.9).
  Counts are checked before AND after each pass, and every uncertainty falls back to a full pass, which names its reason on Home and in Settings (m0.9: Initial scan, Weekly full scan, Rescanning · settings changed, Rescanning · manually triggered, Rescanning · model changed, Rescanning · grouping changed, Scanning new storage, Reconciling deletions, Rescanning · dates changed, Rescanning · many changes, Rescanning · counts disagreed, Rescanning · delta check failed; a resumed pass shows the interrupted pass's own reason with a "resumed" marker, or "Resuming last scan" without one; the table lives in `lib/scanProgress.ts`).
  A full pass checkpoints each closed window's boundary and resumes below it on the next open (m0.9); the screen stays awake while a pass runs in the foreground.
  The scan notices changes through MediaStore's observer, every foreground return, and pull-to-refresh on Home, Everything and Progress; no timer polls (m0.9).
  Schema v18 (destructive reset, pre-v1 policy), which discards the embedding cache.
  The upgrade costs one ~25-minute re-analysis on a 27k library.
  Also: the vestigial range scope is deleted (sessions took the feature that set it), and the coverage goal stops disagreeing with itself between Home and Stats.
  **The 16-item tester backlog closed the release** (docs answered per item, and the release was HELD until it cleared).
  Review became the merged newest-first TIMELINE above, with one unified deck: decided singles stay in place badged, every deck pages newest-photo-first and opens on its first pending photo, and headers are truthful (unit progress plus library remainder, no page ordinals).
  "Continue reviewing" goes straight into the next unit, and Android back exits through Home.
  Organize moved to the two-step queue-assigns-albums flow.
  Compare gained the whole-table verdict dialog, kept-photo eligibility, and the four action chips.
  Home cold start renders ghosts and fills in place (permission is tri-state — no more ask-card flash).
  A running scan shows its percentage on Home and in Settings, with ONE library total everywhere.
  Stats gained all-time records (longest goal streak, most in one day — deliberately no guilt counters).
  Crossing the daily goal celebrates at the crossing decision (deck or Compare, once per day).
  The vocabulary settled: the deletion pipeline speaks "cull" (the OS moment alone says "Trash"), "queued" is the to-do word, and queue screens are "<Action> queue".
  No on-device ML.
- **m0.8.3** — external media: removable volumes as first-class sources.
  Volume-qualified identity end to end: canonical `<volume>/<rawId>` ids parsed from uri paths, constructed per-volume content URIs, and a native canonical-URI details query (raw MediaStore ids interleave across volumes, measured).
  Schema v20.
  **Reachability is scope, not state:** eject and remount write nothing.
  Queues, counts, grids, and the forecast pool scope to mounted volumes via one burst-cached provider fed by live OS mount broadcasts.
  History stays unscoped.
  Every unreachable state is named with counts.
  Bulk writes bind to the rendered reachable set (the M5 rule).
  A review-cycle family of ~30 fixes made that discipline hold on every path.
  **Per-volume scan contract:** mounted enumeration required (the scan fails closed, queries fail open), per-volume count tripwires on both sides of a delta, baseline merges that let a remount resume its delta, mid-pass mount fences, and unreachable-frozen groups that still grow.
  **D15 EXIF date rescue:** MediaStore-undated photos get one native `ExifInterface` header read at ingestion, with a once-per-content marker.
  D300s NEFs land on their real capture day (device-proven), and day grids page SQLite so rescued photos count everywhere (D16).
  **Data lifecycle:** automatic tombstones on permanent deletes (satellites swept, duel history survives restorable trashes), and "Forget this card" keep/erase with positive-absence checks, a durable scan-skip defeat, and honest count-naming copy.
  **RAW policy (binary per format):** DNG/NEF/ARW are fully reviewable.
  CR3 never enters MediaStore's image collection: dropped from the roadmap, documented for testers.
  Organize's SD limitation is named at queue time ("moves are not supported on SD this release").
  Built through a 10-round three-reviewer codex cycle (~75 fix groups, with the snapshot-discipline defect family now in docs/REVIEW_CLASSES.md), a full decision grilling, and the two-phone device matrix.
  714 tests, with the UI gate on the final build.
- **m0.8.4** — drop Android ≤ 10.
  The floor is `minSdkVersion` 30, pinned with `compileSdkVersion`/`targetSdkVersion` 36 via `expo-build-properties`, so the platform enforces it: sideloads refuse with `INSTALL_FAILED_OLDER_SDK`, Play hides the listing, and every local Expo module compiles at 30.
  That is what makes the legacy branches provably dead rather than merely unreachable.
  Below Android 11 there is no system trash, so culling, the product's core loop, had never worked there while the app still installed.
  Deleted with the floor: the pre-API-30 album-catalog fallback and the four-link helper chain only it called, the merged-collection URI shape, the API 24-28 mounted-volume arm, the API 24-27 bitmap decode fallback with its `exifinterface` dependency, ten Kotlin gates, and six screen gates with the "requires Android 11" copy they guarded.
  The trash invariant is now unconditional.
  Two floor assertions guard the regression: `release-preflight.mjs` on the input, and an unconditional `aapt` step on the built APK.
  One non-legacy change rides along: day labels always carry the year, so two "17 Aug" rows a year apart are distinguishable.
  Two admitted exceptions ride along too.
  A failed organize move now explains itself: a three-tier dialog classifies from facts the app owns, never from Android's error text, and always quotes Android verbatim last.
  And the acceptance round deleted the app-side organize allow-list (`ORGANIZE_ROOTS`): Android is the only authority on move targets, while the album picker filters to DCIM/Pictures so it stops offering albums Android will refuse.
  727 tests in 47 files.
  Device matrix: S23 (API 36), S10e (API 31), and an API 30 emulator, plus a proven install refusal on API 29.
- **m0.8.5** — the review loop.
  **One deck.** Groups and day-scoped singles runs review on one route; the unit is state and advances in place.
  The chrome (header, strip, controls) never remounts; while the next unit's rows load, the deck renders a frozen view of the previous unit with every control inert, and a decode underlay covers image latency — no blank frame, no control flicker, and the goal moment can play over the unit that earned it.
  The pager FlatList is deliberately keyed per unit: a fresh native list is born scroll-disabled on its unit's first pending photo, and the old list's offsets, momentum and in-flight animations die with it, so the stage, position badge and strip highlight can never disagree.
  A newly loaded unit opens on its first pending photo regardless of last-minute swipes (a 400 ms settle window swallows finish-adjacent gestures and stale scroll events).
  **The goal moment.** Every verdict write credits the day's goal itself (`ReviewDecisionResult.freshDecisions`, the once-per-day rule: a photo counts once per `decided_at` day, matching the ring exactly) — the deck, Compare, re-decides, un-stagings, and the edited-copy cull prompt alike.
  The celebration marker stores day AND goal, so raising the goal past today's count re-arms the moment; lowering never does.
  Review surfaces host the moment while mounted, the focused one draws it, a crossing with no host says so in a toast, and the deck holds a completed unit until the moment finishes.
  **Feel.** The thumbnail strip follows the photo live; a pan flick keeps its momentum (decayed within pan bounds; a stream that zoomed never flings); a pinch is one contiguous two-finger stretch (finger changes re-anchor and re-prove, single-finger quick-scale can never zoom); "Saving…" appears only when a write actually runs long.
  **Truthful surfaces.** Progress displays are keep-green throughout with completeness carried by geometry (the accent means interaction only — STATE_MODEL rule 3 now has one deliberate exception, the best star); milestone bars take the hue of what they count; a running scan never claims "All reviewed"; the deck's time badge names its capture day from `photos.day` (undated photos say "Unknown day"); the coverage streak reads "Most recent N days with photos fully reviewed"; action chips and the Best control visibly dim on a staged cull on every surface.
  Built through six device-pass rounds and two closing grillings (28 vetted decisions), a three-round three-reviewer codex cycle (14 findings fixed, 2 parked in docs/TODO.md with evidence), and a UI gate that gained its first frame-level measured step: the finish advance is screenrecorded and pixel-checked for blank stages and vanished controls.
  783 tests.

- **m0.8.6** — the browsing surfaces.
  **The Timeline.** The review overview becomes the full **Timeline**: every group and singles run, newest-first, under three chips — **Everything** (a separate DB-paged keyset browse read: browse-group and singles streams merged descending, units assembled incrementally with the tail run open across pages; since m0.9 the group stream walks each group's stored anchor by index — under a millisecond a page at 5.6k groups on the workstation seed — verdicts patch the rendered rows in place, and only a membership change re-walks the stream, to the depth on screen, with the old stream rendered until the fresh one replaces it), **Unfinished** (the pending feed exactly as before, its horizon truncation named out loud in a footer), and **Unreviewed** (a pure display subset). The last choice is remembered.
  **One switch rule on exact geometry.** Every unit card is a style-pinned uniform height (one-line header, five thumb slots, "+N" past five), so `getItemLayout` is exact and every landing deterministic on a cold list; each filter owns its keyed FlatList — no scroll state ever bridges a switch.
  The rule: at the top of any filter a switch lands the target's top; elsewhere the unit at the viewport top becomes the target's top; the pending feeds clamp a past-horizon anchor to their bottom, and one memory slot restores the deep Everything unit on the return while the reader still sits on that clamp.
  An anchor deeper than Everything's loaded pages holds and pages toward its target; a drag during the hold abandons it.
  A back-to-top disc appears past ~a dozen cards, and its tap IS a top landing.
  Every programmatic landing sets the offset, disc, and viewport-unit mirrors by hand to the achievable geometry (Android emits no onScroll for them), and a brief post-jump window discards straggler events.
  **The state editor.** A photo's whole state is editable from the standard viewer on Progress, History, and the queues: one verdict, all four actions, open across writes, refusing only what genuinely cannot be undone (un-review deletes the group's Compare duels, group-wide, behind a confirm).
  **The freeze and the star.** The regroup freeze narrowed to a literal derived rule — a decided ungrouped photo is frozen, a group holding unreviewed work is rebuildable — so un-reviewing returns a photo to the scan's reach.
  The star concept is fully retired (schema v21 destructive rebuild); Compare gains a triage keep.
  **Share resolution.** Delivery resolves on the chooser's chosen-component event with abandoned-sheet discard, a durable launching mark, bounded retries, and the label prompt deferred to a live activity.
  **History.** An externally removed decided photo becomes a tombstone **in place** — no restamped activity, no top-leap, no scroll reset; its live action legs clear with the DB cleanup (the carried favourite direction re-read post-transaction); a dead photo in the viewer says so instead of a black stage, zoom included.
  Plus the rescued-date defect (a D15-rescued photo's real date now reaches the Progress scopes), the histogram keeping its selected month on screen, day labels with years, and the zoom walking pan anchored to touch position.
  Built through the closing grillings (11 + 3 questions), two full device passes, and a nine-round three-reviewer codex cycle (six to convergence on the release delta, three on the closing fixes; ~46 finding groups fixed, 3 refuted with evidence).
  848 tests; the UI gate passed on the final build.
- **m0.8.7** — sources, badges, and the queues; groups land as truth.
  **The regroup freeze retires.** Grouping is pure presentation: groups grow, shrink, and re-form freely under every scan, and photos own their state.
  The one durable membership judgment is the **"not related" cannot-link pair** — eject records a pair against every present group member (directional storage so the dissolution rule and un-eject know whose judgment each row is; enforcement symmetric, in core, at merge time and re-checked in the write transaction), ejecting a photo dissolves pairs where it stood as partner (two photos ejected from one group can reunite elsewhere), and un-eject clears the photo's own pairs and lands its re-placement in seconds through a **targeted stampless rescan** on the scan's single-flight.
  **Duels become an append-only event log** (schema v22 destructive rebuild): pair-keyed, written by Compare, deleted by nothing — forget-card erase anonymizes endpoint ids and keeps the row — so Compare's lifetime stats are exact and un-review is fully non-destructive (its last confirm dialog is gone).
  **Source selection becomes the second scope axis** (F18), exactly like mount state: deselecting a folder writes nothing, and its photos leave every queue, count, grid, bulk binding, and the forecast pool until re-added (measured on the floor device: 3–32 ms scoped queue reads).
  **Per-kind suspension** (F21): share and edit stay live on a staged cull — share-then-delete works end to end — while favourite and organize suspend; the cull confirm names unsent share/edit intents, and dispatching a share with a pending edit asks first.
  **The error contract** ([docs/REVIEW_CLASSES.md](docs/REVIEW_CLASSES.md)-hardened, from the settled Errors design): every boundary where Android can refuse — favourite, trash, share, edit-launch, organize — answers with three tiers built from facts Afterglow owns (verified counts, pipeline stages, typed probe verdicts), never from parsing Android's text, which is quoted verbatim and last; `plural()` ends the hand-rolled agreement ternaries.
  **F27's measured cause fixed**: the delta planner filters the changed set to the source scope by current bucket, in-source undated changes land by direct volume-qualified per-id fetch without a corpus walk, and every planner fallback logs its reason.
  **Every console line persists** to a rotating on-device diagnostics sink (50 MB, adb-pullable) with a global error hook and a provider-stack error boundary — release crashes finally leave a trace.
  **The stats-accuracy sweep**: culls classify by the lifetime `culled_at` stamp (external deletions never re-file a keep), `decided_first_at` makes day history immutable with the goal ring crediting only first decisions, one all-time streak definition, the intake chart's two series describe one population, and the scoping contract splits by purpose — achievement and habit stats read decision history unscoped on both axes, planning stats scope to the selected mounted library ([docs/STATS_ACCURACY.md](docs/STATS_ACCURACY.md) is the living contract); two figures retired until an event log can back them truthfully.
  Also: gallery hearts project into the action vocabulary at scan time (F20), the badge family gains folder and SD annotations with one durable hide toggle (deck header + viewer), the queues share one destructive-styled removal affordance, the Progress grids hydrate full action glyphs, and the three source-picker defects were fixed from on-device measurement (F10/F11/F12).
  Built through a 20-decision vetting grilling and a three-round three-reviewer codex cycle (31 finding groups fixed); 903 tests.

**The 2026-08-20 feedback round (shipped across m0.8.7, m0.8.8 and m0.9).**
F21–F30, settled in an 11-question grilling; F31–F34 joined the m0.9 half, and the m0.9 device passes added F35–F45; every item's answer is in the three shipped entries below, and the round's doc retired with m0.9 per its own lifecycle.

- **m0.8.8 — the review deck** (the 2026-08-20 round's deck cluster: F22 F23 F24 F28 F29).
  **The advance** (F23+F24): an advancing decision jumps both deck kinds to the nearest unreviewed photo — forward first, backward at the tail, staying put when none remain (`lib/deckAdvance.ts`); browse-mode re-decides stop yanking the cursor.
  **The verdict row** (F28): one weighted row — Keep (1.4) · Compare (1) · Not related (1) · Cull (1.4) — always present, disabled where inapplicable, unifying group/singles geometry and reclaiming ~68 px of stage.
  **Compare verdicts** (F29): Keep (green) and Cull (red) both write immediately; one binary complement prompt for the other photo fires only while it is unreviewed, each direction with its own remembered answer (Settings resets both); the whole-table machinery, "is better", and `kept_both` minting are deleted — one duel row per compare, no verdict re-stamps, net-negative code.
  **Pixel-perfect zoom** (F22): a two-layer region pipeline on all three zoom surfaces — a dwell-warmed **base** (whole image at the largest power-of-2 sample reaching `max(stage px, 3840)`, 128 MB guardrail) carries every gesture; a **patch** (visible region plus byte-budgeted margins, ≥1 source px per physical screen px, aligned to a 512 sensor-px grid) carries every settled view, decoded speculatively mid-gesture and applied seamlessly (stable always-mounted view tree, empty-first double-buffer slots, float-exact transform positioning).
  Delivery is zero-copy `SharedRef<Bitmap>` into expo-image with downscaling disabled; EXIF display↔sensor mapping is pure and tested; visited bases retain in a 192 MB byte-MRU flushed on unit advance and memory trim (fixed budgets, loud exhaustion logs, no user knob — D9).
  Max zoom is dynamic per photo: `clamp(10 × the 1:1 scale, 24, 240)` — deliberately deep into reconstruction territory (sharpness adjudication between near-identical shots; the S23 pass raised it in four judged rounds).
  **The gesture rewrite**: ONE tracker (`zoomTouchFrame`, react-native-zoom-toolkit's pinchTransform algebra) owns scale and translation off a single per-stream anchor — focal-locked pinches from the first frame, walking-pan continuity, clamp coherence; stream ownership is explicit (the stage pinch must activate to claim a stream from the pager; an overlay claim stands the stage handlers down); sub-flick release velocities dead-band so a hold-then-lift moves nothing.
  Platform rules hardened into the code headers: no `runOnJS` from gesture worklets, gesture callbacks inline-only, no host-view mounts under the intercepting detector mid-touch, expo-image swaps `SharedRef` bitmaps asynchronously (hence empty-first slot reuse), and the measured stage view must be borderless — Yoga insets absolute children by the border while `onLayout` reports the border box, a 2 dp seam that deep zoom magnifies into a visible jump.
  Built from a measured pre-plan spike (`app_process` BitmapRegionDecoder benchmark — recipe in [docs/ANDROID_DEVICE_TESTING.md](docs/ANDROID_DEVICE_TESTING.md)), a 9-decision pre-build grilling, sixteen tester screen recordings root-caused by frame forensics against the diagnostics sink, a three-round three-reviewer codex cycle (20 finding groups fixed; classes 53–65 in docs/REVIEW_CLASSES.md), a 13-question close-out grilling, and the S23 ship-gate pass with three judged reopen rounds (verdict row 1.75, one-word Compare, no Compare success toasts, zoom to 10× past 1:1); 932 tests.

- **m0.9 — media kinds** (the 2026-08-20 round's remaining half — F25 F26 F27 F31–F34 — plus its riders F35–F45 and the m0.8.8-ship additions; every decision settled in the 23-question pre-build grilling of 2026-08-26; the one-subsystem rule L1 deliberately dropped for this release, the exception and not the norm).
  **The media model.** Photos, videos, motion photos and GIFs: a motion photo is BOTH — a photo while its still is in play (full zoom on the JPEG primary, grouping, photo metadata) and a video while its clip plays — and a GIF is a photo that animates natively with no chrome.
  MIME classifies (chips, playback routing) and the display name renders the extension (uppercase, no dot — JPG, HEIC, DNG, MP4), each layer honest about what it claims.
  **Videos enter review** (F26) as singles interleaved by capture time — no embeddings, no dHash, no content hash — compatible with every action and the full verdict set, muted by default, pinch inert, excluded from Compare (a motion photo compares as a photo).
  Identity is kind-aware end to end (`MediaRef`: the `/images/media/` or `/video/media/` collection per stored kind), the native module reads the Files collection, one batch `queryMediaFacts` per page carries MIME, name, dimensions, duration, size and `GENERATION_MODIFIED`, and full access needs BOTH `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` on API 33+ — with either missing, presence reads go unknown for every kind.
  **Motion photos** (F25) detect at scan time from one bounded native read per content version (`readMediaFacts`: androidx ExifInterface's XMP parsed by local name, never prefix — Motion Photo 1.0 and MicroVideo, Samsung and Google, JPEG and HEIC), stamped by a `facts_checked_version` marker so the weekly full pass IS the one-time backfill; the Samsung SEF trailer is a once-per-pass tripwire, not a detector (every Samsung JPEG carries one, stills included).
  The format spike measured it before the design: every motion photo from both vendors carries the XMP, a HEIC's sits 1.58 MB into the file after the primary image, and the read costs ~10 ms a file on either phone (the S23's 28k backfill rode one pass).
  The same read is M17's measurement rescue — orientation-corrected bounds for a missing width or height, `MediaMetadataRetriever` for a missing duration — so a photo always has a resolution.
  **Playback** runs on expo-video: the player IS the page for a video with the OS frame as its first paint, a pager window of one page each side so at most three players exist, and `TextureView` chosen on the S10e's numbers (SurfaceView cost the floor phone 59 CPU points and 24 MB more for a mild S23 win); looped playback drains either phone about 12–13 % an hour.
  Settings gains a Playback card with per-kind rows — Videos and Motion photos, each Once · Loop · Off, default Once — where Once rests a video on its last frame and a motion photo on its chosen-frame still, and Off shows the frame with a Play control.
  One `Playback` component owns lifecycle, view and chrome for both kinds and both stages: hidden until a stage tap, auto-hidden 2 s into play, kept while paused or ended — play / pause / replay, Stop (rewind to the still; F39), a speaker that unmutes the current view only, expand / collapse, and a seek track that is a hairline when the chrome is hidden and a half-disc thumb when shown (F38); a touch that starts on the band is always and only a seek, and a drag scrubs in Media3's scrubbing mode with the picture following the finger.
  Hold-to-peek (350 ms) shows a looping motion photo's still over its clip; a motion clip plays through the same player over its byte range, and the still ↔ clip handoff keeps the stage's stable view tree; a 4 s / 16 MiB buffer bound ends the Java-heap crash on 4K sources.
  The pager's one width change is gone: a page is the window's width in both stages (the gutter drawn inside the page), so the immersive flip re-lays nothing and the frame-paced assert loop is deleted.
  Rapid culls (F40): the verdict controls are inert for 600 ms after a unit goes live, and only the jump in flight moves the cursor, so a superseded jump's momentum end can no longer land the next tap on the photo just culled.
  **Kind chips** GIF · Motion · Video join the badge vocabulary as quiet near-white annotations (plain photos stay unchipped), and every clip thumbnail wears its kind mark top-left on every surface, playing or not, outside the eye.
  **Animated thumbnails** (M16): every thumbnail surface plays its clips — a video its first seconds, a motion photo its clip, a GIF itself — through real pooled players over the OS thumbnail, revealed on their first frame, bounded by the viewport alone (any part visible); an entering cell waits 0.5 s, a leaving cell stops at once, playback runs on through a scroll (Tristan's choice on both phones over pausing), one row Off · One at a time · All visible (default All, GIFs follow), no player ceiling (hardware decoders past sixteen fall back to software and keep playing), and the deck's strip animates beside the stage at some 300 MB of graphics memory and half a core — a figure the tester judged worth it.
  The spike killed the alternatives by measurement: a frame strip at the clip's real speed needed 2–7 s of extraction an item on the S10e, players at a screenful cost the S10e three cores and 13 % janky frames before pooling, 24 players took the S23 to 2 GB and a kill, and native GIF playback costs ~9 CPU points a cell; the S10e's scroll stall was a viewability feedback loop (`extraData` following the playing set), fixed at source.
  **The media stage** (TODO 11): the three zoom surfaces run on one `MediaStage` with the deck's drivers moved verbatim and Compare's drift fixed (`pairPanBounds`), net-negative code, before any playback code existed.
  The pixel-honesty spike concluded to m0.9.1: a byte-budgeted nearest pre-scale is structurally dead (deep-zoom patches are 42–91 MB on the S23, so every sane budget computes factor 1 and renders pixel-identically to bilinear), and an unfiltered-paint native view over the SharedRef bitmaps is the mechanism.
  **The deck is the one review-and-browse surface** (M24): `PhotoViewer`, `StateEditorSheet` and `QueueViewer` deleted (net −826 lines); list mode over host-supplied items (`lib/deckList.ts`: serializable descriptors whose resolver delegates to the hosts' own queries, so order and filter parity hold by construction), entered by a plain push, order frozen at entry while membership and state stay live, the current photo never leaving the stage under its own action, decisions never advancing the pager, an emptied list going back.
  A stage tap toggles immersive in place — edge-to-edge black, the status bar hidden, the navigation bar kept, a dip-to-black masking the native reflows, zoom re-clamped — and back exits immersive first; the expanded stage hosts the full video transport.
  Tapping the metadata corner opens the details overlay: every item regardless of the rows, the migrated verbose sentences, and the file facts with their unknowns named ("not read yet" apart from unknown), outside the eye and the rows by design; un-mark not-related wakes the dead slot inverted ("Not related · n"), and an untracked photo disables every control ("Not analyzed yet").
  **The URI/cache pass** (TODO 14 + 12): measurement killed the `content://` switch as written (Glide decodes the full file either way), while `ContentResolver.loadThumbnail` at 256 px answers in 14–23 ms cold against 1.4–1.8 s for a 200 MP file — so every thumbnail-scale surface and the pager's at-rest first paint take the OS thumbnail as a `SharedRef<Bitmap>` (`OsThumbnail`, request buckets 128/256/512/1024, a pinned retention, a loud-once URI fallback; History's share-event thumbs are the one URI exception).
  Cache keys carry the version: `image_version = COALESCE(file_generation, file_mtime)` from MediaStore's GENERATION_MODIFIED, carried in the URI itself (`?v=`, because expo-image keys a local file by its URI text alone) and in every `recyclingKey`, and in the review provider's row equality — so a Gallery crop reaches the open deck, its strip and the Timeline on the delta's own completion.
  The gigabyte did not reproduce: Glide is a bounded 250 MB LRU at ~1.4 MB a photo viewed, the WAL is healthy under every scan but the re-embed-plus-facts pass (161 MB, now bounded by `PRAGMA journal_size_limit` 32 MB plus a TRUNCATE checkpoint on open: 160.7 → 0.0 MB), a real S23 session totals 387 MB, and the `[perf] footprint` line ships in every build to catch a recurrence with its composition attached.
  **The stage's metadata and the Overlay section** (F31 F33 F34): the corner draws lines by kind of fact — WHEN (day · time), WHERE (folder exceptions-only, never DCIM/Camera on the primary volume · SD), WHAT (extension · pixels · megapixels, or a video's resolution class from its shorter side · duration) — an empty line disappearing, residual unknowns omitted on the stage and named in the overlay.
  Settings gains one Overlay card of ten switch rows with subtext (Date & time · Source folder · Position · Parts · Resolution · Megapixels · Extension · Duration · Kind chips · Status badges), defaults all on except Megapixels and Parts; the eye is a master mute over the whole set (rows curate, the eye mutes), shared by the deck stage, immersive and Compare, and the zoom fail-soft notice, the playback chrome, the kind marks and the details overlay stay outside it (a fidelity claim is never hidden).
  Riders from the passes: the four queues wear a grid cell's inspection dots (F35), edit's idle glyph is `pencil-outline` (F36), a video's "View only" launches Samsung Gallery's external viewer by name since no chooser lists it (F37), the edit chip un-flags whatever the verdict (F41), the stage pill is two rows growing upward (F42), and the dots wrap inside their thumbnail (F43).
  **Everything usable at scale** (TODO 13): `photo_groups.anchor` is MAX(taken_at) over present members, written inside `repairGroupMembership` — the one call every membership writer ends in, `auditGroupAnchors` the tripwire after each — and the browse walks `idx_groups_anchor` when the reach filter collapses; the bench found the cost in the members join, and a `CROSS JOIN` hint plus a presence-prefixed capture-time index take a group page from 150 to 0.6 ms and a singles page from 7 to 0.3 ms on the 27k seed, the plans pinned.
  `db/membershipSignal` publishes after commit only when a transaction changed browse structure, verdicts patch the rendered rows in place, the Timeline runs one browse flight at a time (a refresh re-walks to the depth on screen with the old stream rendered meanwhile, focus-gated at one per 2 s), and `lib/jsLag` measures the JS thread in every build.
  Measured on the S23: a fresh pass of 32 746 items in 41 min with Everything painted within 1.5 s at 9 % of it and holding eight flings deep, pages median 17–20 ms under the pass and 11 ms cold over 6 325 groups; F45's self-advance loop is closed (an advance to the current unit is no advance).
  **The scan explains itself** (F27 F32): a silent checking phase, a full pass naming its reason (Initial scan · Weekly full scan · Rescanning · settings changed / manually triggered / model changed / grouping changed / dates changed / many changes / counts disagreed / delta check failed · Scanning new storage · Reconciling deletions), a delta its size in items, a resumed pass its interrupted reason with "resumed" and the work actually left, publishing throttled in the runner to one a second — one line on Home and Settings (`lib/scanProgress`).
  The scan notices: a MediaStore `ContentObserver` on the provider root (one check per 2 s burst, foreground only, images and video URIs only), every foreground return and mount change queued behind a running flight, pull-to-refresh on Home, Everything and Progress, no timer polling, and the pending-row race self-healing from Progress.
  Resumable passes (`lib/scanCheckpoint`): each closed dated window's boundary persists under the pass's scope (sources, strictness, model and grouping rules — never generations); a later full pass walks below it, re-pages the rows changed or departed above it, lands the undated tail by ids and counts as the full pass; the checkpoint freezes on any skip or failed read, a forced pass, model swap, scope change or ejected card discards it, and `expo-keep-awake` holds the screen through a foreground check or pass.
  Loss reconciliation (F44): Samsung Gallery's Recycle bin deletes the MediaStore row outright, so a volume short of its tracked count routes to an ids-only `listMediaIds` walk (190–300 ms over 6k rows) diffed against the tracked set, every candidate probed first (PENDING deferred, absent-with-bytes-on-disk a return, undecidable failing closed into the full pass); a 5 955-row mass delete reconciled in 90 s with no full pass.
  A returning file adopts its tombstone: a new row matching an absent one on volume + path + size + capture time is re-keyed (`adoptReturningFiles`, parent then satellites under `PRAGMA defer_foreign_keys`, the old id's cache rows dropped, an ambiguous tuple declined) before the window's constraint read, so its not-related judgments constrain the pass that restores it.
  `photos.state_before_removal` (v26): an external removal records the verdict it found and keeps the never-resolved queued work asleep (the queues, their counts and History's queued badges read live photos only), and the restore — the same id back from the system trash, or a new id adopting the tombstone — brings verdict and work back exactly as they left; Afterglow's own cull remembers nothing, so restoring that re-enters review (confirmed by Tristan on the S23 from Gallery's Recycle bin).
  **The visual group vet**: four judged rounds over the S10e's own groups (the S23's 2019–2022 camera photos), every one frozen in `docs/grouping-study/device-rounds-v1.json` (2 297 photos with the device's vectors, 233 cards) and pinned by core's device-rounds suite at the group and the part level.
  Round 1 (78 cards: 44 groups correct, 17 split, 8 near-group singles should join) found the time bonus is not the lever, re-pinned a single's own adjacent-merge bar (`ADJACENT_MERGE_SINGLE_MIN_CENTROID` 0.73: five more joins, nothing broken) and fixed the scan's rescue windowing — an EXIF-rescued photo had been windowed only among undated ones, so undated ids are now enumerated and rescued before the walk and ride the pager at their real time (rescued singles 58 % → 40 %, all eight joins grouped).
  Rounds 2 and 3b settled PARTS: Tristan splits a tight group near 0.9 and a loose one near 0.6, so core step 5 cuts every group of 3–200 members by average linkage at max(0.60, its mean pairwise cosine) — presentation only, membership untouched: v27 stores the part per member, `lib/groupParts` ranks parts by their newest present member at read time, the deck orders a group part by part with a strip divider and an opt-in "Part k of n · m photos" line in the position box (the Parts Overlay row), and the Everything and day-page cards carry the same divider (3b: 34 of 57 cards accepted as proposed, 90 % pair agreement, the large group the known weak spot).
  Round 3a (67 far pairs beyond 15 min: 10 join, 57 apart) showed no similarity the embedding yields predicts the joins past the hour; at Tristan's choice the merge window widens to 60 min with a FAR BAR beyond 15 min — one member pair across the units at cosine ≥ 0.85, the same shot again and not the same place — joining 2 of the 10 and 1 of the 57, the 44 groups, the 8 joins and the labels-v1 pins untouched; the band beyond the hour stays in the trigger backlog with its link-relation design.
  A rules change regroups the library: core exports `GROUPING_RULES_VERSION`, a completed full pass records it, a differing version plans "Rescanning · grouping changed" that resumes from its own checkpoint, and the merge loop carries its evidence through merges (358 look-alike bursts: 15.8 s → 0.65 s).
  **Schema v22 → v27, one destructive reset** for testers: v23 the file version, v24 the media kinds and facts, v25 the group anchor and its indexes, v26 the pre-removal verdict, v27 the part per member; the animated thumbnails add no table and no column.
  **"Items", not "photos"**, wherever a count can include videos (the source heading "Photos & videos", the goal dialog "Items per day"); "photos" survives where the referent is photos-only, with the gate's selectors and the pinned tests updated in the same sweep.
  Parked with their hedges: video pinch-zoom and videos in Compare (the trigger backlog), per-ABI splits and the all-time goal-days stat (the event-log round), the pixel-honest build (m0.9.1).
  Built through the 23-question pre-build grilling, a six-question deck-design grilling, and the one-by-one vetting of 57 autonomous decisions at eight phase closes; tester passes on the S23 at every phase with the S10e as the floor-experience gate, the UI gate (docs/MOBILE_UI_GATE.md, which now parks the Playback rows Off in a preflight and reads "items") green on every closing build through r27, and the measurement recipes in docs/ANDROID_DEVICE_TESTING.md §6; 52 codex rounds over the ten phases plus nine close-out rounds over the whole release on gpt-6.1-sol (29 cross-phase findings fixed, the last rounds each in the previous round's own fix: a mis-addressed collection uri read as deletion by the presence probe, the details read and the share and viewer dispatch; the zoom ceiling across the immersive flip; the region pipeline's base and patch decodes fenced on a lifecycle generation and ordered by flight; the share, History, queue and untracked-grid thumbnails' edit staleness; every browse loader following the membership signal, History to its loaded depth with its pagination and refreshes serialised; the adoption repair's mounted-volume guard; the playback rows' ordered writes and committed-or-in-flight anchors; the thumbnail gate asking for a rendered frame; stopped at nine by Tristan on the review skill's budget), self-reviewed against docs/REVIEW_CLASSES.md; 119 core, 1 034 mobile and 144 desktop tests; the UI gate green on the release artifact.

**m0.9.1 — the accessibility pass** (moved from m0.8.8, deliberately after the UI stops moving; Tristan, m0.8.6 closing grilling; plan: [docs/Plan_m0.9.1.md](docs/Plan_m0.9.1.md), settled in the 2026-10-08 grilling).
A dedicated release that measures first: an accessibility spike walks every screen at each OS font-scale step and three display sizes on both test phones and the Android 16 emulator, audits every text site (its container, the scale at which it breaks, the lever that fixes it — a container that grows before a cap), and the measured findings set the policy for every pinned-height surface.
Until then the pinned surfaces deliberately ellipsize at extreme scales rather than break the exact-geometry landings.
The spike also opens [docs/IOS.md](docs/IOS.md), the ledger of what iOS support must handle, Dynamic Type first.
Three UI-polish items ride it, briefed by the spike:
the **type-scale and token pass** (the measured drift: 16 distinct font sizes, 18 radii, scrims 0.35–0.72; named text styles with size, weight and line height, a 4-dp spacing grid and three radii in `theme.tsx`, every site mapped; before/after screenshots judged at the close-out; Summary's blank loading view and the UnitCard thumbnail-size question ride it);
the **segmented control on every single-choice Settings row** (the daily goal, keeping-up and grouping rows join the Playback rows on `components/SegmentedControl`, the five-option rows relabelled to fit, the goal rows' write fences kept);
and the **immersive flip as a continuous animation** (the stage frame scales between the framed stage and the edge-to-edge one on shared values while the chrome fades, the real layout committing under the transformed stage, a playing clip playing through; Remove animations keeps the dip-to-black cut).
The release also runs the UI gate on the emulator's Android 16 Google image as a blocking gate at the close, the cheap half of the cross-OS audit the TODO list names, which m0.9 did not run.

**m0.9.2 — the pixel-honest deep zoom** (split from m0.9.1 in its grilling, 2026-10-08; the m0.9 spike's memo, 2026-08-27): a byte-budgeted nearest pre-scale is structurally dead — deep-zoom patches measure 42–91 MB on the S23, so every sane budget computes factor 1 and renders pixel-identically to bilinear — and an unfiltered-paint native view over the SharedRef bitmaps is the mechanism, with two caveats the build must honour: an offscreen layer between the transform and the draw (an opacity or render-to-texture layer) re-bilinears the paint, and the ≤12 MP base-served tier needs the same treatment as the patches; threshold, automatic vs toggle and Compare-only are decided at its device pass on real pixels.
A native release, so the API 30 floor emulator runs with it (docs/DEVELOPMENT.md).

**After m0.9.1**: hardening and tester-driven fixes to 1.0.
One named design round in this stretch: the **generic event log** (assessed 2026-08-21, deliberately not built piecemeal) — one append-only event stream designed once for all its members: group completions (revives the "you keep 1 of X" stat), favourite events (revives the favourites-applied figure), **goal-crossing events** (day, goal value, count — frozen at the celebration moment; backs the all-time "days the goal was reached" stat honestly, where today's goal-relative re-scoring cannot; the pre-log era's rendering is that round's open question), the parked History action streams, the lifetime-counter pattern, and whether duels stay standalone. The same round owns the actions-vs-library stats audit and its copy pass (stats track actions performed in Afterglow; library facts are labeled as such). See [docs/STATS_ACCURACY.md](docs/STATS_ACCURACY.md).
**Per-ABI APK splits** land in this stretch too (moved out of m0.9, 2026-08-26): the universal APK is ~163 MB with MediaPipe; splits reclaim most of it once the release workflow handles multiple artifacts (the aapt-assertion path, the copy step, and `release-artifacts.mjs`'s exactly-one gate).
This includes the planned **one-time identity break**, which bundles everything that forces a reinstall into a single tester disruption: the real release keystore, the **application id aligned to the "Afterglow" name** (drops `com.afterglow.companion`), and a **versionCode reset to 1** (fresh installs have no downgrade check).
Note: if Play Store distribution ever happens, Play tracks the highest versionCode per id.
That is moot since the id is new.
A data export/import path is considered first, so review history survives.
Then `initial` merges into `main` as the pre-1.0 era closes.
**iOS ships post-1.0** (no iOS users or testers today), but building toward it started with m0.9.1: [docs/IOS.md](docs/IOS.md) is the ledger of what iOS support must handle, kept current by every Android decision that rests on something iOS does differently.

---

## Trigger-based backlog

Build these only when their trigger fires.
No release target until then.

- **Desktop `indexReady` IPC push** — pushes the whole library over IPC.
  Chunk or incrementalize when a library passes ~100k photos.
- **Desktop startup speed** — v0.5's warm-start-from-index was the first pass.
  If startup is still slow, a profiling pass rides with v0.6 (the RAW pre-render queue touches the same path).
- **`.scr` thin stub** — the screensaver is currently a full copy of the installed exe.
  A thin stub can replace the copy in a later release without touching the registration logic.
  Cost today: one duplicated exe on disk.
- **Desktop video capture dates** — videos index by file mtime only.
  Container-metadata creation dates are a possible refinement.
  Low priority.
- **`expo-media-library/legacy` migration** — mobile deliberately uses the legacy module for queries (battle-tested cursor paging).
  Migrate to the SDK's class-based Query/Asset API when Expo deprecates the legacy path in earnest (m0.8+).
  All access funnels through `src/lib/media.ts`, so it stays a one-file migration.
- **Video pinch-zoom** — deferred from m0.9 (2026-08-26) with the mechanism corrected for the record: Samsung Gallery's video zoom is a GPU transform of the playing surface, never per-frame decode, so frame rate is irrelevant and the region pipeline is never involved.
  The build needs a transform-respecting player surface plus a new zoomable-surface entry in the gesture arbitration; m0.9 measured and chose `TextureView` (SurfaceView cost the S10e 59 CPU points and 24 MB more over 90 s of looped playback for a mild S23 win), and view transforms apply to it, so the future decision starts warm.
  Videos in Compare ride this trigger too (M7): a video is excluded from Compare until its zoom exists.
  Trigger: a tester asks while reviewing real videos.
- **Loop/boomerang export** — neither motion-photo container stores playback settings, so "make it loop" honestly means exporting a new video file with the effect baked in (Samsung Gallery's own model).
  Trigger: a user asks for it.
- **Opt-in usage analytics** — assessed 2026-08-21 and deliberately not built: at tester scale, feedback rounds are behavioral data with reasons attached, and the generic event log will record Afterglow actions anyway (a stated-purpose substrate most usage questions can query locally). The `diagLog` diagnostics sink deliberately excludes user actions.
  Trigger: a post-v1 user base too large for direct feedback rounds AND a named question the event log cannot answer — both, not either.
- **Background scan execution (idle + charging)** — the initial pass and the weekly reconciliation run only while Afterglow is in the foreground; a phone left on a desk gets the pass throttled or killed with the screen, and a big library's initial embed (the S23's 27 880 photos, ~1 h) then arrives in fragments across days (2026-09-08).
  m0.9 phase 9 ships the in-app half — an enumeration checkpoint, a durable-state progress line, and a foreground keep-awake — which is also this item's prerequisite: a WorkManager slot is ~10 minutes, so a background pass MUST be resumable.
  The remaining blockers are measured in docs/TODO.md ("If it stays, idle + charging"): two new dependencies to reach `requiresCharging`/`requiresDeviceIdle`, a DB-backed cross-process scan lease, and Samsung's background-job culling on both test devices.
  Trigger: the weekly full pass survives its field-time revisit (docs/TODO.md) AND a tester reports an initial pass that phase 9's resume still cannot finish in normal use.
- **Far look-alike links beyond the hour** — photos that would group but sit beyond the 60-minute merge window (the next-day sunset over the same pan).
  Measured on Tristan's judged round (m0.9 phase 10, 2026-10-05, 67 pairs at centroid cosine ≥ 0.80 within 24 h): 10 joins, 57 apart, and no similarity the MobileNetV3 embedding yields separates them past the hour — the safest bar (mean member-pair cosine ≥ 0.885) catches 3 of the 10 with no wrong join; every lower bar joins more wrong pairs than right ones. Within the hour the merge window itself now reaches them under the far bar (one member pair ≥ 0.85: 2 of the 4 judged joins, 1 wrong of 13).
  The mechanism for the rest is settled (m0.9 phase 10): a link relation between stored units computed per window over ±24 h, the deck assembling linked units into one with the gap on the divider, the scan's windows untouched, "not related" undoing a link.
  Trigger: an embedding that separates the round's joins from its aparts (re-run `far_links.mjs` and the round-3a verdicts against the candidate model).
- **GitLab releases** — deferred until further notice.
  GitHub Releases is the sole delivery path.
  Do not add GitLab CI or remotes without a new decision.

## Risks

- **Unsigned builds.**
  Windows builds trip SmartScreen, so testers are told to expect "More info → Run anyway".
  Code signing is a later cost decision.
  Android photo-permission UX varies by OEM and version.
- **Edit detection is heuristic.**
  In-place edits (Samsung) are detectable via MediaStore changes.
  Copy-saving editors need name and timestamp sniffing.
  Both can miss.
  Mitigation: manual mark-done always exists, so detection is a convenience layer, not a correctness dependency.
- **darktable-cli throughput** (seconds per 4K render).
  The mitigation is architectural and non-negotiable: a background queue plus a cache, and never convert on the display path (v0.6).
- **Lightroom fidelity disappointment.**
  Mitigation: the tiered messaging above, in-app labels included.
- **EXIF timestamp quirks** (timezones, missing `DateTimeOriginal`, WhatsApp-stripped files).
  Mitigation: fall back to file mtime, cluster on local naive time, and treat clustering as best-effort.
- **HEIC** (the default on many phones) does not decode in Chromium.
  It is fine on Android.
  Desktop HEIC is a later, deliberate feature.
  Document it as unsupported until then.

## Open questions

- Whether desktop flag-queue items should sync anywhere (a file in the library? an export?).
  Decide when organizer mode matures.
- Code signing (a Windows certificate, macOS notarization): a cost/benefit call before wide distribution.
- Perceptual-hash similarity (blockhash/pHash in TS vs native): shipped on mobile as dHash in m0.4.
  The desktop decision moves to v0.7 (organizer burst-culling).
- What, if anything, should eventually consume the full best→worst ranking (day cover photos? desktop show-best-of-burst?).
  Duel history is stored from m0.1, so the option stays open without extra user effort.
- Samsung Gallery's in-place edits keep a hidden pre-edit backup ("magic" undo).
  It is worth investigating whether its presence is detectable.
  That would make edit detection on Samsung devices near-perfect.
