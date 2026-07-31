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
- MOD `moveMediaToRelativePath`'s row message — the checklist said "name the missing module". Wording chosen: *"Afterglow's media module is not available in this build"*, matching §4.5's three alert bodies. This one is persisted per row by `commitOrganizeOutcomes` and shown in the Organize queue, so it is user-facing copy, not a log string.
- MOD `apps/mobile/package.json` — npm resolved `expo-build-properties` to `^57.0.8`; changed to `~57.0.8` to match the plan and every other `expo-*` dependency in the file.
- MOD `dates.ts` — `formatDay` made **private** rather than merely "may become private" (checklist's phrasing). It had no external caller, and a second entry point would let a surface print a differently-shaped date.
- ADD `dates.ts` — `DAY_FORMAT` carries the rejected-alternative rationale (why unconditional beats "only when the year differs"), and `labelForDayKey` now names itself as the chokepoint for every day label. The decision was settled in the grilling but lived only in the plan, which gets deleted at ship.
- ADD `dates.test.ts` — the three new cases assert through **the same `Intl` call the code makes**, not a hardcoded `"17 Aug 2024"`. A literal would pin the test environment's locale rather than the behaviour; what is pinned is that the year is present, that two same-day-different-year keys differ, and that the three non-formatted labels are unaffected.

## 4. Scope the checklist named but did not specify

- MOD `PLAN.md:178-179` — the checklist said "→ settled floor, mechanism, scope". The entry was also converted from the upcoming form (`**m0.8.4 — …(next)**` heading) to the shipped-bullet form the rest of the list uses.
- MOD `apps/mobile/README.md` — the RAW table gained a **"measured on"** column. §9's "RAW policy at the floor" established that the table was S23-only while this release declares Android 11 supported, and the spikes confirmed NEF/ARW/CR3 on the S10e and the API 30 emulator — but left DNG measured on one device. The column makes each row's evidence visible instead of implying one scope for all five.
  The ARW row also gained its known wrinkle (MediaStore dates ARW by file mtime, not EXIF, so a copied file can sort under the copy date). The plan parked the *fix* in `docs/TODO.md`; not telling testers would have left "Fully supported" saying more than the measurement supports.
- ADD `apps/mobile/README.md:~190` — the compat statement also names what the failure looks like (`INSTALL_FAILED_OLDER_SDK` via adb, a bare "App not installed" on-device). §6.4 established that the on-device installer is silent about the cause; the sentence is what makes the README statement actionable.

## 5. One consequence worth stating plainly

The six deleted screen gates read `Platform.OS === 'android' && Version >= 30`.
The plan analysed the **version** half (unconditionally true above the floor) and is right about it; the **platform** half is what the deletion also removes, so the four favourite chips and the best-of-group hand-off offer now render on non-Android too.

Unobservable in practice — there is no iOS build, the release flow produces an Android APK only — and coherent if there ever were one: the deck chips write the durable queue rather than calling native, and the queue screen's apply lands on `available() === false` → `unsupported` → the alert that now names the missing module. So it degrades into the D4 path by design rather than crashing.

Named because "no behaviour change on any device that can install it" stays true, while the narrower claim "these predicates were unconditionally true" does not.

## 6. Found on device, not in the plan

- **An organize move failed, and it is not this release's doing.** The first move attempted on the S10e targeted a photo in `Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/`, and Android refuses `RELATIVE_PATH` moves out of another package's `Android/media/` tree. It is a scoped-storage rule, not a version gate — `moveToRelativePath`'s only m0.8.4 change was deleting an `SDK_INT < R` early return that could never fire at API 31.
  The app behaved correctly: the row stayed queued, badged failed, with *"1 queued · 1 failed, retried on the next move"*. A second move on a `DCIM/Camera` photo succeeded and verified (`relative_path=DCIM/Table Mountain Lapse/`), so the success path is measured too.
  Worth a TODO of its own — the queue accepts a photo it can never move, and only says so after the OS consent tap. Not raised here because it predates this release and fixing it is a queue-time refusal, not a deletion.

## 7. Process

- The **phase 2 gradle build ran against a phase-2 tree**, before phases 3-7 landed, and a second full `prebuild --clean` + `assembleRelease` ran at the end. Phase 2's proof is native-only, so running it early costs nothing and catches a Kotlin problem before 300 lines of TypeScript deletions can be entangled with it.
- **The final `assembleRelease` failed once and passed on retry, with no source change.** `:app:mergeDexRelease` threw `DexArchiveMergerException: Error while merging dex archives:` with an empty cause — the signature of a dexer worker being killed, and two emulators plus a warm Gradle daemon were resident at the time. Recorded rather than ignored: a build failure that "went away" is worth one line, and the passing build is the one every artifact check below was run against.
- Two commits precede phase 1: the UI-gate screenshot fix and the plan-plus-durables commit, both of which were already in the working tree.
