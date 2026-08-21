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
 */
import type { PhotoState } from '@afterglow/core';
import type { DecisionKind } from '../components/DecisionBadge';
import { PRIMARY_VOLUME, volumeOf } from './mediaIdentity';

/** Where an action sits: waiting for you, or done and carried. */
export type BadgeWeight = 'live' | 'carried';

export interface PhotoBadge {
  kind: DecisionKind;
  weight: BadgeWeight;
  /** Text for the folder pill (kind 'folder'); glyph badges carry none. */
  label?: string;
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
  /** F19 (m0.8.7): the photo's parent-folder name — a quiet text pill
   * AFTER the glyph badges (facts render last and always quiet).
   * Null/absent = no folder badge. Derive with folderNameOfUri. */
  folder?: string | null;
  /** F14 (m0.8.7): the photo lives on a non-primary (SD) volume — the
   * quiet micro-SD glyph. Derive with isSdPhoto. */
  sdCard?: boolean;
}

/** The photo's parent-folder name from its uri (F19: "last folder name
 * only") — the segment just above the filename; null when the uri has no
 * usable directory (content:// uris, root files). */
export function folderNameOfUri(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith('file://')) return null;
  const segments = uri.slice('file://'.length).split('/').filter(Boolean);
  // Need at least a folder AND a filename.
  if (segments.length < 2) return null;
  const folder = segments[segments.length - 2];
  return folder.length > 0 ? decodeURIComponent(folder) : null;
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
  // Annotations LAST and always quiet (m0.8.7, F14/F19): facts about the
  // photo, never chores — they must not compete with the to-do badges.
  if (input.sdCard) badges.push({ kind: 'sd', weight: 'carried' });
  if (input.folder) badges.push({ kind: 'folder', weight: 'carried', label: input.folder });
  return badges;
}
