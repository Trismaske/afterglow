/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3): tappable state summary, filtered photo grid, state
 * editor sheet, and a "Review this day" CTA that starts the normal
 * session flow scoped to the day (the custom-range machinery: paged
 * loader + DeckSession, same as Home).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { rangeOfDayKey } from '../lib/dates';
import { resolveSources } from '../lib/sourceCatalog';
import { getSessionPrefs, loadReviewablePhotos } from '../lib/reviewLoader';
import { bankActiveSessionKeepers } from '../db/store';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
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

  const startDayReview = useCallback(async () => {
    if (starting) return;
    const begin = async () => {
      setStarting(true);
      try {
        // m0.5: bank the replaced session's keepers before loading, so
        // they land as handled instead of being re-reviewed.
        await bankActiveSessionKeepers(db);
        const src = await resolveSources(db).catch(() => null);
        const prefs = await getSessionPrefs(db);
        const { reviewable } = await loadReviewablePhotos(
          db,
          range.startMs,
          range.endMs,
          src?.albumIds ?? null,
          prefs,
        );
        if (reviewable.length === 0) return; // counts were stale; focus refresh will catch up
        await sessionCtx.startSession(range.label, range.startMs, range.endMs, reviewable, (
          done,
          total,
        ) => setAnalyzing({ done, total }));
        navigation.navigate('Groups');
      } finally {
        setStarting(false);
        setAnalyzing(null);
      }
    };
    // Same guard as Home: an unfinished session (in memory or persisted)
    // is replaced only after an explicit confirm.
    const hasActive = sessionCtx.session !== null || (await sessionCtx.resumeSession());
    if (hasActive) {
      // m0.5 order/roles: destructive "Start new" leftmost, Cancel in the
      // middle, "Continue existing" as the rightmost default action.
      Alert.alert(
        'Replace unfinished session?',
        'Starting a new session keeps every decision you already made — reviewed keepers ' +
          'are saved, and the unreviewed rest waits for a later session. Nothing gets deleted.',
        [
          { text: 'Start new', style: 'destructive', onPress: () => void begin() },
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Continue existing',
            isPreferred: true,
            onPress: () => navigation.navigate('Groups'),
          },
        ],
      );
    } else {
      await begin();
    }
  }, [starting, db, range, sessionCtx, navigation]);

  const renderCta = useCallback(
    (b: StateBreakdown) => {
      const remaining = remainingReviewable(b);
      return (
        <BigButton
          label={
            starting
              ? analyzing
                ? `Analyzing photos… ${analyzing.done}/${analyzing.total}`
                : 'Loading photos…'
              : remaining > 0
                ? `Review this day · ${remaining} to review`
                : 'Nothing left to review ✦'
          }
          color={colors.keep}
          disabled={starting || remaining === 0}
          onPress={() => void startDayReview()}
        />
      );
    },
    [starting, analyzing, startDayReview],
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
