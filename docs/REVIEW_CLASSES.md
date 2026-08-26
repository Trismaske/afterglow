# Recurring defect classes: the pre-review checklist

This list is the input to the self-review before any `codex-review` round.
The skill expects a running class list, and this is the repo's.
Every class below was found at least once in a real review cycle here.
Recurring classes are the strongest predictor of the next round's findings.
Sweep the change set against each class before you spend a review round.
Classes marked **(device)** were only ever found when the code ran on a phone.
Spend part of any cycle's budget on device runs, because static review has never caught their siblings.

## Data layer

1. **Two-statement queue exits.**
   To leave a queue means to delete the never-done row AND demote the done one.
   Use `leaveQueue`, never one statement.
2. **SQL placeholder/argument drift.**
   TypeScript sees none of it.
   Count `?`s against args, especially in chunked/IN-list builders.
3. **Removed column or table still referenced in SQL.**
   Cross-check every identifier against the current `BASELINE_DDL`.
4. **Optimistic patch disagreeing with its SQL.**
   The reviewPatch parity harness pins these.
   Give every new write a parity case.
5. **One write where two layers changed.**
   A verdict without its action, or the reverse.
6. **Multi-statement logical writes outside a transaction.**
   A death between them leaves half a truth.
7. **Dependent writes after a guarded no-op.**
   Capture the affected-row count and return early.
   Do not resolve copy matches, restore stars, or stamp History for a transition that did not happen.
8. **Reporting requested instead of committed.**
   Batch writes that silently skip stale rows must return the APPLIED set.
   Counts, patches, and goal credits follow what committed.

## Contracts & state

9. **Fail-open where the contract says fail-closed.**
   A failure becomes a zero, an empty list, a blank surface, or a broadened scope.
   Sweep every catch and every `?? 0` / `?? []`.
10. **Failure sentinels doubling as domain states.**
    When 'missing'/`[]` stands for both "read failed" and "genuinely gone", failures flow into completion routing.
    Keep an explicit failed state with retry.
11. **Direction-blind action reads.**
    Favourite is the only action that points backwards.
    Every favourite surface must read direction: intent-first for the heart, verified-first for "applied" stats.
12. **Verdict/action flattening on a surface.**
    The two layers coexist.
    An action badge must never replace a verdict badge.
13. **A surface diverging from the shared badge/weight vocabulary.**
    Hand-rolled icons drift.
    Render through photoBadges/DecisionBadge.
14. **Retained data outliving the scope that produced it.**
    Keep-last is only valid within an unchanged scope.
    Tag cached data with its scope key.
15. **A documented convention not wired.**
    If a doc or appendix promises a behaviour ("no selection = everyone"), grep for the wiring.

## Bounds, caches, and guarantees

16. **Inclusive bound handed to an exclusive query** **(device)**.
    The MediaStore `createdAfter/Before` render as strict comparisons.
    Widen ±1 ms everywhere an inclusive range meets them.
    Walk a one-element case and a boundary-equal case.
17. **A bound assumed rather than walked** **(device)**.
    Merge windows are maximal chains, not fixed slices.
18. **A one-directional check presented as a guarantee** **(device)**.
    A tripwire that only sees losses needs a second check for gains.
19. **A backstop unreachable from the path it guards** **(device)**.
    Trace every periodic/fallback reconciliation to prove reachability.
20. **A cache TTL wider than the proof it feeds.**
    A count or catalog cached for display must not serve a baseline/tripwire whose validity window is narrower.
    Take fresh reads for proofs.
21. **A baseline compared across the boundary that defines its validity.**
    MediaStore generations are only comparable within one provider version.
    Bake the boundary into the key.
22. **State captured at read time re-derived from patched data.**
    Page tails/fullness are facts about the SOURCE.
    Carry them from the read.
    Never recompute them from optimistically patched arrays.
23. **A bounded read serving an unbounded promise.**
    A hidden LIMIT under a route that claims entirety silently truncates.
    Caps must be loud or absent.
24. **A guard's exclusion creating a sibling hole.**
    Every filter in a new check (e.g. "non-trashed only") is a place where the same defect survives.
    Re-run the scenario through the excluded set.
25. **A fallback inside a fix re-opening the hole it closes.**
    If the fix exists because the fallback value is unsafe, failure is the only safe fallback.
26. **Unserialized lazy initialization.**
    Concurrent first calls double-count or double-arm.
    Single-flight or chain them, and sample shared counters at a defined point relative to reads.
