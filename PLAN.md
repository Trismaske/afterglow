# Afterglow — Product Plan & Roadmap

*Drafted 2026-07-17, after reviewing the Copilot scaffold (see [REVIEW.md](REVIEW.md)) and settling the open product questions. Roadmap updated 2026-07-18 to fold in the first tester round — see [docs/Feedback_20260717.md](docs/Feedback_20260717.md) and the response plan [docs/Plan_20260718.md](docs/Plan_20260718.md).*

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

Two trains. v0.1–v0.4 and m0.1–m0.4 have shipped; the next release on each train packs in the whole 2026-07-17 tester round in one go, and everything after shifts down.

### Desktop train

**Shipped**
- **v0.1** — fullscreen crossfade slideshow (JPEG/PNG/WebP) from user-picked folders, persisted settings, exit on input, preload+contextBridge security, CI-built Windows/Linux releases.
- **v0.2** — path/date overlay; D/E/M/R flag capture with persisted queue + queue window.
- **v0.3** — story engine v1: background EXIF indexing, moments clustering + mix engine from `@afterglow/core`.
- **v0.4** — muted video (MP4/WebM/MOV) in the rotation, per-video duration cap.

**v0.5 — Feedback release: control, navigation, screensaver (next)**
The full tester round in one release:
- Manual launch opens the **settings screen** with a Start button; a `--show` flag jumps straight into the slideshow. When launched manually, any key/mouse **exits the show back to settings** instead of quitting (`--show`/screensaver mode still quits). Flag and nav keys stay exceptions.
- **Arrow-key navigation**: ←/→ previous/next photo, ↑ restart current moment, ↓ skip to next moment. Needs a seek API + history back-buffer on the slideshow (today it's fire-and-forget).
- **Shortcut legend** in the overlay, also shown briefly at show start.
- **New flags**: **N** = "needs rename", **T** = "needs date fix" (extends core `FLAG_TYPES`, key map, queue UI).
- **Video cap 0 = play full length** (sentinel in settings clamp + cap timer); cluster-cap range (2–100) surfaced as inline hint text.
- **OS screensaver/display-sleep suppressed** while the show runs (`powerSaveBlocker`).
- **Startup**: show the window immediately and start playing from the persisted EXIF index; rescan folders in the background and merge. First pass at the "slow to open" complaint.
- **"Set as default screensaver" button (Windows)**: the NSIS installer ships a thin `.scr` wrapper that launches the installed app with `--show`; the button registers it via the registry and shows current status. Same app, same settings store — screensaver and app settings stay in sync by construction. Hidden on non-Windows; primary-display-only in screensaver mode for now (full multi-monitor keeps its later slot).

*Done when: a tester lands in settings on launch, steps back two photos with ←, skips a moment with ↓, flags a photo N for rename, escapes back to settings — then clicks the screensaver button, waits out their idle timeout, and Afterglow starts as the system screensaver with their configured settings.*

**v0.6 — The RAW pipeline** (was v0.5)
`execFile`-based `darktable-cli` wrapper (never shell strings); cache keyed on hash(path + XMP mtime + output size); background pre-render queue with concurrency limit that stays ahead of playback; cache size cap + LRU eviction + settings UI. Per-image renderer routing by XMP namespace (`darktable:` vs `crs:`); embedded-preview extraction for the Lightroom tiers, with `Previews.lrdata` catalog extraction as the stretch goal (or v0.6.x follow-up). RAW+JPEG pair de-dup.
*This is the release where it becomes Afterglow. Budget a real week; it's the hardest engineering in the app.*

**v0.7 — Organizer mode** (was v0.6)
Queue actions (OS trash, move, open in editor — now including rename and date-fix flag actions). Burst-culling compare UI over the index.

**v0.8 — Retrospectives + multi-monitor + polish** (was v0.7)
This-day-in-history and month/year modes; all-displays support; overlay/settings polish.

**v0.9 — Screensaver: Linux + macOS, auto-update** (Windows shipped in v0.5)
Linux idle hooks (systemd/X11); macOS hot-corner + launcher guidance (no `.saver` from Electron). Auto-update (electron-updater) lands here too.

**v1.0** — hardening, docs, signing decisions, whatever the testers demanded loudest.

### Mobile train

**Shipped**
- **m0.1** — trip-ready duel culler: time-clustered cull groups, pairwise duels, staged cull → one confirmation → system trash, SQLite state.
- **m0.2** — the full state machine: `to-edit` in duel and single review, in-app to-edit queue with `ACTION_EDIT`, day-scoped inbox-zero progress.
- **m0.3 / m0.3.1** — edit detection on app open, auto-cull hints, A/B flip compare + synchronized zoom; review-scope ranges, gated All-time, source folders.
- **m0.4** — perceptual-similarity grouping (dHash), **swipe-deck group review replacing the duel bracket** (bracket retained in core), progress browsing, Material You theming.

**m0.5 — Feedback release (next)**
The full tester round in one release:
- **Editor launch fallback**: `ACTION_EDIT` → `ACTION_VIEW` (Samsung Gallery / default viewer, pencil is one tap away) before ever erroring; drop the confusing "or enable" wording from the remaining error.
- **Similarity rescaled looser** — identical photos must group at Strictest. New five-step mapping **Strictest 12 · Strict 16 · Normal 20 · Loose 26 · Loosest 32** (old Normal becomes new Strictest; top end stays temporal-proximity-dominant). Plus a **0–64 fine-tune slider** under the chips (chips snap the slider; off-preset = "Custom") and a one-line explainer.
- **Decisions reversible** until the final cull confirmation (re-decide transitions in core `DeckSession`, chip row on decided photos in the UI).
- **Session flow freedom**: enter any group in any order, do singles before groups; "Replace unfinished session?" dialog reordered (Continue existing = right-most default, Start new on the left); **starting a new session never discards decisions** (they're committed per-photo to the store); **"End session & apply"** banks all decisions early and jumps to cull confirmation.
- **New Sessions settings**: max photos per session (default **50**, replacing the hardcoded 500), group-boundary-inclusion switch (cap soft by up to one group), oldest-first/newest-first selector.
- **Compare fixes**: in 2-photo groups "X is better" marks X best-of-group and offers to cull the other (confirmation with "don't ask again", resettable in Settings); in larger groups "better" visibly stars the best-of-group candidate and feeds Reconsider (with a toast); opponent picking made discoverable ("Compare with…" affordance, not just long-press); compare labels use the photos' **group numbers** instead of A/B.
- **Custom named review scopes** (e.g. "Japan — Jan 31 to Mar 6"): created from the custom-scope screen, persisted; Settings scope manager to enable/disable/delete and reset to defaults (static `SCOPE_DEFS` moves to the store, seeded from defaults).
- **Pinch-zoom in group review** — bring Compare's synchronized-zoom gesture into the deck (needs gesture arbitration against the pager).
- **Gear settings icon** (current reads as an eye/sun); **Source removed from Home** (lives in Settings).

*Done when: a Samsung tester taps Edit and lands in Gallery; two identical photos group on Strictest; a tester does singles first, changes a to-edit photo to cull, ends the session after 3 groups without losing a single decision, creates a "Japan" scope, and pinch-zooms right in group review.*

**m0.6+** — stats/streaks, deeper startup/analysis perf, fixes from field use, then evaluate iOS once the Android loop is proven.

---

## Risks

- **The 1–2 day desktop window.** Mitigation: v0.1 scope is frozen above; anything else is v0.2. Unsigned Windows builds will trip SmartScreen — tell testers to expect "More info → Run anyway"; code signing is a later cost decision.
- **The 1-week mobile window.** Expo + `expo-media-library` covers read/delete, but Android photo-permission UX varies by OEM/version. Mitigation: build the walking skeleton (list → group → duel → staged delete) on day 3, iterate daily. The duel mechanic is core and stays; A/B flip and synchronized zoom are the cut lines.
- **Edit detection is heuristic.** In-place edits (Samsung) are detectable via MediaStore changes; copy-saving editors need name/timestamp sniffing; both can miss. Mitigation: manual mark-done always exists; detection is a convenience layer (m0.3), not a correctness dependency.
- **darktable-cli throughput** (seconds per 4K render). Mitigation is architectural and non-negotiable: background queue + cache, never convert on the display path (v0.6).
- **Lightroom fidelity disappointment.** Mitigation: the tiered messaging above, in-app labels included.
- **EXIF timestamp quirks** (timezones, missing `DateTimeOriginal`, WhatsApp-stripped files). Mitigation: fall back to file mtime, cluster on local naive time, and treat clustering as best-effort.
- **HEIC** (default on many phones) doesn't decode in Chromium; fine on Android. Desktop HEIC is a later, deliberate feature — document as unsupported until then.

## Open questions (not blocking v0.1)

- Whether desktop flag-queue items should sync anywhere (file in the library? export?) — decide when organizer mode matures.
- Code signing (Windows cert, macOS notarization) — cost/benefit call before wide distribution.
- Perceptual-hash similarity (blockhash/pHash in TS vs native) — shipped on mobile as dHash in m0.4; desktop decision moves to v0.7 (organizer burst-culling).
- What, if anything, should eventually consume full best→worst ranking (day cover photos? desktop show-best-of-burst?). Duel history is stored from m0.1 so the option stays open without extra user effort.
- Samsung Gallery's in-place edits keep a hidden pre-edit backup ("magic" undo). Worth investigating whether its presence is detectable — it would make edit detection on Samsung devices near-perfect.
