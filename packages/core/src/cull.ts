import type { MediaItem, PhotoState } from './types.js';

/**
 * The mobile culling session model (Companion m0.1) — the signature duel
 * mechanic from PLAN.md.
 *
 * - Each cull *group* (from time clustering) runs a pairwise DUEL bracket:
 *   two photos at a time; either cull one (loser leaves the bracket AND is
 *   staged for deletion) or keep both and pick the better (both stay kept;
 *   winner advances). Winners advance bracket-style until a single group
 *   "best" emerges.
 * - Every duel outcome is recorded as a {@link DuelRecord} — cheap byproduct
 *   data later features mine (auto-cull hints, ranking).
 * - Photos outside any group get a single-photo review pass.
 * - Culled photos sit in a reviewable staged list; un-culling restores a
 *   photo to `kept` (NOT back into its bracket). `confirmAll()` marks the
 *   staged set `confirmed`; the app performs the actual deletion and reports
 *   back which ids were `trashed`.
 * - The whole session serializes to plain JSON and restores mid-bracket.
 *
 * Pure logic: no Date.now() — decision timestamps are injected via `at`.
 */

/** One duel outcome. `keptBoth` false means the loser was culled. */
export interface DuelRecord {
  groupId: string;
  winnerId: string;
  loserId: string;
  keptBoth: boolean;
  /** Injected decision time, ms since epoch. */
  at: number;
}

/**
 * A duel decision:
 * - `{ cull: loserId }` — loser leaves the bracket and is staged for culling.
 * - `{ keepBoth: true, winner: id }` — both photos stay; the winner advances.
 */
export type DuelDecision = { cull: string } | { keepBoth: true; winner: string };

/**
 * Single-photo review actions for m0.1. Declared as a widening-friendly
 * union so m0.2 can add `'to_edit'` without breaking callers.
 */
export type SingleAction = 'keep' | 'cull';

/** The pair currently up for a duel. */
export interface DuelPair {
  groupId: string;
  a: MediaItem;
  b: MediaItem;
}

/** Minimal group input — `Cluster` from clustering.ts is assignable. */
export interface CullGroup {
  id: string;
  items: MediaItem[];
}

interface BracketState {
  groupId: string;
  /** All photo ids originally in the group. */
  photoIds: string[];
  /** Ids still to duel in the current round, in order. */
  currentRound: string[];
  /** Winners (and byes) advanced to the next round. */
  nextRound: string[];
  bestId: string | null;
  complete: boolean;
}

/** Plain-JSON snapshot of a whole session (versioned). */
export interface CullSessionJSON {
  version: 1;
  items: MediaItem[];
  brackets: BracketState[];
  singleIds: string[];
  states: Record<string, PhotoState>;
  duelHistory: DuelRecord[];
}

export interface CullSessionInput {
  /** Cull groups (typically clusters with >= 2 items). Order is review order. */
  groups: readonly CullGroup[];
  /** Photos outside any group, reviewed one at a time. */
  singles?: readonly MediaItem[];
}

export interface CullSessionSummary {
  total: number;
  unreviewed: number;
  kept: number;
  culled: number;
  confirmed: number;
  trashed: number;
}

export class CullSession {
  private itemsById = new Map<string, MediaItem>();
  private brackets: BracketState[] = [];
  private singleIds: string[] = [];
  private states = new Map<string, PhotoState>();
  private history: DuelRecord[] = [];

  private constructor() {}

  /** Start a fresh session from cull groups + singles. */
  static create(input: CullSessionInput): CullSession {
    const session = new CullSession();
    const seen = new Set<string>();
    const register = (item: MediaItem, where: string) => {
      if (seen.has(item.id)) {
        throw new Error(`CullSession: duplicate photo id "${item.id}" (${where})`);
      }
      seen.add(item.id);
      session.itemsById.set(item.id, item);
      session.states.set(item.id, 'unreviewed');
    };
    const groupIds = new Set<string>();
    for (const group of input.groups) {
      if (groupIds.has(group.id)) {
        throw new Error(`CullSession: duplicate group id "${group.id}"`);
      }
      groupIds.add(group.id);
      if (group.items.length === 0) continue;
      for (const item of group.items) register(item, `group ${group.id}`);
      const bracket: BracketState = {
        groupId: group.id,
        photoIds: group.items.map((i) => i.id),
        currentRound: group.items.map((i) => i.id),
        nextRound: [],
        bestId: null,
        complete: false,
      };
      session.brackets.push(bracket);
      session.normalize(bracket);
    }
    for (const item of input.singles ?? []) {
      register(item, 'singles');
      session.singleIds.push(item.id);
    }
    return session;
  }

