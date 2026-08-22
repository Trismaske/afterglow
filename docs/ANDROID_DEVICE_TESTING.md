# Android device testing over wireless ADB

This guide recreates a clean workstation setup to build, install, and automate Afterglow on one or more physical Android phones.
The pairing steps are standard Android wireless debugging.
The repository helper avoids saving IP addresses and ports, which change whenever wireless debugging reconnects.

ADB access is powerful: it can install applications, read logs, capture the screen, and operate the visible UI.
Prefer a dedicated test phone without personal accounts or data.
Do not share a screen-lock PIN with an agent.
Remove the workstation under **Wireless debugging → Paired devices** when it should no longer have access.

## 1. Prepare a clean workstation

Clone the repository and install its Android toolchain on Linux x86-64:

```bash
git clone <repository-url> afterglow
cd afterglow
bash scripts/setup-android-env.sh
source scripts/android-env.sh
adb version
```

The setup is local to `~/Android` and needs no root access.
It also installs the `afterglow-pixel7` Android 16 emulator.
To make the environment available in new Bash shells, add an absolute path to your shell startup file:

```bash
printf '\nsource /absolute/path/to/afterglow/scripts/android-env.sh\n' >> ~/.bashrc
```

On macOS or Windows, install Google's current Android SDK Platform Tools and put `adb` on `PATH`.
The phone-side and raw `adb` commands below are otherwise the same.
`scripts/android-device.sh` requires Bash (macOS, WSL, or Git Bash).

For optional live screen mirroring and mouse/keyboard control, install `scrcpy` from its official project.
It is not required for headless automation, because ADB already provides screenshots, UI inspection, input, installation, and logs.
Avoid obsolete third-party or distro builds.
Use the official [scrcpy Linux instructions](https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md) or the corresponding official instructions for your OS.

## 2. Prepare each phone

1. Open **Settings → About phone → Software information**.
2. Tap **Build number** seven times and authenticate.
   This enables Developer options.
3. Open **Settings → Developer options**.
4. Enable **USB debugging** and **Wireless debugging**.
5. Connect the phone and the workstation to the same trusted Wi-Fi network.
6. Keep the phone unlocked during setup and testing.

Menu wording varies slightly by Android vendor.
Android 11 or newer supports the TLS pairing-code flow described here.
Repeat the next section separately for every phone.

## 3. Pair a phone

On the phone, open **Wireless debugging → Pair device with pairing code**.
Leave that dialog open.
It displays:

- an IP address and a temporary **pairing port**
- a temporary six-digit pairing code

On the workstation, run:

```bash
scripts/android-device.sh pair PHONE_IP:PAIRING_PORT
```

Enter the six-digit code at the prompt.
The prompt keeps the code out of the command line, so shell history does not store it.

Pairing and connecting use different ports.
Android normally advertises the connection service over mDNS, and ADB connects automatically.
Check:

```bash
scripts/android-device.sh list
```

If the paired phone is not listed, inspect the advertised services:

```bash
scripts/android-device.sh discover
```

Find the phone's `_adb-tls-connect._tcp` entry, not `_adb-tls-pairing._tcp`, and connect with that entry's IP and port:

```bash
scripts/android-device.sh connect PHONE_IP:CONNECTION_PORT
scripts/android-device.sh list
```

The list reports a stable hardware serial and model for each physical phone, and hides duplicate mDNS/IP transports for the same phone.
Use the hardware serial as the selector when two connected devices have the same model.

The phone remembers the pairing, but wireless debugging can turn off after a reboot, a network change, or inactivity.
Connection ports are deliberately dynamic.
Never save one in a script.
After you reinstall the workstation, you must pair its new ADB key again.
You can remove the old entry from the phone's **Paired devices** list.

### When the port has rotated and mDNS cannot find it

`discover` asks ADB for mDNS services, and mDNS is link-local, so it finds nothing across a VPN or tailnet.
This holds even when the phone sits on the same `/24` as the workstation.
With a VPN client capturing the phone's interface (Tailscale on both test phones), the phone does not advertise `_adb-tls-connect._tcp` on the LAN at all, which is what `avahi-browse` reports here.
So a move of the phones onto LAN addresses does not fix discovery.
The VPN does not care which address you dial.

If you turn the VPN off on the phone, mDNS returns on the local network.
This is the fallback to remember if the tailnet is ever unavailable.
It is not needed for the two commands below, which work with the VPN on.

Two commands work wherever the phone is reachable:

