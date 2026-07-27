# Dev handoff — implement desktop v0.6

*For the agent implementing v0.6. Disposable round doc; delete when v0.6 ships.
This file orients you and defines process — the contracts themselves live in `docs/Plan_v0.6.md` and are not repeated here.*

## Read in this order

1. Repo root `CLAUDE.md` — orientation map, commands, invariants.
2. `apps/desktop/CLAUDE.md` and `packages/core/CLAUDE.md` — per-file maps and behavior contracts. Trust the maps; keep them current as you add files.
3. **`docs/Plan_v0.6.md` — the authoritative implementation plan.** Scope, verified constraints, phases P1–P5, and per-phase gates. It survived a 32-round independent review; treat every stated contract as deliberate, not filler.
4. `PLAN.md` §"The Lightroom reality" and the v0.6 roadmap entry — product-level framing.
5. `docs/Investigation_v0.6.md` — the evidence log behind the plan's constraints (render timings, CLI quirks, spike results, library audit). **Consult it; never re-run the investigation.**
6. `docs/Feedback_v0.6.md` — the tester items v0.6 answers.

## State when you start

- Last shipped desktop release: v0.5 (`desktop-v0.5`). Version bumps 0.5.0 → 0.6.0; release tag will be `desktop-v0.6.0`. Work happens on branch `initial`.
- Unreleased desktop work already on the branch (windowed settings, app icon, hardening) rides along — do not redo or revert it.
- No v0.6 code exists yet. P1 (detection core) is the starting point.

## Environment facts

- **Dev machine (Linux)**: darktable is flatpak-only (`org.darktable.Darktable`); RawTherapee installable from flathub. Real test material: `/mnt/onesie/Pictures` has darktable-edited ARW + `.xmp` and RT-edited ARW + `.pp3` pairs (paths and verified render commands are in the investigation log, §A1/A3).
- **Deployment/test machine (Windows, "home-pc")**: SSH access — identity, address, and setup live in the private `machine-setup` repo, `machines/home-pc/` (never commit those identifiers here; this repo is publicly readable). On it: Lightroom Classic (updated 2026-07), darktable 5.2.1, RawTherapee 5.12, the family library on `M:\Photos\Years`, and the investigation's working dir `C:\Users\home\afterglow-tests\` containing the prototype LR plugin (`AfterglowProto.lrplugin`, menu-start only) and rendered test outputs. The LR metadata-prompt suppression preference is already set on this machine.
- Windows PowerShell gotchas learned the hard way: run anything non-trivial as a pushed `.ps1` file, ASCII-only, never `$args` as a variable name; interactive-desktop work (screenshots, GUI launches) needs a `schtasks /it` scheduled task. The OS-launched screensaver process is named `Afterglow.scr`, and GDI captures of the running saver can be black while the monitor shows photos (hardware overlay) — neither is a bug.

## Process contract

- **Work phase by phase (P1 → P5).** A phase is done when its gate passes, its tests land, and every affected doc (CLAUDE.md maps, README where user-facing) is updated. Do not start the next phase on a failing gate.
- **Autonomous decisions**: the plan flags planning-stage calls inline as **(autonomous)**. Number implementation-time judgment calls in the plan's "Autonomous decisions" appendix as you make them; getting them human-vetted is a top priority. Read the appendix and PLAN.md's backlog before re-deciding anything.
- **Verify before claiming done** (repo root `CLAUDE.md` has the full command list): `npm run lint`, `npm run typecheck -w afterglow-desktop`, `npm test -w afterglow-desktop`, `npm run build -w afterglow-desktop`, and after any core edit `npm run build -w @afterglow/core` + `npm test -w @afterglow/core`. Headless e2e: `xvfb-run -a npx electron apps/desktop --smoke --show`.
- **Review**: at each phase boundary, run `/codex-review` over the phase's changes and fix findings until clean before moving on.
- **Commit per phase** (message style: see `git log`), on branch `initial`. Do not tag or release; P5's release steps happen with the human.
- Live-render verification on real photos (the P2 gate's CR2/CR3/DNG cases, the P4 end-to-end gate) requires the Windows machine and/or the human — batch those checks and ask rather than skipping them.
- When the plan and reality disagree (an API doesn't exist, a verified constraint proves wrong), stop and surface it — never silently substitute a different design.

## Kickoff prompt

> Read docs/Handoff_v0.6.md and everything it lists, in order. Then implement Phase P1 of docs/Plan_v0.6.md — the pure detection core — exactly to its stated contract and gate, following the handoff's process contract (tests + docs land with the phase, autonomous decisions numbered in the plan's appendix, /codex-review clean before finishing the phase). When P1's gate passes and review is clean, report what you built, list any autonomous decisions for vetting, and stop for confirmation before starting P2.
