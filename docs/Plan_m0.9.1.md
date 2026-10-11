# Plan — m0.9.1: the accessibility pass

**Status:** building (auto-work session from 2026-10-08; judgment calls in `autowork.md` at the repo root until the close-out grilling vets them).
**Scope source:** PLAN.md's m0.9.1 paragraph, settled in the 2026-10-08 pre-build grilling (seven questions, the decision record below).
**Versioning:** app.json `version` 0.9.0 → 0.9.1, `android.versionCode` 16 → 17, package.json 0.9.0 → 0.9.1; tag `mobile-m0.9.1` (the preflight's non-zero-patch form).
**Schema:** unchanged (v27). No native code changes: the pixel-honest deep-zoom build moved to m0.9.2 (grilling Q1).
Delete this doc when the release ships; durable behavior distills into PLAN.md, docs/STATE_MODEL.md, docs/IOS.md and code headers.

---

## Decisions settled in the pre-build grilling (2026-10-08)

- **Q1 Scope.** The pixel-honest deep-zoom build is its own release, m0.9.2, with its real-pixel device pass and the API 30 floor emulator run. m0.9.1 carries the five JS-side items.
- **Q2 Order.** Spike → tokens → pills → flip → close-out. The emulator gate runs at the close on the release artifact; the S10e gate per phase as before.
- **Q3 The spike comes first** and briefs the token pass. iOS is not supported, but building toward it starts now: docs/IOS.md is the ledger of what iOS support must handle, Dynamic Type its first entry. Every Text site is audited: its container class, the scale at which it breaks (measured), and the lever that fixes it. A cap (`maxFontSizeMultiplier`) is the lever of last resort; containers that grow come first.
- **Q4 Segmented sweep.** All three chip rows (daily goal, keeping-up, grouping strictness) become segmented controls; the five-option rows take one-word labels that fit, the hint carrying the meaning; fit verified at the policy scale.
- **Q5 Flip.** The stage-frame transform on shared values is prototyped first (the chrome fades, the real layout commits under the transformed stage); dip-to-black stays as the Remove-animations cut; judged by Tristan on a screen recording of a photo and a playing clip.
- **Q6 Emulator gate.** The Android 16 Google image (`afterglow-pixel7`) gates the release artifact at the close; a failure holds the tag. The API 30 floor AVD waits for m0.9.2.
- **Pre-flight.** The S23's font size and display size may change through adb during the spike's walks, restored after each walk; app installs only; its camera folder read-only; no DB reset. Each phase lands as a commit and a push to `origin initial`. Tag and release wait for the device pass and the close-out grilling.

Deferred to the close-out grilling, built on autonomous defaults meanwhile: the pinned-height policy per surface, the token shape, and the scales the release gates must pass.

---

## Phases

### Phase 1 — the accessibility spike

Measure before deciding.

1. **The walk matrix.** On the S10e (Android 12), the S23 and the Android 16 emulator: a screenshot walk of every screen at each font-scale step and at three display sizes (default, one step smaller, one step larger), set through `settings put system font_scale` and `wm density`, each device restored to its starting values after its walk. The UI gate runs at 1.0, 1.3 and 2.0 font scale at the default display size, and at 1.0 at the large display size, on the emulator and the S10e; on the S23 the gate does not run (it makes decisions) — screenshots only. Bold text, Remove animations and TalkBack are walked by hand on the S23 at the device pass.
2. **The per-site text audit** (`docs/accessibility-audit.md`, a release artifact deleted with this plan once its findings land in code and STATE_MODEL): every Text site by surface with its font size, its container class (free · fixed height · ellipsized · pinned row), the measured scale at which it breaks, and the proposed lever (grow the container · reflow · ellipsize · cap). The static half comes from `scripts/text-audit.mjs` over the tsx sources; the break scales from the walk's screenshots.
3. **docs/IOS.md** created: the ledger of what iOS support must handle, each entry naming the Android decision it mirrors.
4. **Findings table per surface** at the end of this doc's phase-1 status, which is the brief for phases 2 and 3 and the input to the three deferred decisions.

Exit: the matrix walked on all three targets, the audit complete, the policy drafted as autonomous defaults in `autowork.md`.

**Status (2026-10-09): walked.** All three targets at 0.8–2.0 and the default display size, the phones at the large display size too; `docs/accessibility-audit.md` carries the measured table and the levers; the policy as built is in docs/STATE_MODEL.md ("Text scales; layouts stack") and `lib/textScale.ts` (1.3 and 1.6 effective, relative to the window width). The native header title did not scale at all; Tristan's screenshot review (2026-10-09) found a subtitle matching its title at 1.3 and larger at 2.0, so the title is our text now (`components/HeaderTitle`) and the report's STATIC signal guards the invariant with no exclusions. The two levers phases 2 and 3 needed landed with them. The close-out grilling (2026-10-09) then replaced the thresholds as the decider with MEASURED levers (`components/useTextOverflow`: a surface rearranges when its own label needed a line it is not allowed; the thresholds are the first guess; overflow reports latch until the next scale or width change), verified on the S10e and on 320, 411 and 480 dp emulators. The r15 screenshots at 1.3, 1.5 and 2.0 on the S10e (`~/PhoneSync/current-<scale>x-<screen>.png`) found two overlaps the report could not see (the ring's centre text, the tab badges over their icons; the ring grows by half the font's excess, the badge keeps its 16 dp disc and becomes a dot once its digit outgrows it — Tristan's call, `autowork.md` 43) and the deck squeezed to a sliver of a stage (94 dp at 2.0 on the S10e, about 60 dp at 1.3 on the 320 dp emulator, and none at all there at 2.0: the header, hint and chip rows fill the screen and the chip labels break mid-word) whose time box runs into the kind chip, and the chip row's two-per-row arrangement hiding Organize and Share behind the finish button from 1.3 (Tristan's review: the labels drop to icons instead, each chip keeping its accessibility label) — the stage squeeze is the deck's vertical budget; Tristan's answer (2026-10-11) is the header FOLD (`lib/deckHeader.ts`): measured by the stage's share of the window, flipped by a chevron at every scale, remembered per situation, the strip folding too when the stage stays tight. Residual at 2.0 on the S10e: the stage's kind chip ("Video") is cut by the stage's bottom edge — the badge cluster's bottom anchoring against a chip twice its height, for the grilling (`autowork.md` 53). Tristan's review of the 1.3 set (2026-10-09) settled five more, all in r20 (`autowork.md` 40–46): the header title as our text, the chip row and the edit queue's buttons dropping to icons, the pills as a vertical list past one row, the tab badge as a fixed disc that becomes a dot, and icons that keep their size — the last measured against the OS and two reference apps (docs/accessibility-audit.md, "The OS baseline"). r20 walked clean on the S10e, the S23 and the three emulator widths but the deck squeeze.

### Phase 2 — the type-scale and token pass

`theme.tsx` gains `type` (named text styles with size, weight and line height), `space` (a 4-dp grid) and `radius` tokens; every site maps to a token; the audit's levers for text containers land with them (grow, reflow, ellipsize, cap). Autonomous default shape: six styles — display 28 · title 22 · heading 17 · body 15 · label 13 · caption 11 — spacing 4/8/12/16/20/24, radii card 14 · thumb 8 · pill, one scrim 0.55. Summary's blank loading view and the UnitCard thumbnail-size question ride it. Before/after screenshot pairs from both phones, judged by Tristan as a label round at the close-out.

**Status (2026-10-09): built** — `theme.tsx` tokens (six text styles, four spacing steps, five radii, two scrims; `autowork.md` 7–8 for the shape as built); every site mapped by the codemod; the levers from the walk landed (the stacking rows, the unit card's scaled header, the histogram axis, the tab badge). Device pass and screenshot pairs pending.

### Phase 3 — the segmented control on every single-choice Settings row

Daily goal, keeping-up and grouping strictness move onto `components/SegmentedControl`, the goal rows keeping their write fences; the five-option rows relabelled (autonomous default: Off · Today · 2 days · 7 days · All; Loosest · Looser · Default · Stricter · Strictest) with the row hints carrying the meaning; the fit checked at the policy scale on the S10e.

**Status (2026-10-09): built** — the three rows on `SegmentedControl`, the daily goal with its Custom segment, no selection shown until a value is read (codex round 1). Large text (Tristan's screenshot review): the pill stays one row while its labels fit, measured with no first guess, and becomes a vertical radio list once a label wraps (the three-plus-two pill at 1.3 stretched short labels across full rows).

### Phase 4 — the immersive flip as a continuous animation

The stage frame scales and translates between the framed box and the edge-to-edge box on shared values while the chrome fades; the real layout commits under the transformed stage with the same hold for the native header and status-bar reflows; a playing clip plays through. Remove animations (the animator scale at 0, read through `AccessibilityInfo.isReduceMotionEnabled` and its change event) turns the flip into the existing dip-to-black cut. Judged by Tristan on a screen recording of a photo and a playing clip.

**Status (2026-10-09): built and recorded on the S10e** — `lib/immersiveFlight.ts` + `components/useImmersiveFlight.ts` (the measured host, the aspect snapshot, the committed layout detected by per-frame measurement on the UI thread; `autowork.md` 10, 17, 22, 24), `components/useReduceMotion.ts`, the transparent Deck header. The photo flight glides both ways in the r10 recording (`~/.cache/afterglow-review/flight-r10-photo`); the `[flight]` sink lines carry the geometry. Tristan's judgment on the feel is the device pass.

### Phase 5 — close-out

The release artifact (clean prebuild plus Gradle) gated on the S10e and on the Android 16 emulator (blocking), the scales the close-out grilling chose; both phones on the build; the device pass; the close-out grilling over `autowork.md`; codex rounds on the whole release; the version bump; PLAN.md's m0.9.1 entry; this doc and the audit retire.

Per phase as in m0.9: codex rounds on gpt-6.1-sol after the adversarial self-review, the S10e gate green on the phase's build, a commit and a push.

**Status (2026-10-11): the gate matrix passed on r23** — the Android 16 emulator at font scale 1.0, 1.3 and 2.0 (34 steps each, from a fresh app state over the 332-item seeded corpus; the gate runs at any font scale since the grilling) and the S10e at 1.0 and 2.0 — the cross-OS audit's part one, run as a blocking gate for the first time (r11 passed it first). The S10e gate passed from a fresh state over its 5 408-item library (r11, r18, r20 and r22 before r23); sixteen codex rounds, converging at a clean sixteenth (rounds 1–9 on the app: 2 P1 + 8 P2, 7, 4, 6, 4, 2, 2, 3, 5 P2; rounds 10–15 on the gate's any-scale contract: 1 P1 + 3 P2, 2, 2, 1, 1, 2 P2; all fixed or settled, `autowork.md`) and the S10e gate on r5 preceded it. The device pass and the close-out grilling over `autowork.md` are Tristan's; the tag waits for them.

---

## Device pass (the release-specific gate list)

1. Font size at the largest step and display size at the largest: Home, the deck, Settings, Progress and the Timeline stay usable; nothing overlaps or clips.
2. Bold text on: hierarchy still reads (headings against body).
3. Remove animations on: the immersive flip is a cut; the goal celebration and playback chrome do not animate.
4. TalkBack: the deck's verdict buttons, the tab bar and the Settings rows announce their labels.
5. The flip with a photo and with a playing clip, at the default settings.
6. The three segmented rows at the largest font size.

---

## Autonomous decisions (appendix)

Logged in `autowork.md` as they are made; vetted at the close-out grilling; pruned here as accepted.
