/**
 * The deck's DETAILS OVERLAY (m0.9 phase 2, P2-6 — the retired
 * viewer's facts panel and StateEditorSheet's fact lines, reborn as
 * stage chrome): the metadata corner is the Settings-curated GLANCE;
 * tapping it opens this semi-opaque overlay over the whole stage with
 * the COMPLETE truth — every verbose action-history sentence
 * (favourite direction, edit/share history, the FULL album paths, the
 * superseded-move line, the five F21 "rides along" strings, the
 * not-related count) regardless of any Settings toggle. Exempt from
 * the eye and the phase-7 Overlay rows by design (M21: the detail
 * surface is always complete). Phase 7 adds the file facts (extension,
 * exact pixels, size) here.
 *
 * Read discipline (F30, ported): only a photo CHANGE clears the
 * lines; a re-read of the same photo keeps them mounted and dims to
 * `stale`. A failed read keeps the last-read lines dim with a
 * tap-to-retry — writing surfaces (the deck's own controls) stay
 * elsewhere, so nothing here can act on stale truth.
 *
 * ALWAYS-MOUNTED wrapper, prop-gated (the stage's stable-view-tree
 * rule): visibility is opacity + pointerEvents, never a mount under an
 * active gesture stream. A tap anywhere on the overlay closes it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { getPhotoFacts, type PhotoFacts } from '../db/store';
import { isInShareQueue } from '../db/shareStore';
import { decodeOrganizeTarget } from '../db/actions';
import { classifyPhotoState } from '../lib/progress';
import { formatBytes, plural } from '../lib/format';
import { animatedKindOf } from '../lib/animatedCells';
import { isSdPhoto } from '../lib/photoBadges';
import {
  folderAnnotation,
  formatDuration,
  megapixelsOf,
  resolutionClassOf,
} from '../lib/stageMeta';
import { DECISION_GLYPHS, KIND_CHIP_LABELS } from './DecisionBadge';
import { VERDICT_META } from './progress/stateMeta';
import { colors, scrim, type } from '../theme';

type FactLine = {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  text: string;
};

/** The FILE facts (m0.9 phase 7, F31 + F33): complete here whatever the
 * Overlay rows show on the stage, every unknown NAMED (M17 — the stage
 * omits, this surface says). */
function buildFileLines(facts: PhotoFacts): FactLine[] {
  const lines: FactLine[] = [];
  const kind = animatedKindOf({
    kind: facts.kind,
    mimeType: facts.mime_type,
    hasMotion: facts.motion_offset !== null && facts.motion_length !== null,
  });
  const kindWord =
    kind === null ? 'Photo' : kind === 'motion' ? 'Motion photo' : KIND_CHIP_LABELS[kind];
  lines.push({
    icon: kind === null ? 'image-outline' : DECISION_GLYPHS[kind],
    text: facts.display_name ? `${kindWord} · ${facts.display_name}` : `${kindWord} · name unknown`,
  });
  // Not READ YET is named apart from unknown: before the per-file read
  // completes for this version, the columns may hold a former
  // version's values (codex round 5).
  const read = Number(facts.facts_complete) === 1;
  const sized =
    read && facts.width !== null && facts.height !== null && facts.width > 0 && facts.height > 0;
  lines.push({
    icon: 'aspect-ratio',
    text: sized
      ? `${facts.width} × ${facts.height} pixels · ${
          kind === 'video'
            ? resolutionClassOf(facts.width as number, facts.height as number)
            : megapixelsOf(facts.width as number, facts.height as number)
        }`
      : read
        ? 'Size in pixels unknown'
        : 'Size in pixels not read yet',
  });
  if (kind === 'video' || kind === 'motion')
    lines.push({
      icon: 'timer-outline',
      text:
        read && facts.duration_ms !== null && facts.duration_ms > 0
          ? `${kind === 'motion' ? 'Clip duration' : 'Duration'} ${formatDuration(facts.duration_ms)}`
          : read
            ? 'Duration unknown'
            : 'Duration not read yet',
    });
  lines.push({
    icon: 'file-outline',
    text:
      facts.size_bytes !== null && facts.size_bytes > 0
        ? formatBytes(facts.size_bytes)
        : 'File size unknown',
  });
  const sd = isSdPhoto(facts.asset_id);
  const folder = folderAnnotation(facts.uri, sd);
  const where =
    folder === null && !sd
      ? 'In the camera roll'
      : `In ${folder ?? 'the camera roll'}${sd ? ', on the SD card' : ''}`;
  lines.push({ icon: sd ? 'micro-sd' : 'folder-outline', text: where });
  return lines;
}

