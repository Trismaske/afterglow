# m0.8.4 — steps taken that the code checklist did not name

Companion to [Plan_Code_m0.8.4.md](Plan_Code_m0.8.4.md).
Every entry here is a change made during implementation that was **not** a bullet in that file — a consequence the checklist missed, a judgment call it left open, or a place its wording proved wrong.

Same verbs: `DEL` · `ADD` · `MOD`.
Each entry says what was done and **why the checklist did not have it**.

Nothing here contradicts the plan; the largest cluster (§1) is review class 41 playing out exactly as it predicts — *deletions cascade, so re-grep after every removal, not just before the first*.

_(Deletable with the release plans once m0.8.4 ships; anything durable distils into the permanent docs first.)_

---

## 1. Symbols orphaned by a listed deletion

The checklist named what to delete. It could not name what would *become* unused only once those things were gone — each of these was invisible until the line above it went.

- DEL `CullListScreen.tsx` / `FavouritesQueueScreen.tsx` — the `Platform` import in both. Their only remaining use was the deleted gate.
- DEL `DeckScreen.tsx` — the `Platform` entry in the multi-line `react-native` import block. Same cause, different import shape.
- DEL `CompareScreen.tsx` — the `Platform` import.
- DEL `FavouritesQueueScreen.tsx` — the `styles.unsupported` StyleSheet entry, orphaned with the banner it styled.
- MOD `CullListScreen.tsx` (confirm button) and `FavouritesQueueScreen.tsx` (both action buttons) — **three `disabled` props still read the deleted predicates**, so the code did not compile. TypeScript caught all three; worth naming because they are the load-bearing half of those gates and the checklist listed only the declarations and the visible branches. On a module-absent build these had been silently disabling both queues' primary actions.
- MOD `mediaIdentity.test.ts:5,40` — two `STORAGE_PREFIX` references. The checklist fixed the reference in `mediaIdentity.ts` (which it named) but not the ones in its test.
- MOD `sources.ts` header ×2 — "directory probing" and "the probed bucket directories", describing the deleted probe path.
- MOD `sourceCatalog.ts` ×3 — "one-asset directory probes" in the header, "one MediaStore probe per bucket" in the cache-TTL rationale (the cost is now one cursor walk, which is the whole point of the TTL), and "must not satisfy the probe" in the default-source resolution.

## 2. Copy the checklist scoped to docs, but which also lived in code

§7.1 listed five doc files and two Kotlin comments. These are the same category — a version qualifier that becomes a dead question once the floor is the floor — in files §7.1 did not enumerate.

- MOD `media.ts:8` — "the app's **Android 11+** MediaStore trash-request module". Hedges our own mechanism → prefix dropped.
- MOD `media.ts` (`trashAssets` doc) — "no permanent-delete fallback **below Android 11** or when the native module is absent" → restated as the unconditional invariant, with the module-absent case named separately.
- MOD `scanRunner.ts:844` and `media-store-actions/index.ts:57` — both describe **other apps'** gallery deletes setting `IS_TRASHED`. Treated under the `AGENTS.md:68` rule §7.1 already established: keep the explanation, drop the version prefix.
- MOD `MediaStoreActionsModule.kt:214` — a third "On Android 11+" in the `mediaChangedSince` doc, beside the two §7.1 named.
- MOD `modules/media-store-actions/README.md` — "Android 11+ MediaStore actions" and "reports `unsupported` below API 30 **and** when used in Expo Go". The second half is now the *only* cause, which is exactly what D4 turns on, so the README says so.

**MOD `scanRunner.ts:711` is the one that is not a copy edit.** The comment justified reading mounted volumes independently of generations with "generations are API 30+, this works from API 24" — a *true* independence resting on a *dead* reason. Deleting the sentence would have lost the reason entirely; the live one is that the generation read degrades to `{}` on failure while the mounted read may not degrade at all. Called out because a version qualifier propping up a real invariant is the trap review class 41 is about.

## 3. Judgment calls the checklist left open

