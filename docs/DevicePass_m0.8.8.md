# m0.8.8 device pass — the ship gate

The human pass for release m0.8.8 on the **S23** (the ship-gate device — the F22 report came from it), with S10e spot-checks only where marked.
Fill in every **Result** (pass / fail / skipped) and add anything you noticed under **Feedback** — a blank Feedback line means "nothing beyond the result".
Delete this doc when the release ships; failures reopen the plan.

Build under test: **0.8.8 (versionCode 15)**, installed 2026-08-26 on both devices.
Reference agenda: [Plan_m0.8.8.md](Plan_m0.8.8.md) "Device pass".

**Pulling evidence** (any test that looks wrong): screen-record it, and pull the diagnostics sink —

```bash
scripts/android-device.sh adb R5CW20KBA2W pull /sdcard/Android/data/com.afterglow.companion/files/diag ./s23-diag
```

---

## 0 · Pre-flight (S23)

⚠️ The S23 had **939 MB free** after install. The fresh install runs a first full scan whose embedding data on a big library may not fit — free some space first, or expect the scan to fail loudly.

1. Launch, grant permissions, let the first scan finish (Home shows a percentage; a big library takes a while).
2. Confirm Home's totals look sane for the library.

**Result:** Pass
**Feedback:**

---

## 1 · F22: deep zoom per format tier (S23)

For **each** tier — a 12MP shot, a 50MP-mode JPEG, a 200MP-mode JPEG, a HEIC (both sizes if available), and a DNG:

1. Open it in the deck (or viewer), pinch to **maximum zoom**, and let it settle.
2. Judge the settled view: **pixel-sharp?** (This is the original F22 complaint — softness vs Samsung Gallery.)
3. Pan around at depth — slow pans, fast momentum flings, direction changes.
4. Watch for: content jumps on patch arrival, wrong-content flashes, squares/tearing, sharp↔soft shimmer while panning.

Expected sink lines while you do this: `[perf] zoom base …` once per photo, `[perf] zoom patch …` while zoomed past ~4.5×.

| Tier | Result | Feedback |
|---|---|---|
| 12MP | Pass | |
| 50MP-mode JPEG | Pass | |
| 200MP-mode JPEG | Pass | |
| HEIC | Pass | |
| DNG | Pass | |

---

## 2 · HEIC hardware warm-up timing (S23)

The S10e's software HEIC path made the first decode cost like a full decode (0.8–2.5 s); the S23's hardware path is expected to be much faster — this measures it.

1. Swipe to a HEIC photo, wait ~1 s (the dwell warm), then zoom immediately.
2. Was the base already sharp when the zoom started, or did you catch it soft?
3. Check the sink's `zoom base` timing for the HEIC.

**Result:** Pass
**Feedback (timing if you pulled it):**

---

## 3 · Gesture feel (S23, the unified tracker)

1. **Focal lock:** zoom in and out repeatedly at different screen positions — the content under your fingers must stay under them, every time, including the very first frame of a pinch.
2. **First pinch from unzoomed:** on several photos, start a slow, deliberate pinch from scale 1 (with some horizontal drift) — it must never freeze or hand the stream to the pager.
3. **Walking pan:** two-thumb alternating shoves at depth — continuous, no jumps at finger changes.
4. **Hold-then-lift:** pan precisely, stop, hold a beat, lift — the photo must not move at all on release.
5. **Deliberate flick:** a real fling must still glide with momentum (the 150 dp/s dead-band must not deaden it — tunable if it feels wrong).
6. **Scale breathing:** during two-thumb shoves, the scale may breathe a percent or two with content locked (the engagement gate was removed) — is it noticeable/objectionable?

**Result:** Pass
**Feedback:**

---

## 4 · F23 + F24: the advance (S23 or S10e)

1. Decide the **last** photo of a group with earlier unreviewed members → the cursor must jump **back** to the nearest pending.
2. Decide **mid-group** with an already-decided neighbour ahead → it must **skip** to the nearest pending, not land on the decided one.
3. **Re-decide in browse mode** → the cursor stays put.
4. Decide with **nothing pending left** → stays put; the unit-advance takes over.
5. Judge the **long-skip feel** (a jump across many photos): fly vs snap — is the current animation right? (Named tunable.)

