import React, { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useReview } from '../review/ReviewContext';
import type { ReviewGroupRow } from '../db/store';
import { BigButton } from '../components/BigButton';
import { DecisionBadge, type DecisionKind } from '../components/DecisionBadge';
import { colors, touch, useTheme } from '../theme';
import { formatClock } from '../lib/format';
import { isFavouriteSelected } from '../lib/favouriteState';

type Props = NativeStackScreenProps<RootStackParamList, 'Groups'>;

const STRIP_THUMBS = 6;

/**
 * The review queue (m0.8: the continuous scan's groups — no sessions):
 * cull groups (thumbnail strip + count), the singles bucket, and a
 * "Continue" button for the linear flow. Every group row is tappable and
 * opens THAT group's deck — any order, singles any time; decisions land
 * durably at swipe time, so there is nothing to end or apply.
 */
export function GroupsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { groups, singles, queueCounts, version, needsEdit, favouriteStatus } = useReview();

  const stats = useMemo(() => {
    const total = queueCounts.grouped + queueCounts.singles;
    // The feed keeps staged culls badged (gate 5) — pending counts only
    // the photos still awaiting a verdict.
    const singlesPending = singles.filter((m) => m.state === 'unreviewed').length;
    return { pendingGrouped: queueCounts.grouped, singlesPending, total };
  }, [queueCounts, singles]);

  const nextStep = useMemo(() => {
    if (groups.length > 0) return 'Deck' as const;
    if (singles.length > 0) return 'Singles' as const;
    return 'CullList' as const;
  }, [groups, singles]);

  const continueLabel = useMemo(() => {
    if (nextStep === 'Deck') return 'Review groups';
    if (nextStep === 'Singles') return `Review singles (${stats.singlesPending})`;
    return 'Review cull list';
  }, [stats, nextStep]);

  const stateOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) for (const m of g.members) map.set(m.asset_id, m.state);
    return map;
  }, [groups]);
  const decisionKind = useCallback(
    (id: string): DecisionKind | null => {
      const state = stateOf.get(id) ?? 'unreviewed';
      if (state === 'culled') return 'cull';
      if (state === 'done' || state === 'to_edit') return needsEdit(id) ? 'edit' : 'keep';
      return null;
    },
    [needsEdit, stateOf],
  );

  const renderGroup = useCallback(
    ({ item: group, index }: { item: ReviewGroupRow; index: number }) => {
      const pending = group.members.filter((m) => m.state === 'unreviewed').length;
      const first = group.members[0];
      const displayItems = group.bestPhotoId
        ? [
            ...group.members.filter((m) => m.asset_id === group.bestPhotoId),
            ...group.members.filter((m) => m.asset_id !== group.bestPhotoId),
          ]
        : group.members;
      return (
        <Pressable
          style={styles.groupRow}
          onPress={() => navigation.navigate('Deck', { groupId: String(group.groupId) })}
        >
          <View style={styles.groupHeader}>
            <Text style={styles.groupTitle}>
              Group {index + 1} · {group.members.length} shots
              {first ? ` · ${formatClock(first.taken_at)}` : ''}
            </Text>
            <Text style={[styles.groupStatus, pending === 0 && styles.groupStatusDone]}>
              {pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`}
            </Text>
          </View>
          <View style={styles.strip}>
            {displayItems.slice(0, STRIP_THUMBS).map((member) => {
              const decision = decisionKind(member.asset_id);
              return (
                <View key={member.asset_id} style={styles.thumbWrap} pointerEvents="none">
                  <Image
                    source={{ uri: member.uri }}
                    style={[
                      styles.thumb,
                      member.asset_id === group.bestPhotoId && [
                        styles.thumbBest,
                        { borderColor: theme.accent },
                      ],
                    ]}
                    contentFit="cover"
                    recyclingKey={member.asset_id}
                  />
                  {decision && <DecisionBadge kind={decision} style={styles.decisionBadge} />}
                  {member.asset_id === group.bestPhotoId && (
                    <DecisionBadge kind="best" accent={theme.accent} style={styles.bestBadge} />
                  )}
                  {isFavouriteSelected(favouriteStatus(member.asset_id)) && (
                    <DecisionBadge kind="fav" style={styles.favouriteBadge} />
                  )}
                </View>
              );
            })}
            {group.members.length > STRIP_THUMBS && (
              <View style={[styles.thumb, styles.thumbMore]}>
                <Text style={styles.thumbMoreText}>+{group.members.length - STRIP_THUMBS}</Text>
              </View>
            )}
          </View>
        </Pressable>
      );
    },
    [decisionKind, favouriteStatus, navigation, theme.accent],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>Review</Text>
      <Text style={styles.subtitle}>
        {stats.total} photo{stats.total === 1 ? '' : 's'} waiting · {stats.pendingGrouped} in groups
      </Text>
      <FlatList
        data={groups}
        keyExtractor={(g) => String(g.groupId)}
        renderItem={renderGroup}
        contentContainerStyle={styles.list}
        extraData={version}
        ListFooterComponent={
          <Pressable style={styles.groupRow} onPress={() => navigation.navigate('Singles')}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupTitle}>Singles · {singles.length} photos</Text>
              <Text
                style={[styles.groupStatus, stats.singlesPending === 0 && styles.groupStatusDone]}
              >
                {stats.singlesPending === 0 ? 'Reviewed' : `${stats.singlesPending} pending`}
              </Text>
            </View>
          </Pressable>
        }
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={continueLabel}
          color={theme.accent}
          textColor={theme.onAccent}
          onPress={() => navigation.navigate(nextStep)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  center: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textDim, fontSize: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 15, marginTop: 2, marginBottom: 10 },
  list: { gap: 12, paddingBottom: 12 },
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
  thumbBest: { borderWidth: 2 },
  decisionBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  bestBadge: { position: 'absolute', top: 2, left: 2 },
  favouriteBadge: { position: 'absolute', bottom: 2, left: 2 },
  thumbMore: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
  footer: { paddingTop: 8, gap: 8 },
  endEarly: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  endEarlyText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
