import {describe, expect, it} from 'vitest';

import {formatCardNumber, numbersFrom, parseCardNumber} from '../src/server/card-number';
import {matchesFilter} from '../src/app/boards/filter-logic';
import {sortRows, type Row} from '../src/app/boards/views/view-logic';
import type {CardT} from '../src/app/api';

const card = (id: number, number: number | null, title = `Card ${id}`): CardT =>
  ({id, number, laneId: 1, title, position: 'a', priority: 'none', dueDate: null, completed: false, checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false}) as CardT;

describe('card numbers: pure rules', () => {
  it('parses #42, 42 and "# 42", and nothing else', () => {
    expect(parseCardNumber('#42')).toBe(42);
    expect(parseCardNumber('42')).toBe(42);
    expect(parseCardNumber(' # 7 ')).toBe(7);
    for (const bad of ['', '#', '0', '#0', 'abc', '4 2', '#42x', '-3', '1.5', '12345678901', '2147483648']) expect(parseCardNumber(bad)).toBeNull();
    expect(parseCardNumber('999999999')).toBe(999999999); // nine digits at most
  });

  it('formats and spreads a reserved block', () => {
    expect(formatCardNumber(5)).toBe('#5');
    expect(formatCardNumber(null)).toBeNull();
    expect(numbersFrom(10, 3)).toEqual([10, 11, 12]);
  });
});

describe('card numbers: the board filter and the table sort', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  it('the filter text #N finds that card, titles still match as before', () => {
    expect(matchesFilter(card(1, 42), {text: '#42'}, now)).toBe(true);
    expect(matchesFilter(card(1, 42), {text: '42'}, now)).toBe(true);
    expect(matchesFilter(card(1, 42), {text: '43'}, now)).toBe(false);
    expect(matchesFilter(card(1, null), {text: '42'}, now)).toBe(false);
    expect(matchesFilter(card(1, 3, 'Fix login'), {text: 'login'}, now)).toBe(true);
  });

  it('sorting by number puts cards without a number last in both directions', () => {
    const rows: Row[] = [card(1, 3), card(2, null), card(3, 1)].map((c, i) => ({card: c, laneId: 1, laneName: 'L', laneIndex: i}));
    expect(sortRows(rows, 'number', 'asc').map(r => r.card.id)).toEqual([3, 1, 2]);
    expect(sortRows(rows, 'number', 'desc').map(r => r.card.id)).toEqual([1, 3, 2]);
  });
});