  // ---------------------------------------------------------------- duels

  /**
   * The next duel to present, or null when every bracket is complete.
   * Pure peek — repeated calls return the same pair until decideDuel().
   */
  nextPair(): DuelPair | null {
    const bracket = this.brackets.find((b) => !b.complete);
    if (!bracket) return null;
    // normalize() guarantees an incomplete bracket has >= 2 in currentRound.
    return {
      groupId: bracket.groupId,
      a: this.item(bracket.currentRound[0]),
      b: this.item(bracket.currentRound[1]),
    };
  }

  /**
   * Decide the current duel (the pair from nextPair()). `at` is the injected
   * decision timestamp. Returns the recorded DuelRecord.
   */
  decideDuel(decision: DuelDecision, at: number): DuelRecord {
    const pair = this.nextPair();
    if (!pair) throw new Error('decideDuel: no duel pending');
    const bracket = this.brackets.find((b) => b.groupId === pair.groupId)!;
    const ids = [pair.a.id, pair.b.id];

    let winnerId: string;
    let loserId: string;
    let keptBoth: boolean;
    if ('cull' in decision) {
      loserId = decision.cull;
      if (!ids.includes(loserId)) {
        throw new Error(`decideDuel: ${loserId} is not in the current pair`);
      }
      winnerId = ids[0] === loserId ? ids[1] : ids[0];
      keptBoth = false;
      this.states.set(loserId, 'culled');
    } else {
      winnerId = decision.winner;
      if (!ids.includes(winnerId)) {
        throw new Error(`decideDuel: ${winnerId} is not in the current pair`);
      }
      loserId = ids[0] === winnerId ? ids[1] : ids[0];
      keptBoth = true;
      // Out of the bracket but staying: kept immediately.
      this.states.set(loserId, 'kept');
    }

    bracket.currentRound.splice(0, 2);
    bracket.nextRound.push(winnerId);
    const record: DuelRecord = { groupId: bracket.groupId, winnerId, loserId, keptBoth, at };
    this.history.push(record);
    this.normalize(bracket);
    return record;
  }

  /** Every duel outcome so far, in decision order. */
  get duelHistory(): readonly DuelRecord[] {
    return [...this.history];
  }

  /** The group's bracket winner, once its bracket is complete. */
  groupBest(groupId: string): MediaItem | null {
    const bracket = this.bracket(groupId);
    return bracket.bestId ? this.item(bracket.bestId) : null;
  }

  /** Whether the group's bracket has finished. */
  isGroupComplete(groupId: string): boolean {
    return this.bracket(groupId).complete;
  }

  /**
   * Kept photos in the group that never won a duel — fodder for the
   * "you kept 9, reconsider these 3?" second pass. Excludes the group best
   * and anything culled. Meaningful once the group's bracket is complete.
   */
  autoCullCandidates(groupId: string): MediaItem[] {
    const bracket = this.bracket(groupId);
    const winners = new Set(
      this.history.filter((r) => r.groupId === groupId).map((r) => r.winnerId),
    );
    return bracket.photoIds
      .filter(
        (id) =>
          this.states.get(id) === 'kept' && !winners.has(id) && id !== bracket.bestId,
      )
      .map((id) => this.item(id));
  }

  // -------------------------------------------------------------- singles

  /** The next unreviewed single photo, or null when singles are done. */
  nextSingle(): MediaItem | null {
    const id = this.singleIds.find((sid) => this.states.get(sid) === 'unreviewed');
    return id ? this.item(id) : null;
  }

