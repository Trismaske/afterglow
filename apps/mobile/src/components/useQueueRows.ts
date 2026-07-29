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
 */
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useReview } from '../review/ReviewContext';

export function useQueueRows<T>(load: () => Promise<T[]>): {
  rows: T[] | null;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<T[] | null>(null);
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
    const next = await load();
    setRows(next);
    if (rendered.current !== null && rendered.current !== next.length) queuesChanged();
    rendered.current = next.length;
  }, [load, queuesChanged]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return { rows, reload };
}
