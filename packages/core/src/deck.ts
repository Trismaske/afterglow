import { PHOTO_STATES, type MediaItem, type PhotoState } from './types.js';
import type { CullGroup, CullSessionInput, CullSessionSummary, DuelRecord } from './cull.js';

/**
 * The mobile swipe-deck review model (Companion m0.4) — the successor to
 * the pairwise duel bracket for group review, added ALONGSIDE cull.ts
 * (the bracket `CullSession` stays exported and intact; desktop may reuse
 * it later).
 *
 * - Each cull group is a swipeable stack: the user pages through the
 *   group's *alive* members (position "2/3"), culling any photo as they
 *   meet it. "Keep rest" finishes the group — every remaining unreviewed
 *   member is kept. The staged-cull → confirm → trash flow is UNCHANGED
 *   from the bracket model (same {@link PhotoState} machine).
 * - Explicit A/B compares (the on-demand compare tool) are recorded with
 *   the {@link DuelRecord} shape so the existing duel-history storage
 *   keeps working. Compare-loser analysis remains available for future
 *   consumers without interrupting the app's primary review flow.
 * - `makeSingle(id)` is the escape hatch for a mis-grouped photo: it
 *   leaves its group and joins the singles flow.
 * - Serializes to plain JSON (`kind: 'deck'`) and restores mid-deck. A
 *   bracket-era snapshot is NOT restorable as a deck — `fromJSON` rejects
 *   it (callers discard the in-flight session; reviewed states in the
 *   app's database are the durable truth).
 *
 * Pure logic: no Date.now() — timestamps are injected via `at`.
 */

interface DeckGroupState {
  groupId: string;
  /** Current members, in original order (photos moved out via makeSingle leave). */
  memberIds: string[];
  /** Members still in the deck: not culled. Order follows memberIds. */
  aliveIds: string[];
  /** Index into aliveIds — the photo currently facing the user. */
  cursor: number;
  /** True once keepRest() ran or the deck emptied. */
  complete: boolean;
  /** The user's starred "best of group", if any. */
  bestId: string | null;
}

/** Read-only view of one group's deck. */
export interface DeckGroupInfo {
  id: string;
  memberIds: readonly string[];
  aliveIds: readonly string[];
  cursor: number;
  complete: boolean;
  bestId: string | null;
}

/** Plain-JSON snapshot of a whole deck session (versioned + discriminated). */
export interface DeckSessionJSON {
  version: 1;
  kind: 'deck';
  items: MediaItem[];
  groups: DeckGroupState[];
  singleIds: string[];
  states: Record<string, PhotoState>;
  /** Explicit compare outcomes, DuelRecord-shaped (duels table compatible). */
  compareHistory: DuelRecord[];
}

export class DeckSession {
  private itemsById = new Map<string, MediaItem>();
  private groups: DeckGroupState[] = [];
  private singleIds: string[] = [];
  private states = new Map<string, PhotoState>();
  private history: DuelRecord[] = [];

  private constructor() {}

  /** Start a fresh session from cull groups + singles (same input as CullSession). */
  static create(input: CullSessionInput): DeckSession {
    const session = new DeckSession();
    const seen = new Set<string>();
    const register = (item: MediaItem, where: string) => {
      if (seen.has(item.id)) {
        throw new Error(`DeckSession: duplicate photo id "${item.id}" (${where})`);
      }
      seen.add(item.id);
      session.itemsById.set(item.id, item);
      session.states.set(item.id, 'unreviewed');
    };
    const groupIds = new Set<string>();
    for (const group of input.groups as readonly CullGroup[]) {
      if (groupIds.has(group.id)) {
        throw new Error(`DeckSession: duplicate group id "${group.id}"`);
      }
      groupIds.add(group.id);
      if (group.items.length === 0) continue;
      for (const item of group.items) register(item, `group ${group.id}`);
      session.groups.push({
        groupId: group.id,
        memberIds: group.items.map((i) => i.id),
        aliveIds: group.items.map((i) => i.id),
        cursor: 0,
        complete: false,
        bestId: null,
      });
    }
    for (const item of input.singles ?? []) {
      register(item, 'singles');
      session.singleIds.push(item.id);
    }
    return session;
  }

