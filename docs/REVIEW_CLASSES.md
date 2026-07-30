# Recurring defect classes — the pre-review checklist

The input to the self-review before any `codex-review` round (the skill
expects a running class list; this is the repo's). Every class below was
found at least once in a real review cycle here, and recurring classes
are the strongest predictor of the next round's findings. Sweep the
change set against each before spending a review round. Classes marked
**(device)** were only ever found by running the code on a phone — spend
part of any cycle's budget on device runs, because static review has
never caught their siblings.

## Data layer

1. **Two-statement queue exits** — leaving a queue means deleting the
   never-done row AND demoting the done one; use `leaveQueue`, never one
   statement.
2. **SQL placeholder/argument drift** — TypeScript sees none of it;
   count `?`s against args, especially chunked/IN-list builders.
3. **Removed column or table still referenced in SQL** — cross-check
   every identifier against the current `BASELINE_DDL`.
4. **Optimistic patch disagreeing with its SQL** — the reviewPatch
   parity harness pins these; give every new write a parity case.
5. **One write where two layers changed** — a verdict without its
   action, or vice versa.
6. **Multi-statement logical writes outside a transaction** — a death
   between them leaves half a truth.
7. **Dependent writes after a guarded no-op** — capture the affected-row
   count and return before resolving copy matches / restoring stars /
   stamping History for a transition that did not happen.
8. **Reporting requested instead of committed** — batch writes that
   silently skip stale rows must return the APPLIED set; counts, patches
   and goal credits follow what committed.

## Contracts & state

9. **Fail-open where the contract says fail-closed** — a failure
   becoming a zero, an empty list, a blank surface, or a broadened
   scope. Sweep every catch and every `?? 0` / `?? []`.
10. **Failure sentinels doubling as domain states** — 'missing'/`[]`
    standing for both "read failed" and "genuinely gone" flows failures
    into completion routing; keep an explicit failed state with retry.
11. **Direction-blind action reads** — favourite is the only action that
    points backwards; every favourite surface must read direction
    (intent-first for the heart, verified-first for "applied" stats).
12. **Verdict/action flattening on a surface** — the two layers coexist;
    an action badge must never replace a verdict badge.
13. **A surface diverging from the shared badge/weight vocabulary** —
    hand-rolled icons drift; render through photoBadges/DecisionBadge.
14. **Retained data outliving the scope that produced it** — keep-last
    is only valid within an unchanged scope; tag cached data with its
    scope key.
15. **A documented convention not wired** — if a doc or appendix
    promises a behaviour ("no selection = everyone"), grep for the
    wiring.

## Bounds, caches, and guarantees

16. **Inclusive bound handed to an exclusive query** **(device)** — the
    MediaStore `createdAfter/Before` render as strict comparisons; widen
    ±1 ms everywhere an inclusive range meets them (walk a one-element
    and a boundary-equal case).
17. **A bound assumed rather than walked** **(device)** — merge windows
    are maximal chains, not fixed slices.
18. **A one-directional check presented as a guarantee** **(device)** —
    a tripwire that only sees losses needs a second check for gains.
19. **A backstop unreachable from the path it guards** **(device)** —
    trace every periodic/fallback reconciliation to prove reachability.
20. **A cache TTL wider than the proof it feeds** — a count or catalog
    cached for display must not serve a baseline/tripwire whose validity
    window is narrower; take fresh reads for proofs.
21. **A baseline compared across the boundary that defines its
    validity** — MediaStore generations are only comparable within one
    provider version; bake the boundary into the key.
22. **State captured at read time re-derived from patched data** — page
    tails/fullness are facts about the SOURCE; carry them from the read,
    never recompute from optimistically patched arrays.
23. **A bounded read serving an unbounded promise** — a hidden LIMIT
    under a route that claims entirety silently truncates; caps must be
    loud or absent.
24. **A guard's exclusion creating a sibling hole** — every filter in a
    new check (e.g. "non-trashed only") is a place the same defect
    survives; re-run the scenario through the excluded set.
25. **A fallback inside a fix re-opening the hole it closes** — if the
    fix exists because the fallback value is unsafe, failing is the only
    safe fallback.
26. **Unserialized lazy initialization** — concurrent first calls
    double-count or double-arm; single-flight or chain them, and sample
    shared counters at a defined point relative to reads.
27. **Unfenced optimistic writes** — overlapping writes need a
    generation fence AND a durable-value anchor: only the latest may
    roll back or alert, any success newer than the last recorded one
    advances the baseline, and rollbacks land on persisted values, never
    earlier optimistic renders.
28. **Id-keyed mutation across colliding namespaces** — raw MediaStore
    ids collide across volumes; until identity is volume-qualified,
    enumeration is the only alias-proof reconcile.

## UI tests (the device gate)

29. **Choreography silently degenerating when the data shape shifts**
    **(device)** — steps must verify their preconditions from truthful
    counts (the overview), record real start positions, and reroute.
30. **Assertions satisfiable by absent-anchor defaults** **(device)** —
    a failed UI dump reading as two matching zeroes; only anchored dumps
    may satisfy an equality, and early returns need anchored evidence.
31. **Position-relative steps breaking anchored assertion chains**
    **(device)** — never re-act on a stale position; re-read before
    every move, and refuse to proceed from an unproven position.
32. **Overlays eating taps without taking the foreground** **(device)**
    — PiP windows, and the app's own raised tab bar at screen edges;
    tap on positive evidence with re-tap loops, dismiss known offenders
    every step.
33. **Dependent steps running after their anchor step failed** — record
    them failed-skipped; never write real decisions from an unknown
    position.

## Reachability & snapshot discipline (m0.8.3 — the cycle's dominant family)

34. **A bulk or destructive write reading the world fresh at write time**
    — every fresh read can WIDEN the write past what the user saw (a
    remount, a reload landing late, a null enumeration). Bulk writes
    bind to the RENDERED set intersected with an invalidated fresh
    reachable read (shrink-only); explicit single targets act
    unconditionally (the M5 rule, STATE_MODEL.md); physical operations
    always bind to reachable.
35. **A snapshot published apart from the data it describes** — a
    mounted set (or any paired context) set before its rows commit, by
    a superseded load, or surviving a no-op refresh unpublished, pairs
    one world's data with another's predicate. Publish atomically with
    the rows, latest-load-only, and on no-op paths too.
36. **Two native reads treated as one snapshot** — generations before
    mounted volumes, a count memo beside a fresh enumeration: anything
    that changed between them silently defeats checks built on their
    agreement. Verify the later read still covers the earlier one, and
    re-fence immediately before ACCEPTING a skip or claiming coverage.
37. **A reachability predicate appended beside an OR-facts branch** —
    `reach` next to `(is_present = 1 OR state = 'trashed')` silently
    scopes the FACTS branch too; reachability scopes live rows only.
38. **An IN-list bound sized by user data** — a rendered-ids bound or
    volume-qualified source clause hits SQLite's 999-variable floor at
    real scale; chunk it or cap the input with an actionable error.
39. **A refresh trigger missing one of its worlds** — navigation focus,
    foreground return, and LIVE volume broadcasts are three separate
    signals; a screen wired to fewer than it needs goes stale exactly
    when the world changes without the missing signal
    (useExternalRefresh wires the non-navigation two).
40. **Fix-on-fix drift** — across ten review rounds, the newest hunks
    (my fixes to prior findings) were consistently where the next
    defects lived: incomplete rollouts of a principle (one path of
    four), a fix written against the wrong key shape, a bound added
    without its chunking. Point re-review budget at the newest changes
    first, and sweep a principle across EVERY sibling path in the same
    round.
