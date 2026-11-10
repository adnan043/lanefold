import {keyOrNull} from '../lib/position-key';

import type {BoardData, CardT, Delta, LaneT} from './api';

/**
 * Pure board state: no React, no network. The board screen keeps one `BoardData` in the query cache and
 * these functions return a NEW one for each change (a drag, an add, a poll's delta). Order is by `position`
 * (fractional-indexing keys, compared byte by byte like Postgres COLLATE "C"), then `id`.
 */
export const byPosition = (a: {position: string; id: number}, b: {position: string; id: number}) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id - b.id;

/** A key between two neighbours, or null when they are out of order (the caller then keeps the old key). */
export function keyBetween(before: string | null | undefined, after: string | null | undefined): string | null {
  return keyOrNull(before, after);
}

/** Where a card is now: its lane id and index, or null. */
export function findCard(lanes: LaneT[], cardId: number): {laneId: number; index: number} | null {
  for (const lane of lanes) {
    const index = lane.cards.findIndex(card => card.id === cardId);
    if (index >= 0) return {laneId: lane.id, index};
  }
  return null;
}

/**
 * Move a card to `index` of lane `toLaneId` (index counted WITHOUT the card). Counters follow when the lane
 * changes. `position` (when known) becomes the card's key.
 */
export function moveCardInLanes(lanes: LaneT[], cardId: number, toLaneId: number, index: number, position?: string): LaneT[] {
  const from = findCard(lanes, cardId);
  // The target lane is gone (archived by someone else, a stale drop): nothing moves, the card is never dropped.
  if (!from || !lanes.some(l => l.id === toLaneId)) return lanes;
  const card = lanes.find(l => l.id === from.laneId)!.cards[from.index]!;
  return lanes.map(lane => {
    let cards = lane.cards;
    let cardCount = lane.cardCount;
    if (lane.id === from.laneId) {
      cards = cards.filter(c => c.id !== cardId);
      if (from.laneId !== toLaneId) cardCount -= 1;
    }
    if (lane.id === toLaneId) {
      const next = [...cards];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, {...card, laneId: toLaneId, ...(position ? {position} : {})});
      cards = next;
      if (from.laneId !== toLaneId) cardCount += 1;
    }
    return cards === lane.cards && cardCount === lane.cardCount ? lane : {...lane, cards, cardCount};
  });
}

export function moveLaneInList(lanes: LaneT[], laneId: number, index: number, position?: string): LaneT[] {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return lanes;
  const rest = lanes.filter(l => l.id !== laneId);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, position ? {...lane, position} : lane);
  return rest;
}

/** Undo a failed lane move: put ONLY this lane back at `index` with its old `position`; other lanes keep their current state. */
export function revertLaneMove(lanes: LaneT[], laneId: number, index: number, position: string): LaneT[] {
  return moveLaneInList(lanes, laneId, index, position);
}

/**
 * Undo a failed card move: put ONLY this card back at `index` of lane `laneId` with its old `position`. Other
 * cards keep their current state (later optimistic edits survive). Does nothing when the card or the lane is gone.
 */
export function revertCardMove(lanes: LaneT[], cardId: number, laneId: number, index: number, position: string): LaneT[] {
  if (!findCard(lanes, cardId) || !lanes.some(l => l.id === laneId)) return lanes;
  return moveCardInLanes(lanes, cardId, laneId, index, position);
}

export const patchCard = (lanes: LaneT[], cardId: number, patch: Partial<CardT>): LaneT[] =>
  lanes.map(lane => (lane.cards.some(c => c.id === cardId) ? {...lane, cards: lane.cards.map(c => (c.id === cardId ? {...c, ...patch} : c))} : lane));

export const patchLane = (lanes: LaneT[], laneId: number, patch: Partial<LaneT>): LaneT[] =>
  lanes.map(lane => (lane.id === laneId ? {...lane, ...patch} : lane));

/** Remove a card (archive); the lane's counter follows. */
export function removeCard(lanes: LaneT[], cardId: number): LaneT[] {
  const at = findCard(lanes, cardId);
  if (!at) return lanes;
  return lanes.map(lane => (lane.id === at.laneId ? {...lane, cards: lane.cards.filter(c => c.id !== cardId), cardCount: Math.max(0, lane.cardCount - 1)} : lane));
}

/** Put a card back (undo of an archive) at its key; skipped when it is beyond the loaded part of its lane. */
export function insertCard(lanes: LaneT[], card: CardT): LaneT[] {
  return lanes.map(lane => {
    if (lane.id !== card.laneId || lane.cards.some(c => c.id === card.id)) return lane;
    const last = lane.cards.at(-1);
    const inWindow = !lane.hasMore || !last || byPosition(card, last) <= 0;
    return {
      ...lane,
      cardCount: lane.cardCount + 1,
      cards: inWindow ? [...lane.cards, card].sort(byPosition) : lane.cards,
    };
  });
}