/** The retired viewer's fact-sentence builder, verbatim. */
function buildFactLines(facts: PhotoFacts, shareQueued: boolean): FactLine[] {
  const lines: FactLine[] = [];
  // SUSPENDED (codex r6): a staged cull or trashed photo keeps its
  // action rows, but it is in no queue (STATE_MODEL.md — the badges
  // demote to carried for the same reason). The lines describe the
  // retained intent instead of claiming live queue membership.
  const suspended = facts.state === 'culled' || facts.state === 'trashed';
  const queued = (liveText: string, retainedText: string) => (suspended ? retainedText : liveText);
  // Favourite is DIRECTIONAL (STATE_MODEL.md): the queued row wins the
  // line while one waits — including a queued removal, under which the
  // carried heart must not show — else the resolved apply carries it.
  if (facts.favourite_queued === 1)
    lines.push({
      icon: 'heart-outline',
      text: queued(
        'Favourite queued for gallery confirmation.',
        'Favourite request rides along — resumes if the photo is un-staged.',
      ),
    });
  else if (facts.favourite_queued === 0)
    lines.push({
      icon: 'heart-off-outline',
      text: queued(
        'Favourite removal queued.',
        'Favourite removal rides along — resumes if the photo is un-staged.',
      ),
    });
  else if (facts.favourite_applied === 1)
    lines.push({ icon: 'heart', text: 'Favourited in your gallery.' });
  if (facts.needs_edit === 1)
    // Edit stays IN its queue on a staged cull (m0.8.7, F21 point 1).
    lines.push({ icon: 'pencil-outline', text: 'In the edit queue.' });
  if (facts.edit_completed_at != null)
    lines.push({ icon: 'pencil', text: 'Was edited via the edit queue.' });
  if (shareQueued)
    // Share stays IN its queue on a staged cull (m0.8.7, F21 point 1).
    lines.push({ icon: 'share-variant', text: 'In the share queue.' });
  else if (facts.share_carried === 1)
    lines.push({ icon: 'share-variant', text: 'Was shared from the share queue.' });
  // The organize lines carry the FULL album path: the promise that it
  // lives one tap away, kept here after the viewer retired. A
  // target-less queue row (m0.8.2 F6) keeps the pathless copy.
  const organizeSuperseded = facts.organize_applied_at != null && facts.organize_queued === 1;
  const pendingAlbum = decodeOrganizeTarget(facts.organize_target)?.path ?? null;
  const appliedAlbum = decodeOrganizeTarget(facts.organize_applied_target)?.path ?? null;
  if (facts.organize_applied_at != null) {
    const movedOnce = appliedAlbum ? `Moved to ${appliedAlbum} once` : 'Moved to an album once';
    const newerMove = pendingAlbum ? `a newer move to ${pendingAlbum}` : 'a newer move';
    lines.push({
      icon: organizeSuperseded ? 'folder-clock' : 'folder-move',
      text: organizeSuperseded
        ? queued(
            `${movedOnce}, but ${newerMove} is still pending — the shown album is superseded until it applies.`,
            `${movedOnce}, and ${newerMove} rides along — back in the queue if the photo is un-staged.`,
          )
        : appliedAlbum
          ? `Moved to ${appliedAlbum}.`
          : 'Moved to an album.',
    });
  } else if (facts.organize_queued === 1)
    lines.push({
      icon: 'folder-clock',
      text: pendingAlbum
        ? queued(
            `Album move queued → ${pendingAlbum}`,
            `Album move to ${pendingAlbum} rides along — back in the queue if the photo is un-staged.`,
          )
        : queued(
            'Album move queued.',
            'Album move rides along — back in the queue if the photo is un-staged.',
          ),
    });
  // time_attached is deliberately NOT surfaced (m0.8.2): internal scan
  // quality the user cannot act on.
  if (facts.not_related_count > 0)
    lines.push({
      icon: 'image-move',
      text: `You marked it not related to ${plural(facts.not_related_count, 'photo')} — it never groups with them.`,
    });
  return lines;
}

