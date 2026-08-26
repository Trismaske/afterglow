# Tester feedback — the 2026-08-20 round

Round of 2026-08-20 (Tristan, S23 + S10e on shipped m0.8.6): ten items, **F21–F30**, continuing the 2026-07-31 round's numbering.
Settled in an 11-question grilling (2026-08-20/21) with per-item code facts gathered before each decision.
Two late items, **F31–F32** (reported 2026-08-23 on shipped m0.8.7), were settled in the m0.8.8 pre-build grilling (G12–G13 below) and slotted into m0.9.
Two further items, **F33–F34** (reported 2026-08-25 on shipped m0.8.7), are recorded in the m0.9 section with their decisions still **open**: they are settled in the m0.9 pre-build grilling, not here.
Organised into three releases — one subsystem, one device pass, one review cycle each (L1) — all landing **before** the accessibility pass, which moves to m0.9.1 so font scales are measured once the UI stops moving.
This doc spans the releases, so it is named for the span.
Delete it when m0.9 ships.

Each claim carries an evidence tier: **reported** (tester saw it), **read** (established from the code, not yet reproduced), or **measured** (run on a device).
Reproduce an item whose cause is only **read** before you write its fix.

---

## The releases

| | Release | What it is | Items |
|---|---|---|---|
| **m0.8.7** | sources, badges, and the queues | **SHIPPED** — F21 F30, F27's undated-fallback fix, the share-before-edit confirm, and the stats-accuracy sweep; behavior recorded in PLAN.md's shipped entry | — |
| **m0.8.8** | the review deck | **SHIPPED** — distilled record in PLAN.md's shipped entry | F22 F23 F24 F28 F29 |
| **m0.9** | media kinds | Videos and motion photos enter; every kind wears its chip; the scan explains itself; the stage's metadata grows and becomes configurable | F25 F26 · F27 (presentation) · F31 F32 F33 F34 · plus m0.9's previously planned items, unchanged |

**m0.9.1** is the accessibility pass (moved from m0.8.8).

---

## Decisions settled in the grilling (2026-08-20/21)

