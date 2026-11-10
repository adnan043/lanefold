import {generateKeyBetween} from 'fractional-indexing';
import {describe, expect, it} from 'vitest';

import type {BoardData, CardT, LaneT} from '../src/app/api';
import {applyChanges, byPosition, findCard, keyBetween, moveCardInLanes, moveLaneInList, nextCursor, removeCard, replaceTemps, revertCardMove, revertLaneMove} from '../src/app/board-state';

const card = (id: number, laneId: number, position: string, extra: Partial<CardT> = {}): CardT => ({
  id, laneId, title: `c${id}`, position, priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...extra,
});
const lane = (id: number, position: string, cards: CardT[], extra: Partial<LaneT> = {}): LaneT => ({
  id, name: `L${id}`, position, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false,
  archived: false, rev: '1', cards, loaded: true, hasMore: false, ...extra,
});
/** A lane the way `changes` sends it: no cards, no client flags. */
const wire = (l: LaneT, extra: Partial<LaneT> = {}) => {
  const {cards: _c, loaded: _l, hasMore: _h, ...rest} = l;
  return {...rest, ...extra};
};
const data = (lanes: LaneT[]): BoardData => ({
  board: {id: 1, workspaceId: 1, name: 'B', visibility: 'workspace', bgKind: 'color', bgColor1: '#FFFFFF', bgColor2: '#000000', bgAngle: 0,
    bgPattern: 'none', archived: false, rev: '1', starred: false, role: 'admin', canWrite: true, canAdmin: true},
  lanes,
});

