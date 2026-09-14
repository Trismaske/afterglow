#!/bin/bash
# Sustained device sampling for the m0.9 phase-6 animated-thumbnail
# spike (docs/ANDROID_DEVICE_TESTING.md §6): once per second for
# SECONDS, one CSV row of the app's CPU share (top, one core = 100), its
# TOTAL PSS (dumpsys meminfo, MB), the AP skin temperature (dumpsys
# thermalservice) and the battery temperature (dumpsys battery, °C);
# gfxinfo (frames rendered, janky %) is reset at the start and printed
# at the end. Run it while the probe screen is RUNNING an arm.
#
#   scripts/device-sample.sh SERIAL SECONDS out.csv
set -u -o pipefail
serial="${1:?serial}"; seconds="${2:?seconds}"; out="${3:?out.csv}"
pkg=com.afterglow.companion
adb -s "$serial" shell dumpsys gfxinfo "$pkg" reset >/dev/null || { echo "device-sample: gfxinfo reset failed on $serial" >&2; exit 2; }
pid=$(adb -s "$serial" shell pidof "$pkg" | tr -d '\r')
if [ -z "$pid" ]; then echo "device-sample: $pkg is not running on $serial" >&2; exit 2; fi
misses=0
echo "t,cpu,pss_mb,ap_c,batt_c" > "$out" || { echo "device-sample: cannot write $out" >&2; exit 2; }
# Wall-clock paced: the four dumps take a second or two on their own,
# so `t` is the elapsed second of each sample, not a counter.
start=$(date +%s)
while :; do
  t=$(( $(date +%s) - start ))
  [ "$t" -ge "$seconds" ] && break
  cpu=$(adb -s "$serial" shell top -b -n 1 -p "$pid" 2>/dev/null | awk -v p="$pid" '$1 == p { print $9 }' | head -1)
  pss=$(adb -s "$serial" shell dumpsys meminfo "$pkg" 2>/dev/null | awk '/TOTAL PSS:/ { printf "%.1f", $3 / 1024; exit }')
  ap=$(adb -s "$serial" shell dumpsys thermalservice 2>/dev/null | grep -m1 'mName=AP' | sed -E 's/.*mValue=([0-9.]+).*/\1/')
  batt=$(adb -s "$serial" shell dumpsys battery 2>/dev/null | awk '/temperature:/ { printf "%.1f", $2 / 10; exit }')
  echo "$t,${cpu:-},${pss:-},${ap:-},${batt:-}" >> "$out" || { echo "device-sample: cannot append to $out" >&2; exit 2; }
  # A lost device or a restarted app must not pass as a complete run:
  # three samples without CPU or PSS abort the run with a nonzero exit.
  if [ -z "$cpu" ] || [ -z "$pss" ]; then misses=$((misses + 1)); else misses=0; fi
  if [ "$misses" -ge 3 ]; then echo "device-sample: lost $pkg on $serial at ${t}s — partial run" >&2; exit 2; fi
done
# The run ends against the same live process, with its frame statistics.
if [ "$(adb -s "$serial" shell pidof "$pkg" | tr -d '\r')" != "$pid" ]; then echo "device-sample: $pkg is not the process sampled ($pid) on $serial at the end — partial run" >&2; exit 2; fi
gfx=$(adb -s "$serial" shell dumpsys gfxinfo "$pkg" | grep -E "Total frames rendered|Janky frames" | head -2)
if [ "$(printf '%s\n' "$gfx" | grep -c .)" -ne 2 ]; then echo "device-sample: no frame statistics from $serial" >&2; exit 2; fi
printf '%s\n' "$gfx"
