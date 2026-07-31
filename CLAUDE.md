# Afterglow — orientation map

Two apps, one shared brain. Product vision + roadmap: [PLAN.md](PLAN.md) (read only when product context matters).

- **apps/desktop** — "Afterglow": Electron fullscreen ambient slideshow + flag-to-queue capture. Vanilla TS + esbuild renderer, **no framework**.
- **apps/mobile** — "Afterglow Companion": Expo/React-Native Android photo-culling app (swipe-deck groups, staged deletes, to-edit queue).
- **packages/core** — `@afterglow/core`: pure-TS shared logic (time clustering, dHash similarity, deck/cull session models, mix engine, flag queue). Apps consume its **built `dist/`** — after editing core, run `npm run build -w @afterglow/core`.

Each package has its own CLAUDE.md / AGENTS.md with a **per-file map. Trust the maps instead of scanning the tree**; keep them current when you add/move files. The codebase's file-header comments are authoritative documentation — read the header before the body.

## Commands (repo root; npm workspaces)

```bash
npm ci                                             # once
npm run lint && npm run format:check               # repo-wide quality gates
npm run build -w @afterglow/core                   # REQUIRED after core edits
npm test -w @afterglow/core                        # core unit tests
npm run typecheck -w afterglow-desktop && npm test -w afterglow-desktop && npm run build -w afterglow-desktop
xvfb-run -a npx electron apps/desktop --smoke --show   # desktop headless e2e (see apps/desktop/CLAUDE.md)
npm run typecheck -w afterglow-companion && npm test -w afterglow-companion
cd apps/mobile && npx expo export --platform android --output-dir /tmp/expo-export   # Metro bundle proof
```

Environment setup (Android toolchain/emulator, one command): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). ⚠️ Run all `npx expo …` from `apps/mobile`, never the repo root.

## Cross-cutting invariants

- **Core is pure**: no platform/FS APIs, no `Date.now()`/`Math.random()` — time is an injected `at`, randomness an injected `Rng`. ESM with explicit `.js` import extensions.
- **Desktop security model**: contextIsolation + sandbox, preload/contextBridge only; media served via the `afterglow://` protocol with realpath containment; child processes via `execFile` argument vectors, never shell strings.
- **Mobile trash-path conservatism**: both removal affordances use the local `MediaStore.createTrashRequest` module; there is no permanent-delete fallback. Per-photo review states in SQLite are the durable truth; the in-flight session snapshot is disposable.
- **Assumptions discipline**: planning-stage autonomous calls are flagged inline as **(autonomous)** in the current release plan (`docs/Plan_<version>.md`) — those flags are the authoritative pre-implementation log. The plan's "Autonomous decisions" appendix numbers decisions as they are implemented, plus new judgment calls made mid-build. Getting entries human-vetted is a top priority: once approved, a decision is no longer an assumption — prune it (items needing future work move into a release plan or PLAN.md's roadmap/trigger-based backlog; settled behavior lives in PLAN.md/code headers). Read the plan's flags/appendix and PLAN.md's backlog before re-deciding something.
- **Docs describe now, not the journey**: every doc states only current and planned behavior, as short as specificity allows. No changelogs, no "previously/was/used to", no superseded plans — git history is the archive; delete outdated content instead of annotating it. (Version markers that tell *testers* what a release changed — README, release notes — are the exception.)
- Style: split pure logic (unit-tested) from impure bindings; match the existing heavy header-comment style.

## Release flow

Tags trigger CI to GitHub Releases: `desktop-v*` → Windows installer (+ `.scr` screensaver) & Linux AppImage/deb (`.github/workflows/desktop-release.yml`); `mobile-m*` → release APK (`mobile-release.yml`: clean `expo prebuild` + Gradle — `apps/mobile/android` is **gitignored prebuild output**). Release scripts require exact tag/version mapping, monotonic Android versionCode, all expected artifacts, and SHA-256 manifests. Mobile releases additionally pass the UI gate (docs/MOBILE_UI_GATE.md) on a test device first. GitLab delivery is deferred. Versions: `apps/desktop/package.json`; mobile `app.json` (`version` + `android.versionCode`) and `apps/mobile/package.json`. The APK signs with the standard shared debug keystore. Pre-v1 policy: no upgrade/back-compat constraints — signing, identifiers, and databases may change freely between 0.x releases (testers reinstall); this hardens at v1. Work happens on branch `initial`.

## Docs index (read on demand)

| Doc | When to read |
|---|---|
| PLAN.md | Product vision, feature semantics, roadmap/version numbering |
| docs/DEVELOPMENT.md | Dev env setup, emulator, run/debug commands |
| docs/ANDROID_DEVICE_TESTING.md | Pair/control physical Android phones over wireless ADB; multi-device automation |
| docs/MOBILE_UI_GATE.md | Automated pre-release UI walk of the companion app (`scripts/mobile-ui-gate.mjs`) + manual pass |
| docs/STATE_MODEL.md | **Read before touching any surface that shows photo state.** The three layers (verdict · actions · annotations) and the six visual rules — shipped in m0.8.2, and the contract every state surface is held to |
| docs/TODO.md | Open questions parked for their own investigation |
| docs/REVIEW_CLASSES.md | The recurring defect-class checklist — the self-review input before any `codex-review` round |
| docs/Errors_design.md | DRAFT — the error-surfacing contract across the platform boundaries (three tiers; classify from facts we own, never from Android's error text). Not decision-complete: §6 is unsettled |
| docs/Feedback_<version>.md / docs/Plan_<version>.md (e.g. `Plan_m0.8.md`) | Current tester feedback + the release plan answering it, named for the release they target (removed once shipped) |
| docs/grouping-study/ | Grouping regression labels (human-judged pairs) + study tooling; local-only data gitignored (see its README) |
| README.md | User/tester-facing: formats, key bindings, install notes |
