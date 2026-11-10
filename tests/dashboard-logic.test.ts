import {describe, expect, it} from 'vitest';

import type {CardT, LaneT} from '../src/app/api';
import {dashboardStats, WEEKS_SHOWN} from '../src/app/boards/views/dashboard-logic';
import {isBoardView} from '../src/app/boards/views/view-logic';

const card = (id: number, over: Partial<CardT> = {}): CardT =>
  ({id, laneId: 1, title: `C${id}`, position: `a${id}`, priority: 'none', dueDate: null, completed: false, checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...over}) as CardT;
const lane = (id: number, cards: CardT[]): LaneT => ({id, name: `L${id}`, position: `a${id}`, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false, archived: false, rev: '', cards, loaded: true, hasMore: false});
const TODAY = '2026-11-04'; // a Wednesday

describe('dashboardStats', () => {
  it('is all zero for an empty board', () => {
    const s = dashboardStats([lane(1, [])], TODAY);
    expect([s.total, s.done, s.open, s.overdue, s.dueSoon, s.unassigned]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.weeks).toHaveLength(WEEKS_SHOWN);
  });

  it('counts per lane, skipping archived cards', () => {
    const s = dashboardStats([lane(1, [card(1), card(2, {archived: true})]), lane(2, [card(3)])], TODAY);
    expect(s.byLane.map(l => l.count)).toEqual([1, 1]);
    expect(s.total).toBe(2);
  });

  it('overdue and due soon count open cards only, with today and day 7 inclusive', () => {
    const s = dashboardStats([lane(1, [
      card(1, {dueDate: '2026-11-03'}), card(2, {dueDate: '2026-11-03', completed: true}),
      card(3, {dueDate: TODAY}), card(4, {dueDate: '2026-11-11'}), card(5, {dueDate: '2026-11-12'}), card(6, {dueDate: 'junk'}),
    ])], TODAY);
    expect(s.overdue).toBe(1);
    expect(s.dueSoon).toBe(2);
    expect(s.done).toBe(1);
    expect(s.open).toBe(5);
  });

  it('counts per assignee (a multi-member card counts for each) and unassigned', () => {
    const s = dashboardStats([lane(1, [
      card(1, {members: [{id: 2, name: 'Bo'}, {id: 1, name: 'Al'}]}), card(2, {members: [{id: 1, name: 'Al'}]}), card(3), card(4, {members: []}),
    ])], TODAY);
    expect(s.byAssignee).toEqual([{id: 1, name: 'Al', count: 2}, {id: 2, name: 'Bo', count: 1}]);
    expect(s.unassigned).toBe(2);
  });

  it('buckets cards by due week (week starts on the given day), dropping those out of range', () => {
    const s = dashboardStats([lane(1, [
      card(1, {dueDate: TODAY, completed: true}), card(2, {dueDate: '2026-11-08'}), card(3, {dueDate: '2026-11-09'}),
      card(4, {dueDate: '2025-01-01'}), card(5, {dueDate: '2026-09-14'}),
    ])], TODAY, 1);
    const last = s.weeks[WEEKS_SHOWN - 1];
    expect(last.start).toBe('2026-11-02');
    expect(last).toMatchObject({done: 1, open: 1}); // Wed + Sun of that Mon-Sun week
    expect(s.weeks[0].start).toBe('2026-09-14');
    expect(s.weeks[0].open).toBe(1);
    expect(s.weeks.reduce((n, w) => n + w.done + w.open, 0)).toBe(3);
  });

  it('is a known board view', () => expect(isBoardView('dashboard')).toBe(true));
});
