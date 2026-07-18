# media-store-actions (local Expo module)

Android 11+ MediaStore actions for moving photos to the system trash and
changing the system favourite flag. Android owns the confirmation sheet; a
cancelled sheet is returned separately from an operational failure.

The module intentionally reports `unsupported` below API 30 and when used in
Expo Go or an old development client. It never falls back to permanent delete.

Native changes require a development-client rebuild (`npx expo run:android`).
