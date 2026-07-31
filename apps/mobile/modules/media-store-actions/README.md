# media-store-actions (local Expo module)

MediaStore actions for moving photos to the system trash and changing the
system favourite flag. Android owns the confirmation sheet; a cancelled
sheet is returned separately from an operational failure.

The module reports `unsupported` when it is absent — Expo Go, or a
development client built without it. That is the only remaining cause:
since m0.8.4 the app's own floor is API 30, so every version gate this
module carried is gone. It never falls back to permanent delete.

Native changes require a development-client rebuild (`npx expo run:android`).
