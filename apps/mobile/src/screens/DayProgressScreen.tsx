/**
 * Day-scoped inbox-zero view (m0.2, rebuilt on the shared ProgressView
 * in m0.4 stage 3; m0.8: sessions are gone): tappable state summary,
 * filtered photo grid, state editor sheet, and a "Continue reviewing"
 * CTA into the continuous review queue (the day's photos are already
 * grouped there by the scan). Gate 5: the day's cull groups list here
 * too — completed ones included — and reopen in the deck's
 * browse/re-decide mode.
 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useExternalRefresh } from '../components/useExternalRefresh';
import { useSQLiteContext } from 'expo-sqlite';
import { mountedVolumeSet } from '../lib/mountedVolumes';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { formatClock } from '../lib/format';
import { UNDATED_DAY_KEY } from '../lib/dates';
import { remainingReviewable, type StateBreakdown } from '../lib/progress';
import { listGroupsForDay, type ReviewGroupRow } from '../db/store';
import { resolveSources } from '../lib/sourceCatalog';
import { ProgressView } from '../components/progress/ProgressView';
import { useReview } from '../review/ReviewContext';
import { BadgeCluster } from '../components/DecisionBadge';
import { photoBadges, type PhotoBadge } from '../lib/photoBadges';
import { UnitCard } from '../components/UnitCard';
import { BigButton } from '../components/BigButton';
import { colors, useTheme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'DayProgress'>;

export function DayProgressScreen({ route, navigation }: Props) {
  const { day } = route.params;
  const db = useSQLiteContext();
  const theme = useTheme();
  const { version, actionWeights, hydrateBadges } = useReview();
  // 'failed' is a distinct state, never an empty array: the CTA routes on
  // this list (group vs singles), and a failure read as "no pending
  // group" sent the user to the day's singles deck — a wrong-but-
  // plausible destination.
  const [groups, setGroups] = useState<ReviewGroupRow[] | 'loading' | 'failed'>('loading');
  // Foreground return re-reads the day's group list (final cycle P4):
  // the child ProgressView refreshes its own counts/grid, but this list
  // is loaded here and `version` may not move on a card swap.
  const [foregroundTick, setForegroundTick] = useState(0);
  useExternalRefresh(() => setForegroundTick((t) => t + 1));

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        // Same source scoping as the page's totals and grid. FAIL CLOSED:
        // a resolution error must not broaden a narrowed source to all
        // folders (null's store meaning) — and must not read as a
        // known-empty day (see the state comment above).
        try {
          const roots = (await resolveSources(db)).roots ?? null;
          const rows = await listGroupsForDay(db, day, roots, await mountedVolumeSet());
          // A completed group here can sit entirely OUTSIDE the review
          // snapshot, where actionWeights knows nothing — hydrate the
          // badge refs for every member BEFORE the list renders (the
          // setGroups below is the re-render), exactly as loadGroup does
          // for the deck. FAILURE FAILS CLOSED into the page's 'failed'
          // state below (codex r7): a warned-but-rendered list silently
          // dropped every badge, and the local needs_edit backstop
          // covers only the edit action.
          await hydrateBadges(rows.flatMap((g) => g.members.map((m) => m.asset_id)));
          if (!cancelled) setGroups(rows);
        } catch (error) {
          console.warn('[day] day-group load failed:', String(error));
          if (!cancelled) setGroups('failed');
        }
      })();
      return () => {
        cancelled = true;
      };
      // version is a deliberate refresh trigger: viewer edits refresh the
      // review context, and the day's group list (badges, pending counts)
      // must follow without a leave-and-return (a closing Modal does not
      // refocus the screen).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, day, version, hydrateBadges, foregroundTick]),
  );

  /** Same badge set as the review overview (GroupsScreen): the verdict
   * plus every action at its own weight, none replacing another — the
   * previous `kept && needs_edit ? edit : keep` hid the verdict behind
   * an action (the HistoryScreen fix, this release; docs/STATE_MODEL.md).
   * The verdict rides into actionWeights so a staged cull's retained
   * actions badge quiet. The day query's own needs_edit backstops the
   * edit weight (same demotion) for any member the hydrated map lacks
   * (hydration failure itself fails the page — codex r7). */
  const badgesFor = useCallback(
    (member: ReviewGroupRow['members'][number], bestPhotoId: string | null): PhotoBadge[] => {
      const weights = actionWeights(member.asset_id, member.state);
      const suspended = member.state === 'culled' || member.state === 'trashed';
      return photoBadges({
        ...weights,
        state: member.state,
        edit: weights.edit ?? (member.needs_edit === 1 ? (suspended ? 'carried' : 'live') : null),
        best: member.asset_id === bestPhotoId,
      });
    },
    [actionWeights],
  );

  const renderCta = useCallback(
    (b: StateBreakdown) => {
      const remaining = remainingReviewable(b);
      // TRACKED pending only can be reviewed: `remaining` counts
      // MediaStore photos the scan has not inserted yet, but both
      // destinations read tracked rows — during a cold scan a positive
      // CTA would open an empty deck that immediately backs out
      // (codex r8). `b.unreviewed` is the DB-side count.
      const trackedRemaining = b.unreviewed;
      const loaded = Array.isArray(groups) ? groups : null;
      return (
        <View style={styles.ctaBlock}>
          <BigButton
            label={
              remaining > 0
                ? trackedRemaining > 0
                  ? `Continue reviewing · ${remaining} left this day`
                  : 'Waiting for the scan to reach this day…'
                : 'Nothing left to review'
            }
            color={colors.keep}
            // The group list decides the destination, so the CTA stays
            // disabled until it is KNOWN — the singles fallback is only
            // honest for a truly known-empty (or all-reviewed) list.
            disabled={remaining === 0 || trackedRemaining === 0 || loaded === null}
            // The label promises THIS day, so BOTH destinations are day
            // scoped: the day's first pending group, else the day's own
            // singles deck. The plain `Singles` route opens the GLOBAL
            // newest-first feed, which for any day but the newest is a
            // different day's photos entirely (m0.8.2).
            onPress={() => {
              if (loaded === null) return;
              // Eligibility needs an unreviewed member ON THIS DAY
              // (codex r6) AND IN THE ACTIVE SOURCE (codex r7):
              // listGroupsForDay returns a group whole when ANY member
              // matches the day + source, so a group could qualify via
              // a kept member here while its only pending member lives
              // on another day — or via an out-of-source unreviewed
              // member on this day — hijacking a CTA that counted this
              // day's in-source singles. The opened deck still shows
              // the whole group; only the door checks the scope.
              const pendingGroup = loaded.find((g) =>
                g.members.some(
                  (m) =>
                    m.state === 'unreviewed' &&
                    (m.day ?? UNDATED_DAY_KEY) === day &&
                    m.in_source === 1,
                ),
              );
              if (pendingGroup)
                navigation.navigate('Deck', { groupId: String(pendingGroup.groupId) });
              else navigation.navigate('Singles', { day });
            }}
          />
          {groups === 'failed' && (
            // Mirrors the grid's fail-closed empty state: never claim
            // "no groups" over a failed read.
            <Text style={styles.groupsFailed}>
              Could not read this day's groups just now. Leave and reopen to try again.
            </Text>
          )}
          {loaded !== null && loaded.length > 0 && (
            <>
              <Text style={styles.groupsLabel}>Groups this day</Text>
              {loaded.map((group) => {
                const pending = group.members.filter((m) => m.state === 'unreviewed').length;
                const first = group.members[0];
                const away =
                  (group.unreachableCount ?? 0) > 0
                    ? ` · ${group.unreachableCount} on unmounted SD card`
                    : '';
                return (
                  <UnitCard
                    key={group.groupId}
                    title={`${group.members.length} shots${first ? ` · ${formatClock(first.taken_at)}` : ''}`}
                    status={
                      (pending === 0 ? 'Reviewed · tap to revisit' : `${pending} pending`) + away
                    }
                    statusDone={pending === 0}
                    members={group.members}
                    onPress={() => navigation.navigate('Deck', { groupId: String(group.groupId) })}
                    renderOverlay={(assetId) => {
                      const member = group.members.find((m) => m.asset_id === assetId);
                      return member ? (
                        <BadgeCluster
                          badges={badgesFor(member, group.bestPhotoId)}
                          size={14}
                          accent={theme.accent}
                          style={styles.badges}
                        />
                      ) : null;
                    }}
                  />
                );
              })}
            </>
          )}
        </View>
      );
    },
    [badgesFor, day, groups, navigation, theme.accent],
  );

  return <ProgressView target={{ kind: 'day', day }} renderCta={renderCta} />;
}

const styles = StyleSheet.create({
  ctaBlock: { gap: 12 },
  groupsLabel: {
    color: colors.textDim,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  groupsFailed: { color: colors.textDim, fontSize: 13 },
  // Wrapping cluster inside the thumbnail (GroupsScreen's rule) — every
  // badge stays visible.
  badges: { position: 'absolute', right: 2, bottom: 2, left: 2 },
});
