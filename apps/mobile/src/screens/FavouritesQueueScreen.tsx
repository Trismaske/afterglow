/**
 * Durable Android favourite/unfavourite queue. Each direction is one
 * MediaStore-owned batch confirmation, then every IS_FAVORITE flag is
 * verified before SQLite commits the result. Cancelled and failed work stays
 * visible and retryable across restarts.
 */
import type { StoredMediaKind } from '../lib/mediaIdentity';
import { AnimatedThumb } from '../components/AnimatedThumb';
import { useAnimatedList } from '../components/useAnimatedCells';
import type { AnimatedThumbRow } from '../lib/animatedThumbRow';
import { animatedKindOf } from '../lib/animatedCells';
import type { MotionClipRow } from '../db/store';
import React, { useCallback, useMemo, useState } from 'react';
import { plural } from '../lib/format';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PixelRatio } from 'react-native';
import { OsThumbnail } from '../components/OsThumbnail';
import { thumbBucketPx } from '../lib/thumbnailSize';
const ROW_THUMB_PX = thumbBucketPx(52, PixelRatio.get());
import { Image } from 'expo-image';
import { Icon } from '../components/Icon';
import { useSQLiteContext } from 'expo-sqlite';
import type { PhotoState } from '@afterglow/core';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { invalidateMountedVolumes, mountedVolumeSet } from '../lib/mountedVolumes';
import { resolveSources } from '../lib/sourceCatalog';
import { getPhotoQueueFacts } from '../db/store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {} from '../db/store';
import { applyFavouriteBatch, FAVOURITE_BATCH_LIMIT } from '../lib/favourites';
import { describeFavouriteFailure } from '../lib/favouriteFailures';
import { BigButton } from '../components/BigButton';
import { showToast } from '../lib/toast';
import { colors, radius, space, touch, type, useTheme } from '../theme';
import { useReview } from '../review/ReviewContext';
import {
  decodeFavouriteTarget,
  encodeFavouriteTarget,
  failActions,
  getQueue,
  resolveActions,
  unqueueAction,
} from '../db/actions';
import { QUEUE_REFRESH_FAILED, useQueueRows } from '../components/useQueueRows';
import { withUserWritePriority } from '../lib/writePriority';
import { QueueRemoveChip } from '../components/QueueRemoveChip';
import { useQueueBadges } from '../components/useQueueBadges';
import { StateDots } from '../components/DecisionBadge';

/** The row shape this screen renders (was a store type). */
interface FavouriteQueueRow {
  asset_id: string;
  uri: string;
  /** The image cache version (item 3). */
  image_version: number;
  kind: StoredMediaKind;
  /** What animates the row's thumbnail (phase 6): a GIF by its MIME, a
   * motion photo by its clip. */
  mime_type: string | null;
  motion: MotionClipRow | null;
  taken_at: number;
  /** Capture day; null = honestly undated (m0.8.6 change 5). */
  day: string | null;
  /** The verdict, for the row's inspection dots (F35). */
  photo_state: PhotoState;
  /** 1 = queued to favourite, 0 = queued to un-favourite. */
  favourite_target: number;
  /** 'error' = Android refused this one; still queued, but it needs a
   * retry rather than a first attempt, and the row has to say so. */
  state: string;
}

/** A favourites-queue row's extent along the list (the 52 dp thumb, padding, gap). */
const FAVOURITE_ROW_DP = 76;
const favouriteThumb = (row: FavouriteQueueRow): AnimatedThumbRow => ({
  id: row.asset_id,
  kind: row.kind,
  uri: row.uri,
  version: row.image_version,
  animated: animatedKindOf({
    kind: row.kind,
    mimeType: row.mime_type,
    hasMotion: row.motion !== null,
  }),
  motion: row.motion,
});

