/**
 * The queues' INSPECTION DOTS (m0.9 phase 7, F35): every queue row or
 * cell wears the same marks a grid tile wears — the verdict dot and the
 * weighted action glyphs — so a queue says what its photos carry. One
 * hydration per rows change (db/actions hydrateActionWeights); a failed
 * read leaves the verdict dot alone, never invented actions.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import { hydrateActionWeights } from '../db/actions';
import { photoBadges, type PhotoBadge, type WeightedActionSet } from '../lib/photoBadges';
import { classifyPhotoState, type EffectiveState } from '../lib/progress';

export interface QueueDots {
  effective: EffectiveState;
  badges: PhotoBadge[];
}

const NO_ACTIONS: WeightedActionSet = { edit: null, favourite: null, organize: null, share: null };

export function useQueueBadges(
  rows: ReadonlyArray<{ id: string; state: PhotoState }> | null,
): (id: string) => QueueDots {
  const db = useSQLiteContext();
  // The weights REMEMBER the rows they were read for: a fresh reload
  // renders verdict-only until its own hydration lands, never the last
  // rows' actions over the new rows (codex round 2).
  const [hydrated, setHydrated] = useState<{
    rows: ReadonlyArray<{ id: string; state: PhotoState }>;
    weights: Map<string, WeightedActionSet> | null;
  } | null>(null);
  const weights = hydrated !== null && hydrated.rows === rows ? hydrated.weights : null;
  // Keyed by the rows' IDENTITY: a queue reloads on every focus, and a
  // return from the deck can change an action on the same ids and
  // verdicts (codex round 1) — each reload's fresh array re-reads.
  useEffect(() => {
    if (rows === null) return;
    let cancelled = false;
    void hydrateActionWeights(db, rows).then((w) => {
      if (!cancelled) setHydrated({ rows, weights: w });
    });
    return () => {
      cancelled = true;
    };
  }, [db, rows]);
  const states = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r.state])), [rows]);
  return useMemo(
    () => (id: string) => {
      const state = states.get(id) ?? 'unreviewed';
      return {
        effective: classifyPhotoState({ state }),
        badges: photoBadges({ state, ...(weights?.get(id) ?? NO_ACTIONS) }),
      };
    },
    [states, weights],
  );
}
