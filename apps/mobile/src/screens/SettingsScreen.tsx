/**
 * Settings, reached from the gear on Home: photo source (→ the existing
 * picker, with per-volume unreachable tags and "Forget this card" rows),
 * daily-goal chips + the validated custom-goal dialog, the "Keeping up"
 * coverage chips, accent color (accentTheme.ts + ThemeProvider,
 * live-applied), the Library scan status row with manual rescan, a reset
 * for suppressed confirmation dialogs, and the app version. Values
 * persist in the m0.3.1 settings table.
 */
import { readPlaybackValues, writePlaybackValue } from '../lib/playbackSettings';
import {
  ANIMATED_THUMBS_KEY,
  ANIMATED_THUMBS_MODES,
  DEFAULT_ANIMATED_THUMBS_MODE,
  parseAnimatedThumbsMode,
  type AnimatedThumbsMode,
} from '../lib/animatedCells';
import { SegmentedControl } from '../components/SegmentedControl';
import { useLargeText } from '../components/useLargeText';
import { useTextOverflow } from '../components/useTextOverflow';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '../lib/format';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useReview } from '../review/ReviewContext';
import Constants from 'expo-constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { resolveSources } from '../lib/sourceCatalog';
import {
  invalidateMountedVolumes,
  mountedVolumeSet,
  unreachableCounts,
} from '../lib/mountedVolumes';
import { countForgettable, forgetVolume } from '../db/volumeLifecycle';
import type { SourceRoot } from '../lib/sources';
import {
  COVERAGE_GOAL_CHOICES,
  COVERAGE_GOAL_KEY,
  COVERAGE_GOAL_LABELS,
  parseCoverageGoal,
  serializeCoverageGoal,
  type CoverageGoal,
} from '../lib/coverageGoal';
import {
  DAILY_GOAL_CHOICES,
  DAILY_GOAL_KEY,
  DEFAULT_DAILY_GOAL,
  parseCustomDailyGoal,
  parseDailyGoal,
  serializeDailyGoal,
} from '../lib/dailyGoal';
import {
  GROUPING_STRICTNESS_KEY,
  parseStrictness,
  serializeStrictness,
  STRICTNESS_STEPS,
  type StrictnessStep,
} from '../lib/groupingPrefs';
import {
  PLAYBACK_KEYS,
  PLAYBACK_MODES,
  parsePlaybackMode,
  serializePlaybackMode,
  type PlaybackKind,
  type PlaybackMode,
} from '../lib/playbackPrefs';
import {
  getScanStatus,
  requestRescan,
  SCAN_VERIFIED_AT_KEY,
  subscribeScanStatus,
  supersedeScan,
  type ScanStatus,
} from '../scan/scanRunner';
import { scanStatusLine } from '../lib/scanSkip';
import { countTrackedByVolume, countTrackedPhotos } from '../db/store';
import { applyGroupingSettingChange } from '../db/store';
import {
  COMPARE_AFTER_CULL_KEY,
  COMPARE_AFTER_KEEP_KEY,
  serializeComparePref,
} from '../lib/comparePrefs';
import { getSetting, setSetting, setSettings } from '../db/store';
import {
  DEFAULT_OVERLAY_PREFS,
  OVERLAY_ROWS,
  type OverlayPrefs,
  type OverlayRow,
} from '../lib/overlayPrefs';
import { readOverlayPrefs, writeOverlayRow } from '../components/useOverlayPrefs';
import { ACCENT_PRESETS } from '../lib/accentTheme';
import { showToast } from '../lib/toast';
import { colors, radius, scrim, space, touch, type, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * The two facts the Library scan row states. FAILS CLOSED, quietly: an
 * unreadable scope returns null and the row keeps what it had, rather
 * than counting the whole library and calling it the user's selection.
 */
async function readScanFacts(
  db: SQLiteDatabase,
  roots: readonly SourceRoot[] | null,
): Promise<{ verifiedAt: number | null; corpus: number } | null> {
  try {
    const [rawAt, corpus] = await Promise.all([
      getSetting(db, SCAN_VERIFIED_AT_KEY),
      countTrackedPhotos(db, roots),
    ]);
    const parsed = rawAt === null ? NaN : Number(rawAt);
    return { verifiedAt: Number.isFinite(parsed) ? parsed : null, corpus };
  } catch {
    return null;
  }
}

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { refresh } = useReview();
  const theme = useTheme();
  const largeText = useLargeText();
  /** Measured lever: a pill row stacks when its title needs a second
   * line in the title column; large text is the first guess. */
  const pillTitles = useTextOverflow(largeText);
  const systemAvailable = theme.systemAccent !== null;
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<CoverageGoal | null>(null);
  const [strictness, setStrictness] = useState<StrictnessStep | null>(null);
  /** Phase 5 (M5): the two per-kind playback modes, Once by default. */
  const [playback, setPlayback] = useState<Record<PlaybackKind, PlaybackMode>>({
    video: 'once',
    motion: 'once',
  });
  /** The last DURABLE value per kind (loaded or written) — the rollback
   * anchor when a write fails — and a per-kind write generation so an
   * in-flight focus read cannot overwrite a newer tap (the goal rows'
   * pattern). */
  const durablePlaybackRef = useRef<Record<PlaybackKind, PlaybackMode>>({
    video: 'once',
    motion: 'once',
  });
  const playbackWriteGen = useRef<Record<PlaybackKind, number>>({ video: 0, motion: 0 });
  /** Phase 6: the animated-thumbnails row, All by default,
   * with the same durable anchor and write fence as the modes. */
  const [animatedThumbs, setAnimatedThumbs] = useState<AnimatedThumbsMode>(
    DEFAULT_ANIMATED_THUMBS_MODE,
  );
  const durableAnimatedRef = useRef<AnimatedThumbsMode>(DEFAULT_ANIMATED_THUMBS_MODE);
  const animatedWriteGen = useRef(0);
  /** Committed-since-focus and in-flight tracking, as the Overlay rows
   * keep (codex, close-out round 7): the focus read establishes the
   * durable value for a row with no write in flight and none committed
   * since focus — a tap that FAILED before the read landed must roll
   * back to what SQLite holds, not to the default the read never set. */
  const animatedCommitted = useRef(false);
  const animatedInFlight = useRef(0);
  const pickAnimatedThumbs = useCallback(
    (mode: AnimatedThumbsMode) => {
      const gen = (animatedWriteGen.current += 1);
      setAnimatedThumbs(mode);
      animatedInFlight.current += 1;
      void writePlaybackValue(db, ANIMATED_THUMBS_KEY, mode).then(
        () => {
          animatedInFlight.current -= 1;
          durableAnimatedRef.current = mode;
          animatedCommitted.current = true;
        },
        (error) => {
          animatedInFlight.current -= 1;
          console.warn('[settings] animated thumbnails write failed:', String(error));
          if (animatedWriteGen.current !== gen) return;
          setAnimatedThumbs(durableAnimatedRef.current);
          showToast('Could not save the playback setting');
        },
      );
    },
    [db],
  );
  const playbackCommitted = useRef(new Set<PlaybackKind>());
  const playbackInFlight = useRef<Record<PlaybackKind, number>>({ video: 0, motion: 0 });
  const pickPlayback = useCallback(
    (kind: PlaybackKind, mode: PlaybackMode) => {
      const gen = (playbackWriteGen.current[kind] += 1);
      setPlayback((prev) => ({ ...prev, [kind]: mode }));
      playbackInFlight.current[kind] += 1;
      void writePlaybackValue(db, PLAYBACK_KEYS[kind], serializePlaybackMode(mode)).then(
        () => {
          // Every committed write moves the anchor, whatever generation
          // is current: a later tap that then fails must roll back to
          // what SQLite actually holds, which is this value.
          playbackInFlight.current[kind] -= 1;
          durablePlaybackRef.current[kind] = mode;
          playbackCommitted.current.add(kind);
        },
        (error) => {
          playbackInFlight.current[kind] -= 1;
          console.warn('[settings] playback mode write failed:', String(error));
          if (playbackWriteGen.current[kind] !== gen) return; // a newer tap owns the row
          const durable = durablePlaybackRef.current[kind];
          setPlayback((prev) => ({ ...prev, [kind]: durable }));
          showToast('Could not save the playback setting');
        },
      );
    },
    [db],
  );
  /** Phase 7 (F34): the ten Overlay rows, each with the durable anchor
   * and write fence the playback rows use, read on focus. */
  const [overlay, setOverlay] = useState<OverlayPrefs>(DEFAULT_OVERLAY_PREFS);
  const durableOverlayRef = useRef<OverlayPrefs>(DEFAULT_OVERLAY_PREFS);
  const overlayWriteGen = useRef<Record<OverlayRow, number>>(
    Object.fromEntries(OVERLAY_ROWS.map((r) => [r.row, 0])) as Record<OverlayRow, number>,
  );
  /** The rows' writes go through useOverlayPrefs' module-scope chain
   * (codex rounds 1 and 6): two rapid taps, or a tap on the way out and
   * a newer instance's tap, commit in issue order, and the deck's read
   * waits for them. */
  /** Rows a write has COMMITTED for since focus: the focus read's value
   * is the rollback anchor for every other row, even one tapped while
   * the read was in flight — SQLite still holds the read's value until a
   * write lands (codex round 3). */
  const overlayCommitted = useRef(new Set<OverlayRow>());
  /** Writes in flight per row: a late focus read updates the rendered
   * value of a row with none (a write that already failed rolled the
   * switch back to a stale anchor — codex round 4) and only the anchor
   * of a row with one (its rollback then lands on the read's value). */
  const overlayInFlight = useRef<Record<OverlayRow, number>>(
    Object.fromEntries(OVERLAY_ROWS.map((r) => [r.row, 0])) as Record<OverlayRow, number>,
  );
  const toggleOverlay = useCallback(
    (row: OverlayRow, on: boolean) => {
      const gen = (overlayWriteGen.current[row] += 1);
      setOverlay((prev) => ({ ...prev, [row]: on }));
      const key = OVERLAY_ROWS.find((r) => r.row === row)?.key ?? '';
      overlayInFlight.current[row] += 1;
      void writeOverlayRow(db, key, on).then(
        () => {
          overlayInFlight.current[row] -= 1;
          durableOverlayRef.current = { ...durableOverlayRef.current, [row]: on };
          overlayCommitted.current.add(row);
        },
        (error) => {
          overlayInFlight.current[row] -= 1;
          console.warn('[settings] overlay row write failed:', String(error));
          if (overlayWriteGen.current[row] !== gen) return;
          const durable = durableOverlayRef.current[row];
          setOverlay((prev) => ({ ...prev, [row]: durable }));
          showToast('Could not save the overlay setting');
        },
      );
    },
    [db],
  );
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      overlayCommitted.current.clear();
      void readOverlayPrefs(db).then(
        (loaded) => {
          if (cancelled) return;
          // A row with a write in flight keeps its optimistic value; one
          // whose writes have all settled without a commit since focus
          // shows the read's value (the durable truth).
          setOverlay((prev) => {
            const next = { ...prev };
            for (const r of OVERLAY_ROWS)
              if (overlayInFlight.current[r.row] === 0 && !overlayCommitted.current.has(r.row))
                next[r.row] = loaded[r.row];
            return next;
          });
          const durable = { ...durableOverlayRef.current };
          for (const r of OVERLAY_ROWS)
            if (!overlayCommitted.current.has(r.row)) durable[r.row] = loaded[r.row];
          durableOverlayRef.current = durable;
        },
        (error) => console.warn('[settings] overlay rows read failed:', String(error)),
      );
      return () => {
        cancelled = true;
      };
    }, [db]),
  );
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [customGoalOpen, setCustomGoalOpen] = useState(false);
  const [customGoalText, setCustomGoalText] = useState('');
  const [customGoalError, setCustomGoalError] = useState<string | null>(null);
  // "Are my numbers current?" answered with a fact. Home already
  // re-checks on open and on foreground return, so a bare refresh button
  // would imply a staleness that is not the normal state (m0.8.2).
  /** m0.8.3 §7: unmounted in-scope volumes with their tracked counts —
   * each renders a "Forget this card" row under the source row. */
  const [awayVolumes, setAwayVolumes] = useState<{ volume: string; count: number }[]>([]);
  // Foreground return re-reads the mounted-scoped rows (final cycle O6):
  // a card swapped while Settings sat open in the background must move
  // the source tag and the Forget rows without a re-navigation.
  const [foregroundTick, setForegroundTick] = useState(0);
  useExternalRefresh(() => setForegroundTick((t) => t + 1));
  const [scanFacts, setScanFacts] = useState<{ verifiedAt: number | null; corpus: number } | null>(
    null,
  );
  // Seeded from the LIVE snapshot (codex r7): subscribe-only missed an
  // already-running scan, leaving "Rescan library" enabled — pressing it
  // superseded and discarded real scan work.
  const [scanStatus, setScanStatus] = useState<ScanStatus>(getScanStatus);
  const customGoalActive =
    goal !== null && !(DAILY_GOAL_CHOICES as readonly number[]).includes(goal);

  // While a strictness change applies (setting write, refresh, possibly
  // a rollback), EVERY exit is blocked — leaving mid-apply could strand
  // the rendered queue and the durable setting mid-rollback, disagreeing
  // until the next open.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (applyingRef.current) event.preventDefault();
    });
    return unsubscribe;
  }, [navigation]);

  /**
   * "Forget this card" (m0.8.3 §7 mechanism 2): two levels behind two
   * confirmations, the erase level behind a SECOND, stronger one whose
   * copy names the count that will visibly leave the all-time stats.
   * The honest edge is stated in both flows: a returning card re-ingests.
   */
  const confirmForget = useCallback(
    async (entry: { volume: string; count: number }) => {
      // The IRREVERSIBLE copy must name the WHOLE population the write
      // touches (codex phase-4): volume-wide, prior tombstones included
      // — never the source-scoped banner count. And the premise must be
      // LIVE: re-read mount state before claiming the card is away.
      invalidateMountedVolumes();
      const [mountedNow, counts] = await Promise.all([
        mountedVolumeSet(),
        countForgettable(db, entry.volume),
      ]);
      // POSITIVE absence only (final deep cycle M1): a destructive write
      // must never proceed on an UNKNOWN mount state — null here is a
      // failed read, not proof the card is away (distinct from the
      // query-side null fail-open, which only ever widens what shows).
      if (mountedNow === null || mountedNow.includes(entry.volume)) {
        // A DIALOG, not a toast (Tristan, m0.8.3 matrix): this aborts a
        // destructive flow the user is actively driving — it must not be
        // missable.
        Alert.alert(
          'Nothing was changed',
          mountedNow === null
            ? 'Could not verify the card is absent. Try again.'
            : 'The card is back — its items are reachable again.',
        );
        if (mountedNow !== null) {
          setAwayVolumes((prev) => prev.filter((v) => v.volume !== entry.volume));
          void refresh();
        }
        return;
      }
      const present = `${plural(counts.present, 'item')}`;
      const everything = `${plural(counts.total, 'item')}`;
      const runForget = async (level: 'keep' | 'erase') => {
        try {
          // Final revalidation right before the destructive write — the
          // card can return while a confirmation sits open.
          invalidateMountedVolumes();
          const atWrite = await mountedVolumeSet();
          // Same positive-absence rule at the write itself.
          if (atWrite === null || atWrite.includes(entry.volume)) {
            Alert.alert(
              'Nothing was changed',
              atWrite === null
                ? 'Could not verify the card is absent. Try again.'
                : 'The card is back — its items are reachable again.',
            );
            if (atWrite !== null) {
              setAwayVolumes((prev) => prev.filter((v) => v.volume !== entry.volume));
              void refresh();
            }
            return;
          }
          // Supersede any RUNNING scan first (final cycle S6): a pass
          // finishing during the transaction below could otherwise
          // re-store the fingerprint/baselines it deletes.
          supersedeScan();
          const result = await forgetVolume(db, entry.volume, level, Date.now(), atWrite);
          setAwayVolumes((prev) => prev.filter((v) => v.volume !== entry.volume));
          showToast(
            level === 'keep'
              ? `Card forgotten — review history for ${plural(result.photos, 'item')} kept`
              : `Card erased — ${plural(result.rows, 'item')} removed from your history`,
          );
          void refresh();
          // Forget rewrites scan OUTPUT without changing scan INPUT
          // (generations/roots/model), so the unchanged-library skip
          // would otherwise swallow the promised returning-card
          // re-ingestion until the weekly pass (codex phase-4).
          void requestRescan(db);
        } catch (error) {
          showToast('Could not forget the card — nothing was changed. Try again.');
          console.warn('[settings] forget card failed:', String(error));
          // The supersede above already stopped any running scan; with
          // the transaction rolled back, scanning must resume (final
          // cycle T5) — otherwise status can sit at 'scanning' with no
          // pass until an external trigger.
          void requestRescan(db);
        }
      };
      Alert.alert(
        'Forget this card?',
        `${present} on this card are unreachable` +
          (counts.total > counts.present
            ? ` (${everything} total in your history, earlier departures included)`
            : '') +
          '. For a card that is never coming back:\n\n' +
          '“Keep my review history” marks them gone but keeps every decision — ' +
          'all-time counts survive.\n\n' +
          `“Erase everything” removes all ${everything} from your history entirely.\n\n` +
          'If the card ever returns, its items are re-ingested either way.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Keep my review history', onPress: () => void runForget('keep') },
          {
            text: 'Erase everything',
            style: 'destructive',
            onPress: () =>
              Alert.alert(
                'Erase everything?',
                `This deletes ${everything} from your review history — all-time counts WILL drop. ` +
                  'This cannot be undone.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: `Erase ${everything}`,
                    style: 'destructive',
                    onPress: () => void runForget('erase'),
                  },
                ],
              ),
          },
        ],
      );
    },
    [db, refresh],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      playbackCommitted.current.clear();
      animatedCommitted.current = false;
      (async () => {
        // The playback rows read through their write chain (codex,
        // close-out round 5): a reopened Settings must see a save the
        // previous instance issued on the way out, not the value before it.
        const [[rawGoal, rawCoverage, rawStrictness], [rawVideo, rawMotion, rawAnimated]] =
          await Promise.all([
            Promise.all([
              getSetting(db, DAILY_GOAL_KEY),
              getSetting(db, COVERAGE_GOAL_KEY),
              getSetting(db, GROUPING_STRICTNESS_KEY),
            ]),
            readPlaybackValues(db, [
              PLAYBACK_KEYS.video,
              PLAYBACK_KEYS.motion,
              ANIMATED_THUMBS_KEY,
            ]),
          ]);
        if (!cancelled) {
          // FENCED against user writes (codex r9): a selection made while
          // this read was in flight must not be overwritten by the read's
          // older value — the write generations say whether the user has
          // acted since focus.
          if (goalWriteGen.current === 0) {
            const durableGoal = parseDailyGoal(rawGoal);
            durableGoalRef.current = durableGoal;
            setGoal(durableGoal);
          }
          if (coverageWriteGen.current === 0) {
            const durableCoverage = parseCoverageGoal(rawCoverage);
            durableCoverageRef.current = durableCoverage;
            setCoverage(durableCoverage);
          }
          setStrictness(parseStrictness(rawStrictness));
          // A row with a write in flight keeps its optimistic value and
          // takes the read as its rollback anchor; one whose writes all
          // settled without a commit since focus shows the read's value,
          // the durable truth (the Overlay rows' rule).
          const loaded = {
            video: parsePlaybackMode(rawVideo),
            motion: parsePlaybackMode(rawMotion),
          };
          const settled = (kind: PlaybackKind): boolean =>
            playbackInFlight.current[kind] === 0 && !playbackCommitted.current.has(kind);
          setPlayback((prev) => ({
            video: settled('video') ? loaded.video : prev.video,
            motion: settled('motion') ? loaded.motion : prev.motion,
          }));
          for (const kind of ['video', 'motion'] as const) {
            if (!playbackCommitted.current.has(kind))
              durablePlaybackRef.current[kind] = loaded[kind];
          }
          const loadedAnimated = parseAnimatedThumbsMode(rawAnimated);
          if (!animatedCommitted.current) durableAnimatedRef.current = loadedAnimated;
          if (animatedInFlight.current === 0 && !animatedCommitted.current) {
            setAnimatedThumbs(loadedAnimated);
          }
        }
        // Resolving sources needs MediaStore access; without permission
        // (or on failure) the row still navigates, just without a label.
        // A FAILED resolution also bypasses the facts read entirely:
        // passing null roots there means "whole library" (readScanFacts'
        // contract), which would replace the selected-source corpus count
        // with the global one. A successfully resolved all-folders
        // selection legitimately carries null roots and still reads.
        const src = await resolveSources(db).catch((error): null => {
          console.warn('[settings] source resolution failed — scan facts kept:', String(error));
          return null;
        });
        // m0.8.3 §5: the source row names an unreachable state WITH ITS
        // COUNT, for dirs and All-folders scopes alike — the tracked
        // rows are the population MediaStore cannot see right now. The
        // tag claims nothing when the mounted set is unknowable.
        let label = src?.label ?? null;
        if (label !== null && src !== null) {
          const [byVolume, mounted] = await Promise.all([
            countTrackedByVolume(db, src.roots ?? null),
            mountedVolumeSet(),
          ]);
          const away = unreachableCounts(byVolume, mounted);
          if (!cancelled) setAwayVolumes(away);
          if (away.length > 0) {
            const count = away.reduce((sum, entry) => sum + entry.count, 0);
            label = `${label} — SD card not mounted (${plural(count, 'item')})`;
          }
        } else if (!cancelled) {
          setAwayVolumes([]);
        }
        if (!cancelled) setSourceLabel(label);
        if (src === null) return;
        const facts = await readScanFacts(db, src.roots);
        if (!cancelled && facts) setScanFacts(facts);
      })();
      return () => {
        cancelled = true;
      };
      // foregroundTick: O6 — see its declaration.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, foregroundTick]),
  );

  // The row's whole job is answering "are my numbers current?", so it
  // must not go stale itself: a pass finishing while Settings is open
  // re-reads the facts rather than leaving the line it just invalidated.
  useEffect(
    () =>
      subscribeScanStatus((next) => {
        setScanStatus(next);
        if (next.phase !== 'done') return;
        void (async () => {
          // Same guard as the focus loader: a failed resolution must not
          // widen the facts read to the whole library — keep the line.
          const src = await resolveSources(db).catch((error): null => {
            console.warn('[settings] source resolution failed — scan facts kept:', String(error));
            return null;
          });
          if (src === null) return;
          const facts = await readScanFacts(db, src.roots);
          if (facts) setScanFacts(facts);
        })();
      }),
    [db],
  );

  // Goal/coverage persists handle rejection (codex r7): fired-and-
  // forgotten, a failed write left the UI showing an unsaved value.
  // On rejection the local state reverts to the last durable value and
  // the standard "Change not saved" alert says so.
  const surfaceSettingWriteError = useCallback((error: unknown) => {
    Alert.alert(
      'Change not saved',
      `Afterglow could not write the change to its database. Nothing was changed — please retry the action.\n\n${error instanceof Error ? error.message : String(error)}`,
    );
  }, []);

  // GENERATION-FENCED rollbacks (codex r8) anchored to DURABLE state
  // (codex r9): the chips stay actionable while a write is in flight, so
  // a STALE write's rejection must not roll back a NEWER choice — and a
  // rollback must land on the last value known PERSISTED, never on an
  // earlier optimistic render that may itself have failed.
  const goalWriteGen = useRef(0);
  const durableGoalRef = useRef<number | null>(null);
  /** The write generation the durable ref reflects: a SUPERSEDED write's
   * success must still advance the baseline when it is newer than the
   * last recorded one (codex r10 — tap A, tap B: A commits after B was
   * allocated; if B then rejects, the rollback must land on A, which IS
   * durable, not on the pre-A value). */
  const durableGoalGen = useRef(0);
  const pickGoal = useCallback(
    (value: number) => {
      const gen = ++goalWriteGen.current;
      setGoal(value);
      void setSetting(db, DAILY_GOAL_KEY, serializeDailyGoal(value)).then(
        () => {
          if (gen > durableGoalGen.current) {
            durableGoalGen.current = gen;
            durableGoalRef.current = value;
          }
        },
        (error: unknown) => {
          if (gen !== goalWriteGen.current) return; // superseded — the newer write owns the state
          if (durableGoalRef.current !== null) setGoal(durableGoalRef.current);
          surfaceSettingWriteError(error);
        },
      );
    },
    [db, surfaceSettingWriteError],
  );

  const openCustomGoal = useCallback(() => {
    setCustomGoalText(String(goal));
    setCustomGoalError(null);
    setCustomGoalOpen(true);
  }, [goal]);

  const saveCustomGoal = useCallback(() => {
    const parsed = parseCustomDailyGoal(customGoalText);
    if ('error' in parsed) {
      setCustomGoalError(parsed.error);
      return;
    }
    pickGoal(parsed.goal);
    setCustomGoalOpen(false);
  }, [customGoalText, pickGoal]);

  const coverageWriteGen = useRef(0);
  const durableCoverageRef = useRef<CoverageGoal | null>(null);
  const durableCoverageGen = useRef(0);
  const pickCoverage = useCallback(
    (value: CoverageGoal) => {
      const gen = ++coverageWriteGen.current;
      setCoverage(value);
      void setSetting(db, COVERAGE_GOAL_KEY, serializeCoverageGoal(value)).then(
        () => {
          if (gen > durableCoverageGen.current) {
            durableCoverageGen.current = gen;
            durableCoverageRef.current = value;
          }
        },
        (error: unknown) => {
          if (gen !== coverageWriteGen.current) return; // superseded (codex r8/r9/r10 — see pickGoal)
          if (durableCoverageRef.current !== null) setCoverage(durableCoverageRef.current);
          surfaceSettingWriteError(error);
        },
      );
    },
    [db, surfaceSettingWriteError],
  );

  const pickStrictness = useCallback(
    (step: StrictnessStep) => {
      // The continuous scan re-derives every not-yet-reviewed group on each
      // pass, so a strictness change ALWAYS regroups them on the next scan
      // — an "only new photos" mode would need per-photo threshold
      // provenance the schema does not keep. Confirm honestly instead of
      // promising an opt-out the next launch would break.
      Alert.alert(
        'Change grouping strictness?',
        "Regroups your whole library (takes a few minutes). Review decisions and 'not related' judgments are never touched.",
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Change & regroup',
            onPress: () => {
              const previous = strictness;
              // Supersede the in-flight scan FIRST: it must stop writing
              // old-threshold groups before the refresh below renders,
              // and before the forced rescan starts the new pass.
              supersedeScan();
              setStrictness(step);
              setApplying(true);
              applyingRef.current = true;
              // A plain durable setting write (v22): the forced rescan
              // below re-forms every group under the new threshold.
              void applyGroupingSettingChange(
                db,
                GROUPING_STRICTNESS_KEY,
                serializeStrictness(step),
              )
                // Refresh BEFORE the rescan, so the queue renders the
                // durable state the rescan will start from.
                .then(() => refresh())
                .then(() => {
                  void requestRescan(db);
                  showToast('Regrouping in the background');
                })
                .catch(async () => {
                  // ROLL BACK: the preference may already be durable and
                  // assignments may already be deleted. Restore the
                  // setting, then REBUILD under it — a rescan is the only
                  // way back to a populated queue — and refresh. A FAILED
                  // restore must say so: the new threshold is then the
                  // durable one and the rescan rebuilds under it.
                  let restored = false;
                  if (previous) {
                    restored = await applyGroupingSettingChange(
                      db,
                      GROUPING_STRICTNESS_KEY,
                      serializeStrictness(previous),
                    ).then(
                      () => true,
                      () => false,
                    );
                    if (restored) setStrictness(previous);
                  }
                  // COMPLETE the refresh before anything else, so the
                  // rendered queue matches whichever setting survived.
                  const rerendered = await refresh().then(
                    () => true,
                    () => false,
                  );
                  void requestRescan(db);
                  showToast(
                    restored && rerendered
                      ? 'Could not change strictness — restored; regrouping'
                      : restored
                        ? 'Strictness restored, but the queue could not refresh — reopen review'
                        : 'Strictness change failed midway — check Settings; regrouping',
                  );
                })
                .finally(() => {
                  setApplying(false);
                  applyingRef.current = false;
                });
            },
          },
        ],
      );
    },
    [db, refresh, strictness],
  );

  const resetConfirmations = useCallback(() => {
    // BOTH remembered compare answers clear in ONE atomic statement
    // (codex m0.8.8 round 1: two independent writes could clear one
    // direction while the failure toast claims nothing changed). The
    // toast only fires on a COMMITTED write; a rejection says so
    // instead of silently keeping a memory (codex r7 sibling of the
    // goal/coverage persist handling).
    void setSettings(db, [
      [COMPARE_AFTER_KEEP_KEY, serializeComparePref('ask')],
      [COMPARE_AFTER_CULL_KEY, serializeComparePref('ask')],
    ]).then(
      () => showToast('Confirmation prompts will ask again'),
      (error: unknown) => {
        console.warn('[settings] confirmation reset failed:', String(error));
        showToast('Could not save — confirmation prompts unchanged');
      },
    );
  }, [db]);

  const version = Constants.expoConfig?.version ?? '?';

  return (
    <>
      <Modal visible={applying} transparent animationType="fade">
        {/* Full-screen touch shield while the strictness apply/rollback
            chain runs — paired with the beforeRemove navigation block. */}
        <View style={styles.applyingOverlay}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={styles.applyingText}>Applying grouping change…</Text>
        </View>
      </Modal>
      <Modal
        visible={customGoalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCustomGoalOpen(false)}
      >
        <View style={styles.dialogScrim}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Items per day</Text>
            <TextInput
              value={customGoalText}
              onChangeText={(text) => {
                setCustomGoalText(text);
                setCustomGoalError(null);
              }}
              onSubmitEditing={saveCustomGoal}
              keyboardType="number-pad"
              returnKeyType="done"
              autoFocus
              selectTextOnFocus
              style={[styles.dialogInput, { borderColor: theme.accent }]}
              placeholder={String(DEFAULT_DAILY_GOAL)}
              placeholderTextColor={colors.textDim}
            />
            {customGoalError !== null && <Text style={styles.dialogError}>{customGoalError}</Text>}
            <View style={styles.dialogButtons}>
              <Pressable
                style={styles.dialogButton}
                onPress={() => setCustomGoalOpen(false)}
                hitSlop={8}
              >
                <Text style={styles.dialogButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.dialogButton} onPress={saveCustomGoal} hitSlop={8}>
                <Text style={[styles.dialogButtonText, { color: theme.accent }]}>Set goal</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      >
        <Text style={styles.sectionLabel}>Photos & videos</Text>
        <Pressable style={styles.row} onPress={() => navigation.navigate('SourcePicker')}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Photo source</Text>
            <Text style={styles.rowHint} numberOfLines={1}>
              {sourceLabel ?? 'Which folders feed your reviews'}
            </Text>
          </View>
          <Text style={[styles.chevron, { color: theme.accent }]}>›</Text>
        </Pressable>

        {awayVolumes.map((entry) => (
          <Pressable
            key={entry.volume}
            style={styles.row}
            onPress={() => void confirmForget(entry)}
            accessibilityLabel={`Forget this card (${entry.volume})`}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Forget this card</Text>
              <Text style={styles.rowHint} numberOfLines={2}>
                {`SD card not mounted — ${plural(entry.count, 'item')} waiting on it. For a card that is never coming back.`}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: theme.accent }]}>›</Text>
          </Pressable>
        ))}

        <Text style={styles.sectionLabel}>Daily goal</Text>
        <Text style={styles.hint}>
          A gentle target for items reviewed per day — it drives the Home ring and streaks, and
          never blocks anything.
        </Text>
        {/* m0.9.1: one pill, like the Playback rows (every single-choice
            row reads the same). The custom segment shows the number a
            goal off the presets has, so the current setting is never
            invisible; selecting it opens the custom-goal sheet. */}
        <SegmentedControl
          accessibilityLabel="Daily goal"
          options={[
            ...DAILY_GOAL_CHOICES.map((value) => ({ id: String(value), label: String(value) })),
            { id: 'custom', label: customGoalActive ? String(goal) : 'Custom' },
          ]}
          value={customGoalActive ? 'custom' : String(goal)}
          onChange={(id) => (id === 'custom' ? openCustomGoal() : pickGoal(Number(id)))}
        />

        <Text style={styles.sectionLabel}>Keeping up</Text>
        <Text style={styles.hint}>
          A second, independent goal: leave nothing unreviewed from the last day or two — or aim for
          the whole library. Items without a capture date count only under “All”.
        </Text>
        <SegmentedControl
          accessibilityLabel="Keeping up"
          options={COVERAGE_GOAL_CHOICES.map((value) => ({
            id: value,
            label: COVERAGE_GOAL_LABELS[value],
          }))}
          value={coverage}
          onChange={pickCoverage}
        />

        <Text style={styles.sectionLabel}>Grouping</Text>
        <Text style={styles.hint}>
          How similar photos must look to land in the same group. Stricter makes smaller, tighter
          groups; looser catches more near-duplicates.
        </Text>
        <SegmentedControl
          accessibilityLabel="Grouping"
          options={STRICTNESS_STEPS.map((step) => ({ id: step.id, label: step.label }))}
          value={strictness?.id ?? null}
          onChange={(id) => {
            const step = STRICTNESS_STEPS.find((s) => s.id === id);
            if (step) pickStrictness(step);
          }}
        />

        <Text style={styles.sectionLabel}>Playback</Text>
        <View style={styles.card}>
          <Text style={styles.explainer}>
            How videos and motion photos play when you land on them.
          </Text>
          <Text style={styles.explainer}>
            {'\u2022'} Once — plays through, then rests: a video on its last frame, a motion photo
            on its photo.{'\n'}
            {'\u2022'} Loop — keeps playing until you swipe away.{'\n'}
            {'\u2022'} Off — shows the first frame; tap it for the controls.
          </Text>
          <Text style={styles.explainer}>Everything starts muted; the speaker unmutes.</Text>
          {(
            [
              { kind: 'video' as const, title: 'Videos' },
              { kind: 'motion' as const, title: 'Motion photos' },
            ] as const
          ).map((row) => (
            <View
              key={row.kind}
              style={[styles.playbackRow, pillTitles.overflow && styles.playbackRowStacked]}
            >
              <Text
                style={[
                  styles.playbackRowTitle,
                  !pillTitles.overflow && styles.playbackRowTitleInline,
                ]}
                onTextLayout={pillTitles.watch(row.kind)}
              >
                {row.title}
              </Text>
              <View style={styles.playbackControl}>
                <SegmentedControl
                  options={PLAYBACK_MODES}
                  value={playback[row.kind]}
                  onChange={(mode) => pickPlayback(row.kind, mode)}
                  accessibilityLabel={`${row.title} playback`}
                />
              </View>
            </View>
          ))}
          {/* Animated thumbnails (m0.9 phase 6, D3): thumbnails play their
              clips while on screen — all of them, or one at a time — and
              GIF thumbnails follow this row. */}
          <Text style={styles.explainer}>
            Thumbnails play their clips while on screen — all of them, or one at a time; GIFs follow
            this too.
          </Text>
          <View style={[styles.playbackRow, pillTitles.overflow && styles.playbackRowStacked]}>
            <Text
              style={[
                styles.playbackRowTitle,
                !pillTitles.overflow && styles.playbackRowTitleInline,
              ]}
              onTextLayout={pillTitles.watch('animated')}
            >
              Animated thumbnails
            </Text>
            <View style={styles.playbackControl}>
              <SegmentedControl
                options={ANIMATED_THUMBS_MODES}
                value={animatedThumbs}
                onChange={pickAnimatedThumbs}
                accessibilityLabel="Animated thumbnails playback"
              />
            </View>
          </View>
        </View>

        {/* Phase 7 (F34, M22): the Overlay section — ten full switch
            rows with subtext. The rows say what the stage draws over
            the photo; the deck's eye hides the whole set at once. */}
        <Text style={styles.sectionLabel}>Overlay</Text>
        <View style={styles.card}>
          <Text style={styles.explainer}>
            What the review stage shows over a photo. The eye in the deck's header hides all of it
            at once; these rows choose what is there when it is shown.
          </Text>
          {OVERLAY_ROWS.map((row) => (
            <View key={row.row} style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text style={styles.playbackRowTitle}>{row.title}</Text>
                <Text style={styles.explainer}>{row.hint}</Text>
              </View>
              <Switch
                value={overlay[row.row]}
                onValueChange={(on) => toggleOverlay(row.row, on)}
                trackColor={{ true: theme.accent, false: colors.surfaceRaised }}
                thumbColor={colors.text}
                accessibilityLabel={row.title}
              />
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>Appearance</Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>Accent color</Text>
          <Text style={styles.explainer}>
            Colors the buttons, chips, and highlights. System follows your phone's Material You
            palette, so it changes with your wallpaper.
          </Text>
          <View style={styles.accentWrap}>
            <Pressable
              disabled={!systemAvailable}
              onPress={() => theme.setChoice('system')}
              style={[
                styles.accentChip,
                theme.choice === 'system' && { borderColor: theme.accent },
                !systemAvailable && styles.accentChipDisabled,
              ]}
            >
              <View
                style={[
                  styles.accentSwatch,
                  { backgroundColor: theme.systemAccent ?? colors.surfaceRaised },
                ]}
              />
              <Text
                style={[styles.accentLabel, theme.choice === 'system' && styles.accentLabelActive]}
              >
                System
              </Text>
            </Pressable>
            {ACCENT_PRESETS.map((preset) => {
              const active = theme.choice === preset.id;
              return (
                <Pressable
                  key={preset.id}
                  onPress={() => theme.setChoice(preset.id)}
                  style={[styles.accentChip, active && { borderColor: theme.accent }]}
                >
                  <View style={[styles.accentSwatch, { backgroundColor: preset.hex }]} />
                  <Text style={[styles.accentLabel, active && styles.accentLabelActive]}>
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!systemAvailable && (
            <Text style={styles.stepHint}>
              System needs Android 12 or newer — the fixed colors below still work.
            </Text>
          )}
        </View>

        <Text style={styles.sectionLabel}>Library scan</Text>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>
              {scanFacts === null && scanStatus.phase !== 'scanning'
                ? 'Checking…'
                : scanStatusLine({
                    verifiedAt: scanFacts?.verifiedAt ?? null,
                    corpus: scanFacts?.corpus ?? 0,
                    running: scanStatus,
                  })}
            </Text>
            <Text style={styles.rowHint}>
              Afterglow re-checks your library every time you open it. A full pass re-reads every
              photo — normally unnecessary, but it is the fix if these numbers look wrong.
            </Text>
          </View>
        </View>
        <Pressable
          // Disabled while a flight runs — the check too (phase 9): a
          // forced rescan pressed during one would supersede it.
          style={[
            styles.row,
            (scanStatus.phase === 'scanning' || scanStatus.phase === 'checking') &&
              styles.rowDisabled,
          ]}
          disabled={scanStatus.phase === 'scanning' || scanStatus.phase === 'checking'}
          onPress={() => {
            void requestRescan(db, 'manual');
            showToast('Rescanning your library…');
          }}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, { color: theme.accent }]}>
              {scanStatus.phase === 'scanning'
                ? 'Scan in progress'
                : scanStatus.phase === 'checking'
                  ? 'Checking the library…'
                  : 'Rescan library'}
            </Text>
          </View>
        </Pressable>

        <Text style={styles.sectionLabel}>Confirmations</Text>
        <Pressable style={styles.row} onPress={resetConfirmations}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Reset confirmation prompts</Text>
            <Text style={styles.rowHint}>
              Compare's remembered "after keep" and "after cull" answers ask again.
            </Text>
          </View>
        </Pressable>

        <Text style={styles.sectionLabel}>About</Text>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Afterglow</Text>
            <Text style={styles.rowHint}>Version {version}</Text>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  rowDisabled: { opacity: 0.5 },
  content: { padding: space.page, gap: space.gap },
  hint: { color: colors.textDim, ...type.label, marginBottom: 4 },
  applyingOverlay: {
    flex: 1,
    backgroundColor: scrim.sheet,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  applyingText: { color: colors.text, ...type.body, fontWeight: '600' },
  dialogScrim: {
    flex: 1,
    backgroundColor: scrim.sheet,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.dialog,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 14,
  },
  dialogTitle: { color: colors.text, ...type.heading, fontWeight: '700' },
  dialogInput: {
    color: colors.text,
    ...type.heading,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: 14,
    minHeight: touch.action,
  },
  dialogError: { color: colors.cull, ...type.label },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dialogButton: { minHeight: touch.action, paddingHorizontal: 16, justifyContent: 'center' },
  dialogButtonText: { color: colors.textDim, ...type.body, fontWeight: '700' },
  playbackRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  /** Large text (lib/textScale.ts): the pill goes under its title. */
  playbackRowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  switchCopy: { flex: 1, gap: 2 },
  playbackRowTitle: { color: colors.text, ...type.body, fontWeight: '700' },
  /** The row layout's title column, so the pills align; a stacked row
   * lets the title take the width it needs. */
  playbackRowTitleInline: { width: 118 },
  playbackControl: { flex: 1 },
  sectionLabel: {
    color: colors.textDim,
    ...type.label,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.card,
    minHeight: 56,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, ...type.body, fontWeight: '700' },
  rowHint: { color: colors.textDim, ...type.label },
  chevron: { ...type.title, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: touch.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  explainer: { color: colors.textDim, ...type.label },
  stepHint: { color: colors.textDim, ...type.caption, fontStyle: 'italic' },
  accentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  accentChip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: touch.radius,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  accentChipDisabled: { opacity: 0.4 },
  accentSwatch: {
    width: 18,
    height: 18,
    borderRadius: radius.thumb,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.35)',
  },
  accentLabel: { color: colors.textDim, ...type.label, fontWeight: '600' },
  accentLabelActive: { color: colors.text },
});