- ADD `modules/media-store-actions/index.ts` — `mediaStoreActionsAvailable`'s doc comment now says *why* one predicate replaced four. The checklist said "keep one, repoint callers"; leaving the survivor's doc unchanged would have made the collapse look like an accident.
- MOD `moveMediaToRelativePath`'s row message — the checklist said "name the missing module". Wording chosen: *"Afterglow's media module is not available in this build"*, matching §4.5's three alert bodies. It had no reader when it was written — §6 found that every move-outcome message was dropped at the write — and §7's dialog is what gave it one. Kept as written rather than reduced to a log string, which turned out to be the right call by a few hours.
- MOD `apps/mobile/package.json` — npm resolved `expo-build-properties` to `^57.0.8`; changed to `~57.0.8` to match the plan and every other `expo-*` dependency in the file.
- MOD `dates.ts` — `formatDay` made **private** rather than merely "may become private" (checklist's phrasing). It had no external caller, and a second entry point would let a surface print a differently-shaped date.
- ADD `dates.ts` — `DAY_FORMAT` carries the rejected-alternative rationale (why unconditional beats "only when the year differs"), and `labelForDayKey` now names itself as the chokepoint for every day label. The decision was settled in the grilling but lived only in the plan, which gets deleted at ship.
- ADD `dates.test.ts` — the three new cases assert through **the same `Intl` call the code makes**, not a hardcoded `"17 Aug 2024"`. A literal would pin the test environment's locale rather than the behaviour; what is pinned is that the year is present, that two same-day-different-year keys differ, and that the three non-formatted labels are unaffected.

## 4. Scope the checklist named but did not specify

- MOD `PLAN.md:178-179` — the checklist said "→ settled floor, mechanism, scope". The entry was also converted from the upcoming form (`**m0.8.4 — …(next)**` heading) to the shipped-bullet form the rest of the list uses.
- MOD `apps/mobile/README.md` — the RAW table gained a **"measured on"** column. §9's "RAW policy at the floor" established that the table was S23-only while this release declares Android 11 supported, and the spikes confirmed NEF/ARW/CR3 on the S10e and the API 30 emulator — but left DNG measured on one device. The column makes each row's evidence visible instead of implying one scope for all five.
  The ARW row also gained its known wrinkle (MediaStore dates ARW by file mtime, not EXIF, so a copied file can sort under the copy date). The plan parked the *fix* in `docs/TODO.md`; not telling testers would have left "Fully supported" saying more than the measurement supports.
- ADD `apps/mobile/README.md:~190` — the compat statement also names what the failure looks like (`INSTALL_FAILED_OLDER_SDK` via adb, a bare "App not installed" on-device). §6.4 established that the on-device installer is silent about the cause; the sentence is what makes the README statement actionable.

## 5. The platform half of the deleted gates — kept deleted, deliberately

The six deleted screen gates read `Platform.OS === 'android' && Version >= 30`.
The plan analysed the **version** half and is right about it; the deletion also removes the **platform** half, so the four favourite chips and the best-of-group hand-off offer now render on non-Android too.

**Decision (Tristan, 2026-07-31): leave them unguarded — an iOS version is wanted later, and these surfaces should be there when it arrives.**
Re-adding `Platform.OS === 'android'` would have written a second floor into six screens that a future iOS build then has to find and delete again.

It degrades correctly rather than crashing: the deck chips write the durable queue instead of calling native, and the queue screen's apply lands on `available() === false` → `unsupported`, which is exactly the D4 module-absent path. What an iOS build would still need is a real MediaStore equivalent behind those chips — that is a port, not a gate, and the gate's absence does not pretend otherwise.

Recorded because "no behaviour change on any device that can install it" stays true, while the narrower claim "these predicates were unconditionally true" does not.

## 6. Found on device, not in the plan

- **An organize move failed, and it is not this release's doing.** The first move attempted on the S10e targeted a photo in `Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/`, and Android refuses `RELATIVE_PATH` moves out of another package's `Android/media/` tree. It is a scoped-storage rule, not a version gate — `moveToRelativePath`'s only m0.8.4 change was deleting an `SDK_INT < R` early return that could never fire at API 31. A second move on a `DCIM/Camera` photo succeeded and verified (`relative_path=DCIM/Table Mountain Lapse/`), so the success path is measured too.

  **The failure is safe but unexplained, and that is a defect.** Nothing is lost or silently dropped — the row stays queued and retryable, the toast counts it (*"Moved 0, 1 failed (kept queued)"*), the subtitle counts it (*"1 queued · 1 failed, retried on the next move"*), the cell wears a red `alert-circle`. But the user is told only **that** it failed, never **why**, and retrying will fail forever for that photo.

  The cause is a schema hole, not a missing screen. `moveToRelativePath` already returns Android's own explanation — `"${error.javaClass.simpleName}: ${error.message}"` (`MediaStoreActionsModule.kt:536-540`) — and `commitOrganizeOutcomes` carries it as `outcome.message` all the way to the write, where it writes `state = 'error'` and drops it (`organizeStore.ts:299-304`). `photo_actions` has no column to put it in (`database.ts:89-103`), so no surface can show it, and none tries.

  Fully written up as `docs/TODO.md` **"A failed organize move never says why, and the reason is discarded before anything can show it"** — both fix shapes with their costs, and why the cheap one comes first. Note the irony for §3: the wording chosen for `moveToRelativePath`'s `unsupported` message is copy for a string the same drop swallows, and `unsupported` is folded into the `failed` count besides, so a module-absent build and a platform refusal look identical on screen.

## 7. The one thing that grew into a change

`Plan_m0.8.4.md` §13 carries it in full: the organize-failure dialog. It began here as a finding (§6), and it is in the release because the "persist it" framing that made deferring look sensible turned out to be unnecessary — error rows stay queued, so the next Move regenerates the reason, and a dialog raised from the run is the whole fix rather than half of one. No schema, no reset.

Two things worth carrying out of it:

- **The device pass caught a bug the tests did not.** The first build read *"1 photo live in another app's own storage"*. The plural sentence had a test; the singular one did not, and all four cause lines shared the fault. Copy that interpolates a count needs its `n = 1` case asserted, not just its shape.
- **Android's own words validated a classifier that never reads them.** The dialog diagnoses from the photo's uri; Android independently said *"Changing ownership … not allowed"*. That is the tier-3 quote doing exactly the job it was added for — corroborating a guess without being the basis of one.

## 8. The acceptance pass changed the release again

`Plan_m0.8.4.md` §14 has it in full. Three findings, and the third is the one worth remembering:

**A restriction can be right and still be wrong.** `ORGANIZE_ROOTS` was tagged `(autonomous)` in m0.7 and never vetted. It turned out to mirror Android's real rule exactly — measured in-app: *"allowed directories are [DCIM, Pictures]"* — and it was still the wrong design, because a hand-copy of a platform rule is a second source of truth, and it was stated to the user as if it were ours. The fix was not to change the rule but to change who owns it.

**My own measurement was invalid and I nearly reported it.** An `adb shell content update` accepted an images row into `Download/`, which looked like proof the restriction was arbitrary — until the same probe also accepted `Android/` and `Movies/`, which cannot be right for an app. Shell bypasses the provider's validation entirely. The valid measurement needed the app itself, and it said the opposite. A probe that agrees with your hypothesis deserves the same scepticism as one that does not.

## 9. Process

- The **phase 2 gradle build ran against a phase-2 tree**, before phases 3-7 landed, and a second full `prebuild --clean` + `assembleRelease` ran at the end. Phase 2's proof is native-only, so running it early costs nothing and catches a Kotlin problem before 300 lines of TypeScript deletions can be entangled with it.
- **The final `assembleRelease` failed once and passed on retry, with no source change.** `:app:mergeDexRelease` threw `DexArchiveMergerException: Error while merging dex archives:` with an empty cause — the signature of a dexer worker being killed, and two emulators plus a warm Gradle daemon were resident at the time. Recorded rather than ignored: a build failure that "went away" is worth one line, and the passing build is the one every artifact check below was run against.
- Two commits precede phase 1: the UI-gate screenshot fix and the plan-plus-durables commit, both of which were already in the working tree.
