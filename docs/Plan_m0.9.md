# Plan — m0.9: media kinds

**Status:** ready to build.
Every design gate is cleared: the F21–F30 grilling settled G5–G8 (2026-08-20/21, [Feedback_m0.8.7-m0.9.md](Feedback_m0.8.7-m0.9.md)), and the m0.9 pre-build grilling (2026-08-26, 23 questions) settled everything else — the full decision record is the appendix.
**Scope source:** the feedback doc's m0.9 section (F25 F26 · F27 presentation · F31 F32 F33 F34), plus the m0.8.8-ship additions vetted in the grilling: the ZoomSurface consolidation, the Everything livelock, the URI/cache pass, the image-cache requirement, the pixel-honesty spike, the animated-thumbnail subsystem, and the visual group vet.
**The one-subsystem rule (L1) is deliberately dropped for this release** — decided in the grilling (M16); this release is the exception, not the new norm.
**Out of scope, moved:** per-ABI APK splits → pre-v1 (M2); the all-time goal-days stat → the event-log design round, which gains goal-crossing events as a member (M3); video pinch-zoom → PLAN.md trigger backlog with hedges (M6); videos in Compare → same trigger (M7).
**Versioning:** app.json `version` 0.8.8 → 0.9.0, `android.versionCode` 15 → 16, package.json 0.8.8 → 0.9.0; tag `mobile-m0.9`.
**Schema:** v22 → **v23, one bump, DDL finalized late** — after the animated-thumbnail design doc lands, so any cache table rides the same reset (M18). Phases may build against a provisional v23 (pre-v1 destructive policy; dev devices reset freely).
Delete this doc when the release ships; durable behavior distills into PLAN.md, STATE_MODEL.md, and code headers; the feedback doc prunes per its own instruction.

---

## The media model (settled; the vocabulary every phase builds against)

