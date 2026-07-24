# Android device testing over wireless ADB

This guide recreates a clean workstation setup for building, installing, and
automating Afterglow on one or more physical Android phones. The pairing steps
are standard Android wireless debugging; the repository helper avoids saving
IP addresses and ports, which change whenever wireless debugging reconnects.

ADB access is powerful: it can install applications, read logs, capture the
screen, and operate the visible UI. Prefer a dedicated test phone without
personal accounts or data. Do not share a screen-lock PIN with an agent. Remove
the workstation under **Wireless debugging → Paired devices** when it should no
longer have access.

## 1. Prepare a clean workstation

Clone the repository and install its Android toolchain on Linux x86-64:

```bash
git clone <repository-url> afterglow
cd afterglow
bash scripts/setup-android-env.sh
source scripts/android-env.sh
adb version
```

The setup is local to `~/Android` and needs no root access. It also installs the
`afterglow-pixel7` Android 16 emulator. To make the environment available in
new Bash shells, add an absolute path to your shell startup file:

```bash
printf '\nsource /absolute/path/to/afterglow/scripts/android-env.sh\n' >> ~/.bashrc
```

On macOS or Windows, install Google's current Android SDK Platform Tools and
put `adb` on `PATH`; the phone-side and raw `adb` commands below are otherwise
the same. `scripts/android-device.sh` requires Bash (macOS, WSL, or Git Bash).

For optional live screen mirroring and mouse/keyboard control, install `scrcpy`
from its official project. It is not required for headless automation because
ADB already provides screenshots, UI inspection, input, installation, and
logs. Avoid obsolete third-party or distro builds; use the official
[scrcpy Linux instructions](https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md)
or the corresponding official instructions for your OS.

## 2. Prepare each phone

1. Open **Settings → About phone → Software information**.
2. Tap **Build number** seven times and authenticate to enable Developer
   options.
3. Open **Settings → Developer options**.
4. Enable **USB debugging** and **Wireless debugging**.
5. Connect the phone and workstation to the same trusted Wi-Fi network.
6. Keep the phone unlocked during setup and testing.

Menu wording varies slightly by Android vendor. Android 11 or newer supports
the TLS pairing-code flow described here. Repeat the next section separately
for every phone.

## 3. Pair a phone

On the phone, open **Wireless debugging → Pair device with pairing code**.
Leave that dialog open. It displays:

- an IP address and temporary **pairing port**;
- a temporary six-digit pairing code.

On the workstation, run:

```bash
scripts/android-device.sh pair PHONE_IP:PAIRING_PORT
```

Enter the six-digit code at the prompt. Keeping the code out of the command
line prevents it from being stored in shell history.

Pairing and connecting use different ports. Android normally advertises the
connection service over mDNS and ADB connects automatically. Check:

```bash
scripts/android-device.sh list
```

If the paired phone is not listed, inspect the advertised services:

```bash
scripts/android-device.sh discover
```

Find the phone's `_adb-tls-connect._tcp` entry—not
`_adb-tls-pairing._tcp`—and connect using that entry's IP and port:

```bash
scripts/android-device.sh connect PHONE_IP:CONNECTION_PORT
scripts/android-device.sh list
```

The list reports a stable hardware serial and model for each physical phone,
while hiding duplicate mDNS/IP transports for the same phone. Use the hardware
serial as the selector when two connected devices have the same model.

Pairing is remembered by the phone, but wireless debugging may turn off after
a reboot, network change, or inactivity. Connection ports are deliberately
dynamic; never save one in a script. After reinstalling the workstation, its
new ADB key must be paired again. The old entry can be removed from the phone's
**Paired devices** list.

## 4. Address the intended device

Always specify a device when more than one phone or emulator is online.
The helper accepts a hardware serial, model, Android device codename, or
current ADB transport:

```bash
scripts/android-device.sh adb SM-S918B shell getprop ro.product.model
scripts/android-device.sh adb R5CW20KBA2W shell getprop ro.build.version.release
scripts/android-device.sh scrcpy SM-S918B
```

Run `scripts/android-device.sh list` rather than copying the example
identifiers above. For raw ADB, use the transport shown in the last column:

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

Before installing, check whether the package is already present:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell \
  pm list packages --user 0 com.afterglow.companion
```

Afterglow debug and release builds currently share both the package ID
`com.afterglow.companion` and the repository's shared debug signing key.
Consequently, `install -r` updates/reinstalls the existing app in place and
retains its app data; it does **not** create a side-by-side debug application.
If the installed APK has a different signing key, Android rejects the update
instead of installing a second copy.

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

That last command permanently removes Afterglow's local database and settings
from the selected Android user.

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

Capture logs for Afterglow debugging:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL logcat -c
scripts/android-device.sh adb HARDWARE_SERIAL logcat
```

For a dedicated phone kept on a charger, optionally keep the display awake:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell svc power stayon true
```

Restore normal sleep behavior afterward:

```bash
scripts/android-device.sh adb HARDWARE_SERIAL shell svc power stayon false
```

ADB cannot legitimately bypass a secure lock screen. Unlock the phone yourself
before a run. Screenshots and UI dumps can contain personal information, so
store them only for as long as the test requires and do not commit them.
Secure surfaces may be absent from screenshots. System permission,
MediaStore write/trash, biometric, and similar confirmation dialogs should be
observed and approved as part of acceptance testing rather than bypassed with
pre-granted permissions.

## 7. Emulator pass

The repository setup creates an accelerated Android 16 emulator:

```bash
scripts/run-emulator.sh
adb devices -l
```

When both phones and the emulator are connected, use the emulator transport
explicitly:

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

- Unlock it and confirm **Wireless debugging** is still enabled.
- Confirm both machines are on the same Wi-Fi and the access point does not
  isolate wireless clients.
- Run `scripts/android-device.sh discover`, then explicitly connect to the
  `_adb-tls-connect._tcp` port.
- Restart ADB with `adb kill-server && adb start-server`.
- If discovery remains broken, forget the workstation on the phone and pair
  again.

**Device is `offline`, duplicated, or commands choose the wrong target**

- Run `adb reconnect offline`, followed by
  `scripts/android-device.sh list`.
- Duplicate mDNS and IP transports can refer to one physical phone; the helper
  deduplicates them by hardware serial.
- Always use the helper with a hardware-serial selector in multi-device tests.

**Pairing succeeds but explicit connection is refused**

- The pairing port was probably reused as the connection port. They differ.
  Read the `_adb-tls-connect._tcp` service from `discover`.
- Reopen the Wireless debugging screen; Android may rotate its connection port.

**No mDNS services appear**

- Ensure UDP multicast/mDNS (port 5353) is allowed on the local network and
  workstation firewall.
- Guest Wi-Fi and enterprise networks commonly block peer-to-peer traffic.
- A USB cable remains a useful fallback for setup and diagnosis.

**Automation stops at the lock screen or a system dialog**

- Unlock the phone manually; do not put a PIN in scripts or chat.
- Some security-sensitive dialogs intentionally require a real confirmation.
  This is expected and should be recorded in acceptance results.
