/**
 * JS entry for the local material-you-accent Expo module (Android-only).
 *
 * `requireOptionalNativeModule` returns null when the native side is not
 * present (iOS, Expo Go, web, or a dev client built before the module
 * was added), and the native function itself returns null below
 * Android 12 — every failure path collapses to `null`, which callers
 * treat as "no dynamic palette".
 */
import { requireOptionalNativeModule } from 'expo';

export interface SystemAccents {
  /** system_accent1_200 — tone 80, the accent for dark surfaces. */
  accent200: string;
  /** system_accent1_500 — tone 40. */
  accent500: string;
  /** system_accent1_700 — tone 20. */
  accent700: string;
}

interface NativeApi {
  getSystemAccents(): SystemAccents | null;
}

const native = requireOptionalNativeModule<NativeApi>('MaterialYouAccent');

/** The wallpaper-derived Material You accents, or null when unavailable. */
export function getSystemAccents(): SystemAccents | null {
  try {
    return native?.getSystemAccents() ?? null;
  } catch {
    return null;
  }
}
