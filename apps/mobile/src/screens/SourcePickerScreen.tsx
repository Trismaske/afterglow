/**
 * Photo-source picker (m0.3.1): choose which device folders feed scope
 * counts, sessions, edit detection, and progress rows. Directories come
 * from MediaStore buckets (see sourceCatalog.ts); selection is recursive
 * — a chosen folder includes its subfolders, shown as "included" rows.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { setSetting } from '../db/store';
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
  const [rows, setRows] = useState<Row[] | null>(null);
  const [allFolders, setAllFolders] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [dirs, current] = await Promise.all([listSourceDirs(true), resolveSources(db)]);
        if (cancelled) return;
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
    try {
      const setting: PhotoSourceSetting = allFolders
        ? { mode: 'all' }
        : { mode: 'dirs', dirs: [...selected].sort((a, b) => a.localeCompare(b)) };
      await setSetting(db, PHOTO_SOURCES_KEY, serializePhotoSourceSetting(setting));
      invalidateSourceCatalog();
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  }, [valid, saving, allFolders, selected, db, navigation]);

  const roots = useMemo(() => [...selected], [selected]);

  return (
    <View style={styles.root}>
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
