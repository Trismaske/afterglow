/**
 * THE album picker (m0.8.2): one bottom-sheet component for choosing an
 * organize target — extracted from three drifting copies (deck, queue
 * screen) when F6 moved album choice into the organize queue. Owns its
 * own catalog load (native volume-aware album list, fail-closed to what
 * the query proved, primary volume only), the search-or-create input
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
import { newAlbumPath } from '../db/organizeStore';
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
  const [albums, setAlbums] = useState<VolumeAlbum[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setName('');
    // Fail-closed (C#8): a catalog error never widens choices — the
    // picker simply shows what the native query proved.
    void listImageAlbumsCached().then(
      (catalog) => {
        if (cancelled) return;
        setAlbums(
          catalog
            .filter((a) => a.volumeName === PRIMARY_VOLUME)
            .sort((a, b) => b.photoCount - a.photoCount),
        );
      },
      () => {
        if (!cancelled) setAlbums([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const newPath = useMemo(() => newAlbumPath(name), [name]);
  // The one input searches AND names: typing filters the catalog live;
  // Create makes a new album from the same text (m0.8.1 tester ask).
  const visibleAlbums = useMemo(() => {
    const query = name.trim().toLowerCase();
    if (!query) return albums;
    return albums.filter(
      (a) =>
        a.displayName.toLowerCase().includes(query) || a.relativePath.toLowerCase().includes(query),
    );
  }, [albums, name]);
  /** Display names carried by more than one bucket — those rows get
   * their relativePath as a subtitle so they stay distinguishable. */
  const collidingNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of albums) seen.set(a.displayName, (seen.get(a.displayName) ?? 0) + 1);
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
              <Text style={styles.albumEmpty}>
                {albums.length === 0
                  ? 'No albums found — create one below.'
                  : 'No albums match — Create makes a new one.'}
              </Text>
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
