import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession, type GroupInfo } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { ReDecideSheet, type DecidedState } from '../components/ReDecideSheet';
import { colors, touch, useTheme } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Groups'>;

const STRIP_THUMBS = 6;

/**
 * Overview of the session: cull groups (thumbnail strip + count), the
 * singles bucket, and a "Continue" button for the linear default flow.
 * m0.5 ("trust the user"): every group row is tappable and opens THAT
 * group's deck — any order, singles any time (even before groups),
 * completed groups re-open in browse/re-decide mode. Tapping a decided
 * thumbnail offers its state chips (ReDecideSheet), and "End session &
 * apply" banks all decisions made so far by jumping straight to the
 * staged-cull confirmation (unreviewed photos simply stay unreviewed
 * for a later session).
 */
export function GroupsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session, label, groups, singleIds, version, needsEdit } = useSession();
  const [redecide, setRedecide] = useState<{ item: MediaItem; state: DecidedState } | null>(null);

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

  /** Decided-photo tap → state chips; unreviewed tap → open the group. */
  const onThumbPress = useCallback(
    (group: GroupInfo, item: MediaItem) => {
      if (!session) return;
      const state = session.getState(item.id);
      if (state === 'kept' || state === 'culled') {
        setRedecide({ item, state });
      } else if (state === 'unreviewed') {
        navigation.navigate('Deck', { groupId: group.id });
      }
    },
    [session, navigation],
  );

  const redecideState: DecidedState = useMemo(() => {
    if (!redecide || !session) return 'kept';
    // 'to_edit' is app-side: core kept + needs-edit flag.
    if (redecide.state === 'kept') {
      return needsEdit(redecide.item.id) ? 'to_edit' : 'kept';
    }
    return redecide.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redecide, session, needsEdit, version]);

  const renderGroup = useCallback(
    ({ item: group, index }: { item: GroupInfo; index: number }) => {
      // A group can be emptied entirely via "not related — single".
      const first = group.items[0];
      return (
        <Pressable
          style={styles.groupRow}
          onPress={() => navigation.navigate('Deck', { groupId: group.id })}
        >
          <View style={styles.groupHeader}>
            <Text style={styles.groupTitle}>
              Group {index + 1} · {group.items.length} shots
              {first ? ` · ${formatClock(first.timestamp)}` : ''}
            </Text>
            <Text style={[styles.groupStatus, group.complete && styles.groupStatusDone]}>
              {group.complete ? 'reviewed ✓ · tap to revisit' : 'pending ›'}
            </Text>
          </View>
          <View style={styles.strip}>
            {group.items.slice(0, STRIP_THUMBS).map((item) => (
              <Pressable
                key={item.id}
                style={styles.thumbWrap}
                onPress={() => onThumbPress(group, item)}
              >
                <Image
                  source={{ uri: item.uri }}
                  style={[styles.thumb, item.id === group.bestId && [styles.thumbBest, { borderColor: theme.accent }]]}
                  contentFit="cover"
                  recyclingKey={item.id}
                />
                {session && session.getState(item.id) === 'culled' && (
                  <View style={styles.thumbCullBadge}>
                    <Text style={styles.thumbCullBadgeText}>✕</Text>
                  </View>
                )}
              </Pressable>
            ))}
            {group.items.length > STRIP_THUMBS && (
              <View style={[styles.thumb, styles.thumbMore]}>
                <Text style={styles.thumbMoreText}>+{group.items.length - STRIP_THUMBS}</Text>
              </View>
            )}
          </View>
        </Pressable>
      );
    },
    [theme.accent, navigation, onThumbPress, session],
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
        extraData={version}
        ListFooterComponent={
          <Pressable style={styles.groupRow} onPress={() => navigation.navigate('Singles')}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupTitle}>Singles · {singleIds.length} photos</Text>
              <Text
                style={[styles.groupStatus, stats.singlesPending === 0 && styles.groupStatusDone]}
              >
                {stats.singlesPending === 0 ? 'reviewed ✓' : `${stats.singlesPending} pending ›`}
              </Text>
            </View>
          </Pressable>
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
        {stats.reviewed > 0 && nextStep !== 'CullList' && (
          <Pressable style={styles.endEarly} onPress={() => navigation.navigate('CullList')}>
            <Text style={styles.endEarlyText}>
              End session & apply — bank {stats.reviewed} decision{stats.reviewed === 1 ? '' : 's'}
            </Text>
          </Pressable>
        )}
      </View>
      {redecide && (
        <ReDecideSheet
          item={redecide.item}
          current={redecideState}
          onClose={() => setRedecide(null)}
        />
      )}
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
  thumbCullBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.cullDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbCullBadgeText: { color: colors.cull, fontSize: 10, fontWeight: '800' },
  thumbMore: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbMoreText: { color: colors.textDim, fontWeight: '700' },
  footer: { paddingTop: 8, gap: 8 },
  endEarly: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  endEarlyText: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
});
