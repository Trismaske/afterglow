/**
 * The logging error boundary (m0.8.7) — sits at the provider stack in
 * App.tsx and exists ONLY to record. A render crash in release used to
 * kill the app with no trace; this boundary writes the error and React's
 * component stack through console.error (which the diagLog hook persists
 * and flushes), then RE-THROWS so the crash proceeds exactly as before —
 * it never swallows an error into a silently-broken UI.
 *
 * Mechanics: getDerivedStateFromError makes the fallback render a
 * successful `null`, which is what lets React reach componentDidCatch at
 * all; componentDidCatch logs and then throws, and with no boundary
 * above, the error lands in the global handler (also hooked by
 * lib/diagLog.ts — the suppressor collapses the duplicate message; the
 * component stack recorded here is the part only a boundary can know).
 */
import React from 'react';

interface State {
  error: Error | null;
}

export class DiagErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      '[crash] render error at the provider stack:',
      error,
      '\ncomponent stack:',
      info.componentStack ?? '(unavailable)',
    );
    // Logged — now die exactly as an unboundaried tree would.
    throw error;
  }

  render(): React.ReactNode {
    if (this.state.error !== null) return null;
    return this.props.children;
  }
}
