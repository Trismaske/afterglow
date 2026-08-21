# Afterglow — orientation map

Two apps, one shared brain.
Product vision and roadmap: [PLAN.md](PLAN.md). Read it only when product context matters.

- **apps/desktop** — "Afterglow": an Electron fullscreen ambient slideshow with flag-to-queue capture. Vanilla TS with an esbuild renderer, **no framework**.
- **apps/mobile** — "Afterglow" for Android (workspace `afterglow-companion`): an Expo/React-Native photo-culling app. Swipe-deck groups, staged deletes, a to-edit queue.
- **packages/core** — `@afterglow/core`: pure-TS shared logic (time clustering, dHash similarity, embedding cull grouping, mix engine, flag queue). The apps consume its **built `dist/`**. After you edit core, run `npm run build -w @afterglow/core`.

Each package has its own CLAUDE.md or AGENTS.md with a **per-file map**.
**Trust the maps instead of scanning the tree.**
Keep the maps current when you add or move files.
The file-header comments in the code are the authoritative documentation.
Read the header before the body.

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

Environment setup (Android toolchain and emulator, one command): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
⚠️ Run every `npx expo …` command from `apps/mobile`, never from the repo root.

## Cross-cutting invariants

- **Core is pure**: no platform or filesystem APIs, no `Date.now()`, no `Math.random()`. Time is an injected `at`. Randomness is an injected `Rng`. Core is ESM with explicit `.js` import extensions.
- **Desktop security model**: contextIsolation plus sandbox, with preload/contextBridge as the only bridge. Media is served through the `afterglow://` protocol with realpath containment. Child processes run through `execFile` argument vectors, never shell strings.
- **Mobile trash-path conservatism**: both removal affordances use the local `MediaStore.createTrashRequest` module. There is no permanent-delete fallback. The per-photo review states in SQLite are the durable truth. The in-flight session snapshot is disposable.
- **Assumptions discipline**: flag planning-stage autonomous calls inline as **(autonomous)** in the current release plan (`docs/Plan_<version>.md`). Those flags are the authoritative pre-implementation log. The plan's "Autonomous decisions" appendix numbers each decision as it is implemented, plus new judgment calls made mid-build. Getting entries human-vetted is a top priority. An approved decision is no longer an assumption, so prune it: items that need future work move into a release plan or PLAN.md's roadmap or backlog, and settled behavior lives in PLAN.md or code headers. Before you re-decide something, read the plan's flags and appendix, and PLAN.md's backlog.
- **Docs describe now, not the journey**: every doc states only current and planned behavior, as short as specificity allows. No changelogs, no "previously/was/used to", no superseded plans. Git history is the archive. Delete outdated content instead of annotating it. (Exception: version markers that tell *testers* what a release changed, in README and release notes.)
- Style: split pure logic (unit-tested) from impure bindings. Match the existing heavy header-comment style.

## Release flow

Tags trigger CI builds to GitHub Releases.
A `desktop-v*` tag builds the Windows installer (with the `.scr` screensaver) and the Linux AppImage and deb (`.github/workflows/desktop-release.yml`).
A `mobile-m*` tag builds the release APK (`mobile-release.yml`: a clean `expo prebuild` plus Gradle). Note that `apps/mobile/android` is **gitignored prebuild output**.
The release scripts require an exact tag-to-version mapping, a monotonic Android versionCode, all expected artifacts, and SHA-256 manifests.
A mobile release must first pass the UI gate (docs/MOBILE_UI_GATE.md) on a test device.
GitLab delivery is deferred.
Version locations: `apps/desktop/package.json` for desktop. Mobile versions live in `app.json` (`version` plus `android.versionCode`) and `apps/mobile/package.json`.
The APK signs with the standard shared debug keystore.
Pre-v1 policy: no upgrade or back-compat constraints. Signing, identifiers, and databases may change freely between 0.x releases, and testers reinstall. This hardens at v1.
Work happens on branch `initial`.

## Docs index (read on demand)

| Doc | When to read |
|---|---|
| PLAN.md | Product vision, feature semantics, roadmap and version numbering |
| docs/DEVELOPMENT.md | Dev env setup, emulator, run/debug commands |
| docs/ANDROID_DEVICE_TESTING.md | Pair and control physical Android phones over wireless ADB. Multi-device automation |
| docs/MOBILE_UI_GATE.md | Automated pre-release UI walk of the mobile app (`scripts/mobile-ui-gate.mjs`) plus the manual pass |
| docs/STATE_MODEL.md | **Read before touching any surface that shows photo state.** The three layers (verdict · actions · annotations) and the six visual rules. The contract every state surface is held to |
| docs/TODO.md | Open questions parked for their own investigation |
| docs/REVIEW_CLASSES.md | The recurring defect-class checklist. The self-review input before any `codex-review` round |
| docs/STATS_ACCURACY.md | **Read before touching any stat, deleter, or scope predicate.** Per-stat lifetime-true vs current-state verdicts, the ranked accuracy gaps with fix shapes, and the update discipline |
| docs/Feedback_<version>.md / docs/Plan_<version>.md (e.g. `Plan_m0.8.md`) | Current tester feedback plus the release plan that answers it, named for the release they target (removed once shipped). A round that spans several releases is named for the LINE (e.g. `docs/Feedback_m0.8.7-m0.9.md` for the 2026-08-20 round), and its shipped sections prune at each release close |
| docs/grouping-study/ | Grouping regression labels (human-judged pairs) plus study tooling. Local-only data is gitignored (see its README) |
| README.md | User and tester facing: formats, key bindings, install notes |
