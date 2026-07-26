/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3; m0.8: sessions are gone): tappable state summary,
 * filtered photo grid, state editor sheet, and a "Continue reviewing"
 * CTA into the continuous review queue (the day's photos are already
 * grouped there by the scan). Gate 5: the day's cull groups list here
 * too — completed ones included — and reopen in the deck's
 * browse/re-decide mode.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { rangeOfDayKey } from '../lib/dates';
import { formatClock } from '../lib/format';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
import { listGroupsForDay, type ReviewGroupRow } from '../db/store';
import { resolveSources } from '../lib/sourceCatalog';
import { ProgressView } from '../components/progress/ProgressView';
import { DecisionBadge, type DecisionKind } from '../components/DecisionBadge';
import { BigButton } from '../components/BigButton';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

const STRIP_THUMBS = 6;

function decisionKindOf(member: ReviewGroupRow['members'][number]): DecisionKind | null {
  if (member.state === 'culled') return 'cull';
  if (member.state === 'done' || member.state === 'to_edit')
    return member.needs_edit === 1 ? 'edit' : 'keep';
  return null;
}

export function DayProgressScreen({ route, navigation }: Props) {
  const { day } = route.params;
  const db = useSQLiteContext();
  const range = useMemo(() => rangeOfDayKey(day), [day]);
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
    }, [db, day]),
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
            onPress={() => navigation.navigate('Groups')}
          />
          {groups !== null && groups.length > 0 && (
            <>
              <Text style={styles.groupsLabel}>Groups this day</Text>
              {groups.map((group) => {
                const pending = group.members.filter((m) => m.state === 'unreviewed').length;
                const first = group.members[0];
                return (
                  <Pressable
                    key={group.groupId}
                    style={styles.groupRow}
                    onPress={() => navigation.navigate('Deck', { groupId: String(group.groupId) })}
                  >
                    <View style={styles.groupHeader}>
                      <Text style={styles.groupTitle}>
                        {group.members.length} shots
                        {first ? ` · ${formatClock(first.taken_at)}` : ''}
                      </Text>
                      <Text style={[styles.groupStatus, pending === 0 && styles.groupStatusDone]}>
                        {pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
                      </Text>
                    </View>
                    <View style={styles.strip}>
                      {group.members.slice(0, STRIP_THUMBS).map((member) => {
                        const decision = decisionKindOf(member);
                        return (
                          <View key={member.asset_id} style={styles.thumbWrap} pointerEvents="none">
                            <Image
                              source={{ uri: member.uri }}
                              style={styles.thumb}
                              contentFit="cover"
                              recyclingKey={member.asset_id}
                            />
                            {decision && (
                              <DecisionBadge kind={decision} style={styles.decisionBadge} />
                            )}
                          </View>
                        );
                      })}
                      {group.members.length > STRIP_THUMBS && (
                        <View style={[styles.thumb, styles.thumbMore]}>
                          <Text style={styles.thumbMoreText}>
                            +{group.members.length - STRIP_THUMBS}
                          </Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </>
          )}
        </View>
      );
    },
    [groups, navigation],
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

const styles = StyleSheet.create({
  ctaBlock: { gap: 12 },
  groupsLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  groupRow: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 10,
  },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  groupTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  groupStatus: { color: colors.textDim, fontSize: 13 },
  groupStatusDone: { color: colors.keep },
  strip: { flexDirection: 'row', gap: 6 },
  thumbWrap: { flex: 1 },
  thumb: { width: '100%', aspectRatio: 1, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  thumbMore: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
  decisionBadge: { position: 'absolute', top: 2, right: 2 },
});