```bash
scripts/android-device.sh find 100.104.71.0    # probe for the current port
scripts/android-device.sh pin SM-S918B         # then fix it at 5555
```

`find` probes the ports directly and connects to the one that answers.
A phone in wireless-debugging mode listens on two ports, and only the connection service accepts a connect.
`pin` then moves the phone to the fixed port 5555, so the address stops moving until the phone reboots.

Understand `pin` before you use it.
Port 5555 is the classic ADB daemon, authorised by this workstation's ADB key but outside the TLS pairing.
Keep it to a private network and a dedicated test phone, the same standard the top of this guide sets.
After a reboot, re-enable wireless debugging and re-run `find`.

## 4. Address the intended device

Always specify a device when more than one phone or emulator is online.
The helper accepts a hardware serial, a model, an Android device codename, or a current ADB transport:

```bash
scripts/android-device.sh adb SM-S918B shell getprop ro.product.model
scripts/android-device.sh adb R5CW20KBA2W shell getprop ro.build.version.release
scripts/android-device.sh scrcpy SM-S918B
```

Do not copy the example identifiers above.
Run `scripts/android-device.sh list` to get your own.
For raw ADB, use the transport shown in the last column:

```bash
adb -s CURRENT_TRANSPORT shell getprop ro.product.model
```

## 5. Build and install Afterglow

Build from the mobile workspace:

```bash
cd apps/mobile
npx expo prebuild --platform android --clean --no-install
cd android
./gradlew :app:assembleDebug --console=plain
cd ../../..
```

Install on one explicitly selected phone:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL install -r \
  apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Before you install, check whether the package is already present:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell \
  pm list packages --user 0 com.afterglow.companion
```

Afterglow debug and release builds currently share both the package ID `com.afterglow.companion` and the repository's shared debug signing key.
Consequently, `install -r` updates or reinstalls the existing app in place and retains its app data.
It does **not** create a side-by-side debug application.
If the installed APK has a different signing key, Android rejects the update instead of installing a second copy.

Launch or stop the application:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell monkey \
  -p com.afterglow.companion -c android.intent.category.LAUNCHER 1
scripts/android-device.sh adb HARDWARE_SERIAL shell am force-stop \
  com.afterglow.companion
```

Only clear application data when a clean-state test explicitly requires it:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell pm clear \
  com.afterglow.companion
```

That last command permanently removes Afterglow's local database and settings from the selected Android user.

## 6. Agent-friendly automation

Capture a screenshot without opening a desktop window:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL exec-out screencap -p > screen.png
```

Record up to three minutes of interaction:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell screenrecord \
  /data/local/tmp/afterglow-test.mp4
scripts/android-device.sh adb HARDWARE_SERIAL pull \
  /data/local/tmp/afterglow-test.mp4 .
```

Inspect the accessibility/UI hierarchy:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell uiautomator dump \
  /data/local/tmp/window.xml
scripts/android-device.sh adb HARDWARE_SERIAL pull \
  /data/local/tmp/window.xml .
```

Simulate common actions:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell input keyevent KEYCODE_WAKEUP
scripts/android-device.sh adb HARDWARE_SERIAL shell input tap X Y
scripts/android-device.sh adb HARDWARE_SERIAL shell input swipe X1 Y1 X2 Y2 300
scripts/android-device.sh adb HARDWARE_SERIAL shell input text 'sample%stext'
scripts/android-device.sh adb HARDWARE_SERIAL shell input keyevent KEYCODE_BACK
```

Synthetic gestures fail silently.
An `input swipe` that does nothing looks identical to "no crash / no movement" and corrupts the test's conclusion.
Two rules keep scripted gesture work honest:

- **Assert the gesture's effect** (pager indicator, breadcrumb log), never only that the process survived.
  The UI gate's swipe step does this.
- **Do not blame the device until you rule out the app.**
  "Synthetic swipes don't work on the S23" circulated as fact for two releases.
  It was an app bug that froze the pager on any touch, and after the fix the full UI gate passed on both test phones.
  A device-specific claim about input is only real after the same script passes on another device against the same build.

Double taps: issue both taps in ONE `adb shell` invocation (`shell "input tap X Y; input tap X Y"`).
Two separate adb calls add process round-trips that overshoot the ~300 ms double-tap window.
For crash repros:

1. Clear the crash buffer first (`logcat -c -b crash`).
2. Assert that the app's PID is unchanged after every gesture (`pidof`).
3. Count signature lines at the end (`logcat -d -b crash | grep -c <marker>`).

A PID check per step turns "it crashed eventually" into "it crashed on exactly the Nth gesture".

Capture logs for Afterglow debugging:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL logcat -c
scripts/android-device.sh adb HARDWARE_SERIAL logcat
```

