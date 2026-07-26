# Investigation — desktop v0.6 and the organizer direction

*Research + decisions, updated 2026-07-25. Working document; promote into `docs/Plan_v0.6.md` / PLAN.md and delete once absorbed.*
*Evidence: hands-on CLI tests on lenny (this machine), source-linked web research, full codebase map, and live work on the family Windows machine over the tailnet. Decisions from the 2026-07-25 review session are marked **Decided**; open items **O1–O5** are all resolved. The investigation is complete — `docs/Plan_v0.6.md` is the authoritative implementation plan; this file is its evidence log.*

## Summary and agreed direction

**Next release: desktop v0.6, the RAW pipeline** (PLAN.md's slot, confirmed), from branch `initial`, version 0.5.0 → 0.6.0.
Two unreleased desktop commits ride along: `eba7528` (windowed settings launch, moment-gap copy, real app icon) and `8235ddc`'s desktop share (warm-start folder filtering, scan/build supersession epochs, serialized index commits, transactional screensaver registration + tests).

**The verified RAW picture.**
Editor-owned rendering works exactly as hoped for darktable and RawTherapee: sidecar detection is clean and namespace-sniffed, `darktable-cli` renders faithfully (verified, 2.3–5.9 s/photo on lenny), `rawtherapee-cli -S` has only-if-edited semantics.
For Lightroom there is no headless Adobe render path at any tier, and **darktable-cli silently ignores `crs:` XMPs** (verified pixel-identical) — no standalone CLI or non-Adobe engine can render crs sidecars faithfully; the only faithful local path is Lightroom itself, driven through the companion plugin below.
**The Lightroom answer (Decided O1, 2026-07-25): the companion plugin, Windows-first.**
There is no stock path — that is the investigation's most-verified fact — so v0.6's top-priority LR work is an **Afterglow companion plugin for Lightroom Classic** (Lua SDK `LrExportSession`, proven viable by existing bridge projects), running in the **LR install on the same Windows machine as Afterglow**: import mirror's RAW + crs XMP (+ `.acr` AI-mask sidecars — Adobe sidecars are machine-portable; AI masks recompute locally), export faithful JPEGs into Afterglow's render buffer.
LR's GUI must be running during render batches — an accepted, honestly-documented constraint.
The plugin is its own artifact in the monorepo (e.g. `apps/lightroom-plugin/`); if it's ever wanted on another machine (the Mac), it installs there as the same separate app.
**Preview-cache extraction is removed from the plan entirely** (catalog-unreachable in the real deployment; direction rejected).
A **per-install fallback setting** covers edits that still can't be rendered (labeled camera preview [default] vs skip).

**The deployment reality that reshaped the plan.**
Afterglow's real home is the family Windows machine (currently running the v0.5 soak test — feedback good), which hosts the 16 TB **mirror** drive: the household's central media store (backed up to pCloud), fed by multiple people and devices.
Tristan (Nikon D300s + Sony A6000, RawTherapee historically, moving to darktable) and his mom (Canon now, edits in **Lightroom on her own Mac** — catalog not reachable, and copying it is undesired) both upload to mirror; phones (Android + iPhone) land there too.
Current common pattern is RAW + XMP + JPEG triplets, but the JPEGs go stale after re-edits; the family goal is **RAW + sidecar only, JPEGs rendered on demand, always reflecting the latest edits, with the least manual work** — and the app must stay generic for setups beyond this family.
That goal is achievable outright for darktable/RT photos; for LR photos it needs the companion plugin rendering fresh JPEGs **into Afterglow's render buffer** (refreshing the library's own exported JPEGs in place stays out of scope until the organizer era).

**Organizer/divergence conclusion (decided).**
Keep the monorepo; grow `@afterglow/core` with pure organizer modules (duplicate matching, rename planning, date resolution) consumed by desktop first, mobile later.
v0.7 is the full organizer: exact duplicates, rename + date normalization, year-folder moves, **and** similarity culling (all four rungs — Decided Q5), built on mobile's proven model (states converge to done; durable queues; one confirmed batch apply; decisions reversible until commit).

