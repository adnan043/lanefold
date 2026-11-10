import {addMonths, monthGrid, parseISODate, toISODate} from '../../../portal/ui/date';
import type {CardT, LaneT} from '../../api';
import {byPosition} from '../../board-state';

/** Pure logic of the Table and Calendar views: no React, no network (tests/board-views.test.ts). */

export type BoardView = 'board' | 'calendar' | 'dashboard' | 'workload';
export const BOARD_VIEWS: BoardView[] = ['board', 'calendar', 'dashboard', 'workload'];
export const isBoardView = (value: unknown): value is BoardView => typeof value === 'string' && (BOARD_VIEWS as string[]).includes(value);

export const viewStorageKey = (userId: number | null, boardId: number) => `lanefold.boardView.${userId ?? 0}.${boardId}`;

/* ---------- table ---------- */

export type Row = {card: CardT; laneId: number; laneName: string; laneIndex: number};
export type SortKey = 'number' | 'title' | 'lane' | 'due' | 'labels' | 'members' | 'priority';
export type SortDir = 'asc' | 'desc';
export const SORT_KEYS: SortKey[] = ['number', 'title', 'lane', 'due', 'labels', 'members', 'priority'];

const PRIORITY_RANK: Record<string, number> = {none: 0, low: 1, medium: 2, high: 3, urgent: 4};

/** One row per card of every loaded lane, in board order (lane order, then card order). */
export function tableRows(lanes: LaneT[]): Row[] {
  return lanes.flatMap((lane, laneIndex) => [...lane.cards].sort(byPosition).map(card => ({card, laneId: lane.id, laneName: lane.name, laneIndex})));
}

const labelNames = (card: CardT) => (card.labels ?? []).map(l => l.name).join(', ');

/**
 * Stable sort: the column, then the board order. Empty values (no due date, no labels, no priority) go LAST in
 * both directions, so a descending due-date sort never buries the dated cards under the empty ones.
 */
export function sortRows(rows: Row[], key: SortKey, dir: SortDir, locale = 'en'): Row[] {
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(locale, {numeric: true, sensitivity: 'base'});
  const board = (a: Row, b: Row) => a.laneIndex - b.laneIndex || byPosition(a.card, b.card);
  const empty = (r: Row): boolean =>
    key === 'number' ? r.card.number == null : key === 'due' ? r.card.dueDate === null : key === 'labels' ? labelNames(r.card) === '' : key === 'members' ? (r.card.members ?? []).length === 0 : key === 'priority' ? r.card.priority === 'none' || !(r.card.priority in PRIORITY_RANK) : false;
  const compare = (a: Row, b: Row): number => {
    switch (key) {
      case 'number':
        return (a.card.number ?? 0) - (b.card.number ?? 0);
      case 'title':
        return collator.compare(a.card.title, b.card.title);
      case 'lane':
        return a.laneIndex - b.laneIndex;
      case 'due':
        return a.card.dueDate! < b.card.dueDate! ? -1 : a.card.dueDate! > b.card.dueDate! ? 1 : 0;
      case 'labels':
        return collator.compare(labelNames(a.card), labelNames(b.card));
      case 'members':
        return (a.card.members ?? []).length - (b.card.members ?? []).length;
      case 'priority':
        return (PRIORITY_RANK[a.card.priority] ?? 0) - (PRIORITY_RANK[b.card.priority] ?? 0);
    }
  };
  return [...rows].sort((a, b) => {
    const ea = empty(a);
    const eb = empty(b);
    if (ea !== eb) return ea ? 1 : -1;
    return (ea ? 0 : sign * compare(a, b)) || board(a, b) || a.card.id - b.card.id;
  });
}

/** Clicking a column: the same one flips direction, a new one starts ascending. */
export function nextSort(current: {key: SortKey; dir: SortDir}, key: SortKey): {key: SortKey; dir: SortDir} {
  return current.key === key ? {key, dir: current.dir === 'asc' ? 'desc' : 'asc'} : {key, dir: 'asc'};
}

/* ---------- calendar ---------- */

export type YearMonth = {year: number; month: number};

export const monthOf = (iso: string): YearMonth => {
  const p = parseISODate(iso);
  if (!p) throw new RangeError(`Not an ISO date: ${iso}`);
  return {year: p.year, month: p.month};
};

export const shiftMonth = (ym: YearMonth, delta: number): YearMonth => monthOf(addMonths(toISODate(ym.year, ym.month, 1), delta));

/** The month's weeks as rows of 7 ISO dates starting on `firstDay` (0 Sunday … 6 Saturday; Monday = 1), padded with the neighbours. */
export function monthWeeks(ym: YearMonth, firstDay = 1): string[][] {
  return monthGrid(ym.year, ym.month, ((Math.trunc(firstDay) % 7) + 7) % 7);
}

export const isInMonth = (iso: string, ym: YearMonth) => {
  const m = monthOf(iso);
  return m.year === ym.year && m.month === ym.month;
};

/** Cards by due date (board order inside a day), and the ones without a (valid) due date. Archived cards never show. */
export function groupByDue(lanes: LaneT[]): {byDay: Map<string, CardT[]>; undated: CardT[]} {
  const byDay = new Map<string, CardT[]>();
  const undated: CardT[] = [];
  lanes.forEach(lane => {
    for (const card of [...lane.cards].sort(byPosition)) {
      if (card.archived) continue;
      if (card.dueDate && parseISODate(card.dueDate)) {
        const list = byDay.get(card.dueDate);
        if (list) list.push(card);
        else byDay.set(card.dueDate, [card]);
      } else undated.push(card);
    }
  });
  return {byDay, undated};
}

/** The days of the month (not the padding) that hold cards, for the phone's agenda list. */
export function agendaDays(byDay: Map<string, CardT[]>, ym: YearMonth): {date: string; cards: CardT[]}[] {
  return [...byDay.entries()]
    .filter(([date]) => isInMonth(date, ym))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cards]) => ({date, cards}));
}

/** Weekday indexes in display order, from `firstDay` (for the header row). */
export const weekdayOrder = (firstDay = 1): number[] => Array.from({length: 7}, (_, i) => (((Math.trunc(firstDay) % 7) + 7) % 7 + i) % 7);

/** A drop on `date` changes the due date only when it differs. */
export const dropChangesDue = (card: Pick<CardT, 'dueDate'>, date: string) => card.dueDate !== date;
