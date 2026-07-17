# Assumptions — mobile train

Judgment calls made while building Afterglow Companion, per version.
Merged into `ASSUMPTIONS.md` at the end of the build.

## m0.1

1. **`expo-media-library/legacy` import, deliberately.** SDK 57 introduced a
   new class-based Query/Asset API and deprecated `getAssetsAsync` /
   `deleteAssetsAsync` — but the legacy module is still shipped, documented,
   and is the battle-tested path for cursor paging and the Android system
   delete dialog. All MediaStore access goes through
   `src/lib/media.ts`; migrating to the new API is one file. Revisit in m0.2+.
2. **Cull-group gap = core `MOMENTS_GAP_MS` (3 minutes).** Clusters with ≥ 2
   photos become duel groups; 1-photo clusters go to the singles bucket. Not
   yet user-configurable (m0.1 scope).
3. **Duel presentation: two photos stacked vertically**, one tap per decision
   ("✕ Cull" stages that photo and the other wins; "★ Better" keeps both and
   advances that photo). Long-press a photo to inspect it fullscreen.
   The full-screen A/B flip + synchronized zoom is m0.3 per PLAN.md.
4. **Linear review flow.** One big "Continue" button drives duels
   group-by-group (core's `nextPair()` order = chronological), then singles,
   then the cull list. Jumping into an arbitrary group is not supported in
   m0.1 (core drives brackets in order); the Groups screen is an overview.
5. **Singles use big Keep/Cull buttons, not swipes** — buttons are unambiguous
   with two-handed hotel-bed ergonomics; swipe gestures are optional polish
   later (PLAN.md allows this).
6. **Delete-path correctness:** `deleteAssets()` in `src/lib/media.ts` is the
   only call in the app that deletes media, reachable only from the cull-list
   confirm button. An in-app Alert confirms first (this matters on
   Android < 11 where there is no system dialog); on Android 11+ the system
   dialog is the real gate and moves the batch to the system trash (~30-day
   recovery). `deleteAssetsAsync` returning false / throwing is treated as
   "user cancelled": the batch is rolled back from `confirmed` to `culled` by
   rewriting the core session snapshot (core deliberately has no un-confirm;
   the versioned snapshot format is the escape hatch).
7. **Session persistence:** the whole core `CullSession` (including
   mid-bracket state) is serialized into `sessions.snapshot` after every
   decision, alongside per-photo state updates and the duel record, in one
   exclusive SQLite transaction. Restart → Home offers "Resume". One active
   session at a time; starting a new one abandons (not deletes) the old one
   after an explicit confirm.
8. **Content-hash fallback identity is lazy and best-effort:** SHA-256 via
   expo-crypto, computed in the background only for photos staged as culls
   (never 200 hashes for a day's load). Failures are silently ignored —
   MediaStore id remains the primary key (PLAN.md).
9. **Storage reclaimed is approximate:** summed `File.size` (new
   expo-file-system API) of staged culls, measured just before deletion; 0
   for unreadable files. Labeled "approximate" in the UI.
10. **Timestamps:** `creationTime` from MediaStore, falling back to
    `modificationTime` when creationTime is 0/missing (WhatsApp-style files);
    clustering is best-effort local time per PLAN.md risks.
11. **Permissions:** `expo-media-library` config plugin with
    `granularPermissions: ["photo"]` → READ_MEDIA_IMAGES on Android 13+,
    READ_EXTERNAL_STORAGE on older; runtime request via `usePermissions({
    granularPermissions: ['photo'] })`. Deletion needs no extra permission —
    Android 11+ uses the system delete-request dialog. iOS strings included
    but untested (Android-first).
12. **Testers need a dev build** (`npx expo run:android` or an EAS dev
    build) — media permissions and expo-dev-client don't work in Expo Go.
    Documented in `apps/mobile/README.md`.
13. **No mobile unit-test runner in m0.1.** Decision logic lives in
    @afterglow/core (tested there); app-side lib modules are thin and typed.
    Verification = `tsc --noEmit` + `expo export --platform android` (Metro
    bundle). No device/emulator on the build machine, so the first on-device
    run is on the user's phone.
14. **Abandoned sessions keep their photo state rows** (`photos.state`
    reflects the last decision made). m0.2's full state machine will decide
    how stale `unreviewed`/`kept` rows are reconciled on the next scan of the
    same day.
15. **Added a minimal mobile CI workflow** (`.github/workflows/mobile-ci.yml`:
    typecheck + Metro export on PR/push) even though the roadmap doesn't
    mention mobile CI — it mirrors the verification gate and costs ~2 min.
16. **Mobile docs live in `apps/mobile/README.md`**, with only a short
    pointer section in the root README (the root file was concurrently being
    edited by the desktop train; the pointer hunk was staged independently).

## m0.2

1. **`to_edit`/`done` live in SQLite, not in core.** Core's `CullSession`
   still only knows unreviewed/kept/culled/confirmed/trashed; the needs-edit
   flag is an app-side column (`photos.needs_edit`) and every state write
   remaps kept + flag → `to_edit` via a CASE expression in
   `persistDecision`/`setNeedsEdit`. This keeps core untouched (shared,
   prebuilt, other train may be using it) and matches PLAN.md's "SQLite is
   the source of truth for photo state". Core's `SingleAction` widening to
   `'to_edit'` is left for whenever core is next opened up.
2. **Convergence rule:** photos the user kept but did not flag become
   `done` when the session *finishes* (Summary → Finish runs kept → done
   for the session's photos). Abandoned sessions leave rows `kept`, which
   counts as "still converging" in the progress views and gets re-reviewed
   next session.
3. **Session re-scan reconciliation (m0.1 #14 resolved):** starting a new
   session over a range now *excludes* photos already `to_edit`, `done` or
   `trashed`; interim states (`unreviewed`, `kept`, `culled` from an
   abandoned session) are re-included and reset to `unreviewed` (a staged
   cull from an abandoned session must be re-earned — safer than carrying a
   stale delete list into a new bracket). Home shows "N already handled".
4. **m0.1 data migration:** schema v2 turns every existing `kept` row into
   `done` (m0.1 had no finish-time convergence step, so `kept` was its
   terminal keeper state). If an unfinished m0.1 session is resumed after
   the upgrade, its keeper rows briefly read `done` in progress views until
   the session rewrites them — cosmetic only, and the session snapshot
   (authoritative for review flow) is unaffected.
5. **Migration runner:** append-only array of SQL batches, `MIGRATIONS[n]`
   moves `PRAGMA user_version` n → n+1; each batch runs in one `execAsync`
   with the version bump as its last statement. `day` (local `YYYY-MM-DD`
   from `taken_at`) is backfilled with SQLite `date(..., 'localtime')`; new
   rows compute it in JS — both are device-local time.
6. **ACTION_EDIT decisions** (per m0.2 spec, "document what you land on"):
   raw action string `android.intent.action.EDIT` (SDK 57's ActivityAction
   enum only covers settings screens; `startActivityAsync` accepts
   `ActivityAction | string`); `data` = the asset's `content://` URI from
   legacy `getAssetContentUriAsync` (fallback: constructed
   `content://media/external/images/media/<id>`); `flags = 0x1 | 0x2`
   (FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION) so
   the editor can save over the original; `type` omitted — the SDK 57 docs
   say Android then infers the exact MIME from the content provider, which
   matches more editor intent filters than hardcoding `image/*`.
7. **Editor result codes are ignored as a signal.** Most editors return
   Canceled even after saving, so returning from the editor only triggers a
   "Mark done?" prompt — never an automatic transition. Manual "Mark done"
   is always available (PLAN.md risk mitigation); real edit detection is
   m0.3.
8. **Needs-edit flag semantics in duels:** the ✎ toggle on a duel card
   flags the *photo*, not the decision. If the photo is later culled the
   flag is moot (culled wins); if it is un-culled from the cull list it
   comes back as `to_edit`, not plain kept — the CASE remap makes this hold
   everywhere without special-casing.
9. **Day-progress accounting:** a day's true total = MediaStore count +
   `trashed` rows (trashed photos have left MediaStore). MediaStore photos
   never tracked in SQLite count as unreviewed; `done` in the bar/rows =
   `done` + `trashed` ("everything converges to done" includes culls).
   "In duels" = unreviewed rows with a `group_id`.
10. **Home shows the last 7 days** (days with zero photos are hidden);
    per-day MediaStore totals come from one `getAssetsAsync({first: 1})`
    `totalCount` read per day, refreshed on screen focus.
11. **`photos.session_day` (the free-text session label) is retained but
    superseded** by the new `day` column for anything day-scoped; dropping
    a column needs a table rebuild and isn't worth it in a v2 migration.

## m0.3

1. **Duel-history source of truth (m0.2 open question resolved):** the
   `duels` SQLite table is the *durable* record (append-only archive across
   sessions, future mining); the core snapshot's `duelHistory` is
   *in-session working state* that feeds `autoCullCandidates()`. They are
   written in the same exclusive transaction so they can't diverge
   mid-session; if they ever did, the snapshot wins for the active session.
   Neither was dropped: the table is queryable SQL the snapshot blob isn't,
   and the snapshot is what core's bracket logic actually replays.
2. **Detection heuristics live in `apps/mobile/src/lib/editDetection.ts`,
   not core.** They're Android-MediaStore-shaped (filenames,
   modificationTime semantics) and useless to desktop; keeping core
   untouched also avoids racing the other train on shared prebuilt files.
   The module is pure TS (no platform imports, no Date.now()) and
   unit-tested with vitest, which is now a mobile devDependency
   (`npm test -w afterglow-companion`) — revisits m0.1 #13.
3. **In-place detection = mod-time baseline + lazy hash tiebreaker.**
   `modificationTime > stored mod_time` alone marks done when no hash
   baseline exists (accepting rare metadata-only false positives — it's a
   convenience layer per PLAN.md). Baseline SHA-256 hashes are computed
   lazily during detection runs for unchanged queued photos (max 5
   full-file reads per run); once a baseline exists, a mod-time bump with
   an identical hash is treated as metadata-only and just advances the
   stored baseline. A moved mod time whose file can't be re-hashed counts
   as edited (the mod time is the best remaining signal).
4. **`photos.to_edit_at` (migration v3)** records when a photo entered the
   queue — the scan window for copy detection — maintained by the same
   CASE writes that maintain the kept→to_edit remap (first entry wins,
   kept across done for history). Backfill uses the photo's own mod_time
   (wider window than the unknowable true flag time; matching tolerates
   it).
5. **Copy detection query strategy:** one MediaStore scan of photos created
   since the oldest queue entry (capped at 400) plus a ±2 s creation-time
   sibling window per queued photo (capped at 50). Candidates already
   tracked in SQLite are excluded — that's what stops burst siblings from
   false-positive timestamp matches AND prevents re-prompting (a detected
   copy is inserted as `done`, so it's tracked forever after). A candidate
   must also have been *written* (modificationTime) after flagging.
6. **Copy-prompt outcomes:** "Keep original" → original `done`;
   "Cull original" → the standard system-trash dialog (`deleteAssets` is
   still the app's only delete call — now reachable from exactly two
   explicit user actions) then `trashed`; cancelling the system dialog or
   "Decide later" leaves the original queued in the edit queue, where
   manual Mark done always works. No re-prompt happens later (see #5) —
   deliberate, not a bug.
7. **Detection runs on Home focus, throttled to once per 60 s** — "app
   open" per the plan, plus returning from an editor session usually lands
   back on Home. It does NOT run on EditQueue focus: that screen already
   prompts "Mark done?" on editor return, and double-prompting is worse
   than a 60 s delay.
8. **Externally deleted photos stay in the edit queue.** If a queued
   asset no longer resolves (`getAssetInfoAsync` fails), detection skips
   it rather than guessing trashed — a permission hiccup must not converge
   a photo. Manual mark-done clears it.
9. **Auto-cull hints are a separate Reconsider screen**, routed to when a
   duel decision completes a bracket whose `autoCullCandidates()` (minus
   needs-edit-flagged photos — the user explicitly wants those) is
   non-empty. The pending-hint flag is in-memory only: abandoning/resuming
   mid-transition loses the hint, which is fine for an opportunistic
   prompt. Undecided candidates stay kept.
10. **Reconsider-cull uses the snapshot escape hatch.** Core has no
    kept→culled transition; like the m0.1 confirm-rollback, the app
    rewrites the versioned snapshot (kept → culled) and persists it with
    the state change. No duel record is written — a reconsider isn't a
    duel, and inventing a loser would poison the history.
11. **A/B flip is an instant opacity swap, deliberately not animated** —
    flicker-comparison is how you spot the sharper frame. Both photos stay
    mounted inside ONE transformed container (reanimated shared values on
    the parent), so pinch-zoom/pan applies to both by construction. Zoom
    is center-anchored (no focal-point math) and clamped to 1×–8×;
    pan clamps to the scaled bounds; pinching below ~1× springs back.
    Gestures compose as Exclusive(Simultaneous(pinch, pan), tap) per RNGH
    2.x docs. Buttons act on the *visible* candidate ("✕ Cull B",
    "★ B is better") — clearer than positional buttons on a flip UI.
    Long-press-to-inspect died; the zoom replaces it.
12. **Reanimated 4 / worklets setup relies on babel-preset-expo defaults**
    (SDK 57 auto-configures the worklets plugin; no babel.config.js in the
    app) and `GestureHandlerRootView` now wraps the app root. Verified via
    Metro export; real gesture feel needs the on-device run.
13. **Streak definition:** consecutive local days ending today (or
    yesterday, while today is unfinished) with ≥ 1 *finished* session —
    `sessions.finished` (migration v3) distinguishes Finish-button
    completion from abandonment. Pre-m0.3 completed sessions can't be told
    apart retroactively and optimistically count as finished. Summary
    counts the about-to-finish session as today.
14. **Summary also shows all-time reclaimed bytes** (SUM over sessions,
    same "approximate" caveat). Cheap per the "if cheap" clause; deeper
    stats stay m0.4.

## m0.3.1 (trip feedback)

1. **Scopes are rolling windows ending "now", not calendar-aligned.**
   "Last day" = the trailing 24 h, "Last 7 days" = trailing 7×24 h, etc.
   Fixed day counts throughout: 1 / 7 / 30 / **183** ("Last 6 months") /
   **365** ("Last year") days; "All time" = epoch 0 → now. Rationale:
   the chips answer "how far back do I want to catch up?", rolling avoids
   timezone/calendar edge cases, and PLAN-style day-scoped thinking still
   exists via the Recent-days rows. Today/Yesterday chips are gone
   (m0.1–m0.3's `todayRange`/`yesterdayRange` remain in dates.ts,
   unused); "Last day" covers them, and Custom still picks exact days.
   Default scope = "Last day".
2. **All-time gating rule as implemented:** the All-time chip is visible
   but disabled until `remaining(lastYear) == 0`, where `remaining =
   max(0, mediaStoreCount − handledCount)`, `handledCount` = DB rows in
   the range with state `to_edit` or `done` (**`trashed` rows are
   excluded** — they've left MediaStore, so they're absent from both
   sides of the subtraction; `unreviewed`/`kept`/`culled` interim rows
   count as *not* reviewed, matching the m0.2 re-review rule). Ranges
   nest, so last-year-clear ⇒ only the >365-day backlog remains. A hint
   under the chips explains the gate while locked. The gate re-checks on
   every Home focus; if new photos re-lock it while "All time" is
   selected, the scope snaps back to "Last year".
3. **Scope counts are approximate by design (and cheap).** Remaining =
   MediaStore `totalCount` queries (per source bucket) minus one SQL
   aggregate — no asset lists are loaded to render Home. Known skew: a
   `done` photo later deleted *outside* the app still counts as handled
   (no external-delete reconciliation exists), so remaining can
   undercount and the gate can unlock slightly early; the clamp at 0
   hides the opposite skew. The exact reviewable set is still computed
   photo-by-photo when a session starts (which can also come up empty →
   counts refresh instead of a broken session).
4. **Large scopes: sessions are capped at the oldest 500 reviewable
   photos** (`SESSION_PHOTO_CAP`, reviewLoader.ts). Loading pages
   MediaStore 200 at a time (as m0.1 did), drops converged photos page
   by page against SQLite, and early-stops per bucket at the cap —
   memory stays ≤ buckets × cap, never the whole library. Oldest-first
   matches review order, so repeating the scope after finishing walks
   the backlog forward in 500-photo chunks. The CTA says so ("Start
   culling · oldest 500 of 5 234"); the m0.2 "N to review · X groups ·
   Y singles" pre-count died with the full-list load (groups/singles now
   first appear on the Session screen — acceptable, the numbers were
   never actionable on Home).
5. **Source matching mechanism:** Android MediaStore albums are
   per-directory, non-recursive buckets with no path field, and the
   legacy expo-media-library builds `asset.uri` as `"file://" + DATA`
   (raw path, **no percent-encoding** — verified in the SDK 57 package's
   Android source, AssetUtils.kt). So: each bucket's directory is probed
   with one `first: 1` asset query (`totalCount` doubles as the picker's
   photo count), stripped to a storage-relative path
   (`/storage/emulated/0/…`, `/storage/XXXX-XXXX/…`, `/sdcard/…`
   prefixes), and a selection = a set of directory roots matched
   **case-insensitively as whole-segment path prefixes** (recursive;
   FAT SD cards are case-insensitive, so case-insensitive is the safer
   uniform choice). Queries then pass the matching bucket ids to
   `getAssetsAsync({ album })` — one query per bucket, summed/merged,
   since the API takes a single album.
6. **Source-matching limits (accepted):** (a) buckets exist only for
   directories that contain ≥1 photo — empty or brand-new folders can't
   be picked, and folders created after the 60 s catalog cache expires
   appear on next resolution; (b) the SQLite side filters `photos.uri`
   with `LIKE '%/<root>/%' ESCAPE '\'` (wildcards escaped, ASCII-case-
   insensitive) — containment, not anchored at the volume root, so a
   root named "Pictures" would also match a hypothetical
   ".../Foo/Pictures/..."; contrived, accepted; (c) iOS `ph://` uris
   have no directory — the feature degrades to "All folders" there
   (Android-first per PLAN.md).
7. **Source default is dynamic until explicitly saved:** with nothing
   persisted, the source resolves to "DCIM/Camera" when any bucket lives
   under it, else "All folders" — re-evaluated on every resolution (a
   first camera photo flips the default automatically). Saving in the
   picker persists an explicit choice (settings table, migration v4,
   JSON under key `photo_sources`) and freezes it. The picker keeps
   persisted dirs that no longer have a bucket visible ("no photos
   found") so they can be unselected, and marks subfolders of a selected
   root as "included via a parent folder".
8. **Every MediaStore query site now respects the source filter**
   (audited: Home scope counts + gate, session loading, Recent-days
   totals, DayProgress totals, edited-copy candidate scans) *and* the
   DB-side counterparts (`countHandledInRange`, `getDaySummaries`,
   `getDayStateCounts`) filter by uri. Consequence for edit detection,
   documented in detect.ts: an editor that saves its copy **outside**
   the source folders (Snapseed → `Pictures/` while the source is
   `DCIM/Camera`) is no longer detected — manual Mark done covers it;
   in-place detection re-queries assets by id and is unaffected.
   Already-queued to-edit photos from other folders also stay in the
   queue (queue membership is state, not a live query).
9. **Recent-days rows kept their m0.2 shape** (last 7 calendar days,
   hidden when empty) — only their counts became source-filtered. The
   per-day MediaStore read is now one `totalCount` query per source
   bucket per day (unchanged: 1/day for "All folders").
10. **Settings storage:** a generic `settings(key, value)` table
    (migration v4) rather than a photo-source-specific table — future
    small settings share it without further migrations.

## m0.4

1. **dHash representation: 16-char lowercase hex string** (core
   `similarity.ts`), not bigint — serializes to SQLite/JSON with no
   conversion and `hammingDistance` consumes it directly (per-nibble
   XOR popcount). Bit convention: 8 rows × 9 cols grid, row-major
   adjacent comparison, bit = 1 when the RIGHT pixel is strictly
   brighter, most-significant bit first. `dhash64` accepts any grid
   shape totalling exactly 64 comparisons (the canonical 9×8 is what
   the app feeds it).
2. **Similarity refinement = connected components, chain-linking
   deliberate.** Within a time cluster, photos whose hashes are ≤
   threshold apart are edges; refined groups are the connected
   components, so A~B~C stays one group even when A!~C — a drifting
   burst (pan, walking subject) is still one moment. Threshold 0 =
   only bit-identical connect; ≥64 = cluster unchanged.
3. **Null-hash rule (exact):** a photo whose hash is missing/failed
   attaches to the component of its nearest-by-timestamp hashed
   neighbor in the same time cluster (tie → the earlier item); a
   cluster with no hashes at all stays intact. Consequence: a hash
   failure can never split a photo out of its time cluster on its own.
   Failed hashes are NOT cached, so transient read errors retry on the
   next group build.
4. **Component ordering is deterministic:** components emerge ordered
   by their earliest member's position; items keep cluster order;
   refined clusters reuse the `${timestamp}:${id}` id scheme from
   clustering.ts, so the component containing the cluster's first item
   keeps the original cluster id (group ids stay stable when nothing
   splits).
5. **Hash pipeline split pure/impure:** expo-image-manipulator (SDK 57
   context API: `manipulate(uri).resize({width: 9, height: 8})` →
   `renderAsync()` → `saveAsync({format: JPEG, compress: 1, base64})`,
   with explicit `release()` on both shared objects) produces a tiny
   base64 JPEG; everything after base64 is plain TS in
   `dhashDecode.ts` — hand-rolled base64 decoder (no Buffer in RN,
   Hermes atob too new to rely on), jpeg-js decode, Rec.601 RGB→luma,
   box-sampling to 9×8 (tolerates a resizer that returns a larger
   image) — vitest-covered including JPEG round-trips via jpeg-js's
   encoder. jpeg-js is a plain npm dep; expo-image-manipulator and
   expo-constants installed via `npx expo install`.
6. **Hash cache: `photo_hashes(asset_id PK, hash, mod_time)`
   (migration v5),** separate from `photos` — hashes exist for photos
   that never entered a session and survive session resets. Recompute
   only when MediaStore `modificationTime` ≠ stored `mod_time`
   (in-place edit). Rows are never aged out (~few MB per 100k photos);
   rows for deleted assets are just never read.
7. **Laziness and UI feedback:** hashes are computed at group-building
   time inside `startSession`, ONLY for photos in multi-photo time
   clusters (singles never pay), with concurrency 3 (the heavy work is
   native resizing; JS decodes 9×8 JPEGs in microseconds, so the UI
   thread breathes between awaits — no extra batching layer was
   needed). Progress surfaces on the Home start button as "Analyzing
   photos… n/total"; with the m0.3.1 cap a session hashes ≤ 500
   photos, cached thereafter.
8. **Threshold setting:** settings-table key `similarity_threshold`
   (m0.3.1 key/value table — no migration needed), integer Hamming
   distance 0–64. Default 12: the classic dHash duplicate cutoff is
   ~10, but the goal is grouping related shots of a scene, not just
   duplicates. UI is a 5-step chip control (Strictest 4 / Strict 8 /
   Normal 12 / Loose 18 / Loosest 26) with per-step hints and a
   plain-language explainer, not a raw slider — 64 positions are
   meaningless to users. Parsing accepts any 0–64 integer (forward
   compatibility); garbage falls back to the default; stored
   off-step values snap to the nearest chip for display only (ties
   toward stricter), the stored value itself is what refinement uses.
   Applies from the next session (documented in the UI).
9. **There was no gear affordance on Home** (the stage brief assumed
   one) — m0.3.1 shipped a "Source: … Edit ›" row instead. Added a ⚙
   button beside the Home title routing to the new Settings screen;
   the Home source row stays as a direct shortcut, and Settings has
   its own Photo-source row to the same picker. Settings also shows
   the app version via expo-constants (`Constants.expoConfig.version`
   = app.json, single source of truth).
10. **Refined singleton components join the singles bucket** merged
    with the time-singletons, re-sorted chronologically (timestamp,
    then id) so single review stays in shooting order. Group review
    order likewise stays chronological because refinement preserves
    cluster order and orders components by earliest member.
11. **Core stayed additive:** `similarity.ts` is a new module (new
    exports `dhash64`, `hammingDistance`, `refineClustersBySimilarity`,
    `DHASH_BITS`, `DHASH_HEX_LENGTH`); bracket `CullSession` and every
    existing export are untouched. `hammingDistance` throws on
    malformed/mismatched hashes rather than guessing — a corrupt
    stored hash should surface, not silently count as similar.
12. **Swipe deck replaces the duel bracket (core `deck.ts`, new module;
    `CullSession` stays exported/intact for desktop reuse).**
    `DeckSession` takes the same `{groups, singles}` input and the same
    PhotoState machine; per group it holds `memberIds`/`aliveIds`/
    `cursor`/`complete`/`bestId`. `cull(id)` stages a photo exactly like
    a duel cull did; `keepRest(groupId)` completes the group and keeps
    every alive unreviewed member; culling/ejecting the last alive
    member auto-completes the group. Deck photos stay `unreviewed`
    until culled or kept by keepRest — merely being swiped past commits
    nothing. Staging → confirm → trash and the singles flow are
    byte-for-byte the m0.2 semantics (same screens/store paths).
13. **Deck snapshots are discriminated (`kind: 'deck'`, version 1) and
    m0.3.x bracket snapshots are NOT migrated:** `DeckSession.fromJSON`
    rejects them, and `resumeSession`'s existing corrupt-snapshot catch
    abandons the in-flight session. Reviewed states in SQLite are the
    durable truth; per m0.3.1 rules the abandoned session's interim
    rows are re-reviewed next session. Cursor position is persisted per
    swipe (fire-and-forget snapshot write — expo-sqlite queues writes
    in call order), so mid-deck restarts resume on the same photo.
14. **Compare tool = the m0.3 A/B flip + synced-zoom screen, now
    on-demand** (`CompareScreen`, route `Compare {groupId, aId, bId}`).
    The deck's Compare button opens it against the NEXT alive photo
    (wrapping); long-pressing a thumbnail in the deck's strip compares
    against that photo instead — both documented here as the chosen
    "your call" option. Verdicts return to the deck: "★ X is better"
    records a compare (keptBoth=true, no state change); "✕ Cull X"
    culls X and records keptBoth=false; "Close — no verdict" records
    nothing. Compare outcomes reuse the `DuelRecord` shape and land in
    the same `duels` SQLite table via the unchanged `persistDecision`.
15. **Reconsider hints now derive from explicit compares only** (per
    trip feedback): candidates = kept photos that LOST a compare, never
    won one, and aren't the starred best (`reconsiderCandidates`). A
    group finished with zero compares never prompts. A compare loser
    whose cull is later unstaged becomes a candidate again (it is kept
    and carries a loss) — accepted. The core bracket's
    `autoCullCandidates` remains for `CullSession` users; the app no
    longer calls it. `reconsiderCull` now uses core `cullKept()` (the
    deck model supports kept→culled directly) — the m0.3 snapshot-
    rewrite escape hatch survives only in the confirm-rollback path.
16. **markBest is optional and cosmetic-plus-signal:** the ★ toggle
    stars at most one alive member per group (star lives only in the
    snapshot, like the bracket's bestId); culling or ejecting the best
    clears the star. It excludes the photo from reconsider candidacy
    and highlights its thumbnail; nothing else consumes it yet.
17. **"Not related — review as single" (`makeSingle`)** removes the
    photo from the group entirely (memberIds, deck, best star), appends
    it to the singles queue (reviewed after the pre-existing singles;
    order = ejection order), and NULLs `photos.group_id` (new store
    helper `clearPhotoGroup`) so day-progress "in groups" counts stay
    honest. One tap, no confirm — the photo still gets reviewed, just
    as a single; there is no un-single in-session.
18. **Deck cull undo:** a 4 s "UNDO" banner after each deck cull calls
    core `undoCull(id)` — culled → unreviewed, re-inserted at its
    original deck position (memberIds order), cursor pointed at it.
    Only while the group is live; after completion the cull list's
    tap-to-restore (culled → kept, no deck re-entry) is the path, as
    before. If culling the last photo completes the group, routing
    moves on and the banner dies with the screen — cull list covers it.
19. **Deck UI is a paging FlatList, not a gesture-handler carousel:**
    horizontal `pagingEnabled` FlatList over the alive photos ("2/3"
    indicator, thumbnail strip synced to the cursor). Pinch-zoom on the
    deck was deliberately dropped — it fights the pager's pan gesture —
    and lives in the Compare tool (the "defer zoom, document" option
    from the stage brief). Swiping writes the cursor; membership
    changes (cull/undo/eject) re-align the list to the cursor offset.
20. **Timestamp precision (deck + compare labels):** seconds always,
    hand-rolled 24 h `HH:MM:SS` (locale-proof), switching to
    `HH:MM:SS.mmm` only when adjacent deck photos (or the two compare
    candidates) share the same wall-clock second AND at least one
    timestamp carries a nonzero sub-second part — MediaStore
    creationTime is ms, but second-resolution sources would render a
    noise ".000" otherwise (`millisNeeded` in `lib/format.ts`,
    vitest-covered).
21. **needs-edit stays app-side in the deck world** (m0.2 #1 upheld):
    the deck/compare ✎ buttons call the existing `toggleNeedsEdit`;
    core `DeckSession` has no edit concept. Needs-edit-flagged photos
    are still exempt from reconsider prompts (the user explicitly wants
    them).
22. **Day and Global progress share one body** (`components/progress/
    ProgressView`): state summary (tappable filters) + filtered photo
    grid + per-photo state editor sheet. DB-side scoping is a
    `PhotoScope` union: DayProgress keeps the m0.2 `day = ?` column
    scoping (so its counts match the Recent-days rollups exactly);
    the Global page — and Home's counts — scope by `taken_at BETWEEN`.
    `getDayStateCounts` and `countHandledInRange` were replaced by one
    `getStateCountsInScope` (handled = toEdit + done, byte-identical
    m0.3.1 accounting); the breakdown math moved to `lib/progress.ts`
    (pure, vitest-covered).
23. **Two grid engines, chosen by filter.** In-groups / Kept / To-edit /
    Staged / Done photos all have SQLite rows, so those filters page the
    DB directly (`getGridPhotosByFilter`, newest-first LIMIT/OFFSET) —
    no MediaStore scan to find 3 staged photos in a 5 000-photo scope.
    "All" and "Unreviewed" must include never-tracked photos, so they
    page MediaStore newest-first (one cursor stream per source bucket,
    merged globally-descending by the pure k-way pager in
    `lib/progressPager.ts`, vitest-covered; memory stays O(buckets ×
    page)) and join each page against SQLite to classify
    (`classifyPhotoState`). Grids are newest-first (gallery convention);
    review order stays oldest-first.
24. **Trashed rows appear in no grid** — their files are gone, so there
    is nothing to thumbnail. They still count in the summary's Done
    number (everything-converges accounting), and the grid label notes
    "(N trashed — files gone, not shown)" when the Done filter is
    active.
25. **State editor transitions are the audited store paths, nothing
    new:** kept → done (`markKeptDone`), kept → to_edit
    (`setNeedsEdit(true)`, the m0.2 CASE remap), to_edit → done
    (`markEditDone`), done → to_edit (new `markDoneToEdit`, keeps the
    needs_edit / to_edit_at first-entry-wins conventions), staged cull →
    kept (new `unstageCullDirect`, same outcome as the in-session
    cull-list unstage incl. the m0.2 #8 to_edit comeback). Unreviewed /
    untracked / trashed / confirmed are read-only. Every write is
    state-guarded (`AND state = '…'`), so a stale sheet is a no-op.
26. **Photos in the ACTIVE session are read-only in the state editor.**
    Direct DB writes would desync the authoritative session snapshot —
    e.g. un-culling a staged photo in SQLite would not stop the live
    session from deleting it at confirm. The session's own screens are
    the editing surface while a session runs; the sheet says so. An
    un-cull outside any live session lands on 'kept' (interim state,
    re-reviewed next session per m0.2 #3 — the sheet can then mark it
    done manually).
27. **"Review this day" reuses the custom-range machinery verbatim:**
    `loadReviewablePhotos` over the day's range + `startSession` with
    the day label, including Home's replace-unfinished-session confirm
    and the analyzing-hashes progress label. Enabled while
    `remainingReviewable = total − done − toEdit > 0` — kept/staged/
    in-group interim states count as still-reviewable, matching the
    m0.2 re-review rule.
28. **Home headline counts "done" strictly:** N = done + trashed rows,
    M = MediaStore count + trashed rows — to_edit is *handled* but not
    *done*, so the headline can read 90% while "0 to review" (edit
    queue still open). Same cheap count queries as m0.3.1 (one
    MediaStore totalCount pass + one SQL aggregate; no asset lists on
    Home). The Progress row shows the same percentage and computes the
    rolling range at tap time; the Global page deliberately has no
    review CTA (Home's Start culling covers scope-wide reviews).
29. **Progress-page refresh is whole-page:** a state edit bumps one
    refresh tick that reloads counts and resets the grid (scroll
    position included). Simple-correct over clever in-place patching;
    revisit if editing many photos deep in a grid becomes a real
    workflow. Back-navigation stays flat: Progress and DayProgress are
    only ever pushed from Home, and a day review pushes the existing
    Groups flow (Summary still pops to top).

## m0.4 — theming

1. **Semantic accent tokens, three of them:** `accent` (chips, primary
   buttons, chevrons/links, best-marker), `onAccent` (text/icons on an
   accent fill), `accentMuted` (accent sunk 78% toward the background;
   subtle selected fills like the deck's active Best pill). Success
   (keep-green), destructive (cull-red) and edit-blue are NOT accent
   tokens — they stay fixed in the static `colors` object regardless of
   the chosen accent (danger stays red, the Start-culling / Keep-rest /
   confirm CTAs stay green). The theme module is `src/theme.tsx`
   (formerly theme.ts): static `colors`/`touch` plus
   `ThemeProvider`/`useTheme`; `accent` was REMOVED from `colors` so the
   compiler found every consumer during migration.
2. **Derivation is pure and unit-tested** (`src/lib/accentTheme.ts`):
   `onAccent` by WCAG relative luminance — accents ≥ 0.35 luminance get
   an 11%-of-accent near-black tint (amber derives #1a1208, visually
   identical to the old hand-picked #1a1205; the hue whisper is kept on
   purpose), darker accents get the app's near-white #f2f4f8. All six
   shipped presets and Material You tone-80 land on the dark-text
   branch. `accentMuted` = mix(accent, background, 0.78) (amber →
   #3d301f ≈ old #3d3116). Invalid hex anywhere degrades to amber
   rather than throwing.
3. **System palette via a LOCAL Expo module** (`modules/
   material-you-accent`, Kotlin, Android-only): a synchronous
   `getSystemAccents()` returning `android.R.color.system_accent1_
   {200,500,700}` as #rrggbb, `null` below API 31 (SDK_INT < S) or
   without a context. `expo-module.config.json` declares platforms:
   ["android"] only — the scaffolded "apple" entry was dropped (no
   Swift file exists; declaring it would break iOS builds). JS side
   uses `requireOptionalNativeModule`, so iOS / Expo Go / stale dev
   clients collapse to `null` = "no dynamic palette" → amber. The app
   uses `accent200` (tone 80, made for dark surfaces) as the System
   accent; 500/700 are returned for future use but unused.
4. **Wallpaper changes apply on next app launch, not live.** The
   palette is read once per ThemeProvider mount; Android recreates the
   activity on wallpaper/dynamic-color changes, so a fresh launch
   re-reads it. No AppState listener — simple-correct, revisit if it
   ever feels stale.
5. **Setting: key `accent_color`** in the m0.3.1 settings table, values
   `system|amber|coral|green|sky|violet|rose`, parsed with fallback to
   the default `system` on garbage (which itself resolves to amber when
   the palette is unavailable — always safe to store). Presets: Amber
   #e8a54b (classic), Coral #ee8570, Green #74c69d, Sky blue #6fb3e8,
   Violet #a49bef, Rose #e589b4 — all tone-80-ish for the dark UI. The
   Settings "Accent color" card shows System first (preview swatch =
   live wallpaper accent; disabled with a hint below Android 12) then
   the six swatch chips; selection applies live via context re-render
   and persists immediately.
6. **No accent flash on launch:** ThemeProvider reads the stored choice
   with `db.getFirstSync` in the useState initializer (it mounts inside
   SQLiteProvider, after migrations), so the first frame already has
   the right accent. The Suspense fallback spinner renders before any
   provider exists and uses the static amber constant.
7. **Migration pattern:** accent-dependent StyleSheet entries moved to
   inline `{ color/backgroundColor/borderColor: theme.accent… }`
   overrides at the use site (static neutrals stay in StyleSheet);
   `stateMeta.ts` became `stateMetaFor(accent)` since the in-groups
   swatch follows the accent. React Navigation's `primary` follows the
   accent via a ThemedNavigator component. Hardcoded on-accent
   (#1a1205) and muted (#3d3116) hexes are gone from src/.

## m0.5

1. **Editor fallback chain (Samsung bug):** `launchEditor` now tries
   `ACTION_EDIT` → on rejection `ACTION_VIEW` on the same content URI
   (same read+write grant flags, so the viewer's built-in editor can
   save over the photo too) → only a double failure shows the error,
   reworded without the old "or enable" phrase ("No installed app could
   edit or even view this photo…"). The sequencing is pure and
   vitest-covered (`lib/editFallback.ts`); `edit.ts` only binds the
   platform. The "Opened in viewer — use its edit button" toast fires
   the moment the fallback intent is dispatched — Android toasts overlay
   the opening viewer, and an unresolvable intent rejects immediately,
   so the toast only ever races the error alert in the
   no-viewer-at-all case (accepted). Returning from the VIEWER also
   triggers the "Done editing?" prompt — the user may well have edited
   through the viewer's pencil, and the prompt's "Not yet" is cheap.
2. **Similarity rescale is display-compatible, no migration:** new
   steps 12/16/20/26/32 (old Normal 12 = new Strictest), default 20 on
   fresh installs only — an existing stored value is untouched (any int
   0–64 was already valid) and simply renders as its exact chip or as
   "Custom (N)" next to the new slider. Chip highlighting switched from
   nearest-step to EXACT match because the slider made off-preset
   values first-class; `nearestStep` remains (ties → stricter) for the
   step-hint copy and tests document how old values read on the new
   scale.
3. **Fine-tune slider is hand-built** (`components/FineSlider.tsx`):
   no slider dependency exists in the app and `@react-native-community/
   slider` is a native module — adding it would break the existing dev
   client without a rebuild, so the track is a RNGH pan/tap surface
   (horizontal `activeOffsetX` activation so vertical scrolling wins,
   revert-on-cancel) with − / + buttons for true single-step precision
   (64 steps ≈ 5 px each; finger-only ±1 is unrealistic). Chips set the
   slider; an off-chip value shows "Custom (N)"; explainer line
   "Higher groups more different-looking photos together."
4. **Re-decide surface = one sheet, three chips**
   (`components/ReDecideSheet.tsx`; keep / to-edit / cull): reachable
   by tapping a DECIDED thumbnail in the Groups strips, from a
   completed group's browse deck (see #6), and from the cull list
   (whose tap-to-restore became tap-to-choose — restoring is now one of
   three chips; badge says "tap to change"). No "done" chip: in-session
   photos are never `done` before Finish, and out-of-session `done`
   editing already lives in the m0.4 progress state editor. Summary
   shows no photos, so it got no re-decide surface.
5. **No core changes were needed for reversibility.** All m0.5
   re-decides compose from existing transitions: kept→culled =
   `cullKept` (m0.4), culled→kept = `unstageCull`, and to-edit is the
   app-side needs-edit flag (m0.2 #1) aligned BEFORE persisting so the
   store CASE lands the right row state (`to_edit` vs `kept`).
   `SessionContext.redecide` is the single wrapper; changing a to-edit
   photo to cull stages it exactly like any cull (flag kept, so
   un-culling later returns it to to-edit per m0.2 #8).
6. **Any-order flow:** `Deck` takes an optional `groupId`; Groups rows
   (and strip thumbnails of unreviewed photos) open that group, the
   singles row opens singles any time, and "Continue" keeps the old
   linear default. An explicitly opened COMPLETED group renders the
   deck in browse mode: pages every remaining member (kept AND staged)
   with the photo's verdict as re-decide chips; the pager cursor for
   browse mode is screen-local (core's cursor indexes only alive
   members). Explicit + "Keep rest" returns to the overview (unless a
   reconsider hint fires, which takes priority in both modes); in the
   linear flow routing is unchanged. Singles entered early return to
   the overview when done instead of skipping to the cull list.
7. **Replace-dialog banking:** "Start new" first runs
   `bankActiveSessionKeepers` (store-level: reads the persisted
   snapshot, so it also covers never-resumed sessions after a restart)
   — kept photos converge to `done` exactly like Finish; `to_edit`
   rows are already remapped; compare history was persisted
   per-decision all along. Staged culls deliberately STAY interim
   'culled' (m0.2 #3: a stale delete list is re-earned, never carried
   or silently dropped). Banking runs BEFORE `loadReviewablePhotos`
   (order matters — the loader must see the keepers as handled) plus a
   harmless backstop inside `startSession` for any other caller. The
   replaced session is abandoned (finished=0), so it never feeds the
   streak. Dialog buttons: [Start new (destructive) · Cancel ·
   Continue existing]; RN maps the 3-button array to
   neutral/negative/positive, which renders exactly that left-to-right
   order on Android ("isPreferred" additionally marks Continue on iOS).
8. **"End session & apply" is routing, not new state:** a footer action
   on Groups that jumps straight to the cull list; confirm → Summary →
   Finish already converges kept → done and leaves unreviewed rows
   unreviewed (they simply reload next session). It counts as a
   finished session (streak) because the user deliberately finished.
9. **Session settings** (settings table, accent_color pattern):
   `session_photo_cap` (int 10–500, default 50, garbage → default;
   Settings offers chips 25/50/100/200/500 — a free-form numeric field
   felt like desktop UI, any hand-stored value in bounds still parses
   and is displayed), `session_whole_groups` ('1' default / '0'),
   `session_review_order` ('oldest' default / 'newest').
10. **"Don't split groups" uses the TIME-gap boundary** (core
    `MOMENTS_GAP_MS`, pure logic in `lib/sessionSelect.ts`): the cap
    extends while consecutive draw-order photos are ≤ 3 min apart.
    That is exactly `clusterByGap`'s boundary, and similarity
    refinement only ever SPLITS time clusters — so a session can never
    cut a final group, though it may over-include (a time cluster that
    similarity would have split counts as one "group" for the soft
    cap). Extension is bounded at +200 photos so a gap-free stream
    can't unbound memory; per-bucket paging early-stops via the
    matching `bucketNeedsMore` rule (superset guarantee preserved from
    m0.3.1).
11. **Draw order selects WHICH photos, not how they're presented:**
    'newest first' pages MediaStore descending, caps from the new end,
    then the selection is re-sorted chronologically before clustering —
    groups and review order inside a session stay oldest-first
    (clusterByGap sorts anyway). Home's cap copy follows the setting
    ("sessions take the newest 50 at a time").
12. **Compare labels are the deck's ALIVE positions** (1-based index in
    `aliveIds`, frozen for the screen's lifetime — membership can't
    change while Compare is up), matching the deck's "3/9" counter and
    thumbnail order. Fallback to memberIds position, then '?', for
    stale ids. Chips, badge, buttons, edit tag and the header ("Compare
    3 vs 7") all use them.
13. **Two-photo-group "better" semantics:** the confirm dialog is a
    custom modal (RN Alert has no checkbox) — "Keep both" records the
    compare keptBoth=true; "Cull N" stars the winner and calls the
    normal compareCull (keptBoth=false — exactly ONE duel row per
    verdict, never better+cull double-recorded). "Don't ask again"
    persists ONLY with the cull choice (key `compare_auto_cull_loser`)
    because it means "better = auto-cull from now on" — suppressing on
    "Keep both" would flip the user's stated intent. Settings →
    Confirmations → "Reset confirmation dialogs" clears it. In groups
    of >2, "better" now stars the winner (`markBest`, overwriting any
    prior star) + records the compare, with a toast naming the
    position; the explicit "Cull N" button intentionally does NOT
    auto-star the survivor.
14. **"Compare with…" picker:** the deck's Compare button opens a
    thumbnail grid (position-badged) of the group's OTHER alive members
    when more than two are alive, and goes straight to Compare when
    exactly two are. Long-press on a strip thumbnail stays as the
    shortcut. The old silent "compare against the next photo" default
    died with it — implicit opponents were the discoverability
    complaint.
15. **Scope store schema:** one JSON blob (`review_scopes`, settings
    table — same single-blob pattern as `photo_sources`; no SQL
    migration). Builtins keep their m0.3.1 ids/day-counts, can be
    disabled but never deleted, and missing builtins re-seed on parse
    (disabled ones stay disabled — only truly absent ids come back).
    Custom scopes are FIXED date ranges (`range-<epochMs>` ids) — a
    trip must not drift with "now" — created inline on Home's Custom
    section (name field + "Save scope"; there is no separate
    custom-range screen to extend, m0.3.1 put the pickers inline).
    "Reset to defaults" restores builtin order/enabled state but KEEPS
    customs — deleting user-named scopes on reset felt destructive;
    delete is explicit per-scope (with confirm). The All-time gate
    still applies to the builtin `all` id only; named ranges bypass it
    by design (they are bounded, so the gate's
    protect-against-the-whole-backlog rationale doesn't apply).
16. **Home scope selection isn't persisted** (unchanged from m0.3.1);
    on focus an invalid selection (scope disabled/deleted in Settings)
    falls back to the first enabled chip, and the all-time re-lock
    snap-back to `year1` remains.
17. **Deck pinch-zoom SHIPPED, as an overlay, not a transformed pager:**
    a two-pointer pinch (pinch can't activate with one finger, so
    single-finger swipes always reach the untouched FlatList pager)
    sets a `zoomed` flag on activation → the pager's `scrollEnabled`
    goes false and an absolutely-positioned overlay of the CURRENT
    photo carries the Compare screen's transform (same clamp math,
    1×–8×, center-anchored); a one-finger pan gesture is enabled only
    while zoomed. Zooming back out (≤1.02) springs back and re-enables
    paging; the reset lives in `onFinalize` so a cancelled gesture can
    never leave the pager frozen; cursor/photo changes and navigation
    reset the zoom. Known accepted seams (device verification pending):
    a two-finger touch that starts as a scroll may move the pager a few
    px before the pinch activates and freezes it, and the gesture
    object is rebuilt when `zoomed` flips (same composition shape, so
    RNGH updates handlers in place per its documented diffing). The
    undo banner is cleared when a cull completes the group (browse mode
    takes over — core `undoCull` only works on live decks).
18. **Gear icon:** the app has no icon font (text glyphs only —
    @expo/vector-icons is not a dependency), so the ⚙ TEXT glyph
    became the ⚙️ color-emoji gear (U+2699 U+FE0F), which renders as an
    unambiguous cog on Android. Home's "Source: … Edit ›" row is gone;
    the picker lives in Settings → Photos (route unchanged).
19. **Not verifiable without a device** (flagged for the on-device
    pass): ACTION_VIEW resolution on Samsung Gallery and the grant
    flags surviving the viewer→editor hop; toast timing over the
    opening viewer; pinch-vs-pager feel and the two-finger-scroll seam
    (#17); Switch thumb/track colors on Material You devices; emoji
    gear rendering on older Android emoji fonts; Alert 3-button
    left-to-right order on Samsung's dialog skin.
20. **DayProgress "Review this day" follows every m0.5 rule** (same
    dialog order/wording, banking before load, session prefs) — it
    reuses the Home machinery per m0.4 #27, so the cap now applies to
    day reviews too (a 300-photo day at cap 50 takes several sessions;
    consistent with "progress must be bankable").