- **Photos, videos, motion photos, GIFs.** Motion photos are **both**: a photo while the still is in play (zoom pipeline on the JPEG primary, grouping, photo metadata) and a video while playing (the same playback machinery and chrome as videos). GIFs are photos — native animation everywhere, no chrome, no controls (M14).
- **Kind truth:** MIME classifies (chips, playback routing); the display name renders (extension, uppercase, no dot — JPG, HEIC, DNG, MP4). Name and MIME may disagree; each layer is honest about what it claims (M15).
- **Playback settings:** a Settings **Playback** section with per-kind rows — **Videos: Once · Loop · Off** and **Motion photos: Once · Loop · Off**, both defaulting **Once** (play muted on page settle; motion rests on the chosen-frame still, video rests on its last frame). Off = poster/still with a play control. GIFs excluded (M5, M14; supersedes G6's "looped" and G7's single toggle).
- **Chrome, two tiers** (M4, revised by M24): deck stage = minimal fixed chrome — speaker toggle, thin non-interactive progress hairline, play/replay control; the deck's **fullscreen (expanded) stage** = full transport (scrubber, pause, speaker) — the tier the retired viewer used to own. All chrome permanently mounted and prop-gated (the m0.8.8 host-view rule).
- **Zoom:** motion photos zoom the still at full fidelity (G6, structural). **Pinch is inert on video pages** on all three surfaces — the pager keeps the gesture (M6).
- **Compare:** videos are excluded — the Compare button disables on a video item (F28's disabled pattern), the picker never offers them; motion photos compare as photos (M7).
- **Actions:** videos are compatible with **every** action — edit, favourite, organize, share — and the full verdict set; F21 per-kind suspension unchanged (M8). One implementation flag: the edit-detection hash path must not hash video bytes wholesale (cost check, autonomous).
- **Copy:** "**items**" replaces "photos" wherever a count or aggregate can include videos; "photos" survives only where the referent is photos-only. A deliberate inventory sweep over every user-facing string, with pinned tests and gate selectors updated in the same pass; the Settings source heading and goal copy are classified with the inventory in hand, not mechanically (M9).

## Phases

Each phase lands with its tests and doc updates before the next starts.
No **(autonomous)** flags remain from the grilling; new judgment calls made mid-build are numbered in the appendix as they happen, for vetting at the close-out grilling.
Sequencing rationale: consolidation first (everything else touches those surfaces), the viewer retirement immediately after it (M24 — so no later phase builds on a surface scheduled for deletion), measurement spikes early (they steer two phases), the URI/cache pass before playback and thumbnails (both build on it), v23 finalizes at the animated-thumbnail design doc.

### Phase 1 — the media stage (TODO 11: ZoomSurface consolidation)

**Status: COMPLETE (2026-08-27).** The three surfaces run on one `MediaStage` (the deck's drivers moved verbatim — canonicality in the component header), net-negative code, Compare drift-fixed; one codex round returned zero findings; the UI gate passed; the S23 device leg produced four findings, all fixed and re-verified (instant two-finger pinch claim; the hidden-pane patch gate after the paired-decode/trim-storm evidence; clear-on-hide replacing the stale-slot refinement; union-of-pair pan bounds replacing the stage-rect clamp — `pairPanBounds`, unit-pinned). The drag-capture pinch residual is parked in TODO with its fix shape. 937 tests. The spike concluded (memo below). The phase's working design doc retired per its own lifecycle; its durable contract lives in MediaStage.tsx's header.

- Opens with a **directed design pass** (design-doc process, sized to need) whose brief is *maximal* consolidation: DeckScreen's overlay, PhotoViewer, and CompareScreen each carry a near-copy of the zoom machinery (transform shared values, `zoomTouchFrame` wiring, the overlay stack URI → base → patch slots → fail-soft notice, a `useRegionZoom` instance, styles). The candidate boundary is a **media stage**, not just a zoom surface: this release's overlay rewrite (phase 7) and playback slots (phase 6) land in the same trees — the design pass decides what honestly consolidates beyond the three zoom copies (M10).
- Constraints carried from m0.8.8: gesture configs and callbacks INLINE in the shared file (the de-workletization crash class); arbitration parameterized (pager-negotiating vs single-driver); pan bounds and chrome as parameters.
- A refactor of live behavior: lands with equivalence tests (the existing gesture scenario suite runs unchanged) and its own targeted device leg — all three surfaces walked at depth before any playback code exists.
- **The pixel-honesty spike — RUN AND CONCLUDED (2026-08-27): routes to m0.9.1.** The memo:
  1. **Mechanism A (byte-budgeted nearest integer pre-scale of delivered patches) is structurally dead**, measured: deep-zoom patches on the S23 are 42–91 MB (margin-dominated via the 3× axis cap), so any sane byte budget computes factor 1 — the spike build rendered pixel-identically to bilinear (blockiness metric 0.337–0.345 on both sides of the A/B; the tester independently saw no difference). And no budget rescues it: a 2–4× pre-scale is re-bilineared by the residual 10–40× magnification back into gradients — honest blocks need pre-scale ≈ the FULL magnification, i.e. 100–1600× the bytes. Not a tuning problem; the wrong mechanism.
  2. **Mechanism B (a small custom native view drawing the SharedRef bitmaps with an unfiltered paint) is the credible path**: nearest sampling holds under ancestor canvas transforms (verify the offscreen-layer caveat — an opacity/render-to-texture layer between the transform and the draw would re-bilinear it), engaged past a threshold scale, integrated into the always-mounted slot system. A new native view + three-surface integration + device rounds = over the contained-build bar.
  3. **Disposition per M13's own gate: m0.9.1**, where it lands alongside the accessibility pass with this memo as its design input; the ≤12 MP tier (base-served) needs the same treatment there. The spike code is reverted; nothing ships in m0.9.

### Phase 2 — the viewer retires into the deck (M24)

**Status: BUILT (2026-08-28) — device pass rounds 1 and 2 done, all findings fixed; awaiting the confirming pass.**
Round-1 findings → fixes: (1) Compare's disabled state had no disabled LOOK (RN styles nothing automatically; the button now takes the shared dead style); (2) **acting on a photo could swap it off the stage** — the anchor re-stamped from a stale cursor index when a write reordered the rows (guarded to real cursor changes), and the contract is now stronger: **the current photo never leaves the deck under you** — a row its own action removes from the list is held in place until you navigate away (`shownListRows` pin); (3) the queues' long-press door was invisible — both selection queues say "Long-press a photo to open it"; (4+5) immersive reworked to the Gallery look — edge-to-edge black, no frame, OS status bar hidden — and the LayoutAnimation reflow (which read as no animation: the FlatList's page content snaps regardless) replaced by a dip-to-black that masks the flip.
Round-2 findings → fixes: the History chip chaos had two roots — the list-mode Edit chip rode the unit-browse re-decide fork (kept + fresh cycle every tap, never off; now a flag toggle, the state editor's row semantics) and list verdict taps read stale row state until the async re-resolve landed (an optimistic per-photo override shows the write instantly, cleared per-id when the photo's own fresh row returns); the immersive "second flash" was the native header removal and status-bar hide reflowing the stage after the reveal — the flip holds at black while both land (frame-verified: one monotonic reveal); the long-press hint joins the queue subtitle line. Confirmed fixed by the tester in round 2: Compare's disabled look, the anchor swap. All seven decisions implemented; `PhotoViewer.tsx`, `StateEditorSheet.tsx`, `QueueViewer.tsx` deleted with a full sole-consumer sweep (`editorOffer` and dead `MediaStage` props removed with them — appendix); every host rewired; the docs/comments sweep done (AGENTS.md maps, STATE_MODEL, the gate doc + script, README); gate 33/33 on device; 940 tests; net −826 lines.

**Decision (Tristan, 2026-08-27, at the phase-1 close): the deck becomes the ONE review-and-browse surface.**
Post-consolidation the viewer was a thin shell whose remaining roles the deck can absorb; sequenced HERE — while the phase-1 deck work is fresh — so no later phase touches a doomed surface, and every phase after this one builds in exactly one place.
The design pass and six-question grilling ran 2026-08-27/28; every decision below is settled.

**Deletion targets: `PhotoViewer.tsx`, `StateEditorSheet.tsx`, `QueueViewer.tsx`.**
The gap analysis proved the sheet redundant once the deck's controls exist everywhere: Mark-done already lives on EditQueueScreen; the favourite chip already drives the full directional intent cycle; what remains is four small pieces of deck work (below).

**The settled design (P2-1 … P2-6):**

1. **P2-1 — the list-source contract.** A pure `lib/deckList.ts`: serializable `DeckListDescriptor` route params (`{source: 'queue'|'history'|'grid', …args, anchorId}`), one `resolveDeckList(db, descriptor) → DeckListRow[]` resolver table whose entries delegate to the SAME query functions the host screens use (order/filter parity by construction; History's per-page presence reconcile moves into its entry; the grid source becomes a real scope query, fixing ProgressView's frozen-snapshot oddity). The deck imports one function and holds zero surface knowledge; a new surface is one table entry. Runtime-function params rejected (serializability); the dynamic provider registry rejected (registration-order and restoration hazards).
2. **P2-2 — entry is a plain push**, one `Deck` route, list-vs-unit by params. Back pops to the host (state preserved by the navigator); no navigation modals; the deck's browse-mode stage tap stops opening anything (its old job splits into P2-5/P2-6).
3. **P2-3 — list liveness is the source's own truth.** Rows re-resolve on version bumps and external refresh (unitKey-stamped, like unit rows); the viewer's photo-anchor contract ports verbatim (anchor moves only on user navigation; a vanished photo re-anchors to the clamped neighbour — replacing QueueViewer's unmount-on-original-leave defect); an emptied list quietly goBack()s (the whole-day precedent). Queue lists drop removed rows; grid/day lists keep decided photos badged; History converts to tombstones — all by construction of each source's query, no mode flags.
4. **P2-4 — controls in list mode.** Keep/Cull live with browse semantics (`expectedGroupId: undefined` — the guard protects group decks, a claim list mode never makes); all four chips live with the bookkeeping funnel (badge-ref hydration on load; `hydrateBadges([id])` + `queuesChanged()` after direct writes — the codex-derived pattern); Compare disabled (parked; trigger: a tester wants A/B from a list); Not related keeps its dead state EXCEPT per P2-5; finish hidden (no honest list-batch verb; a future "keep all here" is a designed batch, not a retrofit). The edit chip's unreviewed-photo fork follows the offer matrix (autonomous, matrix as reference). Goal credit and the celebration flow unchanged — the write computes both.
5. **P2-5 — the sheet's residue moves onto the deck** (the gap table, 2026-08-27): **un-mark not-related** = the dead Not-related slot wakes inverted on a pair-carrying photo ("Not related · n" → confirm un-mark + targeted rescan); **untracked photos** (reachable via grid-'all' lists) disable all controls and say "Not analyzed yet" in the corner; **trashed rows are unreachable by construction** (asserted in the source contract; the read-only body drops); the `editorOffer` refusal matrix ports into the controls' disabled logic (its test suite survives re-pointed). Verbose facts: P2-6.
6. **P2-6 — the details overlay** (Tristan's enhancement; Samsung Gallery's swipe-up panel is the idiom guide). The metadata corner stays the Settings-curated GLANCE; **tapping the corner/chips area opens a semi-opaque full-stage overlay showing the complete truth**: every metadata item regardless of the Settings toggles, plus the migrated verbose sentences (full decoded album paths, the superseded-move line, the five F21 "rides along" strings, was-edited/was-shared/favourited-in-gallery, the not-related count) with the fail-closed retry + F30 stale-dimming discipline. Exempt from the eye and the Settings rows (M21 honesty: the detail surface is always complete). Candidates queued for the phase-7 discussion, not decided: capture EXIF (bounded native-reader extension), file size (`size_bytes` exists unrendered), full folder path, container detail, group membership, a possible swipe-up opener (gesture-arbitration care), and — flagged — the future home for TODO's "somewhere to see a group's Compare history". Location-on-map parked as its own future version.
7. **P2-7 — fullscreen immersive: single tap on the stage toggles it, both modes, in place** (never a navigate — no remount, no pipeline re-warm). Sibling chrome collapses, the flex stage grows, contain-fit scales the photo into the freed space; one `LayoutAnimation` call animates the reflow (dropped to instant if it fights the gesture tree on device); native header via `setOptions`; edge-to-edge with the status bar; zoom resets/re-clamps on toggle; back exits immersive first. NO gallery-style floating control redesign (deliberately rejected — the deck's controls are too many and too large for that idiom). **Pre-registered fallback, judged at the device pass:** a four-corner expand icon beside the eye, tap goes inert — a trigger swap on the same mechanism. This mode hosts phase 6's full video transport (revised M4). The stage chrome (corner, badges, notice) stays, under its own rules.

- **Every viewer host rewires** to `navigate('Deck', {list…})`: the four queue screens, History, Progress grids, day pages. The UI gate's viewer step rewrites to the deck-list equivalents; MOBILE_UI_GATE.md's three companion lines update.
- Lands with equivalence coverage (a `deckList.ts` pure suite beside `deckUnit.ts`; real-DB parity for the source queries) and its own device leg (every former viewer entry walked; list-mode order; the anchor under History reorder; immersive toggle; un-mark; untracked).
- Phase-7 knock-on: every "state-editor sheet" fact home in this plan re-targets to **the details overlay (P2-6)**; the facts-flash defect stays dead (the panel's successor reads under the same discipline).

### Phase 3 — the URI/cache pass (TODO 14 + TODO 12 + the image-cache requirement)

The image-cache alarm, measured at the m0.8.8 ship (S23, 27k library, 100% full): one session grew the footprint such that reset reclaimed **~1.5 GB** (split derived, not measured); S10e regrowth measured 353 MB data + 285 MB cache in one session; justified durable cost at 27k ≈ **200 MB** (140.6 MB embeddings + tables).
Investigation findings (read from installed expo-image 57 source): every surface disk-caches decoded results via Glide (~250 MB default LRU, unconfigured); JS cache control on Android is all-or-nothing; a per-key eviction back door exists **unverified** (`getCachePathAsync` + external file delete); the gigabyte's bulk may be **SQLite WAL bloat under checkpoint starvation** (long reads starve checkpoints — the same reads phase 8 fixes), also unverified.

1. **Spikes first — measure before mechanism** (M23, outcome form):
   a. **Composition audit** on a scanned device: break the footprint into DB main, WAL, Glide dir, diag sink, rest — via `run-as` on a debuggable build or a temporary in-app `[perf]` dir-walk line. This assigns the gigabyte.
   b. **WAL behavior:** size during/after an initial scan; does `wal_checkpoint(TRUNCATE)` at scan-end and app-background reclaim it under concurrent reads?
   c. **Per-key eviction:** explicit `cacheKey` on one surface, delete the cached file, confirm Glide treats it as a clean miss across restarts.
2. **The `content://` switch** (TODO 14): grids, strips, and at-rest pager pages serve from `content://` MediaStore uris so the OS supplies precomputed thumbnails; the zoom pipeline keeps its full-decode path. First step measures the OS-thumbnail latency claim on the S23 against the same 200MP group (recording 120115's ~5 s black stage), and verifies video thumbnails arrive the same way (F26 needs them).
3. **Version-carrying cache keys** (TODO 12): `photos.mod_time` threads into every surface's `cacheKey`/`recyclingKey`, plus an invalidation hook where edit detection classifies in-place edits — no surface renders pre-edit pixels past the next scan. The same explicit-key design is the primitive any lifecycle purge needs.
4. **Mechanisms in leverage order until the bound is met:** the `content://` switch (removes demand) → WAL checkpoint discipline (if spike b confirms) → lifecycle purge of large pager-size entries via the verified per-key primitive → periodic `clearDiskCache()` at safe moments as the pre-registered blunt fallback. The per-group purge-on-decided semantics are built **if and only if** the post-`content://` measurements name the large-entry bucket as the remaining problem.
5. **Definition of done, measured on the S23:** after a full review session on the 27k library, total app footprint ≤ justified durable state + a fixed cache budget (~250 MB), and session-over-session growth ≈ zero at steady state.

### Phase 4 — media kinds enter the data layer

- **Permissions:** `READ_MEDIA_VIDEO` joins app.json; the `expo-media-library` plugin's `granularPermissions` gains `"video"`; the native `hasFullImagesAccess` check becomes kind-aware (or presence reads go "unknown").
- **Identity:** canonical uris become kind-aware — `mediaIdentity.ts` builds `/images/` or `/video/` collection paths from the stored kind; every consumer (trash, favourite, presence, region-open) inherits it.
- **The native module goes video-aware** at its seven Images-only sites: delta change discovery, favourite reconciliation, the direct fetch, the tripwire counts, the album catalog walk, details, and the access check (`MediaStoreActionsModule.kt`).
- **The scan:** the four `MediaType.photo` filters widen; videos land as **singles interleaved by capture time** — no grouping, no embeddings (G5); duration from MediaStore's column.
- **Schema (provisional v23, M18):** `photos` gains `kind` ('photo'|'video'), `mime_type`, `display_name`, `width`/`height`, `duration_ms`, the motion container column + its backfill marker; the groups side gains the **indexed anchor column** (phase 7 consumes it). Names and marker shapes follow existing patterns (autonomous).
- **Motion detection** (G6): scan-time container sniffing — Samsung SEF trailer and Google XMP — as a bounded read per new photo plus a one-time backfill. **The format spike runs first**: real files from both containers prove the read before the design hardens. Extracted MP4s are run-scoped temp files under cache policy.
- **The measurement rescue** (M17): metadata first, then measure — missing dimensions get one EXIF-orientation-corrected bounds-only header decode; missing duration gets the platform metadata reader; both cached once per content (the D15 pattern). "Unknown" survives only for unreadable files.
- **The items-copy sweep** (M9) lands here, where the counts change meaning.

### Phase 5 — playback

- **expo-video** enters (new dependency, prebuild); the per-kind Playback rows and Off/poster behavior as the media model states.
- Stage and viewer chrome per the two tiers; playback starts on pager-page settle under Once/Loop; the speaker toggle unmutes the current view only.
- Motion photos route through the same player over their extracted clip; the still ↔ playing handoff keeps the stage's stable view tree (props only, never mid-touch mounts).
- **The video-zoom hedge** (M6): record as a build observation which surface type expo-video renders through and whether view transforms visibly apply — feeding the parked trigger entry.
- The device-pass claim "trash/share/organize/favourite/edit just work on videos" is assumed until the pass walks a real video through **every** queue (F26.4).

### Phase 6 — the animated-thumbnail subsystem (M16)

- **The sustained spike, both devices** (S23 + S10e; the S10e is the floor-experience gate): a realistic mixed population of GIFs, motion photos, and videos animating concurrently in grid cells, sampled at **1 / 3 / 5 / 10 minutes** for CPU, battery, frame health, and thermals — per mechanism: N simultaneous muted players vs transcoded animated thumbnails (animated WebP at grid resolution; transcode cost and storage measured).
- **The design doc** (its own document, this phase's gate): mechanism choice from the spike numbers; the thumbnail-animation setting shape and defaults (motion default = video behavior; "act as GIF" = the parity mode; whether videos animate too); cache lifecycle designed against phase 3's layer; any schema needs — **v23's DDL finalizes here** (M18).
- **The build:** motion-as-GIF parity real on every thumbnail surface the design names (deck strip, timeline cards, Progress grids, History); videos inherit what the numbers allow.

### Phase 7 — the stage's metadata, the chips, and the Overlay section (F31 + F33 + F34)

One pass over the badge and preference layer, in this order (the feedback doc's dependency: F31 → F33 → F34):

1. **F31:** no folder pill for the primary volume's DCIM/Camera; every other folder keeps it; folder + SD move from the action cluster into the day·time metadata badge (one badge, deck and expanded stage alike — M24); small squares stay annotation-free.
2. **Kind chips** — GIF · Motion · Video — join the badge vocabulary as layer-3 annotations (last, quiet, near-white; never an action hue); plain photos stay unchipped.
3. **F33:** the metadata badge gains extension (display-name truth, M15) and resolution; **megapixels and pixel resolution are separate items** (M14); videos gain duration. The **details overlay (P2-6)** carries the file-facts detail (exact pixels always; named unknowns per M17). Stage omits residual unknowns silently.
4. **F34:** one combined **Overlay** Settings section — **nine full switch rows, each with explanatory subtext** (M22; the L6 rewrite): Date & time · Source folder (with SD) · Position · Resolution (pixels) · Megapixels · Extension · Duration · Kind chips · Status badges (verdict + all four actions, indivisible). Defaults all ON except Megapixels (M19).
5. **The eye** becomes a master hide over the entire overlay set — metadata badge and position counter now included; one shared durable boolean; `badgePrefs.ts` rewrites its header to the two-layer contract, citing the fired trigger (M20).
6. **One shared set** across the deck stage and the expanded (fullscreen) stage; Compare inherits it, functional pane labels never hideable; the details overlay (P2-6) stays outside the system, always complete (M21, retargeted by M24).
7. **The zoom fail-soft notice is exempt and un-hideable** — a fidelity claim, not decoration; its copy and placement get their review inside this pass (M19).
8. **The nothing-viewer-only audit** (M24): before this phase closes, verify every fact and affordance the retired viewer AND sheet carried has a live home (overlay corner, the details overlay, or the immersive mode) — the phase-2 deletion's completeness check, re-run after the chrome settles.
8. Section placement: Overlay beside Appearance, Playback adjacent; both use row + subtext form.

### Phase 8 — Everything usable at scale (TODO 13, all prongs — M11)

1. **Write-through anchors:** each group's anchor recomputes inside the same transaction that rewrites its membership — never a global pass. The page becomes a true indexed keyset walk.
   **The membership-writer audit** enumerates and proves every path: scan window writes, adjacent-burst merges, eject dissolution + targeted re-placement, un-eject, forget-card keep/erase, the trash confirmation's cleanup, external-deletion reconciliation. Only these publish a structural invalidation.
   A dev-build tripwire compares stored anchors against recomputed `MAX` in the real-DB tests.
2. **Verdicts never invalidate structure:** a decision changes a card's fill and badges only — card state re-renders from its own row; the browse read's structure resets only on the audited membership writers.
3. **Completed pages always render:** resets coalesce behind the in-flight page; a finished read is never discarded.
4. **The JS-thread multiplier, profiled and fixed at source** (unconditional): on-device profiling with the fixes in; scan/backfill/refresh work yields the THREAD, not just cores.
5. Measured against the unskipped `browseBench.real.test.ts` seed and on the S23. **Done = Everything is usable at 25k photos / 5.6k groups while a scan or backfill runs.**

### Phase 9 — the scan explains itself (F27 presentation + F32)

- No "Scanning…" until the scan survives the skip check; a full pass names its reason; a delta names its size (in "items", per M9).
- Publishing becomes per-photo, time-throttled to ~1 s (G13).
- The diagnostics sink's accumulated full-pass reasons are read back: any reason beyond the weekly reconciliation gets the same named treatment.
- **The pending-row race** (S23, 2026-08-27, sink-proven): Samsung holds fresh camera rows in MediaStore's PENDING state for seconds; an app-open delta racing that window classifies their change events "out-of-source" (the hidden `.pending` bucket), the pending-blind tripwire agrees, and the generation is consumed — then NOTHING re-triggers inside a continuous foreground session, so the app sits stale while the day page promises "join the counts when the scan finishes". Fix here, two halves: (a) a surface computing `analyzing > 0` with the scan idle requests a delta (self-healing pull — the healing delta measured 0.5 s); (b) the out-of-source classifier names pending-bucket changes for what they are instead of silently lumping them. Evidence: the 13:49:58 ignored-then-nothing-changed lines vs the 13:53:51 refocus delta ingesting exactly the two photos.

### Phase 10 — the visual group vet

A contact sheet from a device DB's actual continuous groups, eyeballed against the fitted curve's real-world behavior (deferred since m0.8; tooling + a judged session, no app code).

### Phase 11 — close-out

- Docs distillation: this plan's durable content into PLAN.md's shipped entry, STATE_MODEL.md (the kind vocabulary), and code headers; the feedback doc **deletes** (its own instruction — the round is fully shipped); TODO items 11–14 close; TODO 15 per the spike outcome.
- Full gates: `npm run lint && npm run format:check`, core build+test if touched, both typechecks, mobile tests, `npx expo export` bundle proof (from `apps/mobile`), prebuild + Gradle release build.
- The UI gate against the installed release build, with this release's selector updates: the items-copy strings, the kind chips, a video walked through the deck, and the Overlay rows.
- `codex-review` rounds until clean (self-review against docs/REVIEW_CLASSES.md first). Ask the reviewers specifically to scrutinize: the media-stage consolidation for behavior drift, the kind-aware identity layer (mis-addressed collection uris fail silently), the cache-key/invalidation layer, and the anchor write-through paths.
- Version bumps, tag `mobile-m0.9` — after the device pass.

## Device pass (the release-specific gate list)

Both devices throughout; the S10e is the floor-experience gate.

1. **Media stage regression** (phase 1): the m0.8.8 zoom sweep re-run on the consolidated surfaces — all format tiers, deep zoom, patch lines in the sink, Compare's pair.
2. **The deck as the one surface** (phase 2): every former viewer entry walked from its host (queues, History with tombstones, Progress, day pages), list-mode order preserved, the expand control, back behavior, state edits from browse.
3. **Cache footprint** (phase 3 DoD): a full review session on the S23's 27k library; footprint ≤ durable + budget; steady-state growth ≈ zero. The 200MP group-entry stall re-measured against recording 120115.
4. **Videos end to end** (phases 4–5): a real video through **every** queue (edit, favourite, organize, share) and the full verdict set including trash; playback chrome on both tiers; per-kind modes exercised; the speaker toggle's current-view scope; pinch inert; Compare exclusion.
4. **Motion photos:** both containers (Samsung SEF from the S23's camera, Google XMP samples); still ↔ playing handoff; zoom shows the still; backfill over the corpus timed.
6. **Animated thumbnails** (phase 6): the sustained 1/3/5/10-minute protocol on both devices, per mechanism, before the design doc commits.
7. **Overlay pass** (phase 7): the nine rows at real sizes; badge/metadata placement on stage, viewer, Compare; the eye's widened scope; fail-soft notice visibility.
8. **Everything at scale** (phase 8): the S23 during an active scan/backfill; decisions taken while the filter is open (no structure reset); eject → Everything within seconds (write-through anchors).
9. **Scan presentation** (phase 9): skip check silent; reasons and sizes named; ~1 s cadence on slow phases.
10. **Pixel-honesty judgment** (phase 1 spike, if built): threshold, automatic vs toggle, Compare-only — decided on real pixels.
11. Tunables carried: chrome sizes, hairline geometry, autoplay settle timing, thumbnail-animation population caps — all device-pass items, not pre-decided.

## Decisions settled in the m0.9 pre-build grilling (2026-08-26)

All 23 vetted one-by-one with Tristan; per-question code facts were gathered before each decision.

| # | Decision | Choice | Why |
|---|---|---|---|
| M1 | Release identity | m0.9 as documented (0.9.0, versionCode 16, tag `mobile-m0.9`) | "0.8.9" was a misnaming; the docs' packing stands |
| M2 | Per-ABI splits | Deferred to pre-v1 | Release-workflow work with no urgency; testers tolerate the universal APK |
| M3 | All-time goal-days stat | Deferred to the event-log round; **goal-crossing events** join its member list; the pre-log era is that round's open question | Building it now means building the goal-relative version twice; the crossing event freezes the honest fact |
| M4 | Video chrome | Two tiers: stage = speaker + hairline + play/replay; viewer = full transport | The stage stays a calm verdict surface; study happens in the viewer |
| M5 | Autoplay semantics | Per-kind rows (Videos, Motion photos), each Once · Loop · Off, defaults Once; supersedes G6 "looped" and G7's single toggle | Play-once matches the reference galleries; the mode setting was asked for with the need in hand |
| M6 | Video zoom | Deferred with hedges: pinch inert; surface-type observation recorded in-build; corrected mechanism parked (surface transform, not per-frame decode; frame rate irrelevant); trigger = tester ask | A speculative new zoom surface re-opens the m0.8.8 arbitration class in an already-large release |
| M7 | Videos in Compare | Excluded — button disabled, picker never offers; motion photos compare as photos | Compare is still-oriented end to end; no machine-found video pairs exist under singles-first |
| M8 | Videos and actions | Compatible with **all** actions incl. the edit queue; F21 suspension unchanged; hash-cost flag | The queue machinery is kind-agnostic; manual mark-done bounds detection gaps |
| M9 | Copy vocabulary | "Items" wherever a count can include videos; deliberate inventory sweep | Accuracy and honesty outrank register; "photos" including videos is a small dishonesty |
| M10 | ZoomSurface (TODO 11) | In scope, phase one, with a maximal-consolidation design pass ("media stage" candidate boundary) | m0.8.8 paid the triplication tax repeatedly; playback would pay it thrice again |
| M11 | Everything livelock (TODO 13) | All prongs unconditionally, amended: write-through anchors (audited membership writers), verdicts never invalidate structure, coalesced no-discard resets, JS-thread fix at source | The anchor makes the read the simple thing; the reset fix is subtraction; starvation slows every read in the app |
| M12 | URI/cache pass (TODO 14+12) | Both in scope as one pass: `content://` thumbnails + version-carrying cache keys + edit invalidation | One rewrite of one layer; video thumbnails fall out of the same switch |
| M13 | Pixel-honest deep zoom (TODO 15) | A requirement, not a trigger item: time-boxed spike in m0.9; contained build ships, else m0.9.1 with the memo | Bilinear synthesizes gradients — the same honesty principle as M9; mechanism unknowns need a device test |
| M14 | Resolution rendering + media model | MP and pixels are separate toggleable items on all surfaces; motion photos are both photo and video; GIFs are photos | MP is the capture-settings fact, pixels the editing fact; the dual identity matches how motion photos are used |
| M15 | Extension truth | Display-name extension, uppercase, no dot; MIME stored as classification truth | The name is what every other surface shows the user; classification must survive misnaming |
| M16 | Animated thumbnails | Full subsystem committed to m0.9; **L1 formally dropped for this release**; measurement-first (both devices, sustained 1/3/5/10-min protocol) → design doc → build | Motion-as-GIF parity is the point of the dual identity; Tristan chose the full commit over spike-then-defer |
| M17 | Unknown values | Metadata → measured fallback (orientation-corrected bounds decode; duration reader; once-per-content markers) → residual unknowns: stage omits, viewer names | A photo always has a resolution; measuring is a cost willingly paid for accuracy (the D15 pattern) |
| M18 | Schema v23 | One bump; columns as phase 3 lists; groups anchor; DDL finalizes after the animated-thumbnail design doc | One tester reset, not two; late-binding is what the pre-v1 destructive policy is for |
| M19 | Overlay section scope | Combined, mixed granularity: 7 metadata rows + Kind chips + Status badges (indivisible); fail-soft notice exempt and un-hideable; defaults all ON except MP | Two scopes today was the confusion; hiding a fidelity caveat would hide a caveat |
| M20 | The eye | Master hide over the entire overlay set (metadata badge + position counter now included); notice exempt; one shared boolean | Rows curate, the eye mutes; one crisp model |
| M21 | Per-surface | One shared set; Compare's functional labels never hideable; the facts panel outside the system | The split-want is speculative; the facts panel is already the fact-rich place |
| M22 | Settings form | Nine inline switch rows, each with explanatory subtext; no chip grid, no sub-screen; **L6 rewritten** (need-earned; clarity beats compactness; repo-wide) — lands via the DocsAudit | Novice comprehension outranks screen compactness |
| M23 | Image cache | In scope, outcome form: three spikes assign the gigabyte first; mechanisms in leverage order to a measured bound; per-group purge only if the post-`content://` numbers name it | No machinery before measurement proves it is the correct solution |
| M24 | The viewer retires (added 2026-08-27, phase-1 close) | PhotoViewer deletes; the deck gains list mode, the fullscreen expand control (hosting the video transport tier), and the overlay/state-editor homes for every facts-panel fact; sequenced as phase 2 so later phases build in one place | Post-consolidation the viewer did nothing unique by design, only by history; building phase-7 chrome on a doomed surface would be double work |

Related parallel work, not in this release: the **DocsAudit** ([DocsAudit.md](DocsAudit.md)) — the documentation/comments reorganization, including CONTRIBUTING.md creation and the lettered-principles recovery (L1's drop and L6's rewrite land there).

## Autonomous decisions (appendix)

Numbered as implemented; get each human-vetted at the close-out grilling.
Pre-flagged latitude from the grilling: exact v23 column names and marker shapes (existing patterns); the video hash-cost mechanism on the edit-detection path; dialog and subtext copy (the app's voice); Overlay/Playback section placement details; chrome geometry tunables (device pass).

1. **(Phase 2) `editorOffer` deleted, not ported.** The deck's existing disabled logic already encodes the refusal matrix (staged cull suspends favourite/organize, share/edit stay live; untracked disables everything; trashed rows are excluded by every list source's own query — verified: `livePhotoClause`, History's filter, the grids' presence clauses). Porting the pure function would have added an abstraction with one inline consumer. One accepted divergence, deck-canonical: on a staged cull the deck disables the favourite chip entirely, where the sheet still offered cancelling a QUEUED favourite; recovery is un-stage → cancel → re-cull.
2. **(Phase 2) The library-scope grid engine extracted to `lib/gridPager.ts`** (MediaStore merged pager + state join + rescued-copy dedup, verbatim from PhotoStateGrid), shared by the Progress grid and the deck's library list — parity by construction. The deck side pages it statelessly (re-pull + slice per resolve; the per-bucket fetches are sub-millisecond), failing closed by throwing rather than truncating.
3. **(Phase 2) An untracked-but-dated list row shows MediaStore's own day** (`dayKey(takenAt)` — the same claim its grid tile renders), not a false "Unknown day"; the corner appends "Not analyzed yet".
4. **(Phase 2) Un-mark confirm copy** (pre-flagged latitude): 'Un-mark "not related"? This photo never groups with N photos you separated it from. Un-marking lets the scan group them again.'
5. **(Phase 2 device pass, tester request 2026-08-29) One inspection-dot language everywhere, and the eye narrows to the stage.** The Progress grid's verdict-dot + weighted-action-glyph row extracted as `StateDots` and adopted by the deck's film strip and the Timeline/DayProgress cards (which already wore the glyph-cluster variant). The F19 eye now governs ONLY the stage's badge cluster: it once hid the strip and card markers while the grid's dots stayed (the grid was always exempt by design), which the tester hit as "the strip lost its indicators" — the S23 simply had the eye on. Wayfinding dots on thumbnails never obstruct the stage photo. **Amends the vetted 2026-08-21 "one setting flips every badge surface" scope — vet at close-out.**
