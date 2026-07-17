import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Reconsider'>;

type Verdict = 'culled' | 'kept';

/**
 * Auto-cull hint (m0.3): a bracket just completed and some keepers never
 * won a single duel. One-tap cull or keep for each; anything left
 * undecided simply stays kept. Driven by core's autoCullCandidates()
 * (kept + never won + not the group best, from the duel history).
 */
export function ReconsiderScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { groupId } = route.params;
  const { session, groups, reconsiderCull, clearPendingReconsider, needsEdit } = useSession();

  // Freeze the candidate list on mount — culling one must not reshuffle
  // the others out from under the user's fingers.
  const [candidates] = useState<MediaItem[]>(() =>
    session
      ? session.autoCullCandidates(groupId).filter((item) => !needsEdit(item.id))
      : [],
  );
  const [keptCount] = useState<number>(() => {
    const group = groups.find((g) => g.id === groupId);
    if (!group || !session) return 0;
    return group.items.filter((item) => session.getState(item.id) !== 'culled').length;
  });
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    clearPendingReconsider();
  }, [clearPendingReconsider]);

  const nextStep = useMemo(() => {
    if (!session) return 'CullList' as const;
    if (session.nextPair()) return 'Duel' as const;
    if (session.nextSingle()) return 'Singles' as const;
    return 'CullList' as const;
  }, [session]);

  const continueLabel =
    nextStep === 'Duel'
      ? 'Continue duels'
      : nextStep === 'Singles'
        ? 'Continue to singles'
        : 'Continue to cull list';

  // Nothing to reconsider (e.g. resumed navigation) → move along.
  useEffect(() => {
    if (candidates.length === 0) navigation.replace(nextStep);
  }, [candidates.length, navigation, nextStep]);

  const cullOne = useCallback(
    async (id: string) => {
      if (busyId) return;
      setBusyId(id);
      try {
        await reconsiderCull(id);
        setVerdicts((prev) => new Map(prev).set(id, 'culled'));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, reconsiderCull],
  );

  const keepOne = useCallback((id: string) => {
    setVerdicts((prev) => new Map(prev).set(id, 'kept'));
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: MediaItem }) => {
      const verdict = verdicts.get(item.id);
      return (
        <View style={styles.card}>
          <Image
            source={{ uri: item.uri }}
            style={styles.photo}
            contentFit="cover"
            recyclingKey={item.id}
          />
          <View style={styles.timeTag}>
            <Text style={styles.timeTagText}>{formatClock(item.timestamp)}</Text>
          </View>
          {verdict ? (
            <View style={[styles.verdictRow, verdict === 'culled' && styles.verdictRowCulled]}>
              <Text style={styles.verdictText}>
                {verdict === 'culled' ? '✕ staged to cull' : '✓ keeping it'}
              </Text>
            </View>
          ) : (
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.button, styles.cullButton]}
                disabled={busyId !== null}
                onPress={() => void cullOne(item.id)}
              >
                <Text style={styles.buttonText}>✕ Cull</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.keepButton]}
                disabled={busyId !== null}
                onPress={() => keepOne(item.id)}
              >
                <Text style={styles.buttonText}>✓ Keep</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    },
    [verdicts, busyId, cullOne, keepOne],
  );

  if (!session || candidates.length === 0) {
    return <View style={styles.root} />;
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>
        You kept {keptCount} — reconsider {candidates.length === 1 ? 'this one' : `these ${candidates.length}`}?
      </Text>
      <Text style={styles.subtitle}>
        {candidates.length === 1 ? 'This shot' : 'These shots'} never won a duel. Undecided ones
        stay kept.
      </Text>
      <FlatList
        data={candidates}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={continueLabel}
          color={colors.accent}
          textColor="#1a1205"
          disabled={busyId !== null}
          onPress={() => navigation.replace(nextStep)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16, paddingTop: 12 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 2, marginBottom: 12 },
  list: { gap: 12, paddingBottom: 12 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  photo: { width: '100%', aspectRatio: 4 / 3, backgroundColor: colors.surfaceRaised },
  timeTag: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  timeTagText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  buttonRow: { flexDirection: 'row' },
  button: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  cullButton: { backgroundColor: colors.cullDim },
  keepButton: { backgroundColor: colors.keepDim },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  verdictRow: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.keepDim,
  },
  verdictRowCulled: { backgroundColor: colors.cullDim },
  verdictText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  footer: { paddingTop: 8 },
});
