import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {softCheck} from '../soft-limit';
import {afterResponse} from '../after-response';
import {parseCardNumber} from '../card-number';
import {membership, notFound, rankOf} from '../workspaces';
import {idOf, invalid, likeEscape} from '../validation';

/**
 * Phase 3: search and My Day. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET  /workspaces/:id/search?q=&before=       cards (title, description), boards and people names
 *   GET  /my-day?today=YYYY-MM-DD                cards assigned to me across every workspace I am in
 *
 * Access: the visitor's workspace membership is in EVERY query (a join on `workspace_members`, or the
 * `membership()` guard); private boards only for board members and workspace owners/admins; another user's
 * Inbox never. People are answered as id, name and workspace role: NEVER an email address.
 *
 * Search is bounded ILIKE (wildcards escaped with `likeEscape`). Trigram GIN indexes (migration
 * `search_trigram`, only when the database allows pg_trgm) speed it up; the query is the same and correct without them. It is always scoped to ONE workspace (`workspace_id` is the leading
 * column of the card indexes), capped at 20 cards per page and keyset-paged on the card id.
 */

const SEARCH_CARDS = 20;
/** Searches per user per minute (the ILIKE scan is the costly read here). */
const SEARCH_PER_MINUTE = 90;

/** The limiter's cache read; the count is recorded after the answer (`record` through afterResponse). */
function searchLimit(userId: number) {
  return softCheck(userId, 'search', SEARCH_PER_MINUTE, 60);
}
const SEARCH_SIDE = 8;
const MIN_QUERY = 2;
/**
 * Trigram indexes (pg_trgm) only help a pattern of 3+ characters. A 2-character search matches titles only: the
 * descriptions (up to 10k characters each) would be read for every card of the workspace on each keystroke.
 */
const MIN_DESCRIPTION_QUERY = 3;
const MAX_QUERY = 80;
const MY_DAY_CAP = 200;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/* ---------------------------------------------------------------- search */

const searchQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY) : '',
  before: typeof value.before === 'string' ? value.before : '',
}));

type CardHit = {
  id: number;
  number: number | null;
  title: string;
  board_id: number;
  board_name: string;
  lane_name: string;
  due_date: Date | null;
  completed_at: Date | null;
  priority: string;
};

/* --------------------------------------------------------------- my day */

const todayQuery = validator('query', (value, c) => {
  const now = Date.now();
  const raw = value.today;
  if (raw === undefined || raw === '') return {today: new Date(now).toISOString().slice(0, 10)};
  const ok = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = ok ? new Date(`${raw}T00:00:00.000Z`) : null;
  // The visitor's own calendar day: any time zone is within about a day of the server's UTC day.
  if (!parsed || parsed.toISOString().slice(0, 10) !== raw || Math.abs(parsed.getTime() - now) > 2 * 86_400_000) {
    return invalid(c, {today: {code: 'invalid', message: 'Use a date like 2026-05-01.'}});
  }
  return {today: raw as string};
});

type DayRow = {
  id: number;
  number: number | null;
  title: string;
  priority: string;
  due_date: Date | null;
  workspace_id: number;
  workspace_name: string;
  board_id: number;
  board_name: string;
  lane_name: string;
  completed: boolean;
};

const addDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

function groupOf(due: string | null, today: string, weekEnd: string): 'overdue' | 'today' | 'next7' | 'later' | 'none' {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return due <= weekEnd ? 'next7' : 'later';
}