  // ------------------------------------------------------------ group deck

  /** The first incomplete group — review order — or null when groups are done. */
  currentGroupId(): string | null {
    return this.groups.find((g) => !g.complete)?.groupId ?? null;
  }

  /** Read-only info for every group, in review order. */
  groupsInfo(): DeckGroupInfo[] {
    return this.groups.map((g) => this.infoOf(g));
  }

  /** Read-only info for one group. */
  groupInfo(groupId: string): DeckGroupInfo {
    return this.infoOf(this.group(groupId));
  }

  /** Move the deck cursor (clamped to the alive range). */
  setCursor(groupId: string, index: number): void {
    const group = this.group(groupId);
    group.cursor = clampCursor(index, group.aliveIds.length);
  }

  /**
   * Cull an alive, unreviewed deck member: it leaves the deck and joins the
   * staged cull list. An emptied deck completes its group automatically.
   */
  cull(id: string): void {
    const group = this.aliveGroupOf(id, 'cull');
    this.requireState(id, 'unreviewed', 'cull');
    this.states.set(id, 'culled');
    this.removeFromDeck(group, id);
  }

  /**
   * Decide one live group member as kept. This is used by metadata actions
   * such as Favourite that imply a keep without finishing the whole group.
   * The member leaves the undecided deck; clearing the decision reinserts it
   * at its original position.
   */
  keep(id: string): void {
    const group = this.aliveGroupOf(id, 'keep');
    this.requireState(id, 'unreviewed', 'keep');
    this.states.set(id, 'kept');
    this.removeFromDeck(group, id);
  }

  /**
   * Undo a deck cull (the brief undo affordance): the photo returns to
   * `unreviewed` and re-enters its deck at its original position. Only
   * valid while the group is still incomplete.
   */
  undoCull(id: string): void {
    this.requireState(id, 'culled', 'undoCull');
    const group = this.groups.find((g) => g.memberIds.includes(id));
    if (!group) throw new Error(`undoCull: ${id} is not a group member`);
    if (group.complete) {
      throw new Error(`undoCull: group ${group.groupId} already complete — use unstageCull`);
    }
    this.states.set(id, 'unreviewed');
    this.reinsert(group, id);
  }

  /**
   * Clear an active keep/cull decision (m0.6 tap-again-to-clear): back to
   * `unreviewed`.
   * A group member re-opens its group (`complete` resets) so keepRest can
   * finish it again; a kept photo that had left the deck via a cull →
   * unstageCull round trip re-enters at its original position. Singles
   * simply rejoin the pending queue.
   */
  clearDecision(id: string): void {
    const state = this.getState(id);
    if (state !== 'kept' && state !== 'culled') {
      throw new Error(`clearDecision: expected kept or culled, got ${state} for ${id}`);
    }
    this.states.set(id, 'unreviewed');
    const group = this.groups.find((g) => g.memberIds.includes(id));
    if (!group) return;
    if (!group.aliveIds.includes(id)) this.reinsert(group, id);
    group.complete = false;
  }

  /** Backward-compatible kept-only alias used by older callers. */
  unkeep(id: string): void {
    this.requireState(id, 'kept', 'unkeep');
    this.clearDecision(id);
  }

  /**
   * Finish the group: every alive, still-unreviewed member is kept
   * (survivors win). The group completes.
   */
  keepRest(groupId: string): void {
    const group = this.group(groupId);
    if (group.complete) throw new Error(`keepRest: group ${groupId} already complete`);
    for (const id of group.aliveIds) {
      if (this.states.get(id) === 'unreviewed') this.states.set(id, 'kept');
    }
    group.complete = true;
  }

  /**
   * Star (or unstar, with null) the group's single best. The best must be
   * an alive member; culling or un-grouping it clears the star.
   */
  markBest(groupId: string, id: string | null): void {
    const group = this.group(groupId);
    if (id !== null && !group.aliveIds.includes(id)) {
      throw new Error(`markBest: ${id} is not an alive member of ${groupId}`);
    }
    group.bestId = id;
  }

