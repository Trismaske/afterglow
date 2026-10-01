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

**The m0.9 pre-build grilling ran 2026-08-26 (23 questions) and settled every open item below**; the decisions and the build live in [docs/Plan_m0.9.md](Plan_m0.9.md) (decision table M1–M23).
Supersessions from that grilling: G6's "looped" playback → play-once default under per-kind Once · Loop · Off rows (replacing G7's single Autoplay toggle); the animated-thumbnail parking (below) reversed — the subsystem is committed to m0.9 and **the L1 one-subsystem rule is deliberately dropped for this release**; per-ABI splits move to pre-v1 and the all-time goal-days stat to the event-log round (the visual group vet stays).
The item sections below remain as the reports of record; their "Open" lists are settled in the plan.

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

### F35 · The edit queue shows no state

**Reported (2026-09-25, the phase-6 build on the S23):** the edit queue's rows say nothing about a photo's decisions.
**Read:** every queue renders a bare thumbnail — the edit and favourites rows (`EditQueueScreen`, `FavouritesQueueScreen`) and the share and organize grid cells (`QueueGrid`) — while the grids, History and the Timeline cards wear StateDots.
**Fix (landed 2026-09-25, phase 7):** the four queues wear the same dots a grid cell wears, in `photoBadges` order; a row's own verb (Edit here, Add to favourites) stays its text.
Widened from the edit queue to all four queues by the one-shape rule (STATE_MODEL.md); accepted at the phase 7 close.

### F36 · To-edit and edited look alike

**Reported (2026-09-25):** the favourite control tells "to favourite" from "favourited"; the edit control does not.
**Read:** `ActionChip` flips favourite's glyph (heart-outline → heart) when the action waits, and organize's and share's likewise; edit drew `pencil` both ways, so only its hue moved.
**Fix (landed with the phase 6 close, 2026-09-25):** edit's idle glyph is `pencil-outline`, its waiting glyph `pencil`.
The tester judges it at phase 7's pass.

### F37 · Samsung Gallery is not offered for a video

**Reported (2026-09-25):** "View only" on a video never lists Samsung Gallery.
**Read (measured on the S23, 2026-09-25, `cmd package query-activities`):** for `VIEW video/mp4` Android lists Google Photos, MiXplorer and Samsung Video Player; for `EDIT video/mp4` Google Photos alone. Samsung Gallery registers for neither — it registers `VIEW image/*` only, which is the routing the plan's device-pass item 4 records.
**Probed (S23 2026-09-25, S10e 2026-09-28):** Gallery's main activity only brings its task forward; its EXTERNAL viewer (`com.samsung.android.gallery.app.activity.external.GalleryExternalActivity`) declares a VIEW filter for `content` video without the DEFAULT category — invisible to every chooser, reachable by name — and opens the clip in Gallery's own player with its edit and favourite controls.
**Fix (landed 2026-09-28, phase 7):** a video's "View only" launches that viewer by name first and falls back to the ordinary chooser where Gallery is absent; the subtitle is short again (the explanatory sentence tried on 2026-09-25 was too long, Tristan).
Verified on the S10e: the queue's "View only" on the seeded clip resumed Gallery's external viewer.

### F38 · The seek track lifts and narrows when the chrome shows

**Reported (2026-09-25, the phase-7 build on the S23):** bringing up the video chrome, the progress bar rises from the bottom edge and ends up narrower than the stage.
**Read:** the expanded track was inset by the thumb's radius at both ends and raised by it, so the thumb could ride the track whole; the thin form was full width on the edge, so the two read as different bars.
**Fix (landed 2026-09-25; the thumb reshaped 2026-09-27):** the expanded track is the thin line grown in place — full width, its bottom on the edge — and the thumb is a half disc standing on the line, its flat side on the track's top edge, no rim, its centre clamped a radius in from either end (a whole dot touching the line only at its bottom read wrong). The fill's front is the dome's front the whole way (2026-09-28: the two had met only at the end). The stage's bottom row of buttons and badges sits just above the dome.

