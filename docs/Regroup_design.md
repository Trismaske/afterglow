# Retiring the regroup freeze: design

**Status:** decision-complete.
Settled in a five-question grilling (Tristan, 2026-08-21) on top of the direction agreed in the m0.8.6 closing grilling.
Ready to implement.
**Release:** m0.8.7.
**Audience:** Tristan and the implementing agent.
**Deliverable:** grouping becomes pure presentation — photos own their state, groups grow, shrink, and re-form freely — with two kinds of durable user judgment surviving: review decisions, and "not related" exclusions.
Delete this doc after implementation; the surviving contracts distill into `docs/STATE_MODEL.md` and the file headers.

---

## 1. Overview

**Deleted** (explorer-measured, ~420–440 production LOC + ~520 test LOC):

- The six-rule freeze predicate and window reconcile — all of `src/lib/regroupBoundary.ts` (223 LOC).
- The scan's freeze/reconcile/append block (`scanRunner.ts:1187-1225`) and the grow-only append write path (`store.ts:2196-2244`, `:1963-1982`).
- The reset carve-outs: `resetUnreviewedGroupsIn` and the reset half of `applyGroupingSettingChange` (`store.ts:1747-1812`) — a freely re-forming scan needs no reset.
- `getMetadataGroupIds` and every metadata-freeze read (`store.ts:1814-1833`, revalidation reads at `:2116-2123`).
- The whole D5 un-review apparatus: group-wide duel deletion (`store.ts:546-552`, `:3324-3328`), the `deleteDuelsForGroup`/`clearDuelsForGroup` parameters, the `group_has_duels` fact (`store.ts:1421-1423`), and the state editor's un-review confirm (`StateEditorSheet.tsx:174-196`).
- The `user_single` column and its freeze semantics (replaced by pair exclusions, §4).

**Unchanged:**

- `src/lib/scanWindows.ts` — the window accumulator was never freeze machinery.
- `repairGroupMembership` and its mounted-aware dissolve deferral (`store.ts:711-771`) — membership repair, not freezing; a remounted volume's photos regroup when their window is next scanned.
- The mid-pass mount fence and the in-transaction decision-write guards (`store.ts:317-398`) — the staleness protection that already covers rebuildable groups extends unchanged to all groups.
- Group id minting: ids are never reused; an identical recompute keeps its id (`store.ts:2131-2154`); a changed composition deletes and re-mints.

**New** (~100–150 LOC total, against the ~430 deleted):

- Cannot-link enforcement in `@afterglow/core`'s embedding grouping (§4.2).
- The `not_related` pair table with the dissolution rule (§4.1).
- The targeted window rescan (§5).
- The duels event-log contract (§3) — mostly deletions, plus forget-card anonymization.