  /**
   * "Not related — review as single": the photo leaves its group entirely
   * (group id, deck, best star) and is appended to the singles queue,
   * still unreviewed. An emptied deck completes its group.
   */
  makeSingle(id: string): void {
    const group = this.aliveGroupOf(id, 'makeSingle');
    this.requireState(id, 'unreviewed', 'makeSingle');
    group.memberIds = group.memberIds.filter((m) => m !== id);
    this.removeFromDeck(group, id);
    this.singleIds.push(id);
  }

  /**
   * Record an explicit A/B compare outcome (the on-demand compare tool).
   * DuelRecord-shaped so the existing duel-history storage keeps working.
   * `keptBoth: false` means the loser was culled — callers cull() first
   * (or after); this method only records. States are otherwise untouched:
   * deck photos stay unreviewed until culled or kept by keepRest().
   */
  recordCompare(winnerId: string, loserId: string, keptBoth: boolean, at: number): DuelRecord {
    if (winnerId === loserId) throw new Error('recordCompare: winner === loser');
    const group = this.groups.find(
      (g) => g.memberIds.includes(winnerId) && g.memberIds.includes(loserId),
    );
    if (!group) {
      throw new Error(`recordCompare: ${winnerId} and ${loserId} are not in the same group`);
    }
    const record: DuelRecord = { groupId: group.groupId, winnerId, loserId, keptBoth, at };
    this.history.push(record);
    return record;
  }

  /** Every recorded compare so far, in decision order. */
  get compareHistory(): readonly DuelRecord[] {
    return [...this.history];
  }

  /**
   * Compare-loser candidates for a group (retained analysis from m0.4):
   * kept photos that LOST an explicit compare, never won one, and are not
   * the starred best. A group finished with zero compares yields none —
   * merely surviving the deck is not a signal against a photo.
   */
  reconsiderCandidates(groupId: string): MediaItem[] {
    const group = this.group(groupId);
    const winners = new Set<string>();
    const losers = new Set<string>();
    for (const r of this.history) {
      if (r.groupId !== groupId) continue;
      winners.add(r.winnerId);
      losers.add(r.loserId);
    }
    return group.memberIds
      .filter(
        (id) =>
          this.states.get(id) === 'kept' &&
          losers.has(id) &&
          !winners.has(id) &&
          id !== group.bestId,
      )
      .map((id) => this.item(id));
  }

  /** Whether the group's deck has been finished. */
  isGroupComplete(groupId: string): boolean {
    return this.group(groupId).complete;
  }

  /** The group's starred best, if any. */
  groupBest(groupId: string): MediaItem | null {
    const best = this.group(groupId).bestId;
    return best ? this.item(best) : null;
  }

  // -------------------------------------------------------------- singles

  /** Ids in the singles queue, review order (made-singles append at the end). */
  get singles(): readonly string[] {
    return [...this.singleIds];
  }

  /** The next unreviewed single photo, or null when singles are done. */
  nextSingle(): MediaItem | null {
    const id = this.singleIds.find((sid) => this.states.get(sid) === 'unreviewed');
    return id ? this.item(id) : null;
  }

  /** Decide a pending single: keep or cull (the edit flag is app-side). */
  decideSingle(id: string, action: 'keep' | 'cull'): void {
    if (!this.singleIds.includes(id)) {
      throw new Error(`decideSingle: ${id} is not a single in this session`);
    }
    this.requireState(id, 'unreviewed', 'decideSingle');
    if (action === 'keep') this.states.set(id, 'kept');
    else if (action === 'cull') this.states.set(id, 'culled');
    else throw new Error(`decideSingle: unknown action ${String(action)}`);
  }

  // ------------------------------------------------------- staged culls

  /** The staged cull list (reviewable before confirming), in session order. */
  stagedCulls(): MediaItem[] {
    return this.idsInState('culled').map((id) => this.item(id));
  }

  /**
   * Un-cull from the staged list: back to `kept`. It does NOT re-enter its
   * deck (that's undoCull, only while the group is live) — same semantics
   * as the bracket model.
   */
  unstageCull(id: string): void {
    this.requireState(id, 'culled', 'unstageCull');
    this.states.set(id, 'kept');
  }

