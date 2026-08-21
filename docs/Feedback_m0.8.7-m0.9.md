# Tester feedback — the 2026-08-20 round

Round of 2026-08-20 (Tristan, S23 + S10e on shipped m0.8.6): ten items, **F21–F30**, continuing the numbering from [Feedback_m0.8.x.md](Feedback_m0.8.x.md).
Settled in an 11-question grilling (2026-08-20/21) with per-item code facts gathered before each decision.
Organised into three releases — one subsystem, one device pass, one review cycle each (L1) — all landing **before** the accessibility pass, which moves to m0.9.1 so font scales are measured once the UI stops moving.
This doc spans the releases, so it is named for the span.
Delete it when m0.9 ships.

Each claim carries an evidence tier: **reported** (tester saw it), **read** (established from the code, not yet reproduced), or **measured** (run on a device).
Reproduce an item whose cause is only **read** before you write its fix.

---

## The releases

| | Release | What it is | Items |
|---|---|---|---|
| **m0.8.7** | sources, badges, and the queues | Existing scope ([Feedback_m0.8.x.md](Feedback_m0.8.x.md)) plus riders whose subsystem this already is | F21 F30 · **F27's undated-fallback fix** (pulled forward 2026-08-21, cause measured) · the share-before-edit dispatch confirm · scan-log capture step zero · the stats-accuracy sweep ([STATS_ACCURACY.md](STATS_ACCURACY.md)) |
| **m0.8.8** | the review deck | The deck and Compare become one tighter loop; zoom becomes pixel-perfect | F22 F23 F24 F28 F29 |
| **m0.9** | media kinds | Videos and motion photos enter; every kind wears its chip; the scan explains itself | F25 F26 · F27 (presentation) · plus m0.9's previously planned items, unchanged |

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

---

## m0.8.7 riders — sources, badges, and the queues

The release's main scope lives in [Feedback_m0.8.x.md](Feedback_m0.8.x.md).
These land here because queue semantics and the state editor are this release's subsystem.

### F21 · "I want to delete this photo, but share it first"

