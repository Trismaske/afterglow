# m0.8.3 — External media: removable volumes as first-class sources

**Status:** FINAL — gate 0 complete (both spikes run 2026-07-29), all spike consequences confirmed by Tristan (OTG out of scope, CR3 README-only exclusion, NEF via the D15 EXIF date rescue).
Implementation may start at phase 1.
Every decision was settled with Tristan in the 2026-07-29 grilling session; the plan carries **no (autonomous) flags**.
**Audience:** implementing agents and Tristan.
**Answers:** tester feedback "multiple source folders, external media support" (2026-07-29), plus the former TODO items "Real volume identity at ingestion" and "A source that matches no live bucket reads '0 pictures total'" (promoted here, deleted from TODO.md).

## Overview

Multiple source *folders* already work (`sources.ts`, picker multi-select).
What this release adds is **volumes**: SD cards and any other storage MediaStore indexes become real, honest sources — ingested with true volume identity, reviewable with full action parity, safe across unmount/remount, and with a designed exit for data whose media is gone for good.

What stays unchanged: the grouping engine (volume-blind by decision D9), the review flow and state model's three layers (reachability sits *beneath* them, D5b), the delta-scan cost model, and organize's primary-volume-only moves (D3 — the limit becomes *named*, not silent).

## Agreed decisions

| # | Decision | Outcome |
|---|---|---|
| D1 | Release scope | Sources/external media only. Tester items 1 (Keeping-up copy) and 2 (timeline visibility) → TODO backlog. |
| D2 | Volume scope | Any volume MediaStore indexes (`getExternalVolumeNames`), photos only. SAF-only storage is out, documented. No volume-type detection. |
| D3 | Action parity | Cull/favourite/edit/share: full parity on any volume. Organize: primary-volume moves only; the limitation is named in the UI, never a silent dead chip. The "demote organize to a reminder queue" idea was considered and rejected (not recorded). |
| D4 | Source setting shape | Volume-qualified: `{volume, dir}` pairs. Picker shows one row per (volume, dir) with a volume tag on non-primary rows; DB filter becomes `volume_name = ? AND uri LIKE ?`. |
| D5 | Unmount semantics | Unmounted ≠ deleted, first-class. Named with counts on Home (status line), Settings source row, and greyed picker rows. Coverage/streaks exclude unreachable photos; the banner carries the fact. |
| D5b | State-model placement | Reachability is **scope, not state** — a derived query-time predicate (`volume_name` ∉ mounted set), sibling to `is_present`. No stored flag, zero writes on mount/unmount, states survive untouched. STATE_MODEL.md gains a section saying so (lands with implementation). |
| D6 | Proof hardware | S10e's resident microSD is the SD proof device; a manual device test matrix is a release gate. Camera-card-via-adapter is in scope via spike B on the S23. |
| D7 | Volume derivation | Mechanism D: pure uri-path parse (`/storage/emulated/N/` → `external_primary`; `/storage/<UUID>/` → lowercased UUID), validated against the mounted-volume set, fail-closed on unknowns. Spike A verifies the path shapes before any code trusts them. |
| D8 | Scan contract | The seven per-volume invariants below; invariant 5 is scope-gated; the fallback shape stays the global full pass. |
| D9 | Grouping | Groups may span volumes; the engine stays volume-blind. Partially-reachable decks name their unreachable member count. |
| D10 | Spikes | Two parallel spikes (gate 0) before the plan freezes. SD-in-USB-reader ≡ USB-OTG mass storage (the phone cannot tell), but OTG ≢ the native SD slot — whether the S23 MediaStore-indexes OTG at all is spike B's central question and the in/out-of-scope decider for adapter workflows. |
| D11 | Data lifecycle | Both mechanisms: automatic tombstoning on every scan-confirmed permanent delete, plus a user-facing volume-scoped "Forget this card" with two levels (keep review history / erase everything). Per-photo forget deliberately excluded. |
| D12 | Relation to the danger-zone TODO | "Erase everything" covers healthy-DB data hygiene only. TODO "In-app recovery-grade data reset" stays, reworded to its residue: file/schema-level recovery for a broken DB, reachable from the failure path. |
| D13 | RAW policy | Binary per-format, no half-states: a RAW format is either fully reviewable (renders + embeds + groups + trashes) or visibly excluded at ingestion with a named count. Spike B fills the format table. A format that fails the spike is **dropped from the roadmap**, not parked — no "full RAW support" TODO. |
| D14 | Housekeeping | Version m0.8.3; destructive DB reset (schema v19 → v20) per the standing pre-v1 fresh-baseline policy; TODO edits as listed in §9. |
| D15 | EXIF date rescue | In scope (2026-07-29, post-spike): any photo landing UNDATED at ingestion gets one native `ExifInterface` read of `DateTimeOriginal`; found → real timestamp/day, else Unknown day as today. Generic, not NEF-specific. **No file writes, ever** — the files are not broken (exiftool-verified), Android's extraction is; the app never modifies original photo bytes, and a repair setting was considered and rejected. |