  /**
   * Re-decide an already-kept photo as culled. The bracket model needed a
   * snapshot rewrite for this; the deck model supports it directly.
   */
  cullKept(id: string): void {
    this.requireState(id, 'kept', 'cullKept');
    this.states.set(id, 'culled');
  }

  /**
   * Confirm the staged list: every `culled` photo becomes `confirmed`.
   * Returns the confirmed ids; the app deletes them (system trash) and
   * reports back via markTrashed().
   */
  confirmAll(): string[] {
    const ids = this.idsInState('culled');
    for (const id of ids) this.states.set(id, 'confirmed');
    return ids;
  }

  /** The app reports deletions: each confirmed id becomes `trashed`. */
  markTrashed(ids: readonly string[]): void {
    for (const id of ids) this.requireState(id, 'confirmed', 'markTrashed');
    for (const id of ids) this.states.set(id, 'trashed');
  }

  // ------------------------------------------------------------- queries

  getState(id: string): PhotoState {
    const state = this.states.get(id);
    if (!state) throw new Error(`getState: unknown photo id ${id}`);
    return state;
  }

  /** Look up a session photo by id. */
  item(id: string): MediaItem {
    const item = this.itemsById.get(id);
    if (!item) throw new Error(`DeckSession: unknown photo id ${id}`);
    return item;
  }

  /** True when every group is complete and every single is reviewed. */
  isComplete(): boolean {
    return (
      this.groups.every((g) => g.complete) &&
      this.singleIds.every((id) => this.states.get(id) !== 'unreviewed')
    );
  }

  summary(): CullSessionSummary {
    const s: CullSessionSummary = {
      total: this.itemsById.size,
      unreviewed: 0,
      kept: 0,
      culled: 0,
      confirmed: 0,
      trashed: 0,
    };
    for (const state of this.states.values()) {
      if (state === 'unreviewed') s.unreviewed++;
      else if (state === 'kept') s.kept++;
      else if (state === 'culled') s.culled++;
      else if (state === 'confirmed') s.confirmed++;
      else if (state === 'trashed') s.trashed++;
    }
    return s;
  }

  // ------------------------------------------------------- serialization

  /** Plain-JSON snapshot; safe for JSON.stringify. */
  toJSON(): DeckSessionJSON {
    return {
      version: 1,
      kind: 'deck',
      items: [...this.itemsById.values()].map((i) => ({ ...i })),
      groups: this.groups.map((g) => ({
        groupId: g.groupId,
        memberIds: [...g.memberIds],
        aliveIds: [...g.aliveIds],
        cursor: g.cursor,
        complete: g.complete,
        bestId: g.bestId,
      })),
      singleIds: [...this.singleIds],
      states: Object.fromEntries(this.states),
      compareHistory: this.history.map((r) => ({ ...r })),
    };
  }

  /**
   * Restore a deck snapshot (already-parsed JSON object). Throws on
   * anything that isn't a `kind: 'deck'` snapshot — including bracket-era
   * CullSession snapshots, which are deliberately not migrated (callers
   * discard the in-flight session; the app's reviewed-state rows are the
   * durable truth).
   */
  static fromJSON(json: unknown): DeckSession {
    if (typeof json !== 'object' || json === null) {
      throw new Error('DeckSession.fromJSON: not an object');
    }
    const raw = json as Record<string, unknown>;
    if (raw.kind !== 'deck') {
      throw new Error(`DeckSession.fromJSON: not a deck snapshot (kind ${String(raw.kind)})`);
    }
    if (raw.version !== 1) {
      throw new Error(`DeckSession.fromJSON: unsupported version ${String(raw.version)}`);
    }
    if (
      !Array.isArray(raw.items) ||
      !Array.isArray(raw.groups) ||
      !Array.isArray(raw.singleIds) ||
      !Array.isArray(raw.compareHistory) ||
      !isRecord(raw.states)
    ) {
      throw new Error('DeckSession.fromJSON: malformed snapshot');
    }

    const items: MediaItem[] = [];
    const itemIds = new Set<string>();
    for (const value of raw.items) {
      if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        typeof value.timestamp !== 'number' ||
        !Number.isFinite(value.timestamp) ||
        typeof value.uri !== 'string' ||
        (value.kind !== 'photo' && value.kind !== 'video')
      ) {
        throw new Error('DeckSession.fromJSON: malformed media item');
      }
      if (itemIds.has(value.id)) {
        throw new Error(`DeckSession.fromJSON: duplicate photo id ${value.id}`);
      }
      itemIds.add(value.id);
      items.push({ id: value.id, timestamp: value.timestamp, uri: value.uri, kind: value.kind });
    }

