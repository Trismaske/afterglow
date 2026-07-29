# Investigation — desktop v0.6 evidence log

*The evidence behind `docs/Plan_v0.6.md`'s verified constraints. The investigation is **complete — never re-run it**; consult this file when a constraint needs its source. Decision history lives in git; v0.7 organizer scope lives in PLAN.md. Delete this file once v0.6 ships.*

## Family library topology (verified 2026-07-25)

```
Mom's Mac (LR catalog + Previews.lrdata — private)      Tristan's laptop lenny (darktable 5.6 flatpak; RT edits historically)
        │ copies RAW + crs.xmp (+ sometimes JPEG)               │ /mnt/onesie NVMe: 16k ARW, 2k NEF, 3.4k DNG, 207 .xmp, 239 .pp3
        ▼                                                        ▼ uploads
   Family Windows machine "home-pc" (on the tailnet)  ◀─── phones (Android + iPhone)
   ├─ 16 TB "mirror" drive = central store, SMB-shared, mirrored to pCloud
   │   └─ Photos/Years/<YYYY>/<MM>/<YYYYMMDD>/… (plus stray day-under-year folders)
   ├─ Lightroom Classic 13.4, darktable 5.2.1, RawTherapee 5.12 (paths below)
   └─ Afterglow v0.5 soak test running — the app's primary deployment target
```

- pCloud is **backup only**; never index/render from it — FUSE reads hang unkillably in D-state (verified). Basis for the FUSE/network-mount exclusion.
- Afterglow addresses mirror by drive letter (`M:\Photos\Years\2024`); SSH access per the private machine-setup repo (`machines/home-pc/`).
- `M:\Photos\Years` spans 1991–2026 plus deliberate non-dated folders (person albums, `scans`, `Pre 1989/1991/2000`) — the organizer's conformance model must treat those as legitimate.

**Full-library audit (2026-07-25; CSV at `C:\Users\home\afterglow-tests\audit.csv`):**

