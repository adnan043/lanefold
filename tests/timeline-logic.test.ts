import {describe, expect, it} from 'vitest';

import type {CardT, LaneT} from '../src/app/api';
import {cardSpan, daysBetween, monthSegments, placeSpan, shiftAnchor, shiftedDue, timelineRows, todayColumn, windowFor} from '../src/app/boards/views/timeline-logic';

const card = (id: number, over: Partial<CardT> = {}): CardT =>
  ({id, laneId: 1, title: `C${id}`, position: `a${id}`, priority: 'none', dueDate: null, completed: false, checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...over}) as CardT;
const lane = (cards: CardT[]): LaneT => ({id: 1, name: 'L', position: 'a', colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false, archived: false, rev: '', cards, loaded: true, hasMore: false});

describe('timeline date layout', () => {
  it('counts whole days across month and DST boundaries', () => {
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-10-24', '2026-11-02')).toBe(9);
    expect(daysBetween('2026-11-04', '2026-11-01')).toBe(-3);
  });

  it('spans start (or creation) to due, else a one-day marker', () => {
    expect(cardSpan(card(1, {dueDate: '2026-11-10', startDate: '2026-11-03'}))).toEqual({start: '2026-11-03', end: '2026-11-10', milestone: false});
    expect(cardSpan(card(1, {dueDate: '2026-11-10', createdAt: '2026-11-05T09:00:00.000Z'}))?.start).toBe('2026-11-05');
    expect(cardSpan(card(1, {dueDate: '2026-11-10'}))).toEqual({start: '2026-11-10', end: '2026-11-10', milestone: true});
    expect(cardSpan(card(1, {dueDate: '2026-11-10', startDate: '2026-11-20'}))?.milestone).toBe(true);
    expect(cardSpan(card(1, {dueDate: null}))).toBeNull();
    expect(cardSpan(card(1, {dueDate: 'nope'}))).toBeNull();
  });

  it('prefers the start date over the creation day, and ignores a bad start', () => {
    const both = cardSpan(card(1, {dueDate: '2026-11-10', startDate: '2026-11-03', createdAt: '2026-11-01'}));
    expect(both).toEqual({start: '2026-11-03', end: '2026-11-10', milestone: false});
    expect(cardSpan(card(1, {dueDate: '2026-11-10', startDate: null, createdAt: '2026-11-01'}))?.start).toBe('2026-11-01');
    expect(cardSpan(card(1, {dueDate: '2026-11-10', startDate: '2026-11-10'}))?.milestone).toBe(true);
    expect(timelineRows([lane([card(1, {dueDate: '2026-11-10', startDate: '2026-11-03'})])]).rows[0]?.span.milestone).toBe(false);
  });

  it('splits scheduled and unscheduled cards and skips archived ones', () => {
    const {rows, unscheduled} = timelineRows([lane([card(1, {dueDate: '2026-11-10'}), card(2), card(3, {dueDate: '2026-11-11', archived: true})])]);
    expect(rows.map(r => r.card.id)).toEqual([1]);
    expect(unscheduled.map(c => c.id)).toEqual([2]);
  });

  it('builds the window and clips bars to it', () => {
    const week = windowFor('2026-11-04', 'week', 1); // a Wednesday
    expect(week).toEqual({start: '2026-11-02', days: 28, zoom: 'week'});
    expect(windowFor('2026-11-04', 'month').days).toBe(30 + 31 + 31); // Nov+Dec+Jan
    expect(placeSpan({start: '2026-11-03', end: '2026-11-05', milestone: false}, week)).toEqual({col: 2, span: 3, clippedStart: false, clippedEnd: false});
    expect(placeSpan({start: '2026-10-20', end: '2026-11-03', milestone: false}, week)).toEqual({col: 1, span: 2, clippedStart: true, clippedEnd: false});
    expect(placeSpan({start: '2026-11-28', end: '2026-12-20', milestone: false}, week)).toMatchObject({col: 27, span: 2, clippedEnd: true});
    expect(placeSpan({start: '2026-10-01', end: '2026-10-05', milestone: true}, week)).toBeNull();
    expect(placeSpan({start: '2026-12-01', end: '2026-12-05', milestone: true}, week)).toBeNull();
  });

  it('places the today marker only when visible', () => {
    const week = windowFor('2026-11-04', 'week', 1);
    expect(todayColumn('2026-11-04', week)).toBe(3);
    expect(todayColumn('2027-01-01', week)).toBeNull();
  });

  it('groups month header segments', () => {
    const segs = monthSegments(windowFor('2026-11-25', 'week', 1)); // 23 Nov .. 20 Dec
    expect(segs.map(s => [s.iso, s.col, s.span])).toEqual([['2026-11-23', 1, 8], ['2026-12-01', 9, 20]]);
  });

  it('shifts the anchor and the due date', () => {
    expect(shiftAnchor('2026-11-04', 'week', 1)).toBe('2026-11-11');
    expect(shiftAnchor('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(shiftedDue({dueDate: '2026-11-30'}, 1)).toBe('2026-12-01');
    expect(shiftedDue({dueDate: null}, 1)).toBeNull();
  });
});
