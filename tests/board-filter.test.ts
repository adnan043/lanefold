import {describe, expect, it} from 'vitest';

import type {CardT} from '../src/app/api';
import type {LaneT} from '../src/app/api';
import {activeCount, cleanFilter, matchesFilter, optionCounts} from '../src/app/boards/filter-logic';

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

describe('optionCounts (the number beside each filter option)', () => {
  const lane = (cards: CardT[]): LaneT => ({id: 1, name: 'L', position: 'a', colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false, archived: false, rev: '1', cards, loaded: true, hasMore: false});
  const cards = [
    card({id: 1, members: [{id: 9, name: 'Z'}], labels: [{id: 2, name: 'a', colorHex: '#000'}], dueDate: '2026-11-02'}),
    card({id: 2, members: [{id: 9, name: 'Z'}, {id: 7, name: 'Y'}], completed: true, dueDate: '2026-11-04'}),
    card({id: 3}),
    card({id: -4}), // still being created: not counted
  ];
  it('counts each option on its own, like ticking just that box', () => {
    const c = optionCounts([lane(cards.slice(0, 2)), lane(cards.slice(2))], now, {from: '2026-11-01', to: '2026-11-03'});
    expect(c.members.get(9)).toBe(2);
    expect(c.members.get(7)).toBe(1);
    expect(c.noMembers).toBe(1);
    expect([c.complete, c.incomplete]).toEqual([1, 2]);
    expect(c.labels.get(2)).toBe(1);
    expect(c.noLabels).toBe(2);
    expect(c.dues).toEqual({none: 1, overdue: 1, day: 1, week: 1, month: 1});
    expect(c.dueRange).toBe(1);
    // The same answer as the filter itself for every option.
    const all = cards.filter(x => x.id > 0);
    expect(all.filter(x => matchesFilter(x, {memberIds: [9]}, now)).length).toBe(c.members.get(9));
    expect(all.filter(x => matchesFilter(x, {dues: ['overdue']}, now)).length).toBe(c.dues.overdue);
    expect(all.filter(x => matchesFilter(x, {noLabels: true}, now)).length).toBe(c.noLabels);
  });
  it('no range: the custom range counts nothing', () => expect(optionCounts([lane(cards)], now).dueRange).toBe(0));
});