27. **Unfenced optimistic writes.**
    Overlapping writes need a generation fence AND a durable-value anchor.
    Only the latest may roll back or alert.
    Any success newer than the last recorded one advances the baseline.
    Rollbacks land on persisted values, never on earlier optimistic renders.
28. **Id-keyed mutation across colliding namespaces.**
    Raw MediaStore ids collide across volumes.
    Until identity is volume-qualified, enumeration is the only alias-proof reconcile.

## UI tests (the device gate)

29. **Choreography silently degenerating when the data shape shifts** **(device)**.
    Steps must verify their preconditions from truthful counts (the overview), record real start positions, and reroute.
30. **Assertions satisfiable by absent-anchor defaults** **(device)**.
    A failed UI dump reads as two matching zeroes.
    Only anchored dumps may satisfy an equality, and early returns need anchored evidence.
31. **Position-relative steps breaking anchored assertion chains** **(device)**.
    Never re-act on a stale position.
    Re-read before every move, and refuse to proceed from an unproven position.
32. **Overlays eating taps without taking the foreground** **(device)**.
    The offenders are PiP windows and the app's own raised tab bar at screen edges.
    Tap on positive evidence with re-tap loops.
    Dismiss known offenders at every step.
33. **Dependent steps running after their anchor step failed.**
    Record them failed-skipped.
    Never write real decisions from an unknown position.

## Reachability & snapshot discipline (m0.8.3, the cycle's dominant family)

34. **A bulk or destructive write reading the world fresh at write time.**
    Every fresh read can WIDEN the write past what the user saw (a remount, a reload landing late, a null enumeration).
    Bulk writes bind to the RENDERED set intersected with an invalidated fresh reachable read (shrink-only).
    Explicit single targets act unconditionally (the M5 rule, STATE_MODEL.md).
    Physical operations always bind to reachable.
35. **A snapshot published apart from the data it describes.**
    A mounted set (or any paired context) can publish before its rows commit, publish from a superseded load, or survive a no-op refresh unpublished.
    Each pairs one world's data with another world's predicate.
    Publish atomically with the rows, latest-load-only, and on no-op paths too.
36. **Two native reads treated as one snapshot.**
    Generations before mounted volumes, or a count memo beside a fresh enumeration: anything that changed between them silently defeats checks built on their agreement.
    Verify that the later read still covers the earlier one.
    Re-fence immediately before you ACCEPT a skip or claim coverage.
37. **A reachability predicate appended beside an OR-facts branch.**
    `reach` next to `(is_present = 1 OR state = 'trashed')` silently scopes the FACTS branch too.
    Reachability scopes live rows only.
38. **An IN-list bound sized by user data.**
    A rendered-ids bound or volume-qualified source clause hits SQLite's 999-variable floor at real scale.
    Chunk it, or cap the input with an actionable error.
39. **A refresh trigger missing one of its worlds.**
    Navigation focus, foreground return, and LIVE volume broadcasts are three separate signals.
    A screen wired to fewer than it needs goes stale exactly when the world changes without the missing signal (useExternalRefresh wires the non-navigation two).
40. **Fix-on-fix drift.**
    Across ten review rounds, the newest hunks (fixes to prior findings) were consistently where the next defects lived: incomplete rollouts of a principle (one path of four), a fix written against the wrong key shape, a bound added without its chunking.
    Point re-review budget at the newest changes first.
    Sweep a principle across EVERY sibling path in the same round.

## Deletions and dual sources (m0.8.4)

41. **A dead branch left behind a raised floor.**
    When a minimum rises, the unreachable arm is only half the sweep.
    The other half is whatever that arm was the *sole* consumer of: helper chains, build dependencies, tests, doc lines.
    Each is invisible until the thing above it goes, so deletions cascade.
    Re-grep for callers after every removal, not just before the first.
    A pure deletion adds no tests: a test file appearing in a deletion hunk is a stop signal.
    A changed assertion means the arm was not dead. Stop and investigate rather than fix the test (changed argument literals are not that signal).
42. **An inert-looking declaration a dependency treats as load-bearing.**
    Platform semantics are not library semantics.
    A dependency can still read, as a precondition, a permission or flag the OS ignores.
    A permission or flag absent from the manifest can never be granted.
    Before you delete a declaration a third party can observe, grep that dependency's own source for it.
    Test in the version band where the declaration still applies: the failure can be invisible on newer releases.