For a dedicated phone kept on a charger, you can keep the display awake:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell svc power stayon true
```

Restore normal sleep behavior afterward:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell svc power stayon false
```

ADB cannot legitimately bypass a secure lock screen.
Unlock the phone yourself before a run.
Screenshots and UI dumps can contain personal information.
Store them only for as long as the test requires, and do not commit them.
Secure surfaces may be absent from screenshots.
Observe and approve system permission, MediaStore write/trash, biometric, and similar confirmation dialogs as part of acceptance testing.
Do not bypass them with pre-granted permissions.

**`adb shell content` writes bypass the media provider's validation.**
A row inserted or updated from the shell lands directly, where the provider would refuse the same write from an app.
A shell probe therefore proves nothing about what apps may do (measured in m0.8.4: shell updates landed rows in folders the provider refuses to apps).
Measure provider rules from the app itself.

### 6.1 The tap-by-text harness

`scripts/adb-ui.sh` packages the working loop the m0.8.7 automated device pass ran on: dump the hierarchy, find a node by text/content-desc regex, tap its center, assert the effect.

```bash
source scripts/adb-ui.sh HARDWARE_SERIAL
tap "Continue reviewing" && has "Keep remaining" && shot deck-open
sink '\[scan\] delta done' | tail -1
```

What its rules encode (each one cost a wrong conclusion before it existed):

- Every `tap`/`has` re-dumps; a stale hierarchy tapped confidently drives the wrong screen.
- A `TAP-MISS` returns 1 and must be checked — an ignored miss silently invalidates every later assertion.
- Zero-area nodes are skipped: detached (inactive-tab) screens leave ghost nodes whose "center" is (0,0).
- When `texts` shows an unexpected screen, the app was probably backgrounded (a stray BACK exits through Home) or a system dialog is up — screenshot before assuming.
- A swipe from y≈700 upward at the screen top opens the notification shade, not the list — scroll with start points well inside the content.

### 6.2 The diagnostics sink is the assertion surface

Every console line the app emits persists on-device (m0.8.7, `lib/diagLog.ts`), so scripted passes assert **behavior** by grepping the sink instead of screenshots:

```bash
adb -s SERIAL shell "grep -hE '\[scan\] (done|delta)' \
  /sdcard/Android/data/com.afterglow.companion/files/diag/*.log" | tail
```

The `[scan]` lines carry the whole scan contract (delta vs full, reasons, tripwires, targeted rescans) and the `[perf]` lines the timings; a claim like "no corpus walk happened" or "the un-eject landed" is one grep, timestamped.
Wait for a pass by polling the sink for its `done` line — never by sleeping a guessed duration.

### 6.3 Generating test media

Real pass items need photos with controlled properties; ImageMagick + exiftool make them on the host:

```bash
# A distinctive scene, then near-identical variants that will GROUP
# (same window: EXIF stamps seconds apart; similarity: tiny crop/brightness deltas)
convert -size 1400x1050 plasma:red-blue -seed 42 base.png
for i in 1 2 3 4 5; do
  convert base.png -brightness-contrast $((i-3))x0 -crop 1360x1020+$((i*4))+$((i*2)) +repage -quality 92 burst_$i.jpg
  exiftool -overwrite_original "-DateTimeOriginal=2026:08:22 01:35:0$i" burst_$i.jpg
done

# An honestly UNDATED photo (exercises the delta's direct-fetch leg)
convert -size 1200x900 plasma:fractal -strip noexif.jpg && exiftool -all= -overwrite_original noexif.jpg
```

Push into place, then make MediaStore ingest (per-file scan broadcasts are unreliable on modern Android; scan the volume):

```bash
adb -s SERIAL push burst_1.jpg /sdcard/DCIM/Camera/AG_BURST_1.jpg
adb -s SERIAL shell "content call --uri content://media/none/ --method scan_volume --arg external_primary"
```

Landing a file under another app's storage (`/sdcard/Android/media/com.whatsapp/...`) makes an **out-of-source** change for scan tests; a REAL row owned by that app (check `owner_package_name`) is what forces the organize boundary's ownership refusal — a shell-pushed file may scan with no owner and behave differently.
Prefix generated files (`AG_...`) so cleanup is a name match.

