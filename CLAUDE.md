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
- **Mobile trash-path conservatism**: both removal affordances use the local Android 11+ `MediaStore.createTrashRequest` module; there is no permanent-delete fallback. Per-photo review states in SQLite are the durable truth; the in-flight session snapshot is disposable.
- **Assumptions discipline**: every autonomous decision goes into the numbered log `docs/assumptions-{core,desktop,mobile}.md`; the cross-train review shortlist is `docs/ASSUMPTIONS.md`. Read the relevant log before re-deciding something.
- Style: split pure logic (unit-tested) from impure bindings; match the existing heavy header-comment style.

## Release flow

Tags trigger CI to GitHub Releases: `desktop-v*` → Windows installer (+ `.scr` screensaver) & Linux AppImage/deb (`.github/workflows/desktop-release.yml`); `mobile-m*` → release APK (`mobile-release.yml`: clean `expo prebuild` + Gradle — `apps/mobile/android` is **gitignored prebuild output**). Release scripts require exact tag/version mapping, monotonic Android versionCode, all expected artifacts, and SHA-256 manifests. GitLab delivery is deferred. Versions: `apps/desktop/package.json`; mobile `app.json` (`version` + `android.versionCode`) and `apps/mobile/package.json`. The APK signs with the standard shared debug keystore — changing signing breaks testers' in-place upgrades. Work happens on branch `initial`.

## Docs index (read on demand)

| Doc | When to read |
|---|---|
| PLAN.md | Product vision, feature semantics, roadmap/version numbering |
| docs/DEVELOPMENT.md | Dev env setup, emulator, run/debug commands |
| docs/ASSUMPTIONS.md | Shortlist of open decisions needing human review (kept current; resolved items are pruned) |
| docs/assumptions-{core,desktop,mobile}.md | Full per-train decision logs (append yours) |
| docs/Feedback_YYYYMMDD.md / docs/Plan_YYYYMMDD.md | Current tester feedback + the release plan answering it (removed once shipped) |
| README.md | User/tester-facing: formats, key bindings, install notes |
