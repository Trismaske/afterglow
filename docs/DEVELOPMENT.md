# Developing Afterglow

Everything a new developer needs to build, test, and run both apps. Linux
(Ubuntu/Mint) is the primary dev platform; Windows/macOS notes at the end.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | `@afterglow/core` — shared pure-TS logic (clustering, mix engine, flags, culling sessions) + its tests |
| `apps/desktop` | Afterglow Desktop — Electron app (vanilla-TS renderer, esbuild) |
| `apps/mobile` | Afterglow Companion — Expo SDK 57 / React Native 0.86 Android app |
| `scripts/` | Dev-environment setup + helpers |
| `docs/` | Plans, assumptions, this file |

npm workspaces tie it together: run `npm install` **once, at the repo root**.
`@afterglow/core` builds to `dist/` automatically on install; after editing
core, rebuild it with `npm run build -w @afterglow/core`.

## Prerequisites

- **Node.js ≥ 22.13.0** and npm ≥ 10 (React Native 0.86's enforced floor)
- git, curl, unzip, tar (all standard on Ubuntu/Mint)
- ~20 GB free disk if you're doing Android work

## First-time setup

```bash
git clone <repo> && cd afterglow
npm install            # installs every workspace + builds @afterglow/core
npm run lint && npm run format:check
npm run typecheck      # sanity check: should be clean
npm test               # core + desktop + mobile unit tests, all green
```

That's all the **desktop** app needs. For **Android**, continue below.

### Android toolchain (one command)

```bash
bash scripts/setup-android-env.sh
```

This installs — entirely under `~/Android`, no sudo, checksum-verified,
idempotent (safe to re-run):

- Temurin **JDK 21** (Gradle 9 needs JDK 17+; system JDK 11 won't work)
- Android SDK command-line tools, platform-tools (adb), **platform 36**,
  **build-tools 36.0.0**, **NDK 27.1.12297006**, cmake 3.22.1 — the exact
  versions Expo SDK 57 / React Native 0.86 pin
- The emulator + an Android 16 (API 36, Google APIs, x86_64) system image
- An AVD named **`afterglow-pixel7`** (Pixel 7, 4 GB RAM, 8 GB storage)

Then activate it (add this line to your `~/.bashrc` to make it permanent):

```bash
source scripts/android-env.sh
```

**KVM:** the emulator needs `/dev/kvm` access to be usable. The setup script
checks and tells you the fix if you lack it (`sudo gpasswd -a $USER kvm`,
then log out/in). On most desktop logins an ACL already grants it.

## Daily commands

### Shared core

```bash
npm test -w @afterglow/core            # vitest
npm run build -w @afterglow/core       # rebuild dist/ after editing core
```

### Desktop (Electron)

```bash
npm start -w afterglow-desktop         # build + launch fullscreen slideshow
npm test  -w afterglow-desktop         # unit tests
npm run dist -w afterglow-desktop      # package installers (electron-builder)

# Headless smoke test (used by CI; safe over SSH):
xvfb-run -a npx electron apps/desktop --smoke --show
```

In-app keys: any input leaves the show (back to settings on a manual
launch, quit under `--show`); exceptions are `O` overlay, `D/E/M/R/N/T`
flag, `←/→/↑/↓` navigate, `Q` queue window, `S` settings.

### Mobile (Android)

> ⚠️ **Run all mobile commands from `apps/mobile`** (or use the root
> `npm run …` aliases below). Running `npx expo …` from the repo root
> will scaffold a junk Expo project into the root — that's the classic
> "why is there an `android/` folder next to `package.json`" mistake.

```bash
# 1. Boot the emulator (leave it running; skip if a USB device is plugged in)
scripts/run-emulator.sh                # HEADLESS=1 for no window

# 2. Build + install + launch (first build ~10 min; later ones are fast)
cd apps/mobile
npx expo run:android

# Day-to-day JS iteration (after the dev build is installed once):
npx expo start                         # Metro; press 'a' to (re)open the app

npm run typecheck -w afterglow-companion
npm test -w afterglow-companion        # heuristics unit tests (vitest)
npx expo prebuild --platform android --clean --no-install
cd android && ./gradlew :app:assembleDebug --console=plain
```

Root-level aliases (work from anywhere in the repo):

```bash
npm run setup:android                  # = bash scripts/setup-android-env.sh
npm run emulator                       # = scripts/run-emulator.sh
npm run mobile:android                 # = expo run:android in apps/mobile
npm run mobile:start                   # = expo start in apps/mobile
```

**Expo Go does not work** for this app — media-library permissions and
SQLite need a dev build, which is exactly what `expo run:android` produces.

**Physical device instead of emulator:** enable USB debugging, plug in,
check `adb devices` shows it, then `npx expo run:android` as usual (it
prefers a connected device over the emulator).

### Useful emulator/adb commands

```bash
adb devices                            # list targets
adb exec-out screencap -p > shot.png   # screenshot
adb emu kill                           # stop the emulator
adb shell pm clear com.afterglow.companion   # wipe app data
```

## Version pins & bumping

`electronVersion` is pinned in `apps/desktop/electron-builder.yml` (electron
is hoisted to the workspace root, so electron-builder can't resolve the
semver range itself) — bump it manually whenever electron is upgraded.

The Android toolchain versions live at the top of
`scripts/setup-android-env.sh` and mirror
`node_modules/react-native/gradle/libs.versions.toml` (compileSdk,
build-tools, NDK). When upgrading Expo/RN, update those constants to match
the new toml, and refresh the JDK pin from
`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse`
(URL + `sha256` fields). Google lists only SHA-1 for cmdline-tools — pin the
SHA-256 by computing it from a download you've verified against their SHA-1.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `expo run:android` fails with SDK/JDK errors | You didn't `source scripts/android-env.sh` in this shell, or setup never ran |
| Gradle: "Unsupported class file major version" / JDK 11 errors | `JAVA_HOME` points at the system JDK — source the env file |
| Emulator boots but is unusably slow | No KVM access: `sudo gpasswd -a $USER kvm`, log out/in |
| `expo` created `android/`/`app.json` at the repo root | You ran it from the root — delete those, restore `package.json` from git, run commands from `apps/mobile` |
| First `expo run:android` is very slow | Normal: Gradle downloads ~2-3 GB of dependencies once |
| Emulator: adb-pushed JPEGs get wrong/inconsistent `datetaken` | Known media-scanner quirk; MediaStore also rejects `datetaken` updates from the adb shell — test timestamp-clustering fidelity on a real phone |
| Windows testers see SmartScreen warning | Expected for unsigned builds: "More info → Run anyway" |
| Desktop HEIC files don't display | Unsupported on desktop for now (documented in README) |

## Windows / macOS

The setup script is Linux-only. Elsewhere, install manually and match the
same pins: Temurin JDK 21, Android Studio (or cmdline-tools) with platform
36 / build-tools 36.0.0 / NDK 27.1.12297006, and create any x86_64/arm64
API 36 AVD. `scripts/android-env.sh` concepts translate directly
(`ANDROID_HOME`, `JAVA_HOME`, PATH). The desktop app builds anywhere Node
and Electron run.