---

## The family library topology (verified 2026-07-25)

```
Mom's Mac (LR catalog + Previews.lrdata — private)      Tristan's laptop lenny (darktable 5.6 flatpak; RT edits historically)
        │ copies RAW + crs.xmp (+ sometimes JPEG)               │ /mnt/onesie NVMe: 16k ARW, 2k NEF, 3.4k DNG, 207 .xmp, 239 .pp3
        ▼                                                        ▼ uploads
   Family Windows machine "home-pc" (on the tailnet)  ◀─── phones (Android + iPhone)
   ├─ 16 TB "mirror" drive = central store, SMB-shared, mirrored to pCloud
   │   └─ Photos/Years/<YYYY>/<MM>/<YYYYMMDD>/… (plus stray day-under-year folders, e.g. 2026/20260408)
   ├─ Lightroom installed (touchups only; no catalog of record)
   └─ Afterglow v0.5 soak test running — the app's primary deployment target
```

- pCloud is **backup only**; never index/render from it (FUSE reads hang unkillably — verified; and Decided Q4: detect + exclude network/FUSE mounts as media folders).
- Mirror is reachable from lenny today via the user's GVFS SMB mount of the share; anonymous SMB is denied.
- **SSH access works** (since 2026-07-25): key auth, PowerShell shell. Identity, address, and setup script live in the private machine-setup repo (`machines/home-pc/`).
- **Windows recon (2026-07-25, via SSH):** Windows 10 22H2; mirror = drive `M:`; **Lightroom Classic 13.4** (June 2024) at the standard path; **darktable 5.2.1 already installed natively** (`C:\Program Files\darktable\bin\darktable-cli.exe`); RawTherapee not installed; Afterglow at `%LOCALAPPDATA%\Programs\afterglow-desktop`.
- `M:\Photos\Years` spans **1991–2026** plus non-year folders (named-person albums — `Carl Maske`, `Dale`, `Mel…`, `Nick…` — `scans`, `Pre 1989/1991/2000`, and a stray `2025-10-05_101634` import folder): the organizer's conformance model must handle deliberate non-dated folders, not just year trees.
- ⚠️ Layout tension: mirror uses `Years/<YYYY>/<MM>/<YYYYMMDD>/`, lenny's onesie uses `<YYYY>/<YYYYMMDD>/`, and Q6 chose `<YYYY>/<YYYYMMDD>/` as the target — see **O2**.

**Mirror audit, 2026 (verified 2026-07-25, corrected same day):** 870 CR3 + 545 basename-style `crs:` XMPs + 392 `.acr` + **852 JPGs + 1 DNG**.
The JPGs live in **`JPEG\` subfolders inside day folders** (e.g. `20260219\JPEG\_5M38527.jpg`) — an initial depth-limited count missed them and wrongly reported 3.
Consequence: the prefer-the-JPEG-sibling tier *does* cover most of mom's library **if sibling matching looks across the `JPEG` subfolder** (same basename, parent day folder), and the real LR problem is **staleness** (JPEGs not re-exported after later edits) — exactly what the companion plugin fixes and what the full-library audit quantifies per year (`StaleJpg` column).
Filenames are camera originals (`_5M30331.CR3`), so the v0.7 rename rung applies to mirror too.
The `.acr` files are **Adobe Camera Raw AI-mask sidecars** (verified: ~19 KB, `ACR`+`CR3` header, one 272×603 single-channel JPEG-XL-compressed tile — mask data, no extractable preview): mom's edits use AI masking, which no non-Adobe renderer can even approximate (darktable's partial crs import has no masking support).
Net: for her photos, faithful display is possible **only** via Adobe-rendered output — the companion plugin (or manual export discipline).

---

## Part A — the RAW pipeline (v0.6)

### A1. Tooling facts (lenny, empirical)

- darktable **5.6.0 flatpak only** (`org.darktable.Darktable`); OpenCL compiled in but no usable device here → CPU renders.
- **RawTherapee not installed** on lenny (despite 239 RT 5.12 `.pp3` files in the library); flathub `com.rawtherapee.RawTherapee` when needed.
- exiftool 12.40, dcraw 9.28 installed; ImageMagick's RAW delegate broken (wants ufraw-batch). dcraw fallback rejected: slower than darktable-cli and never applies edits.

### A2. Where edits live — verified detection rules

Detection order per RAW file (multi-editor conflicts are NOT resolved by this order — the release plan supersedes it with newest-sidecar-wins + surfaced conflict):

1. `X.ext.xmp` beside the raw with `xmlns:darktable=` and `darktable:history_end > 0` → **darktable edits** (verified real sidecar). `xmp:Rating="-1"` marks darktable-rejected shots — exclude from rotation.
2. `X.ext.pp3` beside the raw (INI, `[Version] AppVersion=`) → **RawTherapee edits**.
3. `X.xmp` (basename, no raw ext) with `crs:` + `crs:HasSettings="True"` → **Lightroom edits** (present on mirror/pCloud).
4. Else embedded XMP (`exiftool -b -XMP`) scanned for the same *edit* namespaces — mere XMP presence is meaningless (DJI DNGs carry 8 KB of factory XMP with no edit namespace, verified).
5. Else: no edits.

Caveat accepted: an RT user configured "cache only" (non-default) leaves no `.pp3` and is invisible to us.

### A3. Renderer paths (verified)

**darktable-cli** — working invocation on lenny:

```
flatpak run --filesystem=<dir-if-outside-host-scope> --command=darktable-cli org.darktable.Darktable \
  IN.raw [SIDECAR.xmp] OUT.jpg --width 2560 --height 1440 \
  --core --configdir <private-dir> --library :memory: \
  --conf plugins/imageio/format/jpeg/quality=80
