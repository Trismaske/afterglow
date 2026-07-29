/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3; m0.8: sessions are gone): tappable state summary,
 * filtered photo grid, state editor sheet, and a "Continue reviewing"
 * CTA into the continuous review queue (the day's photos are already
 * grouped there by the scan). Gate 5: the day's cull groups list here
 * too — completed ones included — and reopen in the deck's
 * browse/re-decide mode.
 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { formatClock } from '../lib/format';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
import { listGroupsForDay, type ReviewGroupRow } from '../db/store';
import { resolveSources } from '../lib/sourceCatalog';
import { ProgressView } from '../components/progress/ProgressView';
import { useReview } from '../review/ReviewContext';
import { DecisionBadge, type DecisionKind } from '../components/DecisionBadge';
import { UnitCard } from '../components/UnitCard';
import { BigButton } from '../components/BigButton';
import { colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

function decisionKindOf(member: ReviewGroupRow['members'][number]): DecisionKind | null {
  if (member.state === 'culled') return 'cull';
  // v18: one kept verdict; the pencil comes from the edit ACTION.
  if (member.state === 'kept') return member.needs_edit === 1 ? 'edit' : 'keep';
  return null;
}

export function DayProgressScreen({ route, navigation }: Props) {
  const { day } = route.params;
  const db = useSQLiteContext();
  const { version } = useReview();
  const [groups, setGroups] = useState<ReviewGroupRow[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        // Same source scoping as the page's totals and grid. FAIL CLOSED:
        // a resolution error hides the section rather than broadening a
        // narrowed source to all folders (null's store meaning).
        try {
          const roots = (await resolveSources(db)).roots ?? null;
          const rows = await listGroupsForDay(db, day, roots);
          if (!cancelled) setGroups(rows);
        } catch (error) {
          console.warn('[day] source resolution failed — day groups hidden:', String(error));
          if (!cancelled) setGroups([]);
        }
      })();
      return () => {
        cancelled = true;
      };
      // version is a deliberate refresh trigger: viewer edits refresh the
      // review context, and the day's group list (badges, pending counts)
      // must follow without a leave-and-return (a closing Modal does not
      // refocus the screen).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, day, version]),
  );

  const renderCta = useCallback(
    (b: StateBreakdown) => {
      const remaining = remainingReviewable(b);
      return (
        <View style={styles.ctaBlock}>
          <BigButton
            label={
              remaining > 0
                ? `Continue reviewing · ${remaining} left this day`
                : 'Nothing left to review'
            }
            color={colors.keep}
            disabled={remaining === 0}
            // The label promises THIS day, so BOTH destinations are day
            // scoped: the day's first pending group, else the day's own
            // singles deck. The plain `Singles` route opens the GLOBAL
            // newest-first feed, which for any day but the newest is a
            // different day's photos entirely (m0.8.2).
            onPress={() => {
              const pendingGroup = (groups ?? []).find((g) =>
                g.members.some((m) => m.state === 'unreviewed'),
              );
              if (pendingGroup)
                navigation.navigate('Deck', { groupId: String(pendingGroup.groupId) });
              else navigation.navigate('Singles', { day });
            }}
          />
          {groups !== null && groups.length > 0 && (
            <>
              <Text style={styles.groupsLabel}>Groups this day</Text>
              {groups.map((group) => {
                const pending = group.members.filter((m) => m.state === 'unreviewed').length;
                const first = group.members[0];
                const decisionOf = (assetId: string) => {
                  const member = group.members.find((m) => m.asset_id === assetId);
                  return member ? decisionKindOf(member) : null;
                };
                return (
                  <UnitCard
                    key={group.groupId}
                    title={`${group.members.length} shots${first ? ` · ${formatClock(first.taken_at)}` : ''}`}
                    status={pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
                    statusDone={pending === 0}
                    members={group.members}
                    onPress={() => navigation.navigate('Deck', { groupId: String(group.groupId) })}
                    renderOverlay={(assetId) => {
                      const decision = decisionOf(assetId);
                      return decision ? (
                        <DecisionBadge kind={decision} style={styles.decisionBadge} />
                      ) : null;
                    }}
                  />
                );
              })}
            </>
          )}
        </View>
      );
    },
    [day, groups, navigation],
  );

  return <ProgressView target={{ kind: 'day', day }} renderCta={renderCta} />;
}

const styles = StyleSheet.create({
  ctaBlock: { gap: 12 },
  groupsLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  decisionBadge: { position: 'absolute', top: 2, right: 2 },
});
