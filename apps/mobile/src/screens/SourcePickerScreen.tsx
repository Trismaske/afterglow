/**
 * Photo-source picker (m0.3.1): choose which device folders feed scope
 * counts, sessions, edit detection, and progress rows. Directories come
 * from MediaStore buckets (see sourceCatalog.ts); selection is recursive
 * — a chosen folder includes its subfolders, shown as "included" rows.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
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
  serializePhotoSourceSetting,
  type PhotoSourceSetting,
} from '../lib/sources';
import { applyGroupingSettingChange } from '../db/store';
import { requestRescan, supersedeScan } from '../scan/scanRunner';
import { useReview } from '../review/ReviewContext';
import { showToast } from '../lib/toast';
import { BigButton } from '../components/BigButton';
import { colors, touch, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'SourcePicker'>;

interface Row extends SourceDir {
  /** Persisted dir that no longer has a bucket (still deselectable). */
  missing?: boolean;
}

export function SourcePickerScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const db = useSQLiteContext();
  const { refresh, refreshScoped } = useReview();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [allFolders, setAllFolders] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // While the apply/rollback transaction chain runs, EVERY exit is
  // blocked (header back, hardware back, gestures): leaving mid-apply
  // would let the cached old-scope queue take decisions that freeze
  // stale membership before the strict refresh lands.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (savingRef.current) event.preventDefault();
    });
    return unsubscribe;
  }, [navigation]);
  /** The persisted state at load — the rollback target if applying a new
   * scope fails after it committed. `unset` preserves the DYNAMIC default
   * (rolling back to a resolved snapshot would freeze it). */
  const previousSettingRef = useRef<
    { kind: 'set'; setting: PhotoSourceSetting } | { kind: 'unset' } | null
  >(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [dirs, current] = await Promise.all([listSourceDirs(true), resolveSources(db)]);
        if (cancelled) return;
        previousSettingRef.current = current.isDefault
          ? { kind: 'unset' }
          : { kind: 'set', setting: current.setting };
        const catalog: Row[] = [...dirs];
        const chosen = new Set<string>();
        if (current.setting.mode === 'all') {
          setAllFolders(true);
        } else {
          setAllFolders(false);
          for (const dir of current.setting.dirs) {
            // Map persisted dirs onto catalog rows case-insensitively;
            // keep vanished dirs visible so they can be unselected.
            const row = catalog.find((r) => r.dir.toLowerCase() === dir.toLowerCase());
            if (row) chosen.add(row.dir);
            else {
              catalog.push({ dir, albumIds: [], photoCount: 0, missing: true });
              chosen.add(dir);
            }
          }
        }
        catalog.sort((a, b) => a.dir.localeCompare(b.dir));
        setRows(catalog);
        setSelected(chosen);
      })();
      return () => {
        cancelled = true;
      };
    }, [db]),
  );

  const toggleAll = useCallback(() => {
    setAllFolders(true);
    setSelected(new Set());
  }, []);

  const toggleDir = useCallback((dir: string) => {
    setAllFolders(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  const totalPhotos = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.photoCount, 0), [rows]);

  const valid = allFolders || selected.size > 0;

  const save = useCallback(async () => {
    if (!valid || saving) return;
    setSaving(true);
    savingRef.current = true;
    try {
      const setting: PhotoSourceSetting = allFolders
        ? { mode: 'all' }
        : { mode: 'dirs', dirs: [...selected].sort((a, b) => a.localeCompare(b)) };
      // Supersede the in-flight scan FIRST: an old-source window
      // completing during the apply below could repopulate a group with
      // newly excluded photos and have the scoped refresh render it.
      supersedeScan();
      // Setting + unfrozen-assignment reset commit ATOMICALLY — a process
      // death between them would leave the next launch rendering old
      // assignments under the new scope.
      await applyGroupingSettingChange(db, PHOTO_SOURCES_KEY, serializePhotoSourceSetting(setting));
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
      navigation.goBack();
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [valid, saving, allFolders, selected, db, navigation, refresh, refreshScoped]);

  const roots = useMemo(() => [...selected], [selected]);

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

        {rows === null && <Text style={styles.loading}>Listing photo folders…</Text>}
        {rows !== null && rows.length === 0 && (
          <Text style={styles.loading}>No photo folders found.</Text>
        )}

        {rows?.map((row) => {
          const isSelected = !allFolders && selected.has(row.dir);
          const included = !allFolders && !isSelected && isUnderAnyRoot(row.dir, roots);
          return (
            <Pressable
              key={row.dir}
              style={[styles.row, isSelected && { borderColor: theme.accent }]}
              onPress={() => toggleDir(row.dir)}
            >
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{row.dir}</Text>
                {row.missing ? (
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
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowHint: { color: colors.textDim, fontSize: 12 },
  rowIncluded: { fontSize: 12 },
  rowCount: { color: colors.textDim, fontSize: 13 },
  check: { width: 22, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 8 },
});
