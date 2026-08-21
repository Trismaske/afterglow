/**
 * Photo-source picker (m0.3.1; volume-qualified since m0.8.3 D4): choose
 * which (volume, folder) sources feed scope counts, review, edit
 * detection, and progress rows. Directories come from MediaStore buckets
 * (see sourceCatalog.ts) — one row per (volume, dir), so DCIM/Camera on
 * the SD card is its own row wearing the "SD card" tag. Selection is
 * recursive within a volume — a chosen folder includes its subfolders,
 * shown as "included" rows. A selected root whose volume is not mounted
 * renders greyed as "not mounted" (unmounted ≠ deleted, D5): it stays in
 * the setting and comes back with the card.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { useSQLiteContext } from 'expo-sqlite';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import {
  invalidateSourceCatalog,
  listSourceDirs,
  resolveSources,
  type SourceDir,
} from '../lib/sourceCatalog';
import {
  isUnderAnyRoot,
  PHOTO_SOURCES_KEY,
  rootKey,
  serializePhotoSourceSetting,
  volumeTag,
  type PhotoSourceSetting,
  type SourceRoot,
} from '../lib/sources';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import { countTrackedPhotos } from '../db/store';
import { applyGroupingSettingChange } from '../db/store';
import { requestRescan, supersedeScan } from '../scan/scanRunner';
import { useReview } from '../review/ReviewContext';
import { showToast } from '../lib/toast';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'SourcePicker'>;

interface Row extends SourceDir {
  /** Persisted root that no longer has a bucket (still deselectable). */
  missing?: boolean;
  /** Persisted root whose volume is not currently mounted (D5): greyed
   * "not mounted", never "no photos" — the data is intact on the card. */
  unmounted?: boolean;
}