**Result:** Pass
**Feedback:**

---

## 5 · F28: the verdict row (S23)

1. Row reads **Keep · Compare · Not related · Cull** in groups, singles, and browse — identical geometry in all three (Not related dimmed where inapplicable, never missing).
2. Fat-finger check at real thumb speed: are Keep/Cull comfortably separated from the middle pair? (Weights 1.4 : 1 are tunable.)
3. Do the ¼-width middle labels fit on the S23's width, or does the pre-registered icon+short-label fallback need to trigger?

**Result:** Pass, I would however like to try 1.5 and 1.6 to see if that feels better. It does look and feel okay for now.
**Feedback:** Compare reads "Compare with..." for singles, and "Compare" for groups? This is a red flag. This tells me that there is still some code difference between singles and groups for these pages when it should be exactly the same component just with different props to render the different copy between singles and groups. The behavior, the buttons, all the logic behind them, the deck, tthe thumbnail photos, everything should be exactly the same. No code duplicated between singles and groups. However, seeing that the compare has different copy for singles and groups, this is a major red flag and is telling me as someone that hasn't seen the code that there are skeletons in the closet here that need to be cleaned out. Why is the code different between singles and groups? Why is this not a single component with the same interface, the same JSX effectively. This is a major red flag for me.

---

## 6 · F29: Compare decides (S23 or S10e)

Run all four outcomes in a **group** (this exercises the codex-round-1 fix — the fourth case used to abort):

1. **Keep {N}**, decline the prompt → N kept, other stays open.
2. **Keep {N}**, accept "Cull the other photo?" → keep + cull.
3. **Cull {N}**, decline "Keep the other photo?" → cull only.
4. **Cull {N}**, accept "Keep the other photo?" → **must succeed** (cull + keep, one duel row).
5. Tick **"Remember this answer"** in one direction, verify it auto-applies next time, then reset it in Settings and verify the prompt returns.
6. The prompt must **not** fire when the other photo is already decided.
7. **Close — no verdict** still leaves both untouched.

**Result:** Pass
**Feedback:** Is the toast really needed? I don't think it is? Toasts are used for warnings and such right? We can see the results of the compare in the decision glyphs, do we really need the Toast? My feeling is no.

---

## 7 · In-place edit revalidation (either device)

1. Zoom deep into a photo; note a detail.
2. Without leaving the deck, switch to an editor (via the app switcher), edit that photo **saving over the original**, and return to Afterglow.
3. The zoomed view must show the **edited** pixels within a moment of returning (a brief re-sharpen is expected).
4. Known accepted gap: the *unzoomed* pager thumbnail may still show the pre-edit frame (app-wide cache class, parked in TODO) — note it, don't fail it.

**Result:** Fail, I had to leave the review page, go to the home screen, and come bacck to the group to see the edit
**Feedback:**

---

## 8 · Observation items (S23, no pass/fail — judgment)

1. **Settle sharpen-in:** the focus pop when the settle patch lands — visible on the S23's bigger screen? Objectionable?
2. **Advance-while-zoomed transient:** decide while deeply zoomed — any visible blink on the swap?
3. **HEIC content correctness at depth:** deep-zoomed HEIC regions must show the RIGHT content (the 512-tile alignment fix was confirmed on the S10e; re-confirm on the hardware decoder).
4. **"Reset to no zoom":** the one-off unexplained zoom reset from an earlier S10e session — does anything like it appear?
5. **Memory:** any OOM, blackouts, or `[zoom] memory trim` / `margin clamped` lines in the sink during heavy zooming across the biggest photos.

**Result:** All working well, no changes needed.
**Feedback:**

---

## 9 · The Samsung Gallery comparison (S23 — the original acceptance bar)

