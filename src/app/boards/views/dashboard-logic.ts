import {addDays, parseISODate, startOfWeek} from '../../../portal/ui/date';
import type {CardT, LaneT} from '../../api';

/** Pure numbers behind the Dashboard view: no React, no network (tests/dashboard-logic.test.ts). */

export const DUE_SOON_DAYS = 7;
export const WEEKS_SHOWN = 8;

export type LaneCount = {laneId: number; name: string; count: number};
export type AssigneeCount = {id: number; name: string; count: number};
export type WeekBucket = {start: string; done: number; open: number};
export type DashboardStats = {
  total: number;
  done: number;
  open: number;
  overdue: number;
  dueSoon: number;
  byLane: LaneCount[];
  byAssignee: AssigneeCount[];
  unassigned: number;
  weeks: WeekBucket[];
};

const validDue = (card: CardT): string | null => (card.dueDate && parseISODate(card.dueDate) ? card.dueDate : null);

/**
 * Counts over the cards the client holds. Archived cards are left out. "Overdue" and "due soon" only count open
 * cards (a completed card is never late); due soon is today through the next 7 days. A card with several members
 * counts once for each of them. There is no completion timestamp on a card, so the weekly chart buckets cards by
 * DUE week: how many of the cards due that week are done and how many are still open.
 */
export function dashboardStats(lanes: LaneT[], today: string, firstDayOfWeek = 0): DashboardStats {
  const soonEnd = addDays(today, DUE_SOON_DAYS);
  const thisWeek = startOfWeek(today, firstDayOfWeek);
  const firstWeek = addDays(thisWeek, -7 * (WEEKS_SHOWN - 1));
  const weeks: WeekBucket[] = Array.from({length: WEEKS_SHOWN}, (_, i) => ({start: addDays(firstWeek, 7 * i), done: 0, open: 0}));
  const people = new Map<number, AssigneeCount>();
  const byLane: LaneCount[] = [];
  let total = 0, done = 0, overdue = 0, dueSoon = 0, unassigned = 0;

  for (const lane of lanes) {
    const cards = lane.cards.filter(c => !c.archived);
    byLane.push({laneId: lane.id, name: lane.name, count: cards.length});
    for (const card of cards) {
      total++;
      if (card.completed) done++;
      const due = validDue(card);
      if (!card.completed && due) {
        if (due < today) overdue++;
        else if (due <= soonEnd) dueSoon++;
      }
      if (due) {
        const bucket = weeks.find(w => due >= w.start && due <= addDays(w.start, 6));
        if (bucket) card.completed ? bucket.done++ : bucket.open++;
      }
      const members = card.members ?? [];
      if (members.length === 0) unassigned++;
      for (const m of members) {
        const entry = people.get(m.id) ?? {id: m.id, name: m.name, count: 0};
        entry.count++;
        people.set(m.id, entry);
      }
    }
  }
  const byAssignee = [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.id - b.id);
  return {total, done, open: total - done, overdue, dueSoon, byLane, byAssignee, unassigned, weeks};
}
