import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MediaItem } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { useSession } from '../session/SessionContext';
import { useSQLiteContext } from 'expo-sqlite';
import { getStagedCulls, restoreCarriedCull, type StagedCullRow } from '../db/store';
import { BigButton } from '../components/BigButton';
import { ReDecideSheet, type DecidedState } from '../components/ReDecideSheet';
import { showToast } from '../lib/toast';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'CullList'>;

/**
 * The staged cull list. Tapping a photo opens the m0.5 re-decide sheet
 * (keep / to edit / stays culled) — the last stop where any decision is
 * still reversible. The ONE confirm button below is the only path in the
 * app that deletes anything; on Android 11+ the system dialog moves the
 * batch to recoverable system trash (retention is gallery-controlled).
 */
export function CullListScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { session, restoring, version, confirmStagedCulls, needsEdit, redecide } = useSession();
  // Home-card entry is queue MAINTENANCE: it returns Home afterwards and
  // must never funnel an unfinished session into the Summary/finish flow.
  const fromHome = route.params?.fromHome === true;
  const db = useSQLiteContext();
  const [busy, setBusy] = useState(false);
  const [redecideItem, setRedecideItem] = useState<MediaItem | null>(null);
  // null = the queue query hasn't resolved — an empty array must mean a
  // truly empty queue, or the footer's Finish/Done button could navigate
  // away during the loading frame before staged rows appear.
  const [globalRows, setGlobalRows] = useState<StagedCullRow[] | null>(null);
  // A failed query must stay distinct from an empty queue: rows remain
  // null (footer disabled) so Finish/Done can never fire while durable
  // culls might exist unseen.
  const [loadFailed, setLoadFailed] = useState(false);
  const loading = globalRows === null;
  const systemTrashSupported = Platform.OS === 'android' && Number(Platform.Version) >= 30;

  // P4#1: the DURABLE GLOBAL cull queue is the confirmation truth — it
  // includes carried culls from replaced sessions, which the active
  // snapshot cannot see.
  useEffect(() => {
    let cancelled = false;
    getStagedCulls(db).then(
      (rows) => {
        if (!cancelled) {
          setLoadFailed(false);
          setGlobalRows(rows);
        }
      },
      () => {
        if (!cancelled) {
          // Also invalidate rows from an EARLIER successful load — stale
          // tiles must not stay interactive (a tap could re-stage a
          // photo whose decision just changed).
          setGlobalRows(null);
          setLoadFailed(true);
          Alert.alert('Could not load the cull queue', 'Leave and reopen this screen to retry.');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, version, busy]);

  const staged: MediaItem[] = useMemo(
    () =>
      (globalRows ?? []).map((row) => ({
        id: row.asset_id,
        uri: row.uri,
        timestamp: row.taken_at,
        kind: 'photo' as const,
      })),
    [globalRows],
  );

  const runConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The session context owns the durable trash lifecycle; it loops the
      // whole global queue in bounded batches (one system dialog each) and
      // mirrors verified outcomes into the active snapshot.
      const result = await confirmStagedCulls();
      if (result.status === 'applied' && result.remaining === 0) {
        // The session-ending flow lands on the session Summary; Home-card
        // maintenance returns Home (also: Summary renders blank without a
        // session).
        if (session && !fromHome) navigation.replace('Summary');
        else navigation.goBack();
      } else if (result.status === 'cancelled') {
        // Earlier applied batches may hold verified moves AND
        // inconclusive verifications — the aggregate must surface both:
        // "untouched" is only honest when nothing was attempted
        // ambiguously.
        const ambiguity =
          result.unresolvedCount > 0
            ? ` ${result.unresolvedCount} could not be verified and may already be in the system trash.`
            : '';
        Alert.alert(
          result.trashedCount > 0 ? 'Partly moved to trash' : 'Nothing confirmed moved',
          result.trashedCount > 0
            ? `${result.trashedCount} photo${result.trashedCount === 1 ? '' : 's'} moved before the system confirmation was cancelled. ${result.remaining} remain staged.${ambiguity}`
            : result.unresolvedCount > 0
              ? `The system confirmation was cancelled. ${result.unresolvedCount} earlier photo${result.unresolvedCount === 1 ? '' : 's'} could not be verified — they remain staged and may already be in the system trash.`
              : 'The system confirmation was cancelled. Your photos are untouched and still staged.',
        );
      } else if (result.status === 'unsupported') {
        Alert.alert(
          'System trash unavailable',
          'Afterglow does not permanently delete photos. Moving culls to trash requires Android 11 or later.',
        );
      } else if (result.status === 'failed') {
        // A later batch failing must not hide earlier verified moves —
        // nor the ambiguity of members whose verification stayed unknown
        // (a post-dispatch failure may have trashed them already).
        const progress =
          result.trashedCount > 0
            ? `${result.trashedCount} photo${result.trashedCount === 1 ? '' : 's'} were already moved to trash; ${result.remaining} remain staged. `
            : '';
        const ambiguity =
          result.unresolvedCount > 0
            ? ` ${result.unresolvedCount} photo${result.unresolvedCount === 1 ? '' : 's'} could not be verified and may already be in the system trash.`
            : '';
        Alert.alert(
          result.trashedCount > 0 ? 'Partly moved to trash' : 'Could not move photos to trash',
          progress +
            (result.error ??
              'Android MediaStore returned an unexpected error. Your culls remain staged.') +
            ambiguity,
        );
      } else {
        // Dialog applied but photos could not be verified as trashed —
        // conservative: they stay staged rather than claiming success.
        Alert.alert(
          'Could not verify the move',
          `${result.remaining} photo${result.remaining === 1 ? '' : 's'} could not be confirmed as trashed and remain staged.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy, confirmStagedCulls, navigation, session, fromHome]);

  const onConfirmPress = useCallback(() => {
    // Mid-restore, confirming could trash a member the restoring snapshot
    // still holds as culled — the reconcile would find no session and the
    // stale snapshot would install afterwards.
    if (restoring) {
      showToast('Still loading your session — try again in a moment');
      return;
    }
    if (staged.length === 0) {
      if (session && !fromHome) navigation.replace('Summary');
      else navigation.goBack();
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
  }, [staged.length, navigation, runConfirm, session, fromHome, restoring]);

  const inSession = useCallback(
    (id: string) => {
      if (!session) return false;
      try {
        session.getState(id);
        return true;
      } catch {
        return false;
      }
    },
    [session],
  );

  // The sheet must show the SESSION's current verdict — a durable
  // 'culled' row can coexist with a 'kept' snapshot state (e.g. an
  // inconclusive edited-copy cull) and the redecide chips act on the
  // session's truth, so a hard-coded 'culled' would invert the taps.
  const currentOf = useCallback(
    (id: string): DecidedState => {
      try {
        const state = session?.getState(id);
        if (state === 'culled') return 'culled';
        return needsEdit(id) ? 'to_edit' : 'kept';
      } catch {
        return 'culled';
      }
    },
    [session, needsEdit],
  );

  const restoreCarried = useCallback(
    (item: MediaItem) => {
      Alert.alert(
        'Carried cull',
        'This photo was staged in an earlier session. Restore it to unreviewed (it will be drawn again), or keep it staged?',
        [
          { text: 'Keep staged', style: 'cancel' },
          {
            text: 'Restore to unreviewed',
            onPress: () =>
              void restoreCarriedCull(db, item.id, Date.now())
                .then(() => getStagedCulls(db))
                .then(setGlobalRows),
          },
        ],
      );
    },
    [db],
  );

  const onTilePress = useCallback(
    (item: MediaItem) => {
      // Mid-restore, membership is unknown: acting now could restore an
      // ACTIVE member as carried and desync the restoring snapshot.
      if (restoring) {
        showToast('Still loading your session — try again in a moment');
        return;
      }
      if (inSession(item.id)) {
        void (async () => {
          // Heal the divergence an interrupted edited-copy cull can
          // leave (durable row culled, snapshot still kept): mirror the
          // staging into the session BEFORE the sheet opens, so every
          // chip acts on consistent state — Keep then truly unstages
          // the durable row (a flag-only change would leave it culled).
          try {
            if (session!.getState(item.id) !== 'culled') await redecide(item.id, 'cull');
          } catch {
            // leave the sheet to the session's current view
          }
          setRedecideItem(item);
        })();
      } else restoreCarried(item);
    },
    [inSession, restoreCarried, session, redecide, restoring],
  );

  const renderItem = useCallback(
    ({ item }: { item: MediaItem }) => (
      <Pressable style={styles.tile} onPress={() => onTilePress(item)} disabled={busy}>
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
    [busy, onTilePress],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.title}>Cull list</Text>
      <Text style={styles.subtitle}>
        {loadFailed
          ? 'Could not load the cull queue.'
          : loading
            ? 'Loading…'
            : !systemTrashSupported && staged.length > 0
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
          loading ? null : (
            <Text style={styles.emptyText}>Everything you reviewed is a keeper.</Text>
          )
        }
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={
            busy
              ? 'Moving to trash…'
              : loading
                ? 'Loading…'
                : staged.length === 0
                  ? session && !fromHome
                    ? 'Finish session'
                    : 'Done'
                  : `Trash ${staged.length} photo${staged.length === 1 ? '' : 's'}`
          }
          color={staged.length === 0 ? colors.keep : colors.cull}
          disabled={busy || loading || (!systemTrashSupported && staged.length > 0)}
          onPress={onConfirmPress}
        />
      </View>
      {redecideItem && (
        <ReDecideSheet
          item={redecideItem}
          current={currentOf(redecideItem.id)}
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
