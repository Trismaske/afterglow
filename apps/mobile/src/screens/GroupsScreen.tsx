import React, { useCallback, useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useSession, type GroupInfo } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Groups'>;

const STRIP_THUMBS = 6;

/**
 * Overview of the session: cull groups (thumbnail strip + count), the
 * singles bucket, and one big "Continue" button that drives the linear
 * review flow (swipe decks group-by-group, then singles, then the cull
 * list).
 */
export function GroupsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session, label, groups, singleIds, version } = useSession();

  const stats = useMemo(() => {
    if (!session) return null;
    const s = session.summary();
    const singlesPending = singleIds.filter((id) => session.getState(id) === 'unreviewed').length;
    return { ...s, reviewed: s.total - s.unreviewed, singlesPending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, version, singleIds]);

  const nextStep = useMemo(() => {
    if (!session) return null;
    if (session.currentGroupId()) return 'Deck' as const;
    if (session.nextSingle()) return 'Singles' as const;
    return 'CullList' as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, version]);

  const continueLabel = useMemo(() => {
    if (!session || !stats) return '';
    if (nextStep === 'Deck') return 'Review groups';
    if (nextStep === 'Singles') return `Review singles (${stats.singlesPending})`;
    return stats.culled > 0 ? `Review cull list (${stats.culled})` : 'Finish up';
  }, [session, stats, nextStep]);

  const renderGroup = useCallback(
    ({ item: group, index }: { item: GroupInfo; index: number }) => {
      // A group can be emptied entirely via "not related — single".
      const first = group.items[0];
      return (
        <View style={styles.groupRow}>
          <View style={styles.groupHeader}>
            <Text style={styles.groupTitle}>
              Group {index + 1} · {group.items.length} shots
              {first ? ` · ${formatClock(first.timestamp)}` : ''}
            </Text>
            <Text style={[styles.groupStatus, group.complete && styles.groupStatusDone]}>
              {group.complete ? 'reviewed ✓' : 'pending'}
            </Text>
          </View>
          <View style={styles.strip}>
            {group.items.slice(0, STRIP_THUMBS).map((item) => (
              <Image
                key={item.id}
                source={{ uri: item.uri }}
                style={[styles.thumb, item.id === group.bestId && [styles.thumbBest, { borderColor: theme.accent }]]}
                contentFit="cover"
                recyclingKey={item.id}
              />
            ))}
            {group.items.length > STRIP_THUMBS && (
              <View style={[styles.thumb, styles.thumbMore]}>
                <Text style={styles.thumbMoreText}>+{group.items.length - STRIP_THUMBS}</Text>
              </View>
            )}
          </View>
        </View>
      );
    },
    [theme.accent],
  );

  if (!session || !stats) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.emptyText}>No active session.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>{label}</Text>
      <Text style={styles.subtitle}>
        {stats.reviewed} of {stats.total} reviewed · {stats.culled} staged to cull
      </Text>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.id}
        renderItem={renderGroup}
        contentContainerStyle={styles.list}
        ListFooterComponent={
          <View style={styles.groupRow}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupTitle}>Singles · {singleIds.length} photos</Text>
              <Text
                style={[styles.groupStatus, stats.singlesPending === 0 && styles.groupStatusDone]}
              >
                {stats.singlesPending === 0 ? 'reviewed ✓' : `${stats.singlesPending} pending`}
              </Text>
            </View>
          </View>
        }
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {nextStep && (
          <BigButton
            label={continueLabel}
            color={theme.accent}
            textColor={theme.onAccent}
            onPress={() => navigation.navigate(nextStep)}
          />
        )}
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
  thumb: { flex: 1, aspectRatio: 1, borderRadius: 8, backgroundColor: colors.surfaceRaised },
  thumbBest: { borderWidth: 2 },
  thumbMore: { alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
  footer: { paddingTop: 8 },
});