| # | Decision | Choice | Why |
|---|---|---|---|
| G1 | Round shape | Flesh out all ten first, then pack into three releases, all before accessibility | Two of the ten needed research and design; packing before definition would have guessed the blast radii. Accessibility measures a UI that must first stop moving. |
| G2 | Staged cull vs actions (F21) | **Per-kind suspension**: share and edit stay live on a staged cull; favourite and organize stay suspended | Edit-then-delete-original and share-then-delete are coherent workflows; favouriting or organising a photo you are deleting is not. A "Cull later" second verdict state was rejected: the staged cull already *is* cull-later, and a new state multiplies every predicate. |
| G3 | Zoom architecture (F22) | **C1: region-snapshot native function** (BitmapRegionDecoder, platform API, zero new deps), base decode raised to ≥4096 px | Full-native decode (A) structurally cannot serve 200MP files (~800 MB, texture ceilings); a capped decode (B) permanently concedes deep-zoom parity — rejected outright, sharpness is not negotiable. C1 keeps the device-tuned gesture worklets intact. Escalation ladder pre-registered: raise base → pivot to a tiling library (C2). |
| G4 | Post-decision advance (F23+F24) | **One unified rule**: nearest unreviewed, forward first, backward at the tail; stay put when none remain | Both reports are one rule with a direction preference. Re-decisions in browse mode stop yanking the cursor — a side improvement. |
| G5 | Videos scope (F26) | **Adopt m0.9's singles-first scope unchanged**: playback, keep/cull, queues; no grouping, no embeddings | Display-only would ship unreviewable items STATE_MODEL has no vocabulary for. expo-video (the current Expo player) under the amended dependency-priority rule. |
| G6 | Motion photos (F25) | Scan-time detection (bounded trailer read, new photos only, one-time backfill) + looped muted full-view playback; **zoom always shows the still** | Grid chips need kind known at read time, so detection cannot stay lazy. The still-under-zoom property is structural: the region pipeline (G3) decodes the JPEG primary, which *is* the presentation-timestamp frame. |
| G7 | Playback metadata & settings | **One Autoplay toggle** (default ON) under a "Playback" settings heading, governing motion photos and videos; GIFs excluded, unchanged; no per-kind granularity; no metadata writeback | Researched: the [Android Motion Photo 1.0 spec](https://developer.android.com/media/platform/motion-photo-format) defines **no playback fields** (loop/reverse/speed do not exist in either container; Samsung Gallery's effects are app-side, kept via Save-As export). So there is nothing to respect or write. GIFs have no still/motion dual identity — the animation *is* the artifact — so the toggle does not apply to them. Granular settings are rows earned by a guess (L6 reasoning). |
| G8 | The "random" scan (F27) | **Diagnose, then present**: log capture first; presentation truth fixes ship; trigger redesign deferred pending evidence | The differential design the tester asked for already exists (skip + delta); frequent long corpus scans on the S23 contradict it, so something is broken or the status line lies. The scan already logs its reason every run — read it before touching triggers. |
| G9 | Deck control block (F28) | **Option A**: one weighted verdict row Keep(1.4) · Compare(1) · Not related(1) · Cull(1.4) at ~50 px, chips 44, finish 64→56; "Not related" always present, disabled in singles | Reclaims ~68 px of stage on groups and unifies group/singles row structure. Rejected: three-verdict row (fat-finger adjacency of "keep remaining" beside Cull), stacked half-height middle buttons (under the touch floor). Heights/weights are device-pass tunables; icon+short-label is the pre-registered fallback for the middle pair. |
| G10 | Compare buttons (F29) | **Keep (green, writes) · Cull (red, writes)** + one binary complement prompt for the other photo; whole-table machinery and "is better" deleted; the don't-ask-again preference **rewired** into the prompts | All four outcomes map onto existing write modes (full duel, triage keep, reverse duel, plain cull) — a rewiring, not new machinery, and net-negative code. Green becomes legal under STATE_MODEL rule 2 precisely because the tap now writes. Prompt fires only when the other photo is still unreviewed. |
| G11 | State-editor collapse (F30) | **Dimmed stale facts** during re-reads at both sites (sheet + viewer facts panel) instead of unmounting to "Loading…" | Kills the collapse for both verdict directions and every chained write. The kept-path's delayed render burst is correct queue behavior; the sheet becomes indifferent to it. |
| G12 | The "Camera" pill (F31) | **Exceptions-only + fullscreen-only + metadata placement** (settled 2026-08-23): no folder pill for the primary volume's DCIM/Camera; other folders keep it; annotations (folder + SD) live in the deck stage's day·time metadata badge and the viewer facts panel, never among the action glyphs, never on small squares | The camera roll is the "plain photo" of source-ness — a pill on ~every photo distinguishes nothing (the kind-chips noise rule); folder is a fact, not an action, so it reads wrong in the action cluster. Verified: only the deck stage hydrates it today (DeckScreen.tsx:1576), so the surface set is a placement move, not a retreat. |
| G13 | Scan status cadence (F32) | **Per-photo publish, time-throttled to ~1 s** (settled 2026-08-23), replacing the once-per-200-page update | The cadence was coupled to `SCAN_PAGE_SIZE`, a DB-efficiency constant, not a presentation choice; a time throttle is smooth on slow phases and costs one state update per second on fast ones. Shrinking the page to 20 would pay scan speed for presentation. |

---

## m0.8.7 riders (shipped)

Shipped; the release's distilled record lives in PLAN.md's shipped entry, and the settled behavior in docs/STATE_MODEL.md and the code headers.
The S23 adb scan-log capture retires when the m0.8.7 build (whose in-app diagnostics sink replaces it) lands on the device; m0.9's F27 presentation work reads full-pass reasons from the sink instead.

---

## m0.8.8 — the review deck (shipped)

Shipped 2026-08-26 after the S23 ship-gate pass (three judged reopen rounds).
The distilled record lives in PLAN.md's shipped entry; the settled behavior in the three zoom surfaces' headers, `lib/regionZoom.ts`, `lib/zoomTarget.ts`, and `components/useRegionZoom.ts`.

---

## m0.9 — media kinds

m0.9's previously planned items (per-ABI splits, visual group vet, all-time goal-days stat) are unchanged and not re-decided here.

### F26 · Show videos, muted by default

**Read:** videos are excluded at four independent layers — query filters ([media.ts:156,201,260,378](../apps/mobile/src/lib/media.ts#L156)), the native module's Images-only collections ([MediaStoreActionsModule.kt:277,361,384,449](../apps/mobile/modules/media-store-actions/android/src/main/java/expo/modules/mediastoreactions/MediaStoreActionsModule.kt#L277)), the canonical URI builder ([mediaIdentity.ts:63](../apps/mobile/src/lib/mediaIdentity.ts#L63)), and the missing `READ_MEDIA_VIDEO` permission ([app.json:22-27](../apps/mobile/app.json#L22-L27)).
Core's `MediaKind` already models `'video'` ([types.ts:9](../../packages/core/src/types.ts#L9)); nothing reads it yet.

**Fix (G5):** the full singles-first m0.9 scope.

1. Videos enter the scan as **singles interleaved by capture time**, wearing a kind chip; no grouping, no embeddings.
2. Playback via **expo-video**; **muted by default, always**; a speaker toggle unmutes for the current view only.
3. Keep/cull/trash, share, organize, favourite all apply; whether the edit queue offers videos is decided in-build **(autonomous)**.
4. The device pass must walk a video through **every** queue — the "trash/share/organize just work" claim is assumed until exercised.

### F25 · Show motion photos, muted by default

**Read:** motion photos (JPEG + embedded MP4 trailer) are already scanned as stills; the app has zero container awareness.
Researched: neither container stores playback settings — the [Android Motion Photo 1.0 spec](https://developer.android.com/media/platform/motion-photo-format) is structural only (offsets, semantics, presentation timestamp, frame scores), and Samsung's SEF trailer likewise; Samsung Gallery's boomerang/reverse effects are app-side, kept via Save-As video export.
So playback behavior is the reader's choice, and "respect the metadata" is satisfied by the presentation timestamp — whose frame *is* the JPEG primary the zoom inspects.

**Fix (G6/G7):**

1. **Scan-time detection**: a bounded trailer/XMP read per **new** photo plus a one-time backfill over the corpus, cached in a DB column. (Fallback if the spike measures it slow: detect-on-first-render with the same cache.)
2. Full view behaves like a GIF: **auto-play, muted, looped**, starting when the pager page settles; **zoom always shows the still** at full G3 fidelity.
3. Both containers (Samsung SEF, Google XMP). **The format spike runs first** — a wrong container assumption invalidates the design.
4. Extracted MP4s are run-scoped temp files under cache policy.
5. Loop-vs-once on manual play and a stage "motion" indicator are in-build judgment calls **(autonomous)**.

### Kind chips and the Autoplay setting (G6/G7)

- **Kind chips** — GIF · Motion · Video — join the shared badge vocabulary on every surface; plain photos stay unchipped (chips on ~95% of tiles would be noise). They obey the m0.8.7 hide-badges control.
- **One Autoplay toggle, default ON**, under a **"Playback"** heading in Settings (the heading gives future granularity a home without redesign). Governs motion photos and videos. OFF shows the still/poster with a shared play control.
- **GIFs are excluded and unchanged**: they animate natively everywhere (thumbnails included) at zero cost, and they have no still/photo identity for a toggle to reveal.
- Grid thumbnails for videos and motion photos stay **still**, chip-badged: both animated-thumbnail designs (player farms; Samsung-style sequential clips over recycling cells) are a subsystem, not a spike — parked in PLAN.md's trigger backlog.

### F27 (presentation) · The scan explains itself

The item's report, measured cause, and the fallback fix moved to m0.8.7 (above).
What stays here is the presentation half, in the release where the scan status surfaces are open anyway:

1. No "Scanning…" until the scan survives the skip check ([scanRunner.ts:688-689](../apps/mobile/src/scan/scanRunner.ts#L688-L689) publishes the phase before the skip check runs, so today even a no-op check visibly flashes).
2. A full pass **names its reason** in the status line ("Weekly full check…"); a delta names its size ("Checking 12 new photos…") — a truthful surface can never *feel* like a full walk.
3. The accumulated capture log is read back here: if it names any full-pass reason beyond the weekly reconciliation and the (by then fixed) undated fallback, that reason gets the same treatment.

### F31 · The "Camera" pill reads as an action

**Reported (2026-08-23, m0.8.7):** a "Camera" label sits among the share/favourite/edit/organize glyphs on the deck stage; its purpose and grouping are unclear.
**Read:** it is F19's source-folder annotation (photoBadges.ts:81-84) — source distinction, not media kinds — hydrated **only** on the deck stage (DeckScreen.tsx:1576); no grid or thumbnail wears it.

**Fix (G12):**

1. **Exceptions-only:** no pill for the primary volume's DCIM/Camera; every other folder (WhatsApp, Screenshots, Downloads, SD anything) keeps its pill.
2. **Placement:** the deck stage moves the folder pill and SD marker out of the action cluster into the day·time metadata badge; the fullscreen viewer carries folder (and SD, if missing) in its facts panel.
3. **Small squares stay annotation-free** (already true; now the contract).
4. Lands with m0.9's kind chips — one badge-vocabulary pass.

### F32 · Scan status updates every 200 photos

**Reported (2026-08-23):** not often enough; suggested every 20 photos or every 2.5–5 s.
**Read:** publishing is coupled to `SCAN_PAGE_SIZE = 200` (scanRunner.ts:103, 404-424, 470) — the count only moves once per fetched page, so slow phases freeze the line for many seconds then jump 200.

**Fix (G13):** publish per photo, time-throttled to ~1 s.
Lands with F27's status-line rewrite (above) — cadence and truthful copy touch the status surface once.

### F33 · The metadata badge carries extension and resolution

**Reported (2026-08-25, m0.8.7):** show more about the photo itself in the metadata corner — the file **extension** and the **resolution**.
**Read:** that corner is the deck stage's day·time badge, top-left ([DeckScreen.tsx:1878-1888](../apps/mobile/src/screens/DeckScreen.tsx#L1878-L1888)); the position counter sits top-right ([DeckScreen.tsx:1873-1877](../apps/mobile/src/screens/DeckScreen.tsx#L1873-L1877)) and the badge cluster bottom-left ([DeckScreen.tsx:1889](../apps/mobile/src/screens/DeckScreen.tsx#L1889)).
F31 (above) already moves the folder pill and the SD marker into that same badge, so one pass rewrites it for both items.
**Read:** the values exist at scan time and are discarded — `LoadedPhoto` carries `filename`, `width` and `height` on both read paths ([media.ts:57-73](../apps/mobile/src/lib/media.ts#L57-L73), [media.ts:374-389](../apps/mobile/src/lib/media.ts#L374-L389)) — but the `photos` table stores none of the three ([database.ts:38-90](../apps/mobile/src/db/database.ts#L38-L90)), so `getPhotoFacts` has nothing to select ([store.ts:1451](../apps/mobile/src/db/store.ts#L1451)).

**Shape:** three new `photos` columns (`display_name`, `width`, `height`) written by the scan upsert, plus the render in the metadata badge and in the viewer facts panel.
Schema goes **v22 → v23** — the same bump m0.9's motion-photo kind column already takes, so the release costs testers one destructive reset, not two (pre-v1 policy).

**Not state.** Extension and resolution are file facts, not verdicts, actions or annotations ([STATE_MODEL.md](STATE_MODEL.md), layer 3), so they never join the badge vocabulary and never appear on small squares.
The metadata badge and the viewer facts panel are their only homes.

**Open — for the m0.9 pre-build grilling:**

1. **Resolution as pixels, as megapixels, or both.** `8160 × 4592` is the exact fact a photographer checks; `37 MP` is the comparable one and costs a third of the width; both spend a whole badge line on one item. A middle option: megapixels on the stage, full pixel dimensions in the viewer facts panel, where there is room and the reader has already asked for detail.
2. **Where the extension comes from, and its casing.** The display name and the MIME subtype disagree (`.jpg` vs `.jpeg`; HEIC files report `image/heif`), so one of them must be named as the truth.
3. **The unknown-value rule.** A photo whose dimensions MediaStore did not report needs a rendering; the badge already has the pattern in "Unknown day".

### F34 · Settings choose which overlay items show

**Reported (2026-08-25, m0.8.7):** the stage is getting busy — this release adds kind chips (G6/G7), moves the folder pill and SD marker into the metadata badge (F31), and F33 adds two more facts.
The eye hides everything or nothing.
A Settings section should let each item be turned on or off on its own: source folder, date and time, position in the run, resolution, megapixels, extension.
**Read:** the eye is one durable boolean over the whole badge family ([badgePrefs.ts](../apps/mobile/src/lib/badgePrefs.ts)), mirrored in the deck header ([DeckScreen.tsx:225-241](../apps/mobile/src/screens/DeckScreen.tsx#L225-L241)) and the viewer top bar ([PhotoViewer.tsx:767-771](../apps/mobile/src/components/PhotoViewer.tsx#L767-L771)).
It does **not** reach the metadata badge or the position counter — both render unconditionally ([DeckScreen.tsx:1873-1888](../apps/mobile/src/screens/DeckScreen.tsx#L1873-L1888)).
So "all of them" is two scopes today, not one, and the tester's list spans both.

**The pre-registered trigger has fired.** `badgePrefs.ts` refused per-badge settings on 2026-08-21 as "a settings row earned by a guess", and named the condition for revisiting: *"if the cluster still feels noisy with the toggle in hand, that complaint arrives with evidence."*
This is that complaint, from the tester holding the toggle, against a stage about to gain four more items.
Implementing it rewrites that header.

**Open — for the m0.9 pre-build grilling:**

1. **What the section governs.** The metadata items only, or one combined overlay vocabulary that also splits the badge cluster into per-kind rows. The tester's list is metadata; the eye's scope is badges. Separate keeps two mental models; combined makes the eye a master switch over a settings-defined set.
2. **What the eye means afterwards.** A master hide over whatever the settings enable — the settings say what exists, the eye says whether to show it — or a third state the per-item rows can override.
3. **Whether the choices are per-surface.** The deck stage, the fullscreen viewer and Compare have different room. One shared set is fewer rows and one model; per-surface sets are truer to the complaint, which is about the stage.
4. **Whether megapixels is its own row.** It is a second rendering of resolution, not a second fact, so it is a row only if F33 shows both.
5. **How six-plus switches are carried.** A long switch list is the L6 concern the original refusal was made under, so it is answered rather than assumed away: a chip row or a "Metadata" sub-screen may carry it better than one row per item.
6. **The zoom fail-soft notice joins the redesign** (m0.8.8 close-out, Tristan): the small "Full detail unavailable — image file can't be fully read" chip the zoom overlay shows when the region pipeline rejects a photo (unreadable EXIF, mirrored orientation, unopenable format — shipped in m0.8.8; the deck's `zoomNotice` comment carries the rationale) — review its copy, placement, and whether it belongs to the overlay vocabulary this section defines.

---

## What this round adds to PLAN.md's trigger backlog

- **Animated video/motion thumbnails** (Samsung-style sequential clips or a transcode-preview pipeline). Trigger: missing them once m0.9's looping full-view playback ships.
- **Loop/boomerang export as a new video file** (the only honest "make it loop" — no container stores playback settings). Trigger: a user asks.
- **Share-dispatch-with-pending-edit confirm** ships in m0.8.7 (above), so it is *not* parked.

## Cross-release dependencies

1. **G3 (m0.8.8) → G6 (m0.9).** Motion-photo "zoom shows the still" relies on the region pipeline decoding the JPEG primary. Ship order already satisfies it.
2. **m0.8.7's type-scale/token pass → F28 (m0.8.8).** The deck relayout consumes the tokens that pass establishes; landing F28 first would re-touch the deck twice.
3. **m0.8.7's badge vocabulary + hide control → kind chips (m0.9).** The chips join an existing, toggleable vocabulary rather than inventing one.
4. **F31 → F33 → F34, all inside m0.9.** The folder pill's move into the metadata badge, the two new facts, and per-item visibility all rewrite the same badge and the same preference layer. They land as one pass, in that order — F34 cannot name its rows until F33 settles what the badge shows.
