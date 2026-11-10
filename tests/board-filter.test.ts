import {describe, expect, it} from 'vitest';

import type {CardT} from '../src/app/api';
import {activeCount, cleanFilter, matchesFilter} from '../src/app/boards/filter-logic';

const now = new Date(2026, 10, 3, 15, 0); // 2026-11-03 local
const card = (over: Partial<CardT> = {}): CardT => ({
  id: 1, laneId: 1, title: 'Café menu', position: 'a', priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, labels: [], members: [], ...over,
});

describe('matchesFilter', () => {
  it('passes everything when empty', () => expect(matchesFilter(card(), {}, now)).toBe(true));
  it('text ignores case and accents', () => {
    expect(matchesFilter(card(), {text: 'CAFE'}, now)).toBe(true);
    expect(matchesFilter(card(), {text: 'tea'}, now)).toBe(false);
  });
  it('labels and members are any-of', () => {
    const c = card({labels: [{id: 2, name: 'a', colorHex: '#000'}], members: [{id: 9, name: 'Z'}]});
    expect(matchesFilter(c, {labelIds: [1, 2]}, now)).toBe(true);
    expect(matchesFilter(c, {labelIds: [1]}, now)).toBe(false);
    expect(matchesFilter(c, {memberIds: [9, 10]}, now)).toBe(true);
    expect(matchesFilter(c, {memberIds: [10]}, now)).toBe(false);
  });
  it('due filters use the local date', () => {
    expect(matchesFilter(card({dueDate: '2026-11-03'}), {dues: ['day']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-11-04'}), {dues: ['day']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-11-05'}), {dues: ['day']}, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-11-02'}), {dues: ['overdue']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-11-02', completed: true}), {dues: ['overdue']}, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-11-10'}), {dues: ['week']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-11-11'}), {dues: ['week']}, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-12-03'}), {dues: ['month']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-12-04'}), {dues: ['month']}, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-11-02'}), {dues: ['week']}, now)).toBe(false);
    expect(matchesFilter(card(), {dues: ['none']}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-11-03'}), {dues: ['none']}, now)).toBe(false);
    expect(matchesFilter(card(), {dues: ['day']}, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-11-02'}), {dues: ['none', 'overdue']}, now)).toBe(true);
  });
  it('custom due range includes both ends, either end may be open, and is any-of with the presets', () => {
    const r = {dueFrom: '2026-12-01', dueTo: '2026-12-10'};
    expect(matchesFilter(card({dueDate: '2026-12-01'}), r, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-12-10'}), r, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2026-12-11'}), r, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2026-11-30'}), r, now)).toBe(false);
    expect(matchesFilter(card(), r, now)).toBe(false);
    expect(matchesFilter(card({dueDate: '2030-01-01'}), {dueFrom: '2026-12-01'}, now)).toBe(true);
    expect(matchesFilter(card({dueDate: '2020-01-01'}), {dueTo: '2026-12-01'}, now)).toBe(true);
    expect(matchesFilter(card(), {...r, dues: ['none']}, now)).toBe(true);
    expect(activeCount({dueFrom: '2026-12-01', dues: ['none']})).toBe(1);
  });
  it('cleanFilter keeps real range dates, drops bad ones, swaps a reversed range', () => {
    expect(cleanFilter({dueFrom: '2026-12-10', dueTo: '2026-12-01'})).toEqual({dueFrom: '2026-12-01', dueTo: '2026-12-10'});
    expect(cleanFilter({dueFrom: '2026-02-30', dueTo: 'soon'})).toEqual({});
  });
  it('no labels, no members and card status', () => {
    expect(matchesFilter(card(), {noLabels: true}, now)).toBe(true);
    expect(matchesFilter(card({labels: [{id: 1, name: 'a', colorHex: '#000'}]}), {noLabels: true}, now)).toBe(false);
    expect(matchesFilter(card({labels: [{id: 1, name: 'a', colorHex: '#000'}]}), {noLabels: true, labelIds: [1]}, now)).toBe(true);
    expect(matchesFilter(card(), {noMembers: true}, now)).toBe(true);
    expect(matchesFilter(card({completed: true}), {status: 'complete'}, now)).toBe(true);
    expect(matchesFilter(card({completed: true}), {status: 'incomplete'}, now)).toBe(false);
  });
  it('any match is the default, all match needs every group', () => {
    const f = {priority: 'high', text: 'x'} as const;
    expect(matchesFilter(card({priority: 'high'}), f, now)).toBe(true);
    expect(matchesFilter(card({priority: 'high'}), {...f, match: 'all'}, now)).toBe(false);
    expect(matchesFilter(card({priority: 'low'}), f, now)).toBe(false);
    expect(matchesFilter(card({priority: 'high', title: 'x'}), {...f, match: 'all'}, now)).toBe(true);
  });
  it('priority', () => {
    expect(matchesFilter(card({priority: 'high'}), {priority: 'high'}, now)).toBe(true);
    expect(matchesFilter(card({priority: 'low'}), {priority: 'high'}, now)).toBe(false);
  });
});

describe('helpers', () => {
  it('counts criteria and cleans junk', () => {
    expect(activeCount({text: ' ', labelIds: [1], noLabels: true, dues: ['day'], match: 'all'})).toBe(2);
    expect(cleanFilter({text: 'a', labelIds: [1, 1, 'x', -2], due: 'nope', extra: 1})).toEqual({text: 'a', labelIds: [1]});
    expect(cleanFilter({due: 'today', match: 'all'})).toEqual({dues: ['day'], match: 'all'});
    expect(cleanFilter({match: 'all'})).toEqual({});
  });
});