    const stateEntries = Object.entries(raw.states);
    const validStates = new Set<string>(PHOTO_STATES);
    const states = new Map<string, PhotoState>();
    for (const [id, value] of stateEntries) {
      if (!itemIds.has(id)) throw new Error(`DeckSession.fromJSON: state for unknown id ${id}`);
      if (typeof value !== 'string' || !validStates.has(value)) {
        throw new Error(`DeckSession.fromJSON: invalid state for ${id}`);
      }
      states.set(id, value as PhotoState);
    }
    for (const id of itemIds) {
      if (!states.has(id)) throw new Error(`DeckSession.fromJSON: missing state for ${id}`);
    }

    const groups: DeckGroupState[] = [];
    const groupIds = new Set<string>();
    const assigned = new Set<string>();
    const membersByGroup = new Map<string, Set<string>>();
    for (const value of raw.groups) {
      if (
        !isRecord(value) ||
        typeof value.groupId !== 'string' ||
        value.groupId.length === 0 ||
        !Array.isArray(value.memberIds) ||
        !Array.isArray(value.aliveIds) ||
        typeof value.cursor !== 'number' ||
        !Number.isFinite(value.cursor) ||
        typeof value.complete !== 'boolean' ||
        !(value.bestId === null || typeof value.bestId === 'string')
      ) {
        throw new Error('DeckSession.fromJSON: malformed group');
      }
      if (groupIds.has(value.groupId)) {
        throw new Error(`DeckSession.fromJSON: duplicate group id ${value.groupId}`);
      }
      groupIds.add(value.groupId);
      const memberIds = stringIdArray(value.memberIds, 'group member');
      const aliveIds = stringIdArray(value.aliveIds, 'alive member');
      const members = new Set(memberIds);
      if (members.size !== memberIds.length) {
        throw new Error(`DeckSession.fromJSON: duplicate member in ${value.groupId}`);
      }
      const alive = new Set(aliveIds);
      if (alive.size !== aliveIds.length) {
        throw new Error(`DeckSession.fromJSON: duplicate alive member in ${value.groupId}`);
      }
      for (const id of memberIds) {
        if (!itemIds.has(id)) throw new Error(`DeckSession.fromJSON: unknown group member ${id}`);
        if (assigned.has(id)) throw new Error(`DeckSession.fromJSON: photo ${id} assigned twice`);
        assigned.add(id);
      }
      for (const id of aliveIds) {
        if (!members.has(id)) throw new Error(`DeckSession.fromJSON: alive non-member ${id}`);
        const state = states.get(id)!;
        if (state === 'culled' || state === 'confirmed' || state === 'trashed') {
          throw new Error(`DeckSession.fromJSON: removed photo ${id} is still alive`);
        }
      }
      for (const id of memberIds) {
        if (states.get(id) === 'unreviewed' && !alive.has(id)) {
          throw new Error(`DeckSession.fromJSON: unreviewed photo ${id} is outside its deck`);
        }
      }
      if (value.bestId !== null && !alive.has(value.bestId)) {
        throw new Error(`DeckSession.fromJSON: best photo is not alive in ${value.groupId}`);
      }
      membersByGroup.set(value.groupId, members);
      groups.push({
        groupId: value.groupId,
        memberIds,
        aliveIds,
        cursor: clampCursor(value.cursor, aliveIds.length),
        complete: value.complete,
        bestId: value.bestId,
      });
    }

