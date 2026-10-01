/**
 * The browse-structure version as React state (m0.9 phase 8), throttled
 * on the trailing edge: a publish schedules ONE delivery `delayMs` later
 * and every publish inside that window folds into it, so a scan landing
 * a window every few hundred milliseconds refreshes a listening screen
 * a few times a second at most — and always with the latest version.
 * The source is db/membershipSignal.ts.
 */
import { useEffect, useState } from 'react';
import { membershipVersion, onMembershipChange } from '../db/membershipSignal';

export function useMembershipVersion(delayMs: number): number {
  const [version, setVersion] = useState(membershipVersion);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onMembershipChange(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion(membershipVersion());
      }, delayMs);
    });
    // A publish that landed between the first render and this
    // subscription is not lost: the version is re-read now.
    setVersion(membershipVersion());
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [delayMs]);
  return version;
}