| Era | Character |
|---|---|
| 1991–2010 + person folders + scans | **JPG-only** (~19k JPGs) — slideshow-ready as-is |
| 2011–2022 | **NEF era** (~37k NEF), XMP-heavy 2019–2021 (5.8k/10.4k/7.6k XMPs) |
| 2023–2026 | **CR3 era** (mom's Canon switch: 14.4k CR3 and growing) + ARW trickle; `.acr` AI-mask sidecars start 2025 |

Totals: ~59k RAW, ~160k JPG, ~40k XMP, zero `.pp3` on mirror (the 239 RT edits live on lenny), no HEIC in this tree, modest video. **~2,100 stale JPGs** (older than their XMP), concentrated 2020 (867) and 2017 (538) — the head of the export-inventory work list. 2026 sample: 870 CR3 + 545 `crs:` XMPs + 392 `.acr` + 852 JPGs, the JPGs living in **`JPEG\` subfolders inside day folders** (a depth-limited count misses them — verified mistake). Separate tree `M:\Backups\Phones`: 5,967 HEIC + 7,758 JPG + 2,914 MOV (1,486 same-basename HEIC+JPG pairs on one phone) — HEIC is a real requirement and its Resilio Sync feed died 2022-12-04 (replacement tracked in `docs/TODO.md`).

The `.acr` files are Adobe Camera Raw AI-mask sidecars (verified: ~19 KB+, `ACR`+`CR3` header, single-channel JPEG-XL-compressed mask tiles — no extractable preview). See the 2026-07-29 spike: they contribute **nothing to rendered pixels**.

## Tooling facts (lenny, empirical)

- darktable **5.6.0 flatpak only** (`org.darktable.Darktable`); no usable OpenCL device → CPU renders. RawTherapee not installed (flathub `com.rawtherapee.RawTherapee` when needed).
- exiftool 12.40, dcraw 9.28; ImageMagick's RAW delegate broken. dcraw rejected as a fallback: slower than darktable-cli and never applies edits.

## Detection rules (verified per-file evidence)

1. `X.ext.xmp` with `xmlns:darktable=` and `darktable:history_end > 0` → darktable (real sidecar verified). `xmp:Rating="-1"` marks darktable-rejected shots.
2. `X.ext.pp3` (INI, `[Version] AppVersion=`) → RawTherapee.
3. `X.xmp` with `crs:HasSettings="True"` → Lightroom.
4. Else embedded XMP (`exiftool -b -XMP`) scanned for edit namespaces — mere XMP presence is meaningless (DJI DNGs carry 8 KB of factory XMP with no edit namespace, verified).
5. Else: no edits.

Caveat accepted: an RT user configured "cache only" (non-default) leaves no `.pp3` and is invisible. Multi-editor conflict resolution is the plan's newest-wins rule, not this list's order.

## Renderer invocations and timings

**darktable-cli** (working invocation on lenny):

```
flatpak run --filesystem=<dir-if-outside-host-scope> --command=darktable-cli org.darktable.Darktable \
  IN.raw [SIDECAR.xmp] OUT.jpg --width 2560 --height 1440 \
  --core --configdir <private-dir> --library :memory: \
  --conf plugins/imageio/format/jpeg/quality=80
```

- Edits genuinely applied (13.9 % RMSE vs default render). **Private `--configdir` mandatory**: the default deadlocks on a stale-lock check that can never pass inside flatpak's PID namespace; crashes brick a configdir until `.lock` files are deleted.
- **Serialize renders**: shared configdir → second instance aborts; separate configdirs → heavy contention (6.2 s solo vs 19.8 s parallel).
- lenny timings: NEF 12 MP ≈ 2.3 s; ARW 24 MP ≈ 5.9 s; size capping saves little.
- **crs XMPs silently ignored** (RMSE 0 vs no-sidecar render — verified). darktable's partial LR import is GUI-only; no CLI path renders crs.

**rawtherapee-cli**: `rawtherapee-cli -o OUT -S -j80 -Y -c IN`; `-S` renders only-if-sidecar — verified on home-pc: a sidecar-less file exits with an explicit "no sidecar procparams found" error and no output. With `-p` pp3 the output hash differs from default (edits applied). CR3 support good since RT 5.10.

**Windows-native timings (home-pc: i5-11400, Intel UHD 730, inputs from mechanical `M:`):**

| Test | Time | Output |
|---|---|---|
| darktable-cli NEF 24 MP, capped 2560×1440 | 3.1–3.2 s | 2154×1440 |
| darktable-cli NEF 24 MP, full-res | 3.9 s | 6032×4032 |
| darktable-cli ARW 24 MP + sidecar, capped | 7.4 s (7.7 s default; hashes differ — edits applied) | 2154×1440 |
| rawtherapee-cli NEF 24 MP, default / with pp3 | 5.8 / 4.3 s | 6024×4024 |

**Windows wrapper quirks (verified):** darktable-cli's output-filename template engine **eats backslashes** — pass the output path with forward slashes. Discovery paths: `C:\Program Files\darktable\bin\darktable-cli.exe`; RawTherapee is **version-directory'd** (`C:\Program Files\RawTherapee\5.12\rawtherapee-cli.exe`) — glob it.

**Embedded previews** — `exiftool -b -JpgFromRaw`/`-PreviewImage`, ~0.1 s (~40× faster than rendering):

| Format | Best embedded preview |
|---|---|
| NEF | `JpgFromRaw` full-res (4288×2848 verified) |
| CR2 | `JpgFromRaw` full-res (research) |
| CR3 | **1620×1080 only** (research) |
| ARW | `PreviewImage` 1616×1080 (verified); newer bodies add full-size `JpgFromRaw` — try first |
| DNG (DJI) | 960×544 (verified) |

## Lightroom facts

- **No headless Lightroom, ever**: no CLI, no COM/AppleScript, no headless Camera Raw; cloud API partner-gated. Smart Previews are pixel-unedited; DNG Converter embeds default renders only; preview-cache extraction was researched and rejected (catalog unreachable in the real deployment).
- **Sidecar portability confirmed by manual test (O5, 2026-07-26)**: CR3 + `.xmp` + `.acr` copied Mac → Windows, imported into a fresh catalog: photos load **without** edits; after **Metadata → Read Metadata from Files** they render identically across machines. Hence the plugin must call `photo:readMetadata()` after import — a bare import-then-export renders *without* edits.
- Prior art: PhotoPrism shells out to both CLIs with no per-image routing; Immich declined darktable rendering. Per-image owner-editor routing has no precedent found — Afterglow's differentiator.

## Companion-plugin spikes (home-pc, prototype `AfterglowProto.lrplugin`)

### 2026-07-26 — feasibility and SDK plumbing

- Automated chain proven: `photo:readMetadata()` exists, runs silently once suppressed, and `LrExportSession` exports capped JPEGs with edits visibly applied (crop included).
- **Metadata-read prompt** fires even for fresh imports; durably suppressed via LR prefs: `doNotShowPrompts` contains `AgLibrary_readMetadata` with `AgLibrary_readMetadata = "read"` (verified: first call blocked, every later call silent and instant).
- SDK plumbing learned the hard way: fresh `LrTasks.startAsyncTask` per job **and** `{ timeout }` on `withWriteAccessDo`; `LrTasks.pcall`, never plain `pcall`, around anything that yields; `LrForceInitPlugin = true` or the init script may never run; **an unverified job-claim rename caused a runaway respawn loop** — claims must be verified (rename confirmed) and de-duplicated in-process.

### 2026-07-29 — pre-build spike: throughput, dialogs, mask fidelity

Run fully over SSH (LR launched via a `schtasks /it` interactive task; prototype v0.3 auto-starts its watcher via `LrInitPlugin` + `LrForceInitPlugin` — no menu interaction). Artifacts on home-pc: `lr-jobs2\*.result.txt` (timings), `spike2-out\` (exports), plugin v0.3 source.

**Throughput** (import → `readMetadata` → export at 2560 px, fresh CR3 imports from local disk):

| Case | Time |
|---|---|
| LR process start → watcher operational | ~12 s |
| First photo after launch (cold) | 9.6 s |
| Warm single photo | 5.4–6.4 s |
| Batch of 3 in one job | 14.8 s (~4.9 s/photo — LR parallelizes renders internally; batching moment members into one job pays) |

**Dialog suppression for fresh AI-mask imports — the previously unproven case — verified**: with `AIUpdateWarning_shouldUpdateAffectedPhotos = true` already in prefs, a never-imported CR3+`.xmp`+`.acr` exported unattended, zero dialogs, in 5.9 s. Eight jobs / ten photos in the session; no dialog ever appeared.

**Mask fidelity chain (RMSE via ImageMagick, same photo `_5M36828`, heavy masking — 56 KB of its 70 KB XMP is `crs:MaskGroupBasedCorrections`):**

| Comparison | RMSE | Meaning |
|---|---|---|
| unattended export vs attended-spike export (same inputs) | 0 | unattended = attended, pixel-identical |
| export without `.acr` vs with `.acr` | 0 | `.acr` contributes **zero rendered pixels** |
| export with mask block stripped from XMP vs full XMP | 1372 (2.1 %) | mask corrections **do render**, from XMP alone |

Net: AI-mask photos render faithfully and unattended from RAW + XMP; `.acr` matters only as an edit-change signal. No mask exclusion, no fallback setting, no attended workflow.

**Close-path evidence**: two `CloseMainWindow()` requests over ~75 s did not exit an idle LR; the spike instance was force-closed (safe — disposable catalog). The real plugin phase must design a working graceful-close mechanism; WM_CLOSE to the main window is not it.

**Spike catalog hygiene**: the 2026-07-26 catalog lived under `M:\test\Catalog` and accumulated pCloud "[conflicted]" lock/WAL litter — LR catalogs must never live on the mirrored drive; the 2026-07-29 run used a local copy under `C:\Users\home\afterglow-tests\spike2-catalog\`. Reinforces the plan's local, disposable render catalog.

## Resume prompt

> The investigation is complete — do not re-run it. Read docs/Plan_v0.6.md (the authoritative plan) and start or continue its phases; consult this file only as the evidence log behind the plan's constraints.