/** Add new cards at the end of a lane (the server put them there). */
export function appendCards(lanes: LaneT[], laneId: number, cards: CardT[]): LaneT[] {
  return lanes.map(lane => {
    if (lane.id !== laneId) return lane;
    const known = new Set(lane.cards.map(c => c.id));
    const fresh = cards.filter(c => !known.has(c.id));
    return {...lane, cards: lane.hasMore ? lane.cards : [...lane.cards, ...fresh].sort(byPosition), cardCount: lane.cardCount + fresh.length};
  });
}

/**
 * The saved answer for a batch of new cards: the temporary (negative id) cards leave and the saved ones take
 * their place at the end of the lane. The counter is NOT touched: the temporaries already counted them, whether
 * or not later pages of the lane also brought the saved cards in.
 */
export function replaceTemps(lanes: LaneT[], laneId: number, tempIds: number[], saved: CardT[]): LaneT[] {
  const temps = new Set(tempIds);
  return lanes.map(lane => {
    if (lane.id !== laneId) return lane;
    const rest = lane.cards.filter(c => !temps.has(c.id));
    const known = new Set(rest.map(c => c.id));
    return {...lane, cards: [...rest, ...saved.filter(c => !known.has(c.id))].sort(byPosition)};
  });
}

/** Merge a lane's next page (load more) or its first one. */
export function mergeLanePage(lanes: LaneT[], laneId: number, items: CardT[], more: boolean): LaneT[] {
  return lanes.map(lane => {
    if (lane.id !== laneId) return lane;
    const known = new Set(lane.cards.map(c => c.id));
    return {...lane, cards: [...lane.cards, ...items.filter(c => !known.has(c.id))].sort(byPosition), loaded: true, hasMore: more};
  });
}

/** The cursor for a lane's next page. */
export const nextCursor = (lane: LaneT): string => {
  // Pending cards (negative id) have no saved key: the cursor is the last SAVED card.
  const last = [...lane.cards].reverse().find(c => c.id > 0);
  return last ? `${last.position}|${last.id}` : '';
};

/**
 * Apply a `changes` answer. Idempotent (our own writes come back in it too): a card is removed everywhere
 * first, then re-inserted into its lane when that lane has loaded far enough to hold it.
 */
export function applyChanges(data: BoardData, delta: Delta): BoardData {
  // An answer older than the board we hold (a poll that raced a reload) would put old state back: ignore it.
  if (isOlderRev(delta.rev, data.board.rev)) return data;
  const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  let lanes = data.lanes;
  for (const change of delta.lanes) {
    if (change.archived) {
      lanes = lanes.filter(l => l.id !== change.id);
      continue;
    }
    const existing = lanes.find(l => l.id === change.id);
    lanes = existing
      ? lanes.map(l => {
          if (l.id !== change.id) return l;
          const {cards, loaded, hasMore} = l;
          const merged = {...l, ...change, cards, loaded, hasMore};
          // Same fields (our own write echoed back): keep the lane, and so its cards, referentially stable.
          return sameJson({...merged, cards: 0}, {...l, cards: 0}) ? l : merged;
        })
      : [...lanes, {...change, cards: [], loaded: change.cardCount === 0, hasMore: change.cardCount > 0}];
  }
  lanes = [...lanes].sort(byPosition);
  const before = lanes;
  // Cards that did not change keep their object, so a memoized card does not re-render.
  const known = new Map<number, CardT>();
  for (const lane of lanes) for (const c of lane.cards) known.set(c.id, c);
  for (const incoming of delta.cards) {
    const old = known.get(incoming.id);
    const card = old && sameJson(old, incoming) ? old : incoming;
    lanes = lanes.map(lane => (lane.cards.some(c => c.id === card.id) ? {...lane, cards: lane.cards.filter(c => c.id !== card.id)} : lane));
    if (card.archived) continue;
    lanes = lanes.map(lane => {
      if (lane.id !== card.laneId || !lane.loaded) return lane;
      const last = lane.cards.at(-1);
      if (lane.hasMore && last && byPosition(card, last) > 0) return lane;
      return {...lane, cards: [...lane.cards, card].sort(byPosition)};
    });
  }
  // A lane whose cards came out the same (same objects, same order) is the lane it was.
  lanes = lanes.map(lane => {
    const was = before.find(l => l.id === lane.id);
    return was && was !== lane && was.cards.length === lane.cards.length && was.cards.every((c, i) => c === lane.cards[i]) && sameJson({...was, cards: 0}, {...lane, cards: 0}) ? was : lane;
  });
  const b = delta.board;
  const board = {...data.board, ...(b ?? {}), rev: delta.rev, archived: delta.archived};
  return {board, lanes};
}

/** True when revision `a` is strictly older than `b` (both decimal strings; anything unparsable is never older). */
export function isOlderRev(a: string, b: string): boolean {
  try {
    return BigInt(a) < BigInt(b);
  } catch {
    return false;
  }
}
