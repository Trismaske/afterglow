# Afterglow — Product Plan & Roadmap

*Drafted 2026-07-17, after reviewing the Copilot scaffold (see [REVIEW.md](REVIEW.md)) and settling the open product questions.*

## Vision

Two apps, one shared brain:

1. **Afterglow Desktop** — a fullscreen ambient photo display ("screensaver") for a media PC or desktop, that shows your *edited* photos and videos with intelligent ordering, and quietly doubles as a photo-organization capture tool: see a photo that needs attention, flag it with one keypress, deal with it later.
2. **Afterglow Companion** — an Android app that drives every phone photo to a reviewed end-state: it groups shots taken in quick succession, walks you through each group two photos at a time (cull one, or keep both and pick the better), stages deletions for one confirmed batch, and tracks which keepers still need editing.

They are separate apps with separate release trains, but the intelligence — time-based clustering, ordering strategies, the flag/culling session model — lives in one shared TypeScript package both consume.

## Decisions locked in (2026-07-17)

| Question | Decision |
|---|---|
| Platforms | Windows, Linux, macOS — **Windows first priority** (the media PC). Dev machines run Ubuntu/Mint. |
| Desktop stack | **Electron + TypeScript**, proper security model (preload + `contextBridge`) from day one. Chosen over Tauri for reliable bundled video codecs and over Flutter for web-tech slideshow strengths + TS code sharing with React Native. |
| Mobile stack | **React Native (Expo), Android first.** iOS later. |
| App split | Two apps sharing a core package. Desktop = screensaver + organizer modes in one app. |
| RAW strategy | Keep it — it's the differentiator. **darktable XMPs rendered faithfully** via `darktable-cli`; **Lightroom via tiered fallbacks** — preview-cache extraction, DNG/embedded previews (see below). Per-image routing by sniffing XMP namespaces (`darktable:` vs `crs:`). JPEG-only libraries work fine regardless. |
| Mobile app name | **Afterglow Companion.** |
| Mobile workflow | State machine converging on `done` (see below); pairwise duel culling ships in m0.1; bracket-for-best + stored duel history instead of full ranking; auto-cull hints from duel losses; to-edit queue lives in-app with `ACTION_EDIT` launch. |
| Distribution | GitHub Releases, CI-built installers per tag. Auto-update later. |
| First deadlines | Desktop v0.1 in **1–2 days** (testers are waiting). Mobile m0.1 in **~1 week** (needed for a trip). |
| Existing code | Start over. The scaffold has injection bugs, cache collisions, and deprecated Electron patterns ([REVIEW.md](REVIEW.md)). Keep only the research: format lists, XMP sidecar naming convention, `darktable-cli` flags. |

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

### Afterglow Companion (Android)

**The state machine.** Photos have no state by default. Every photo eventually converges to `done` — the app's goal is inbox zero for the camera roll, achievable day by day:

```
(no state) ──in a cull group──▶ duel review ──┬─▶ culled ─▶ confirmed ─▶ trashed
                                              └─▶ kept ──┬─▶ to-edit ─▶ done
(no state) ──not in a group──▶ single review ─┴──────────┴─▶ done
```