export function FavouritesQueueScreen() {
  // P2-2: browse taps navigate to the deck's list mode.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { refreshFavouriteStates } = useReview();
  const { rows, failed, reload } = useQueueRows<FavouriteQueueRow>(
    useCallback(async () => {
      // v18: one action queue; the DIRECTION that used to be a five-value
      // enum is now the action's target.
      // The two scope axes (m0.8.3 reachability; m0.8.7 F18 sources).
      const actions = await getQueue(
        db,
        'favourite',
        await mountedVolumeSet(),
        (await resolveSources(db)).roots ?? null,
      );
      const byId = await getPhotoQueueFacts(
        db,
        actions.map((a) => a.photoId),
      );
      return actions.map((action) => ({
        asset_id: action.photoId,
        uri: byId.get(action.photoId)?.uri ?? '',
        // The photo's CAPTURE time, not when it was queued: the deck's
        // corner renders this as the day and clock the shot was taken.
        taken_at: byId.get(action.photoId)?.takenAt ?? action.queuedAt,
        image_version: byId.get(action.photoId)?.imageVersion ?? 0,
        kind: byId.get(action.photoId)?.kind ?? 'photo',
        mime_type: byId.get(action.photoId)?.mimeType ?? null,
        motion: byId.get(action.photoId)?.motion ?? null,
        day: byId.get(action.photoId)?.day ?? null,
        photo_state: byId.get(action.photoId)?.state ?? 'unreviewed',
        favourite_target: decodeFavouriteTarget(action.target) === false ? 0 : 1,
        state: action.state,
      }));
    }, [db]),
    'favourite',
  );
  const [busyTarget, setBusyTarget] = useState<boolean | null>(null);
  // The rows' thumbnails play their clips while on screen (phase 6).
  const listRows = useMemo(() => rows ?? [], [rows]);
  const dotsFor = useQueueBadges(
    useMemo(() => rows?.map((r) => ({ id: r.asset_id, state: r.photo_state })) ?? null, [rows]),
  );
  const { cells, thumbRows } = useAnimatedList({
    rows: listRows,
    thumbOf: favouriteThumb,
    columns: 1,
    tileDp: FAVOURITE_ROW_DP,
  });
  /** Thumbnail tap opens the deck in list mode over this queue (gate 5). */

  const applyRows = useMemo(() => (rows ?? []).filter((row) => row.favourite_target === 1), [rows]);
  const removeRows = useMemo(
    () => (rows ?? []).filter((row) => row.favourite_target === 0),
    [rows],
  );

  const runBatch = useCallback(
    async (target: boolean) => {
      if (busyTarget !== null) return;
      const renderedRows = target ? applyRows : removeRows;
      const rendered = renderedRows.map((row) => row.asset_id);
      const kindOf = new Map(renderedRows.map((row) => [row.asset_id, row.kind]));
      if (rendered.length === 0) return;
      setBusyTarget(target);
      try {
        // M5/F18 (codex m0.8.7 r1): rendered ∩ fresh two-axis read.
        // useQueueRows deliberately retains rows across a failed
        // refresh, so the render alone can be stale after a source or
        // mount change — the physical MediaStore batch binds to what the
        // user saw AND the current scope still holds, in the CURRENT
        // direction (a photo re-toggled while on screen leaves the
        // batch). Fail closed: no fresh read, no physical write.
        let all: string[];
        try {
          invalidateMountedVolumes();
          const fresh = await getQueue(
            db,
            'favourite',
            await mountedVolumeSet(),
            (await resolveSources(db)).roots ?? null,
          );
          const live = new Set(
            fresh
              .filter((action) => (decodeFavouriteTarget(action.target) === false) !== target)
              .map((action) => action.photoId),
          );
          all = rendered.filter((id) => live.has(id));
        } catch (error) {
          console.warn('[favourites] fresh scope read failed — apply blocked:', String(error));
          Alert.alert(
            'Could not verify the queue',
            'Afterglow could not re-check which items are still in the selected folders. Nothing was changed — try again.',
          );
          return;
        }
        if (all.length === 0) {
          await reload();
          return;
        }
        // Bounded per OS consent request (P5#4; the platform throws above
        // 2000 URIs, which would error the whole queue unrecoverably):
        // loop batches — one dialog each — until drained or declined.
        for (let i = 0; i < all.length; i += FAVOURITE_BATCH_LIMIT) {
          const batch = all.slice(i, i + FAVOURITE_BATCH_LIMIT);
          const result = await applyFavouriteBatch(
            batch.map((id) => {
              const kind = kindOf.get(id);
              // `all` ⊆ rendered, so this cannot miss — and a miss must
              // not dispatch a guessed collection.
              if (!kind) throw new Error(`no stored kind for ${id}`);
              return { id, kind };
            }),
            target,
          );
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
            // Partial success commits the VERIFIED subset (codex m0.8.7
            // r1): the classifier's copy promises "the unconfirmed ones
            // stay queued and retry", so the confirmed rows must resolve
            // — leaving them in error re-applies work Android already
            // verified and falsifies the alert.
            const unverified = new Set(result.unverifiedIds);
            const confirmed =
              result.unverifiedIds.length > 0 && result.unverifiedIds.length < batch.length
                ? batch.filter((id) => !unverified.has(id))
                : [];
            const executed = encodeFavouriteTarget(target);
            if (confirmed.length > 0) {
              try {
                await resolveActions(db, confirmed, 'favourite', Date.now(), executed, executed);
              } catch {
                // The verified subset could not be RECORDED (codex m0.8.7
                // r2): the gallery change is real, but the rows stay
                // queued and would re-apply — the partial-success report
                // below would falsely claim only the unconfirmed retry.
                // Same handling as the all-applied branch: say so, stop.
                Alert.alert(
                  'Applied, but not recorded',
                  `Android confirmed ${plural(confirmed.length, 'favourite change')}, but Afterglow could not record ${confirmed.length === 1 ? 'it' : 'them'} — ${confirmed.length === 1 ? 'it' : 'they'} will retry next time. ${plural(result.unverifiedIds.length, 'photo')} also went unconfirmed and ${result.unverifiedIds.length === 1 ? 'retries' : 'retry'} as well.`,
                );
                break;
              }
            }
            // codex r9: the durable error mark is bookkeeping too — if it
            // rejects, the retry alert must still fire and the run still
            // stop; the row stays 'queued', which retries on the next
            // apply just the same as 'error'.
            await failActions(
              db,
              confirmed.length > 0 ? batch.filter((id) => unverified.has(id)) : batch,
              'favourite',
              executed,
            ).catch(() => {});
            // The three-tier report (Errors_design D4): the partial-
            // success counts from our own verify, then Android verbatim.
            const report = describeFavouriteFailure({
              batchSize: batch.length,
              unverifiedCount: result.unverifiedIds.length || batch.length,
              favourite: target,
              error: result.error,
            });
            Alert.alert(report.title, report.body);
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

  /** Confirmed clear-all (m0.8.7 shared bar): bound to the rendered rows
   * intersected with a fresh scoped read (the M5 rule). Cancelling a
   * queued intent restores the known gallery state — nothing physical
   * runs here. */
  const removeAll = useCallback(async () => {
    try {
      const rendered = new Set((rows ?? []).map((r) => r.asset_id));
      const fresh = (
        await getQueue(
          db,
          'favourite',
          await mountedVolumeSet(),
          (await resolveSources(db)).roots ?? null,
        )
      ).filter((a) => rendered.has(a.photoId));
      for (const action of fresh) {
        await withUserWritePriority(() => unqueueAction(db, action.photoId, 'favourite'));
      }
      await reload();
      await refreshFavouriteStates().catch(() => {});
    } catch (error) {
      console.warn('[favourite] queue clear failed:', String(error));
      Alert.alert('Could not clear the queue', 'The list below shows what actually stands.');
      await reload().catch(() => {});
    }
  }, [db, rows, reload, refreshFavouriteStates]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: 12 }]}>
      <Text style={styles.heading}>Favourite queue</Text>
      <Text style={styles.intro}>
        Apply queued hearts to the system gallery. Android shows one confirmation for each batch.
      </Text>
      {rows !== null && rows.length > 0 ? (
        <View style={styles.chips}>
          {/* The shared removal affordance (m0.8.7): this queue had none.
              Removing a queued intent cancels it — the known gallery
              state stands; nothing is un-favourited by a cancel. */}
          <QueueRemoveChip
            queueLabel="favourite"
            count={rows.length}
            selectedCount={0}
            onRemove={() => void removeAll()}
          />
        </View>
      ) : null}
      {failed && rows !== null ? (
        // codex r9: the reload kept the last rows on a failed read — the
        // list may be stale, and it has to say so.
        <Text style={styles.refreshFailed}>{QUEUE_REFRESH_FAILED}</Text>
      ) : null}
      <FlatList
        data={listRows}
        {...cells.listProps}
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
        renderItem={({ item, index }) => (
          <View style={styles.row}>
            <Pressable
              onPress={() =>
                navigation.navigate('Deck', {
                  list: { source: 'queue', queue: 'favourite' },
                  anchorId: item.asset_id,
                })
              }
            >
              <AnimatedThumb
                row={thumbRows[index]}
                px={ROW_THUMB_PX}
                index={index}
                cells={cells}
                style={styles.thumb}
                markSize={11}
              />
              <StateDots {...dotsFor(item.asset_id)} size={9} style={styles.dots} />
            </Pressable>
            <Icon
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
      <View style={styles.actions}>
        {applyRows.length > 0 && (
          <BigButton
            label={`Apply ${plural(applyRows.length, 'favourite')}`}
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
  // Two dp in: the 52 dp thumbnail then holds the verdict dot and three
  // marks on one row.
  dots: { position: 'absolute', left: 2, right: 2, bottom: 2 },
  heading: { color: colors.text, ...type.title, fontWeight: '800', marginBottom: 2 },
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space.page },
  intro: { color: colors.textDim, ...type.label, marginBottom: 10 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  list: { gap: 10, paddingBottom: 12, flexGrow: 1 },
  empty: { color: colors.textDim, ...type.label, textAlign: 'center', marginTop: 40 },
  // codex r9: quiet stale-rows notice — dim like every read-failure line.
  refreshFailed: { color: colors.textDim, ...type.label, textAlign: 'center', marginBottom: 8 },
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
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.thumb,
    backgroundColor: colors.surfaceRaised,
  },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.text, fontWeight: '700' },
  rowMetaError: { color: colors.cull, fontWeight: '600' },
  rowMeta: { color: colors.textDim, ...type.caption, marginTop: 3 },
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
