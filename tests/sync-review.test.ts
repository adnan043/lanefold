import {generateKeyBetween} from 'fractional-indexing';
import {describe, expect, it} from 'vitest';

import type {BoardData, CardT, LaneT} from '../src/app/api';
import {applyChanges, byPosition, insertCard, isOlderRev, moveCardInLanes, revertCardMove} from '../src/app/board-state';
import {keyOrNull, MAX_KEY_LENGTH} from '../src/lib/position-key';

const card = (id: number, laneId: number, position: string, extra: Partial<CardT> = {}): CardT => ({
  id, laneId, title: `c${id}`, position, priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...extra,
});
const lane = (id: number, position: string, cards: CardT[], extra: Partial<LaneT> = {}): LaneT => ({
  id, name: `L${id}`, position, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false,
  archived: false, rev: '1', cards, loaded: true, hasMore: false, ...extra,
});
const board = (lanes: LaneT[], rev = '5'): BoardData => ({
  board: {id: 1, workspaceId: 1, name: 'B', visibility: 'workspace', bgKind: 'color', bgColor1: '#FFFFFF', bgColor2: '#000000', bgAngle: 0,
    bgPattern: 'none', archived: false, rev, starred: false, role: 'admin', canWrite: true, canAdmin: true},
  lanes,
});

describe('position keys stay inside the column', () => {
  it('inserting repeatedly into one gap eventually yields null instead of a key over 64 chars', () => {
    const before = 'a0';
    let after = 'a1';
    let sawNull = false;
    for (let i = 0; i < 2000; i++) {
      const key = keyOrNull(before, after);
      if (key === null) { sawNull = true; break; }
      expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      expect(key > before && key < after).toBe(true);
      after = key;
    }
    expect(sawNull).toBe(true);
    // The unguarded generator would have passed the VarChar(64) column long before 2000 inserts.
    let raw = 'a1';
    for (let i = 0; i < 2000; i++) raw = generateKeyBetween('a0', raw);
    expect(raw.length).toBeGreaterThan(64);
  });

  it('returns null for equal or reversed neighbours', () => {
    expect(keyOrNull('a1', 'a1')).toBeNull();
    expect(keyOrNull('a2', 'a1')).toBeNull();
    expect(keyOrNull(null, null)).toBe('a0');
  });
});

describe('remote deltas', () => {
  it('isOlderRev compares numerically, not as text', () => {
    expect(isOlderRev('9', '10')).toBe(true);
    expect(isOlderRev('10', '9')).toBe(false);
    expect(isOlderRev('5', '5')).toBe(false);
    expect(isOlderRev('x', '5')).toBe(false);
  });

  it('ignores a delta older than the board we hold', () => {
    const d = board([lane(1, 'a0', [card(1, 1, 'a0')])], '10');
    const out = applyChanges(d, {rev: '9', archived: false, truncated: false, lanes: [], cards: [card(1, 1, 'a5', {title: 'old'})]});
    expect(out).toBe(d);
  });

  it('applying the same delta twice gives the same board (idempotent)', () => {
    const d = board([lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')]), lane(2, 'a1', [])]);
    const delta = {rev: '6', archived: false, truncated: false, lanes: [], cards: [card(1, 2, 'a0')]};
    const once = applyChanges(d, delta);
    const twice = applyChanges(once, delta);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(once.lanes[1]!.cards.map(c => c.id)).toEqual([1]);
    expect(once.lanes[0]!.cards.map(c => c.id)).toEqual([2]);
  });

  it('a remote move into a lane archived in the same delta never resurrects the lane', () => {
    const d = board([lane(1, 'a0', [card(1, 1, 'a0')]), lane(2, 'a1', [])]);
    const wire = {id: 2, name: 'L2', position: 'a1', colorHex: null, wipLimit: null, cardCount: 0, collapsed: false, archived: true, rev: '6'};
    const out = applyChanges(d, {rev: '6', archived: false, truncated: false, lanes: [wire], cards: [card(1, 2, 'a0')]});
    expect(out.lanes.map(l => l.id)).toEqual([1]);
    expect(out.lanes[0]!.cards).toEqual([]); // card is in an archived lane: not shown anywhere
  });

  it('a card that moves beyond a partly loaded lane window leaves it (no hole, no duplicate)', () => {
    const d = board([lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')], {hasMore: true})]);
    const out = applyChanges(d, {rev: '6', archived: false, truncated: false, lanes: [], cards: [card(1, 1, 'a9')]});
    expect(out.lanes[0]!.cards.map(c => c.id)).toEqual([2]);
  });
});

describe('undo and revert never land in a missing lane', () => {
  const lanes = [lane(1, 'a0', [card(1, 1, 'a0')]), lane(2, 'a1', [])];
  it('moveCardInLanes to an archived (absent) lane keeps the card where it is', () => {
    expect(moveCardInLanes(lanes, 1, 3, 0)).toBe(lanes);
  });
  it('revertCardMove into an absent lane does nothing', () => {
    const moved = moveCardInLanes(lanes, 1, 2, 0, 'a5');
    expect(revertCardMove(moved, 1, 9, 0, 'a0')).toBe(moved);
  });
  it('insertCard (undo archive) into an absent lane drops it and counts nothing', () => {
    expect(insertCard(lanes, card(7, 9, 'a0'))).toEqual(lanes);
  });
  it('moves counters with the card and sorts ties by id', () => {
    const out = moveCardInLanes(lanes, 1, 2, 0, 'a5');
    expect([out[0]!.cardCount, out[1]!.cardCount]).toEqual([0, 1]);
    expect([card(3, 1, 'a0'), card(2, 1, 'a0')].sort(byPosition).map(c => c.id)).toEqual([2, 3]);
  });
});
