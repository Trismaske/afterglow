/**
 * Durable Android favourite/unfavourite queue. Each direction is one
 * MediaStore-owned batch confirmation, then every IS_FAVORITE flag is
 * verified before SQLite commits the result. Cancelled and failed work stays
 * visible and retryable across restarts.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getFavouriteQueue,
  markFavouriteBatchApplied,
  markFavouriteBatchError,
  type FavouriteQueueRow,
} from '../db/store';
import { applyFavouriteBatch, FAVOURITE_BATCH_LIMIT } from '../lib/favourites';
import { BigButton } from '../components/BigButton';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';
import { useReview } from '../review/ReviewContext';
import { PhotoViewer } from '../components/PhotoViewer';

export function FavouritesQueueScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { refreshFavouriteStates } = useReview();
  const [rows, setRows] = useState<FavouriteQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyTarget, setBusyTarget] = useState<boolean | null>(null);
  /** In-app full-screen viewer (gate 5) — thumbnail tap. */
  const [viewerId, setViewerId] = useState<string | null>(null);
  const supported = Platform.OS === 'android' && Number(Platform.Version) >= 30;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await getFavouriteQueue(db));
    } finally {
      setLoading(false);
    }
  }, [db]);

  // Focus-driven: the bottom-tab navigator keeps this screen mounted
  // while blurred — intents queued from the deck must show on return.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const applyRows = useMemo(() => rows.filter((row) => row.favourite_target === 1), [rows]);
  const removeRows = useMemo(() => rows.filter((row) => row.favourite_target === 0), [rows]);

  const runBatch = useCallback(
    async (target: boolean) => {
      if (busyTarget !== null) return;
      const all = (target ? applyRows : removeRows).map((row) => row.asset_id);
      if (all.length === 0) return;
      setBusyTarget(target);
      try {
        // Bounded per OS consent request (P5#4; the platform throws above
        // 2000 URIs, which would error the whole queue unrecoverably):
        // loop batches — one dialog each — until drained or declined.
        for (let i = 0; i < all.length; i += FAVOURITE_BATCH_LIMIT) {
          const batch = all.slice(i, i + FAVOURITE_BATCH_LIMIT);
          const result = await applyFavouriteBatch(batch, target);
          if (result.status === 'applied') {
            await markFavouriteBatchApplied(db, batch, target, Date.now());
          } else if (result.status === 'failed') {
            await markFavouriteBatchError(db, batch, target, Date.now());
            Alert.alert(
              'Favourite changes need retry',
              result.error ?? 'Android did not verify them.',
            );
            break;
          } else if (result.status === 'unsupported') {
            Alert.alert(
              'Gallery favourites unavailable',
              'This feature requires Android 11 or later.',
            );
            break;
          } else {
            break; // cancelled — remaining rows stay queued and retryable
          }
        }
        await refresh();
        await refreshFavouriteStates();
      } finally {
        setBusyTarget(null);
      }
    },
    [applyRows, busyTarget, db, refresh, refreshFavouriteStates, removeRows],
  );

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 12 }]}>
      <Text style={styles.intro}>
        Apply queued hearts to the system gallery. Android shows one confirmation for each batch.
      </Text>
      {!supported && (
        <Text style={styles.unsupported}>Gallery favourites require Android 11 or later.</Text>
      )}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.asset_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No favourite changes waiting.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable onPress={() => setViewerId(item.asset_id)}>
              <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" />
            </Pressable>
            <MaterialCommunityIcons
              name={item.favourite_target === 1 ? 'heart-plus' : 'heart-minus'}
              size={24}
              color={colors.fav}
            />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>
                {item.favourite_target === 1 ? 'Add to favourites' : 'Remove from favourites'}
              </Text>
              <Text style={styles.rowMeta}>
                {item.favourite_state === 'error' ? 'Previous attempt needs retry' : 'Waiting'}
              </Text>
            </View>
          </View>
        )}
      />
      {viewerId !== null &&
        (() => {
          const index = rows.findIndex((r) => r.asset_id === viewerId);
          if (index < 0) return null;
          return (
            <PhotoViewer
              items={rows.map((r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at }))}
              initialIndex={index}
              onClose={() => setViewerId(null)}
              onChanged={() => void refresh().catch(() => {})}
            />
          );
        })()}
      <View style={styles.actions}>
        {applyRows.length > 0 && (
          <BigButton
            label={`Apply ${applyRows.length} favourite${applyRows.length === 1 ? '' : 's'}`}
            color={colors.fav}
            disabled={!supported || busyTarget !== null}
            onPress={() => void runBatch(true)}
          />
        )}
        {removeRows.length > 0 && (
          <Pressable
            style={[styles.removeButton, { borderColor: theme.accent }]}
            disabled={!supported || busyTarget !== null}
            onPress={() => void runBatch(false)}
          >
            <Text style={[styles.removeText, { color: theme.accent }]}>
              Remove {removeRows.length} from gallery favourites
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16, paddingTop: 12 },
  intro: { color: colors.textDim, lineHeight: 20, marginBottom: 10 },
  unsupported: { color: colors.cull, marginBottom: 10 },
  list: { gap: 10, paddingBottom: 12, flexGrow: 1 },
  empty: { color: colors.textDim, textAlign: 'center', marginTop: 40 },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: touch.radius,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: 52, height: 52, borderRadius: 9, backgroundColor: colors.surfaceRaised },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.text, fontWeight: '700' },
  rowMeta: { color: colors.textDim, fontSize: 12, marginTop: 3 },
  actions: { gap: 8, paddingTop: 8 },
  removeButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: touch.radius,
  },
  removeText: { fontWeight: '800' },
});