```

- Sidecar auto-discovery works; edits genuinely applied (13.9 % RMSE vs default render).
- **Private `--configdir` mandatory**: the default configdir deadlocks on a stale-lock check that can never pass inside flatpak's PID namespace (lock pid 2 always "alive"); crashes brick a configdir until `.lock` files are deleted. Wrapper owns its configdir and cleans stale locks.
- **Serialize renders** (concurrency 1): shared configdir → second instance aborts; separate configdirs → heavy CPU contention (6.2 s solo vs 19.8 s parallel).
- Timings: NEF 12 MP ≈ 2.3 s; ARW 24 MP ≈ 5.9 s; size capping saves little (pipeline dominates). Never render on the display path.
- **crs XMPs silently ignored** (RMSE 0 — verified). darktable's partial LR import (crop/exposure/tone-curve/…, no WB or masks) is GUI-only. PLAN.md's "darktable can best-effort import basic `crs:` settings" is wrong for the CLI and must be removed (**O4**).
- Wrappers must handle native binaries *and* flatpak (lenny is flatpak-only; Windows uses native installs — registry/default-path discovery).

**rawtherapee-cli** — `rawtherapee-cli -o OUT -S -j80 -Y -c IN`; `-S` = render only if a sidecar exists; profile stacking documented; CR3 good since 5.10. **Verified on home-pc (2026-07-25, RT 5.12 silent-installed):** 24 MP NEF default render 5.8 s, with `-p` pp3 4.3 s (output hash differs from default — edits genuinely applied), and `-S` on a sidecar-less file exits with an explicit "no sidecar procparams found" error and no output — clean only-if-edited semantics. Still not installed on lenny (flathub `com.rawtherapee.RawTherapee`; same private-/tmp caveat as darktable there).

**Windows-native render timings (home-pc: i5-11400, Intel UHD 730, inputs read from the mechanical `M:` drive):**

| Test | Time | Output |
|---|---|---|
| darktable-cli NEF 24 MP, capped 2560×1440 | **3.1–3.2 s** | 2154×1440 |
| darktable-cli NEF 24 MP, full-res | **3.9 s** | 6032×4032 |
| darktable-cli ARW 24 MP + darktable sidecar, capped | **7.4 s** (7.7 s default; hashes differ — edits applied) | 2154×1440 |
| rawtherapee-cli NEF 24 MP, default / with pp3 | **5.8 / 4.3 s** | 6024×4024 |

Somewhat slower than lenny on the matched ARW file (7.4 s vs 5.9 s; the NEF rows aren't comparable — different megapixels) — still comfortably viable for the background pre-render queue on the deployment machine.
**Windows wrapper quirks (verified):** darktable-cli's output-filename template engine **eats backslashes on Windows** — always pass the *output* path with forward slashes (input paths are fine either way). Install paths for discovery: `C:\Program Files\darktable\bin\darktable-cli.exe`; RawTherapee uses a **versioned directory** (`C:\Program Files\RawTherapee\5.12\rawtherapee-cli.exe`) — glob the version folder.

**Embedded previews** — `exiftool -b -JpgFromRaw`/`-PreviewImage`, ~0.1 s (~40× faster than rendering):

| Format | Best embedded preview |
|---|---|
| NEF | `JpgFromRaw` full-res (4288×2848 verified) |
| CR2 | `JpgFromRaw` full-res (research) |
| CR3 | **1620×1080 only** (research) |
| ARW | `PreviewImage` 1616×1080 (verified); newer bodies add full-size `JpgFromRaw` — try first |
| DNG (DJI) | 960×544 (verified) |

### A4. The Lightroom tiers (re-verified + family-fit)

- **No headless Lightroom, ever**: no CLI, no COM/AppleScript, no headless Camera Raw; cloud API partner-gated. Confirmed — "stock" RAW+crs→JPEG cannot exist.
- **Smart Previews are a dead end** (pixels unedited). **DNG Converter CLI** embeds default renders only. **Preview-cache extraction** (`Previews.lrdata`) was researched, found technically viable for catalog-local users, and **rejected by decision O1** (catalog unreachable in the real deployment; direction dropped — details in git history of this doc).
- **The companion plugin** (Lua SDK; export-with-edits proven by existing bridge projects, e.g. Automaat/lightroom-mcp): runs inside the Windows machine's own LR Classic; per job it imports mirror RAWs, **forces the sidecar read (Metadata → Read Metadata from Files — required, import alone loads no edits; O5)**, and exports JPEGs into Afterglow's cache.
- **Decided (2026-07-25, catalog policy tightened in review 2026-07-26): Afterglow manages LR's lifecycle itself** — it launches LR (minimized, `execFile`, **with Afterglow's dedicated render catalog**) when the slideshow starts and closes it when the slideshow ends, so renders happen without anyone thinking about LR. Invariants: **user catalogs are never touched** (a user's own open LR session is left alone and LR jobs defer until it closes — importing or forcing metadata reads there could pollute the catalog or overwrite newer unsaved edits); **only close an instance Afterglow launched** — later superseded in one respect: the plan adds an opt-in setting that gracefully closes a user session on screensaver-triggered launches only; **never force-kill** (graceful window-close request only; if a modal dialog blocks the close, log and leave LR running — catalog safety over tidiness). Jobs queue harmlessly during LR's slow startup; "jobs pending, LR unavailable" is surfaced honestly.
- **Decided (2026-07-25): the plugin is hand-rolled, not third-party.** Rationale: the need is ~200–400 lines of Lua (import-if-needed + `LrExportSession`); the LR Lua SDK is famously stable across versions (decade-old plugins still run — low maintenance); existing bridge plugins are small, young, unaudited codebases (auditing ≈ rewriting) and the family machine should run only our own code. Lives at `apps/lightroom-plugin/` in the monorepo; open-source bridges are reference reading only.
  **IPC is a file-based job queue** (Afterglow writes job files into a watched folder; the plugin exports and writes result files): no TCP listener/attack surface, survives LR restarts, trivially debuggable.
- **Prior art**: PhotoPrism shells out to both CLIs (config-chosen, no per-image routing); Immich declined darktable rendering; nobody does per-image "detect owning editor → render via it". The routing design remains Afterglow's differentiator.

### A5. v0.6 decisions (2026-07-25 session)

| # | Decision |
|---|---|
| Q1 | Initially scope B (+preview-cache); **superseded by O1**: v0.6 = core tiers **+ the LR companion plugin as top priority**, preview-cache removed entirely. Plugin runs in the Windows machine's LR beside the desktop app; a Mac install would be the same separate monorepo app. |
| Q2 | **Accept any extension the editors accept**, with an honest tested/untested split: NEF/CR2/CR3/ARW/DNG are first-class (NEF/ARW render-verified in this investigation; CR2/CR3/DNG live-render verification is a P2 release gate in the plan); the rest accepted but documented as untested. |
| Q3 | **Setting for unedited-RAW handling** with a good default — proposed: `Unedited RAWs: show camera preview (labeled) [default] / only if full-resolution preview / skip`. |
| Q4 | **Detect + exclude cloud/FUSE mounts** as media folders, with a clear message (pCloud reads hang unkillably). |
| Follow-up | **Unrenderable edits** (e.g. crs sidecar, no faithful source): **per-install setting** — show labeled camera preview (default) / skip. |
| Follow-up | **No LR catalog copying** to mirror; parity ideal is RAW+sidecar rendering — achieved for darktable/RT, approximated for LR via the companion plugin. |

### A6. v0.6 architecture (agreed shape)

- `main/raw/detect.ts` — pure edit-location + owning-editor classifier (unit-tested).
- `main/raw/renderers.ts` — `execFile` wrappers: darktable-cli (private configdir, stale-lock cleanup, flatpak/native discovery), rawtherapee-cli, exiftool preview extraction; per-editor availability surfaced in settings.
- Just-in-time ephemeral rendering for a moment-aware look-ahead queue (decided in the 2026-07-26 review session, superseding the earlier persistent-cache shape) — see docs/Plan_v0.6.md P2 for the authoritative contract.
- RAW slides display fresh siblings (freshness includes the RAW's own identity) / JIT renders / labeled stale siblings / embedded previews (per the Q3 and unrenderable-edits settings); `afterglow://` keeps serving browser-decodable source media and adds the render-buffer/preview roots — RAW originals are never served.
- RAW+JPEG pair de-dup: prefer the JPEG sibling (with the plugin, this is also the fresh-LR-edits path). Sibling matching must cover both same-folder siblings **and** the mirror's `JPEG\` subfolder convention (same basename, one level down); a sibling counts as stale when older than any of its edit sidecars (`.xmp`/`.pp3`/`.acr`) or when a sidecar's stored content digest changes — plugin-refresh candidate, shown until the fresh render lands.
- Scanner accepts the broad RAW extension list (Q2) behind this pipeline.
- Feedback ridealong (see `docs/Feedback_v0.6.md`): a "Flag queue" button on the settings screen (+ `Q` accepted there) — today the queue is only reachable mid-show via the `Q` hotkey.