describe('board state (pure)', () => {
  it('orders keys byte by byte, ties by id (the same as COLLATE "C")', () => {
    const keys = ['a0', 'a1', 'Zz', 'a0V', 'a'];
    const sorted = keys.map((position, id) => ({position, id})).sort(byPosition).map(k => k.position);
    expect(sorted).toEqual([...keys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(byPosition({position: 'a0', id: 1}, {position: 'a0', id: 2})).toBeLessThan(0);
  });

  it('keeps keys sorted after many inserts at the front and in the middle', () => {
    let list = [generateKeyBetween(null, null)];
    for (let i = 0; i < 300; i++) {
      const at = i % 3 === 0 ? 0 : Math.floor(list.length / 2);
      const key = keyBetween(list[at - 1] ?? null, list[at] ?? null)!;
      list.splice(at, 0, key);
    }
    expect(list).toEqual([...list].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(new Set(list).size).toBe(list.length);
    expect(keyBetween('b', 'a')).toBeNull();
  });

  it('moves a card across lanes and fixes both counters', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')]), lane(2, 'a1', [card(3, 2, 'a0')])];
    const moved = moveCardInLanes(lanes, 1, 2, 1, 'a0V');
    expect(moved[0]!.cards.map(c => c.id)).toEqual([2]);
    expect(moved[1]!.cards.map(c => [c.id, c.laneId, c.position])).toEqual([[3, 2, 'a0'], [1, 2, 'a0V']]);
    expect(moved.map(l => l.cardCount)).toEqual([1, 2]);
    expect(findCard(moved, 1)).toEqual({laneId: 2, index: 1});
    expect(removeCard(moved, 1)[1]!.cardCount).toBe(1);
  });

  it('moves a lane', () => {
    const lanes = [lane(1, 'a0', []), lane(2, 'a1', []), lane(3, 'a2', [])];
    expect(moveLaneInList(lanes, 3, 0).map(l => l.id)).toEqual([3, 1, 2]);
    expect(moveLaneInList(lanes, 1, 2).map(l => l.id)).toEqual([2, 3, 1]);
  });

  it('applies a delta idempotently: moves, archives, new lanes, rev', () => {
    const base = data([lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')]), lane(2, 'a1', [])]);
    const delta = {
      rev: '5', archived: false, truncated: false,
      lanes: [wire(lane(3, 'a2', []), {cardCount: 2}), wire(lane(2, 'a1', []), {cardCount: 1})],
      cards: [card(1, 2, 'a0'), card(2, 1, 'a1', {archived: true})],
    };
    const once = applyChanges(base, delta as never);
    expect(once.board.rev).toBe('5');
    expect(once.lanes.map(l => l.id)).toEqual([1, 2, 3]);
    expect(once.lanes[1]!.cards.map(c => c.id)).toEqual([1]);
    expect(once.lanes[0]!.cards).toEqual([]);
    // The new lane has cards the delta did not carry: it loads them itself.
    expect(once.lanes[2]).toMatchObject({loaded: false, hasMore: true});
    expect(applyChanges(once, delta as never)).toEqual(once);
  });

  it('does not insert a changed card beyond the loaded part of a lane with more cards', () => {
    const base = data([lane(1, 'a0', [card(1, 1, 'a0')], {hasMore: true, cardCount: 40})]);
    const out = applyChanges(base, {rev: '2', archived: false, truncated: false, lanes: [], cards: [card(9, 1, 'zz')]} as never);
    expect(out.lanes[0]!.cards.map(c => c.id)).toEqual([1]);
  });
});

describe('revertLaneMove', () => {
  it('puts only the moved lane back and keeps other lanes as they are now', () => {
    const now = [lane(2, 'a1', []), lane(1, 'a2', [], {name: 'renamed'}), lane(3, 'a3', [])];
    const out = revertLaneMove(now, 1, 0, 'a0');
    expect(out.map(l => l.id)).toEqual([1, 2, 3]);
    expect(out[0]!.position).toBe('a0');
    expect(out[1]!.id).toBe(2);
    expect(out.find(l => l.id === 1)!.name).toBe('renamed');
  });
  it('is a no-op when the lane is gone', () => {
    const now = [lane(2, 'a1', [])];
    expect(revertLaneMove(now, 9, 0, 'a0')).toBe(now);
  });
});

describe('revertCardMove', () => {
  it('puts only the failed card back and keeps later edits', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')]), lane(2, 'a1', [])];
    // A moved to lane 2, then B moved after it and a new card 9 was added.
    let now = moveCardInLanes(lanes, 1, 2, 0, 'b0');
    now = moveCardInLanes(now, 2, 2, 1, 'b1');
    now = now.map(l => (l.id === 2 ? {...l, cards: [...l.cards, card(9, 2, 'b2')]} : l));
    const reverted = revertCardMove(now, 1, 1, 0, 'a0');
    expect(reverted.find(l => l.id === 1)!.cards.map(c => c.id)).toEqual([1]);
    expect(reverted.find(l => l.id === 2)!.cards.map(c => c.id)).toEqual([2, 9]);
    expect(reverted.find(l => l.id === 1)!.cardCount).toBe(1);
  });
  it('does nothing when the card or the lane is gone', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0')])];
    expect(revertCardMove(lanes, 5, 1, 0, 'a0')).toBe(lanes);
    expect(revertCardMove(lanes, 1, 7, 0, 'a0')).toBe(lanes);
  });
});

describe('board state: audit fixes', () => {
  it('merges the board fields and the caller role a delta carries', () => {
    const base = data([lane(1, 'a0', [])]);
    const next = applyChanges(base, {
      rev: '5', archived: false, truncated: false, lanes: [], cards: [],
      board: {name: 'Renamed', visibility: 'private', bgKind: 'gradient', bgColor1: '#111111', bgColor2: '#222222', bgAngle: 90, bgPattern: 'none', role: 'viewer', canWrite: false, canAdmin: false},
    });
    expect(next.board).toMatchObject({name: 'Renamed', visibility: 'private', bgKind: 'gradient', role: 'viewer', canWrite: false, canAdmin: false, rev: '5', starred: false});
    // An older answer without board fields keeps what is there.
    expect(applyChanges(base, {rev: '2', archived: false, truncated: false, lanes: [], cards: []}).board.name).toBe('B');
  });

  it('does not move or drop a card when the target lane is gone', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0')])];
    expect(moveCardInLanes(lanes, 1, 99, 0)).toBe(lanes);
  });

  it('the load-more cursor skips pending (negative id) cards', () => {
    const l = lane(1, 'a0', [card(1, 1, 'a0'), card(-1, 1, '~00000001')], {hasMore: true});
    expect(nextCursor(l)).toBe('a0|1');
  });

  it('swaps pending cards for the saved ones without touching the counter', () => {
    const l = lane(1, 'a0', [card(1, 1, 'a0'), card(-1, 1, '~00000001')], {hasMore: true, cardCount: 600});
    const out = replaceTemps([l], 1, [-1], [card(7, 1, 'z0')])[0]!;
    expect(out.cards.map(c => c.id)).toEqual([1, 7]);
    expect(out.cardCount).toBe(600);
    // Saved cards that a later page already brought in are not doubled.
    const again = replaceTemps([{...l, cards: [card(1, 1, 'a0'), card(7, 1, 'z0'), card(-1, 1, '~00000001')]}], 1, [-1], [card(7, 1, 'z0')])[0]!;
    expect(again.cards.map(c => c.id)).toEqual([1, 7]);
  });
});
