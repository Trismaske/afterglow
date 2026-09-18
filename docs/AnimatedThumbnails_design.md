# Animated thumbnails — design (m0.9 phase 6)

**Status:** agreed 2026-09-16 (Tristan + agent); implementation phase 1 landed the same day (the shared pieces, the setting, the kind mark, the Progress grid and the cull list, the probe deleted); phase 2 next.
**Audience:** the agent building phase 6; Tristan reviewing the decisions.
**Lifecycle:** lives while phase 6 is open; its durable content moves into the owning headers, PLAN.md and docs/STATE_MODEL.md at the phase close, and this file is deleted.

## Overview

Every thumbnail-scale surface can animate the clips it shows: a video plays its first seconds, a motion photo plays its clip, a GIF plays itself.
The mechanism is REAL PLAYBACK — expo-video players over the same files the stage plays — bounded by what is on screen, never by a count.
A cell is the OS thumbnail every cell shows today with a player laid over it once the cell is on screen and the list has settled; the player is revealed on its first rendered frame, so nothing ever shows black.
Players are borrowed from a pool made once per list and sized from that list's geometry, so a scroll creates and destroys nothing.
Every clip thumbnail also carries a KIND MARK, playing or not: a video, a motion photo and a GIF are told apart at a glance on every surface.

Unchanged: the stage's own playback (`components/Playback`, the deck's three-player bound), the OS-thumbnail source (`useOsThumbnail`), the StateDots language, the Playback rows for the stage (Videos, Motion photos: Once · Loop · Off).

The evidence behind every decision is the phase-6 spike (docs/Plan_m0.9.md, phase 6): the probe screen, its sustained runs on both phones, and Tristan's iterations on it between 2026-09-15 and 2026-09-16.

## Agreed decisions