## 1. Gate 0 — the spikes

Two spikes run in parallel over wireless ADB (docs/ANDROID_DEVICE_TESTING.md), against dev builds instrumented to log the raw values.
Each hypothesis gets a verdict (**confirmed / refuted / partial**) recorded in this table with its design consequence; a refuted row reopens the affected decision with Tristan before implementation.

### Spike A — S10e, resident microSD (the shipped-design verifier)

**Run 2026-07-29** (SM-G970F, Android 12 / API 31, SD UUID `0A91-E18D`).
Full evidence: `/tmp/afterglow-m0.8.3-handoff/spikeA-findings.md` (with the build handoff; local-only, not committed).
No hypothesis refuted — no decision reopens.

| # | Hypothesis | Verdict |
|---|---|---|
| A1 | SD asset uris look like `/storage/<UUID>/…`; primary like `/storage/emulated/0/…` | **Confirmed** — mechanism D's parse holds on-device |
| A2 | The SD volume name equals the lowercased UUID and appears in `getExternalVolumeNames` | **Confirmed** (`volume_name = 0a91-e18d` on every SD row); `getExternalVolumeNames` membership inferred — log it once from the instrumented build in phase 1 |
| A3 | Legacy `getAssetsAsync` actually returns SD assets in its merged pages | **Confirmed** — the merged external collection (the exact URI the legacy API queries) held 625 SD + 8,165 primary rows |
| A4 | `listImageAlbums` lists SD buckets with correct `volumeName` | **Confirmed** at the MediaStore layer (per-volume URI works, buckets present); module-output check rides phase 1 |
| A5 | Per-volume generations are readable for the SD volume | **Confirmed, major caveat** — the generation counter is SHARED across external volumes (one external.db): see finding 1 below |
| A6 | `createTrashRequest` works on an SD photo's content URI, including a mixed-volume batch | **Partial by design** — volume-qualified URI resolves the SD row and `external_primary/<sd-id>` does NOT (proving the shipped primary-stamped URIs cannot address SD rows); the consent-flow half is the device matrix's job |
| A7 | `createFavoriteRequest` works on an SD photo | **Partial by design** — same addressability evidence; write deferred to the device matrix |
| A8 | Unmounting mid-session fails *observably* without crashing the app | **Confirmed** (sm-simulated; physical-ejection fidelity stays a matrix item) — two distinct failure shapes: see finding 2 |
| A9 | Remount restores the same MediaStore ids and generation continuity | **Confirmed** — identical counts and sample ids, `generation_added` unchanged (rows retained, not re-inserted), generation monotonic across the cycle |
| A10 | `ACTION_EDIT` / share / `ACTION_VIEW` intents work with SD content URIs | **Confirmed** for VIEW (Samsung Gallery rendered the SD photo); EDIT/share ride the device matrix |

