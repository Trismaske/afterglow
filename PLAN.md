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
  The algorithm (m0.8): on-device image embeddings (MediaPipe MobileNetV3-large) with a 3-min burst gate, centroid linkage, and adjacent-burst merges ≤15 min.
  Validated against a committed suite of human-judged pairs.
  dHash survives only as a time-gated exact/near-duplicate annotation.
  Groups persist, so completed days re-show them.
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
  The **coverage** goal ("leave nothing unreviewed from the last N capture days": Off/Today/2 days/7 days/All time, default 2 days) is scored on CAPTURE days.
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
v0.1–v0.5 and m0.1–m0.8.5 have shipped.
Next up: the desktop RAW pipeline (v0.6) and mobile m0.8.6.

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
  Deletions arrive as trashed rows, since an Android 11+ gallery delete keeps the row with `IS_TRASHED` set.
  Counts are checked before AND after each pass, and every uncertainty falls back to a full pass.
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

**The m0.8.x feedback line (next).**
The remaining tester items from the 2026-07-31 round, organised into subsystem-aligned releases so each gets one device pass and one review cycle.
Items, evidence, and the settled decisions: [docs/Feedback_m0.8.x.md](docs/Feedback_m0.8.x.md).

- **m0.8.6 — the browsing surfaces.**
  The review overview becomes the full **Timeline**: every group and singles run, newest-first and paged, with filters that peel back to today's pending view.
  A photo's whole state becomes editable from Progress and History (one verdict, every action, refusing only what genuinely cannot be undone).
  That reopens the regroup boundary in one narrow direction: the freeze follows a photo's CURRENT state, so un-reviewing returns it to the scan's reach.
  Plus the rescued-date defect (designed and ready), History tombstone rows, the Progress histogram keeping its selected month on screen, and the star/Compare knot: whether "best of group" survives, and how you keep a photo from a triage duel.
- **m0.8.7 — sources, badges, and the queues.**
  Source selection becomes a scope axis exactly like mount state: deselecting a folder writes nothing, and its photos leave every queue, count, and grid until it is re-added.
  Source-folder and SD-card badges join the shared vocabulary, with one control to hide badges.
  The gallery's own favourites are read back at scan time.
  The source picker stops shifting rows on selection.
  A copy audit fixes singular strings in plural situations.
  The four queue screens get one action language, plus full action hydration in the Progress grids.
  Carries two more: the **error-surfacing contract** ([docs/Errors_design.md](docs/Errors_design.md) — one three-tier answer at every boundary where Android can refuse systematically, with its §6 to be settled before implementation) and the type-scale and token pass, whose evidence sits on this release's own screens.

**m0.9 — Videos (moved from m0.8)**
- **Videos enter review** (singles-first: playback, keep/cull/queues, with grouping later if warranted).
- **Per-ABI APK splits** (deferred from m0.8's Gate 6): the universal APK is ~163 MB with MediaPipe.
  Splits reclaim most of it once the release workflow handles multiple artifacts.
- **Visual vet of live groups** (deferred from m0.8): a contact sheet from a device DB's actual continuous groups, to eyeball the fitted curve's real-world behavior.
- **All-time "days the goal was reached"** on a Stats tab (Tristan, 2026-08-07).
  The 30-day version already exists (`activityWindow`'s `goalDays`, printed beside the goal line), so this is the same figure over the whole history.
  One decision it carries: like every goal figure, it re-scores against the CURRENT goal, so the number moves when the goal changes — defensible on a 30-day chart, stranger on an all-time total.

**After m0.9**: hardening and tester-driven fixes to 1.0.
This includes the planned **one-time identity break**, which bundles everything that forces a reinstall into a single tester disruption: the real release keystore, the **application id aligned to the "Afterglow" name** (drops `com.afterglow.companion`), and a **versionCode reset to 1** (fresh installs have no downgrade check).
Note: if Play Store distribution ever happens, Play tracks the highest versionCode per id.
That is moot since the id is new.
A data export/import path is considered first, so review history survives.
Then `initial` merges into `main` as the pre-1.0 era closes.
**iOS evaluation is deferred post-1.0 until further notice** (no iOS users or testers today).

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
