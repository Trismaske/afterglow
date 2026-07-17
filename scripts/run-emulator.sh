#!/usr/bin/env bash
# Boot the Afterglow dev emulator.
#
#   scripts/run-emulator.sh              # windowed (normal dev use)
#   HEADLESS=1 scripts/run-emulator.sh   # no window (CI / remote shells)
#   scripts/run-emulator.sh <avd-name>   # a different AVD
set -euo pipefail
# shellcheck source=android-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/android-env.sh"

AVD_NAME="${1:-afterglow-pixel7}"
ARGS=(-avd "$AVD_NAME" -no-boot-anim -no-audio)
if [ "${HEADLESS:-0}" = "1" ]; then
  ARGS+=(-no-window -gpu swiftshader_indirect)
fi

exec "$ANDROID_HOME/emulator/emulator" "${ARGS[@]}"
