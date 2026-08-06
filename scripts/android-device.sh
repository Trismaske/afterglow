#!/usr/bin/env bash
#
# Resolve and control physical Android test devices without hard-coding their
# changing wireless-debugging ports. A selector may be an adb transport
# address, Android model, or hardware serial reported by ro.serialno.
#
# Examples:
#   scripts/android-device.sh list
#   scripts/android-device.sh pair 192.168.1.20:37123
#   scripts/android-device.sh adb SM-S918B shell getprop ro.build.version.release
#   scripts/android-device.sh adb R5CW20KBA2W install -r app-debug.apk
#   scripts/android-device.sh scrcpy SM-S918B

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/android-device.sh list
  scripts/android-device.sh discover
  scripts/android-device.sh find IP [FIRST_PORT LAST_PORT]
  scripts/android-device.sh pair IP:PAIRING_PORT
  scripts/android-device.sh connect IP:CONNECTION_PORT
  scripts/android-device.sh pin SELECTOR
  scripts/android-device.sh adb SELECTOR ADB_ARGUMENT...
  scripts/android-device.sh scrcpy SELECTOR [SCRCPY_ARGUMENT...]

SELECTOR may be the current adb transport, model, or hardware serial shown by
"list". Model matching is case-insensitive and treats "-" and "_" alike.
Use the hardware serial when two connected devices have the same model.

"discover" only works on the phone's own network segment: it asks adb for mDNS
services, and mDNS is link-local, so it finds nothing across a VPN/tailnet — and
nothing on a Wi-Fi network that blocks multicast, which is the common case.
"find" answers the same question by probing ports directly, so it works wherever
the phone is reachable at all.

"pin" moves an already-connected phone onto the fixed port 5555, so its address
stops changing every time wireless debugging restarts. It lasts until the phone
reboots. Note the trade: port 5555 is the classic adb daemon, authorised by this
workstation's adb key but not by the TLS pairing — use it on a private network
(a tailnet, or a trusted LAN) and on a dedicated test phone.
EOF
}

die() {
  printf 'android-device: %s\n' "$*" >&2
  exit 1
}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ -f "$repo_root/scripts/android-env.sh" ]; then
  set +e
  set +u
  # shellcheck source=/dev/null
  source "$repo_root/scripts/android-env.sh"
  set -e
  set -u
fi

adb_path=$(command -v adb || true)
[ -n "$adb_path" ] || die "adb is not installed or on PATH; see docs/ANDROID_DEVICE_TESTING.md"

normalize() {
  printf '%s' "$1" | tr '[:upper:]_' '[:lower:]-'
}

connected_transports() {
  "$adb_path" devices -l |
    awk 'NR > 1 && $2 == "device" { print $1 }'
}

device_property() {
  local transport=$1 property=$2
  "$adb_path" -s "$transport" shell getprop "$property" 2>/dev/null | tr -d '\r'
}

