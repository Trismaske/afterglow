# material-you-accent (local Expo module)

Tiny Android-only Expo module that reads the Material You dynamic
palette — `android.R.color.system_accent1_{200,500,700}` — and returns
the tones as hex strings. Built locally (`npx create-expo-module --local`)
because no maintained community library could be verified against
Expo SDK 57 / RN 0.86 new architecture.

API: `getSystemAccents(): { accent200, accent500, accent700 } | null`
(synchronous; `null` on Android < 12, iOS, Expo Go, or any failure).

The app's theme layer (`src/theme.tsx`) uses `accent200`
(tone 80 — light, made for dark surfaces) as the "System" accent and
falls back to the fixed amber preset when this returns `null`.

Native changes here require a dev-client rebuild (`npx expo run:android`).
