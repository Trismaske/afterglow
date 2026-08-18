import React, { useCallback, useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PhotoState } from '@afterglow/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import { BigButton } from '../components/BigButton';
import { UnitCard } from '../components/UnitCard';
import { BadgeCluster } from '../components/DecisionBadge';
import { colors, useTheme } from '../theme';
import { formatClock } from '../lib/format';
import { labelForDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import { firstPendingUnit, unitDestination, type TimelineUnit } from '../lib/timeline';
import { deckParamsFor } from '../lib/deckUnit';
import { photoBadges, type PhotoBadge } from '../lib/photoBadges';

type Props = NativeStackScreenProps<RootStackParamList, 'Groups'>;

/**
 * The review overview (m0.8.2, F9): the merged timeline — group cards
 * and singles-run cards interleaved in ONE newest-first capture order,
 * the same order the deck's auto-advance walks, so the list never shows
 * an order the flow does not follow. Every card is tappable and opens
 * its own deck (any order); decisions land durably at swipe time, so
 * there is nothing to end or apply.
 */
export function GroupsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { timeline, queueCounts, version, actionWeights } = useReview();

  const stateOf = useMemo(() => {
    const map = new Map<string, PhotoState>();
    for (const unit of timeline) {
      const members = unit.kind === 'group' ? unit.group.members : unit.members;
      for (const m of members) map.set(m.asset_id, m.state);
    }
    return map;
  }, [timeline]);
  /** Same badge set as the deck (m0.8.1 round 4): verdict plus every
   * action, none hiding another, each at its own weight (m0.8.2). The
   * verdict rides into actionWeights so a staged cull's retained actions
   * badge quiet — they left the queues with it. */
  const badgesFor = useCallback(
    (assetId: string): PhotoBadge[] => {
      const state = stateOf.get(assetId) ?? 'unreviewed';
      return photoBadges({
        state,
        ...actionWeights(assetId, state),
      });
    },
    [actionWeights, stateOf],
  );

  const openUnit = useCallback(
    (unit: TimelineUnit) => {
      const destination = unitDestination(unit);
      if (destination.kind === 'cullList') navigation.navigate('CullList');
      else navigation.navigate('Deck', deckParamsFor(destination));
    },
    [navigation],
  );

  const renderUnit = useCallback(
    ({ item: unit }: { item: TimelineUnit }) => {
      if (unit.kind === 'group') {
        const group = unit.group;
        const pending = group.members.filter((m) => m.state === 'unreviewed').length;
        // Hidden members are NAMED on the card itself (Tristan, m0.8.3
        // matrix): a mixed group showing one thumbnail must say why
        // without being opened.
        const away =
          (group.unreachableCount ?? 0) > 0
            ? ` · ${group.unreachableCount} on unmounted SD card`
            : '';
        const newest = group.members[0];
        return (
          <UnitCard
            title={`Group · ${group.members.length} shots · ${labelForDayKey(newest?.day ?? UNDATED_DAY_KEY)}${newest ? ` ${formatClock(newest.taken_at)}` : ''}`}
            status={(pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`) + away}
            statusDone={pending === 0}
            members={group.members}
            onPress={() => openUnit(unit)}
            renderOverlay={(id) => (
              <BadgeCluster badges={badgesFor(id)} size={14} style={styles.badges} />
            )}
          />
        );
      }
      const pending = unit.members.filter((m) => m.state === 'unreviewed').length;
      return (
        <UnitCard
          title={`Singles · ${unit.members.length} photo${unit.members.length === 1 ? '' : 's'} · ${labelForDayKey(unit.day)}`}
          status={pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
          statusDone={pending === 0}
          members={unit.members}
          onPress={() => openUnit(unit)}
          renderOverlay={(id) => (
            <BadgeCluster badges={badgesFor(id)} size={14} style={styles.badges} />
          )}
        />
      );
    },
    [badgesFor, openUnit],
  );

  // First PENDING unit: a cull-only run stays a browseable card, but
  // the overview CTA must open review work (lib/timeline.ts).
  const first = firstPendingUnit(timeline);
  const total = queueCounts.grouped + queueCounts.singles;

  return (
    // The native stack header carries the title + back arrow (and eats
    // the top inset) — stack screens never re-render their own title or
    // re-pad insets.top (m0.8.1 consistency sweep).
    <View style={[styles.root, { paddingTop: 12 }]}>
      <Text style={styles.subtitle}>
        {total.toLocaleString()} photo{total === 1 ? '' : 's'} to review ·{' '}
        {queueCounts.groups.toLocaleString()} group{queueCounts.groups === 1 ? '' : 's'} ·{' '}
        {queueCounts.singles.toLocaleString()} single{queueCounts.singles === 1 ? '' : 's'}
      </Text>
      <FlatList
        data={timeline}
        keyExtractor={(unit) =>
          unit.kind === 'group' ? `g:${unit.group.groupId}` : `r:${unit.day}:${unit.to}`
        }
        renderItem={renderUnit}
        contentContainerStyle={styles.list}
        extraData={version}
        ListEmptyComponent={<Text style={styles.emptyText}>Nothing left to review.</Text>}
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={first ? 'Continue reviewing' : 'Review cull list'}
          color={theme.accent}
          textColor={theme.onAccent}
          onPress={() => (first ? openUnit(first) : navigation.navigate('CullList'))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  emptyText: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
  subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 10 },
  list: { gap: 12, paddingBottom: 12 },
  // Wrapping cluster inside the thumbnail — every badge stays visible.
  badges: { position: 'absolute', right: 2, bottom: 2, left: 2 },
  footer: { paddingTop: 8, gap: 8 },
});