  /** Decide a pending single: keep or cull (m0.2 adds to_edit). */
  decideSingle(id: string, action: SingleAction): void {
    if (!this.singleIds.includes(id)) {
      throw new Error(`decideSingle: ${id} is not a single in this session`);
    }
    if (this.states.get(id) !== 'unreviewed') {
      throw new Error(`decideSingle: ${id} already reviewed (${this.states.get(id)})`);
    }
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
   * Un-cull: restore a staged photo to `kept`. It does NOT re-enter its
   * bracket — the duel that removed it stands in the history.
   */
  unstageCull(id: string): void {
    this.requireState(id, 'culled', 'unstageCull');
    this.states.set(id, 'kept');
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

  /** True when every bracket is complete and every single is reviewed. */
  isComplete(): boolean {
    return (
      this.brackets.every((b) => b.complete) &&
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
  toJSON(): CullSessionJSON {
    return {
      version: 1,
      items: [...this.itemsById.values()].map((i) => ({ ...i })),
      brackets: this.brackets.map((b) => ({
        groupId: b.groupId,
        photoIds: [...b.photoIds],
        currentRound: [...b.currentRound],
        nextRound: [...b.nextRound],
        bestId: b.bestId,
        complete: b.complete,
      })),
      singleIds: [...this.singleIds],
      states: Object.fromEntries(this.states),
      duelHistory: this.history.map((r) => ({ ...r })),
    };
  }

  /** Restore a session snapshot (already-parsed JSON object). */
  static fromJSON(json: unknown): CullSession {
    if (typeof json !== 'object' || json === null) {
      throw new Error('CullSession.fromJSON: not an object');
    }
    const snap = json as CullSessionJSON;
    if (snap.version !== 1) {
      throw new Error(`CullSession.fromJSON: unsupported version ${String(snap.version)}`);
    }
    if (
      !Array.isArray(snap.items) ||
      !Array.isArray(snap.brackets) ||
      !Array.isArray(snap.singleIds) ||
      !Array.isArray(snap.duelHistory) ||
      typeof snap.states !== 'object' ||
      snap.states === null
    ) {
      throw new Error('CullSession.fromJSON: malformed snapshot');
    }
    const session = new CullSession();
    for (const item of snap.items) session.itemsById.set(item.id, { ...item });
    session.brackets = snap.brackets.map((b) => ({
      groupId: b.groupId,
      photoIds: [...b.photoIds],
      currentRound: [...b.currentRound],
      nextRound: [...b.nextRound],
      bestId: b.bestId ?? null,
      complete: !!b.complete,
    }));
    session.singleIds = [...snap.singleIds];
    session.states = new Map(Object.entries(snap.states) as [string, PhotoState][]);
    session.history = snap.duelHistory.map((r) => ({ ...r }));
    // Sanity: every referenced id must exist.
    for (const [id] of session.states) {
      if (!session.itemsById.has(id)) {
        throw new Error(`CullSession.fromJSON: state for unknown id ${id}`);
      }
    }
    return session;
  }

  // ------------------------------------------------------------ internal

  private item(id: string): MediaItem {
    const item = this.itemsById.get(id);
    if (!item) throw new Error(`CullSession: unknown photo id ${id}`);
    return item;
  }

  private bracket(groupId: string): BracketState {
    const bracket = this.brackets.find((b) => b.groupId === groupId);
    if (!bracket) throw new Error(`CullSession: unknown group ${groupId}`);
    return bracket;
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

  /**
   * Advance bracket bookkeeping until it either has a playable pair or is
   * complete. Handles byes (odd rounds) and round promotion.
   */
  private normalize(bracket: BracketState): void {
    while (!bracket.complete) {
      const alive = bracket.currentRound.length + bracket.nextRound.length;
      if (alive <= 1) {
        bracket.bestId = bracket.currentRound[0] ?? bracket.nextRound[0] ?? null;
        bracket.complete = true;
        // Everything still standing (never culled) is now kept.
        for (const id of bracket.photoIds) {
          if (this.states.get(id) === 'unreviewed') this.states.set(id, 'kept');
        }
        return;
      }
      if (bracket.currentRound.length >= 2) return; // playable pair available
      if (bracket.currentRound.length === 1) {
        // Odd round: the leftover gets a bye into the next round.
        bracket.nextRound.push(bracket.currentRound.shift()!);
      }
      bracket.currentRound = bracket.nextRound;
      bracket.nextRound = [];
    }
  }
}
