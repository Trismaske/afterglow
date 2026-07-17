#!/usr/bin/env bash
#
# Afterglow — reproducible Android dev-environment setup (Linux x86_64).
#
# Installs, entirely under $HOME (no sudo needed):
#   * Temurin JDK 21 (pinned, checksum-verified)     → ~/Android/jdk/
#   * Android SDK command-line tools (pinned)        → ~/Android/Sdk/cmdline-tools/latest
#   * platform-tools, platform android-36, build-tools 36.0.0, emulator,
#     NDK 27.1.12297006, cmake 3.22.1 (the versions Expo SDK 57 / RN 0.86 pin)
#   * an x86_64 Android 16 (API 36, Google APIs) system image
#   * an AVD named "afterglow-pixel7"
#
# Idempotent: re-running skips anything already installed.
# After it finishes:   source scripts/android-env.sh
#
# To bump pinned versions: update the constants below; checksums for the JDK
# come from https://api.adoptium.net (assets/latest), the cmdline-tools
# SHA-256 must be recomputed from the download (Google's site lists SHA-1).

set -euo pipefail

# ---------------------------------------------------------------- versions --
JDK_RELEASE="jdk-21.0.11+10"
JDK_URL="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_x64_linux_hotspot_21.0.11_10.tar.gz"
JDK_SHA256="4b2220e232a97997b436ca6ab15cbf70171ecff52958a46159dfa5a8c44ca4de"

CLT_URL="https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip"
CLT_SHA256="04453066b540409d975c676d781da1477479dde3761310f1a7eb92a1dfb15af7"

# Match node_modules/react-native/gradle/libs.versions.toml (RN 0.86):
SDK_PACKAGES=(
  "platform-tools"
  "platforms;android-36"
  "build-tools;36.0.0"
  "emulator"
  "ndk;27.1.12297006"
  "cmake;3.22.1"
  "system-images;android-36;google_apis;x86_64"
)

AVD_NAME="afterglow-pixel7"
AVD_DEVICE="pixel_7"
AVD_IMAGE="system-images;android-36;google_apis;x86_64"

ANDROID_ROOT="$HOME/Android"
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_ROOT/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
JDK_DIR="$ANDROID_ROOT/jdk/$JDK_RELEASE"
DOWNLOADS="$ANDROID_ROOT/downloads"

MIN_FREE_GB=20

