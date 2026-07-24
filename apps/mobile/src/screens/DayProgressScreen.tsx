/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3): tappable state summary, filtered photo grid, state
 * editor sheet, and a "Review this day" CTA that starts the normal
 * session flow scoped to the day (the custom-range machinery: paged
 * loader + DeckSession, same as Home).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { rangeOfDayKey } from '../lib/dates';
import { resolveSources } from '../lib/sourceCatalog';
import { getSessionPrefs, loadReviewablePhotos, pendingBankIdsFor } from '../lib/reviewLoader';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
import { countKeptInScopeAmong } from '../db/store';
import { useSession } from '../session/SessionContext';
import { ProgressView } from '../components/progress/ProgressView';
import { BigButton } from '../components/BigButton';
import { colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

export function DayProgressScreen({ route, navigation }: Props) {
  const db = useSQLiteContext();
  const sessionCtx = useSession();
  const { day } = route.params;
  const range = useMemo(() => rangeOfDayKey(day), [day]);
  const [starting, setStarting] = useState(false);
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  // The CTA count must match the loader: the active session's
  // pending-bank keepers in this day are excluded from a draw, so they
  // must not enable "Review this day" on their own.
  const [keptPending, setKeptPending] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const ids = [...(await pendingBankIdsFor(sessionCtx.session, db))];
        const src = await resolveSources(db).catch(() => null);
        const n = await countKeptInScopeAmong(
          db,
          { startMs: range.startMs, endMs: range.endMs },
          src?.roots ?? null,
          ids,
        );
        if (!cancelled) setKeptPending(n);
      })();
      return () => {
        cancelled = true;
      };
    }, [db, sessionCtx.session, range]),
  );

  const startDayReview = useCallback(async () => {
    if (starting) return;
    const begin = async () => {
      setStarting(true);
      try {
        // Queued decision writes land first (a fresh staged cull must
        // not be re-drawn from its stale row), then the active session's
        // keepers count as handled WITHOUT mutation — they bank only
        // inside the atomic replacement, so an aborted start leaves the
        // old session intact.
        await sessionCtx.flushPersistence();
        const pendingBank = await pendingBankIdsFor(sessionCtx.session, db);
        const src = await resolveSources(db).catch(() => null);
        const prefs = await getSessionPrefs(db);
        const { reviewable } = await loadReviewablePhotos(
          db,
          range.startMs,
          range.endMs,
          src?.albumIds ?? null,
          prefs,
          pendingBank,
        );
        if (reviewable.length === 0) return; // counts were stale; focus refresh will catch up
        await sessionCtx.startSession(
          range.label,
          range.startMs,
          range.endMs,
          reviewable,
          (done, total) => setAnalyzing({ done, total }),
        );
        navigation.navigate('Groups');
      } catch (error) {
        // e.g. startup recovery hasn't succeeded yet — nothing was
        // replaced; retry is safe.
        Alert.alert(
          'Could not start the session',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setStarting(false);
        setAnalyzing(null);
      }
    };
    // m0.7 item H (#1): replacement is SILENT on every session-start
    // surface — the carry policy means nothing is ever lost (keepers
    // bank, staged culls stay in the durable global cull queue, and
    // re-drawn photos keep their verdicts). Resume first so the
    // in-memory session feeds pendingBankIdsFor when one exists.
    if (sessionCtx.session === null) await sessionCtx.resumeSession();
    await begin();
  }, [starting, db, range, sessionCtx, navigation]);

  const renderCta = useCallback(
    (b: StateBreakdown) => {
      const remaining = Math.max(0, remainingReviewable(b) - keptPending);
      return (
        <BigButton
          label={
            starting
              ? analyzing
                ? `Analyzing photos… ${analyzing.done}/${analyzing.total}`
                : 'Loading photos…'
              : remaining > 0
                ? `Review this day · ${remaining} to review`
                : 'Nothing left to review'
          }
          color={colors.keep}
          disabled={starting || remaining === 0}
          onPress={() => void startDayReview()}
        />
      );
    },
    [starting, analyzing, startDayReview, keptPending],
  );

  return (
    <ProgressView
      heading={range.label}
      scope={{ day }}
      startMs={range.startMs}
      endMs={range.endMs}
      renderCta={renderCta}
    />
  );
}
