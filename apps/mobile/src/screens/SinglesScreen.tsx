import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Singles'>;

/**
 * One-at-a-time review of photos outside any cull group. Big Cull /
 * To edit / Keep buttons (m0.2 adds the edit path; swipes remain later
 * polish). "To edit" keeps the photo AND queues it in the edit queue;
 * "Keep" converges to done when the session finishes.
 */
export function SinglesScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, singleIds, decideSingle, version } = useSession();
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => session?.nextSingle() ?? null, [session, version]);

  const progress = useMemo(() => {
    if (!session) return null;
    const done = singleIds.filter((id) => session.getState(id) !== 'unreviewed').length;
    return { done, total: singleIds.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, singleIds, version]);

  useEffect(() => {
    if (session && !current) navigation.replace('CullList');
  }, [session, current, navigation]);

  const decide = useCallback(
    async (action: 'keep' | 'cull' | 'to_edit') => {
      if (!current || busy) return;
      setBusy(true);
      try {
        await decideSingle(current.id, action);
      } finally {
        setBusy(false);
      }
    },
    [current, busy, decideSingle],
  );

  if (!session || !current) {
    return <View style={styles.root} />;
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          Singles · {(progress?.done ?? 0) + 1} of {progress?.total ?? 0}
        </Text>
        <Text style={styles.headerHint}>{formatClock(current.timestamp)}</Text>
      </View>
      <View style={styles.photoCard}>
        <Image
          source={{ uri: current.uri }}
          style={styles.photo}
          contentFit="contain"
          recyclingKey={current.id}
          transition={60}
        />
      </View>
      <View style={styles.actions}>
        <BigButton
          label={'✕\nCull'}
          color={colors.cull}
          disabled={busy}
          onPress={() => void decide('cull')}
          style={styles.actionButton}
        />
        <BigButton
          label={'✎\nTo edit'}
          color={colors.edit}
          disabled={busy}
          onPress={() => void decide('to_edit')}
          style={styles.actionButton}
        />
        <BigButton
          label={'✓\nKeep'}
          color={colors.keep}
          disabled={busy}
          onPress={() => void decide('keep')}
          style={styles.actionButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12, gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  headerHint: { color: colors.textDim, fontSize: 14 },
  photoCard: {
    flex: 1,
    borderRadius: touch.radius,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photo: { flex: 1 },
  actions: { flexDirection: 'row', gap: 12 },
  actionButton: { flex: 1 },
});
