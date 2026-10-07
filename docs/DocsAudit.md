# Docs & comments audit — work order (parallel to the release trains)

**Status:** not started. This is a standalone documentation effort, independent of any release.
**Delete this file when the audit lands.** Its durable output is the reorganized documentation itself.
**Coordination:** the repo works on one branch (`initial`). This audit touches only Markdown and comments, so conflicts with feature work are unlikely but possible — rebase early, and land it as its own commit series. If m0.9 implementation is running, prefer a worktree and frequent small merges over one big drop.

## Mandate (Tristan, 2026-08-26, m0.9 pre-build grilling)

The repo's guidance is scattered and partly dangling.
Symptoms found so far:

- **Dangling lettered principles.** Feedback docs cited "L1" and "L6" whose definitions lived in an earlier round's feedback doc, deleted per its own lifecycle (the m0.8.7–m0.9 doc that carried the citations is itself gone with m0.9's ship). Letters outlived their home; the code headers that restate them (below) are what remains to recover.
- **Principles restated instead of cited.** The "settings rows earned by a guess" reasoning is restated in at least three code headers (`apps/mobile/src/lib/badgePrefs.ts`, `apps/mobile/src/screens/DeckScreen.tsx`, `apps/mobile/src/components/DecisionBadge.tsx`). When the principle changed (see L6 below), every copy went stale at once.
- **No CONTRIBUTING.md.** The industry-standard home for repo-local engineering principles and process does not exist; fragments of that content sit in CLAUDE.md files, code headers, and release docs.
- Docs have grown organically: some content is durable and generic, some is stale, some is slop.

The goal: **every durable fact and principle has exactly one, obvious, durable home; everything else is deleted; code and docs cite, never restate.**
Different repos have different principles — everything stays repo-local.
Pre-v1, Tristan reviews the organized result and decides what lifts to his global `~/.claude/AGENTS.md`.

## The target structure (use existing homes; create only industry standards)

| Home | What belongs there |
|---|---|
| **CONTRIBUTING.md** (create) | Repo-local engineering and product principles, under **names, not letters**; the development process (release flow already in CLAUDE.md may stay there — decide, don't duplicate); review/self-review process pointers |
| README.md | Users and testers only |
| PLAN.md | Product vision, roadmap, shipped records |
| docs/DEVELOPMENT.md | Environment setup, run/debug |
| docs/REVIEW_CLASSES.md | Defect classes (already well-defined) |
| docs/STATE_MODEL.md, docs/STATS_ACCURACY.md | Domain contracts (already well-defined) |
| docs/TODO.md | Parked open questions (already well-defined) |
| Per-package CLAUDE.md / AGENTS.md | Per-file maps and package-local conventions only |
| Code file headers | File-local behavior contracts and rationale; principles **cited by name**, never restated |

## The audit process

1. **Inventory.** Every `.md` in the repo, every code file-header comment, and every comment that states a rule or principle (grep for reasoning-shaped comments: "vetted", "decided", "principle", "rule", "never", "always", "policy", "(Tristan").
2. **Recover the lettered principles.** Git history holds the deleted feedback docs that defined L1–Ln (the 2026-07-31 round's doc and earlier). Recover every definition still cited anywhere; retire the letters — each becomes a **named** principle in CONTRIBUTING.md, and every citation updates to the name.
3. **Classify every inventoried item:**
   - *Durable generic principle* → CONTRIBUTING.md, named, one home.
   - *Domain contract* → the matching contract doc (STATE_MODEL, STATS_ACCURACY, REVIEW_CLASSES).
   - *File-local rationale* → stays in the header, trimmed, citing principles by name.
   - *Stale / journey content / slop* → delete (the repo rule: docs describe now; git history is the archive).
4. **Sweep the restatements.** Every code comment that restates a principle now cites it instead.
5. **Index.** Root CLAUDE.md's docs table gains CONTRIBUTING.md with a one-line "when to read".

## Known content that must land (inputs from the m0.9 grilling, 2026-08-26)

- **L1** ("one subsystem, one device pass, one review cycle per release") — recover, name it, and record that **m0.9 deliberately drops it** for that release (the animated-thumbnail subsystem decision).
- **L6 — superseded.** The old form ("a settings row is earned by evidence, not a guess") is replaced by Tristan's rewrite, which is repo-wide, not settings-specific:
  > A setting (or control, or surface) exists when a real need does — never speculatively. Once the need exists, clarity beats compactness: give it full room, with explanatory subtext that tells a novice exactly what it changes. Space spent on comprehension is never waste; the only waste is things no one needs.
  Update the three restating code headers to cite the named principle.
- Candidate principles visible in recent decisions (name them properly during the audit): *accuracy and honesty outrank polish and speed* (items-vs-photos copy, unknown-value tiers, pixel-honest zoom); *metadata first, then measure — never guess* (the D15/EXIF pattern, dimension rescue); *evidence tiers on every claim* (reported / read / measured).

## Definition of done

- Zero dangling lettered references anywhere in the repo.
- CONTRIBUTING.md exists, is indexed from root CLAUDE.md, and holds every generic principle exactly once, under names.
- No code comment restates a principle; citations only.
- Deleted content is deleted, not annotated.
- `npm run lint && npm run format:check` pass; every cross-reference resolves.
- A closing summary for Tristan: what moved where, what was deleted and why, and the candidate list for the pre-v1 global-lift review.