### F39 · A looping motion photo never shows its chosen frame

**Reported (2026-09-25):** with Motion photos set to Loop there is no way to see the still inside the motion photo; pausing shows the paused frame, which is right for a pause.
**Read:** the still shows only while no play is underway (`restsOnStill`): a Once play returns to it at the end, a Loop never ends. The tester's candidates: a Stop control, a hold-to-peek, a shortcut to the Off mode.
**Fix (Tristan 2026-09-25, both; landed the same day):** a STOP control in the playback chrome, bottom-left while a play is underway — it rewinds and rests the clip on the still (a video on its first frame), and Play starts it over — and HOLD-TO-PEEK on the page: a finger held 350 ms on a motion photo shows the still over the playing clip until it lifts. The peek is the page's own press: a pinch or a page swipe claiming the touch ends it, a plain photo takes no long press.

### F40 · Rapid culls cross into the next group

**Reported (2026-09-25, recording `Screen_Recording_20260925_214553_Afterglow.mp4`):** tapping Cull as fast as possible through a group of ten "breaks things"; three tries to reproduce.
**Read (the recording, frame by frame; reproduced on the S10e with a scripted tap every 250 ms on a seeded 24-shot group):** two faults. Within the unit, a cull's jump to the next pending photo is commanded while the previous jump still animates, and the superseded jump's momentum end then snapped the cursor BACK onto the photo just culled — whose next tap read as the undo of the same verdict, leaving it unreviewed and the deck jumping about (the recording's 1 → 4 → 5 → 9 → 2). At the unit's end, the tap already in flight when the finished group advanced landed on the next group's first photo. The sink holds no fault for the minute: every write was correct, two addressed the wrong photo.
**Fix (landed 2026-09-25/27):** while a commanded jump is in flight only its own arrival moves the cursor, so a superseded jump's momentum end is ignored; and the verdict controls (and Not related, Keep remaining) are inert for 600 ms after a new unit goes LIVE — the pager's own 400 ms swipe settle, made longer for taps — with a decision arriving inside it dropped (codex: a settle timed from the swap would elapse during a slow load). A tap that arrives while a write is in flight is still dropped: at a tap every 250 ms about half land, each on the photo the deck is moving to.

### F41 · The edit chip cannot un-flag a kept photo

**Reported (2026-09-28):** on a kept photo the Edit chip would not deselect; un-keeping first was the only way. On a staged cull it deselected fine.
**Read:** the chip's press took the decided-photo path (`decideCurrent('to_edit')`, which re-runs the to-edit cycle) for every verdict but a staged cull; only the cull branch used the flag toggle.
**Fix (landed 2026-09-28):** a flagged photo un-flags whatever its verdict; an unflagged one keeps the decided-photo path.

### F42 · The stage's badge pill overflows

**Reported (2026-09-28, screenshot):** a kept video with edit and favourite queued drew its three badges below the pill, outside its backdrop, with only the Video chip inside.
**Read (reproduced on the S10e):** the cluster wrapped with `wrap-reverse`, and the second line rendered outside the pill's box.
**Fix (landed 2026-09-28):** the cluster is two rows by construction — the glyph badges, then the kind chip — and never a wrapped line (plain wrap sized the pill to one line as well); the pill, anchored at its bottom, grows upward.

### F43 · Inspection dots run past a row thumbnail

**Reported (2026-09-28, screenshot):** in the favourites queue a photo carrying every action drew its dots past the 52 dp thumbnail's edge.
**Fix (landed 2026-09-28):** the dots row wraps inside its host, and the favourites and edit rows bound it to the thumbnail's width; the details overlay's duration line says "Duration", not "Runs" (the same round).

### F44 · Photos deleted in Gallery linger in Everything as empty thumbnails

**Reported (2026-09-30, S23, phase-8 pass):** four photos deleted in Gallery stayed in their Everything cards as empty thumbnails, and the group still opened.
**Read (sink + filesystem, measured):** Samsung Gallery's Recycle bin is NOT MediaStore's trash. The four files were MOVED to `/sdcard/Android/.Trash/com.sec.android.gallery3d/uuid/<stamp>/storage/emulated/0/DCIM/Camera/.!%#@$/<name>.jpg` under a `.nomedia` marker, and their MediaStore rows were deleted outright (a `MATCH_TRASHED` query finds no `is_trashed = 1` row) — so the delta saw `0 trashed` and only the volume count falling by four "with no trace", which by design sends the scan to a FULL PASS to reconcile: 4 min 35 s on the 33k library (`21:41:20` → `21:45:58 reconciled 4 externally removed items`), during which the rows stayed present and the cards rendered them. The reconciliation then published on the membership signal and Everything dropped them without a hand (screenshot at 23:47, the group opening normally). A restore from Gallery's bin re-inserts the file as a new MediaStore row; the next delta lands it as a new item — phase 9 makes such a return ADOPT its tombstone (re-keyed to the new id, the verdict back; decided 2026-10-01).
**The gap is the pass's length, not the publish:** a loss with no trace needs only an ids-only enumeration to name the missing rows (seconds), not the full pass with its windows and facts. Scheduled for phase 9's scan work (docs/Plan_m0.9.md, phase 9: the loss reconciliation).

### F45 · The deck dies after an eject lands it on the ejected photo

**Reported (2026-10-01, S10e, phase-8 pass; three crashes, the last on a screen recording):** eject a group's pending photo; the deck advances to that photo's own singles unit; un-mark "not related" there (or wait for the next refresh) and the process dies with React's "Maximum update depth exceeded".
**Read (dev build with a per-render trace):** a passive-effect loop in the deck. The un-mark's targeted rescan regroups the photo, so the deck's own singles read returns no rows; the empty-scope exit asks the timeline where to go, and the pending snapshot — not yet refreshed — still lists that run with the photo as pending, so the resolver names the run itself (a matching unit with pending work is a destination by design, codex r4 of m0.8.5). The advance replaced the unit object with an equal one, which re-made `range` and `unitRef`, the exit effect re-ran on them, and the deck advanced into itself until the limit.
**Fix (landed 2026-10-01):** an advance to the unit the deck is already on is no advance — the unit state keeps its object, the params stay, and the exit effect waits for the provider's refresh to move the timeline; `unitRef` is keyed on the range's values. The recipe passed three times on the dev build after the fix. The "advanced onto the ejected photo" itself is the designed advance after a dissolved pair and stands.

---

## What this round adds to PLAN.md's trigger backlog

- **Video pinch-zoom** (deferred from m0.9's grilling with the mechanism corrected — a GPU surface transform, never per-frame decode). Trigger: a tester asks while reviewing real videos.
- **Loop/boomerang export as a new video file** (the only honest "make it loop" — no container stores playback settings). Trigger: a user asks.
- **Animated video/motion thumbnails** were parked here originally; the m0.9 pre-build grilling reversed that — the subsystem is committed to m0.9.
- **Share-dispatch-with-pending-edit confirm** ships in m0.8.7 (above), so it is *not* parked.

## Cross-release dependencies

1. **G3 (m0.8.8) → G6 (m0.9).** Motion-photo "zoom shows the still" relies on the region pipeline decoding the JPEG primary. Ship order already satisfies it.
2. **m0.8.7's type-scale/token pass → F28 (m0.8.8).** The deck relayout consumes the tokens that pass establishes; landing F28 first would re-touch the deck twice.
3. **m0.8.7's badge vocabulary + hide control → kind chips (m0.9).** The chips join an existing, toggleable vocabulary rather than inventing one.
4. **F31 → F33 → F34, all inside m0.9.** The folder pill's move into the metadata badge, the two new facts, and per-item visibility all rewrite the same badge and the same preference layer. They land as one pass, in that order — F34 cannot name its rows until F33 settles what the badge shows.
