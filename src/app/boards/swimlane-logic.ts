import type {CardT, LaneT} from '../api';

/** Pure logic of the board's swimlanes (tests/swimlanes.test.ts): no React, no network. */
export const GROUP_BYS = ['none', 'assignee', 'label', 'priority'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (value: unknown): value is GroupBy => (GROUP_BYS as readonly unknown[]).includes(value);

export const groupByStorageKey = (userId: number | null, boardId: number) => `lanefold.boardGroupBy.${userId ?? 0}.${boardId}`;

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'] as const;

export type SwimGroup = {
  /** Stable id: `m:<memberId>`, `l:<labelId>`, `p:<priority>` or `none`. */
  key: string;
  kind: Exclude<GroupBy, 'none'>;
  /** Name for people and labels; for priority and the "nobody" row the UI translates from `kind` + `key`. */
  name: string | null;
  colorHex: string | null;
  /** All the board's lanes (same order), each holding only this group's cards. */
  lanes: LaneT[];
  cardCount: number;
};

/** The group keys a card belongs to. A card with two assignees (or labels) shows in both rows; with none, in the last row. */
export function groupKeysOf(card: CardT, by: Exclude<GroupBy, 'none'>): string[] {
  if (by === 'priority') return [`p:${card.priority || 'none'}`];
  const items = by === 'assignee' ? (card.members ?? []).map(m => `m:${m.id}`) : (card.labels ?? []).map(l => `l:${l.id}`);
  return items.length ? [...new Set(items)] : ['none'];
}

/**
 * Splits the board into rows. Every row keeps every lane (so columns line up and a card can be dropped in any
 * lane of its row), but only the cards of that group. Rows without a card are left out. Order: people and labels
 * by name, "nobody" last; priorities from urgent down. `visible` (the board filter) is applied first.
 */
export function buildSwimGroups(lanes: LaneT[], by: GroupBy, visible: ((card: CardT) => boolean) | null = null): SwimGroup[] {
  if (by === 'none') return [];
  const meta = new Map<string, {name: string | null; colorHex: string | null}>();
  const buckets = new Map<string, Map<number, CardT[]>>();
  for (const lane of lanes) {
    for (const card of lane.cards) {
      if (visible && !visible(card)) continue;
      for (const key of groupKeysOf(card, by)) {
        if (!meta.has(key)) {
          const member = key.startsWith('m:') ? card.members?.find(m => `m:${m.id}` === key) : undefined;
          const label = key.startsWith('l:') ? card.labels?.find(l => `l:${l.id}` === key) : undefined;
          meta.set(key, {name: member?.name ?? label?.name ?? null, colorHex: label?.colorHex ?? null});
        }
        const perLane = buckets.get(key) ?? new Map<number, CardT[]>();
        perLane.set(lane.id, [...(perLane.get(lane.id) ?? []), card]);
        buckets.set(key, perLane);
      }
    }
  }
  const rank = (key: string) => (key === 'none' ? 1 : 0);
  const keys = [...buckets.keys()].sort((a, b) => {
    if (by === 'priority') return PRIORITY_ORDER.indexOf(a.slice(2) as (typeof PRIORITY_ORDER)[number]) - PRIORITY_ORDER.indexOf(b.slice(2) as (typeof PRIORITY_ORDER)[number]);
    return rank(a) - rank(b) || (meta.get(a)!.name ?? '').localeCompare(meta.get(b)!.name ?? '') || a.localeCompare(b);
  });
  return keys.map(key => {
    const perLane = buckets.get(key)!;
    const rowLanes = lanes.map(lane => ({...lane, cards: perLane.get(lane.id) ?? []}));
    return {key, kind: by, ...meta.get(key)!, lanes: rowLanes, cardCount: rowLanes.reduce((n, l) => n + l.cards.length, 0)};
  });
}