    const singleIds = stringIdArray(raw.singleIds, 'single');
    if (new Set(singleIds).size !== singleIds.length) {
      throw new Error('DeckSession.fromJSON: duplicate single');
    }
    for (const id of singleIds) {
      if (!itemIds.has(id)) throw new Error(`DeckSession.fromJSON: unknown single ${id}`);
      if (assigned.has(id)) throw new Error(`DeckSession.fromJSON: photo ${id} assigned twice`);
      assigned.add(id);
    }
    if (assigned.size !== itemIds.size) {
      throw new Error('DeckSession.fromJSON: one or more photos are not assigned');
    }

    const history: DuelRecord[] = raw.compareHistory.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.groupId !== 'string' ||
        typeof value.winnerId !== 'string' ||
        typeof value.loserId !== 'string' ||
        value.winnerId === value.loserId ||
        typeof value.keptBoth !== 'boolean' ||
        typeof value.at !== 'number' ||
        !Number.isFinite(value.at)
      ) {
        throw new Error('DeckSession.fromJSON: malformed compare record');
      }
      const members = membersByGroup.get(value.groupId);
      if (!members?.has(value.winnerId) || !members.has(value.loserId)) {
        throw new Error('DeckSession.fromJSON: compare photos are not in their group');
      }
      return {
        groupId: value.groupId,
        winnerId: value.winnerId,
        loserId: value.loserId,
        keptBoth: value.keptBoth,
        at: value.at,
      };
    });

    const session = new DeckSession();
    for (const item of items) session.itemsById.set(item.id, item);
    session.groups = groups;
    session.singleIds = singleIds;
    session.states = states;
    session.history = history;
    return session;
  }

  // ------------------------------------------------------------ internal

  private infoOf(g: DeckGroupState): DeckGroupInfo {
    return {
      id: g.groupId,
      memberIds: [...g.memberIds],
      aliveIds: [...g.aliveIds],
      cursor: g.cursor,
      complete: g.complete,
      bestId: g.bestId,
    };
  }

  private group(groupId: string): DeckGroupState {
    const group = this.groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error(`DeckSession: unknown group ${groupId}`);
    return group;
  }

  /** The live (incomplete) group in whose deck `id` currently sits. */
  private aliveGroupOf(id: string, op: string): DeckGroupState {
    const group = this.groups.find((g) => g.aliveIds.includes(id));
    if (!group) throw new Error(`${op}: ${id} is not in any deck`);
    if (group.complete) throw new Error(`${op}: group ${group.groupId} already complete`);
    return group;
  }

  /** Reinsert an id into its deck in memberIds order; cursor lands on it. */
  private reinsert(group: DeckGroupState, id: string): void {
    // Before the first alive id that follows it in the original order.
    const order = new Map(group.memberIds.map((m, i) => [m, i]));
    const myPos = order.get(id)!;
    let insertAt = group.aliveIds.length;
    for (let i = 0; i < group.aliveIds.length; i++) {
      if (order.get(group.aliveIds[i])! > myPos) {
        insertAt = i;
        break;
      }
    }
    group.aliveIds.splice(insertAt, 0, id);
    group.cursor = insertAt;
  }

  /** Drop an id from a deck, fix the cursor/best, auto-complete if emptied. */
  private removeFromDeck(group: DeckGroupState, id: string): void {
    const index = group.aliveIds.indexOf(id);
    group.aliveIds.splice(index, 1);
    if (group.bestId === id) group.bestId = null;
    // Removing before the cursor shifts it left; removing AT the cursor
    // leaves it in place (the next photo slides in), clamped at the end.
    if (index < group.cursor) group.cursor -= 1;
    group.cursor = clampCursor(group.cursor, group.aliveIds.length);
    if (group.aliveIds.length === 0) group.complete = true;
  }

  private idsInState(state: PhotoState): string[] {
    const out: string[] = [];
    for (const [id, s] of this.states) if (s === state) out.push(id);
    return out;
  }

  private requireState(id: string, expected: PhotoState, op: string): void {
    const actual = this.states.get(id);
    if (!actual) throw new Error(`${op}: unknown photo id ${id}`);
    if (actual !== expected) {
      throw new Error(`${op}: ${id} is ${actual}, expected ${expected}`);
    }
  }
}

function clampCursor(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(index)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringIdArray(value: unknown[], label: string): string[] {
  if (!value.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error(`DeckSession.fromJSON: malformed ${label} id`);
  }
  return value as string[];
}
