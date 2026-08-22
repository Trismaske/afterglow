#!/bin/bash
# Interactive/agent UI-driving helpers over adb — the hands the m0.8.7
# automated device pass ran on (docs/ANDROID_DEVICE_TESTING.md §6.1).
#
# Source it with the target serial, then call the functions:
#
#   source scripts/adb-ui.sh HARDWARE_SERIAL
#   tap "Continue reviewing"        # tap the first node matching a regex
#   texts | head                    # every visible text/content-desc
#   has "Keep remaining"            # grep the current dump (exit code)
#   shot before-eject               # screenshot to $AG_UI_OUT/before-eject.png
#   sink '\[scan\] done'            # grep the app's on-device diag sink
#   back                           # one BACK keyevent
#
# Rules that keep this honest (learned the hard way; see §6):
# - tap/has re-dump every call — never act on a stale hierarchy.
# - A TAP-MISS prints and returns 1; check it. A missed tap that scripts
#   ignore turns every later assertion into noise.
# - Assert EFFECTS (a dump change, a sink line, a count) after every
#   gesture, never just process survival.
# - The dump only sees the foreground window: an unexpected screen in
#   `texts` output usually means the app was backgrounded or a system
#   dialog is up — screenshot before assuming anything.

AG_UI_SERIAL="${1:?usage: source scripts/adb-ui.sh SERIAL}"
AG_UI_OUT="${AG_UI_OUT:-/tmp/adb-ui}"
AG_UI_PKG="${AG_UI_PKG:-com.afterglow.companion}"
mkdir -p "$AG_UI_OUT"

_aui() { adb -s "$AG_UI_SERIAL" "$@"; }

dump() {
  _aui shell "rm -f /sdcard/ag-ui.xml; uiautomator dump /sdcard/ag-ui.xml >/dev/null 2>&1 || true"
  _aui exec-out cat /sdcard/ag-ui.xml 2>/dev/null
}

# Center coordinates of the first node whose text OR content-desc matches
# the regex; zero-area (detached) nodes are skipped — matching one sends
# taps to (0,0).
_findnode() {
  python3 - "$1" <<'PY'
import re, sys
pat = sys.argv[1]; xml = sys.stdin.read()
for m in re.finditer(r'<node[^>]*>', xml):
    t = m.group(0)
    def attr(n):
        mm = re.search(n + r'="([^"]*)"', t); return mm.group(1) if mm else ''
    if re.search(pat, attr('text')) or re.search(pat, attr('content-desc')):
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', t)
        if b:
            x1, y1, x2, y2 = map(int, b.groups())
            if x2 > x1 and y2 > y1:
                print(f"{(x1+x2)//2} {(y1+y2)//2}"); sys.exit(0)
sys.exit(1)
PY
}

tap() {
  local xy
  xy=$(dump | _findnode "$1") || { echo "TAP-MISS: $1" >&2; return 1; }
  _aui shell input tap $xy
  sleep 1.3
}

texts() { dump | grep -oE '(text|content-desc)="[^"]{1,120}"' | grep -vE '=""' | sort -u; }
has() { dump | grep -qE "(text|content-desc)=\"[^\"]*$1"; }
shot() { _aui exec-out screencap -p > "$AG_UI_OUT/$1.png" && echo "shot: $AG_UI_OUT/$1.png"; }
sink() { _aui shell "grep -hE \"$1\" /sdcard/Android/data/$AG_UI_PKG/files/diag/*.log 2>/dev/null"; }
back() { _aui shell input keyevent KEYCODE_BACK; sleep 0.8; }
