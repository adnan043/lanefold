import {addDays, addMonths, parseISODate, startOfWeek, toISODate} from '../../../portal/ui/date';
import type {CardT, LaneT} from '../../api';
import {byPosition} from '../../board-state';

/** Pure date layout of the Timeline view: no React, no network (tests/timeline-logic.test.ts). All dates are ISO `YYYY-MM-DD`. */

export type Zoom = 'week' | 'month';
export const ZOOMS: Zoom[] = ['week', 'month'];
export const isZoom = (value: unknown): value is Zoom => value === 'week' || value === 'month';

/** A card as the timeline reads it: the board answer carries the optional start and creation days (`CardT`). */
export type TimelineCard = CardT;

const isoDay = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return parseISODate(day) ? day : null;
};

/** Whole days from `a` to `b` (negative when b is earlier). Dates are compared as UTC days, so DST never shifts a bar. */
export function daysBetween(a: string, b: string): number {
  const pa = parseISODate(a);
  const pb = parseISODate(b);
  if (!pa || !pb) throw new RangeError(`Not an ISO date: ${a} / ${b}`);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

export type Span = {start: string; end: string; /** true when the card has no real start: it is drawn as a one-day marker on its due date. */ milestone: boolean};

/**
 * The days a card covers. The end is the due date (no due date = not on the timeline). The start is the start date,
 * else the creation day, else the due date itself. A start after the due date (bad data) collapses to the due date.
 */
export function cardSpan(card: TimelineCard): Span | null {
  const end = isoDay(card.dueDate);
  if (!end) return null;
  const start = isoDay(card.startDate) ?? isoDay(card.createdAt);
  if (!start || start > end) return {start: end, end, milestone: true};
  return {start, end, milestone: start === end};
}

export type TimelineRow = {card: TimelineCard; laneName: string; span: Span};

/** Scheduled cards in board order (lane, then position), and the ones with no due date. Archived cards never show. */
export function timelineRows(lanes: LaneT[]): {rows: TimelineRow[]; unscheduled: TimelineCard[]} {
  const rows: TimelineRow[] = [];
  const unscheduled: TimelineCard[] = [];
  for (const lane of lanes) {
    for (const card of [...lane.cards].sort(byPosition) as TimelineCard[]) {
      if (card.archived) continue;
      const span = cardSpan(card);
      if (span) rows.push({card, laneName: lane.name, span});
      else unscheduled.push(card);
    }
  }
  return {rows, unscheduled};
}

export type Window = {start: string; days: number; zoom: Zoom};

/** The visible days: week zoom = 4 weeks from the week start, month zoom = 3 months from the 1st. */
export function windowFor(anchor: string, zoom: Zoom, firstDay = 1): Window {
  if (zoom === 'week') return {start: startOfWeek(anchor, ((Math.trunc(firstDay) % 7) + 7) % 7), days: 28, zoom};
  const p = parseISODate(anchor);
  if (!p) throw new RangeError(`Not an ISO date: ${anchor}`);
  const start = toISODate(p.year, p.month, 1);
  return {start, days: daysBetween(start, addMonths(start, 3)), zoom};
}

/** Moves the anchor by one step: a week in week zoom, a month in month zoom. */
export const shiftAnchor = (anchor: string, zoom: Zoom, direction: -1 | 1): string => (zoom === 'week' ? addDays(anchor, 7 * direction) : addMonths(anchor, direction));

export type Placement = {/** 1-based grid column. */ col: number; span: number; clippedStart: boolean; clippedEnd: boolean};

/** Where a span sits in the window's day columns, clipped to it; null when it lies entirely outside. */
export function placeSpan(span: Span, win: Window): Placement | null {
  const first = daysBetween(win.start, span.start);
  const last = daysBetween(win.start, span.end);
  if (last < 0 || first > win.days - 1) return null;
  const from = Math.max(first, 0);
  const to = Math.min(last, win.days - 1);
  return {col: from + 1, span: to - from + 1, clippedStart: first < 0, clippedEnd: last > win.days - 1};
}

/** The column of `day` in the window (1-based), or null when today is not visible. */
export function todayColumn(today: string, win: Window): number | null {
  const offset = daysBetween(win.start, today);
  return offset >= 0 && offset < win.days ? offset + 1 : null;
}

/** Month header segments: each month the window touches with its first column and width. */
export function monthSegments(win: Window): {iso: string; col: number; span: number}[] {
  const out: {iso: string; col: number; span: number}[] = [];
  for (let i = 0; i < win.days; i++) {
    const iso = addDays(win.start, i);
    const key = iso.slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.iso.slice(0, 7) === key) last.span += 1;
    else out.push({iso, col: i + 1, span: 1});
  }
  return out;
}

/** Moving a due date by whole days (the keyboard edit); the start never moves, so the bar grows or shrinks. */
export const shiftedDue = (card: Pick<CardT, 'dueDate'>, days: number): string | null => (card.dueDate && parseISODate(card.dueDate) ? addDays(card.dueDate, days) : null);
