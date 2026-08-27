# MediaStage — the shared stage component (m0.9 phase 1 design)

**Status:** drafted 2026-08-26 from two full code maps (the zoom-machinery divergence table and the stage-adjacent consolidation map); open decisions listed at the end.
**Canonicality (Tristan, 2026-08-26):** the deck stage is the gold standard — hundreds of judged iterations; its current behavior is the specification. The MediaStage's driver and overlay code is lifted **verbatim from DeckScreen**, never synthesized; the viewer and Compare align to deck behavior wherever their divergence is not deliberate product semantics (Compare's flip, stacked panes, stage-rect clamp, max-of-pair). Consequently the deck port is mechanical relocation of its own tuned code — the biggest risk surface gets the smallest delta.
**Mandate:** [Plan_m0.9.md](Plan_m0.9.md) phase 1 (M10) — maximal consolidation of DeckScreen, PhotoViewer, and CompareScreen's stage machinery into one component, so phases 2 (URI/cache), 4 (playback), and 6 (overlay chrome) each write once instead of three or four times.
Delete this doc when phase 1 lands; the durable contract distills into the component's header.

## Why "media stage", not "zoom surface"

The maps found four write-once units, and only the first is zoom:

1. **The overlay stack** — backdrop → URI image → base → two patch slots → fail-soft notice — exists in four copies (Compare duplicates it per pane), including the S10e-recording rationale comments. Purely mechanical duplication, and it is the exact tree the playback slot must join.
2. **The chrome tier** — metadata badge, position counter, badge cluster, the notice — is what phase 6 rewrites (nine-item overlay vocabulary, the widened eye). Written per-surface today, in three different renderings.
3. **The source tier** — every render site re-derives `source`/`recyclingKey` from `{uri, id}` by hand; no `cachePolicy`/`cacheKey` exists anywhere. Phase 2's `content://` + `mod_time` switch wants one derivation function.
4. **The playback slot** — phase 4 needs a permanently-mounted `VideoView` (accepts `player: null`; props-only swaps) under the same detector, per the stable-view-tree rule.

## The component boundary

