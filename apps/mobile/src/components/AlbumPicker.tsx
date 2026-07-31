/**
 * THE album picker (m0.8.2): one bottom-sheet component for choosing an
 * organize target — extracted from three drifting copies (deck, queue
 * screen) when F6 moved album choice into the organize queue. Owns its
 * own catalog load (native volume-aware album list, primary volume only,
 * with loading / failed / proven-empty kept DISTINCT — an outage renders
 * its own line plus a retry, never "No albums found", which would invite
 * duplicate albums), the search-or-create input
 * (typing filters live; Create makes `Pictures/<name>/` from the same
 * text), and the duplicate-name rule: two MediaStore buckets can share a
 * displayName (observed: two "Receipts" folders), so any colliding row
 * shows its relativePath beneath the name — rows must never be
 * indistinguishable while targeting different paths.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { VolumeAlbum } from '../../modules/media-store-actions';
import { listImageAlbumsCached } from '../lib/sourceCatalog';
import { PRIMARY_VOLUME } from '../lib/mediaIdentity';
import { androidAllowsImagesIn, newAlbumPath } from '../db/organizeStore';
import { colors, touch } from '../theme';

export function AlbumPicker({
  visible,
  title = 'Move to album',
  onChoose,
  onClose,
}: {
  visible: boolean;
  title?: string;
  /** Called with the chosen/created relativePath (trailing slash kept). */
  onChoose: (relativePath: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  /** null = load in flight; [] only ever means the query PROVED empty. */
  const [albums, setAlbums] = useState<VolumeAlbum[] | null>(null);
  /** The catalog load failed — its own state, never conflated with an
   * empty catalog (an outage reading "No albums found — create one
   * below" invites duplicates). */
  const [failed, setFailed] = useState(false);
  /** Bumped by Retry to re-run the catalog load. */
  const [loadNonce, setLoadNonce] = useState(0);
  const [name, setName] = useState('');

  // The search text resets when the sheet OPENS — not on a retry, which
  // must keep whatever the user typed.
  useEffect(() => {
    if (visible) setName('');
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setAlbums(null);
    setFailed(false);
    // Fail-closed (C#8): a catalog error never widens choices — the
    // picker shows what the native query proved, and a failure says so
    // (errors are not cached, so Retry really re-queries).
    void listImageAlbumsCached().then(
      (catalog) => {
        if (cancelled) return;
        setAlbums(
          catalog
            // Primary volume only (cross-volume moves are out of scope),
            // and only where Android permits an image to live — offering
            // Downloads and then refusing it after an OS consent tap is
            // the defect m0.8.4's acceptance pass found. The refusal
            // itself is still explained if one slips through: this is a
            // convenience filter, not the authority (organizeStore).
            .filter((a) => a.volumeName === PRIMARY_VOLUME && androidAllowsImagesIn(a.relativePath))
            .sort((a, b) => b.photoCount - a.photoCount),
        );
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, loadNonce]);

  const newPath = useMemo(() => newAlbumPath(name), [name]);
  // The one input searches AND names: typing filters the catalog live;
  // Create makes a new album from the same text (m0.8.1 tester ask).
  const visibleAlbums = useMemo(() => {
    const loaded = albums ?? [];
    const query = name.trim().toLowerCase();
    if (!query) return loaded;
    return loaded.filter(
      (a) =>
        a.displayName.toLowerCase().includes(query) || a.relativePath.toLowerCase().includes(query),
    );
  }, [albums, name]);
  /** Display names carried by more than one bucket — those rows get
   * their relativePath as a subtitle so they stay distinguishable. */
  const collidingNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of albums ?? []) seen.set(a.displayName, (seen.get(a.displayName) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
  }, [albums]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <FlatList
            data={visibleAlbums}
            keyExtractor={(a) => `${a.volumeName}:${a.bucketId}`}
            style={{ flexGrow: 0, maxHeight: 320 }}
            renderItem={({ item }) => (
              <Pressable style={styles.albumRow} onPress={() => onChoose(item.relativePath)}>
                <MaterialCommunityIcons name="folder-image" size={20} color={colors.textDim} />
                <View style={styles.albumBody}>
                  <Text style={styles.albumName}>{item.displayName}</Text>
                  {collidingNames.has(item.displayName) && (
                    <Text style={styles.albumPath} numberOfLines={1}>
                      {item.relativePath}
                    </Text>
                  )}
                </View>
                <Text style={styles.albumCount}>{item.photoCount}</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              failed ? (
                // Failure is its own state — search and Create above/below
                // stay usable, and Retry re-runs the catalog load.
                <View style={styles.catalogFailed}>
                  <Text style={styles.albumEmpty}>Could not read your albums just now.</Text>
                  <Pressable style={styles.button} onPress={() => setLoadNonce((n) => n + 1)}>
                    <Text style={styles.buttonText}>Retry</Text>
                  </Pressable>
                </View>
              ) : albums === null ? (
                <Text style={styles.albumEmpty}>Loading albums…</Text>
              ) : (
                <Text style={styles.albumEmpty}>
                  {albums.length === 0
                    ? 'No albums found — create one below.'
                    : 'No albums match — Create makes a new one.'}
                </Text>
              )
            }
          />
          <View style={styles.newRow}>
            <TextInput
              style={styles.newInput}
              placeholder="Search or new album name"
              placeholderTextColor={colors.textDim}
              value={name}
              onChangeText={setName}
            />
            <Pressable
              style={[styles.button, !newPath && styles.disabled]}
              disabled={!newPath}
              onPress={() => newPath && onChoose(newPath)}
            >
              <Text style={styles.buttonText}>Create</Text>
            </Pressable>
          </View>
          <Pressable style={styles.button} onPress={onClose}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: touch.radius,
    borderTopRightRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  albumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  albumBody: { flex: 1, gap: 1 },
  albumName: { color: colors.text, fontSize: 15 },
  albumPath: { color: colors.textDim, fontSize: 12 },
  albumCount: { color: colors.textDim, fontSize: 13 },
  albumEmpty: { color: colors.textDim, fontSize: 14, paddingVertical: 12 },
  catalogFailed: { alignItems: 'flex-start', gap: 2, paddingBottom: 10 },
  newRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  newInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
