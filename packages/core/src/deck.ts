import type { MediaItem, PhotoState } from './types.js';
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
 *   keeps working. Reconsider ("auto-cull") hints derive from compares
 *   only: the losers of explicit compares that remain kept.
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
    // Reinsert in memberIds order: before the first alive id that follows it.
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
   * Reconsider ("auto-cull hint") candidates for a group, m0.4 rule:
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
   * Second-pass cull of an already-kept photo (the Reconsider screen).
   * The bracket model needed a snapshot rewrite for this; the deck model
   * supports it directly.
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
    const snap = json as DeckSessionJSON;
    if (snap.kind !== 'deck') {
      throw new Error(`DeckSession.fromJSON: not a deck snapshot (kind ${String(snap.kind)})`);
    }
    if (snap.version !== 1) {
      throw new Error(`DeckSession.fromJSON: unsupported version ${String(snap.version)}`);
    }
    if (
      !Array.isArray(snap.items) ||
      !Array.isArray(snap.groups) ||
      !Array.isArray(snap.singleIds) ||
      !Array.isArray(snap.compareHistory) ||
      typeof snap.states !== 'object' ||
      snap.states === null
    ) {
      throw new Error('DeckSession.fromJSON: malformed snapshot');
    }
    const session = new DeckSession();
    for (const item of snap.items) session.itemsById.set(item.id, { ...item });
    session.groups = snap.groups.map((g) => ({
      groupId: g.groupId,
      memberIds: [...g.memberIds],
      aliveIds: [...g.aliveIds],
      cursor: clampCursor(g.cursor, g.aliveIds.length),
      complete: !!g.complete,
      bestId: g.bestId ?? null,
    }));
    session.singleIds = [...snap.singleIds];
    session.states = new Map(Object.entries(snap.states) as [string, PhotoState][]);
    session.history = snap.compareHistory.map((r) => ({ ...r }));
    for (const [id] of session.states) {
      if (!session.itemsById.has(id)) {
        throw new Error(`DeckSession.fromJSON: state for unknown id ${id}`);
      }
    }
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