- **Cull groups:** internal logic (time proximity first, perceptual similarity later) clusters shots of the same moment.
- **Duel review — the signature mechanic:** the group is presented two photos at a time. Each duel: cull one, or keep both and pick the better. Winners advance bracket-style until a group **best** emerges. Every duel outcome (win/loss record) is stored cheaply as a byproduct — no extra comparisons — so later features can mine it.
- **Auto-cull hints:** after the bracket, photos that never won a duel get a second-pass prompt: "You kept 9 — want to reconsider these 3?" (Full best→worst ranking is deliberately *not* built until something consumes it; candidates: cover photo for a day, desktop's show-best-of-burst. The duel history preserves the option.)
- **Cull list:** staged, reviewable, then one final confirmation → batch delete into the **system trash** (30-day recovery, single system dialog).
- **Single review:** photos outside any group get a swipe pass — cull / to-edit / done.
- **To-edit queue:** in-app list (Android has no virtual gallery albums); each entry has an Edit button firing `ACTION_EDIT` into the user's editor of choice — fewer taps than finding it in the gallery. Manual "mark done" always available.
- **Edit detection on app open:** two heuristics, because Android editors differ. Samsung Gallery (and similar) edit **in place** — same file, changed content — detected via MediaStore generation/`date_modified`/hash change → auto-mark `done`. Other editors (Google Photos, Snapseed) save a **copy** — detected via sibling-name/timestamp sniffing → copy marked `done`, app asks whether to keep or cull the original.
- **Compare UX:** full-screen A/B flip (tap to alternate the two duel candidates — better than side-by-side on a phone) and synchronized pinch-zoom (both photos zoom to the same region for sharpness/eyes checks).
- **Sessions & progress:** day-scoped review sessions ("clear July 16"), summary (reviewed / culled / storage reclaimed), streaks.
- Later: perceptual similarity grouping, stats, iOS.

### Shared core — `@afterglow/core`

Pure TypeScript, no filesystem or platform APIs — both apps feed it `MediaItem[]` (id, timestamp, path/uri, kind) through their own adapters:
- Gap-based time clustering (moments/sessions) with configurable gap, cap, sampling.
- Playlist/mix engine and retrospective selectors.
- Flag-queue and culling-session state models (flag types, staged actions, undo, serialization).

---

## Repository layout

Monorepo (this repo), npm workspaces:

```
afterglow/
├── packages/core/        # @afterglow/core — shared pure-TS logic + its tests
├── apps/desktop/         # Electron app (main, preload, renderer)
├── apps/mobile/          # Expo React Native app
├── docs/                 # PLAN.md, REVIEW.md move here eventually
└── .github/workflows/    # CI: lint/test + release builds
```

v0.1 may start as `apps/desktop` + a stub core to keep the deadline; the structure exists from day one so nothing needs moving later.

---

## Release roadmap

Two trains. The sequencing respects the deadlines: desktop v0.1 ships first (testers waiting), then the mobile MVP gets the full push before the trip, then trains interleave.

### Desktop train

**v0.1 — "It's alive" (Days 1–2)**
Fresh Electron+TS app: fullscreen crossfade slideshow of JPEG/PNG/WebP from user-picked folders (recursive scan), shuffle order, persisted settings (folders, slide duration), exit on mouse-move/key/click, preload+contextBridge security, media served via a custom protocol. CI builds Windows installer + Linux AppImage to a GitHub Release.
*Done when: a tester downloads the Windows build, picks their Pictures folder, and it runs for an hour without interaction.*

**v0.2 — Overlay + flag capture (fast follow, ~2–3 days after m0.1 ships)**
Path/date overlay (toggleable). Flag keys D/E/M/R with toast; queue persisted to disk; minimal queue window listing flags with "reveal in folder" / "open" / "remove". This is deliberately cheap — capture first, rich actions later.
*Done when: you flag 10 photos during a session and can find and open every one afterwards.*

**v0.3 — Story engine v1**
Background EXIF indexing (`exifr`), persisted index. Moments clustering + mix engine from `@afterglow/core` (now real, shared with mobile). Settings: gap, cluster cap, shuffle↔smart toggle.
*Done when: a burst of 8 shots plays consecutively instead of scattered across the night.*

**v0.4 — Video**
Muted MP4/WebM/MOV in the rotation, duration cap, honest format documentation.

**v0.5 — The RAW pipeline**
`execFile`-based `darktable-cli` wrapper (never shell strings); cache keyed on hash(path + XMP mtime + output size); background pre-render queue with concurrency limit that stays ahead of playback; cache size cap + LRU eviction + settings UI. Per-image renderer routing by XMP namespace (`darktable:` vs `crs:`); embedded-preview extraction for the Lightroom tiers, with `Previews.lrdata` catalog extraction as the stretch goal (or v0.5.x follow-up). RAW+JPEG pair de-dup.
*This is the release where it becomes Afterglow. Budget a real week; it's the hardest engineering in the app.*

**v0.6 — Organizer mode**
Queue actions (OS trash, move, open in editor). Burst-culling compare UI over the index.

**v0.7 — Retrospectives + multi-monitor + polish**
This-day-in-history and month/year modes; all-displays support; overlay/settings polish.

**v0.8 — Screensaver integration, Windows first**
Idle-trigger and/or `.scr` wrapper on Windows; then Linux idle hooks; macOS guidance. Auto-update (electron-updater) lands here too.

**v1.0** — hardening, docs, signing decisions, whatever the testers demanded loudest.

### Mobile train

**m0.1 — Trip-ready culler with duels (Days 3–7, ships before the trip)**
Expo dev build (not Expo Go — media permissions need it). Read camera roll for today/yesterday/date-range; time-cluster into cull groups with `@afterglow/core`; **pairwise duel flow** (cull one / keep both & pick better, bracket to a group best, duel outcomes persisted); simple swipe keep/toss for non-group photos; staged cull list → review → one confirmation → batch delete to system trash; session summary. Local state in SQLite keyed by MediaStore ID (+ content hash fallback). Ugly is fine; end-of-day usefulness is the bar.
*Done when: you can clear a 200-photo day down to keepers in 10 minutes at a hotel.*

**m0.2 — The full state machine (on/after the trip)**
`to-edit` flag in both duel and single review; in-app to-edit queue with `ACTION_EDIT` launch and manual mark-done; everything converges to `done`; day-scoped inbox-zero progress view. Plus fixes from real trip use.

**m0.3 — Detection & compare polish**
Edit detection on app open (in-place mtime/generation/hash change → auto-done; edited-copy sniffing → prompt keep/cull original). Auto-cull hints from duel history ("never won a duel — reconsider?"). Full-screen A/B flip compare + synchronized pinch-zoom.

**m0.4+** — perceptual-similarity grouping, stats/streaks, then evaluate iOS once the Android loop is proven.

---

## Risks

- **The 1–2 day desktop window.** Mitigation: v0.1 scope is frozen above; anything else is v0.2. Unsigned Windows builds will trip SmartScreen — tell testers to expect "More info → Run anyway"; code signing is a later cost decision.
- **The 1-week mobile window.** Expo + `expo-media-library` covers read/delete, but Android photo-permission UX varies by OEM/version. Mitigation: build the walking skeleton (list → group → duel → staged delete) on day 3, iterate daily. The duel mechanic is core and stays; A/B flip and synchronized zoom are the cut lines.
- **Edit detection is heuristic.** In-place edits (Samsung) are detectable via MediaStore changes; copy-saving editors need name/timestamp sniffing; both can miss. Mitigation: manual mark-done always exists; detection is a convenience layer (m0.3), not a correctness dependency.
- **darktable-cli throughput** (seconds per 4K render). Mitigation is architectural and non-negotiable: background queue + cache, never convert on the display path (v0.5).
- **Lightroom fidelity disappointment.** Mitigation: the tiered messaging above, in-app labels included.
- **EXIF timestamp quirks** (timezones, missing `DateTimeOriginal`, WhatsApp-stripped files). Mitigation: fall back to file mtime, cluster on local naive time, and treat clustering as best-effort.
- **HEIC** (default on many phones) doesn't decode in Chromium; fine on Android. Desktop HEIC is a later, deliberate feature — document as unsupported until then.

## Open questions (not blocking v0.1)

- Whether desktop flag-queue items should sync anywhere (file in the library? export?) — decide when organizer mode matures.
- Code signing (Windows cert, macOS notarization) — cost/benefit call before wide distribution.
- Perceptual-hash similarity (blockhash/pHash in TS vs native) — decide at desktop v0.6 / mobile m0.4.
- What, if anything, should eventually consume full best→worst ranking (day cover photos? desktop show-best-of-burst?). Duel history is stored from m0.1 so the option stays open without extra user effort.
- Samsung Gallery's in-place edits keep a hidden pre-edit backup ("magic" undo). Worth investigating whether its presence is detectable — it would make edit detection on Samsung devices near-perfect.
