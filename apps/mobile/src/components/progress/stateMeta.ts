/**
 * Display metadata for the two chip rows on the progress pages (v18).
 *
 * Row 1 is the VERDICT layer, row 2 the PENDING ACTIONS
 * (docs/STATE_MODEL.md). They are separate maps because they are
 * separate layers — merging them is what previously let "in a group",
 * an annotation, sit in a list of decisions and be counted as progress.
 *
 * Every colour here is a FIXED semantic hue. None is the accent: the
 * accent is user-chosen (Material You) and means interaction, so it can
 * never carry a meaning that has to stay stable (rule 3).
 */
import { colors } from '../../theme';
import type { ActionFilter, EffectiveState } from '../../lib/progress';
import type { ActionKind } from '../../db/actions';

export interface StateMeta {
  label: string;
  color: string;
}

/** Verdicts, in the order the bar fills: decided first. */
export const VERDICT_META: Record<EffectiveState, StateMeta> = {
  kept: { label: 'Kept', color: colors.keep },
  staged: { label: 'Staged cull', color: colors.cull },
  // The empty track: unreviewed is the ABSENCE of fill, so its swatch
  // matches the track rather than claiming a colour of its own (rule 1).
  unreviewed: { label: 'Unreviewed', color: colors.surfaceRaised },
};

export const VERDICT_ORDER: readonly EffectiveState[] = ['unreviewed', 'kept', 'staged'];

/** Pending actions — one hue each, shared with their button and badge. */
export const ACTION_META: Record<ActionKind, StateMeta> = {
  edit: { label: 'To edit', color: colors.edit },
  favourite: { label: 'Favourite', color: colors.fav },
  organize: { label: 'Organize', color: colors.organize },
  share: { label: 'Share', color: colors.share },
};

/** Tab-bar order, which is the order these appear everywhere else. */
export const ACTION_ORDER: readonly ActionKind[] = ['edit', 'favourite', 'organize', 'share'];

/** The filter value a pending-action chip carries. */
export function actionFilterOf(kind: ActionKind): ActionFilter {
  return `act:${kind}`;
}

/** The action a filter refers to (null when it is a verdict filter). */
export function actionKindOf(filter: string): ActionKind | null {
  if (!filter.startsWith('act:')) return null;
  const kind = filter.slice(4) as ActionKind;
  return kind in ACTION_META ? kind : null;
}

/** Label for any filter value, for the grid header. */
export function filterLabel(filter: EffectiveState | ActionFilter): string {
  const action = actionKindOf(filter);
  return action !== null ? ACTION_META[action].label : VERDICT_META[filter as EffectiveState].label;
}