export function SourcePickerScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refresh, refreshScoped } = useReview();
  const [rows, setRows] = useState<Row[] | null>(null);
  /** The catalog failure's own message, not a bare flag: an unreadable
   * album is only ONE of its causes (the native module can be absent, or
   * the all-volumes-or-none contract can reject), and a screen that names
   * the wrong cause sends the reader after the wrong fix. */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  /** The user has toggled since the last load — a reload would clobber
   * the unsaved selection (the loader sets it from the PERSISTED
   * setting), so the foreground refresh below stands down. */
  const dirtyRef = useRef(false);
  // Foreground return re-reads the catalog (final cycle O6): the volume
  // tags and unmounted rows must reflect a card swapped while the picker
  // sat open in the background — unless that would cost unsaved input
  // (stale tags beat lost toggles; saving or reopening refreshes).
  useExternalRefresh(() => {
    if (!dirtyRef.current) setLoadTick((t) => t + 1);
  });
  const [allFolders, setAllFolders] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // While the apply/rollback chain runs, EVERY exit is blocked (header
  // back, hardware back, gestures): leaving mid-apply would let the
  // cached old-scope queue keep rendering photos the new scope excludes
  // before the strict refresh lands.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (savingRef.current) event.preventDefault();
    });
    return unsubscribe;
  }, [navigation]);
  /** The persisted state at load — the rollback target if applying a new
   * scope fails after it committed. `unset` preserves the DYNAMIC default
   * (rolling back to a resolved snapshot would pin it). */
  const previousSettingRef = useRef<
    { kind: 'set'; setting: PhotoSourceSetting } | { kind: 'unset' } | null
  >(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoadFailed(null);
        let dirs: SourceDir[];
        let current: Awaited<ReturnType<typeof resolveSources>>;
        let mountedList: readonly string[] | null;
        try {
          [dirs, current, mountedList] = await Promise.all([
            listSourceDirs(true),
            resolveSources(db),
            // The REAL mounted-volume provider (codex phase-3): works
            // from API 24, unlike the generations API this used to lean
            // on. Null = unknowable — absent rows fall back to the
            // "no photos found" wording rather than claiming "not
            // mounted" without evidence.
            mountedVolumeSet(),
          ]);
        } catch (error) {
          // A transient unreadable album fails the catalog (fail-closed
          // contract) — surface a retry instead of a stuck loader.
          console.warn('[sources] catalog unavailable:', String(error));
          if (!cancelled) setLoadFailed(error instanceof Error ? error.message : String(error));
          return;
        }
        if (cancelled) return;
        const mounted = mountedList === null ? null : new Set(mountedList);
        previousSettingRef.current = current.isDefault
          ? { kind: 'unset' }
          : { kind: 'set', setting: current.setting };
        const catalog: Row[] = [...dirs];
        const chosen = new Set<string>();
        if (current.setting.mode === 'all') {
          setAllFolders(true);
        } else {
          setAllFolders(false);
          for (const root of current.setting.dirs) {
            // Map persisted roots onto catalog rows by (volume, dir);
            // keep absent roots visible — unmounted ones greyed (D5),
            // vanished ones deselectable.
            const row = catalog.find((r) => rootKey(r) === rootKey(root));
            if (row) chosen.add(rootKey(row));
            else {
              const unmounted = mounted !== null && !mounted.has(root.volume);
              // An unmounted root still CARRIES ITS COUNT (§5: all three
              // naming surfaces carry counts) — the tracked rows are the
              // population MediaStore cannot see right now.
              const trackedCount = unmounted ? await countTrackedPhotos(db, [root]) : 0;
              catalog.push({
                volume: root.volume,
                dir: root.dir,
                albumIds: [],
                photoCount: trackedCount,
                missing: !unmounted,
                unmounted,
              });
              chosen.add(rootKey(root));
            }
          }
        }
        catalog.sort((a, b) => a.dir.localeCompare(b.dir) || a.volume.localeCompare(b.volume));
        setRows(catalog);
        setSelected(chosen);
        dirtyRef.current = false;
      })();
      return () => {
        cancelled = true;
      };
      // loadTick re-runs this on Retry.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, loadTick]),
  );

  const toggleAll = useCallback(() => {
    dirtyRef.current = true;
    setAllFolders(true);
    setSelected(new Set());
  }, []);

  const toggleRow = useCallback((row: Row) => {
    dirtyRef.current = true;
    setAllFolders(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rootKey(row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const totalPhotos = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.photoCount, 0), [rows]);

  const valid = allFolders || selected.size > 0;

  const save = useCallback(async () => {
    if (!valid || saving) return;
    // Every selected root costs SQL bind variables in the volume-
    // qualified source predicate (up to 4 per root in the widest query),
    // against SQLite's 999-variable compatibility floor — an unbounded
    // selection would make scoped reads FAIL after saving (final cycle
    // Q7). Explicit over implicit: refuse with the fix named.
    if (!allFolders && selected.size > 200) {
      Alert.alert(
        'Too many folders',
        `${selected.size} folders selected — the limit is 200. Select fewer folders, or use "All folders".`,
      );
      return;
    }
    setSaving(true);
    savingRef.current = true;
    try {
      const chosenRoots: SourceRoot[] = (rows ?? [])
        .filter((row) => selected.has(rootKey(row)))
        .map((row) => ({ volume: row.volume, dir: row.dir }))
        .sort((a, b) => a.dir.localeCompare(b.dir) || a.volume.localeCompare(b.volume));
      const setting: PhotoSourceSetting = allFolders
        ? { mode: 'all' }
        : { mode: 'dirs', dirs: chosenRoots };
      // Supersede the in-flight scan FIRST: an old-source window
      // completing during the apply below could repopulate a group with
      // newly excluded photos and have the scoped refresh render it.
      supersedeScan();
      // A plain durable setting write (v22): groups re-form freely, so
      // nothing needs resetting — the forced rescan below rewrites every
      // assignment under the new scope.
      try {
        await applyGroupingSettingChange(
          db,
          PHOTO_SOURCES_KEY,
          serializePhotoSourceSetting(setting),
        );
      } catch {
        // Nothing committed — but supersedeScan already fenced the active
        // run, so restart scanning under the (unchanged) durable setting.
        void requestRescan(db);
        showToast('Could not save the photo source — try again');
        return;
      }
      invalidateSourceCatalog();
      // FAIL CLOSED before leaving: the queue reads are source-scoped and
      // must drop excluded photos NOW (the queued rescan lands later). If
      // applying the new scope fails, ROLL BACK the committed setting —
      // header/back navigation stays enabled, so a half-applied narrower
      // scope must never outlive this screen.
      try {
        const resolved = await resolveSources(db);
        // STRICT: read under the just-resolved roots — the general
        // refresh's fail-open fallback could silently keep the old scope.
        await refreshScoped(resolved.roots ?? null);
      } catch {
        // A FAILED rollback must say so — the new source is then durable
        // while the rendered queue may still show the old scope. An
        // unset previous state rolls back to UNSET (the dynamic default
        // must stay dynamic). The queue re-renders only AFTER the
        // rollback landed — a refresh before it would resolve and paint
        // the rejected source.
        const previous = previousSettingRef.current;
        let restored = false;
        if (previous) {
          restored = await applyGroupingSettingChange(
            db,
            PHOTO_SOURCES_KEY,
            previous.kind === 'unset' ? null : serializePhotoSourceSetting(previous.setting),
          ).then(
            () => true,
            () => false,
          );
          invalidateSourceCatalog();
        }
        // Rebuild under whatever setting is durable now — the superseded
        // scan was stopped above either way.
        void requestRescan(db);
        if (!restored) {
          // The NEW source stays durable: install and render IT (the
          // failed refreshScoped reverted the fallback to the previous
          // scope, which no longer matches anything persisted).
          try {
            const durable = await resolveSources(db);
            await refreshScoped(durable.roots ?? null);
          } catch {
            // The harsh midway toast below already directs a reopen.
          }
        }
        // Re-rendering the restored scope is PART of the rollback: a
        // competing refresh may have painted the rejected scope, and a
        // swallowed failure here would leave the queue disagreeing with
        // the restored setting while back navigation stays enabled.
        const rerendered = restored
          ? await refresh().then(
              () => true,
              () => false,
            )
          : false;
        showToast(
          restored && rerendered
            ? 'Could not apply the new source — selection unchanged'
            : restored
              ? 'Source restored, but the queue could not refresh — reopen this screen to retry'
              : 'Source change failed midway — reopen this screen to verify your selection',
        );
        return;
      }
      // The scan reads the source at run start: rescan over the new
      // selection (an in-flight run finishes its old buckets first).
      void requestRescan(db);
      // Release the exit guard BEFORE leaving — beforeRemove would
      // otherwise cancel our own successful goBack.
      savingRef.current = false;
      setSaving(false);
      navigation.goBack();
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [valid, saving, allFolders, selected, rows, db, navigation, refresh, refreshScoped]);

  const roots = useMemo<SourceRoot[]>(
    () =>
      (rows ?? [])
        .filter((row) => selected.has(rootKey(row)))
        .map((row) => ({ volume: row.volume, dir: row.dir })),
    [rows, selected],
  );

  return (
    <View style={styles.root}>
      <Modal visible={saving} transparent animationType="fade">
        {/* Full-screen touch shield while the source apply/rollback chain
            runs — paired with the beforeRemove navigation block. */}
        <View style={styles.applyingOverlay}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={styles.applyingText}>Applying photo source…</Text>
        </View>
      </Modal>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 16 }]}
      >
        <Text style={styles.hint}>
          Reviews only look at photos in the selected folders. Selecting a folder includes its
          subfolders.
        </Text>

        <Pressable
          style={[styles.row, allFolders && { borderColor: theme.accent }]}
          onPress={toggleAll}
        >
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>All folders</Text>
            <Text style={styles.rowHint}>every photo on the device</Text>
          </View>
          <Text style={styles.rowCount}>{totalPhotos}</Text>
          <View style={styles.check}>
            {allFolders && <MaterialCommunityIcons name="check" size={22} color={theme.accent} />}
          </View>
        </Pressable>

        {rows === null && loadFailed === null && (
          <Text style={styles.loading}>Listing photo folders…</Text>
        )}
        {loadFailed !== null && (
          <View style={styles.loadFailed}>
            <Text style={styles.loading}>
              Could not read the photo folders.{'\n'}
              {loadFailed}
            </Text>
            <Pressable style={styles.retryButton} onPress={() => setLoadTick((t) => t + 1)}>
              <Text style={[styles.retryText, { color: theme.accent }]}>Retry</Text>
            </Pressable>
          </View>
        )}
        {rows !== null && rows.length === 0 && (
          <Text style={styles.loading}>No photo folders found.</Text>
        )}

        {rows?.map((row) => {
          const isSelected = !allFolders && selected.has(rootKey(row));
          const included = !allFolders && !isSelected && isUnderAnyRoot(row.volume, row.dir, roots);
          const tag = volumeTag(row.volume);
          return (
            <Pressable
              key={rootKey(row)}
              style={[
                styles.row,
                isSelected && { borderColor: theme.accent },
                row.unmounted && styles.rowUnmounted,
              ]}
              onPress={() => toggleRow(row)}
            >
              <View style={styles.rowBody}>
                <View style={styles.rowTitleLine}>
                  <Text style={[styles.rowTitle, row.unmounted && styles.rowTitleUnmounted]}>
                    {row.dir}
                  </Text>
                  {tag !== null && <Text style={styles.rowTag}>{tag}</Text>}
                </View>
                {row.unmounted ? (
                  <Text style={styles.rowHint}>not mounted</Text>
                ) : row.missing ? (
                  <Text style={styles.rowHint}>no photos found — tap to unselect</Text>
                ) : included ? (
                  <Text style={[styles.rowIncluded, { color: theme.accent }]}>
                    included via a parent folder
                  </Text>
                ) : null}
              </View>
              {!row.missing && <Text style={styles.rowCount}>{row.photoCount}</Text>}
              <View style={styles.check}>
                {isSelected ? (
                  <MaterialCommunityIcons name="check" size={22} color={theme.accent} />
                ) : included ? (
                  <MaterialCommunityIcons name="circle-small" size={22} color={theme.accent} />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <BigButton
          label={saving ? 'Saving…' : 'Use this source'}
          color={theme.accent}
          textColor={theme.onAccent}
          disabled={!valid || saving || rows === null}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadFailed: { gap: 10, alignItems: 'flex-start' },
  retryButton: { minHeight: 44, justifyContent: 'center' },
  retryText: { fontSize: 15, fontWeight: '700' },
  applyingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  applyingText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 10 },
  hint: { color: colors.textDim, fontSize: 14, lineHeight: 20, marginBottom: 4 },
  loading: { color: colors.textDim, fontSize: 14, padding: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowBody: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  // Unmounted = greyed, never gone (D5): the row names the state and
  // keeps its place; the data returns with the card.
  rowUnmounted: { opacity: 0.55 },
  rowTitleUnmounted: { color: colors.textDim },
  rowTag: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  rowHint: { color: colors.textDim, fontSize: 12 },
  rowIncluded: { fontSize: 12 },
  rowCount: { color: colors.textDim, fontSize: 13 },
  check: { width: 22, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 8 },
});