## 2. Agreed decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| R1 | The freeze itself | **Retired entirely** (settled m0.8.6 closing grilling; re-affirmed) | Grouping is presentation; photos own their state. Net-negative code, and the D4/L2 narrowing had already conceded the principle. |
| R2 | Duel identity | **Pair-keyed; `group_id` column dropped** (schema v22 destructive rebuild, no duel migration) | Group ids re-mint on any composition change, so a group-keyed duel dies on benign re-mints. The pair is the truth; a maintained group cache can silently lie. v21 (the star) set the rebuild precedent. |
| R3 | Duel lifetime | **Append-only event log: written by Compare, deleted by nothing** except the destructive schema reset. Forget-card **erase anonymizes** (nulls endpoint ids, keeps the row). | Post-retirement no operational reader remains that a stale row could confuse; rows are ~100 bytes; deleted-photo ids already persist as tombstones, so duels add no new exposure. Lifetime stats stay exact. Supersedes the m0.8.6 "per-photo un-review deletion" (first prize): that narrowing's purpose was a deletion that no longer exists. Un-review becomes fully non-destructive — the editor's last confirm dialog disappears. |
| R4 | Ejection model | **Directional cannot-link pairs with the dissolution rule**, replacing `user_single` | "Not related" means "not related to *these* photos", not "never group with anything". Pairs survive re-mints (photo ids are stable); an excluded-group-id would evaporate on the first re-mint. |
| R5 | Multi-eject case | **Dissolution rule:** ejecting a photo first deletes every pair in which it appears as *partner* | Two photos ejected from the same group must be able to reunite elsewhere (Tristan's A→B scenario). Over-deletion recovers with one in-flow re-eject; under-deletion has no recovery surface anywhere. |
| R6 | Ejection undo | **Un-eject in the state editor**, clearing the photo's own pairs, delivered by a **targeted window rescan** | The editor's charter: refuse only what cannot be undone. A flag-clear whose visible effect waits for the weekly pass reads as broken; the targeted rescan lands the effect in seconds through the normal scan pipeline. |
| R7 | Strictness interaction | **Exclusions persist at every strictness, both directions** | Strictness is the algorithm's opinion about relatedness; a cannot-link is the user's. User judgment outranks the threshold. |
| R8 | Strictness/source change | **Plain setting write + forced full pass, behind a re-copied confirm** | Nothing destructive remains to guard, but a settings tap booking ~5 min of scan and a Timeline reshuffle deserves a heads-up. New copy names the real costs and the surviving promise ("review decisions and 'not related' judgments are never touched"). |
| R9 | Stats accuracy | **Audit complete** — [STATS_ACCURACY.md](STATS_ACCURACY.md) records every verdict; the cheap fixes ride m0.8.7 as the stats sweep, gap 8's `decided_first_at` rides this design's v22 rebuild, and the event-log family (burst-tax revival included) is one post-m0.9 design round | The append-only duels contract is the pattern's first instance; a table-per-stat was rejected as sprawl. |

## 3. The duels event log

Schema v22 (destructive rebuild; existing duels are lost by design — Tristan, 2026-08-21):

```sql
CREATE TABLE duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  winner_id TEXT,              -- NULL only after forget-card anonymization
  loser_id TEXT,               -- NULL only after forget-card anonymization
  kept_both INTEGER,           -- NULL = verdict-free triage duel (unchanged)
  at INTEGER NOT NULL
);
CREATE INDEX idx_duels_winner ON duels(winner_id);
CREATE INDEX idx_duels_loser ON duels(loser_id);
```

- **Writers:** Compare's `recordDuel`, unchanged in shape (m0.8.8's F29 redesign then reworks the modes; the two land independently — F29 touches which modes write, not the table contract).
- **Deleters: none.** The permanent-removal sweep (`trashStore.ts:287-290`), the D5 deletes, and the forget-card duel delete (`volumeLifecycle.ts:108-113`) are all removed. Forget-card **erase** instead nulls the forgotten photos' endpoint ids — the erase contract ("no trace of the card's photos") holds, the count survives.
- **Readers:** `getDuelSummary` (counts — now lifetime-true) and any future duel-history browse (`docs/TODO.md` item 5). `group_has_duels` dies; nothing needs a per-photo duel fact once un-review stops deleting.
- The `queuePlan.real.test.ts` EXPLAIN pin for `idx_duels_group` is deleted with the index; the two endpoint indexes serve the anonymization update and future pair lookups.

## 4. "Not related": pair exclusions

### 4.1 Storage and the dissolution rule

```sql
CREATE TABLE not_related (
  ejected_id TEXT NOT NULL,    -- the photo the user ejected
  partner_id TEXT NOT NULL,    -- a member of the group it was ejected from
  at INTEGER NOT NULL,
  PRIMARY KEY (ejected_id, partner_id)
);
CREATE INDEX idx_not_related_partner ON not_related(partner_id);
```

- **Eject** (deck "Not related", label unchanged): in one transaction, first the dissolution rule — `DELETE FROM not_related WHERE partner_id = :ejected` — then insert `(ejected, m)` for each **present member `m` of the group** (vetted 2026-08-21: hidden unreachable members included — the judgment is about the group, and recording only the rendered subset would let the photo regroup with the unreachable members on remount; the dissolution rule is the over-reach safety valve), then clear the photo's assignment (it leaves the deck immediately, exactly today's feel).
- **Dissolution rationale** (R5): a pair records "X doesn't belong with the cluster Y represented"; Y's own ejection revokes Y's standing as that cluster's proxy. Verified against the A→B scenario: eject P1 from A {P1…P5} → P1 lands in B; eject P2 → (P1→P2) dissolves, P2 lands in B beside P1; A's core {P3,P4,P5} stays protected from both.
- **Un-eject** (new state editor row): `DELETE FROM not_related WHERE ejected_id = :photo` (pairs where the photo is merely a partner belong to other photos' judgments and stand), then the targeted rescan (§5). The viewer fact line becomes "You marked it not related to N photos — it never groups with them", with the editor row as the exit.
- Enforcement is **symmetric** (a pair blocks clustering in both directions); storage is directional only so the dissolution and un-eject rules know whose judgment each row is.
- Exclusions are membership constraints, not state: they never touch verdicts, actions, or stats.

### 4.2 Enforcement in core

`@afterglow/core`'s embedding grouping gains cannot-link constraints: a merge that would place any excluded pair in one cluster is refused (the check runs at cluster-merge time against the pair set for the window's photos).
Core stays pure — the pair set is an injected input, like time and randomness.
The scan passes the window's pairs in; the write-side revalidation re-checks them in the transaction (replacing today's `frozenPhotos` revalidation at `store.ts:2107-2126`) so a stale plan can never regroup an excluded pair.

## 5. The targeted window rescan

