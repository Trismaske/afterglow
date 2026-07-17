import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as MediaLibrary from 'expo-media-library';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { clusterByGap } from '@afterglow/core';
import type { RootStackParamList } from '../navigation';
import { customRange, todayRange, yesterdayRange, type DateRange } from '../lib/dates';
import { loadPhotosInRange, type LoadedPhoto } from '../lib/media';
import { useSession, CULL_GROUP_GAP_MS } from '../session/SessionContext';
import { BigButton } from '../components/BigButton';
import { colors, touch } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Scope = 'today' | 'yesterday' | 'custom';

export function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const sessionCtx = useSession();
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ['photo'],
  });

  const [scope, setScope] = useState<Scope>('today');
  const [customFrom, setCustomFrom] = useState<Date>(new Date());
  const [customTo, setCustomTo] = useState<Date>(new Date());
  const [pickerFor, setPickerFor] = useState<'from' | 'to' | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<LoadedPhoto[] | null>(null);
  const [hasResumable, setHasResumable] = useState(false);
  const [starting, setStarting] = useState(false);

  const range: DateRange = useMemo(() => {
    if (scope === 'today') return todayRange(new Date());
    if (scope === 'yesterday') return yesterdayRange(new Date());
    return customRange(customFrom, customTo);
  }, [scope, customFrom, customTo]);

  // Is there a persisted session to resume? (session may not be loaded yet)
  useEffect(() => {
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
  }, [sessionCtx.version]);

  // Load counts whenever the range changes and we have permission.
  useEffect(() => {
    if (!permission?.granted) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(null);
    loadPhotosInRange(range.startMs, range.endMs)
      .then((photos) => {
        if (!cancelled) setLoaded(photos);
      })
      .catch(() => {
        if (!cancelled) setLoaded([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [permission?.granted, range.startMs, range.endMs]);

  const counts = useMemo(() => {
    if (!loaded) return null;
    const clusters = clusterByGap(
      loaded.map((p) => p.item),
      { gapMs: CULL_GROUP_GAP_MS },
    );
    const groups = clusters.filter((c) => c.items.length >= 2);
    return {
      photos: loaded.length,
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
    if (!loaded || loaded.length === 0 || starting) return;
    const begin = async () => {
      setStarting(true);
      try {
        await sessionCtx.startSession(range.label, range.startMs, range.endMs, loaded);
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
                ? 'No photos in this range.'
                : `${counts.photos} photos · ${counts.groups} cull groups · ${counts.singles} singles`}
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
});