**Reported:** the tester wants to cull a photo and share it before it is trashed.
**Read:** share-then-cull already half-works — the share row survives a cull, suspended ([actions.ts:54-59](../apps/mobile/src/db/actions.ts#L54-L59)); but the deck refuses cull-then-share ([DeckScreen.tsx:1869-1908](../apps/mobile/src/screens/DeckScreen.tsx#L1869-L1908)), dispatch silently drops culled photos from a batch ([ShareQueueScreen.tsx:184-211](../apps/mobile/src/screens/ShareQueueScreen.tsx#L184-L211)), and **trash-confirm silently deletes never-sent rows** ([trashStore.ts:256-260](../apps/mobile/src/db/trashStore.ts#L256-L260)).
Found inconsistency: the state editor *does* offer "Add to share queue" on a staged cull, but the add lands invisibly (guard only on `is_present`, [shareStore.ts:74](../apps/mobile/src/db/shareStore.ts#L74)) and confirm deletes it.

**Fix (G2), the four-point contract:**

1. **Share and edit intents stay live on a staged cull** — visible in their queues (wearing the staged-cull badge), dispatchable, addable from deck and editor.
2. **Favourite and organize stay suspended** and remain refused as additions on a staged cull.
3. **Cull-confirm gains one guard**: members with never-sent share or edit intents are named in the dialog ("2 photos still have unsent share requests") with proceed (delete the intents knowingly) or cancel. Post-confirm cleanup is unchanged: unsent rows delete, sent ones keep their History proof.
4. The suspension doctrine and its pinning tests ([shareStore.real.test.ts:182-222](../apps/mobile/src/db/shareStore.real.test.ts#L182-L222)) plus `docs/STATE_MODEL.md`'s suspension section are rewritten deliberately.
   Deleted along the way: the un-stage resurface machinery ([shareStore.ts:209-219](../apps/mobile/src/db/shareStore.ts#L209-L219)), which exists only because shares hide today.

### Rider · Share-dispatch confirm when an edit is pending

Separate from F21 (applies to any photo, culled or not): dispatching a share for a photo whose edit intent is still queued sends the unedited file.
One confirm at dispatch time when the batch contains such photos.
Small; lives with the share-queue work.

### F30 · The state-editor panel minimises on kept→unreviewed but not culled→unreviewed

**Reported:** on Progress, un-reviewing a kept photo makes the panel collapse and return; a culled photo does not.
**Read, cause located:** every write clears the sheet's facts and re-reads; while `facts === undefined` the body unmounts to "Loading…" ([StateEditorSheet.tsx:96](../apps/mobile/src/components/progress/StateEditorSheet.tsx#L96), gate at [:390-449](../apps/mobile/src/components/progress/StateEditorSheet.tsx#L390-L449); same pattern in [PhotoViewer.tsx:392](../apps/mobile/src/components/PhotoViewer.tsx#L392)).
The asymmetry: kept→unreviewed re-enters the pending queue and triggers a delayed version-bump render burst; culled→unreviewed is already in the loaded queue, so its refresh commits nothing ([ReviewContext.tsx:495-558](../apps/mobile/src/review/ReviewContext.tsx#L495-L558), [store.ts:1186](../apps/mobile/src/db/store.ts#L1186)).

**Fix (G11):** keep the previous facts rendered, dimmed under the existing `busy` treatment, during re-reads — both sites.
No queue-layer change; the delayed burst is correct behavior the sheet becomes indifferent to.

### F27 (fix) · "The app seems to do a random scan when opening it up"

Pulled forward from m0.9 (Tristan, 2026-08-21) because the cause landed on day one of the log capture; the presentation half stays in m0.9.

**Reported:** long, corpus-sized scans several times a day, mostly on the S23; sometimes a foreground return scans, sometimes not.
**Cause located (measured, 2026-08-21, live on the S23):** the delta planner's **undated fallback** ([scanRunner.ts:602-605](../apps/mobile/src/scan/scanRunner.ts#L602-L605)).
Any changed photo with neither capture nor modification time cannot be placed in a delta range, so `plan.undated > 0` silently discards the delta and runs a full pass — the **only unlogged fallback in the planner**, and it runs *after* the verdict line prints, so the log says "DELTA wins" while the corpus walk starts.
Captured in the act: one new photo (27282 vs tracked 27281, "1 undated"), verdict "cost 4 vs budget 13641: DELTA wins", then Home showing "Scanning 53% · 14 400 of 27 282 photos" with no full-pass reason logged, ending "done: scanned 27282, embedded 1 fresh" — **4 min 50 s of corpus walk to land one photo** (measured, 11:39:51→11:44:41).
So **every new undated photo — a WhatsApp image, a stripped-EXIF download — costs a full corpus scan**: several arrivals a day is "the app randomly scans everything, several times a day", and the unchanged-library skip explains the opens that stay quiet.
**A second instance five minutes later (measured, 11:49:59) showed the compounding case:** another WhatsApp image arrived *during* the first pass, so the start-of-pass fingerprint correctly flagged it on the next open (counts equal, "1 changed, 1 undated", cost 1) — and the fallback launched full pass #2.
With a ~5-minute pass and undated photos arriving independently, an active chat day can keep the corpus walking back-to-back.
The triggers themselves were vindicated by the same capture (skips and deltas behaving as designed on the no-change samples), so **trigger redesign stays off the table**.

**A second cause layer beneath it (Tristan's question, 2026-08-21; read + measured):** the WhatsApp folder is **not in the selected sources at all**.
The scan is source-scoped everywhere — counts, paging, embedding — but `mediaChangedSince` is **volume-wide with no bucket or path filter** ([MediaStoreActionsModule.kt:273-287](../apps/mobile/modules/media-store-actions/android/src/main/java/expo/modules/mediastoreactions/MediaStoreActionsModule.kt#L273-L287)), so out-of-source photos leak into the delta's changed set.
Measured proof, both directions: at 11:49:59 the source-scoped tripwire read **equal** (27282 = 27282 — nothing in the sources changed) while the volume-wide changed set still held the WhatsApp photo; and pass #2 ended "done: scanned 27282, **embedded 0 fresh**" (11:49:59→11:53:59) — a four-minute corpus walk that could not ingest the very photo that triggered it, because that photo is out of scope for ingestion.
This is another missed predicate of exactly the class L3/F18 audits this release: source selection is a scope axis, and the changed-set read skipped it.

**Fix (G8, point 1 — now two legs):**

1. **The changed set is filtered to the source scope** before delta planning: an out-of-source change plans nothing and triggers nothing (it is already invisible to every other read). The filter must key on each changed row's *current* path, so a photo moved *into* a selected source still registers as a change.
2. **The undated fallback stops walking the corpus** for in-source undated changes — they are fetched, EXIF-rescued, embedded, and landed as undated units directly (the D15 rescue and undated-batch machinery already exist in the full-pass path); if that proves unsafe in-build, the fallback at minimum logs itself and names itself in the UI.

Plus one invariant, landed with the fix: **every planner fallback logs its reason; none returns silently.**
The capture (below) keeps running to measure the fallback's real frequency and catch any *other* full-pass reasons before m0.9's presentation work.

### Step zero · S23 scan-log capture (F27's evidence)

**Running since 2026-08-21 11:13** (no app code involved).
The shipped build logs its scan reason every run (**measured**: `[scan]` lines reach logcat under tag `ReactNativeJS`), and an on-device logcat writer records them across ADB disconnects for the whole release cycle.
It caught F27's cause within the first half hour (the undated fallback, above); it stays running to measure that fallback's frequency and to catch any other full-pass reason before m0.9's presentation work.

Mechanism (`logcat -f` writes nothing on this Samsung build — **measured**, use shell redirection):

```bash
# start (survives ADB disconnect; dies on phone reboot AND is reaped
# spontaneously every hour or two — check `ps -A | grep logcat` on every pull
# and at every phase boundary, restart if gone; the ring buffer bridges short
# gaps for the sparse [scan] tag):
scripts/android-device.sh adb R5CW20KBA2W shell \
  "nohup setsid logcat -v time -s 'ReactNativeJS:*' >> /data/local/tmp/afterglow-scan.log 2>&1 &"
# pull a snapshot:
scripts/android-device.sh adb R5CW20KBA2W shell \
  "grep -a '\[scan\]' /data/local/tmp/afterglow-scan.log"
# stop when m0.9's diagnosis is done:
scripts/android-device.sh adb R5CW20KBA2W shell "pkill logcat; rm /data/local/tmp/afterglow-scan.log"
```

Volume is a few KB/day (one app's JS log only), so no rotation is needed.
First samples, 2026-08-21 11:07–11:13 (**measured**): a foreground delta whose tripwire read "nothing changed", then three foreground returns each hitting "library unchanged since last complete pass — skipped" — the differential design working as intended on those samples.
The phase-2 read-back (2026-08-21 14:41, **measured**) found a third same-day corpus walk (13:38–13:42, "2 undated" after "DELTA wins") — same undated leg, **no new cause**; three walks in one quiet-library day confirms the fix's priority.
The open question the remaining capture must answer: whether any OTHER full-pass reason shows up before the m0.8.7 build (whose in-app sink retires this writer) lands on the device.

---

## m0.8.8 — the review deck

### F23 + F24 · Advance to the nearest unreviewed photo

**Reported:** (F23) deciding the last photo of a group with earlier unreviewed members strands the cursor at the end; (F24) deciding mid-group lands on already-decided neighbours.
**Read:** the advance is a bare `index + 1` with no state test ([DeckScreen.tsx:1603](../apps/mobile/src/screens/DeckScreen.tsx#L1603)); "first pending" exists only at unit entry ([DeckScreen.tsx:883-895](../apps/mobile/src/screens/DeckScreen.tsx#L883-L895)).

**Fix (G4):** after an advancing decision, jump to the nearest unreviewed photo **forward first**; if none ahead, **backward to the closest**; if none anywhere, stay put (the existing unit-advance takes over).
Both deck kinds (shared decide handler).
All cursor moves go through `jumpTo` (the pager-alignment contract, [DeckScreen.tsx:1186-1224](../apps/mobile/src/screens/DeckScreen.tsx#L1186-L1224)).
Long-skip animation feel (fly vs snap) is a device-pass judgment call.

### F28 · "Not related" joins the verdict row

**Reported:** move "Not related" between Keep and Cull, sharing the row with Compare, reclaiming vertical space and unifying the group/singles layout.
**Read:** today it is a group-only fourth row costing 54 px ([DeckScreen.tsx:1911-1924](../apps/mobile/src/screens/DeckScreen.tsx#L1911-L1924)).

**Fix (G9):** one weighted row — **Keep (flex 1.4) · Compare (1) · Not related (1) · Cull (1.4)** at ~50 px; chips unchanged (44); finish button 64→56.
Total control block ≈170 px in both modes (from 238/184): groups reclaim ~68 px of stage.
"Not related" is **always present, disabled in singles** (and in browse, as today) so row geometry never shifts between deck kinds.
Neutral styling carries over (it writes no verdict — STATE_MODEL rules 2/3).
Heights and flex weights are declared **device-pass tunables**; the pre-registered fallback for the ¼-width middle labels is icon + short label.
The UI gate has no "Not related" selector and its Compare regex (`^Compare( with…)?$`, [mobile-ui-gate.mjs:708](../scripts/mobile-ui-gate.mjs#L708)) is unaffected; the frame probe's keep-green band assertion must keep holding.

### F29 · Compare gets Keep and Cull

**Reported:** replace "is better" with Cull and Keep (green); on Cull, ask about keeping the other; on Keep, ask about culling the other.
**Read:** the whole-table branch deliberately writes nothing on tap (selection + dialog), which is why it wears the accent ([CompareScreen.tsx:914-936](../apps/mobile/src/screens/CompareScreen.tsx#L914-L936)); all four outcomes of the new flow map onto existing write modes ([ReviewContext.tsx:1440-1489](../apps/mobile/src/review/ReviewContext.tsx#L1440-L1489)).

**Fix (G10):**

1. Two buttons, always: **Keep {photo}** (green, writes immediately) and **Cull {photo}** (red, writes immediately). "Is better", the accent branch, and the whole-table gating (UI and store-side) are deleted.
2. After either write, one binary prompt about the other photo: "Cull {other}?" after Keep, "Keep {other}?" after Cull. Declining leaves it open (triage semantics).
3. The prompt fires **only when the other photo is still unreviewed** — never offers to overwrite settled work. Keep-both is two taps and a decline.
4. Duel rows keep recording, mapped to existing modes (`kept_both` true/false/NULL); "Close — no verdict" stays.

The don't-ask-again preference is **rewired** into the prompts: one remembered answer per direction ("always cull the other" / "always keep the other"), Settings reset row updated.

### F22 · Zoomed quality on a 50MP photo is much worse than the gallery

**Reported:** deep zoom is visibly soft next to Samsung Gallery.
**Read, cause located:** expo-image's Android default (`allowDownscaling=true`) decodes every photo to roughly the stage size, and zoom is a pure composited transform that never re-decodes — 1:1 is reached at ~1.0×, so the entire 16× range magnifies interpolation ([ExpoImageViewWrapper.kt:484-494](../node_modules/expo-image/android/src/main/java/expo/modules/image/ExpoImageViewWrapper.kt#L484-L494), [DeckScreen.tsx:819-821](../apps/mobile/src/screens/DeckScreen.tsx#L819-L821)).
The header comments claiming full-res decode ([DeckScreen.tsx:100-106](../apps/mobile/src/screens/DeckScreen.tsx#L100-L106), duplicated in PhotoViewer and Compare) are wrong and get corrected.

**Fix (G3):** sharpness is not negotiable (200MP capture exists on the S23; future max zoom may rise past 16×).

1. **Region-snapshot function** in the existing native module: URI + source rect + target size → BitmapRegionDecoder patch (~10 MB), laid over the stage when the gesture settles and debounced during pan. Pixel-perfect at any zoom, any source size, zero new dependencies. JPEG and HEIF (API 28+) covered.
2. **Base decode raised to ≥4096 px** (≈50 MB ARGB) so mid-gesture softness shrinks; a bump to ~6144 is available if the devices wear it.
3. All three zoom surfaces: deck overlay, PhotoViewer overlay, Compare panes.
4. `decodeFormat` stays ARGB — 16-bit banding would corrupt keep/cull judgments.
5. **Escalation ladder, pre-registered:** tester still unhappy *mid-gesture* → raise the base; unhappy *after settle* → that is a patch bug, fix it; both exhausted → pivot to a tiling library (C2, `subsampling-scale-image-view`), accepting the gesture-system replacement.
6. Device-pass measurement gate: settle latency, memory, and texture behavior on both devices before ship.

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

---

## What this round adds to PLAN.md's trigger backlog

- **Animated video/motion thumbnails** (Samsung-style sequential clips or a transcode-preview pipeline). Trigger: missing them once m0.9's looping full-view playback ships.
- **Loop/boomerang export as a new video file** (the only honest "make it loop" — no container stores playback settings). Trigger: a user asks.
- **Share-dispatch-with-pending-edit confirm** ships in m0.8.7 (above), so it is *not* parked.

## Cross-release dependencies

1. **G3 (m0.8.8) → G6 (m0.9).** Motion-photo "zoom shows the still" relies on the region pipeline decoding the JPEG primary. Ship order already satisfies it.
2. **m0.8.7's type-scale/token pass → F28 (m0.8.8).** The deck relayout consumes the tokens that pass establishes; landing F28 first would re-touch the deck twice.
3. **m0.8.7's badge vocabulary + hide control → kind chips (m0.9).** The chips join an existing, toggleable vocabulary rather than inventing one.