| # | Decision | Choice | Evidence |
|---|---|---|---|
| D1 | Mechanism | Real players (expo-video) per visible cell. The frame strip is OUT. | The strip needed 2–7 s of extraction per item on the S10e once faithful to the clip's speed — "way way too high" (Tristan); the players' measured cost is bounded by the viewport (D5) and the pool (D6). |
| D2 | What bounds the players | The VIEWPORT, never a count: every cell with any part on screen may play, and the set is bounded by the list's geometry alone (columns × the rows on screen plus the two cut rows), which is what the pool is sized from (D6). **Confirmed 2026-09-18 (plan appendix 29):** the S23's Progress grid crashed at 24 players with the deck's buffer; the thumbnail buffer (D11) fixed the heap; a ceiling tried in between restated the pool's size and was removed. | Same 90 s scroll on the S23: 22 players run in the same memory as 12 (PSS ~1.5 GB peak, Java heap ≤ 124 MB) at 26 % janky frames against 14 %, no crash either way; Tristan took every visible clip over the smoothness. |
| D3 | The setting | ONE row in the Playback card: **Animated thumbnails: Off · One · All**, default **All**; the card's explanation says what One and All mean. GIF thumbnails follow it. | Tristan 2026-09-16; the short labels 2026-09-18. Off exists for users who find moving grids overwhelming. |
| D4 | One at a time | A single player walks the playing set's video and motion cells, handing over at a clip's END or after `DWELL_MS` (5 s), whichever first — the cap bounds long clips, never extends short ones; GIF cells play on their own. | Tristan 2026-09-15 (Samsung Gallery's behaviour). |
| D5 | Visibility rules | A cell counts as visible with ANY PART on screen. ENTERING cells start only once the visible set has held for the SETTLE (500 ms); LEAVING cells stop the instant they are no longer visible. Already-playing cells keep going through a scroll. | Tristan's feel on both phones, 2026-09-16: 2 s "too long", 0.25 s right until the pool fix, 0.5 s "great" with it; the leaving rule is what stopped a deep scroll's lag (players running on inside the mounted window). |
| D5b | While the list MOVES | A drag or its fling HOLDS every playing cell on its frame: the player pauses (a GIF stops animating), the view and the borrow stay, nothing flashes; playback resumes when the list stops (Gallery's idiom). | S10e, 2026-09-18, the same scripted drag on a player-dense screen: 18.9 % janky frames with 17 live players (slow frames on the render thread: 125 "issue draw commands" against 28 on the UI thread) and 0 % with one; held, 2.8 % at 13 players, the 90th percentile 30 → 20 ms, render-thread slow frames 125 → 7. |
| D6 | The player pool | One pool per list, made when the list's animation starts, sized from its geometry: columns × (rows the list's height holds + 3), the extra rows for the cut rows a partial rule can hold at top and bottom. Borrow on enter (swap the source), pause and return on leave; released when the list leaves. | The S23's lag spike was nine players released mid-scroll; with the pool the S10e's scripted 300-cell scroll shows the same frame-time percentiles stopped and running (90th 18 vs 17 ms, 95th 18 ms both). |
| D7 | No black, no blank | The OS thumbnail is a STABLE base layer that never remounts; the player view sits over it at opacity 0 until `onFirstFrameRender`, a GIF image until `onLoad`. | The S10e recording: not one flat tile in 140 frames across a start and a scroll; the earlier remounting still blinked. |
| D8 | Kind mark | A kind glyph (video · motion · GIF) on every clip thumbnail on every surface, ALWAYS shown, playing or not, in the StateDots corner language; plain photos carry none. Phase 7's stage chips use the same glyphs. | Tristan 2026-09-16: "if we are not playing it, we need to show it", and playing kinds must still be told apart. |
| D9 | Surfaces | EVERY thumbnail surface animates in the build; the device pass prunes any that reads wrong (the deck strip beside a playing stage, 52 dp rows). | Tristan 2026-09-16: build all and see; the conservative fallback is Progress and Timeline only. |
| D10 | Sources | A video plays its content URI; a motion photo its clip through the deck's `extractMotionClip` (run-scoped cache, one in-flight extraction per key); a GIF through expo-image's native playback. | The deck's paths, reused; single-flight from codex round 1 of the probe. |
| D11 | Cost bound per player | A THUMBNAIL bound: 1 s ahead, 4 MiB of samples, half a second to start; NO audio track (`audioTrack = null` — a muted player still decodes its audio: the S23's resource manager showed one AAC decoder per thumbnail player, 2026-09-18), `timeUpdateEventInterval` 0, TextureView. **Amended 2026-09-18:** the deck's 16 MiB times a dozen players was the heap. | The S23 crash of 2026-09-18 (OutOfMemoryError on ExoPlayer's playback thread at 256 MB); after: 72 MB average Java heap on the grid. |
| D12 | Schema | NONE: no cache table, no column. v24 stays; M18's "DDL finalizes after the design doc" closes with no addition. | Players read files the store already knows; the motion cache is run-scoped files. |
| D13 | What leaves | The probe screen, its Settings row and route, `fetchAnimatedProbeRows`, the module's `extractFrameStrip`. `scripts/device-sample.sh` and its §6 recipe STAY (a reusable protocol). | M29: the probe leaves once the plan holds the numbers. |

## 1. The cell — `components/AnimatedThumb`

One component replaces the bare `OsThumbnail` on every clip cell (photos keep `OsThumbnail`):

- Base: `OsThumbnail` (assetId, kind, version, px) — always mounted, never keyed by anything that changes with playback.
- Playing layer, mounted only while the controller says `playing`:
  - video / motion: a `VideoView` over a POOLED player (`surfaceType="textureView"`, `nativeControls={false}`, `contentFit="cover"`), opacity 0 until `onFirstFrameRender`; on mount the layer borrows a player, sets `loop`, `replace({ uri })`, `play()`; on unmount it pauses and returns the player. A `playToEnd` before the source has ever reported playing is ignored (an empty player's ENDED, Playback's header).
  - GIF: `expo-image` with `autoplay`, opacity 0 until `onLoad`.
- Kind mark (D8): a small glyph in the corner the StateDots row does not use (the corner is a device-pass call), from the phase-7 chip vocabulary; `pointerEvents="none"`.
- Props: `{ row (id, kind, uri, version, animated: 'video'|'motion'|'gif'|null, motion), px, index, cells }`. Subscribed, not re-rendered: the cell reads its own playback from the list's controller (`useCellPlayback(cells, index, id:version)`), so only a cell whose answer changed re-renders, and the list's `data` / `extraData` never change with the playing set (a change there resets React Native's viewability).

## 2. The controller — `lib/animatedCells.ts` (pure) + `components/useAnimatedCells.ts` (impure)

Pure, unit-tested (`animatedCells.test.ts`):
- `playingSet(settled, visible)` = settled ∩ visible (D5: entering waits, leaving stops).
- `poolSizeFor(columns, listHeight, tileDp, partial)` (D6).
- `spotWalk(playing, kinds)` = the non-GIF cells in order; `nextSpot(spot, length)`.
- `mode` semantics: `off` → empty playing set; `one` → the spotlight only; `all` → the playing set.

Impure hook, one per list:
- Feeds `visible` from the list's `onViewableItemsChanged` with `{ itemVisiblePercentThreshold: 1, minimumViewTime: 100 }` (D5, any part) — the rule is fixed at mount (FlatList), so the list is keyed by it.
- `settled` = `visible` after `SETTLE_MS` of no change; `playing` = `playingSet(settled, visible)`.
- The spotlight: `spot` advances on `onEnd` or `DWELL_MS`; a new settled set restarts the walk.
- The pool: made in the same tick the mode turns on (BEFORE the cells' effects run — a child's effects precede its parent's), released when the mode turns off or the list unmounts.
- Reads the setting (D3) through the same provider the Playback rows use; a null mode animates nothing until read.

## 3. The pool — `lib/playerPool.ts`

`makePool(size)`: `size` players from `createVideoPlayer(null)` with D11 applied; `borrow()`/`giveBack(player)` (pause, mute); `release()` releases every player and marks the pool dead so a late giveBack is dropped.
Pools are per list; the deck screen therefore holds the stage's players (M26) AND the strip's pool — the device pass measures the deck with the strip animating (a 52 dp strip pool is 7 × (1 + 3) = 28 by the formula, capped at the strip's visible slots plus two; the cap is the device pass's number).

## 4. The setting — `lib/playbackPrefs.ts`

Key `animated_thumbnails`, values `off | one | all`, default `all` (D3), parsed with the same fail-safe as the modes (an unrecognised value is the default).
Settings › Playback card: a third segmented row **Animated thumbnails: Off · One at a time · All visible** with the card's shared explanation extended by one sentence ("Thumbnails play their clips while on screen; GIFs follow this too").
The UI gate's `playback off` preflight parks this row on Off as well (a playing cell keeps `uiautomator dump` from idling — the phase-5 finding).

## 5. Surfaces (D9) and their visibility source

| Surface | List | Visibility | Pool geometry |
|---|---|---|---|
| Progress grid (`PhotoStateGrid`) | FlatList, 3 columns | viewability | 3 × (rows + 3) |
| Cull list grid (`CullListScreen`) | FlatList, 3 columns | viewability | 3 × (rows + 3) |
| Queue grids (`QueueGrid` cells in the share/organize FlatLists) | FlatList, 4 columns | viewability | 4 × (rows + 3) |
| Timeline cards (`TimelineScreen` → `UnitCard`) | FlatList of cards (viewability already used) | a visible CARD's thumbs are all visible | 5 × (cards + 3) |
| DayProgress cards | ScrollView | card visibility from `onLayout` + `onScroll` (the one non-list surface; or the screen moves to a FlatList) | 5 × (cards + 3) |
| History, Favourites, Edit queue rows | FlatList, one thumb per row | viewability | 1 × (rows + 3) |
| Deck strip | horizontal ScrollView | `onScroll` + the strip's own geometry (`lib/stripScroll.ts` already knows it) | visible slots + 2 |

Each surface swaps `OsThumbnail` for `AnimatedThumb` on its clip cells and mounts the hook; the pruning decision (D9) is per surface at the device pass.

## 5b. Decoders (measured 2026-09-18, `dumpsys media.resource_manager`)

Both phones declare 16 concurrent instances per hardware decoder type (AVC and HEVC each; the vendors' `media_codecs` tables).
The S23 with 18 players on screen ran 16 `c2.qti.hevc.decoder` — the limit exactly — plus 2 `c2.android.hevc.decoder`: players past the limit FALL BACK to the software decoder and keep playing, at CPU cost (the S23's janky frames doubled from 12 to 22 players).
That fallback is why there is no ceiling (D2): every visible clip plays, and the floor phone's cost at a full screen (four cores in the spike) is the software decoders' share.
The tester's S10e scroll stalls (an 814 ms frame, "Skipped 31 frames", 2026-09-18) had two parts. FIXED: a feedback loop — React Native resets a list's viewability whenever `data` or `extraData` changes, and an `extraData` that followed the playing set emptied the visible set on every change, which regrew row by row: sixteen players handed back and re-borrowed within a second. Cells now SUBSCRIBE to the controller (`useCellPlayback`, a stable store), the list's props never change with the playing set, and the S10e's sink shows the set shrinking a row at a time through a scroll and growing once on the settle, with no skipped-frame line over six scrolls. OPEN: both recorded stalls fall as the S10e's players go from 16 to 17, with `MediaCodec::reclaim(OMX.Exynos.avc.dec)` in the app's own process at that instant — the S10e's OMX stack RECLAIMS a hardware decoder from one of our players instead of giving the newcomer a software one, as the S23's Codec2 does.

## 6. Validation against the driving cases

- **Motion-as-GIF parity (M16's point):** a grid of motion photos moves together under All visible (the probe at 24 cells, both phones); one at a time walks them.
- **GIF parity (the phase-5 observation):** GIF thumbnails move again on every surface, following the row.
- **Videos preview:** a video's first seconds play in its cell; the stage's Playback is untouched.
- **A deep scroll stays smooth:** D5 + D6 — measured on the S10e (frame-time percentiles unchanged stopped vs running) and felt on the S23 under thermal load.
- **Nothing black:** D7, measured.
- **Off means off:** the row's Off animates nothing and the kind marks still say what each cell is (D8).

## 7. Implementation phases

1. **The shared pieces — LANDED 2026-09-16**: `lib/playerPool`, `lib/animatedCells` (+ tests), `lib/motionClips` (the shared one-in-flight clip resolver, the stage's overlay on it too), `components/useAnimatedCells`, `components/AnimatedThumb` with the kind mark (top-left; the StateDots sit bottom-right), the setting row and pref (`animated_thumbnails` in lib/animatedCells), the gate preflight and its positive leg; the Progress grid and the cull list wired; the probe deleted (D13). Five codex rounds shaped it: resume after a background return (AppState in the active predicate), the player layer keyed by the row version, cells keyed by identity (index + id:version) through the settle, the walk and the cell's decision, one hand-over per spotlight turn, the extension MIME fallback for untracked rows only, a remembered clip failure, and the gate reading a wrapped row title by nearest chip. S10e gate green with the positive leg.
2. **The remaining surfaces**: queue grids, Timeline cards, DayProgress cards, the three row lists, the deck strip.
3. **The device pass**: both phones — every surface judged (prune per D9), the deck screen with the strip animating measured (heap, CPU) against the stage's own playback, five minutes of grid browsing UNPLUGGED on each phone for battery, the S23 under thermal load, the S10e gate. Phase 6 closes on that pass with the appendix entries vetted.

## 8. Testing

- Unit (pinned, `lib/animatedCells.test.ts`): the playing-set rule across enter/leave sequences with the settle; pool sizing per geometry; the spotlight walk skipping GIFs and restarting on a new set; the mode's three values.
- Device recipes (docs/ANDROID_DEVICE_TESTING.md §6): the scripted 300-cell scroll with frame-time percentiles stopped vs running on each surface's list; the no-black recording check (flat-tile detector).
- Gate: the preflight parks the row on Off; one step turns it to All visible on the Progress grid, asserts a `[thumbs] playing` sink line names cells, and parks it Off again.