Side by side on the same 50MP and 200MP photos: Afterglow's deep zoom vs Samsung Gallery — sharpness at settle, behavior during pans, overall feel.
The bar from the feedback round: **as good or better**.

**Result:** Pass
**Feedback:** As Good, although I noticed on the 200MP photos that I could zoom in more in Gallery than I could in Afterglow. I want our zoom to be even more than Gallery, can we increase it further?

---

## 10 · S10e spot-checks (only if something above failed, plus these two)

1. Hold-then-lift and flick feel with the final build (the 150 dp/s dead-band landed after your last full pass).
2. One deep-zoom sweep on the 50MP JPEG to confirm nothing regressed since your "feels perfect" build (three codex-fix rounds landed after it).

**Result:** Pass
**Feedback:**

---

## Verdict

- [x] **PASS — tag `mobile-m0.8.8`** (all sections pass or accepted; section 7 re-scoped to its zoom-layer criterion with the URI-cache class parked — Tristan, reopen rounds 1–3)
- [ ] **FAIL — reopen** (list the failing sections above)

**Overall feedback:** Some minor issues, especially with the really long everything load, that is the biggest regression by far. I also noticed that the group of Hi Res photos take s a long time to load (See recording Screen_Recording_20260826_120115_Afterglow.mp4), but I am not sure if there is anything we can do about this.

---

## Reopen round (2026-08-26, after the first fill-in)

**Section 7 resolved by controlled repro** (sacrificial photo, in-place byte swap over adb, background→foreground): the zoom pipeline revalidated within 400 ms (stale log + fresh decode in the sink) and the ZOOMED view showed post-edit pixels; the stale content you saw is the URI layer underneath (pager page + thumbnail strip — expo-image's uri cache), the app-wide class parked as TODO "Stale rendered pixels after an in-place edit".
**Section 5's red flag defused**: one deck component; the label branches on candidate count ("with…" = a picker follows, >2 eligible), not on kind — live-proven showing "Compare with…" in a group.
**Overall-feedback items diagnosed**: the Everything stall (three-part diagnosis, TODO) and the hi-res black stage (~5 s of full-size JPEG decodes for pager/thumbs; content:// thumbnail fix direction, TODO).

**Changes in the retest build** (gates green; awaiting ~1 GB free on the S23 to install):

1. Verdict-row weight 1.4 → **1.5** — judge it; 1.6 is the next step if still tight.
2. Compare's success toasts **removed** (failure surfaces stay).
3. Max zoom deepened past Gallery: headroom 2.5 → **3**, ceiling 48 → **64** — re-run the 200MP Gallery comparison.

**Result:**
**Feedback:**

Then tick the Verdict above.

### Reopen round 2 (installed on both devices)

Section 7's park CONFIRMED (the fix shape depends on m0.9's content:// thumbnail decision — TODO 12 + 14 decide together).
Round-1 results: toasts verified gone; 1.5 rejected (1.4 preferred so far); 64× still not deep enough.

1. Compare label pinned to **"Compare"** always (the picker still opens by candidate count) — confirm.
2. Verdict-row weight now **1.6** — judge against your remembered 1.4; the loser reverts.
3. Zoom now **headroom 4× past 1:1, ceiling 96** (200MP ≈ 71× on the deck) — re-run the Gallery comparison.

**Result:**
**Feedback:**

### Reopen round 3 (installed on both devices)

Round-2 results: label pin confirmed good, **1.75 ACCEPTED** for the verdict row.
Zoom depth showed diminishing returns per headroom point; trialing **10× past 1:1** (ceiling 240; 200MP ≈ 178× deck, 12MP ≈ 44×).
Known trade at this depth: bilinear smoothing may mask micro-contrast — if depth stops helping, the next lever is nearest-neighbour rendering at extreme zoom (a pixel-grid mode, m0.9-shaped), not more scale.

**Result:** Pass — 10× accepted ("the level of zoom I was looking for"); 1.75 accepted; label pin and toast removal confirmed in round 2. The pixel-grid mode is parked in docs/TODO.md.
**Feedback:**