### 6.4 Volume (SD card) control

A physically present card can be mounted and unmounted in software — reach-axis tests without touching the phone:

```bash
adb -s SERIAL shell sm list-volumes           # public:179,1 unmounted 0A91-E18D
adb -s SERIAL shell sm mount public:179,1     # → SD rows in the picker, SD badges, volumesChanged
adb -s SERIAL shell sm unmount public:179,1
```

Mounting mid-scan is itself a test: the pass must abort on the mount fence ("storage volumes changed mid-scan") and the next open rescan cleanly.

### 6.5 Fresh-state setup and OS dialogs

A scripted pass on a fresh install must grant the media permission itself, or every step fails against the permission screen (the gate's 0-buckets failure shape):

```bash
adb -s SERIAL shell pm clear com.afterglow.companion
adb -s SERIAL shell pm grant com.afterglow.companion android.permission.READ_EXTERNAL_STORAGE  # API ≤32
adb -s SERIAL shell pm grant com.afterglow.companion android.permission.READ_MEDIA_IMAGES      # API 33+
adb -s SERIAL shell monkey -p com.afterglow.companion -c android.intent.category.LAUNCHER 1
```

Grant only the READ permission this way.
The per-operation consents (trash, write, favourite batches) must never be pre-granted — **drive** them: they are plain dialogs the harness taps like any node (`tap "^Allow$"`), and walking them is part of what the pass proves.
The share sheet is drivable the same way; a direct-share target ("My Drive") uploads with no further dialog, and the receiving app's own notification ("Uploaded 2 items") is the physical-delivery proof — read it from a `texts` dump of the opened shade.

### 6.6 Pixel assertions

Layout claims ("selecting a row must not shift its neighbours") are verifiable by screenshot diff, not eyeballs:

```bash
shot before && tap "WhatsApp Images" && shot after
python3 - <<'PY'
from PIL import Image, ImageChops
a = Image.open('/tmp/adb-ui/before.png').convert('L'); b = Image.open('/tmp/adb-ui/after.png').convert('L')
px = ImageChops.difference(a, b).load(); w, h = a.size
bands, start = [], None
for y in range(h):
    hot = sum(px[x, y] for x in range(0, w, 8)) > 300
    if hot and start is None: start = y
    elif not hot and start is not None: bands.append((start, y)); start = None
print(bands)   # expect: the status-bar clock + the tapped row's own band, nothing else
PY
```

## 7. Emulator pass

The repository setup creates an accelerated Android 16 emulator:

```bash
scripts/run-emulator.sh
adb devices -l
```

When both phones and the emulator are connected, use the emulator transport explicitly:

```bash
adb -s emulator-5554 install -r \
  apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 exec-out screencap -p > emulator.png
```

Stop it with:

```bash
adb -s emulator-5554 emu kill
```

## 8. Troubleshooting

**Phone is paired but absent from the list**

- Unlock the phone and confirm that **Wireless debugging** is still enabled.
- Confirm that both machines are on the same Wi-Fi and that the access point does not isolate wireless clients.
- Run `scripts/android-device.sh discover`, then explicitly connect to the `_adb-tls-connect._tcp` port.
- Restart ADB with `adb kill-server && adb start-server`.
- If discovery remains broken, forget the workstation on the phone and pair again.

**Device is `offline`, duplicated, or commands choose the wrong target**

- Run `adb reconnect offline`, then `scripts/android-device.sh list`.
- Duplicate mDNS and IP transports can refer to one physical phone.
  The helper deduplicates them by hardware serial.
- Always use the helper with a hardware-serial selector in multi-device tests.

**Pairing succeeds but explicit connection is refused**

- The pairing port was probably reused as the connection port.
  The two ports differ.
  Read the `_adb-tls-connect._tcp` service from `discover`.
- Reopen the Wireless debugging screen.
  Android can rotate its connection port.

**No mDNS services appear**

- Make sure that UDP multicast/mDNS (port 5353) is allowed on the local network and the workstation firewall.
- Guest Wi-Fi and enterprise networks commonly block peer-to-peer traffic.
- A USB cable remains a useful fallback for setup and diagnosis.

**Automation stops at the lock screen or a system dialog**

- Unlock the phone manually.
  Do not put a PIN in scripts or chat.
- Some security-sensitive dialogs intentionally require a real confirmation.
  This is expected.
  Record it in acceptance results.