log()  { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- preflight ----
[ "$(uname -s)" = "Linux" ] || die "This script supports Linux only (see docs/DEVELOPMENT.md for other OSes)."
[ "$(uname -m)" = "x86_64" ] || die "This script supports x86_64 only."
for tool in curl unzip tar sha256sum; do
  command -v "$tool" >/dev/null || die "Missing '$tool' — install it first (e.g. sudo apt install $tool)."
done

free_gb=$(df --output=avail -BG "$HOME" | tail -1 | tr -dc '0-9')
[ "$free_gb" -ge "$MIN_FREE_GB" ] || die "Need at least ${MIN_FREE_GB}GB free in \$HOME (have ${free_gb}GB)."

if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  log "KVM: /dev/kvm is accessible — emulator will be hardware-accelerated."
else
  warn "KVM is NOT accessible. The emulator will be unusably slow without it."
  warn "Fix (needs sudo, then log out and back in):"
  warn "    sudo gpasswd -a \"$USER\" kvm"
  warn "If /dev/kvm does not exist at all, enable VT-x/AMD-V in your BIOS."
fi

mkdir -p "$ANDROID_ROOT" "$DOWNLOADS" "$ANDROID_ROOT/jdk"

# fetch <url> <sha256> <dest-file>
fetch() {
  local url="$1" sha="$2" dest="$3"
  if [ -f "$dest" ] && echo "$sha  $dest" | sha256sum -c --quiet 2>/dev/null; then
    log "Already downloaded: $(basename "$dest")"
    return 0
  fi
  log "Downloading $(basename "$dest") ..."
  local progress="-sS"
  [ -t 1 ] && progress="--progress-bar"
  curl -fSL $progress -o "$dest.part" "$url"
  echo "$sha  $dest.part" | sha256sum -c --quiet || die "Checksum mismatch for $url"
  mv "$dest.part" "$dest"
}

# ------------------------------------------------------------------- JDK ----
if [ -x "$JDK_DIR/bin/java" ]; then
  log "JDK already installed: $JDK_DIR"
else
  fetch "$JDK_URL" "$JDK_SHA256" "$DOWNLOADS/temurin-$JDK_RELEASE.tar.gz"
  log "Installing Temurin $JDK_RELEASE ..."
  tmp=$(mktemp -d "$ANDROID_ROOT/jdk/.extract.XXXXXX")
  tar -xzf "$DOWNLOADS/temurin-$JDK_RELEASE.tar.gz" -C "$tmp"
  mv "$tmp"/jdk-* "$JDK_DIR"
  rmdir "$tmp"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"

# -------------------------------------------------------- cmdline-tools -----
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
if [ -x "$SDKMANAGER" ]; then
  log "cmdline-tools already installed."
else
  fetch "$CLT_URL" "$CLT_SHA256" "$DOWNLOADS/cmdline-tools.zip"
  log "Installing Android command-line tools ..."
  tmp=$(mktemp -d "$ANDROID_ROOT/.extract.XXXXXX")
  unzip -q "$DOWNLOADS/cmdline-tools.zip" -d "$tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

# ------------------------------------------------------------ SDK pieces ----
log "Accepting SDK licenses ..."
# `yes` exits via SIGPIPE when sdkmanager closes stdin, so judge the pipeline
# by sdkmanager's status alone (pipefail would report yes's SIGPIPE).
set +o pipefail
yes | "$SDKMANAGER" --licenses >/dev/null
lic_status=${PIPESTATUS[1]}
set -o pipefail
[ "$lic_status" -eq 0 ] || die "License acceptance failed."

log "Installing SDK packages (skips anything present):"
printf '        %s\n' "${SDK_PACKAGES[@]}"
"$SDKMANAGER" --install "${SDK_PACKAGES[@]}" || die "sdkmanager install failed."

# ------------------------------------------------------------------- AVD ----
if "$AVDMANAGER" list avd -c 2>/dev/null | grep -qx "$AVD_NAME"; then
  log "AVD '$AVD_NAME' already exists."
else
  log "Creating AVD '$AVD_NAME' ($AVD_DEVICE, $AVD_IMAGE) ..."
  echo no | "$AVDMANAGER" create avd \
    --name "$AVD_NAME" \
    --package "$AVD_IMAGE" \
    --device "$AVD_DEVICE" \
    --sdcard 2048M >/dev/null
  avd_config="$HOME/.config/.android/avd/$AVD_NAME.avd/config.ini"
  [ -f "$avd_config" ] || avd_config="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  if [ -f "$avd_config" ]; then
    # More RAM + storage than the stingy defaults; keeps Gradle installs happy.
    sed -i 's/^hw.ramSize.*/hw.ramSize=4096/' "$avd_config" || true
    grep -q '^disk.dataPartition.size' "$avd_config" \
      && sed -i 's/^disk.dataPartition.size.*/disk.dataPartition.size=8192M/' "$avd_config" \
      || echo 'disk.dataPartition.size=8192M' >> "$avd_config"
  fi
fi

# ----------------------------------------------------------------- doctor ---
log "Verifying installation:"
log "  java:      $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
log "  sdkmanager: $("$SDKMANAGER" --version 2>/dev/null | head -1)"
log "  adb:       $("$ANDROID_HOME/platform-tools/adb" --version | head -1)"
log "  emulator:  $("$ANDROID_HOME/emulator/emulator" -version 2>/dev/null | head -1)"
log "  AVDs:      $("$AVDMANAGER" list avd -c | tr '\n' ' ')"
log ""
log "Done. Activate the environment in every shell you build from:"
log "    source scripts/android-env.sh"
log "(or add that line to your ~/.bashrc). Then, from apps/mobile:"
log "    npx expo run:android    # builds, installs and launches on the emulator/device"