**Spike A findings that bind the design:**

1. **Generations are per external *database*, not per volume** — both volumes read one counter.
   "Unchanged" remains a valid per-volume no-change proof, but "changed" on the SD volume can be a false positive caused by primary-volume writes; harmless (the per-volume delta query then returns nothing), so invariant 4 stands — but the implementation must not assume counter independence, and equal baseline values across volumes are expected, not a bug.
2. **Two unmounted-failure shapes**: merged queries silently drop the volume's rows (625 → 0, no error) while volume-qualified queries and generation reads throw `IllegalArgumentException: Volume … not found`.
   The scan must treat an empty merged result as *no evidence of deletion* — per-volume operations (which throw, and are what invariants 1–2 prescribe) are the only honest signal.
3. **While unmounted, rows are hidden, not deleted** — files-collection counts went 10,190 → 0 → 10,190 with `generation_added` unchanged, so the same DB rows return on remount.
   D11's tombstone/resurrection foundation (id stability) is solid on this device.
4. Tooling for future device work: `content query` needs colon-separated projections, and `get_generation` takes the volume via extras (`android.intent.extra.TEXT`), not `--arg`.

### Spike B — S23, USB reader + camera SD card (the scope decider)

**Run 2026-07-29** (SM-S918B, Android 16; two USB-reader SD cards, both ARW-only; RAW seeds — 3 NEF, 3 CR3, ARW/JPG copies — left at `DCIM/SpikeRAW/` on primary for the implementation phase).
Full evidence: `/tmp/afterglow-m0.8.3-handoff/spikeB-findings.md` (with the build handoff; local-only, not committed).

| # | Hypothesis | Verdict |
|---|---|---|
| B1 | The OTG volume appears in `getExternalVolumeNames` | **REFUTED, both cards** — mounted as `type=PUBLIC` with no VISIBLE flag, reachable only at `/mnt/media_rw/<UUID>`; no `/storage/<UUID>` exists; MediaStore throws `Volume … not found` |
| B2 | MediaStore indexes the OTG media | **REFUTED, both cards** — "never indexed", proven: `scan_volume` exists and demonstrably walked both cards (72 s / 7.5 s), yet zero rows even with `includePending=1` |
| B3 | OTG uris parse under mechanism D's rules | Moot — no `/storage/<UUID>` paths exist for these volumes |
| B4 | Camera folder structures surface as pickable buckets | Refuted for OTG (no MediaStore buckets possible). Real card shapes recorded for future reference: `100MSDCF`/`101MSDCF` at card ROOT (no DCIM wrapper) on one card, canonical `DCIM/100MSDCF` on the other; one real-world 0-byte `.arw` |
| B5 | Expert RAW DNGs: photos, decode/embed, render | **Confirmed** — 17 image rows, `image/x-adobe-dng`, dimensions extracted, datetaken present; the app already reviews and renders them in the deck |
| B6 | NEF / ARW / CR3 classification + graceful handling | **Per-format** — NEF (`image/x-nikon-nef`, 4288×2848) and ARW (`image/x-sony-arw`, 6000×4000) are image rows; **CR3 = `media_type 0`, `application/octet-stream`** — invisible to photo queries entirely. `scan_file` via `content call` indexes pushed files |
| B7 | Generations/delta for OTG volumes | Moot — no rows to track; `get_generation` confirmed working (extras form) for primary and attached volumes, sharing the one external-DB counter (matches spike A finding 1) |
| B8 | RAW+JPEG pairs ingest as two independent rows | **Partial** — no real pairs exist on the cards (ARW-only, stated not fabricated); a synthetic same-basename pair on primary produced two independent image rows; same-capture-time grouping untested |
| App-level RAW render | — | **Confirmed for DNG/NEF/ARW** — `scanned 22, embedded 5 fresh`, zero embedder errors, full-size NEF and ARW renders screenshot-verified; CR3 nowhere in the UI |