### MediaStage owns
- The optional decorative **`stageFrame`** tier and the measured **borderless stage** box (the m0.8.8 rule, uniform already); `onStageLayout(w, h)` callback for consumers that need React state (the deck's `pageW`).
- The **detector host**: `InterceptingGestureDetector` + `VirtualGestureDetector`s (never a plain `GestureDetector` — the app-wide rule).
- The **gesture drivers** built inline in the shared file (the de-workletization rule): stage pinch, overlay pan, overlay double-tap — parameterized by `arbitration: 'pagerNegotiating' | 'singleDriver'`, `panBoundsMode: 'photoEdges' | 'stageRect'`, `doubleTapMode: 'zoom' | 'none'`, `onSingleTap`.
- The **zoom transform state**: scale/translation/saved values, `zoomTracking`, `overlayOwnsStream`, `imageAspect`, `maxScale` (fed by a shared `useMaxScale(sources)` that already handles Compare's max-of-pair).
- The **overlay stack**, per pane (`panes: 1 | 2` with a `visiblePane` flip prop for Compare's stacked pair under one transform), with the region-zoom hook instance(s) wired inside; identity gating via an `identityGate` predicate prop (the deck passes its live-vs-frozen check; others default to the `forPhotoId` gate).
- The **fail-soft notice**: stage-owned, un-hideable (M19), one copy, normalized gating (see drift fixes).
- The **chrome slots**: a declarative `overlay` descriptor — `topLeft` metadata items, `topRight` position, `bottomLeft` badge cluster — plus `chromePlacement: 'inStage' | 'hostBar'` (the viewer keeps its top bar). The item LIST is built by a new pure `lib/stageOverlay.ts` beside `photoBadges.ts`; phase 6 rewrites that one builder and the Settings section, never the JSX. The eye moves from `BadgeCluster`-internal to this layer (M20's widened scope).
- The **source derivation**: a `MediaSource` descriptor — `{ id, uri, contentUri?, modTime, kind }` — with one internal function deriving `source`/`recyclingKey`/`cacheKey`/`cachePolicy` per role (`page` | `underlay` | `zoom` | `thumb`). Phase 2 edits this function only. (The same descriptor serves the seven non-stage thumbnail consumers via a sibling shared thumb component — in scope for phase 2, not phase 1.)
- The optional **underlay slot** (the deck's decode underlay; posters later) and the optional **playback slot** (phase 4: one stage-level `VideoView`, permanently mounted, `player` prop-gated, positioned between pager and zoom overlay; absent — not merely disabled — on Compare). Phase 1 builds the slot positions, not the players.
- A single **`onPageSettled(item)`** event so phase 4 gets one autoplay hook instead of three.

### The screens keep
- **Deck:** the unit-keyed FlatList and all freeze/settle/alignment machinery (`unitKey`, `heldViewRef`, `inert`, `jumpTo`, the settle window), the thumbnail strip, verdict/chip/finish controls, the unit-advance `flushRegionZoomRetention` call.
- **Viewer:** its Modal shell, pager (with its `useNativeGesture` link passed in as `pagerGesture`), dead-photo bookkeeping (`deadIds` — passed to the stage as a `deadNotice` state for the overlay branch), top bar, facts panel, StateEditorSheet.
- **Compare:** pair loading, the flip timer and A/B semantics (`onSingleTap` = flip; `visiblePane`), verdict buttons, prompts.
- The viewer-over-deck coupling is untouched by construction: each mounted MediaStage instance runs its own `useRegionZoom` hook(s), so the ref-counted trim pins and single-flight base decode keep working per instance.

## Divergence dispositions

The 31-entry divergence table (in the phase-1 exploration record) resolves into three buckets:

**Parameters** (surface-declared, preserved exactly): pan-bounds mode (D1 — REVISED at the S23 device leg: the "deliberate" stage-rect clamp was a bug the tester could pan into — Compare now clamps to the per-axis UNION of the pair's rendered edges (`pairPanBounds`, unit-pinned), which reduces to the deck's `panBounds` for equal aspects; the stage rectangle survives only as the both-aspects-unknown fallback), max-scale policy (D3), two-finger drive predicate ordering (D6 — Compare pinches from scale 1, no pager to protect), tap semantics (D13–D15), notice offset (D18), backdrop color (D19), page-width source (D27), zoom persistence across the A/B flip (D31), frame tier presence (D28).

**Unified by the move** (duplicates that die): `clampPan` ×3, the max-zoom header comment ×3, the `regionStageSize`/`regionViewport` callback pairs ×3, the patch-slot JSX ×4, the notice ×3, the accessibility `pointerEvents` mirroring.

**Drift fixes** — behavior changes, landed deliberately and listed (they are m0.8.8's correctness classes applied to the surface that missed them; each is a fix, not an equivalence break):
1. Compare gains `onTouchesCancel` resets on both drivers (D8) — a stolen stream no longer leaves a stale anchor.
2. Compare gains a driving-gesture finalize/unwind and the "never zoomed" early-out (D9, D12).
3. Compare's pinch `onBegin` resets tracking (D10).
4. Compare's base/patch slots gain the `forPhotoId` identity gate; its notice gains the same gate (D16, D17). The notice's always-visible-when-failed behavior on Compare is *kept* (it has no zoom-only overlay; the fact is true unzoomed too) — only the wrong-photo window closes.
5. Compare's dead `isFocused` is either used (focus-gating its hooks like the deck) or deleted — decided at implementation; focus-gating becomes load-bearing once players exist, so the default is **use it**.
6. The Compare file header's stale `panBounds` claim is corrected (D1's contradiction).

**Deliberately NOT unified in this phase:** the deck's activation-claim pager negotiation vs the viewer's `useNativeGesture`+`simultaneousWith` (D4). Both are device-proven under different hosts (native FlatList scroll vs Modal-wrapped list); unifying them is gesture-arbitration risk with no phase-6/4/2 payoff. The stage accepts an optional `pagerGesture` prop and otherwise uses activation-claim. Revisit only if the device leg shows a defect.

## Equivalence strategy (honest about the gap)

The pure suites (`zoomTarget.test.ts`, `regionZoom.test.ts`) fully pin the math and run unchanged — they prove the shared drivers call `zoomTouchFrame`/`planPatch` with the same contracts.
**The impure layer (arbitration wiring, slot double-buffering, pins, timers, mount order) has no test coverage today**; the refactor cannot lean on tests it doesn't have. Mitigations, in order:
1. `useRegionZoom.ts` is **not modified** in this phase — the highest-risk shared machinery moves zero lines.
2. New pure units get unit tests: `lib/stageOverlay.ts` (the chrome item builder), the source-derivation function, the pane/gate predicates.
3. A **parameter-parity audit** closes the port of each surface: the divergence table is the checklist; every "parameter" row is verified preserved, every "drift fix" row verified changed, nothing else different (self-review artifact, then codex-review input).
4. The **device leg** (Plan device-pass item 1): the m0.8.8 zoom sweep re-run per surface as each port lands — all format tiers, deep zoom, patch lines in the sink, viewer-over-deck, Compare's pair.
5. The UI gate's frame-level probe steps run against the ported build.

## Build order — status (2026-08-27: code complete, device legs pending)

1. **Shared pure extractions** — DONE: `clampPan` → `zoomTarget.ts` (+ pinning test); `useStageRegionZoom` + `useStageMaxScale` in `components/useStageZoom.ts` (the max-of-panes rule subsumes Compare's pair with zero branches — every real ceiling clamps ≥ floor). `lib/stageOverlay.ts` deferred to phase 6 per settled decision 2 (chrome stays verbatim this phase).
2. **MediaStage component + viewer port** — DONE: `components/MediaStage.tsx` holds the deck's driver code verbatim (`useMediaStage`), the stage tree (`MediaStageView`), the shared pane stack (`StagePaneLayers`, deduping the 4× patch-slot block), and the un-hideable `ZoomFailNotice`. The viewer's `useNativeGesture` pager link is REMOVED (D4 alignment); the escape-hatch `pagerGesture` prop is deliberately not implemented — it is added only if the viewer's Modal-host device leg fails, else it never exists.
3. **Compare port** — DONE via `useMediaStageSingleDriver` (Compare's deliberate structure, drift-fixed). Fixes landed: `onTouchesCancel` on both drivers; the pan's `onFinalize` now owns the end-of-stream anchor reset + ≤1.02 unwind with the never-zoomed guard (the pinch's `onDeactivate` became save-only — the unwind now also covers cancelled streams, which it never did); base/patch slots and the notice gained `forPhotoId` identity gates; `isFocused` now gates both region hooks (the dead variable became load-bearing); the stale `panBounds` header claim corrected. **Fix 3 refined at implementation:** a pinch-`onBegin` tracking reset was NOT added — a full reset would clobber the `zoomed` marker the pan's fling check reads (the codex-r1 class), and a partial reset duplicates what the pan's `onBegin`/`onTouchesDown` already do on the same events; the cancel handlers close the actual hole D10 described.
4. **Deck port** — DONE, mechanical: the deck consumes its own relocated code (`useMediaStage` + `MediaStageView` with `frameStyle`, `onStageLayout`→`pageW`, the live-vs-frozen `identityOk` gate, chrome as verbatim JSX in the chrome slot, pager + decode underlay as children). The cold-open last-photo branch keeps its own frameless container (`coldStage`).
5. **Header distillation** — DONE: MediaStage.tsx's header is the authoritative contract; the three screens carry citations; `apps/mobile/AGENTS.md`'s SIGSEGV/detector pointer moved to MediaStage.tsx and the component map gained MediaStage/useStageZoom.

**Gates:** typecheck, 933 tests (57 files), eslint, prettier, and the Metro bundle proof all pass after each port.
**Parity audit:** the divergence table walked post-port — every "parameter" row preserved (backdrops, notice offsets, tap contracts, clamp modes, max-scale policies, page-width sources, A/B zoom persistence), every "unified" row dead (clampPan ×3, the max-zoom comment ×3, callback pairs ×3, patch JSX ×4, notice ×3), drift fixes as listed above.

## The review cycle and device leg (2026-08-27)

- **codex round 1: three reviewers, ZERO findings** (codex-review.md) — deck parity confirmed by direct comparison in all three, the drift fixes and fix-3 refinement endorsed, the further worklet-helper consolidation unanimously rejected as risk-without-payoff.
- **UI gate: PASSED on the S10e** (all 33 steps; one non-reproducible transient in a run started seconds after a reinstall — no crash, launcher walkout, clean on re-run).
- **S23 manual pass** produced two findings, both root-caused by frame forensics + the sink:
  1. **Pinch-vs-pager aggressiveness** (deck + viewer; pre-existing m0.8.8 behavior surfaced by the pass, not a port regression): the pinch waited for the recognizer's span threshold before activation claimed the stream, so the pager owned the first centimetres of every pinch. FIXED in `useMediaStage`: the stage pinch **force-activates the instant a second finger lands** (`GestureStateManager.activate`, a v3 worklet) — the claim mechanism is unchanged, only the wait is gone. One edit fixed both surfaces.
     **Parked residual** (Tristan, accepted): if finger 1's drag crosses the touch slop before finger 2 lands, the native scroll has captured and RNGH has cancelled the pinch — no activation can reclaim; the pager freezes at a partial offset until lift, and a retry works. Full fix = wrapping the deck FlatList in an RNGH native handler so activation can interrupt a captured scroll; deliberately not done (an arbitration change to proven machinery for a rare, self-recovering edge). Trigger: it keeps irritating in daily use.
  2. **Compare deep-zoom pan jank on hi-res pairs** (real, measured, time-correlated not pane-correlated — the frame/sink correlation showed the stalls tracking bitmap-churn storms and OS memory trims, not the visible pane): the sink showed **every viewport change decoding PAIRED ~72–91 MB patches for both panes, hidden included**. FIXED: `useRegionZoom` gained a `patchesEnabled` gate — Compare's **hidden pane keeps its base warm (instant flip) but is otherwise patch-free**: disabling clears its slots, plan, and pending apply, and completions landing after the hide are discarded. (The first cut kept stale slots mounted for an "instant sharp flip-back" — the S23 retest showed those slots rendering pre-hide regions as displaced sharp boxes over the post-flip view, masking the flip itself on a near-identical pair; corrected same day.) The newly visible pane sharpens in ~1 s after a deep-zoom flip (trade accepted by Tristan).
- **D4 verdict:** the viewer's pager under activation-claim inside its Modal host passed the manual pinch checks — the escape hatch is never built; the mechanism is unified for good.

## Remaining before phase 1 closes

- Tristan's confirmation re-test on the S23 (pinch feel + Compare pan on a quiet device).
- **The pixel-honesty spike** (M13, ~half a day, on-device) — runs on the consolidated render path this phase produced.

## Open decisions

1. **Drift-fix policy** — SETTLED (Tristan, 2026-08-26): land all six with the Compare port, each named in the commit, verified in that port's parity audit. Alignment to the deck's behavior needs no per-item debate (canonicality above).
2. **Chrome descriptor depth in phase 1** — SETTLED (Tristan, 2026-08-26: "easier, less code, least risk; all adopt what the deck does"): phase 1 reproduces today's chrome verbatim behind the slots + builder (a pure refactor, parity-auditable); **phase 6 converges everything on the deck's rendering and in-stage placement** when it rewrites the builder for the nine-item vocabulary — the viewer's duplicate top-bar facts resolve then, and Compare keeps only its functional pane label (M21: never hideable).
3. **D4 pager negotiation** — SETTLED (same ruling): the viewer aligns to the deck's activation-claim mechanism; the `pagerGesture` prop survives only as the escape hatch if the viewer's Modal host proves to need the explicit `useNativeGesture` link on the device leg. If the hatch stays unused after the port, it is deleted.
