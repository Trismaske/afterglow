/**
 * Durable Android favourite/unfavourite queue. Each direction is one
 * MediaStore-owned batch confirmation, then every IS_FAVORITE flag is
 * verified before SQLite commits the result. Cancelled and failed work stays
 * visible and retryable across restarts.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { getPhotoQueueFacts } from '../db/store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {} from '../db/store';
import { applyFavouriteBatch, FAVOURITE_BATCH_LIMIT } from '../lib/favourites';
import { BigButton } from '../components/BigButton';
import { showToast } from '../lib/toast';
import { colors, touch, useTheme } from '../theme';
import { useReview } from '../review/ReviewContext';
import { QueueViewer } from '../components/QueueViewer';
import {
  decodeFavouriteTarget,
  encodeFavouriteTarget,
  failActions,
  getQueue,
  resolveActions,
} from '../db/actions';
import { useQueueRows } from '../components/useQueueRows';

/** The row shape this screen renders (was a store type). */
interface FavouriteQueueRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  /** 1 = queued to favourite, 0 = queued to un-favourite. */
  favourite_target: number;
  /** 'error' = Android refused this one; still queued, but it needs a
   * retry rather than a first attempt, and the row has to say so. */
  state: string;
}

export function FavouritesQueueScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { refreshFavouriteStates } = useReview();
  const { rows, reload } = useQueueRows<FavouriteQueueRow>(
    useCallback(async () => {
      // v18: one action queue; the DIRECTION that used to be a five-value
      // enum is now the action's target.
      const actions = await getQueue(db, 'favourite');
      const byId = await getPhotoQueueFacts(
        db,
        actions.map((a) => a.photoId),
      );
      return actions.map((action) => ({
        asset_id: action.photoId,
        uri: byId.get(action.photoId)?.uri ?? '',
        // The photo's CAPTURE time, not when it was queued: the standard
        // viewer renders this as the day and clock the shot was taken.
        taken_at: byId.get(action.photoId)?.takenAt ?? action.queuedAt,
        favourite_target: decodeFavouriteTarget(action.target) === false ? 0 : 1,
        state: action.state,
      }));
    }, [db]),
  );
  const [busyTarget, setBusyTarget] = useState<boolean | null>(null);
  /** In-app full-screen viewer (gate 5) — thumbnail tap. */
  const [viewerId, setViewerId] = useState<string | null>(null);
  const supported = Platform.OS === 'android' && Number(Platform.Version) >= 30;

  const applyRows = useMemo(() => (rows ?? []).filter((row) => row.favourite_target === 1), [rows]);
  const removeRows = useMemo(
    () => (rows ?? []).filter((row) => row.favourite_target === 0),
    [rows],
  );

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
            // Guarded on the direction we ACTUALLY sent: a photo the user
            // re-toggled while the consent dialog was up must not be
            // recorded as having had the new direction applied.
            const executed = encodeFavouriteTarget(target);
            await resolveActions(db, batch, 'favourite', Date.now(), executed, executed);
          } else if (result.status === 'failed') {
            await failActions(db, batch, 'favourite', encodeFavouriteTarget(target));
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
        await reload();
        await refreshFavouriteStates();
      } finally {
        setBusyTarget(null);
      }
    },
    [applyRows, busyTarget, db, reload, refreshFavouriteStates, removeRows],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: 12 }]}>
      <Text style={styles.heading}>Favourite queue</Text>
      <Text style={styles.intro}>
        Apply queued hearts to the system gallery. Android shows one confirmation for each batch.
      </Text>
      {!supported && (
        <Text style={styles.unsupported}>Gallery favourites require Android 11 or later.</Text>
      )}
      <FlatList
        data={rows ?? []}
        keyExtractor={(row) => row.asset_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          rows !== null ? <Text style={styles.empty}>No favourite changes queued.</Text> : null
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
              <Text style={[styles.rowMeta, item.state === 'error' && styles.rowMetaError]}>
                {item.state === 'error' ? 'Failed — will retry on the next apply' : 'Waiting'}
              </Text>
            </View>
          </View>
        )}
      />
      <QueueViewer
        rows={rows}
        viewerId={viewerId}
        toItem={(r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at })}
        onClose={() => setViewerId(null)}
        onChanged={() => void reload().catch(() => {})}
      />
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
  heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 2 },
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
  intro: { color: colors.textDim, fontSize: 14, lineHeight: 20, marginBottom: 10 },
  unsupported: { color: colors.cull, marginBottom: 10 },
  list: { gap: 10, paddingBottom: 12, flexGrow: 1 },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
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
  rowMetaError: { color: colors.cull, fontWeight: '600' },
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
