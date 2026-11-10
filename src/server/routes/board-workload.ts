import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {requireAuth, withDb, withViewer} from '../../platform/guards';
import {idOf, invalid} from '../validation';
import {dateOnly, noStore, seatFilter} from './card-detail';
import {boardFor, refused} from './boards';

/**
 * The Workload view of ONE board: who has how much open work.
 *
 *   GET /boards/:id/workload?today=YYYY-MM-DD   (today: the caller's own calendar day; default the server's UTC day)
 *
 * Answer: {lanes: [{id, name}], people: [{id, name, open, overdue, dueSoon, estimateMinutes, lanes: [{laneId, count}]}],
 *          unassigned: {open, overdue, dueSoon, estimateMinutes, lanes} | null, truncated}
 *
 * Rules (server side):
 *  - READ access to the board (boardFor 'read': another workspace, a private board without a seat and somebody else's
 *    Inbox are all 404). The board AND the workspace are in every where; no client id is trusted.
 *  - "Open" = a card that is not archived, not completed, in a lane that is not archived. A card with two people counts for BOTH
 *    (it is work on both desks), so the people's numbers can add up to more than the board's. "Unassigned" = open cards with
 *    NO card_members row at all (a card whose only assignees lost their seat shows under nobody).
 *  - Only people who can still see the board are listed: an active workspace member passing the same seat rule the card
 *    panel uses (seatFilter: private boards need a seat, an Inbox is its owner's alone, and an Inbox board has no workload).
 *  - "Overdue" = due before `today`; "dueSoon" = due from `today` up to 7 days after it. Estimate = the sum of
 *    cards.estimate_minutes (cards with no estimate add nothing).
 *  - Names only: never an email address. Bounded: the 100 busiest people (truncated says there were more), at most 5000 rows.
 *  - ONE aggregate statement (plus the lane names, in parallel): no query per person or per lane. Not cached: the answer
 *    depends on who is asking (their seat) and must show a card the moment it moves.
 */

export const MAX_WORKLOAD_PEOPLE = 100;
const MAX_ROWS = 5000;

type Row = {user_id: number | null; name: string | null; lane_id: number; open: number; overdue: number; soon: number; est: number};
type Totals = {open: number; overdue: number; dueSoon: number; estimateMinutes: number; lanes: {laneId: number; count: number}[]};
export type WorkloadPerson = Totals & {id: number; name: string};

const todayQuery = validator('query', (value, c) => {
  const raw = (value as Record<string, unknown>).today;
  if (raw === undefined || raw === '') return {today: new Date().toISOString().slice(0, 10)};
  const parsed = dateOnly(raw);
  if (!parsed.ok || parsed.value === null) return invalid(c, {today: {code: 'invalid', message: 'Use a date like 2026-11-04.'}});
  return {today: raw as string};
});

/** Pure: rows of (person, lane) sums into the answer's shape, busiest first; the unassigned rows become one entry. */
export function shapeWorkload(rows: Row[], limit = MAX_WORKLOAD_PEOPLE): {people: WorkloadPerson[]; unassigned: Totals | null; truncated: boolean} {
  const add = (t: Totals, r: Row) => {
    t.open += r.open;
    t.overdue += r.overdue;
    t.dueSoon += r.soon;
    t.estimateMinutes += r.est;
    t.lanes.push({laneId: r.lane_id, count: r.open});
  };
  const empty = (): Totals => ({open: 0, overdue: 0, dueSoon: 0, estimateMinutes: 0, lanes: []});
  const byUser = new Map<number, WorkloadPerson>();
  let unassigned: Totals | null = null;
  for (const r of rows) {
    if (r.user_id === null) {
      unassigned ??= empty();
      add(unassigned, r);
      continue;
    }
    let p = byUser.get(r.user_id);
    if (!p) byUser.set(r.user_id, (p = {id: r.user_id, name: r.name ?? '', ...empty()}));
    add(p, r);
  }
  const all = [...byUser.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name) || a.id - b.id);
  return {people: all.slice(0, limit), unassigned, truncated: all.length > limit};
}

export const boardWorkloadRoutes = new Hono().get('/boards/:id/workload', todayQuery, withViewer, requireAuth, withDb, noStore, async c => {
  const db = c.var.db;
  const ctx = await boardFor(db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
  if (refused(ctx)) return c.json(ctx.body, ctx.status);
  const {boardId} = ctx;
  const {workspaceId, visibility} = ctx.access;
  const {today} = c.req.valid('query');
  const seats = seatFilter({visibility, boardId, inboxOf: null});

  const [rows, lanes] = await Promise.all([
    db.$queryRaw<Row[]>`
      WITH oc AS (
        SELECT c.id, c.lane_id, c.due_date, c.estimate_minutes
        FROM cards c
        JOIN lanes l ON l.id = c.lane_id AND l.archived_at IS NULL
        JOIN boards b ON b.id = c.board_id AND b.inbox_of IS NULL
        WHERE c.board_id = ${boardId} AND c.workspace_id = ${workspaceId}
          AND c.archived_at IS NULL AND c.completed_at IS NULL
      ),
      busiest AS (
        SELECT cm.user_id, count(*) AS n
        FROM oc
        JOIN card_members cm ON cm.card_id = oc.id
        JOIN workspace_members m ON m.user_id = cm.user_id AND m.workspace_id = ${workspaceId}
        JOIN users u ON u.id = cm.user_id AND u.status = 'active'
        WHERE true ${seats}
        GROUP BY cm.user_id
        ORDER BY n DESC, cm.user_id
        LIMIT ${MAX_WORKLOAD_PEOPLE + 1}
      )
      SELECT cm.user_id, u.name, oc.lane_id,
             count(*)::int AS open,
             (count(*) FILTER (WHERE oc.due_date < ${today}::date))::int AS overdue,
             (count(*) FILTER (WHERE oc.due_date >= ${today}::date AND oc.due_date <= ${today}::date + 7))::int AS soon,
             COALESCE(sum(oc.estimate_minutes), 0)::int AS est
      FROM busiest bz
      JOIN card_members cm ON cm.user_id = bz.user_id
      JOIN oc ON oc.id = cm.card_id
      JOIN users u ON u.id = bz.user_id
      GROUP BY cm.user_id, u.name, oc.lane_id
      UNION ALL
      SELECT NULL::int, NULL::text, oc.lane_id,
             count(*)::int,
             (count(*) FILTER (WHERE oc.due_date < ${today}::date))::int,
             (count(*) FILTER (WHERE oc.due_date >= ${today}::date AND oc.due_date <= ${today}::date + 7))::int,
             COALESCE(sum(oc.estimate_minutes), 0)::int
      FROM oc
      WHERE NOT EXISTS (SELECT 1 FROM card_members cm2 WHERE cm2.card_id = oc.id)
      GROUP BY oc.lane_id
      LIMIT ${MAX_ROWS}`,
    db.lane.findMany({
      where: {boardId, workspaceId, archivedAt: null},
      select: {id: true, name: true},
      orderBy: [{position: 'asc'}, {id: 'asc'}],
      take: 200,
    }),
  ]);

  const shaped = shapeWorkload(rows);
  return c.json({lanes, ...shaped});
});
