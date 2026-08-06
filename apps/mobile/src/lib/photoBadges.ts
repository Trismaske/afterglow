/**
 * Which badges a photo wears, in one order every surface shares (m0.8.1
 * round 4 — pure). The four actions (edit, favourite, organize, share)
 * badge ALIKE and independently: none replaces another, and none replaces
 * the verdict, so a kept photo queued for editing and sharing shows check
 * + pencil + share together (components/DecisionBadge.tsx's BadgeCluster
 * wraps them into the anchor).
 *
 * Order = verdict first (the decision is what the eye looks for), then
 * best, then the actions in tab-bar order.
 *
 * m0.8.2 — TWO WEIGHTS, because the four actions now align on one rule
 * (docs/STATE_MODEL.md, layer 2):
 *
 * - `live`    — the action is WAITING for you. Full action colour on its
 *               tinted disc: the loud badges are the to-do list, and they
 *               are exactly the set the tab badges and queue screens count.
 * - `carried` — the action HAPPENED. Same glyph, same hue, quieter and on
 *               a plain disc: a permanent property of the photo, not a
 *               chore. Never grey — a greyed action reads as disabled.
 *
 * The deck and Groups read each photo's per-action weight from
 * ReviewContext's `actionWeights`.
 *
 * The verdict and the best star have no lifecycle, so they always render
 * at full strength. (The time-attached scan annotation is deliberately
 * NOT a badge since m0.8.2 — it is internal scan quality the user cannot
 * act on, and the scan itself rewrites it once embeddings land.)
 */
import type { PhotoState } from '@afterglow/core';
import type { DecisionKind } from '../components/DecisionBadge';

/** Where an action sits: waiting for you, or done and carried. */
export type BadgeWeight = 'live' | 'carried';

export interface PhotoBadge {
  kind: DecisionKind;
  weight: BadgeWeight;
}

export interface PhotoBadgeInput {
  /** Durable review state; 'unreviewed' contributes no verdict badge. */
  state: PhotoState;
  /** Per-action weight, or null when the photo carries no such action. */
  edit: BadgeWeight | null;
  /** Favourite adds a third state (grilling Q5): 'removing' renders the
   * heart-off glyph at the live weight — a queued switch-off is waiting
   * work, and it must read apart from queued-apply and applied. */
  favourite: BadgeWeight | 'removing' | null;
  organize: BadgeWeight | null;
  share: BadgeWeight | null;
  /** Best-of-group star (group surfaces only). */
  best?: boolean;
}

export function photoBadges(input: PhotoBadgeInput): PhotoBadge[] {
  const badges: PhotoBadge[] = [];
  // Layer 1, the verdict. 'trashed' photos never render in a review
  // surface, so only the two live verdicts badge.
  if (input.state === 'culled') badges.push({ kind: 'cull', weight: 'live' });
  else if (input.state === 'kept') badges.push({ kind: 'keep', weight: 'live' });
  if (input.best) badges.push({ kind: 'best', weight: 'live' });
  if (input.edit) badges.push({ kind: 'edit', weight: input.edit });
  if (input.favourite === 'removing') badges.push({ kind: 'fav_off', weight: 'live' });
  else if (input.favourite) badges.push({ kind: 'fav', weight: input.favourite });
  if (input.organize) badges.push({ kind: 'organize', weight: input.organize });
  if (input.share) badges.push({ kind: 'share', weight: input.share });
  return badges;
}
