# media-store-actions (local Expo module)

MediaStore actions that move photos to the system trash and set the system favourite flag.
Android owns the confirmation sheet.
A cancelled sheet returns separately from an operational failure.

The module reports `unsupported` only when it is absent: Expo Go, or a development client built without it.
The app's floor is API 30 (since m0.8.4), so the module has no version gates.
It never falls back to a permanent delete.

If you change native code, rebuild the development client (`npx expo run:android`).
