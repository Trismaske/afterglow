import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { clusterByGap } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import {
  customRange,
  labelForDayKey,
  recentDayKeys,
  rangeOfDayKey,
  todayRange,
  yesterdayRange,
  type DateRange,
} from '../lib/dates';
import { countPhotosInRange, loadPhotosInRange, type LoadedPhoto } from '../lib/media';
import { countToEdit, getDaySummaries, getStatesForAssets } from '../db/store';
import { useSession, CULL_GROUP_GAP_MS } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { StateProgressBar } from '../components/StateProgressBar';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Scope = 'today' | 'yesterday' | 'custom';

const RECENT_DAYS = 7;

interface DayRow {
  day: string;
  label: string;
  /** All photos taken that day (MediaStore + trashed rows). */
  total: number;
  /** done + trashed. */
  done: number;
  toEdit: number;
  staged: number;
}

interface LoadedRange {
  /** Photos still needing review (not yet converged to to_edit/done/trashed). */
  reviewable: LoadedPhoto[];
  /** Photos in this range already handled in previous sessions. */
  handled: number;
}

export function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const sessionCtx = useSession();
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo'],
  });

  const [scope, setScope] = useState<Scope>('today');
  const [customFrom, setCustomFrom] = useState<Date>(new Date());
  const [customTo, setCustomTo] = useState<Date>(new Date());
  const [pickerFor, setPickerFor] = useState<'from' | 'to' | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<LoadedRange | null>(null);
  const [hasResumable, setHasResumable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [editCount, setEditCount] = useState(0);
  const [dayRows, setDayRows] = useState<DayRow[] | null>(null);

  const range: DateRange = useMemo(() => {
    if (scope === 'today') return todayRange(new Date());
    if (scope === 'yesterday') return yesterdayRange(new Date());
    return customRange(customFrom, customTo);
  }, [scope, customFrom, customTo]);

  // Is there a persisted session to resume? (session may not be loaded yet)
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (sessionCtx.session) {
          setHasResumable(true);
          return;
        }
        const resumed = await sessionCtx.resumeSession();
        if (!cancelled) setHasResumable(resumed);
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionCtx.version]),
  );

  // Edit-queue badge + recent-days progress, refreshed on focus.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const toEdit = await countToEdit(db);
        if (cancelled) return;
        setEditCount(toEdit);

        const keys = recentDayKeys(RECENT_DAYS);
        const summaries = await getDaySummaries(db, keys[keys.length - 1]);
        const rows: DayRow[] = [];
        for (const day of keys) {
          const dbRow = summaries.get(day);
          let msTotal = 0;
          if (permission?.granted) {
            const r = rangeOfDayKey(day);
            msTotal = await countPhotosInRange(r.startMs, r.endMs).catch(() => 0);
          }
          // Trashed photos are gone from MediaStore, so the day's true
          // total is MediaStore + trashed rows (DB `done` includes them).
          const total = msTotal + (dbRow?.trashed ?? 0);
          if (cancelled) return;
          if (total === 0) continue;
          rows.push({
            day,
            label: labelForDayKey(day),
            total,
            done: dbRow?.done ?? 0,
            toEdit: dbRow?.toEdit ?? 0,
            staged: dbRow?.staged ?? 0,
          });
        }
        if (!cancelled) setDayRows(rows);
      })();
      return () => {
        cancelled = true;
      };
    }, [db, permission?.granted]),
  );

  // Load photos + previously-handled filter whenever the range changes.
  useFocusEffect(
    useCallback(() => {
      if (!permission?.granted) return;
      let cancelled = false;
      setLoading(true);
      setLoaded(null);
      (async () => {
        try {
          const photos = await loadPhotosInRange(range.startMs, range.endMs);
          const states = await getStatesForAssets(
            db,
            photos.map((p) => p.item.id),
          );
          const reviewable: LoadedPhoto[] = [];
          let handled = 0;
          for (const photo of photos) {
            const state = states.get(photo.item.id);
            // Converged states stay converged; interim states (unreviewed /
            // kept / culled from an abandoned session) get re-reviewed.
            if (state === 'to_edit' || state === 'done' || state === 'trashed') handled++;
            else reviewable.push(photo);
          }
          if (!cancelled) setLoaded({ reviewable, handled });
        } catch {
          if (!cancelled) setLoaded({ reviewable: [], handled: 0 });
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [db, permission?.granted, range.startMs, range.endMs]),
  );

  const counts = useMemo(() => {
    if (!loaded) return null;
    const clusters = clusterByGap(
      loaded.reviewable.map((p) => p.item),
      { gapMs: CULL_GROUP_GAP_MS },
    );
    const groups = clusters.filter((c) => c.items.length >= 2);
    return {
      photos: loaded.reviewable.length,
      handled: loaded.handled,
      groups: groups.length,
      singles: clusters.length - groups.length,
    };
  }, [loaded]);

  const onPickerChange = useCallback(
    (event: DateTimePickerEvent, date?: Date) => {
      const which = pickerFor;
      setPickerFor(null);
      if (event.type !== 'set' || !date || !which) return;
      if (which === 'from') setCustomFrom(date);
      else setCustomTo(date);
    },
    [pickerFor],
  );

  const startReview = useCallback(async () => {
    if (!loaded || loaded.reviewable.length === 0 || starting) return;
    const begin = async () => {
      setStarting(true);
      try {
        await sessionCtx.startSession(range.label, range.startMs, range.endMs, loaded.reviewable);
        navigation.navigate('Groups');
      } finally {
        setStarting(false);
      }
    };
    if (hasResumable) {
      Alert.alert(
        'Replace unfinished session?',
        'Starting a new session discards the unfinished one. Nothing gets deleted either way.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Start new', style: 'destructive', onPress: () => void begin() },
        ],
      );
    } else {
      await begin();
    }
  }, [loaded, starting, hasResumable, sessionCtx, range, navigation]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <Text style={styles.title}>Afterglow Companion</Text>
      <Text style={styles.subtitle}>Clear today's photos down to the keepers.</Text>

      {!permission?.granted && (
        <View style={styles.card}>
          <Text style={styles.cardText}>
            Afterglow needs access to your photos to review them. Nothing is ever deleted
            without your explicit confirmation.
          </Text>
          <BigButton
            label={permission?.canAskAgain === false ? 'Enable photo access in Settings' : 'Allow photo access'}
            color={colors.accent}
            textColor="#1a1205"
            onPress={() => void requestPermission()}
          />
        </View>
      )}

      {hasResumable && sessionCtx.session && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Unfinished session — {sessionCtx.label}</Text>
          <Text style={styles.cardText}>
            {(() => {
              const s = sessionCtx.session.summary();
              return `${s.total - s.unreviewed} of ${s.total} photos reviewed`;
            })()}
          </Text>
          <BigButton
            label="Resume review"
            color={colors.accent}
            textColor="#1a1205"
            onPress={() => navigation.navigate('Groups')}
          />
        </View>
      )}

      <Pressable style={styles.editQueueRow} onPress={() => navigation.navigate('EditQueue')}>
        <Text style={styles.editQueueIcon}>✎</Text>
        <View style={styles.editQueueBody}>
          <Text style={styles.editQueueTitle}>Edit queue</Text>
          <Text style={styles.editQueueHint}>
            {editCount === 0
              ? 'No keepers waiting for edits'
              : `${editCount} keeper${editCount === 1 ? '' : 's'} waiting for edits`}
          </Text>
        </View>
        {editCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{editCount}</Text>
          </View>
        )}
      </Pressable>

      <Text style={styles.sectionLabel}>Review scope</Text>
      <View style={styles.scopeRow}>
        {(
          [
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['custom', 'Custom'],
          ] as const
        ).map(([key, title]) => (
          <Pressable
            key={key}
            onPress={() => setScope(key)}
            style={[styles.scopeChip, scope === key && styles.scopeChipActive]}
          >
            <Text style={[styles.scopeChipText, scope === key && styles.scopeChipTextActive]}>
              {title}
            </Text>
          </Pressable>
        ))}
      </View>

      {scope === 'custom' && (
        <View style={styles.customRow}>
          <Pressable style={styles.dateField} onPress={() => setPickerFor('from')}>
            <Text style={styles.dateFieldLabel}>From</Text>
            <Text style={styles.dateFieldValue}>{customFrom.toLocaleDateString()}</Text>
          </Pressable>
          <Pressable style={styles.dateField} onPress={() => setPickerFor('to')}>
            <Text style={styles.dateFieldLabel}>To</Text>
            <Text style={styles.dateFieldValue}>{customTo.toLocaleDateString()}</Text>
          </Pressable>
        </View>
      )}

      {pickerFor && (
        <DateTimePicker
          value={pickerFor === 'from' ? customFrom : customTo}
          mode="date"
          onChange={onPickerChange}
        />
      )}

      {permission?.granted && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{range.label}</Text>
          {loading && <Text style={styles.cardText}>Counting photos…</Text>}
          {!loading && counts && (
            <Text style={styles.cardText}>
              {counts.photos === 0
                ? counts.handled > 0
                  ? `All ${counts.handled} photos in this range are already handled ✦`
                  : 'No photos in this range.'
                : `${counts.photos} to review · ${counts.groups} cull groups · ${counts.singles} singles` +
                  (counts.handled > 0 ? ` · ${counts.handled} already handled` : '')}
            </Text>
          )}
          <BigButton
            label={starting ? 'Starting…' : 'Start culling'}
            color={colors.keep}
            disabled={loading || starting || !counts || counts.photos === 0}
            onPress={() => void startReview()}
          />
        </View>
      )}

      {permission?.granted && dayRows && dayRows.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Recent days</Text>
          {dayRows.map((row) => {
            const pct = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
            return (
              <Pressable
                key={row.day}
                style={styles.dayRow}
                onPress={() => navigation.navigate('DayProgress', { day: row.day })}
              >
                <View style={styles.dayRowHeader}>
                  <Text style={styles.dayRowTitle}>{row.label}</Text>
                  <Text style={styles.dayRowPct}>
                    {row.done === row.total ? 'done ✦' : `${row.done}/${row.total} · ${pct}%`}
                  </Text>
                </View>
                <StateProgressBar
                  total={row.total}
                  segments={[
                    { count: row.done, color: colors.keep },
                    { count: row.toEdit, color: colors.edit },
                    { count: row.staged, color: colors.cull },
                  ]}
                />
                {(row.toEdit > 0 || row.staged > 0) && (
                  <Text style={styles.dayRowHint}>
                    {[
                      row.toEdit > 0 ? `${row.toEdit} to edit` : null,
                      row.staged > 0 ? `${row.staged} staged cull` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, gap: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textDim, fontSize: 16, marginBottom: 8 },
  sectionLabel: { color: colors.textDim, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  cardText: { color: colors.textDim, fontSize: 15, lineHeight: 21 },
  scopeRow: { flexDirection: 'row', gap: 10 },
  scopeChip: {
    flex: 1,
    minHeight: 52,
    borderRadius: touch.radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scopeChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  scopeChipText: { color: colors.textDim, fontSize: 16, fontWeight: '600' },
  scopeChipTextActive: { color: '#1a1205' },
  customRow: { flexDirection: 'row', gap: 10 },
  dateField: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  dateFieldLabel: { color: colors.textDim, fontSize: 12 },
  dateFieldValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
  editQueueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  editQueueIcon: { color: colors.edit, fontSize: 22, fontWeight: '700' },
  editQueueBody: { flex: 1 },
  editQueueTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  editQueueHint: { color: colors.textDim, fontSize: 13 },
  badge: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.edit,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { color: '#0d1524', fontSize: 14, fontWeight: '800' },
  dayRow: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  dayRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayRowTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dayRowPct: { color: colors.textDim, fontSize: 13 },
  dayRowHint: { color: colors.textDim, fontSize: 12 },
});
