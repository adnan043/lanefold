import {describe, expect, it} from 'vitest';

import type {CardT, LaneT} from '../src/app/api';
import {buildSwimGroups, groupByStorageKey, groupKeysOf, isGroupBy} from '../src/app/boards/swimlane-logic';

const card = (id: number, over: Partial<CardT> = {}): CardT => ({
  id, laneId: 1, title: `Card ${id}`, position: `a${id}`, priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...over,
});
const lane = (id: number, cards: CardT[]): LaneT => ({
  id, name: `Lane ${id}`, position: `a${id}`, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false, archived: false, rev: '', cards, loaded: true, hasMore: false,
});
const ann = {id: 1, name: 'Ann'};
const bob = {id: 2, name: 'Bob'};

describe('swimlane grouping', () => {
  const lanes = [
    lane(1, [card(1, {members: [bob]}), card(2, {members: [ann, bob]}), card(3)]),
    lane(2, [card(4, {members: [ann]})]),
  ];

  it('validates the choice and keys storage per user and board', () => {
    expect(isGroupBy('label')).toBe(true);
    expect(isGroupBy('x')).toBe(false);
    expect(groupByStorageKey(null, 5)).toBe('lanefold.boardGroupBy.0.5');
  });

  it('returns no rows for none', () => {
    expect(buildSwimGroups(lanes, 'none')).toEqual([]);
  });

  it('groups by assignee: sorted by name, unassigned last, multi-assignee in each row, every lane kept', () => {
    const groups = buildSwimGroups(lanes, 'assignee');
    expect(groups.map(g => g.key)).toEqual(['m:1', 'm:2', 'none']);
    expect(groups[0]!.lanes.map(l => l.cards.map(c => c.id))).toEqual([[2], [4]]);
    expect(groups[1]!.lanes.map(l => l.cards.map(c => c.id))).toEqual([[1, 2], []]);
    expect(groups[2]!.lanes.map(l => l.cards.map(c => c.id))).toEqual([[3], []]);
    expect(groups.every(g => g.lanes.length === 2)).toBe(true);
    expect(groups.map(g => g.cardCount)).toEqual([2, 2, 1]);
  });

  it('groups by priority from urgent down and skips empty rows', () => {
    const l = [lane(1, [card(1, {priority: 'low'}), card(2, {priority: 'urgent'}), card(3, {priority: ''}), card(4, {priority: 'low'})])];
    const groups = buildSwimGroups(l, 'priority');
    expect(groups.map(g => g.key)).toEqual(['p:urgent', 'p:low', 'p:none']);
    expect(groups[1]!.lanes[0]!.cards.map(c => c.id)).toEqual([1, 4]);
  });

  it('groups by label with colour, and respects the board filter', () => {
    const red = {id: 7, name: 'Bug', colorHex: '#f00'};
    const l = [lane(1, [card(1, {labels: [red]}), card(2, {labels: [red]}), card(3)])];
    const groups = buildSwimGroups(l, 'label', c => c.id !== 2);
    expect(groups.map(g => [g.key, g.name, g.colorHex, g.cardCount])).toEqual([['l:7', 'Bug', '#f00', 1], ['none', null, null, 1]]);
  });

  it('does not mutate the board lanes', () => {
    buildSwimGroups(lanes, 'assignee');
    expect(lanes[0]!.cards).toHaveLength(3);
    expect(groupKeysOf(card(9, {members: [ann, ann]}), 'assignee')).toEqual(['m:1']);
  });
});
