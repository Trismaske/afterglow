/**
 * Durable Android favourite/unfavourite queue. Each direction is one
 * MediaStore-owned batch confirmation, then every IS_FAVORITE flag is
 * verified before SQLite commits the result. Cancelled and failed work stays
 * visible and retryable across restarts.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { mountedVolumeSet } from '../lib/mountedVolumes';
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
import { QUEUE_REFRESH_FAILED, useQueueRows } from '../components/useQueueRows';

/** The row shape this screen renders (was a store type). */
interface FavouriteQueueRow {
  asset_id: string;
  uri: string;
  taken_at: number;
  /** Capture day; null = honestly undated (m0.8.6 change 5). */
  day: string | null;
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
  const { rows, failed, reload } = useQueueRows<FavouriteQueueRow>(
    useCallback(async () => {
      // v18: one action queue; the DIRECTION that used to be a five-value
      // enum is now the action's target.
      const actions = await getQueue(db, 'favourite', await mountedVolumeSet());
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
        day: byId.get(action.photoId)?.day ?? null,
        favourite_target: decodeFavouriteTarget(action.target) === false ? 0 : 1,
        state: action.state,
      }));
    }, [db]),
  );
  const [busyTarget, setBusyTarget] = useState<boolean | null>(null);
  /** In-app full-screen viewer (gate 5) — thumbnail tap. */
  const [viewerId, setViewerId] = useState<string | null>(null);

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
            try {
              await resolveActions(db, batch, 'favourite', Date.now(), executed, executed);
            } catch {
              // codex r9: Android has ALREADY applied this batch — a
              // bookkeeping rejection here used to escape as an unhandled
              // rejection, leaving the rows durably queued with no word
              // to the user; the next run re-applies to Android (harmless
              // but confusing, so it must not be silent). Stop the run —
              // further batches would hit the same store — and let the
              // reload below show the durable truth.
              Alert.alert(
                'Applied, but not recorded',
                'Applied in your gallery, but Afterglow could not record it — it will retry next time.',
              );
              break;
            }
          } else if (result.status === 'failed') {
            // codex r9: the durable error mark is bookkeeping too — if it
            // rejects, the retry alert must still fire and the run still
            // stop; the row stays 'queued', which retries on the next
            // apply just the same as 'error'.
            await failActions(db, batch, 'favourite', encodeFavouriteTarget(target)).catch(
              () => {},
            );
            Alert.alert(
              'Favourite changes need retry',
              result.error ?? 'Android did not verify them.',
            );
            break;
          } else if (result.status === 'unsupported') {
            Alert.alert(
              'Gallery favourites unavailable',
              "Afterglow's media module is not available in this build, so nothing was changed. The queued hearts are still waiting.",
            );
            break;
          } else {
            break; // cancelled — remaining rows stay queued and retryable
          }
        }
        await reload();
        // codex r9: reload never rejects, but the badge refresh can — it
        // must not escape the void handler (the durable rows are already
        // committed; the next focus re-reads them anyway).
        await refreshFavouriteStates().catch(() => {});
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
      {failed && rows !== null ? (
        // codex r9: the reload kept the last rows on a failed read — the
        // list may be stale, and it has to say so.
        <Text style={styles.refreshFailed}>{QUEUE_REFRESH_FAILED}</Text>
      ) : null}
      <FlatList
        data={rows ?? []}
        keyExtractor={(row) => row.asset_id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          rows !== null ? (
            <Text style={styles.empty}>No favourite changes queued.</Text>
          ) : failed ? (
            // codex r9: an initial reload failure would have loaded
            // forever — the empty-state area says what happened.
            <Text style={styles.empty}>{QUEUE_REFRESH_FAILED}</Text>
          ) : null
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
        toItem={(r) => ({ id: r.asset_id, uri: r.uri, takenAt: r.taken_at, day: r.day })}
        onClose={() => setViewerId(null)}
        onChanged={() => void reload().catch(() => {})}
      />
      <View style={styles.actions}>
        {applyRows.length > 0 && (
          <BigButton
            label={`Apply ${applyRows.length} favourite${applyRows.length === 1 ? '' : 's'}`}
            color={colors.fav}
            disabled={busyTarget !== null}
            onPress={() => void runBatch(true)}
          />
        )}
        {removeRows.length > 0 && (
          <Pressable
            style={[styles.removeButton, { borderColor: theme.accent }]}
            disabled={busyTarget !== null}
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
  list: { gap: 10, paddingBottom: 12, flexGrow: 1 },
  empty: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 40 },
  // codex r9: quiet stale-rows notice — dim like every read-failure line.
  refreshFailed: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 8 },
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
