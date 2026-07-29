# Afterglow — Product Plan & Roadmap

*The living product plan: vision, locked decisions, the full 1.0 feature picture, and the release roadmap. Tester feedback is folded directly into the roadmap each round.*

## Vision

Two apps, one shared brain:

1. **Afterglow Desktop** — a fullscreen ambient photo display ("screensaver") for a media PC or desktop, that shows your *edited* photos and videos with intelligent ordering, and quietly doubles as a photo-organization capture tool: see a photo that needs attention, flag it with one keypress, deal with it later.
2. **Afterglow on Android** ("Afterglow Companion" until the m0.8 rename) — an app that drives every phone photo to a reviewed end-state: it groups shots taken in quick succession, walks you through each group two photos at a time (cull one, or keep both and pick the better), stages deletions for one confirmed batch, and tracks which photos still need editing.

They are separate apps with separate release trains, but the intelligence — time-based clustering, ordering strategies, the flag/culling session model — lives in one shared TypeScript package both consume.

## Decisions locked in

| Question | Decision |
|---|---|
| Platforms | Windows, Linux, macOS — **Windows first priority** (the media PC). Dev machines run Ubuntu/Mint. |
| Desktop stack | **Electron + TypeScript**, proper security model (preload + `contextBridge`) from day one. Chosen over Tauri for reliable bundled video codecs and over Flutter for web-tech slideshow strengths + TS code sharing with React Native. |
| Mobile stack | **React Native (Expo), Android first.** iOS later. |
| App split | Two apps sharing a core package. Desktop = screensaver + organizer modes in one app. |
| RAW strategy | Keep it — it's the differentiator. **darktable XMPs rendered faithfully** via `darktable-cli`; **Lightroom via tiered fallbacks** — preview-cache extraction, DNG/embedded previews (see below). Per-image routing by sniffing XMP namespaces (`darktable:` vs `crs:`). JPEG-only libraries work fine regardless. |
| App naming & convergence | **Both apps are "Afterglow"** (mobile renames from "Afterglow Companion" in m0.8 — display name only; the Android application id stays `com.afterglow.companion` so testers don't end up with two installs). One product, two surfaces: organize/queue UI-UX patterns converge as desktop organizer (v0.7+) and mobile mature, with shared vocabulary throughout. |
| Mobile workflow | Three-layer photo state model — verdict · actions · annotations (see below); swipe-deck group review (replaced the m0.1–m0.3 duel bracket in m0.4; the bracket stays in core for desktop reuse); stored compare/duel history instead of full ranking; completed groups advance directly to the next unfinished group; to-edit queue lives in-app with `ACTION_EDIT` launch. |
| Distribution | GitHub Releases, CI-built installers per tag. Auto-update later. |

## The Lightroom reality (verified 2026-07-17)

**There is no local/headless Lightroom API.** Lightroom Classic's only extensibility is the Lua plugin SDK, which runs *inside* a running Lightroom instance — nothing external can ask it to render a photo. Adobe's cloud REST API exists but only covers cloud-synced Lightroom CC libraries and is gated to approved partner integrations. So "use Lightroom if installed" works only indirectly, and RAW support has honest tiers:

1. **darktable users:** pixel-faithful rendering via `darktable-cli` with the sidecar XMP. Flagship feature.
2. **Lightroom Classic users — preview-cache extraction:** `Previews.lrdata` beside the catalog holds JPEG previews *with edits applied* (SQLite index + `.lrprev` files). Unofficial format that could break with an LR update, but works offline and shows the real edit; quality depends on the user's preview-size setting. User points Afterglow at their catalog once.
3. **Lightroom + DNG users** who enable "Update DNG Preview & Metadata": the DNG's embedded preview *includes their edits* — extract and show it.
4. **Lightroom + proprietary RAW (CR2/NEF/ARW…), no catalog access:** the embedded preview is the *camera's* rendition, not the edit. Show it, but label it honestly ("camera preview").
5. **Anyone:** exported JPEGs always work; when a JPEG sits next to its RAW, prefer it and don't show the photo twice.
6. **Later (1.0+):** an optional companion Lightroom plugin (official Lua SDK) that auto-exports edited photos to an Afterglow cache folder — faithful and supported, but requires LR running and a plugin install.

**Per-image renderer routing:** sidecar XMPs self-identify — darktable writes `darktable:` namespaces (its history stack), Lightroom writes `crs:` (Camera Raw Settings). Sniff the XMP → route to `darktable-cli` or the Lightroom tiers. If only one path is available, use it (darktable can best-effort import basic `crs:` settings as a last resort). The UI and README must state these tiers plainly so Lightroom users aren't promised fidelity we can't deliver.

---

## Full feature picture at 1.0

### Afterglow Desktop

**Display**
- Fullscreen slideshow: JPEG/PNG/WebP (later GIF, HEIC via optional codec work), crossfade transitions, optional Ken Burns pan/zoom.
- Muted video playback (MP4/WebM/MOV — honest list only; no AVI/MKV claims), per-video duration cap.
- RAW via the tiers above, with a background pre-render queue and a bounded, hash-keyed cache.
- Multi-monitor: all displays covered (mirrored or independent streams).
- De-duplication: RAW+JPEG pairs shown once.

**Story engine (smart ordering)** — the big differentiator over "shuffle":
- *Moments:* photos taken within a configurable gap (e.g. ≤3 min apart) form a cluster shown consecutively, capped at N photos (evenly sampled if over the cap).
- *Sessions:* looser clusters (e.g. 10 photos across half an hour, or a day's shoot) played as a sequence to "take you back to that day."
- *Retrospectives:* this-day-in-history, one-photo-per-day-of-a-month, one-per-month-of-a-year.
- A mix engine interleaves cluster playback with random singles, avoids near-term repeats, and exposes mode weights in settings.
- All of this needs a **library index** (EXIF `DateTimeOriginal`, path, dimensions) built in a background scan and persisted.

**Overlay & capture**
- Path/metadata overlay: file location, date, optionally camera/GPS — subtle, toggleable, positioned for TV viewing.
- Flag-to-queue: single keypress while watching — **D**elete, **E**dit, **M**ove/misfiled, **R**eview — with an unobtrusive confirmation toast; slideshow never stops. Queue persists across sessions.

**Organizer mode** (windowed, not fullscreen)
- Work through the flag queue: preview, then act — send to OS trash, reveal in file manager, open in editor, move to another folder. Each action clears the item.
- Culling assistant: surface bursts/near-duplicates from the index (time proximity first; perceptual-hash similarity later), side-by-side compare, pick the keeper.

**Platform & ops**
- Settings UI: media folders (multiple), durations, transition, story-mode weights, cache size cap + clear button. Persisted (`electron-store`).
- Exit on mouse-move/key/click through one code path (flag keys excepted).
- Idle/screensaver integration, per platform, in priority order: Windows `.scr` wrapper or Task Scheduler idle trigger → Linux (systemd/X11 idle hooks) → macOS (no `.saver` possible from Electron; use hot-corner + launcher guidance).
- CI: lint, tests, tagged releases building Windows NSIS/portable, Linux AppImage/deb, macOS dmg.

### Afterglow (Android)

**The state model (m0.8.2).** Three layers, spelled out in full in
[docs/STATE_MODEL.md](docs/STATE_MODEL.md) — read that before touching any surface that shows what has happened to a photo.
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

Reviewed = has a verdict, and that one definition drives every "X of Y reviewed" number in the app.
Flagging a photo for editing is a pending action on a KEPT photo, not a fourth verdict — before m0.8.2 it was one, which is why "keep vs done vs to-edit" was three words for one confusion.
Every verdict stays revisable until the final cull confirmation.

- **Cull groups — purpose (Tristan, 2026-07-24):** a group is a **de-duplication aid** — visually similar photos that could substitute for each other, from which a human keeps the best. Visual similarity decides membership; time proximity may narrow candidates but never adds members (temporally close, dissimilar photos must NOT group). UNKNOWN similarity is different from known-dissimilar (Tristan, 2026-07-26): a photo whose embedding is unavailable attaches by time to its nearest embedded neighbour in the burst until its embedding lands — the inclusive policy applied to missing signal (internal scan bookkeeping since m0.8.2: the user cannot act on it, so no surface draws it). Byte-identical duplicates are the floor. Boundary calls err **inclusive** — ejecting a wrongly-grouped photo is one tap, while singles can never be promoted into a group (by design), so a false inclusion costs a swipe but a false exclusion costs a navigation loop. This is a different concept from desktop *moments*, even where machinery is shared — and the same grouping engine is intended for desktop organizer culling (v0.7+), so investment here pays twice. The algorithm (m0.8, `docs/Plan_m0.8.md`): on-device image embeddings (MediaPipe MobileNetV3-large) with a 3-min burst gate, centroid linkage, and adjacent-burst merges ≤15 min — validated against a committed suite of human-judged pairs; dHash survives only as a time-gated exact/near-duplicate annotation. Groups persist, so completed days re-show them. 1-photo groups are singles.
- **Review order — one timeline (m0.8.2):** the review queue is a single newest-first timeline of units — groups (anchored at their newest member) interleaved with runs of ungrouped singles, split at day boundaries — so recent singles come up where they were taken instead of behind every group. The overview renders exactly the order the flow walks; completing any unit advances to the next one in time; "Continue reviewing" on Home jumps straight into the next unit (the overview is one tap away on the queue-breakdown numbers). Crossing the daily goal celebrates in the deck, at the crossing decision, once per day.
- **Group review — swipe deck:** each unit is a swipeable deck — keep or cull any photo, keep the rest, flag to-edit, star a best (groups), or eject an unrelated photo ("Not related", groups). Every deck pages newest-photo-first and opens on its first pending photo. A decided photo stays in place wearing its badges (verdict plus any of edit/favourite/organize/share, none hiding another); re-tapping the active verdict clears it — in groups AND singles runs alike (m0.8.2 unification: one deck, one behavior). Units can be entered in any order and every decision is reversible until the final cull confirmation; deliberately reopening a completed unit remains in browse/re-decide mode.
- **Compare:** any two undecided-or-KEPT deck photos go full-screen A/B — tap to flip (better than side-by-side on a phone), synchronized pinch-zoom for sharpness/eyes checks, labels keep the photos' deck numbers, and all four action chips ride along. A duel writes verdicts only when it IS the whole table (m0.8.2): any singles duel, or a group whose undecided remainder it settles (≤ 2 alive) — there "X is better" raises the keep-both/cull dialog ("Keep both" marks BOTH kept; "Cull" stages the loser and leaves the winner untouched; a persisted don't-ask preference auto-culls). A duel with 3+ alive is triage: star + history, no verdict. Comparing against an already-kept photo is a legitimate re-decide. Every duel is stored cheaply as compare history — no extra comparisons — so later features can mine it.
- **Cull list:** a durable global queue — staged culls persist, badged with their verdict wherever they resurface, until the final confirmation. Reviewable, then one final confirmation → batch move into the **system trash** (recovery duration is gallery-managed; one system dialog per bounded batch) on Android 11+; below API 30, permanent delete behind unmissable warnings (m0.8 — no system trash exists there).
- **Single review:** photos outside any group review through the SAME deck as groups (m0.8.2) — as day-split runs on the timeline, or a whole day's singles from its day page — with identical controls and decided-stays-badged behavior.
- **The queue family** — every queue is a durable, reviewable in-app list: **to-edit** (per-photo — Edit button fires `ACTION_EDIT` into the user's editor; manual "mark done" always available), **favourite** (applied in one batch via `MediaStore.createFavoriteRequest`, surfaces as the gallery's heart), **organize** (two-step since m0.8.2: the deck button just queues the photo — a toggle, like share — and the queue screen assigns albums in batches over a selectable grid, then applies verified `createWriteRequest` + `RELATIVE_PATH` moves per target; duplicate album names show their folder paths), **share** (a persistent working set shared in multiple sharesheet passes over chosen subsets).
- **History:** a re-decidable, filterable current-state feed of photos still present, plus share-sheet events.
- **Edit detection on app open:** two heuristics, because Android editors differ. Samsung Gallery (and similar) edit **in place** — same file, changed content — detected via MediaStore generation/`date_modified`/hash change → the edit action resolves itself. Other editors (Google Photos, Snapseed) save a **copy** — detected via sibling-name/timestamp sniffing → the copy is recorded as kept, and the app asks whether to keep or cull the original.
- **Continuous scan & progress (m0.8, replaces sessions):** on app open a chunked scan pages the configured folder newest→oldest, hashing and grouping incrementally — the deck fills as results land and is enterable within seconds. Two independent, presentational goals drive Home and Stats, each with its own indicator and chart: a **count** goal (photos reviewed per day — chips 25/50/100 plus any custom whole number, default 50) scored on DECISION days, and a **coverage** goal ("leave nothing unreviewed from the last N capture days" — Off/Today/2 days/7 days/All time, default 2 days) scored on CAPTURE days, where All time is the 100%-of-library goal and the only mode counting undated photos. Streaks: a count-goal streak day is a day the goal was reached; a coverage streak day is a shooting day that ended fully reviewed (days with no photos neither break nor extend it). Home shows live corpus stats (total, groups found, % reviewed, reclaimable estimate) plus per-day and global progress browsing.
- Later: iOS (deferred post-1.0 until there are iOS users/testers).

### Shared core — `@afterglow/core`

Pure TypeScript, no filesystem or platform APIs — both apps feed it `MediaItem[]` (id, timestamp, path/uri, kind) through their own adapters:
- Gap-based time clustering (moments/sessions) with configurable gap, cap, sampling.
- Playlist/mix engine and retrospective selectors.
- Flag-queue state model (flag types, staged actions, undo, serialization). The culling/deck session models retire in m0.8 — mobile review state becomes DB-backed; desktop organizer (v0.7) brings its own compare model.

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

Two trains. v0.1–v0.5 and m0.1–m0.8.2 have shipped; next up: the desktop RAW pipeline (v0.6) and mobile m0.9.

### Desktop train

**Shipped**
- **v0.1** — fullscreen crossfade slideshow (JPEG/PNG/WebP) from user-picked folders, persisted settings, exit on input, preload+contextBridge security, CI-built Windows/Linux releases.
- **v0.2** — path/date overlay; D/E/M/R flag capture with persisted queue + queue window.
- **v0.3** — story engine v1: background EXIF indexing, moments clustering + mix engine from `@afterglow/core`.
- **v0.4** — muted video (MP4/WebM/MOV) in the rotation, per-video duration cap.
- **v0.5** — feedback release: settings-first launch (show exits back to settings; `--show` for straight-in), arrow-key navigation with history, shortcut legend, N/T flags (rename / date fix), video cap 0 = full length, display-sleep suppression, warm start from the persisted index, Windows "Set as default screensaver" button (`.scr` via the NSIS installer, same settings store).

**v0.6 — The RAW pipeline (next)**
`execFile`-based `darktable-cli` wrapper (never shell strings); cache keyed on hash(path + XMP mtime + output size); background pre-render queue with concurrency limit that stays ahead of playback; cache size cap + LRU eviction + settings UI. Per-image renderer routing by XMP namespace (`darktable:` vs `crs:`); embedded-preview extraction for the Lightroom tiers, with `Previews.lrdata` catalog extraction as the stretch goal (or v0.6.x follow-up). RAW+JPEG pair de-dup.
*This is the release where it becomes Afterglow. Budget a real week; it's the hardest engineering in the app.*

**v0.7 — Organizer mode**
Queue actions (OS trash, move, open in editor — including rename and date-fix flag actions). Burst-culling compare UI over the index.

**v0.8 — Retrospectives + multi-monitor + polish**
This-day-in-history and month/year modes; all-displays support; overlay/settings polish.

**v0.9 — Screensaver: Linux + macOS, auto-update** (Windows shipped in v0.5)
Linux idle hooks (systemd/X11); macOS hot-corner + launcher guidance (no `.saver` from Electron). Auto-update (electron-updater) lands here too.

**v1.0** — hardening, docs, code signing (Windows certificate / macOS notarization — until then SmartScreen "More info → Run anyway" stays the documented tester path), whatever the testers demanded loudest.

### Mobile train

**Shipped**
- **m0.1** — trip-ready duel culler: time-clustered cull groups, pairwise duels, staged cull → one confirmation → system trash, SQLite state.
- **m0.2** — the full state machine: `to-edit` in duel and single review, in-app to-edit queue with `ACTION_EDIT`, day-scoped inbox-zero progress.
- **m0.3 / m0.3.1** — edit detection on app open, auto-cull hints, A/B flip compare + synchronized zoom; source folders.
- **m0.4** — perceptual-similarity grouping (dHash), **swipe-deck group review replacing the duel bracket** (bracket retained in core), progress browsing, Material You theming.
- **m0.5** — feedback release: editor launch fallback (`ACTION_EDIT` → `ACTION_VIEW`), looser similarity scale (12/16/20/26/32) + 0–64 fine-tune slider, decisions reversible until the final confirm, session flow freedom (any order, banked decisions, "End session & apply"), Sessions settings (cap 50 default, group-boundary softness, oldest/newest first), compare fixes (best-of-group semantics, "Compare with…" picker, group-number labels), deck pinch-zoom, gear icon.
- **m0.6** — feedback + feature-completion release: decision indicators everywhere with re-tap-to-clear, group cards reopen the group, singles unified into the deck as a pseudo-group, completed groups advance immediately, favourites queue (♥, batched `createFavoriteRequest` native module), lifetime stats + streaks, progress-bar fix, startup/analysis perf pass, Material icon language, editor-launch diagnostics (fix itself carried to m0.7 — see below).
- **m0.7** — feedback release: editor launch fixed at the root (request MediaStore write access first, then `ACTION_EDIT`; two-button edit queue — ✎ Edit + read-only Gallery); similarity-first grouping v2 (time proximity only ever helps, never excludes; groups always ≥ 2 photos; legacy time-only toggle); durable SQLite group membership; deck relayout (Keep / Compare / Cull + queue row Edit · Favourite · Organize · Share); **share queue** with multi-pass sharing (overlapping subsets across repeated sharesheet passes, pass badges + labels, honest `sheet_opened` state); **organize queue** (verified `RELATIVE_PATH` moves to primary-volume albums); **Favourite queue** rename + atomic batches; silent lossless session replacement with the **durable global cull list** (kept, edit, and staged-cull decisions all survive); crash-safe trash-attempt lifecycle (verified per-photo outcomes, at-most-once reclaimed-bytes credit); **History** feed; canonical volume-qualified photo ids; fresh-baseline schema policy (destructive DB reset between 0.x versions; migrations return at v1).

- **m0.8** — sessions removed: continuous newest→oldest scan feeding the durable tables (nothing to start or apply; decisions save at swipe); embedding groups (MediaPipe MobileNetV3-large local module, burst gate/centroid linkage/adjacent merge, human-judged CI regression suite); bottom tabs **Home · Edit · Favourite · Share · Organize** with the goal-ring Home (presentational daily goal + goal streaks, live corpus stats incl. exact reclaimable bytes, 3-recent + still-to-review day layout with the **Unknown day** pseudo-day for undated photos); culled photos stay badged in the deck (the badge is the undo); one standard full-screen viewer with per-photo decision detail; state-aware re-decisions; "reviewed" = every verdict; write priority (user decisions outrank scan writes); app renamed **"Afterglow"** (id unchanged). Schema v14; v13→v14 is the one additive migration. 42-round adversarial review hardening: every group write validates presence + rendered assignment in-transaction, fail-closed source scoping everywhere, atomic settings flows with honest rollbacks, snapshot-consistent queue reads.
- **m0.8.1** — feedback + performance release: decision writes resolve at commit with parity-tested optimistic queue patches (no more scan-blocked "Saving…"); goal-ring arc geometry fixed and the ring now counts today's review WORK (`decided_at`, re-stamped per verdict); Home copy/layout pass (tab-duplicated queue rows removed, per-line breakdown); bottom bar **Edit · Favourite · Home · Organize · Share** with a raised center Home button and an active-tab indicator; queue-screen headings + shared shell (`useQueueRows`/`QueueViewer`); album-picker search; UI-consistency sweep (one title per screen, insets, bottom sheets); scan status shows a real percentage. **Performance/battery:** unchanged-library scan skip (MediaStore generation fingerprint — an unchanged library costs one native call, not a ~6 min re-walk), the review-queue query de-quadratified (15 s → 0.4 s, plan pinned in CI), the source catalog from one native cursor walk instead of a probe per bucket (35 s → 0.5 s on an 895-bucket device), scoped group repair (was unbounded per scan window), four measured indexes + `ANALYZE`/`PRAGMA optimize` (schema v16), no-change refreshes commit nothing, badge polling removed, and bounded-parallel native round trips. Cold start to usable Home 39.7 s → ~4 s (S10e) and 6.6 s → ~3 s (S23); full 27k scan ~390 s → ~204 s. New: Stats page, queue badges on every photo, `scripts/mobile-ui-gate.mjs` pre-release UI gate, and the second **coverage** goal ("Keeping up") with its own Home card and Stats chart alongside a custom count-goal value.

- **m0.8.2** — forecast, Progress redesign, and the photo STATE MODEL straightened out. **The app learns to look forward:** a finish-line date from your actual trailing pace with the goal pace beside it — refusing to print a date when intake outpaces reviewing, showing the growth rate and break-even pace instead; projected culls/edits/favourites/shares as ranges from your own chunked base rates; "hours of tapping left", gated on a split-half stability check with a sitting rhythm derived from your own pace. Its headline IS the Home Progress row's subtitle. **Progress, redesigned from scratch:** state chips that double as the composition-bar legend (the grid used to start 72% down the screen, now 58%), a horizontally scrolling capture histogram by month that *filters* the grid, backlog frontier, storage by state, burst tax. **Stats becomes Activity · Forecast · Habits**, each tab loading its own query set on first open — intake vs review, reviewing rhythm (weekday × hour), per-queue turnaround ("3 waiting · oldest 9 days · usually done within 2 days" — no completion RATE, because queues built to drain make any such rate read ~100% for everyone), decisiveness trend, milestones — spending `duels`, share batches and the queue timestamp pairs, which no screen read. **The state model (docs/STATE_MODEL.md):** one verdict per photo (`unreviewed`/`kept`/`culled`/`trashed` — `to_edit` stops being a verdict, `done` is spelled `kept`), any number of ACTIONS in one `photo_actions` table replacing three column shapes plus the share-queue table, and annotations that are never states. The four actions align by rule, and each badges at two weights — loud while it waits for you, quiet once the photo merely carries it. Fill = reviewed everywhere, grouping moves to an underline, selection becomes an outline, each kind's hue is reserved for that kind (red doubles as the danger colour; nothing else doubles), and the accent means interaction only. Also: the day page's "Continue reviewing" is day-scoped on both legs, so it can no longer open a different day's photos. **And the scan stops re-walking the library:** a DELTA pass asks MediaStore which rows changed since the last per-volume generation, walks the real merge-window bounds around each one, and re-pages only those — 262 s → 0.25 s on a 27k corpus, with byte-identical grouping (a full pass is the same code over one unbounded range). Deletions arrive as trashed rows, since an Android 11+ gallery delete keeps the row with `IS_TRASHED` set; counts are checked before AND after each pass, and every uncertainty falls back to a full pass. Schema v18 (destructive reset, pre-v1 policy) — which discards the embedding cache, so the upgrade costs one ~25-minute re-analysis on a 27k library. Also: the vestigial range scope is deleted (sessions took the feature that set it), and the coverage goal stops disagreeing with itself between Home and Stats. **The 16-item tester backlog closed the release** (docs answered per item; the release was HELD until it cleared): review became the merged newest-first TIMELINE above with one unified deck (decided singles stay in place badged; every deck newest-photo-first, opening on its first pending photo; truthful headers — unit progress + library remainder, no page ordinals); "Continue reviewing" goes straight into the next unit and Android back exits through Home; organize moved to the two-step queue-assigns-albums flow; Compare gained the whole-table verdict dialog, kept-photo eligibility and the four action chips; Home cold start renders ghosts and fills in place (permission is tri-state — no more ask-card flash); a running scan shows its percentage on Home and in Settings with ONE library total everywhere; Stats gained all-time records (longest goal streak, most in one day — deliberately no guilt counters); crossing the daily goal celebrates at the crossing decision (deck or Compare, once per day); and the vocabulary settled — the deletion pipeline speaks "cull" (the OS moment alone says "Trash"), "queued" is the to-do word, queue screens are "<Action> queue". No on-device ML.

**m0.9 — Videos + legacy Android (moved from m0.8; next)**
- **Videos enter review** (singles-first: playback, keep/cull/queues; grouping later if warranted).
- **Android ≤ 10 culling via permanent delete** behind unmissable warnings (no system trash below API 30; ships with matching trash-invariant doc updates).
- **Per-ABI APK splits** (deferred from m0.8's Gate 6): the universal APK is ~163 MB with MediaPipe; splits reclaim most of it once the release workflow handles multiple artifacts.
- **Visual vet of live groups** (deferred from m0.8): a contact sheet from a device DB's actual continuous groups to eyeball the fitted curve's real-world behavior.

**After m0.9**: hardening and tester-driven fixes to 1.0 — including the planned **one-time identity break** bundling everything that forces a reinstall into a single tester disruption: real release keystore, **application id aligned to the "Afterglow" name** (drops `com.afterglow.companion`), and **versionCode reset to 1** (fresh installs have no downgrade check; note: if Play Store distribution ever happens, Play tracks the highest versionCode per id — moot since the id is new). A data export/import path is considered first so review history survives. Then merging `initial` → `main` as the pre-1.0 era closes. **iOS evaluation is deferred post-1.0 until further notice** (no iOS users or testers today).

---

## Trigger-based backlog

Build these only when their trigger fires; no release target until then.

- **Desktop `indexReady` IPC push** — pushes the whole library over IPC; chunk/incrementalize when a library passes ~100k photos.
- **Desktop startup speed** — v0.5's warm-start-from-index was the first pass; if still slow, a profiling pass rides with v0.6 (the RAW pre-render queue touches the same path).
- **`.scr` thin stub** — the screensaver is currently a full copy of the installed exe; a thin stub can replace the copy in a later release without touching registration logic. Cost today: one duplicated exe on disk.
- **Desktop video capture dates** — videos index by file mtime only; container-metadata creation dates are a possible refinement. Low priority.
- **`expo-media-library/legacy` migration** — mobile deliberately uses the legacy module for queries (battle-tested cursor paging); migrate to the SDK's class-based Query/Asset API when Expo deprecates the legacy path in earnest (m0.8+). All access funnels through `src/lib/media.ts`, so it stays a one-file migration.
- **GitLab releases** — deferred until further notice; GitHub Releases is the sole delivery path. Do not add GitLab CI/remotes without a new decision.

## Risks

- **Unsigned builds.** Windows builds trip SmartScreen — testers are told to expect "More info → Run anyway"; code signing is a later cost decision. Android photo-permission UX varies by OEM/version.
- **Edit detection is heuristic.** In-place edits (Samsung) are detectable via MediaStore changes; copy-saving editors need name/timestamp sniffing; both can miss. Mitigation: manual mark-done always exists; detection is a convenience layer, not a correctness dependency.
- **darktable-cli throughput** (seconds per 4K render). Mitigation is architectural and non-negotiable: background queue + cache, never convert on the display path (v0.6).
- **Lightroom fidelity disappointment.** Mitigation: the tiered messaging above, in-app labels included.
- **EXIF timestamp quirks** (timezones, missing `DateTimeOriginal`, WhatsApp-stripped files). Mitigation: fall back to file mtime, cluster on local naive time, and treat clustering as best-effort.
- **HEIC** (default on many phones) doesn't decode in Chromium; fine on Android. Desktop HEIC is a later, deliberate feature — document as unsupported until then.

## Open questions

- Whether desktop flag-queue items should sync anywhere (file in the library? export?) — decide when organizer mode matures.
- Code signing (Windows cert, macOS notarization) — cost/benefit call before wide distribution.
- Perceptual-hash similarity (blockhash/pHash in TS vs native) — shipped on mobile as dHash in m0.4; desktop decision moves to v0.7 (organizer burst-culling).
- What, if anything, should eventually consume full best→worst ranking (day cover photos? desktop show-best-of-burst?). Duel history is stored from m0.1 so the option stays open without extra user effort.
- Samsung Gallery's in-place edits keep a hidden pre-edit backup ("magic" undo). Worth investigating whether its presence is detectable — it would make edit detection on Samsung devices near-perfect.