43. **Two engines behind one screen.**
    A surface that pages from two sources, chosen by a filter, will eventually show both answers.
    A row only one engine can see appears under one control and vanishes under the next, while a count drawn from a third source agrees with neither.
    When a component has two data paths, ask what a row visible to only one of them looks like.

## Errors and generated copy (m0.8.4)

44. **A failure reported by a toast the user cannot act on.**
    A toast is enough when RETRYING IS THE WHOLE ANSWER: nothing changed, tap again.
    It is the wrong surface when retry is futile (a platform refusal that will refuse identically forever) or when the state is now ambiguous.
    A message that vanishes leaves the user in a loop.
    Apply the retry test to every failure surface.
    The five "could not save — try again" toasts in this codebase pass it.
    The one that did not was the one that needed a dialog.
45. **A diagnosis parsed out of a platform's error text.**
    Exception wording is not an API.
    It differs by OS version and OEM skin, so a matcher silently stops matching and the explanation degrades to nothing.
    That outcome is worse than never claiming to know.
    Classify from facts YOU own (the item's own path, your own status codes).
    Quote the platform's words verbatim and unparsed underneath.
    Let a rule that becomes wrong go quiet rather than start lying.
46. **Count copy asserted only in its plural form.**
    An interpolated count reads naturally while you write it, because you write the plural.
    The `n = 1` case is the one that ships as "1 photo live in".
    Every generated sentence that carries a count needs its singular asserted, not just its shape.
    Assert the verb and the pronoun, not only the noun.

## Keeping a screen alive, and async hand-offs (m0.8.5)

47. **A per-visit reset the unmount used to do for free.**
    A refactor that keeps a component mounted across what used to be remounts inherits every reset the unmount performed silently: cursors, native scroll offsets, pickers, entered-with state, async results.
    Enumerate them by asking what a fresh mount initialises, then key each on the new identity (the unit, not the mount).
    Async results additionally need STAMPING with the identity they were read for, or the previous visit's rows render as this one's.
    Three instances in one release, one introduced by the fix for another.
48. **A UI transition gated on state an async chain sets.**
    If a transition may proceed only after an async evaluation (was this the crossing? is the moment claimed?), gating on the evaluation's OUTPUT loses the race: the transition runs before the chain resolves.
    Gate on observable state that is raised synchronously BEFORE the async work is queued and lowered on every exit path — one gate per stage of the hand-off.
    The second-order form: arming stage N+1 and lowering stage N in the same batched render lets an effect between them run with both gates open.
    This class recurred within one review cycle; its fix is where its next instance lived.
49. **An incrementally maintained counter beside a documented aggregate.**
    A counter kept in step with events (fresh decisions, bytes freed) must agree with the query that defines the number users see.
    Judge each increment by the AGGREGATE's semantics — the same column, the same once-per-bucket rule — not by a plausible event-level rule; "unreviewed became decided" and "one row per photo stamped today" disagree exactly when a user undoes.
    Test the running SUM against the query, not increments in isolation: the isolated test encoded the wrong rule confidently.
50. **A pending hand-off outliving its receiver.**
    A consume-once flag armed for a receiver that unmounts or blurs before consuming does not disappear — it fires stale on whatever claims it next, hours later.
    Every producer→consumer flag needs an owner for the abandoned case: the last receiver leaving either consumes it, degrades it (a toast), or clears it.
    Registration scope matters too: scope receivers to MOUNT when a covering screen must not count as departure, and keep consuming scoped to focus.
51. **Physical native state reconciled by accounting.**
    A reused native view (a scroll list, a text input, a video surface) carries state React cannot observe: offsets, in-flight momentum, animations, IME composition.
    Reconciling it against React state through events and imperative commands breeds a patch per timing gap — an event that never fires when a tap cuts momentum short, a corrective command that an in-flight animation outlives, bookkeeping that only tracks commands and goes stale on real gestures.
    When the identity changes (a new unit in the same screen), do not reconcile: REMOUNT the native view (key it by the identity) so the physical state dies with the old one, and create the replacement already in the safe state (scroll disabled, selection cleared) rather than commanding it safe one frame later.
    Three consecutive bookkeeping fixes failed on-device before the keyed remount ended the class.
52. **A guard armed by an effect, one paint late.**
    Anything that must be true ON the frame a transition commits (a disabled control, a suppressed event handler, an overlay) cannot be armed by an effect — effects run after paint, and the unguarded frame is exactly the one the race hits.
    Derive the guard from state that already changed in the committing render (compare identities: `settledUnit !== unitKey`), and use effects only to LIFT it later.
    The same class hides in event handlers: a handler that checks a flag an effect sets accepts every event delivered before the effect ran — including stale deliveries from an unmounted native view, whose events outlive it by a few frames.

## Shared caches, native seams, and render pipelines (m0.8.8)

53. **A two-step flow revalidated against pre-flow state.**
    A guard written before a multi-write flow existed rejects the flow's own first write as "state changed".
    When a feature makes a state sequence first-class, re-derive every guard on the path from the flow's real state machine, per endpoint — not from the single-write era's invariant.
54. **Check-then-decode on a shared cache.**
    Two surfaces independently checking a shared cache and then decoding race: the loser's `put` replaces (and releases) the winner's entry while a mounted view still renders it, and a hit landing between check and decode gets discarded.
    Shared expensive work needs per-key single-flight with ADOPT semantics — and the in-flight key must include the source VERSION its waiters observed, or an edit landing mid-decode hands old bytes to a surface that opened new ones.
55. **An identity check that survives unmount.**
    Async completions gated only on "is this still the same item" apply happily after the component died, because the item id outlives the mount.
    Every completion path — not just the one branch someone remembered — needs the liveness gate beside the identity gate, with an owner releasing the resource on the dead path.
56. **A deferred apply without a generation fence.**
    Work deferred even a frame (an empty-first slot swap, a stash) can be overtaken by newer work or a clearing reset inside the window; landing it then violates newest-wins with stale content.
    Fence every deferral on a generation bumped by both applies and clears, and release the loser.
57. **Shared mutable bookkeeping cleared by a stale closure.**
    Per-item flags on a cross-item object (`baseDecoding`, `decoding` on a pipeline reused across photos) get cleared by the PREVIOUS item's completion, unblocking or clobbering the current one.
    Guard every write to shared bookkeeping with the closure's own identity; reset the flag at item change so abandoned work never blocks the successor.
58. **A budget formula allowed below its correctness floor.**
    A sizing formula (`√(budget/bytes)`) quietly drops below 1 when the input outgrows the budget, turning a margin-limiter into a coverage-cutter.
    Every budget that shapes an optional extra needs an explicit floor at the mandatory part; budgets bound cushions, never promises.
59. **A silent default on a failed metadata read.**
    Degrading a failed EXIF/metadata read to a default (rotation 0) renders WRONG content when a sibling renderer read the same metadata successfully — two renderers, two answers, composited.
    When alignment with another renderer cannot be proven, reject into the path with ONE renderer; wrong pixels are never fail-soft.
60. **A blocking call on a module's serial async queue.**
    One non-coroutine function waiting on a lock (a close behind a multi-second decode) stalls every unrelated call on the module's single queue.
    Anything that can wait must dispatch like its siblings; audit the odd one out in any AsyncFunction block.
61. **A version probe that cannot probe the stored data shape.**
    An invalidation mechanism queried MediaStore columns through the `file://` uris the app actually stores — always returning "unknown", making the whole feature inert while reading as implemented.
    When adding a probe, verify it fires on the REAL stored identifiers (and treat "cannot verify" as stale, never as permission to reuse).
62. **A timer standing in for ownership.**
    A deferred release protects the replacing surface's next commit — not a SIBLING surface whose state still holds the old ref indefinitely.
    Shared refs need pin-scoped lifetime (park until the last consumer's pin drops), not a grace period.
63. **An identity-keyed effect blind to same-identity content changes.**
    Effects keyed on id+uri never re-run when an in-place edit changes the bytes behind the same id — the one path users actually take to edit.
    Content-sensitive pipelines need a foreground/content-version trigger alongside the identity deps.
64. **A module-level cache outliving its last subscriber's reclaim signal.**
    Tearing down the last subscriber removed the memory-pressure listener but kept the cache — megabytes strandable with nothing able to flush them.
    The last consumer leaving either flushes the cache or keeps the reclaim path alive; never neither.
65. **A simultaneous-gesture finalizer resetting stream state a sibling still reads.**
    Recognizers over one touch stream finalize at different times; a full reset in the earlier one erases flags the later one's deactivation logic reads.
    Stream-scoped state is reset by the LAST handler out (or preserved across the earlier finalizer), never by whichever finishes first.