export const searchRoutes = new Hono()
  /* ------------------------------------------------------------ search */
  .get('/workspaces/:id/search', searchQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const {q, before: rawBefore} = c.req.valid('query');
    // A one-digit number (`#2`, `2`) is a card number, not a text search: only the numbered probe runs for it.
    const short = q.length < MIN_QUERY;
    const empty = short && parseCardNumber(q) === null;
    // The membership read and the limiter's cache read side by side; nothing is counted unless a search runs.
    const [member, limit] = await Promise.all([membership(db, workspaceId, userId), empty ? null : searchLimit(userId)]);
    if (!member) return notFound(c);
    const before = idOf(rawBefore) ?? 2_147_483_647;
    if (empty || !limit) return c.json({cards: [], boards: [], people: [], nextBefore: null});
    if (limit.limited) {
      c.header('Retry-After', '30');
      return c.json(problem('rate_limited', 'Too many searches. Wait a moment and try again.'), 429);
    }
    // The count is written after the answer: the visitor does not wait for the cache write.
    await afterResponse(c, 'search limiter', limit.record);
    const pattern = `%${likeEscape(q)}%`;
    const seesAll = rankOf(member.role) >= 3;
    const firstPage = before === 2_147_483_647;

    // `#42` or `42`: the cards numbered 42 on each board (the unique index (board_id, number)), shown first.
    const wanted = firstPage ? parseCardNumber(q) : null;

    // One round: cards, boards, people in parallel (each ONE bounded query).
    const [cards, boards, people, numbered] = await Promise.all([
      short
        ? Promise.resolve([] as CardHit[])
        : db.$queryRaw<CardHit[]>`
        SELECT c.id, c.number, c.title, c.board_id, b.name AS board_name, l.name AS lane_name, c.due_date, c.completed_at, c.priority
        FROM cards c
        JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
        JOIN lanes l ON l.id = c.lane_id
        WHERE c.workspace_id = ${workspaceId} AND c.id < ${before}
          AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
          AND (b.inbox_of IS NULL OR b.inbox_of = ${userId})
          AND (${seesAll}::boolean OR b.visibility <> 'private' OR b.inbox_of = ${userId}
               OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId}))
          AND (c.title ILIKE ${pattern} OR (${q.length >= MIN_DESCRIPTION_QUERY}::boolean AND c.description_md ILIKE ${pattern}))
        ORDER BY c.id DESC
        LIMIT ${SEARCH_CARDS + 1}`,
      firstPage && !short
        ? db.$queryRaw<{id: number; name: string; visibility: string}[]>`
            SELECT b.id, b.name, b.visibility
            FROM boards b
            WHERE b.workspace_id = ${workspaceId} AND b.archived_at IS NULL AND b.inbox_of IS NULL
              AND (${seesAll}::boolean OR b.visibility <> 'private'
                   OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId}))
              AND b.name ILIKE ${pattern}
            ORDER BY b.id DESC
            LIMIT ${SEARCH_SIDE}`
        : Promise.resolve([]),
      firstPage && !short
        ? db.$queryRaw<{id: number; name: string; role: string}[]>`
            SELECT u.id, u.name, wm.role
            FROM workspace_members wm
            JOIN users u ON u.id = wm.user_id
            WHERE wm.workspace_id = ${workspaceId} AND u.status = 'active' AND u.name ILIKE ${pattern}
            ORDER BY u.name, u.id
            LIMIT ${SEARCH_SIDE}`
        : Promise.resolve([]),
      // Same visibility rule as the text search; one probe of the unique index per board of the workspace.
      wanted === null
        ? Promise.resolve([] as CardHit[])
        : db.$queryRaw<CardHit[]>`
            SELECT c.id, c.number, c.title, c.board_id, b.name AS board_name, l.name AS lane_name, c.due_date, c.completed_at, c.priority
            FROM boards b
            JOIN LATERAL (
              SELECT id, number, title, lane_id, board_id, due_date, completed_at, priority
              FROM cards
              WHERE board_id = b.id AND number = ${wanted}::int AND workspace_id = b.workspace_id AND archived_at IS NULL
            ) c ON true
            JOIN lanes l ON l.id = c.lane_id
            WHERE b.workspace_id = ${workspaceId} AND l.archived_at IS NULL AND b.archived_at IS NULL
              AND (b.inbox_of IS NULL OR b.inbox_of = ${userId})
              AND (${seesAll}::boolean OR b.visibility <> 'private' OR b.inbox_of = ${userId}
                   OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId}))
            ORDER BY b.id DESC
            LIMIT ${SEARCH_SIDE}`,
    ]);
    const seen = new Set(numbered.map(h => h.id));
    const text = cards.filter(h => !seen.has(h.id));
    const textPart = text.slice(0, SEARCH_CARDS - numbered.length);
    const page = [...numbered, ...textPart];
    return c.json({
      cards: page.map(r => ({
        id: r.id,
        number: r.number,
        title: r.title,
        boardId: r.board_id,
        boardName: r.board_name,
        laneName: r.lane_name,
        dueDate: dayOf(r.due_date),
        completed: r.completed_at !== null,
        priority: r.priority,
      })),
      boards,
      people,
      // The text hits page by id; the numbered ones are only on the first page, so the cursor comes from the text hits.
      nextBefore: text.length > textPart.length ? (textPart.at(-1)?.id ?? null) : null,
    });
  })

  /* ------------------------------------------------------------ my day */
  .get('/my-day', todayQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const {today} = c.req.valid('query');
    const weekEnd = addDays(today, 7);
    // ONE query: my assignments, in workspaces I am still in, on boards I may see (the visibility rule of
    // boardAccess() in SQL), never another user's Inbox. Index: card_members(user_id, workspace_id, card_id).
    // A card done in the last day stays (shown ticked, with an Archive button) so ticking it leaves it in place;
    // older done cards (a board's Done lane is rarely archived) stay out, or every card ever finished would come back.
    // Done cards sort last so open cards always fit the cap. Archiving the card, its lane or its board drops it.
    const rows = await c.var.db.$queryRaw<DayRow[]>`
      SELECT c.id, c.number, c.title, c.priority, c.due_date, c.workspace_id, w.name AS workspace_name,
             c.board_id, b.name AS board_name, l.name AS lane_name, (c.completed_at IS NOT NULL) AS completed
      FROM card_members cm
      JOIN cards c ON c.id = cm.card_id AND c.workspace_id = cm.workspace_id
      JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = ${userId}
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
      JOIN lanes l ON l.id = c.lane_id
      WHERE cm.user_id = ${userId} AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
        AND (c.completed_at IS NULL OR c.completed_at > now() - interval '1 day')
        AND (b.inbox_of IS NULL OR b.inbox_of = ${userId})
        AND (wm.role IN ('owner', 'admin') OR b.visibility <> 'private' OR b.inbox_of = ${userId}
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId}))
      ORDER BY (c.completed_at IS NOT NULL), c.due_date ASC NULLS LAST, c.id DESC
      LIMIT ${MY_DAY_CAP + 1}`;
    // Done-last only decides which cards fit the cap; the list itself is by due date, so ticking a card leaves it in
    // place instead of dropping it to the bottom of its group.
    const time = (d: Date | null) => (d ? d.getTime() : Infinity);
    const page = rows.slice(0, MY_DAY_CAP).sort((a, b) => time(a.due_date) - time(b.due_date) || b.id - a.id);
    return c.json({
      today,
      // Only an OPEN card left out counts (done ones sort last, so the first one cut tells).
      truncated: rows.length > MY_DAY_CAP && !rows[MY_DAY_CAP].completed,
      items: page.map(r => {
        const due = dayOf(r.due_date);
        return {
          id: r.id,
          number: r.number,
          title: r.title,
          priority: r.priority,
          dueDate: due,
          group: groupOf(due, today, weekEnd),
          workspaceId: r.workspace_id,
          workspaceName: r.workspace_name,
          boardId: r.board_id,
          boardName: r.board_name,
          laneName: r.lane_name,
          completed: r.completed,
        };
      }),
    });
  });
