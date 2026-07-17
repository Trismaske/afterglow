# Afterglow Companion (Android)

Drive every phone photo to a reviewed end-state. m0.1 is the trip-ready
culler: pick a day, duel through burst groups two photos at a time, sweep
the singles, review the staged cull list, and delete the batch to the
system trash with one confirmation.

## Running it (dev build required — NOT Expo Go)

Media permissions and the dev client don't work in Expo Go. You need a
development build on a real Android device:

```bash
cd apps/mobile
npx expo run:android        # device connected with USB debugging enabled
```

or build a dev client with EAS (`eas build --profile development
--platform android`) and then `npx expo start --dev-client`.

## The flow

1. **Home** — grant photo access, pick a scope: Today / Yesterday / custom
   date range. Shows how many photos, cull groups and singles are waiting.
2. **Session overview** — burst groups (photos ≤ 3 min apart) with
   thumbnail strips, plus the singles bucket. One button continues the
   review wherever it left off.
3. **Duel** — the signature mechanic. Two photos from the group, stacked.
   Tap **✕ Cull** on the weaker shot (stages it for deletion), or **★
   Better** to keep both and advance that one. Winners duel on until a
   group best emerges. Long-press any photo to inspect it fullscreen.
   Every outcome is recorded as duel history.
4. **Singles** — one photo at a time, **Keep** or **Cull**.
5. **Cull list** — everything staged, as a grid. Tap any photo to restore
   it. The single delete button is the only thing in the app that deletes
   anything: on Android 11+ the system dialog moves the batch to the
   system trash (recoverable ~30 days).
6. **Summary** — photos reviewed, keepers, culls, approximate storage
   reclaimed. Done for today.

Close the app mid-session and nothing is lost: the whole session —
including a half-finished duel bracket — is persisted to SQLite after
every decision and resumes from Home.

## Architecture notes

- All bracket/staging/state logic is `@afterglow/core` (`CullSession`,
  `clusterByGap`) — pure TS, tested in the core package.
- `src/lib/media.ts` is the only MediaStore adapter (SDK 57
  `expo-media-library/legacy` — see `docs/assumptions-mobile.md` #1) and
  contains the app's single delete call.
- SQLite (expo-sqlite async API) is the source of truth: `photos` keyed by
  MediaStore asset id (lazy SHA-256 content hash as fallback identity),
  `duels` history, `sessions` with the serialized core snapshot.
- Rendering via `expo-image` (`contentFit`, recycling keys) for fast
  thumbnails.