resolve_transport() {
  local selector=$1
  local wanted
  wanted=$(normalize "$selector")

  local transport hardware model product candidate_key
  local -a matches=()
  declare -A seen_devices=()

  while IFS= read -r transport; do
    [ -n "$transport" ] || continue

    # An exact adb transport selector needs no property probes.
    if [ "$transport" = "$selector" ]; then
      printf '%s\n' "$transport"
      return 0
    fi

    hardware=$(device_property "$transport" ro.serialno)
    model=$(device_property "$transport" ro.product.model)
    product=$(device_property "$transport" ro.product.device)
    candidate_key=${hardware:-$transport}

    # mDNS and an explicit adb connect may expose the same phone twice.
    [ -z "${seen_devices[$candidate_key]+x}" ] || continue
    seen_devices[$candidate_key]=1

    if [ "$(normalize "$hardware")" = "$wanted" ] ||
       [ "$(normalize "$model")" = "$wanted" ] ||
       [ "$(normalize "$product")" = "$wanted" ]; then
      matches+=("$transport|$hardware|$model")
    fi
  done < <(connected_transports)

  if [ "${#matches[@]}" -eq 1 ]; then
    printf '%s\n' "${matches[0]%%|*}"
    return 0
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    printf 'Selector "%s" matches more than one physical device:\n' "$selector" >&2
    local match rest
    for match in "${matches[@]}"; do
      rest=${match#*|}
      printf '  serial=%s model=%s\n' "${rest%%|*}" "${rest#*|}" >&2
    done
    die "use a hardware serial from the list output"
  fi

  die "no connected device matches \"$selector\"; run '$0 list' and '$0 discover'"
}

list_devices() {
  local transport hardware model android sdk candidate_key
  declare -A seen_devices=()

  printf 'SERIAL\tMODEL\tANDROID\tSDK\tTRANSPORT\n'
  while IFS= read -r transport; do
    [ -n "$transport" ] || continue
    hardware=$(device_property "$transport" ro.serialno)
    candidate_key=${hardware:-$transport}
    [ -z "${seen_devices[$candidate_key]+x}" ] || continue
    seen_devices[$candidate_key]=1

    model=$(device_property "$transport" ro.product.model)
    android=$(device_property "$transport" ro.build.version.release)
    sdk=$(device_property "$transport" ro.build.version.sdk)
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "${hardware:--}" "${model:--}" "${android:--}" "${sdk:--}" "$transport"
  done < <(connected_transports)
}

command_name=${1:-}
case "$command_name" in
  list)
    [ "$#" -eq 1 ] || die "list takes no arguments"
    list_devices
    ;;
  discover)
    [ "$#" -eq 1 ] || die "discover takes no arguments"
    "$adb_path" mdns services
    ;;
  find)
    [ "$#" -ge 2 ] && [ "$#" -le 4 ] || die "find requires IP [FIRST_PORT LAST_PORT]"
    find_ip=$2
    # Every wireless-debugging port observed on the two test phones has
    # fallen inside this window (34895, 36349, 37519, 43105, 45851, 46019,
    # 46477 — pairing and connection alike), which keeps a scan short
    # enough to be usable. Widen it with the optional arguments if a phone
    # ever lands outside.
    first_port=${3:-30000}
    last_port=${4:-50000}
    printf 'Probing %s ports %s-%s …\n' "$find_ip" "$first_port" "$last_port" >&2
    # Parallelism is deliberately modest: these probes may cross a relayed
    # VPN link, where a few hundred simultaneous connections are dropped
    # rather than refused and the scan reports a false "nothing here".
    # `|| true`: xargs exits 123 when ANY probe fails, which is every closed
    # port — under `set -e` that kills the scan instead of reporting it.
    open_ports=$(
      {
        seq "$first_port" "$last_port" |
          xargs -P 60 -I{} bash -c "timeout 3 bash -c 'echo > /dev/tcp/$find_ip/{}' 2>/dev/null && echo {}" ||
          true
      } | sort -n
    )
    [ -n "$open_ports" ] ||
      die "no open port on $find_ip — is wireless debugging still enabled on the phone?"
    # A phone in wireless-debugging mode listens on TWO ports: the pairing
    # service and the connection service. Only the latter accepts a
    # connect, so report what actually connected rather than a guess.
    for port in $open_ports; do
      # "connected to …" is NOT proof: adb prints it for a TCP connection
      # whose ADB handshake then fails, leaving the device parked in
      # "offline" — which is what a pairing-service port, or a phone that
      # has forgotten this workstation, actually looks like. Wait for the
      # transport to reach the "device" state before believing it.
      "$adb_path" connect "$find_ip:$port" >/dev/null 2>&1 || true
      for _ in 1 2 3 4 5 6; do
        if "$adb_path" devices | awk -v t="$find_ip:$port" '$1 == t && $2 == "device" { found = 1 } END { exit !found }'; then
          printf 'connected: %s:%s\n' "$find_ip" "$port"
          exit 0
        fi
        sleep 1
      done
      "$adb_path" disconnect "$find_ip:$port" >/dev/null 2>&1 || true
    done
    printf 'open but not accepting a connection (pairing service?): %s\n' "$open_ports" >&2
    die "found no connection port on $find_ip; pair the phone first"
    ;;
  pin)
    [ "$#" -eq 2 ] || die "pin requires SELECTOR"
    transport=$(resolve_transport "$2")
    pin_ip=${transport%%:*}
    [ "$pin_ip" != "$transport" ] ||
      die "pin needs a network device (SELECTOR resolved to the USB/emulator transport $transport)"
    "$adb_path" -s "$transport" tcpip 5555
    sleep 4
    "$adb_path" connect "$pin_ip:5555"
    ;;
  pair)
    [ "$#" -eq 2 ] || die "pair requires IP:PAIRING_PORT"
    printf 'Enter the temporary six-digit code shown on the phone when prompted.\n'
    "$adb_path" pair "$2"
    ;;
  connect)
    [ "$#" -eq 2 ] || die "connect requires IP:CONNECTION_PORT"
    "$adb_path" connect "$2"
    ;;
  adb)
    [ "$#" -ge 3 ] || die "adb requires SELECTOR and at least one adb argument"
    transport=$(resolve_transport "$2")
    shift 2
    exec "$adb_path" -s "$transport" "$@"
    ;;
  scrcpy)
    [ "$#" -ge 2 ] || die "scrcpy requires SELECTOR"
    scrcpy_path=$(command -v scrcpy || true)
    [ -n "$scrcpy_path" ] ||
      die "scrcpy is optional and not installed; see docs/ANDROID_DEVICE_TESTING.md"
    transport=$(resolve_transport "$2")
    shift 2
    exec "$scrcpy_path" --serial "$transport" "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
