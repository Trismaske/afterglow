/**
 * Which badges a photo wears, in one order every surface shares (m0.8.1
 * round 4 — pure). The four actions (edit, favourite, organize, share)
 * badge ALIKE and independently: none replaces another, and none replaces
 * the verdict, so a kept photo queued for editing and sharing shows check
 * + pencil + share together (components/DecisionBadge.tsx's BadgeCluster
 * wraps them into the anchor).
 *
 * Order = verdict first (the decision is what the eye looks for), then
 * the actions in tab-bar order.
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
 * The verdict has no lifecycle, so it always renders at full strength.
 * (The time-attached scan annotation is deliberately
 * NOT a badge since m0.8.2 — it is internal scan quality the user cannot
 * act on, and the scan itself rewrites it once embeddings land.)
 *
 * m0.9 phase 7 — the KIND CHIP (G6/G7): a video, a motion photo or a GIF
 * carries its kind LAST, as a layer-3 annotation (docs/STATE_MODEL.md):
 * quiet, near-white, never an action hue; a plain photo carries none.
 * The folder and SD annotations left the cluster for the stage's
 * metadata corner (F31, lib/stageMeta): facts read wrong among the
 * action glyphs, and small squares carry no annotation at all.
 */
import type { PhotoState } from '@afterglow/core';
import type { DecisionKind } from '../components/DecisionBadge';
import type { AnimatedKind } from './animatedCells';
import { PRIMARY_VOLUME, volumeOf } from './mediaIdentity';

/** Where an action sits: waiting for you, or done and carried. */
export type BadgeWeight = 'live' | 'carried';

export interface PhotoBadge {
  kind: DecisionKind;
  weight: BadgeWeight;
}

/** The weighted per-kind action set a surface hydrates for its badges.
 * `favourite` adds a third state (grilling Q5): 'removing' renders the
 * heart-off glyph at the live weight — a queued switch-off is waiting
 * work, and it must read apart from queued-apply and applied. */
export interface WeightedActionSet {
  edit: BadgeWeight | null;
  favourite: BadgeWeight | 'removing' | null;
  organize: BadgeWeight | null;
  share: BadgeWeight | null;
}

/** Demote a hydrated weight set for its photo's verdict — the per-kind
 * suspension rule (m0.8.7, F21) in ONE place: share and edit stay live
 * on a staged cull (dispatchable work); favourite and organize demote
 * to carried there; a trashed photo demotes everything. */
export function demoteForState(
  state: PhotoState | null | undefined,
  set: WeightedActionSet,
): WeightedActionSet {
  const trashed = state === 'trashed';
  const suspended = state === 'culled' || trashed;
  const demote = (
    weight: BadgeWeight | 'removing' | null,
    demoted: boolean,
  ): BadgeWeight | 'removing' | null =>
    demoted && (weight === 'live' || weight === 'removing') ? 'carried' : weight;
  return {
    edit: demote(set.edit, trashed) as BadgeWeight | null,
    favourite: demote(set.favourite, suspended),
    organize: demote(set.organize, suspended) as BadgeWeight | null,
    share: demote(set.share, trashed) as BadgeWeight | null,
  };
}

export interface PhotoBadgeInput extends WeightedActionSet {
  /** Durable review state; 'unreviewed' contributes no verdict badge. */
  state: PhotoState;
  /** The kind chip (phase 7): what the item is beyond a plain photo
   * (lib/animatedCells `animatedKindOf`); null or absent = none. Only
   * the stage cluster draws it — thumbnails carry the kind MARK. */
  kind?: AnimatedKind | null;
}

/** Does this canonical id live on a non-primary (SD) volume? (F14). */
export function isSdPhoto(assetId: string): boolean {
  return volumeOf(assetId) !== PRIMARY_VOLUME;
}

export function photoBadges(input: PhotoBadgeInput): PhotoBadge[] {
  const badges: PhotoBadge[] = [];
  // Layer 1, the verdict. 'trashed' badges too since m0.8.6 (D9):
  // History's tombstone rows render executed culls, and D9 promises the
  // placeholder a verdict badge — the trash-can in cull-red, read apart
  // from a merely staged cull.
  if (input.state === 'culled') badges.push({ kind: 'cull', weight: 'live' });
  else if (input.state === 'kept') badges.push({ kind: 'keep', weight: 'live' });
  else if (input.state === 'trashed') badges.push({ kind: 'trashed', weight: 'live' });
  if (input.edit) badges.push({ kind: 'edit', weight: input.edit });
  if (input.favourite === 'removing') badges.push({ kind: 'fav_off', weight: 'live' });
  else if (input.favourite) badges.push({ kind: 'fav', weight: input.favourite });
  if (input.organize) badges.push({ kind: 'organize', weight: input.organize });
  if (input.share) badges.push({ kind: 'share', weight: input.share });
  // The annotation LAST and always quiet: a fact about the item, never
  // a chore — it must not compete with the to-do badges.
  if (input.kind) badges.push({ kind: input.kind, weight: 'carried' });
  return badges;
}
