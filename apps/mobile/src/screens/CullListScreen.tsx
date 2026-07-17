import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { ReDecideSheet } from '../components/ReDecideSheet';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'CullList'>;

/**
 * The staged cull list. Tapping a photo opens the m0.5 re-decide sheet
 * (keep / to edit / stays culled) — the last stop where any decision is
 * still reversible. The ONE confirm button below is the only path in the
 * app that deletes anything; on Android 11+ the system dialog moves the
 * batch to the trash (30-day recovery).
 */
export function CullListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, confirmCulls, version } = useSession();
  const [busy, setBusy] = useState(false);
  const [redecideItem, setRedecideItem] = useState<MediaItem | null>(null);

  const staged = useMemo(() => session?.stagedCulls() ?? [], [session, version]);

  const runConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await confirmCulls();
      if (result.deleted) {
        navigation.replace('Summary');
      } else {
        Alert.alert(
          'Nothing deleted',
          'The system delete was cancelled. Your photos are untouched and still staged.',
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy, confirmCulls, navigation]);

  const onConfirmPress = useCallback(() => {
    if (staged.length === 0) {
      navigation.replace('Summary');
      return;
    }
    // Our own confirm matters on Android < 11 where there is no system
    // dialog; on 11+ the system dialog follows and is the real gate.
    Alert.alert(
      `Delete ${staged.length} photo${staged.length === 1 ? '' : 's'}?`,
      'They go to the system trash (recoverable for ~30 days).',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void runConfirm() },
      ],
    );
  }, [staged.length, navigation, runConfirm]);

  const renderItem = useCallback(
    ({ item }: { item: MediaItem }) => (
      <Pressable style={styles.tile} onPress={() => setRedecideItem(item)} disabled={busy}>
        <Image
          source={{ uri: item.uri }}
          style={styles.tileImage}
          contentFit="cover"
          recyclingKey={item.id}
        />
        <View style={styles.tileBadge}>
          <Text style={styles.tileBadgeText}>tap to change</Text>
        </View>
      </Pressable>
    ),
    [busy],
  );

  if (!session) {
    return <View style={styles.root} />;
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>Cull list</Text>
      <Text style={styles.subtitle}>
        {staged.length === 0
          ? 'Nothing staged for deletion.'
          : `${staged.length} staged · tap any photo to change its decision`}
      </Text>
      <FlatList
        data={staged}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        numColumns={3}
        columnWrapperStyle={staged.length > 0 ? styles.column : undefined}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Everything you reviewed is a keeper.</Text>
        }
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={
            busy
              ? 'Deleting…'
              : staged.length === 0
                ? 'Finish session'
                : `Delete ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          }
          color={staged.length === 0 ? colors.keep : colors.cull}
          disabled={busy}
          onPress={onConfirmPress}
        />
      </View>
      {redecideItem && (
        <ReDecideSheet
          item={redecideItem}
          current="culled"
          onClose={() => setRedecideItem(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 2, marginBottom: 10 },
  list: { gap: 6, paddingBottom: 12, flexGrow: 1 },
  column: { gap: 6 },
  tile: { flex: 1 / 3, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  tileImage: { flex: 1, backgroundColor: colors.surfaceRaised },
  tileBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 2,
    alignItems: 'center',
  },
  tileBadgeText: { color: colors.textDim, fontSize: 10 },
  emptyText: { color: colors.textDim, fontSize: 15, textAlign: 'center', marginTop: 40 },
  footer: { paddingTop: 8 },
});
