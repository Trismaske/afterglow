/**
 * Run a callback when the world changes OUTSIDE navigation (m0.8.3):
 * on every foreground return (final cycle O6 — React Navigation's focus
 * effects do not re-fire when the app merely returns from background)
 * AND on every live storage-volume mount/unmount (Tristan, matrix — a
 * card swapped while the app stays foregrounded fires no AppState or
 * focus event; the OS broadcast is the only push). Every screen showing
 * mounted-scoped data wires the same reload its focus effect runs.
 *
 * The mounted-volume cache itself invalidates before either trigger
 * reaches callbacks (module-scope listeners in lib/mountedVolumes.ts
 * and the module registered at import — i.e. BEFORE any component's
 * subscription), so callbacks always re-read fresh mount state.
 *
 * The callback is kept in a ref: callers may pass a fresh closure every
 * render without re-subscribing or looping.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { onVolumesChanged } from '../lib/mountedVolumes';

export function useExternalRefresh(onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') ref.current();
    });
    const unsubscribe = onVolumesChanged(() => ref.current());
    return () => {
      subscription.remove();
      unsubscribe();
    };
  }, []);
}
