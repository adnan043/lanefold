import {describe, expect, it} from 'vitest';

import type {CardT, LaneT} from '../src/app/api';
import {agendaDays, dropChangesDue, groupByDue, isBoardView, monthWeeks, nextSort, shiftMonth, sortRows, tableRows, viewStorageKey, weekdayOrder} from '../src/app/boards/views/view-logic';

const card = (id: number, over: Partial<CardT> = {}): CardT => ({
  id, laneId: 1, title: `Card ${id}`, position: `a${id}`, priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...over,
});
const lane = (id: number, cards: CardT[], position = `a${id}`): LaneT => ({
  id, name: `Lane ${id}`, position, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false, archived: false, rev: '', cards, loaded: true, hasMore: false,
});

describe('calendar grid', () => {
  it('starts on Monday by default and pads with neighbours', () => {
    const weeks = monthWeeks({year: 2026, month: 11}); // 1 Nov 2026 is a Sunday
    expect(weeks[0]![0]).toBe('2026-10-26');
    expect(weeks[0]![6]).toBe('2026-11-01');
    expect(weeks.every(w => w.length === 7)).toBe(true);
    expect(weeks.flat()).toContain('2026-11-30');
  });
  it('starts on Sunday when asked', () => {
    expect(monthWeeks({year: 2026, month: 11}, 0)[0]![0]).toBe('2026-11-01');
  });
  it('handles February of a leap year', () => {
    const days = monthWeeks({year: 2028, month: 2}).flat();
    expect(days).toContain('2028-02-29');
    expect(days.filter(d => d.startsWith('2028-02'))).toHaveLength(29);
  });
  it('shifts months across years', () => {
    expect(shiftMonth({year: 2026, month: 12}, 1)).toEqual({year: 2027, month: 1});
    expect(shiftMonth({year: 2026, month: 1}, -1)).toEqual({year: 2025, month: 12});
  });
  it('orders weekdays from the first day', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
  it('groups cards by due date, keeps undated apart, skips archived', () => {
    const lanes = [lane(1, [card(1, {dueDate: '2026-11-05'}), card(2), card(3, {dueDate: '2026-11-05', archived: true})]), lane(2, [card(4, {dueDate: '2026-11-05'}), card(5, {dueDate: 'nope'})])];
    const {byDay, undated} = groupByDue(lanes);
    expect(byDay.get('2026-11-05')!.map(c => c.id)).toEqual([1, 4]);
    expect(undated.map(c => c.id)).toEqual([2, 5]);
    expect(agendaDays(byDay, {year: 2026, month: 11}).map(d => d.date)).toEqual(['2026-11-05']);
    expect(agendaDays(byDay, {year: 2026, month: 12})).toEqual([]);
  });
  it('a drop on the same day changes nothing', () => {
    expect(dropChangesDue({dueDate: '2026-11-05'}, '2026-11-05')).toBe(false);
    expect(dropChangesDue({dueDate: null}, '2026-11-05')).toBe(true);
  });
});

describe('table sorting', () => {
  const lanes = [
    lane(1, [card(1, {title: 'Item 10', dueDate: '2026-11-09', priority: 'low'}), card(2, {title: 'Item 2', priority: 'urgent'})]),
    lane(2, [card(3, {title: 'Alpha', dueDate: '2026-11-01', labels: [{id: 1, name: 'Bug', colorHex: '#f00'}]}), card(4, {title: 'beta', members: [{id: 1, name: 'A'}, {id: 2, name: 'B'}]})], 'a2'),
  ];
  const rows = tableRows(lanes);
  const ids = (key: Parameters<typeof sortRows>[1], dir: 'asc' | 'desc') => sortRows(rows, key, dir).map(r => r.card.id);
  it('lists cards in board order', () => expect(rows.map(r => r.card.id)).toEqual([1, 2, 3, 4]));
  it('sorts titles naturally and case-insensitively', () => {
    expect(ids('title', 'asc')).toEqual([3, 4, 2, 1]);
    expect(ids('title', 'desc')).toEqual([1, 2, 4, 3]);
  });
  it('puts empty values last in both directions', () => {
    expect(ids('due', 'asc')).toEqual([3, 1, 2, 4]);
    expect(ids('due', 'desc')).toEqual([1, 3, 2, 4]);
    expect(ids('priority', 'desc')).toEqual([2, 1, 3, 4]);
  });
  it('sorts by lane, labels and assignees', () => {
    expect(ids('lane', 'desc')).toEqual([3, 4, 1, 2]);
    expect(ids('labels', 'asc')[0]).toBe(3);
    expect(ids('members', 'desc')[0]).toBe(4);
  });
  it('does not mutate its input and flips direction on the same column', () => {
    const copy = [...rows];
    sortRows(rows, 'title', 'desc');
    expect(rows).toEqual(copy);
    expect(nextSort({key: 'title', dir: 'asc'}, 'title')).toEqual({key: 'title', dir: 'desc'});
    expect(nextSort({key: 'title', dir: 'desc'}, 'due')).toEqual({key: 'due', dir: 'asc'});
  });
});

describe('view choice', () => {
  it('validates and keys per user and board', () => {
    expect(isBoardView('table')).toBe(false);
    expect(isBoardView('gantt')).toBe(false);
    expect(viewStorageKey(7, 3)).not.toBe(viewStorageKey(8, 3));
  });
});
