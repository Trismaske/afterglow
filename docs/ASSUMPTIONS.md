# Assumptions log

Decisions made autonomously during the build (2026-07-17) that Tristan should review.
Per-train logs live in `assumptions-desktop.md` / `assumptions-mobile.md` during the
build and get merged here at the end.

## Repo & tooling

1. **Building on branch `initial`** (main + plan commit), one commit per version.
   Merge to `main` via PR when you're happy.
2. **Desktop renderer is vanilla TypeScript + esbuild, no React/Vite.** A slideshow
   is DOM-light; fewer moving parts beats framework ergonomics here. Mobile still
   uses React (Expo), so core stays framework-agnostic.
3. **`@afterglow/core` compiles to `dist/` via tsc** (`prepare` script builds it on
   install); apps consume the built output. Trains must run
   `npm run build -w @afterglow/core` after changing core.
4. **Expo SDK 57 / RN 0.86 / React 19.2** — whatever `create-expo-app@latest`
   produced today. Media permissions need a dev build (not Expo Go), as the plan
   says.
5. **No device/emulator on this machine** (no adb): mobile verification is
   typecheck + `expo export --platform android` (Metro bundle) + unit tests on
   extracted logic. First on-device run happens on your phone via
   `npx expo run:android` or an EAS dev build.
6. **Desktop verification** is typecheck + unit tests + a headless launch smoke
   test (xvfb). Windows installer CI is authored but can only be proven on a
   pushed tag.
7. **CI workflows are written but untested** until pushed to GitHub.
