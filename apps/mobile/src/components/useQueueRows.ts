/**
 * Shared row-loading shell of the four queue screens (m0.8.1): rows state
 * (null = still loading), a reload bound to the store read, and a
 * focus-effect reload — the tab navigator keeps queue screens mounted
 * while blurred, so queues touched elsewhere (deck toggles, applies,
 * detection) must re-read on return.
 *
 * `load` MUST be referentially stable (useCallback on [db]) — a fresh
 * function every render would re-fire the focus effect per render and
 * loop reloads.
 *
 * `failed` (codex r9): a rejected read no longer escapes as an unhandled
 * rejection. The last successful rows are KEPT — a queue list going
 * blank mid-action is worse than a stale one — and `failed` lets each
 * screen say so quietly (the shared line below); the next successful
 * reload clears it. An INITIAL failure leaves rows null, so screens swap
 * their loading state for the failure line instead of loading forever.
 */
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useReview } from '../review/ReviewContext';

/** The one quiet failure line every queue screen renders when `failed`
 * is set — stale rows stay on screen, this says why they might be. */
export const QUEUE_REFRESH_FAILED = 'Could not refresh this queue just now.';

export function useQueueRows<T>(load: () => Promise<T[]>): {
  rows: T[] | null;
  failed: boolean;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { queuesChanged } = useReview();
  // The last count this hook rendered. A reload that changes it means
  // work entered or left a durable queue, which the TAB BADGES and any
  // loaded Stats tab must hear about — the review-queue refresh cannot
  // tell them, because it deliberately commits nothing when the deck's
  // own snapshot is unchanged (m0.8.1), and queue screens routinely act
  // on photos the deck never loaded. Gated on the count so an ordinary
  // focus-reload does not invalidate every stats query.
  const rendered = useRef<number | null>(null);
  const reload = useCallback(async () => {
    let next: T[];
    try {
      next = await load();
    } catch {
      // codex r9: the read rejected — keep whatever the screen already
      // shows and mark the failure; reload itself never rejects, so the
      // focus effect and every awaiting mutation handler stay total.
      setFailed(true);
      return;
    }
    setRows(next);
    setFailed(false);
    if (rendered.current !== null && rendered.current !== next.length) queuesChanged();
    rendered.current = next.length;
  }, [load, queuesChanged]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return { rows, failed, reload };
}
