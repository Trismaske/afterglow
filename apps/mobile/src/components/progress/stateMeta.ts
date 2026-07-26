/**
 * Display metadata per effective photo state (progress pages, m0.4).
 * The in-group swatch follows the dynamic accent (m0.4 theming), so the
 * record is built from the current accent; everything else is fixed.
 */
import { colors } from '../../theme';
import type { EffectiveState } from '../../lib/progress';

export interface StateMeta {
  label: string;
  hint: string;
  color: string;
}

/** Build the per-state metadata for the given accent color. */
export function stateMetaFor(accent: string): Record<EffectiveState, StateMeta> {
  return {
    unreviewed: {
      label: 'Unreviewed',
      hint: 'not looked at yet',
      color: colors.surfaceRaised,
    },
    in_group: {
      label: 'In groups',
      hint: 'waiting in a cull-group deck',
      color: accent,
    },
    to_edit: {
      label: 'To edit',
      hint: 'keepers waiting in the edit queue',
      color: colors.edit,
    },
    staged: {
      label: 'Staged cull',
      hint: 'staged for deletion, not yet confirmed',
      color: colors.cull,
    },
    done: {
      label: 'Done',
      hint: 'reviewed keepers + trashed culls',
      color: colors.keep,
    },
  };
}

/** Summary-row / filter order on the progress pages. */
export const STATE_ORDER: readonly EffectiveState[] = [
  'unreviewed',
  'in_group',
  'to_edit',
  'staged',
  'done',
];
