import type {CardT, LaneT} from '../api';
import {parseISODate} from '../../portal/ui/date';

/** Pure logic of the board filter panel: no React, no network (tests/board-filter.test.ts). Same shape as a saved filter. */
export const DUE_OPTIONS = ['none', 'overdue', 'day', 'week', 'month'] as const;
export const PRIORITY_OPTIONS = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type DueOption = (typeof DUE_OPTIONS)[number];

export type BoardFilter = {
  text?: string;
  labelIds?: number[];
  /** Cards that have no label at all. */
  noLabels?: boolean;
  memberIds?: number[];
  /** Cards that have no member at all. */
  noMembers?: boolean;
  /** Any of these due states (a card passes when it fits one). */
  dues?: DueOption[];
  /** A custom due range, YYYY-MM-DD, both ends included; either end may be open. Part of the due group (any-of with `dues`). */
  dueFrom?: string;
  dueTo?: string;
  status?: 'complete' | 'incomplete';
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  /** How the criteria combine: `any` (default) = at least one, `all` = every one. */
  match?: 'any' | 'all';
};

/** Lower case, no accents: "Café" matches "cafe". */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** The viewer's LOCAL calendar date as YYYY-MM-DD (due dates are plain dates, compared as strings). */
export function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** How many criteria groups are set (the badge on the Filter button). `match` alone is not a criterion. */
export function activeCount(f: BoardFilter): number {
  return (
    (f.text?.trim() ? 1 : 0) +
    (f.labelIds?.length || f.noLabels ? 1 : 0) +
    (f.memberIds?.length || f.noMembers ? 1 : 0) +
    (f.dues?.length || f.dueFrom || f.dueTo ? 1 : 0) +
    (f.status ? 1 : 0) +
    (f.priority ? 1 : 0)
  );
}
export const isActive = (f: BoardFilter) => activeCount(f) > 0;

/** A date `days` after `now`, as YYYY-MM-DD. */
const plusDays = (now: Date, days: number) => localISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));

/** Does one due option fit the card? overdue = before today and not completed; day = today or tomorrow; week = next 7 days; month = next 30 days. */
function fitsDue(card: CardT, due: DueOption, now: Date): boolean {
  const date = card.dueDate;
  if (due === 'none') return date === null;
  if (date === null) return false;
  const today = localISODate(now);
  if (due === 'overdue') return date < today && !card.completed;
  return date >= today && date <= plusDays(now, due === 'day' ? 1 : due === 'week' ? 7 : 30);
}

/** Is the card's due date inside the custom range (both ends included)? No range set: false. */
function fitsDueRange(card: CardT, from: string | undefined, to: string | undefined): boolean {
  if (!from && !to) return false;
  const date = card.dueDate;
  if (date === null) return false;
  return (!from || date >= from) && (!to || date <= to);
}

/**
 * Does the card pass? Each criteria group (keyword, labels, members, due, status, priority) is either met or not;
 * `match: 'any'` (default) wants one met group, `all` wants every set group. Inside a group the picks are any-of.
 */
export function matchesFilter(card: CardT, filter: BoardFilter, now: Date): boolean {
  const groups: boolean[] = [];
  const raw = filter.text?.trim() ?? '';
  if (raw) {
    const text = fold(raw);
    // `#42` or `42` also finds the card numbered 42.
    const typed = /^#?\s*(\d{1,9})$/.exec(raw);
    groups.push(fold(card.title).includes(text) || !!(typed && card.number != null && Number(typed[1]) === card.number));
  }
  if (filter.labelIds?.length || filter.noLabels) {
    const labels = card.labels ?? [];
    groups.push((!!filter.noLabels && labels.length === 0) || labels.some(l => filter.labelIds?.includes(l.id)));
  }
  if (filter.memberIds?.length || filter.noMembers) {
    const members = card.members ?? [];
    groups.push((!!filter.noMembers && members.length === 0) || members.some(m => filter.memberIds?.includes(m.id)));
  }
  if (filter.dues?.length || filter.dueFrom || filter.dueTo) {
    groups.push((filter.dues ?? []).some(d => fitsDue(card, d, now)) || fitsDueRange(card, filter.dueFrom, filter.dueTo));
  }
  if (filter.status) groups.push(filter.status === 'complete' ? card.completed : !card.completed);
  if (filter.priority) groups.push((card.priority || 'none') === filter.priority);
  if (groups.length === 0) return true;
  return filter.match === 'all' ? groups.every(Boolean) : groups.some(Boolean);
}