---

## Part B — organizer and code sharing (v0.7)

### B1. Divergence, quantified

core 2,024 / desktop 3,881 / mobile 13,822 src LOC.
No duplicated logic between apps — the divergence is capability: mobile decides-and-applies (SQLite states, staged batches, verified trash); desktop only captures intent (D/E/M/R/N/T flags are capture-only; the queue window can only reveal/open).
Desktop lacks exactly what organizing needs: no file hashing anywhere, no camera make/model extraction (indexer reads only `DateTimeOriginal`/`CreateDate`), no rename/move/date execution.
Already in core and ready for desktop: `PHOTO_STATES`, `DeckSession`, `groupBySimilarity`/`dhash64`, `CullSession`, retrospectives.

### B2. What transfers from mobile

The state machine converging on `done`; durable queues with one confirmed batch apply and at-most-once side effects (trash lifecycle: prepare → reserve → apply → verify — maps to desktop file ops via `shell.trashItem`); decisions reversible until commit; sessions bankable any time.
Not transferable: SQLite-vs-JSON persistence, MediaStore identity, Android intents — correctly stranded behind the `MediaItem` seam.

### B3. The perfectly organized library (decided definition)

1. Every **dated capture photo** lives under the library's **configurable layout template** (Decided O2), default `<root>/<YYYY>/<YYYYMMDD>/` (Q6); mirror keeps `Years/<YYYY>/<MM>/<YYYYMMDD>/` via its own template. Deliberate non-dated collections (person albums, `scans`, `Pre 1989`-style folders) are exempt passthrough folders — conformance checking never queues them for moves.
2. Every filename is `YYYYMMDD_HHMMSS_<CameraModel>.<ext>`; files with no camera metadata (scans, old JPGs) use `YYYYMMDD_HHMMSS.<ext>` — the camera segment simply drops, and that form is conformant; collisions get `_1`, `_2` suffixes; **sidecars rename in lockstep with their raw** (Decided Q7).
3. Capture time is trusted: the **strong signals** (EXIF `DateTimeOriginal`, filename-parsed date, folder date) agree — **any disagreement among them queues for human review; nothing auto-resolves** (Decided Q8). mtime is a fallback only, consulted when no strong signal exists (it usually records processing/copy time, so it never triggers conflicts). Adjudications are recorded once.
4. Adjudicated dates are **written back into EXIF** as well as filename/folder/index (Decided Q9) — via exiftool inside the confirmed batch apply, with its `_original` safety copies (policy for cleaning those up decided at design time).
5. No byte-identical duplicates (SHA-256 over size-bucketed candidates).
6. (Later tiers) no unreviewed near-duplicate bursts; every keeper edited or consciously passed.

