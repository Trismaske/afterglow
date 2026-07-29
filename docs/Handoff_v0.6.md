# Dev handoff — implement desktop v0.6

*For the agent implementing v0.6. Disposable round doc; delete when v0.6 ships.
This file orients you and defines process — the contracts themselves live in `docs/Plan_v0.6.md` and are not repeated here.*

## Read in this order

1. Repo root `CLAUDE.md` — orientation map, commands, invariants.
2. `apps/desktop/CLAUDE.md` and `packages/core/CLAUDE.md` — per-file maps and behavior contracts. Trust the maps; keep them current as you add files.
3. **`docs/Plan_v0.6.md` — the authoritative implementation plan.** Scope, verified constraints, phases P1–P5, and per-phase gates. Every stated contract is deliberate, not filler — the plan has been reviewed and revised repeatedly, and its density is the product of settled arguments. Its **rendering predicate** is the load-bearing idea: read that section before anything else, because it decides both display behavior and what the v0.7 organizer inherits.
4. `PLAN.md` §"The Lightroom reality" and the v0.6 roadmap entry — product-level framing.
5. `docs/STATE_MODEL.md` — mobile's shipped three-layer contract (verdict · actions · annotations). v0.6's flag-model changes, the on-screen marker, and the queue-window palette align to it by design (the plan's "Cross-app alignment" paragraph and P5 say exactly how); v0.7 builds on it. Do not invent state or colour vocabulary it already defines.
6. `docs/Investigation_v0.6.md` — the evidence log behind the plan's constraints (render timings, CLI quirks, both plugin spikes, library audit). **Consult it; never re-run the investigation.**
7. `docs/Feedback_v0.6.md` — the tester items v0.6 answers.

## State when you start

- Last shipped desktop release: v0.5 (`desktop-v0.5`). Version bumps 0.5.0 → 0.6.0; release tag will be `desktop-v0.6.0`. Work happens on branch `initial`.
- Unreleased desktop work already on the branch (windowed settings, app icon, hardening) rides along — do not redo or revert it.
- **Core changed under the mobile releases (m0.8–m0.8.2, shipped)**: `deck.ts`/`cull.ts` are deleted, `grouping.ts` (the embedding grouping engine + pinned label-suite tests) is in, and `PHOTO_STATES` is the four-verdict model. v0.6's only core change is `flags.ts` (v2 model per the plan) — **mobile never imports `flags.ts`** (verified), so that change is desktop-owned; any core change that *would* touch mobile's surface needs the mobile team's sign-off first.
- No v0.6 code exists yet. P1 (detection core) is the starting point.

## Environment facts

- **Dev machine (Linux)**: darktable is flatpak-only (`org.darktable.Darktable`); RawTherapee installable from flathub. Real test material: `/mnt/onesie/Pictures` has darktable-edited ARW + `.xmp` and RT-edited ARW + `.pp3` pairs (verified render commands: investigation log, "Renderer invocations and timings").
- **Deployment/test machine (Windows, "home-pc")**: SSH access — identity, address, and setup live in the private `machine-setup` repo, `machines/home-pc/` (never commit those identifiers here; this repo is publicly readable). On it: Lightroom Classic (updated 2026-07), darktable 5.2.1, RawTherapee 5.12, the family library on `M:\Photos\Years`, and the investigation's working dir `C:\Users\home\afterglow-tests\` containing the prototype LR plugin (`AfterglowProto.lrplugin` v0.3 — auto-starts its watcher on LR launch via `LrForceInitPlugin`; job protocol and timing logs under `lr-jobs2\`) and rendered test outputs. Both LR dialog-suppression preferences (metadata-read and AI-update) are already set on this machine.
- Windows PowerShell gotchas and screensaver diagnostics: `docs/DEVELOPMENT.md` § Windows screensaver diagnostics (pushed `.ps1` files, `schtasks /it`, `Afterglow.scr` process naming, black GDI captures).

## Process contract

- **Work phase by phase (P1 → P5).** A phase is done when its gate passes, its tests land, and every affected doc (CLAUDE.md maps, README where user-facing) is updated. Do not start the next phase on a failing gate.
- **Autonomous decisions**: every planning-stage call has been human-vetted (2026-07-29 grilling session), and the 2026-07-29 pre-build spike converted the plan's remaining hypotheses into measured facts (LR throughput, dialog suppression, mask fidelity — evidence in the investigation log). **There are no untested assumptions left**: do not re-verify settled constraints, and do not re-decide settled contracts. Number implementation-time judgment calls in the plan's "Autonomous decisions" appendix as you make them; getting them human-vetted is a top priority. Read the appendix and PLAN.md's backlog before re-deciding anything.
- **Verify before claiming done** (repo root `CLAUDE.md` has the full command list): `npm run lint`, `npm run typecheck -w afterglow-desktop`, `npm test -w afterglow-desktop`, `npm run build -w afterglow-desktop`, and after any core edit `npm run build -w @afterglow/core` + `npm test -w @afterglow/core` **plus** `npm run typecheck -w afterglow-companion && npm test -w afterglow-companion` (core is shared with the shipped mobile app — prove you broke nothing there). Headless e2e: `xvfb-run -a npx electron apps/desktop --smoke --show`.
- **Review**: at each phase boundary, run `/codex-review` over the phase's changes and fix findings until clean before moving on.
- **Commit per phase** (message style: see `git log`), on branch `initial`. Do not tag or release; P5's release steps happen with the human.
- Live-render verification on real photos (the P2 gate's CR2/CR3/DNG cases, the P4 end-to-end gate) requires the Windows machine and/or the human — batch those checks and ask rather than skipping them.
- When the plan and reality disagree (an API doesn't exist, a verified constraint proves wrong), stop and surface it — never silently substitute a different design.

## Kickoff prompt

> Read docs/Handoff_v0.6.md and everything it lists, in order. Then implement Phase P1 of docs/Plan_v0.6.md — the pure detection core — exactly to its stated contract and gate, following the handoff's process contract (tests + docs land with the phase, autonomous decisions numbered in the plan's appendix, /codex-review clean before finishing the phase). When P1's gate passes and review is clean, report what you built, list any autonomous decisions for vetting, and stop for confirmation before starting P2.
