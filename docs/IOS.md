# iOS readiness — the ledger

Afterglow for Android ships Android only; iOS has no users or testers yet (PLAN.md).
Building toward iOS starts with m0.9.1: this ledger names what iOS support must handle, each entry with the Android decision it mirrors, so that the Android work stops closing doors.
Add an entry whenever an Android decision rests on something iOS does differently.
Delete an entry when the iOS implementation lands.

| Area | What iOS needs | The Android decision it mirrors |
|---|---|---|
| Text scaling | Dynamic Type: each text style maps to a `dynamicTypeRamp` (caption2 … largeTitle) so iOS scales on its own curve; the same per-site audit of containers applies (free, fixed, ellipsized, pinned). | m0.9.1's type tokens (`theme.tsx`) and the per-site text audit; the pinned-height policy from the spike. |
| Reduce motion | `isReduceMotionEnabled` plus `prefersCrossFadeTransitions`: the immersive flip and the goal celebration become cuts or cross-fades. | m0.9.1's flip reads the Android animator scale through the same API. |
| Bold text | `isBoldTextEnabled` (iOS only): weights must still read as a hierarchy when every weight is lifted. | Android applies `fontWeightAdjustment` itself; the spike measures the 600/700 collapse. |
| Media library | PHPhotoLibrary: no MediaStore ids, no `createTrashRequest`; deletion is a system confirmation per request, favourites are `PHAssetChangeRequest`, albums are PHAssetCollections. | `lib/mediaIdentity.ts` ids, the trash and favourite wrappers in `lib/media.ts` and `modules/media-store-actions`. |
| Native modules | No iOS half exists for region zoom (`RegionZoom.kt`), the OS thumbnail source, media facts and motion-clip extraction, the MediaPipe embedder, the diagnostics sink and the Material You accent. | `apps/mobile/modules/*`. |
| Motion photos | Live Photos are a paired still and video, not a byte range in one file. | The v24 motion-clip byte ranges and `lib/motionClips.ts`. |
| Accent | No Material You; the "System" accent choice needs an iOS source or hides. | `lib/accentTheme.ts`. |
