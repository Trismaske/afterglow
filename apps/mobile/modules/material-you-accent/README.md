# material-you-accent (local Expo module)

Small Android-only Expo module.
It reads the Material You dynamic palette (`android.R.color.system_accent1_{200,500,700}`) and returns the tones as hex strings.
It is built locally (`npx create-expo-module --local`) because we could not verify a maintained community library against Expo SDK 57 / RN 0.86 new architecture.

API: `getSystemAccents(): { accent200, accent500, accent700 } | null`.
The call is synchronous and returns `null` on Android < 12, iOS, Expo Go, or any failure.

The app's theme layer (`src/theme.tsx`) uses `accent200` (tone 80: light, made for dark surfaces) as the "System" accent.
If this returns `null`, the theme layer falls back to the fixed amber preset.

If you change native code here, rebuild the development client (`npx expo run:android`).