**Spike B findings that bind the design:**

1. **OTG/adapter media is out of scope** (B1/B2 refuted — the pre-agreed consequence of D2's "any volume MediaStore indexes" rule).
   On this hardware, USB-reader cards are structurally outside MediaStore: non-VISIBLE public volumes that only SAF can reach (Samsung's My Files browses them via StorageVolume directly).
   Documented honestly in README/release notes; no SAF ingestion path is designed.
   The slotted-card path (spike A) is unaffected — a camera's microSD reviewed via a phone's own SD slot remains fully in scope.
2. **CR3 is invisible below the app's horizon** — not a render failure but total absence at the MediaStore layer, so D13's "named in-app count" cannot be built on photo queries for it (counting would need a files-collection sweep built solely for a format we are dropping).
3. **NEF carries `datetaken = NULL`** despite EXIF dates → NEF photos land in the Unknown day pseudo-day with mtime as their group-time fallback (the existing undated machinery, working as designed).
   Part of NEF's honest support story, documented.

## 2. Volume-qualified sources (D4)

- Setting shape: `{ mode: 'dirs'; dirs: { volume: string; dir: string }[] }` (or `{ mode: 'all' }`, unchanged).
  Parse/serialize in `sources.ts` with the existing fallback-to-default pattern; the old path-only shape is not migrated (destructive reset, D14).
- Catalog: `buildCatalog` stops erasing volume identity — one `SourceDir` per (volume, dir) instead of keying by lower-cased path alone (`sourceCatalog.ts:181-196`).
  The pre-API-30 expo fallback path has no volume data; it yields primary-volume entries only (legacy devices without the native module keep today's behavior).
- Picker: one row per (volume, dir); non-primary rows carry a volume tag ("SD card"); unreachable rows (volume in the setting but not mounted) render greyed with "not mounted" instead of disappearing.
- DB filter: `sourceClause` becomes `volume_name = ? AND uri LIKE ?` per root.
- MediaStore filter: `matchAlbumIds` matches within the root's volume only.
- Default-source resolution ("DCIM/Camera") resolves against the primary volume.

## 3. Ingestion volume identity (D7 — mechanism D)

- New pure function (in `mediaIdentity.ts` or a sibling): uri path → volume name, unit-tested against every shape spike A observes plus the `STORAGE_PREFIX` variants (`sources.ts:82`).
- `toLoadedPhoto` (`media.ts:49`) stamps the parsed volume; the `PRIMARY_VOLUME` constant stamp and its `(autonomous)` header flag are deleted.
- Validation: every parsed volume must be in the mounted-volume set fetched at pass start.
  Fail-closed: a row whose volume cannot be parsed or is not in the set is skipped **loudly** (`console.warn` with the uri shape), and the pass does not advance any generation baseline — it cannot claim coverage it did not achieve; the next launch retries.
- The delta path already carries real per-row volumes (`mediaChangedSince`); its rows and the full-pass rows now agree by construction.
- iOS note: the whole mechanism sits behind the Android adapter; a future iOS adapter collapses volume to a constant (no removable storage, no MediaStore).

**EXIF date rescue (D15).**
Any photo landing undated (`!asset.creationTime`, the existing flag at `media.ts:64`) gets one native `ExifInterface` read of `DateTimeOriginal` at ingestion — header-only, once per photo.
Found → the timestamp and day are real (EXIF naive local time converted with the device timezone, the same best-effort stance clustering already takes); absent → Unknown day exactly as today (a WhatsApp-stripped JPEG stays honestly undated).
The pure side (date parse/convert, undated predicate) is unit-tested; the native read lives in `media-store-actions`.
Phase-1 verification, before coding against it: confirm on-device that `ExifInterface` parses the D300s NEFs (the `DCIM/SpikeRAW` seeds exist for exactly this — ExifInterface's NEF support is documented but assumed-tier until observed).
No file writes, ever: the spike proved the files are complete (exiftool: full `DateTimeOriginal` on every NEF) and the gap is Android's extraction — there is nothing to repair, and the app never modifies original photo bytes.

## 4. The per-volume scan contract (D8 — seven invariants)

1. All count comparisons are per-volume, over mounted volumes only — pre-pass (`MediaStore(v) < tracked(v)` means a real permanent delete *on v*) and post-delta agreement alike.
2. An unmounted volume is skipped entirely: no reads, no writes, generation and count baselines retained untouched.
   Its photos leave scope via the reachability predicate only.
3. Unmount/remount alone can never fire the permanent-delete tripwire, mark a photo absent, or touch review state.
   The test: eject mid-session, relaunch, remount — zero row changes.
4. A remounted known volume resumes normal service: unchanged generation contributes nothing; a changed generation (card written elsewhere) feeds the existing delta-vs-full cost decision.
   (Spike A finding 1: the generation counter is shared across external volumes, so a per-volume "changed" can be a false positive from another volume's writes — harmless, the delta query then returns nothing — and "unchanged" remains a valid no-change proof. Do not assume counter independence.)
5. A never-seen volume triggers a full pass **only when it intersects the selected sources**: immediately under "All folders"; under `dirs`, only when the user adds one of its folders (the picker save already rescans).
   An out-of-scope volume is ignored entirely.
   The fallback shape stays the **global full pass** — new-volume is one more uncertainty in the scan's standing "every uncertainty falls back to a full pass" rule; no volume-scoped pass machinery.
6. Deletions are only ever concluded while the owning volume is mounted.
7. The scan-skip fingerprint and generation baselines track **scope-relevant volumes only** (all volumes under "All folders"; the roots' volumes under `dirs`) — an out-of-scope card's activity must never defeat the unchanged-library skip.

## 5. Reachability is scope, not state (D5, D5b)

- A photo is **unreachable** iff its `volume_name` is not in the currently-mounted set.
  Derived at query time; never stored; zero writes on mount/unmount.
  `is_present` keeps its exact meaning: gone from MediaStore while its volume was mounted — a real deletion.
- Every review-scope query (queues, timeline, counts, coverage, forecast inputs, grids) adds the mounted-volume predicate beside `is_present = 1`.
  The mounted set is fetched once per refresh burst and passed down, same lifecycle as `resolveSources`.
- Scan-side corollary of spike A finding 2: an unmounted volume silently vanishes from MERGED MediaStore queries (no error), so merged results are never evidence of deletion — only per-volume operations (which throw `IllegalArgumentException` when the volume is absent) may drive absence conclusions, which is exactly what invariants 1–2 prescribe.
- Unreachable photos keep every row byte-for-byte: verdict, actions (pending and carried), annotations, group membership, embeddings, duel history.
  Remount restores them exactly, no re-ingestion, no re-analysis.
- UX naming (all three surfaces, counts included):
  - Home: a status line in the corpus card region — "SD card not mounted — 214 photos waiting on it".
  - Settings source row: the unreachable tag beside the affected root(s).
  - Picker: greyed rows, "not mounted".
- Coverage/streaks exclude unreachable photos; a "clear" day earned by ejecting a card is visibly asterisked by the Home banner's presence.
- A group straddling volumes shows only reachable members while the card is out; the deck header names the rest ("3 on unmounted SD card" — D9's naming rule).
  Deck verdict writes touch loaded members only.
- STATE_MODEL.md gains a short section beside the layers — "Reachability is scope, not state" — plus a line in "Deliberately not states", landing with the implementation phase that adds the predicate.

## 6. Action parity and the organize limitation (D3)

- Cull/trash, favourite, edit, share operate on content URIs that encode the volume — full parity expected on any indexed volume (spike A verifies each).
- Organize: `validateOrganizeTarget`'s primary-volume rule and the cross-volume source rejection (`organizeStore.ts:79-95`) go live the moment ingestion stops lying.
  The limitation is **named**: an SD photo's organize affordance states "on SD card — moves not supported" at the queue surface (exact placement at build; the principle is visible-and-named, never a dead chip or a Move-time surprise).

## 7. Departed-photo data lifecycle (D11, D12)

**Mechanism 1 — automatic tombstone** on every scan-confirmed permanent delete (mounted volume, invariant 6):
- The `photos` row survives as today (`is_present = 0`, verdict/timestamps/day intact) — all-time counts, per-day charts, and forecast base rates stay exactly right with zero stats-query changes.
- Satellites are swept in the same transaction: embeddings, hashes, duel rows, *queued* action rows (dead work), pending `edit_copy_matches`, group membership via the existing `<2 present members` repair.
  *Resolved* action rows stay — completed work feeds base rates and turnaround.
  (The exact satellite list is confirmed against schema v20 at implementation; the principle: sweep what only has value if the pixels return or work remains, keep facts about completed work.)
- This runs for every permanent delete — internal storage included — and is what keeps the cycling camera-card workflow from structurally bloating the DB: each cycle leaves one slim row per departed photo.

**Mechanism 2 — "Forget this card"**, volume-scoped, user-asserted, offered where the unreachable state is named (Settings source row / Home banner), for a card that is never coming back:
- **Keep my review history:** every photo on the volume demotes to a tombstone and is marked absent by user assertion.
  Counts survive; the banner clears.
- **Erase everything:** hard-delete the rows and satellites; all-time counts visibly drop — the confirmation copy says so.
  Destructive-flow confirmation in both levels, strong confirmation on erase.
- Honest edge, stated in the flow copy: if a forgotten card returns with files intact, the scan re-ingests them — state-intact but needing re-embedding (level 1) or as brand-new unreviewed photos (level 2).
- Per-photo forget is deliberately excluded (volume scope is the use case; smaller destructive surface).
- Healthy-DB hygiene only: the recovery case (broken DB, file/schema-level reset) remains the reworded danger-zone TODO.

## 8. RAW policy (D13)

Binary per-format, no half-states — spike B's verdicts (2026-07-29, S23/Android 16):

| Format | Verdict | Basis |
|---|---|---|
| DNG | **Fully reviewable** | Image rows with dimensions + datetaken; decodes, embeds, renders in the deck (Expert RAW in live review) |
| NEF | **Fully reviewable** | Image rows, decodes/embeds/renders; MediaStore extracts no `datetaken` for it, but the D15 EXIF date rescue recovers the capture date at ingestion (exiftool-verified present in the files). The README's Unknown-day caveat line is updated when the rescue ships |
| ARW | **Fully reviewable** | Image rows with dimensions; decodes, embeds, renders full-size |
| CR3 | **Dropped from the roadmap** | `media_type 0`, `application/octet-stream` — never enters MediaStore's image collection; invisible below the app's horizon |

- DNG/NEF/ARW need no format-specific code — they arrive through the normal ingestion path; the release's obligation is only the documented caveats (NEF undated) and trash verification in the device matrix.
- CR3's exclusion is documented in README/release notes, **not** counted in-app: an in-app count would require a files-collection sweep built solely for a format the OS itself does not classify as an image (spike B finding 2). *(Pending Tristan's confirmation — the alternative is building that sweep for a named in-app count.)*
- RAW+JPEG pairs ingest as two independent rows (B8, synthetic pair); real-pair grouping behavior is observed during implementation, not designed this release.

## 9. Validation against the driving use cases

- **Resident SD (S10e):** pick an SD folder → scan ingests with true volume ids → review/cull/favourite/share SD photos, groups may mix volumes → eject: banner + counts, review state frozen, no tripwire → remount: photos return exactly, delta covers card-side changes.
  Covered by §§2-6.
- **Cycling camera card:** B1/B2 refuted — USB-reader cards never reach MediaStore on the S23, so the OTG variant of this workflow is **out of scope** (documented).
  The workflow survives on slot-equipped devices (a camera's microSD in the S10e's slot is spike A's confirmed territory): ingest via invariant 5 → de-dup (cross-volume groups, D9) → card wiped elsewhere → reinsert: per-volume tripwire concludes real deletions → tombstones keep the stats, DB stays slim (§7 mech 1).
  Retired card: "Forget this card" (§7 mech 2).
- **Unmounted source confusion (former TODO #20):** a source on an absent volume now renders the named unreachable state with counts on Home/Settings/picker instead of "0 pictures total".
  Covered by §5.

## 10. Implementation phases (after gate 0)

Each phase lands with its tests and doc updates; order is dependency order.

1. **Volume identity foundation** — mechanism D parser (pure, unit-tested against spike-verified shapes), ingestion stamping, schema v20 destructive reset, volume-qualified setting + catalog + picker + DB/MediaStore filters, and the D15 EXIF date rescue (native read + pure conversion, gated on the ExifInterface-parses-NEF verification against the `DCIM/SpikeRAW` seeds) (§§2-3).
2. **Per-volume scan contract** — tripwires, baselines, fingerprint scoping, unmount safety; unit tests per invariant, including the eject-mid-session zero-row-change test (§4).
3. **Reachability scope** — mounted-set provider, query predicates, the three naming surfaces, partial-group naming; STATE_MODEL.md section lands here (§5).
4. **Data lifecycle** — tombstone sweep (SQL-parity tested like `reviewPatch.ts`) + Forget-this-card flow with both levels (§7).
5. **Parity naming + RAW policy** — organize limitation copy (§6), per-format ingestion policy from the spike table (§8), README/tester notes (reset cost: one ~25-min re-analysis on a 27k library), release gate.

## 11. Testing strategy

- **Unit (mobile Jest):** the volume parser (every spike-observed shape + malformed inputs), setting parse/serialize round-trip, catalog volume splitting, scan invariants at the `deltaScan`/`scanSkip` pure layer, reachability predicates, tombstone SQL parity against a real DB (the `reviewPatch.ts` pattern), coverage exclusion.
- **Existing suites** must stay green untouched where behavior is unchanged (grouping engine, timeline, queues).
- **Device test matrix (manual release gate, S10e + card; recorded in this doc until shipped):** ingest from SD folder · review/cull/favourite/share an SD photo · mixed-volume cull batch · organize limitation named · **physical** eject mid-session (banner, counts, no tripwire, no state change — spike A proved the sm-simulated cycle; the physical one is this matrix's job) · relaunch while ejected · remount (photos return, state intact, delta picks up card-side changes) · unreachable picker/Settings states · Forget-this-card both levels (erase copy names the count drop) · RAW rows on the S23 (`DCIM/SpikeRAW` seeds + Expert RAW): DNG/NEF/ARW review + trash, **NEF lands on its real capture day (17 Aug 2024) via the D15 rescue**, CR3 absent.
- **UI gate** (`scripts/mobile-ui-gate.mjs`) runs as standard; SD steps stay manual (physical unmount is not scriptable — an `adb shell sm` simulation is a build-time nice-to-have, not the proof).

## 12. Doc and TODO changes shipping with this release

- TODO.md: items "Real volume identity at ingestion" and "A source that matches no live bucket reads '0 pictures total'" deleted (promoted here); "In-app data reset" reworded to the recovery residue (D12); two new entries added for the parked tester items (Keeping-up copy; full timeline).
- STATE_MODEL.md: reachability section (phase 3).
- README/release notes: SD support, the RAW format table's outcome, the reinstall/re-analysis cost.
- This plan is deleted once m0.8.3 ships (standing convention).