### B4. v0.7 scope (Decided Q5: all four rungs)

1. **Exact duplicates** — size-bucket, hash collisions only, grouped review, keep-one-trash-rest as one confirmed batch.
2. **Rename + date normalization** — indexer learns `Make`/`Model`; rename planning is pure core logic; full work-list preview before any file is touched; sidecar lockstep; collision suffixes.
3. **Year-folder moves** — same plan/preview/apply/verify machinery, different target computation.
4. **Similarity culling** — `groupBySimilarity` + `DeckSession` on desktop; needs a desktop decode path for dHash (sharp vs Electron-native decode — design-time choice).

Screensaver flags (N/T/D/M) feed these same queues, closing PLAN's v0.7 organizer-mode loop.

### B5. Monorepo (Decided Q10: confirmed)

Keep the monorepo; grow core with `duplicates.ts` (matching over app-supplied digests), `rename.ts` (derivation + collision + sidecar-lockstep planning), `dates.ts` (multi-signal resolution; mobile's `lib/dates.ts` may partially migrate up).
Desktop consumes first; mobile later (exact dupes and date-fix make sense there too).

---

## Open items

- **O1 — RESOLVED (2026-07-25): preview-cache removed entirely; the LR companion plugin is v0.6's top-priority Lightroom work, Windows-first** (runs in the Windows machine's LR beside the desktop app; a Mac install would be the same separate monorepo app, only if ever needed). Rationale: no stock path exists; the catalog is unreachable (so preview-cache extraction has no fuel); and exported JPEGs cannot be trusted as the LR tier — the audit shows they go stale after re-edits (~2,100 library-wide) and nothing refreshes them automatically.
- **O2 — RESOLVED (2026-07-25): configurable layout template per library**, default `<YYYY>/<YYYYMMDD>`; mirror keeps its month level via its own template.
- **O3 — RESOLVED (2026-07-25): full-library audit complete** (ran locally on home-pc; full CSV at `C:\Users\home\afterglow-tests\audit.csv`). The library in eras:

  | Era | Character |
  |---|---|
  | 1991–2010 + person folders + scans | **JPG-only** (~19k JPGs; scans and compact-camera era) — slideshow-ready as-is; organizer date-resolution matters most here |
  | 2011–2022 | **NEF era** (~37k NEF), XMP-heavy 2019–2021 (5.8k/10.4k/7.6k XMPs) |
  | 2023–2026 | **CR3 era** (mom's Canon switch: 14.4k CR3 and growing) + Tristan's ARW trickle (77–201/yr); `.acr` AI-mask sidecars start 2025 |

  Totals: ~59k RAW, ~160k JPG, ~40k XMP, **zero `.pp3` on mirror** (Tristan's 239 RT edits live only on lenny's onesie drive), zero HEIC, modest video (≤153 MP4/yr).
  **~2,100 stale JPGs** (older than their XMP — showing outdated edits today), concentrated in 2020 (867), 2017 (538), and steady ~100+/yr elsewhere: the plugin's refresh backlog, now quantified.
  v0.6 consequences: CR3 support is non-negotiable (the current-camera format); the RT tier serves lenny's library only for now; the JPG-only eras make the slideshow immediately useful across the whole archive.
- **O4 — Doc corrections when v0.6 planning starts:** PLAN.md's RAW-strategy row and "Lightroom reality" section need rewriting to the O1 outcome (remove the preview-cache tier and the "darktable can best-effort import basic `crs:` settings" claim — the latter is empirically false for darktable-cli); fold this doc into `docs/Plan_v0.6.md`.
- **O5 — RESOLVED (2026-07-26): sidecar portability CONFIRMED by manual test.** CR3 + `.xmp` + `.acr` copied from the Mac to `M:\test`, imported into a fresh catalog in the Windows LR: photos loaded **without** edits; after **Metadata → Read Metadata from Files** the edits loaded and the photos rendered identically across machines. Two consequences: (1) the strategy is viable end-to-end — sidecars are portable and the Windows LR renders faithfully; (2) **the plugin must trigger the read-metadata step itself** after import (and after any sidecar changes on already-imported photos) — a bare import-then-export would render *without* edits. **Prototype plugin verified the full automated chain (2026-07-26):** `photo:readMetadata()` exists, ran without error, and `LrExportSession` exported capped JPEGs with the edits visibly applied (crop included; output eyeballed on both ends).
**Watcher spike (2026-07-26) settled the dialog question:** the metadata-read prompt fires even for fresh imports but its don't-show-again is durable in LR prefs (`doNotShowPrompts` gains `AgLibrary_readMetadata`, `AgLibrary_readMetadata = "read"`) — verified silent-and-instant afterwards; the remaining dialog class is **"AI Updates Recommended"** at export for AI-mask photos (suppression unproven — P4 work item under the zero-dialog hard requirement). SDK plumbing learned: per-job `LrTasks.startAsyncTask` + `withWriteAccessDo` timeout; `LrTasks.pcall` (plain `pcall` breaks on SDK yields); `LrForceInitPlugin = true`; verified-atomic job claims (an unverified claim caused a runaway respawn during the spike).
`readMetadata()` raises a per-photo confirmation dialog — **resolved by the watcher spike below**: the don't-show-again preference suppresses it durably (keys identified), leaving only the AI-updates dialog open.
- **HEIC note:** iPhone photos land on mirror; desktop HEIC stays a documented non-feature for v0.6 (PLAN risk entry unchanged) but the family topology raises its priority for a later release.

## Windows-machine session — outcomes (2026-07-25/26)

All checklist items landed; results are folded into the sections above:

1. **Plugin feasibility (O5): passed** — manual sidecar-portability test plus the prototype plugin's automated import → `readMetadata()` → export chain, output verified faithful on both ends.
2. **Editor installs**: darktable 5.2.1 was already present; RawTherapee 5.12 silently installed; both CLI paths recorded for discovery.
3. **Render tests**: darktable NEF/ARW and RT default/pp3 renders timed and hash-verified (table in A3); RT `-S` skip semantics confirmed.
4. **Library audit (O3)**: complete, all years (table above). Remaining nuance: the audit's stale metric compared JPEGs against `.xmp` only — the implementation's staleness rule covers all edit sidecars, so per-year stale counts are a floor.
5. **Path handling**: Afterglow addresses mirror by drive letter (`M:\Photos\Years\2024`).
6. **Soak test**: running well per tester; first feedback item captured in `docs/Feedback_v0.6.md`. Uptime/memory observations still worth collecting informally before P2 lands.
7. **Remote access**: OpenSSH enabled (`machines/home-pc/` in the machine-setup repo).

## Resume prompt

> The investigation is complete — do not re-run it. Read docs/Plan_v0.6.md (the authoritative plan) and start or continue its phases; consult this file only as the evidence log behind the plan's constraints.
