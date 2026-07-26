/**
 * Shared progress page body (m0.4 stage 3): state summary (tappable
 * filters) + filtered photo grid + per-photo state editor sheet. Used by
 * both the Day progress screen (scope = one local day, plus a "Review
 * this day" CTA) and the Global progress screen (scope = the Home
 * screen's selected rolling range) — same accounting, same components.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import {
  computeBreakdown,
  reviewedOf,
  reviewedPct,
  type EffectiveState,
  type ProgressFilter,
  type StateBreakdown,
} from '../../lib/progress';
import { countUndatedAlive, getStateCountsInScope, type PhotoScope } from '../../db/store';
import { UNDATED_DAY_KEY } from '../../lib/dates';
import { countPhotosInRange } from '../../lib/media';
import { resolveSources } from '../../lib/sourceCatalog';
import { StateProgressBar } from '../StateProgressBar';
import { colors, touch, useTheme } from '../../theme';
import { stateMetaFor, STATE_ORDER } from './stateMeta';
import { PhotoStateGrid, type GridPhoto } from './PhotoStateGrid';
import { PhotoViewer, type ViewerItem } from '../PhotoViewer';

interface ResolvedSrc {
  roots: string[] | null;
  albumIds: string[] | null;
}

function countOf(b: StateBreakdown, state: EffectiveState): number {
  switch (state) {
    case 'unreviewed':
      return b.unreviewed;
    case 'in_group':
      return b.inGroups;
    case 'to_edit':
      return b.toEdit;
    case 'staged':
      return b.staged;
    case 'done':
      return b.done;
  }
}

export function ProgressView({
  heading,
  scope,
  startMs,
  endMs,
  renderCta,
}: {
  heading: string;
  /** DB-side scope (day column for Day progress, taken_at range otherwise). */
  scope: PhotoScope;
  /** MediaStore-side range (ms). */
  startMs: number;
  endMs: number;
  /** Optional CTA (Day progress: "Review this day"). */
  renderCta?: (breakdown: StateBreakdown) => React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { accent } = useTheme();
  const stateMeta = useMemo(() => stateMetaFor(accent), [accent]);
  const [src, setSrc] = useState<ResolvedSrc | null>(null);
  const [data, setData] = useState<{ breakdown: StateBreakdown; trashed: number } | null>(null);
  const [filter, setFilter] = useState<ProgressFilter>('all');
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const scopeKey = 'day' in scope ? `d:${scope.day}` : `r:${scope.startMs}:${scope.endMs}`;

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        // Respect the photo-source folder filter (m0.3.1) on both sides.
        // FAIL CLOSED: a resolution failure keeps the previously rendered
        // scope (or stays loading before any success) — null's meaning is
        // "all folders", which would silently broaden a narrowed source.
        let sources: Awaited<ReturnType<typeof resolveSources>>;
        try {
          sources = await resolveSources(db);
        } catch (error) {
          console.warn('[progress] source resolution failed — scope kept:', String(error));
          return;
        }
        const roots = sources.roots ?? null;
        const albumIds = sources.albumIds ?? null;
        // The Unknown-day pseudo-day cannot be counted via MediaStore
        // (no DATE_TAKEN query) — the tracked rows ARE its population.
        const undatedScope = 'day' in scope && scope.day === UNDATED_DAY_KEY;
        const [msTotal, counts] = await Promise.all([
          undatedScope
            ? countUndatedAlive(db, roots)
            : countPhotosInRange(startMs, endMs, albumIds).catch(() => 0),
          getStateCountsInScope(db, scope, roots),
        ]);
        if (cancelled) return;
        setSrc({ roots, albumIds });
        setData({ breakdown: computeBreakdown(msTotal, counts), trashed: counts.trashed });
      })();
      return () => {
        cancelled = true;
      };
      // scopeKey stands in for the scope object's identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, scopeKey, startMs, endMs, refreshTick]),
  );

  const toggleFilter = useCallback((state: EffectiveState) => {
    setFilter((current) => (current === state ? 'all' : state));
  }, []);

  const onChanged = useCallback(() => setRefreshTick((t) => t + 1), []);

  const header = useMemo(() => {
    if (!data) return <View />;
    const b = data.breakdown;
    const reviewed = reviewedOf(b);
    const pct = reviewedPct(b);
    return (
      <View style={styles.header}>
        <Text style={styles.title}>{heading}</Text>
        <Text style={styles.subtitle}>
          {b.total === 0
            ? 'No photos here.'
            : reviewed === b.total
              ? `All ${b.total} photos reviewed`
              : `${reviewed} of ${b.total} photos reviewed · ${pct}%`}
        </Text>

        <StateProgressBar
          height={14}
          total={b.total}
          segments={[
            { count: b.done, color: colors.keep },
            { count: b.toEdit, color: colors.edit },
            { count: b.staged, color: colors.cull },
            { count: b.inGroups, color: accent },
            // unreviewed = the empty track
          ]}
        />

        <View style={styles.rows}>
          {STATE_ORDER.map((state) => {
            const meta = stateMeta[state];
            const active = filter === state;
            return (
              <Pressable
                key={state}
                style={[
                  styles.stateRow,
                  active && [styles.stateRowActive, { borderColor: accent }],
                ]}
                onPress={() => toggleFilter(state)}
              >
                <View style={[styles.swatch, { backgroundColor: meta.color }]} />
                <View style={styles.stateBody}>
                  <Text style={styles.stateLabel}>{meta.label}</Text>
                  <Text style={styles.stateHint}>{meta.hint}</Text>
                </View>
                <Text style={styles.stateCount}>{countOf(b, state)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.footnote}>
          Tap a state to filter the photos below — tap again for all states. Tap a photo to view it
          and change its state.
        </Text>

        {renderCta?.(b)}

        <Text style={styles.gridLabel}>
          {filter === 'all' ? 'Photos · all states' : `Photos · ${stateMeta[filter].label}`}
          {filter === 'done' && data.trashed > 0
            ? `  (${data.trashed} trashed — files gone, not shown)`
            : ''}
        </Text>
      </View>
    );
  }, [data, heading, filter, toggleFilter, renderCta, accent, stateMeta]);

  if (!data || !src) {
    return (
      <View style={[styles.loadingRoot]}>
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  return (
    <>
      <PhotoStateGrid
        scope={scope}
        startMs={startMs}
        endMs={endMs}
        roots={src.roots}
        albumIds={src.albumIds}
        filter={filter}
        refreshKey={refreshTick}
        header={header}
        bottomInset={insets.bottom}
        onPhotoPress={(_photo, siblings, index) =>
          setViewer({
            items: siblings.map((g) => ({ id: g.id, uri: g.uri, takenAt: g.takenAt })),
            index,
          })
        }
      />
      {viewer && (
        <PhotoViewer
          items={viewer.items}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loadingRoot: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { color: colors.textDim, fontSize: 15 },
  header: { paddingHorizontal: 2, paddingTop: 16, paddingBottom: 12, gap: 14 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 15, marginTop: -8 },
  rows: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: touch.radius - 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  stateRowActive: { backgroundColor: colors.surfaceRaised },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  stateBody: { flex: 1 },
  stateLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  stateHint: { color: colors.textDim, fontSize: 12 },
  stateCount: { color: colors.text, fontSize: 18, fontWeight: '800' },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: -6 },
  gridLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
});
