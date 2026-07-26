/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3; m0.8: sessions are gone): tappable state summary,
 * filtered photo grid, state editor sheet, and a "Continue reviewing"
 * CTA into the continuous review queue (the day's photos are already
 * grouped there by the scan).
 */
import React, { useCallback, useMemo } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { rangeOfDayKey } from '../lib/dates';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
import { ProgressView } from '../components/progress/ProgressView';
import { BigButton } from '../components/BigButton';
import { colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

export function DayProgressScreen({ route, navigation }: Props) {
  const { day } = route.params;
  const range = useMemo(() => rangeOfDayKey(day), [day]);

  const renderCta = useCallback(
    (b: StateBreakdown) => {
      const remaining = remainingReviewable(b);
      return (
        <BigButton
          label={
            remaining > 0
              ? `Continue reviewing · ${remaining} left this day`
              : 'Nothing left to review'
          }
          color={colors.keep}
          disabled={remaining === 0}
          onPress={() => navigation.navigate('Groups')}
        />
      );
    },
    [navigation],
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
