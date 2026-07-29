# Afterglow — Product Plan & Roadmap

*The living product plan: vision, locked decisions, the full 1.0 feature picture, and the release roadmap. Tester feedback is folded directly into the roadmap each round.*

## Vision

Two apps, one shared brain:

1. **Afterglow Desktop** — a fullscreen ambient photo display ("screensaver") for a media PC or desktop, that shows your *edited* photos and videos with intelligent ordering, and quietly doubles as a photo-organization capture tool: see a photo that needs attention, flag it with one keypress, deal with it later.
2. **Afterglow on Android** ("Afterglow Companion" until the m0.8 rename) — an app that drives every phone photo to a reviewed end-state: it groups shots taken in quick succession, walks you through each group two photos at a time (cull one, or keep both and pick the better), stages deletions for one confirmed batch, and tracks which keepers still need editing.

They are separate apps with separate release trains, but the intelligence — time-based clustering, ordering strategies, the flag/culling session model — lives in one shared TypeScript package both consume.

## Decisions locked in

| Question | Decision |
|---|---|
| Platforms | Windows, Linux, macOS — **Windows first priority** (the media PC). Dev machines run Ubuntu/Mint. |
| Desktop stack | **Electron + TypeScript**, proper security model (preload + `contextBridge`) from day one. Chosen over Tauri for reliable bundled video codecs and over Flutter for web-tech slideshow strengths + TS code sharing with React Native. |
| Mobile stack | **React Native (Expo), Android first.** iOS later. |
| App split | Two apps sharing a core package. Desktop = screensaver + organizer modes in one app. |
| RAW strategy | Keep it — it's the differentiator. Per-image routing to the editor that owns the edits (sidecar + namespace sniffing): **darktable XMPs via `darktable-cli`**, **RawTherapee pp3s via `rawtherapee-cli`**, **Lightroom via the Afterglow companion plugin** driving the machine's own LR Classic (no headless Adobe path exists — verified). Unedited/unrenderable RAWs show the embedded camera preview, honestly labeled, behind a setting. JPEG-only libraries work fine regardless. |
| App naming & convergence | **Both apps are "Afterglow"** (mobile renames from "Afterglow Companion" in m0.8 — display name only; the Android application id stays `com.afterglow.companion` so testers don't end up with two installs). One product, two surfaces: organize/queue UI-UX patterns converge as desktop organizer (v0.7+) and mobile mature, with shared vocabulary throughout. |
| Mobile workflow | State machine converging on `done` (see below); swipe-deck group review (replaced the m0.1–m0.3 duel bracket in m0.4; the bracket stays in core for desktop reuse); stored compare/duel history instead of full ranking; completed groups advance directly to the next unfinished group; to-edit queue lives in-app with `ACTION_EDIT` launch. |
| Distribution | GitHub Releases, CI-built installers per tag. Auto-update later. |

## The Lightroom reality

**There is no local/headless Lightroom API** — no CLI, no COM/AppleScript, no headless Camera Raw; the cloud REST API is partner-gated and cloud-only. `darktable-cli` silently ignores `crs:` XMPs (verified pixel-identical output), so no non-Adobe engine can render Lightroom edits. The honest tiers:

1. **darktable users:** pixel-faithful rendering via `darktable-cli` with the sidecar XMP. Flagship feature.
2. **RawTherapee users:** pixel-faithful rendering via `rawtherapee-cli` with the `.pp3` sidecar (`-S` = only-if-edited).
3. **Lightroom users — the companion plugin** (`apps/lightroom-plugin/`, hand-rolled Lua, file-based job queue): drives the machine's own LR Classic against a **dedicated Afterglow render catalog** — import, forced sidecar read (`photo:readMetadata()` — import alone loads no edits), `LrExportSession` into Afterglow's render buffer. User catalogs are never imported into or metadata-read. While a user's own LR session is open, jobs defer by default; the opt-in **close-Lightroom-on-screensaver-start** setting adds one exception to the close policy: on a screensaver-triggered launch only (manual starts never qualify) a user-owned session may be closed **gracefully** — a blocked close (unsaved dialog) falls back to deferral, and force-kill never happens. Outside that opt-in, Afterglow closes only instances it launched. Sidecars (`crs:` XMP + `.acr` AI masks) are machine-portable and render faithfully. Requires LR installed + running; Afterglow launches LR minimized when LR jobs are pending and gracefully closes only instances it launched. **Unattended operation is dialog-free** (LR's metadata-read prompt is suppressed via preference keys verified at onboarding); photos whose render would raise a dialog (AI-settings updates, if unsuppressible) are excluded from unattended rendering and handled by an explicit attended maintenance pass.
4. **No editor / no edits:** the embedded camera preview (full-res for NEF/CR2; ~1080p for CR3/ARW), labeled "camera preview", behind a setting (show [default] / only full-res / skip).
5. **Anyone:** exported JPEGs always work; a JPEG sibling (same folder or the `JPEG\` subfolder convention) is preferred over re-rendering — unless it is stale (older than any edit dependency, a dependency's stored digest changed — catches mtime-preserving sync rewrites — or the source RAW's own mtime/size identity changed since the sibling was last judged fresh) or the RAW carries a **multi-editor conflict** (a conflicted photo renders through the selected editor; a sibling cannot be attributed to it). Stale → shown with an "outdated edit" label until its JIT render supersedes it — but only as far as the unrenderable-edits fallback setting permits (`skip` means skipped, not shown) — and auto-flagged into the flag queue for review (known-outdated output is never shown silently).

Reading Lightroom's preview cache (`Previews.lrdata`) is deliberately not a tier — it requires the catalog on the Afterglow machine and undercuts the RAW+sidecar parity goal. The UI and README must state these tiers plainly so Lightroom users aren't promised fidelity we can't deliver.

---

## Full feature picture at 1.0

### Afterglow Desktop

**Display**
- Fullscreen slideshow: JPEG/PNG/WebP (later GIF), crossfade transitions, optional Ken Burns pan/zoom.
- **HEIC** — required, not optional: it is the iPhone default and the family's phone backups hold thousands. Chromium can't decode it, so HEIC rides the same **look-ahead JIT render pipeline as RAW** (a non-displayable source rendered to a displayable JPEG on demand): a HEIC renderer joins the renderer registry, no new display architecture.
- Muted video playback (MP4/WebM/MOV — honest list only; no AVI/MKV claims), per-video duration cap.
- RAW via the tiers above, rendered just-in-time for a moment-aware look-ahead queue into an ephemeral buffer (deleted after leaving recent history; re-rendered on next appearance — compute is free on an idle machine). A slide may hold a few extra seconds while the next photo renders (stated in settings); up-to-date exported JPEG siblings are used directly instead of rendering.
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
- Settings UI: media folders (multiple), durations, transition, story-mode weights, unedited-RAW handling, unrenderable-edits fallback (labeled sibling/preview vs skip), video sound (default muted), close-Lightroom-on-screensaver-start (default off), render look-ahead depth (default 10), navigation-history size (default 200). Persisted via the atomic `<userData>/settings.json` store.
- Exit on mouse-move/key/click through one code path (flag keys excepted).
- Idle/screensaver integration, per platform, in priority order: Windows `.scr` wrapper or Task Scheduler idle trigger → Linux (systemd/X11 idle hooks) → macOS (no `.saver` possible from Electron; use hot-corner + launcher guidance).
- CI: lint, tests, tagged releases building Windows NSIS/portable, Linux AppImage/deb, macOS dmg.

### Afterglow (Android)

**The state machine.** Photos have no state by default. Every photo eventually converges to `done` — the app's goal is inbox zero for the camera roll, achievable day by day:

```
(no state) ──in a cull group──▶ group review ─┬─▶ culled ─▶ confirmed ─▶ trashed
                                              ├─▶ to-edit ─▶ done
(no state) ──not in a group──▶ single review ─┴─▶ done
```

(From m0.8 a keep writes `done` directly — there is no interim `kept` state; every verdict stays revisable until the final cull confirmation.)

- **Cull groups — purpose (Tristan, 2026-07-24):** a group is a **de-duplication aid** — visually similar photos that could substitute for each other, from which a human keeps the best. Visual similarity decides membership; time proximity may narrow candidates but never adds members (temporally close, dissimilar photos must NOT group). Byte-identical duplicates are the floor. Boundary calls err **inclusive** — ejecting a wrongly-grouped photo is one tap, while singles can never be promoted into a group (by design), so a false inclusion costs a swipe but a false exclusion costs a navigation loop. This is a different concept from desktop *moments*, even where machinery is shared — and the same grouping engine is intended for desktop organizer culling (v0.7+), so investment here pays twice. The algorithm (m0.8, `docs/Plan_m0.8.md`): on-device image embeddings (MediaPipe MobileNetV3-large) with a 3-min burst gate, centroid linkage, and adjacent-burst merges ≤15 min — validated against a committed suite of human-judged pairs; dHash survives only as a time-gated exact/near-duplicate annotation. Groups persist, so completed days re-show them. 1-photo groups are singles.
- **Group review — swipe deck:** each group is a swipeable deck — cull (with undo), keep the rest, flag to-edit, star a best, or eject an unrelated photo to the singles bucket. Groups can be entered in any order, singles first is fine, and every decision is reversible until the final cull confirmation. Completing a group advances directly to the next unfinished group; deliberately reopening an already-completed group remains in browse/re-decide mode.
- **Compare:** any two group members go full-screen A/B — tap to flip (better than side-by-side on a phone), synchronized pinch-zoom for sharpness/eyes checks, labels keep the photos' group numbers. "X is better" stars the best-of-group; in a two-photo group it offers to cull the loser. Every verdict is stored cheaply as compare history — no extra comparisons — so later features can mine it.
- **Cull list:** a durable global queue — staged culls persist, badged with their verdict wherever they resurface, until the final confirmation. Reviewable, then one final confirmation → batch move into the **system trash** (recovery duration is gallery-managed; one system dialog per bounded batch) on Android 11+; below API 30, permanent delete behind unmissable warnings (m0.8 — no system trash exists there).
- **Single review:** photos outside any group get a swipe pass — cull / to-edit / done.
- **The queue family** — every queue is a durable, reviewable in-app list: **to-edit** (per-photo — Edit button fires `ACTION_EDIT` into the user's editor; manual "mark done" always available), **favourite** (applied in one batch via `MediaStore.createFavoriteRequest`, surfaces as the gallery's heart), **organize** (applied in one batch — move to a chosen album via `createWriteRequest` + `RELATIVE_PATH`), **share** (a persistent working set shared in multiple sharesheet passes over chosen subsets).
- **History:** a re-decidable, filterable current-state feed of photos still present, plus share-sheet events.
- **Edit detection on app open:** two heuristics, because Android editors differ. Samsung Gallery (and similar) edit **in place** — same file, changed content — detected via MediaStore generation/`date_modified`/hash change → auto-mark `done`. Other editors (Google Photos, Snapseed) save a **copy** — detected via sibling-name/timestamp sniffing → copy marked `done`, app asks whether to keep or cull the original.
- **Continuous scan & progress (m0.8, replaces sessions):** on app open a chunked scan pages the configured folder newest→oldest, hashing and grouping incrementally — the deck fills as results land and is enterable within seconds. A presentational daily goal (default 50) drives the progress ring, celebrations, and streaks (streak day = goal reached); Home shows live corpus stats (total, groups found, % reviewed, reclaimable estimate) plus per-day and global progress browsing.
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

Two trains. v0.1–v0.5 and m0.1–m0.7 have shipped; next up: the desktop RAW pipeline (v0.6) and mobile m0.8.

### Desktop train

**Shipped**
- **v0.1** — fullscreen crossfade slideshow (JPEG/PNG/WebP) from user-picked folders, persisted settings, exit on input, preload+contextBridge security, CI-built Windows/Linux releases.
- **v0.2** — path/date overlay; D/E/M/R flag capture with persisted queue + queue window.
- **v0.3** — story engine v1: background EXIF indexing, moments clustering + mix engine from `@afterglow/core`.
- **v0.4** — muted video (MP4/WebM/MOV) in the rotation, per-video duration cap.
- **v0.5** — feedback release: settings-first launch (show exits back to settings; `--show` for straight-in), arrow-key navigation with history, shortcut legend, N/T flags (rename / date fix), video cap 0 = full length, display-sleep suppression, warm start from the persisted index, Windows "Set as default screensaver" button (`.scr` via the NSIS installer, same settings store).

**v0.6 — The RAW pipeline + Lightroom companion plugin (next; plan: `docs/Plan_v0.6.md`)**
Per-image routing to the owning editor (sidecar/namespace detection); `execFile`-based `darktable-cli` and `rawtherapee-cli` wrappers (never shell strings; serialized renders; private darktable configdir); the LR companion plugin (import → forced sidecar read → export, with Afterglow managing LR's lifecycle); embedded-preview fallback behind a setting, honestly labeled; just-in-time ephemeral rendering for a moment-aware look-ahead queue (fresh JPEG siblings used directly; stale siblings shown labeled + auto-flagged for review; renders keyed by full render identity — RAW mtime/size, sidecar content digests, artifact route, renderer version, output settings — and deleted after leaving recent history); substitution-or-brief-hold when a render isn't ready; RAW+JPEG pair de-dup (incl. `JPEG\` subfolders + staleness); FUSE/network-mount exclusion; flag queue reachable from the settings screen (tester feedback).
*This is the release where it becomes Afterglow. Budget a real week+; it's the hardest engineering in the app.*

**v0.6.x — HEIC display**
A HEIC renderer added to v0.6's renderer registry (bundled decoder; the JIT look-ahead pipeline, cache identity, and fallback settings all apply unchanged), so iPhone photos enter the rotation. Sequenced right after v0.6 while the pipeline is fresh.

**v0.7 — Organizer mode**
The flag queue becomes workable and the library becomes organizable, reusing the mobile model (states converge to done; durable queues; plan/preview → one confirmed batch apply; decisions reversible until commit). Every operation works on the photo's **file family** (RAW + JPEG sibling + every edit sidecar): renames, moves, and trash carry the whole family in lockstep — with one defined exception, the **sibling-only delete** for stale-export flags (the entry names the export itself; deleting just it is the intent). Byte-identical RAWs whose sidecars differ are surfaced as edit conflicts for review — never auto-trashed as duplicates. **Redundant exports are flagged wherever a better-format original exists** — a JPEG beside its RAW *or beside its HEIC* (same-basename pairs are common in phone backups: ~1,500 on one family phone alone) — feeding the same sibling-only delete action, so the library can converge on originals-plus-sidecars rather than accumulating derived copies. Four rungs sharing one plan/apply/verify machinery: exact-duplicate cleanup (size-bucketed SHA-256 over family-aware groups); rename + date normalization (`YYYYMMDD_HHMMSS_<CameraModel>`, camera segment dropped when no camera metadata exists — scans, old JPGs; `_1` collision suffixes; conflicts among strong date signals — EXIF/filename/folder — always queue for human review, mtime being fallback-only; adjudications written back to EXIF via exiftool); folder-layout moves against a per-library configurable template (default `<YYYY>/<YYYYMMDD>`; deliberate non-dated folders — person albums, scans — are legitimate, not violations); burst-culling compare UI over the index (`groupBySimilarity` + `DeckSession` from core). Queue actions cover the D/E/M/R/N/T flags (OS trash, move, open in editor, rename, date-fix). New shared-core modules: duplicate matching, rename planning, multi-signal date resolution — desktop consumes first, mobile later.

**v0.8 — Retrospectives + multi-monitor + polish**
This-day-in-history and month/year modes; all-displays support; overlay/settings polish.

**v0.9 — Screensaver: Linux + macOS, auto-update** (Windows shipped in v0.5)
Linux idle hooks (systemd/X11); macOS hot-corner + launcher guidance (no `.saver` from Electron). Auto-update (electron-updater) lands here too.

**v1.0** — hardening, docs, code signing (Windows certificate / macOS notarization — until then SmartScreen "More info → Run anyway" stays the documented tester path), whatever the testers demanded loudest.

### Mobile train

**Shipped**
- **m0.1** — trip-ready duel culler: time-clustered cull groups, pairwise duels, staged cull → one confirmation → system trash, SQLite state.
- **m0.2** — the full state machine: `to-edit` in duel and single review, in-app to-edit queue with `ACTION_EDIT`, day-scoped inbox-zero progress.
- **m0.3 / m0.3.1** — edit detection on app open, auto-cull hints, A/B flip compare + synchronized zoom; review-scope ranges, gated All-time, source folders.
- **m0.4** — perceptual-similarity grouping (dHash), **swipe-deck group review replacing the duel bracket** (bracket retained in core), progress browsing, Material You theming.
- **m0.5** — feedback release: editor launch fallback (`ACTION_EDIT` → `ACTION_VIEW`), looser similarity scale (12/16/20/26/32) + 0–64 fine-tune slider, decisions reversible until the final confirm, session flow freedom (any order, banked decisions, "End session & apply"), Sessions settings (cap 50 default, group-boundary softness, oldest/newest first), compare fixes (best-of-group semantics, "Compare with…" picker, group-number labels), custom named review scopes, deck pinch-zoom, gear icon.
- **m0.6** — feedback + feature-completion release: decision indicators everywhere with re-tap-to-clear, group cards reopen the group, singles unified into the deck as a pseudo-group, completed groups advance immediately, favourites queue (♥, batched `createFavoriteRequest` native module), lifetime stats + streaks, progress-bar fix, startup/analysis perf pass, Material icon language, editor-launch diagnostics (fix itself carried to m0.7 — see below).
- **m0.7** — feedback release: editor launch fixed at the root (request MediaStore write access first, then `ACTION_EDIT`; two-button edit queue — ✎ Edit + read-only Gallery); similarity-first grouping v2 (time proximity only ever helps, never excludes; groups always ≥ 2 photos; legacy time-only toggle); durable SQLite group membership; deck relayout (Keep / Compare / Cull + queue row Edit · Favourite · Organize · Share); **share queue** with multi-pass sharing (overlapping subsets across repeated sharesheet passes, pass badges + labels, honest `sheet_opened` state); **organize queue** (verified `RELATIVE_PATH` moves to primary-volume albums); **Favourite queue** rename + atomic batches; silent lossless session replacement with the **durable global cull list** (kept, edit, and staged-cull decisions all survive); crash-safe trash-attempt lifecycle (verified per-photo outcomes, at-most-once reclaimed-bytes credit); **History** feed; canonical volume-qualified photo ids; fresh-baseline schema policy (destructive DB reset between 0.x versions; migrations return at v1).

**m0.8 — Sessions removed: continuous scan, embedding groups, navigation redesign (next; plan: `docs/Plan_m0.8.md`)**
All decisions human-vetted 2026-07-24; feasibility + grouping quality study complete (four judged rounds + validation, 698-pair frozen label set, on-device benchmarks on both test phones).
- **Sessions disappear**: continuous newest→oldest scan feeds the durable tables; DB-backed deck cursor (core `DeckSession`/`CullSession` deleted); `kept` state removed (keep writes `done`; re-decide works on `done`); scopes dropped; presentational daily goal (default 50) with goal-reached streaks; live corpus stats on Home. Continuous grouping also closes the similarity components the m0.7 time-gap session cap used to split.
- **Embedding groups**: MediaPipe MobileNetV3-large (`modules/image-embedder`) + burst gate/centroid linkage/adjacent merge per the cull-groups purpose above; committed human-judged regression suite pins grouping quality in CI.
- **Home navigation redesign + tester copy round** (`docs/Feedback_m0.8.md`): bottom tabs **Home · Edit · Favourite · Share · Organize** (count-badged); Home centers scan status + daily goal + continue-reviewing; the bar stays off full-screen review surfaces. App renames to **"Afterglow"** (display name only) with a mobile/desktop terminology audit; tagline removed; review-not-cull copy; self-explanatory edit-queue buttons.
- **Deck/viewer rework** (deferred from m0.7): culled photos stay badged in the live deck; one standard full-screen viewer for deck browse, progress, history and queues (also the home for per-photo decision detail — e.g. explaining a superseded organized fact that m0.7.1 only marks with a pending icon); completed days re-show groups in browse/re-decide mode; staged culls re-enter badged with their prior verdict; recent days = 3 recent + 2 unreviewed + older-days indicator; day-count audit with kept/done merged into "reviewed".

**m0.9 — Videos + legacy Android (moved from m0.8)**
- **Videos enter review** (singles-first: playback, keep/cull/queues; grouping later if warranted).
- **Android ≤ 10 culling via permanent delete** behind unmissable warnings (no system trash below API 30; ships with matching trash-invariant doc updates).

**After m0.9**: hardening and tester-driven fixes to 1.0 — including the planned **one-time identity break** bundling everything that forces a reinstall into a single tester disruption: real release keystore, **application id aligned to the "Afterglow" name** (drops `com.afterglow.companion`), and **versionCode reset to 1** (fresh installs have no downgrade check; note: if Play Store distribution ever happens, Play tracks the highest versionCode per id — moot since the id is new). A data export/import path is considered first so review history survives. Then merging `initial` → `main` as the pre-1.0 era closes. **iOS evaluation is deferred post-1.0 until further notice** (no iOS users or testers today).

---

## Trigger-based backlog

Build these only when their trigger fires; no release target until then.

- **Desktop `indexReady` IPC push** — pushes the whole library over IPC; chunk/incrementalize when a library passes ~100k photos.
- **Desktop startup speed** — v0.5's warm-start-from-index was the first pass; if still slow, a profiling pass rides with v0.6 (the RAW look-ahead scheduler touches the same path).
- **`.scr` thin stub** — the screensaver is currently a full copy of the installed exe; a thin stub can replace the copy in a later release without touching registration logic. Cost today: one duplicated exe on disk.
- **Desktop video capture dates** — videos index by file mtime only; container-metadata creation dates are a possible refinement. Low priority.
- **`expo-media-library/legacy` migration** — mobile deliberately uses the legacy module for queries (battle-tested cursor paging); migrate to the SDK's class-based Query/Asset API when Expo deprecates the legacy path in earnest (m0.8+). All access funnels through `src/lib/media.ts`, so it stays a one-file migration.
- **GitLab releases** — deferred until further notice; GitHub Releases is the sole delivery path. Do not add GitLab CI/remotes without a new decision.

## Risks

- **Unsigned builds.** Windows builds trip SmartScreen — testers are told to expect "More info → Run anyway"; code signing is a later cost decision. Android photo-permission UX varies by OEM/version.
- **Edit detection is heuristic.** In-place edits (Samsung) are detectable via MediaStore changes; copy-saving editors need name/timestamp sniffing; both can miss. Mitigation: manual mark-done always exists; detection is a convenience layer, not a correctness dependency.
- **darktable-cli throughput** (seconds per 4K render). Mitigation is architectural and non-negotiable: renders run out-of-process for a look-ahead queue ahead of their slot, with substitution-or-brief-hold when one isn't ready — the show never blocks indefinitely on a render (v0.6).
- **Lightroom coupling.** The LR tier needs LR installed, running, and a plugin loaded, and unattended operation must stay dialog-free (the metadata-read prompt is solved via verified preference keys; the AI-updates dialog for AI-mask photos is the one unresolved case). Mitigation: the tiered messaging above, in-app labels included; if the AI dialog proves unsuppressible, AI-mask photos are excluded from unattended rendering (labeled fallback) and handled by an explicit attended maintenance pass.
- **EXIF timestamp quirks** (timezones, missing `DateTimeOriginal`, WhatsApp-stripped files). Mitigation: fall back to file mtime, cluster on local naive time, and treat clustering as best-effort.
- **HEIC** doesn't decode in Chromium (fine on Android), so desktop HEIC needs a bundled decoder — one more binary dependency alongside exiftool, and the decoder choice (libheif-based CLI vs. a sharp/libvips build) is the open implementation question. Mitigation: it reuses v0.6's render pipeline wholesale, and the format is unsupported-and-documented until that lands.

## Open questions

- Whether desktop flag-queue items should sync anywhere (file in the library? export?) — decide when organizer mode matures.
- Code signing (Windows cert, macOS notarization) — cost/benefit call before wide distribution.
- Perceptual-hash similarity (blockhash/pHash in TS vs native) — shipped on mobile as dHash in m0.4; desktop decision moves to v0.7 (organizer burst-culling).
- What, if anything, should eventually consume full best→worst ranking (day cover photos? desktop show-best-of-burst?). Duel history is stored from m0.1 so the option stays open without extra user effort.
- Samsung Gallery's in-place edits keep a hidden pre-edit backup ("magic" undo). Worth investigating whether its presence is detectable — it would make edit detection on Samsung devices near-perfect.
