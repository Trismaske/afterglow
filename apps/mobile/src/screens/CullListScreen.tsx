import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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
 * batch to recoverable system trash (retention is gallery-controlled).
 */
export function CullListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { session, confirmCulls, version } = useSession();
  const [busy, setBusy] = useState(false);
  const [redecideItem, setRedecideItem] = useState<MediaItem | null>(null);
  const systemTrashSupported = Platform.OS === 'android' && Number(Platform.Version) >= 30;

  const staged = useMemo(
    () => session?.stagedCulls() ?? [],
    // The session object mutates in place; version is its render signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, version],
  );

  const runConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await confirmCulls();
      if (result.deleted) {
        navigation.replace('Summary');
      } else if (result.status === 'cancelled') {
        Alert.alert(
          'Nothing moved to trash',
          'The system confirmation was cancelled. Your photos are untouched and still staged.',
        );
      } else if (result.status === 'unsupported') {
        Alert.alert(
          'System trash unavailable',
          'Afterglow does not permanently delete photos. Moving culls to trash requires Android 11 or later.',
        );
      } else {
        Alert.alert(
          'Could not move photos to trash',
          result.error ??
            'Android MediaStore returned an unexpected error. Your culls remain staged.',
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
    // The app-level warning is followed by Android's MediaStore-owned
    // confirmation sheet. There is no permanent-delete fallback.
    Alert.alert(
      `Move ${staged.length} photo${staged.length === 1 ? '' : 's'} to trash?`,
      'Android will ask you to confirm. Recovery duration is controlled by your system gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Move to trash', style: 'destructive', onPress: () => void runConfirm() },
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
        {!systemTrashSupported && staged.length > 0
          ? 'System trash requires Android 11 or later. Culls remain staged and untouched.'
          : staged.length === 0
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
              ? 'Moving to trash…'
              : staged.length === 0
                ? 'Finish session'
                : `Trash ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          }
          color={staged.length === 0 ? colors.keep : colors.cull}
          disabled={busy || (!systemTrashSupported && staged.length > 0)}
          onPress={onConfirmPress}
        />
      </View>
      {redecideItem && (
        <ReDecideSheet item={redecideItem} current="culled" onClose={() => setRedecideItem(null)} />
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
