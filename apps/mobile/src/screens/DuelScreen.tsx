import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { colors, touch } from '../theme';
import { formatClock } from '../lib/format';

type Props = NativeStackScreenProps<RootStackParamList, 'Duel'>;

/**
 * The duel: the two photos of the current pair stacked vertically (m0.1
 * call — the fullscreen A/B flip is m0.3 polish). One tap decides:
 *   - "Cull" on a photo stages IT for deletion, the other wins the duel.
 *   - "Better" on a photo keeps BOTH and advances that photo.
 * Press-and-hold a photo to inspect it fullscreen.
 */
export function DuelScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, groups, decideDuel, version } = useSession();
  const [busy, setBusy] = useState(false);
  const [zoomed, setZoomed] = useState<MediaItem | null>(null);

  const pair = useMemo(() => session?.nextPair() ?? null, [session, version]);

  const groupInfo = useMemo(() => {
    if (!pair) return null;
    const index = groups.findIndex((g) => g.id === pair.groupId);
    if (index < 0) return null;
    const group = groups[index];
    return { index, total: groups.length, size: group.items.length, start: group.items[0].timestamp };
  }, [pair, groups]);

  // All duels done → move along (singles, else cull list).
  useEffect(() => {
    if (!session || pair) return;
    if (session.nextSingle()) navigation.replace('Singles');
    else navigation.replace('CullList');
  }, [session, pair, navigation]);

  const decide = useCallback(
    async (decision: Parameters<typeof decideDuel>[0]) => {
      if (busy) return;
      setBusy(true);
      try {
        await decideDuel(decision);
      } finally {
        setBusy(false);
      }
    },
    [busy, decideDuel],
  );

  if (!session || !pair) {
    return <View style={styles.root} />;
  }

  const renderCard = (item: MediaItem) => (
    <View style={styles.card}>
      <Pressable
        style={styles.photoWrap}
        onLongPress={() => setZoomed(item)}
        onPressOut={() => setZoomed(null)}
        delayLongPress={180}
      >
        <Image
          source={{ uri: item.uri }}
          style={styles.photo}
          contentFit="cover"
          recyclingKey={item.id}
          transition={60}
        />
        <View style={styles.timeTag}>
          <Text style={styles.timeTagText}>{formatClock(item.timestamp)}</Text>
        </View>
      </Pressable>
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.actionButton, styles.cullButton]}
          disabled={busy}
          onPress={() => void decide({ cull: item.id })}
        >
          <Text style={styles.actionText}>✕ Cull</Text>
        </Pressable>
        <Pressable
          style={[styles.actionButton, styles.betterButton]}
          disabled={busy}
          onPress={() => void decide({ keepBoth: true, winner: item.id })}
        >
          <Text style={styles.actionText}>★ Better</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {groupInfo
            ? `Group ${groupInfo.index + 1} of ${groupInfo.total} · ${groupInfo.size} shots · ${formatClock(groupInfo.start)}`
            : 'Duel'}
        </Text>
        <Text style={styles.headerHint}>Cull the weaker shot, or keep both and pick the better. Hold to zoom.</Text>
      </View>
      {renderCard(pair.a)}
      {renderCard(pair.b)}

      {zoomed && (
        <View style={styles.zoomOverlay} pointerEvents="none">
          <Image source={{ uri: zoomed.uri }} style={styles.zoomImage} contentFit="contain" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12, gap: 10 },
  header: { gap: 2, paddingHorizontal: 4 },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  headerHint: { color: colors.textDim, fontSize: 12 },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  photoWrap: { flex: 1 },
  photo: { flex: 1, backgroundColor: colors.surfaceRaised },
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
  actionRow: { flexDirection: 'row' },
  actionButton: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cullButton: { backgroundColor: colors.cullDim },
  betterButton: { backgroundColor: '#1f3a2a' },
  actionText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  zoomOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    zIndex: 10,
  },
  zoomImage: { flex: 1 },
});