export function DeckDetailsOverlay({
  open,
  photoId,
  header,
  onClose,
}: {
  open: boolean;
  /** The CURRENT stage photo — a change clears and re-reads (F30). */
  photoId: string | null;
  /** The corner's own day·clock line, repeated as the overlay title. */
  header: string;
  onClose: () => void;
}) {
  const db = useSQLiteContext();
  // undefined = loading, null = never tracked.
  const [facts, setFacts] = useState<PhotoFacts | null | undefined>(undefined);
  const [shareQueued, setShareQueued] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || photoId === null) return;
    let cancelled = false;
    // F30: only a photo CHANGE clears; a same-photo re-read dims.
    if (lastIdRef.current !== photoId) {
      lastIdRef.current = photoId;
      setFacts(undefined);
      setShareQueued(false);
    }
    setStale(true);
    void Promise.all([getPhotoFacts(db, photoId), isInShareQueue(db, photoId)]).then(
      ([f, share]) => {
        if (cancelled) return;
        setFacts(f);
        setShareQueued(share);
        setFailed(false);
        setStale(false);
      },
      (error: unknown) => {
        console.warn('[deck] details read failed:', String(error));
        if (cancelled) return;
        setFailed(true);
        setStale(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, open, photoId, tick]);

  const meta = facts ? VERDICT_META[classifyPhotoState({ state: facts.state })] : null;
  const lines = facts ? [...buildFileLines(facts), ...buildFactLines(facts, shareQueued)] : [];
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: open ? 1 : 0 }]}
      pointerEvents={open ? 'auto' : 'none'}
    >
      {open && (
        <Pressable style={styles.sheet} onPress={onClose} accessibilityLabel="Close photo details">
          {/* Scrolls when the lines outgrow the stage (the file facts
              plus an action-rich history on the floor phone — codex
              round 3): a tap still closes, a drag reads on. */}
          <ScrollView style={styles.scroll} contentContainerStyle={styles.lines}>
            <Text style={styles.header}>{header}</Text>
            {meta && facts && (
              <View style={styles.stateRow}>
                <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                <Text style={styles.stateText}>{meta.label}</Text>
              </View>
            )}
            {lines.map((line) => (
              <View key={line.icon + line.text} style={styles.line}>
                <MaterialCommunityIcons name={line.icon} size={16} color={colors.textDim} />
                <Text style={[styles.lineText, (stale || failed) && styles.staleText]}>
                  {line.text}
                </Text>
              </View>
            ))}
            {facts !== undefined &&
              facts !== null &&
              buildFactLines(facts, shareQueued).length === 0 && (
                <Text style={styles.quietText}>No queued or carried actions.</Text>
              )}
            {facts === null && (
              <Text style={styles.quietText}>
                Not analyzed yet — it enters review when the scan reaches it.
              </Text>
            )}
            {facts === undefined && !failed && <Text style={styles.quietText}>Loading…</Text>}
            {failed && (
              <Pressable onPress={() => setTick((t) => t + 1)} hitSlop={8}>
                <Text style={styles.retryText}>
                  Could not read this photo's details just now — tap to retry.
                </Text>
              </Pressable>
            )}
          </ScrollView>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 10 },
  sheet: {
    flex: 1,
    backgroundColor: scrim.sheet,
    padding: 16,
    gap: 8,
    justifyContent: 'flex-end',
    paddingBottom: 24,
  },
  scroll: { flexGrow: 0 },
  lines: { gap: 8 },
  header: { color: colors.text, ...type.body, fontWeight: '700' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 4 },
  stateText: { color: colors.text, ...type.label, fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  lineText: { color: colors.textDim, ...type.label, flex: 1 },
  staleText: { opacity: 0.5 },
  quietText: { color: colors.textDim, ...type.label },
  retryText: { color: colors.text, ...type.label, textDecorationLine: 'underline' },
});