/** A predicate for the views: everything passes when no filter is set. */
export function cardFilter(filter: BoardFilter, now: Date): (card: CardT) => boolean {
  return isActive(filter) ? card => matchesFilter(card, filter, now) : () => true;
}

/** Labels and members seen on the loaded cards (names only), for the pickers. */
export function collectFacets(lanes: LaneT[]) {
  const labels = new Map<number, {id: number; name: string; colorHex: string}>();
  const members = new Map<number, {id: number; name: string}>();
  for (const lane of lanes) {
    for (const card of lane.cards) {
      for (const l of card.labels ?? []) labels.set(l.id, l);
      for (const m of card.members ?? []) members.set(m.id, m);
    }
  }
  const byName = (a: {name: string}, b: {name: string}) => a.name.localeCompare(b.name);
  return {labels: [...labels.values()].sort(byName), members: [...members.values()].sort(byName)};
}

/** Counts of cards that pass vs loaded cards, over all lanes. */
export function countMatches(lanes: LaneT[], match: (card: CardT) => boolean) {
  let shown = 0;
  let total = 0;
  for (const lane of lanes) for (const card of lane.cards) { total++; if (match(card)) shown++; }
  return {shown, total};
}

export type OptionCounts = {
  noMembers: number;
  members: Map<number, number>;
  complete: number;
  incomplete: number;
  dues: Record<DueOption, number>;
  /** Cards inside the custom due range (0 when no range is set). */
  dueRange: number;
  noLabels: number;
  labels: Map<number, number>;
};

/**
 * For the filter panel: how many loaded cards each option would match ON ITS OWN (what ticking just that box shows),
 * in ONE pass over the cards, whatever the number of options.
 */
export function optionCounts(lanes: LaneT[], now: Date, range: {from?: string; to?: string} = {}): OptionCounts {
  const out: OptionCounts = {
    noMembers: 0,
    members: new Map(),
    complete: 0,
    incomplete: 0,
    dues: {none: 0, overdue: 0, day: 0, week: 0, month: 0},
    dueRange: 0,
    noLabels: 0,
    labels: new Map(),
  };
  const bump = (map: Map<number, number>, id: number) => map.set(id, (map.get(id) ?? 0) + 1);
  for (const lane of lanes) {
    for (const card of lane.cards) {
      if (card.id < 0) continue; // a card still being created
      const members = card.members ?? [];
      if (members.length === 0) out.noMembers++;
      for (const m of members) bump(out.members, m.id);
      if (card.completed) out.complete++;
      else out.incomplete++;
      for (const d of DUE_OPTIONS) if (fitsDue(card, d, now)) out.dues[d]++;
      if (fitsDueRange(card, range.from, range.to)) out.dueRange++;
      const labels = card.labels ?? [];
      if (labels.length === 0) out.noLabels++;
      for (const l of labels) bump(out.labels, l.id);
    }
  }
  return out;
}

/** Drops anything the strict server schema would refuse, so a stale session value never breaks a save. Reads the old single `due` too. */
export function cleanFilter(value: unknown): BoardFilter {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const ids = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((n): n is number => Number.isSafeInteger(n) && n > 0))].slice(0, 20) : []);
  const out: BoardFilter = {};
  if (typeof v.text === 'string' && v.text.trim()) out.text = v.text.slice(0, 80);
  if (ids(v.labelIds).length) out.labelIds = ids(v.labelIds);
  if (v.noLabels === true) out.noLabels = true;
  if (ids(v.memberIds).length) out.memberIds = ids(v.memberIds);
  if (v.noMembers === true) out.noMembers = true;
  const legacyDue = typeof v.due === 'string' ? [v.due === 'today' ? 'day' : v.due] : [];
  const dues = DUE_OPTIONS.filter(d => [...(Array.isArray(v.dues) ? v.dues : []), ...legacyDue].includes(d));
  if (dues.length) out.dues = dues;
  let from = parseISODate(v.dueFrom) ? (v.dueFrom as string) : undefined;
  let to = parseISODate(v.dueTo) ? (v.dueTo as string) : undefined;
  if (from && to && from > to) [from, to] = [to, from];
  if (from) out.dueFrom = from;
  if (to) out.dueTo = to;
  if (v.status === 'complete' || v.status === 'incomplete') out.status = v.status;
  if ((PRIORITY_OPTIONS as readonly unknown[]).includes(v.priority)) out.priority = v.priority as BoardFilter['priority'];
  if (v.match === 'all' && activeCount(out) > 0) out.match = 'all';
  return out;
}

export const filterStorageKey = (userId: number | null, boardId: number) => `lanefold.boardFilter.${userId ?? 0}.${boardId}`;