One mechanism serves eject re-placement and un-eject: synthesize a delta range around the photo's timestamp and run it through the existing range machinery (`deltaScan.ts` plans ranges; `processWindow` executes them).
The scan status line shows it like any small delta.
It is a **user-triggered scan request** routed through `startContinuousScan`'s single-flight, not a parallel pipeline.

## 6. Strictness and source changes

`applyGroupingSettingChange` collapses to: write the setting, request a forced full pass.
The Settings confirm survives with new copy in this direction: *"Regroups your whole library (takes a few minutes). Review decisions and 'not related' judgments are never touched."*
The old promise ("Reviewed groups … are never touched") leaves everywhere it appears — reviewed groups now re-form like any others.
Generation fencing (`requestRescan` forced, `supersedeScan`) survives: it exists so a superseded pass cannot land stale groups, which free re-forming still requires.

## 7. Mid-review behavior

A scan landing mid-review can now re-mint the group under an open deck.
This is the already-shipped rebuildable-group situation (m0.8.6 D4 made any group with unreviewed work rebuildable; its staleness machinery — the write guards at `store.ts:317-398`, the deck's stale-generation handling — shipped and device-passed).
The retirement extends the same handled case to decided groups.
No new mechanism; the release's device pass explicitly walks it — **(autonomous)** confidence check, not a design change.

## 8. Validation against the driving cases

| Case | Outcome under this design |
|---|---|
| F9 lineage: un-review returns a photo to the scan's reach | Trivially true — nothing freezes; and un-review is now confirm-free and non-destructive (R3). |
| Two photos ejected from A both belong in B | Dissolution rule (R5) — verified step-by-step above. |
| Duel's loser culled, purged after 30 days | The duel row survives; lifetime Compare stats hold (R3). |
| Strictness tightened, then loosened back | Groups re-form both times; exclusions hold both times (R7); decisions and duels untouched. |
| SD card unmounts mid-library | Repair deferral unchanged; photos regroup when their window is next scanned after remount. |
| Ejected photo's group re-minted with new neighbours | Pairs are photo-keyed — unaffected by any re-mint (R4). |

## 9. Implementation phases

Each phase lands with its tests and doc updates; order is a dependency chain.

1. **Schema v22 + core cannot-link.** The rebuild (drop `duels.group_id`, nullable endpoints, endpoint indexes; `not_related` table; drop `user_single`; plus the stats sweep's immutable `photos.decided_first_at` — [STATS_ACCURACY.md](STATS_ACCURACY.md) gap 8, whose free window this rebuild is), and the constraint check in core's grouping (pure unit tests, including the dissolution scenarios). `npm run build -w @afterglow/core` after.
2. **The scan writes groups as truth.** Delete `regroupBoundary.ts`, the freeze/append block, the append write path, the carve-outs; exclusions filter grouping input and revalidate in the write transaction. The big test rewrite lands here (freeze pins out, exclusion pins in).
3. **The duels contract.** Remove every deleter; forget-erase anonymization; delete the D5 apparatus (params, fact, confirm); Stats unaffected by any cleanup thereafter.
4. **Eject/un-eject flows.** Pair recording + dissolution on eject; the un-eject editor row; the targeted rescan; viewer/editor copy.
5. **Settings + docs.** The re-copied confirm; `STATE_MODEL.md` (exclusions section replaces the freeze section), `apps/mobile/AGENTS.md` map rows, header rewrites (`database.ts`, `scanRunner.ts`, `SettingsScreen.tsx`); this doc distills and dies.

## 10. Testing

Mapped onto the existing tiers (core unit tests; `*.real.test.ts` DB tier; the UI gate and the human device pass above):

- **Deleted:** `regroupBoundary.test.ts` (348 LOC), the grow-only sections of `volumeScanContract.real.test.ts:208-307`, the carve-out pins (`store.real.test.ts:1222-1252`, `:1456-1487`), the D5 describe block (`store.real.test.ts:2340-2474`), the freeze-revalidation pin (`continuousGroups.real.test.ts:450-473`).
- **Rewritten:** the ejection pins (`store.real.test.ts:437-532`, `:1290-1316`, `:1704-1731`) assert pairs instead of `user_single`; `continuousGroups.real.test.ts:368-402` becomes "an excluded pair is never regrouped by a later scan write".
- **New:** core cannot-link (merge refusal, the A→B dissolution walk, constraint injection); append-only duel invariants (un-review, trash cleanup, and forget-keep leave rows; forget-erase anonymizes; counts stable across regrouping); targeted-rescan range synthesis (pure half) and its single-flight routing; the eject transaction's dissolve-then-insert ordering.
- **Device pass:** mid-review re-mint walk (§7), eject → re-placement latency, un-eject → regroup latency, the strictness confirm's full-pass cost naming.

## 11. Migration

None.
Schema v22 is a destructive rebuild under the pre-v1 policy (testers reinstall; the 2026-08-21 decision explicitly accepts losing existing duels and ejection flags).
