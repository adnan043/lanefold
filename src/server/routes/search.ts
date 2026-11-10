import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {softLimited} from '../soft-limit';
import {parseCardNumber, reserveCardNumbers} from '../card-number';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {boardAccess, membership, notFound, rankOf} from '../workspaces';
import {idOf, intField, invalid, likeEscape, objectOf, textField} from '../validation';

/**
 * Phase 3: search, My Day and the personal Inbox. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET  /workspaces/:id/search?q=&before=       cards (title, description), boards and people names
 *   GET  /my-day?today=YYYY-MM-DD                cards assigned to me across every workspace I am in
 *   GET  /workspaces/:id/inbox?before=           my quick-capture cards in this workspace
 *   POST /workspaces/:id/inbox/cards             capture one card (creates my Inbox board on first use)
 *   POST /inbox/cards/:id/triage                 move an Inbox card into a lane of a board I can write
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

async function searchLimited(userId: number): Promise<boolean> {
  return softLimited(userId, 'search', SEARCH_PER_MINUTE, 60);
}
const SEARCH_SIDE = 8;
const MIN_QUERY = 2;
const MAX_QUERY = 80;
const MY_DAY_CAP = 200;
const INBOX_PAGE = 50;
const INBOX_CAP = 500;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const forbidden = (c: {json: (b: unknown, s: 403) => Response}) => c.json(problem('forbidden', 'You do not have access to this.'), 403);

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
};

const addDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

function groupOf(due: string | null, today: string, weekEnd: string): 'overdue' | 'today' | 'next7' | 'later' | 'none' {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return due <= weekEnd ? 'next7' : 'later';
}

/* ----------------------------------------------------------------- inbox */

const captureBody = validator('json', (value, c) => {
  const title = textField(objectOf(value)?.title, 1, 200);
  if (!title.ok) return invalid(c, {title: title.error});
  return {title: title.value};
});

const triageBody = validator('json', (value, c) => {
  const lane = intField(objectOf(value)?.laneId, 1, 2_147_483_647);
  if (!lane.ok) return invalid(c, {laneId: {code: 'required', message: 'Choose a lane.'}});
  return {laneId: lane.value};
});

/** Thrown inside a transaction to roll it back: the target lane is full, or the card moved meanwhile. */
class LaneFull extends Error {
  constructor(readonly why: 'full' | 'stale' = 'full') {
    super(why);
  }
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** `boards.rev + 1`, row-locked (same as boards.ts): every change on a board gets its own rev. */
async function bumpRev(tx: Tx, boardId: number, workspaceId: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`
    UPDATE boards SET rev = rev + 1, updated_at = now()
    WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  if (!rows[0]) throw new Error('board vanished');
  return rows[0].rev;
}

const inboxCardCols = {id: true, number: true, title: true, priority: true, dueDate: true, createdAt: true} as const;
const inboxShape = (r: {id: number; number: number | null; title: string; priority: string; dueDate: Date | null; createdAt: Date}) => ({
  id: r.id,
  number: r.number,
  title: r.title,
  priority: r.priority,
  dueDate: dayOf(r.dueDate),
  createdAt: r.createdAt.toISOString(),
});

export const searchRoutes = new Hono()
  /* ------------------------------------------------------------ search */
  .get('/workspaces/:id/search', searchQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(db, workspaceId, userId);
    if (!member) return notFound(c);
    const {q, before: rawBefore} = c.req.valid('query');
    const before = idOf(rawBefore) ?? 2_147_483_647;
    // A one-digit number (`#2`, `2`) is a card number, not a text search: only the numbered probe runs for it.
    const short = q.length < MIN_QUERY;
    if (short && parseCardNumber(q) === null) return c.json({cards: [], boards: [], people: [], nextBefore: null});
    if (await searchLimited(userId)) {
      c.header('Retry-After', '30');
      return c.json(problem('rate_limited', 'Too many searches. Wait a moment and try again.'), 429);
    }
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
          AND (c.title ILIKE ${pattern} OR c.description_md ILIKE ${pattern})
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
    const rows = await c.var.db.$queryRaw<DayRow[]>`
      SELECT c.id, c.number, c.title, c.priority, c.due_date, c.workspace_id, w.name AS workspace_name,
             c.board_id, b.name AS board_name, l.name AS lane_name
      FROM card_members cm
      JOIN cards c ON c.id = cm.card_id AND c.workspace_id = cm.workspace_id
      JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = ${userId}
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
      JOIN lanes l ON l.id = c.lane_id
      WHERE cm.user_id = ${userId} AND c.archived_at IS NULL AND l.archived_at IS NULL AND c.completed_at IS NULL AND b.archived_at IS NULL
        AND (b.inbox_of IS NULL OR b.inbox_of = ${userId})
        AND (wm.role IN ('owner', 'admin') OR b.visibility <> 'private' OR b.inbox_of = ${userId}
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId}))
      ORDER BY c.due_date ASC NULLS LAST, c.id DESC
      LIMIT ${MY_DAY_CAP + 1}`;
    const page = rows.slice(0, MY_DAY_CAP);
    return c.json({
      today,
      truncated: rows.length > MY_DAY_CAP,
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
        };
      }),
    });
  })

  /* ------------------------------------------------------------- inbox */
  .get('/workspaces/:id/inbox', searchQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(db, workspaceId, userId);
    if (!member) return notFound(c);
    const before = idOf(c.req.valid('query').before);
    // The board and its cards in ONE query (nested select); my Inbox only (`inboxOf: userId`).
    const board = await db.board.findFirst({
      where: {workspaceId, inboxOf: userId, archivedAt: null},
      orderBy: {id: 'asc'},
      select: {
        id: true,
        cards: {
          where: {workspaceId, archivedAt: null, completedAt: null, ...(before ? {id: {lt: before}} : {})},
          orderBy: {id: 'desc'},
          take: INBOX_PAGE + 1,
          select: inboxCardCols,
        },
      },
    });
    if (!board) return c.json({boardId: null, items: [], nextBefore: null});
    const page = board.cards.slice(0, INBOX_PAGE);
    return c.json({boardId: board.id, items: page.map(inboxShape), nextBefore: board.cards.length > INBOX_PAGE ? page.at(-1)!.id : null});
  })

  .post('/workspaces/:id/inbox/cards', captureBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(db, workspaceId, userId);
    if (!member) return notFound(c);
    if (rankOf(member.role) < 2) return forbidden(c);
    const ent = await getEntitlements(db, workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const {title} = c.req.valid('json');
    const out = await db.$transaction(async tx => {
      // Two quick captures must not make two Inboxes: serialise on (workspace, user).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${workspaceId}::int, ${userId}::int)`;
      let board = await tx.board.findFirst({
        where: {workspaceId, inboxOf: userId, archivedAt: null},
        orderBy: {id: 'asc'},
        select: {id: true, lanes: {where: {archivedAt: null}, orderBy: {id: 'asc'}, take: 1, select: {id: true, cardCount: true}}},
      });
      if (!board) {
        board = await tx.board.create({
          data: {
            workspaceId,
            name: 'Inbox',
            visibility: 'private',
            inboxOf: userId,
            rev: 1n,
            createdBy: userId,
            lanes: {create: {workspaceId, name: 'Inbox', position: generateKeyBetween(null, null), updatedRev: 1n}},
          },
          select: {id: true, lanes: {where: {archivedAt: null}, orderBy: {id: 'asc'}, take: 1, select: {id: true, cardCount: true}}},
        });
      }
      const lane = board.lanes[0];
      if (!lane) return 'broken' as const;
      if (lane.cardCount >= INBOX_CAP || lane.cardCount >= MAX_CARDS_PER_LANE) return 'full' as const;
      const rev = await bumpRev(tx, board.id, workspaceId);
      const last = await tx.card.findFirst({where: {workspaceId, laneId: lane.id, archivedAt: null}, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
      const number = await reserveCardNumbers(tx, board.id, workspaceId, 1);
      const card = await tx.card.create({
        data: {number, boardId: board.id, laneId: lane.id, workspaceId, title, position: generateKeyBetween(last?.position ?? null, null), updatedRev: rev, createdBy: userId},
        select: inboxCardCols,
      });
      await tx.lane.updateMany({where: {id: lane.id, boardId: board.id, workspaceId}, data: {cardCount: {increment: 1}, updatedRev: rev}});
      return {card, boardId: board.id};
    });
    if (out === 'full') return c.json(problem('limit_reached', `Your Inbox holds up to ${INBOX_CAP} cards. Move some to a board first.`), 409);
    if (out === 'broken') return c.json(problem('internal_error', 'Your Inbox could not be opened.'), 500);
    return c.json({boardId: out.boardId, card: inboxShape(out.card)}, 201);
  })

  .post('/inbox/cards/:id/triage', triageBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const cardId = idOf(c.req.param('id'));
    if (!cardId) return notFound(c, 'card');
    const {laneId} = c.req.valid('json');
    // The card must be in MY Inbox, in a workspace I am still in.
    const card = await db.card.findFirst({
      where: {id: cardId, archivedAt: null, board: {inboxOf: userId, archivedAt: null, workspace: {archivedAt: null, members: {some: {userId}}}}},
      select: {id: true, boardId: true, laneId: true, workspaceId: true},
    });
    if (!card) return notFound(c, 'card');
    // The target: a live lane of an ordinary board of the SAME workspace that I may write to.
    const target = await db.lane.findFirst({
      where: {id: laneId, workspaceId: card.workspaceId, archivedAt: null, board: {inboxOf: null, archivedAt: null}},
      select: {id: true, boardId: true},
    });
    if (!target) return notFound(c, 'lane');
    const access = await boardAccess(db, target.boardId, userId);
    if (!access || access.workspaceId !== card.workspaceId || access.archived) return notFound(c, 'lane');
    if (!access.canWrite) return forbidden(c);
    const ent = await getEntitlements(db, card.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const done = await db
      .$transaction(async tx => {
      // Lock the two boards in id order (no deadlock with a concurrent move the other way).
      const ids = [card.boardId, target.boardId].sort((a, b) => a - b);
      const revs = new Map<number, bigint>();
      for (const id of ids) revs.set(id, await bumpRev(tx, id, card.workspaceId));
      const last = await tx.card.findFirst({
        where: {workspaceId: card.workspaceId, laneId: target.id, archivedAt: null},
        orderBy: [{position: 'desc'}, {id: 'desc'}],
        select: {position: true},
      });
      // The target's cap is ONE conditional update; no room rolls the whole triage back.
      const room = await tx.$queryRaw<{id: number}[]>`
        UPDATE lanes SET card_count = card_count + 1, updated_rev = ${revs.get(target.boardId)!}
        WHERE id = ${target.id} AND board_id = ${target.boardId} AND workspace_id = ${card.workspaceId}
          AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
        RETURNING id`;
      if (!room[0]) throw new LaneFull();
      // A new number on the board it lands on (the card keeps its id).
      const number = await reserveCardNumbers(tx, target.boardId, card.workspaceId, 1);
      const {count} = await tx.card.updateMany({
        where: {id: card.id, boardId: card.boardId, laneId: card.laneId, workspaceId: card.workspaceId, archivedAt: null},
        data: {number, boardId: target.boardId, laneId: target.id, position: generateKeyBetween(last?.position ?? null, null), updatedRev: revs.get(target.boardId)!},
      });
      if (!count) throw new LaneFull('stale');
      // Labels belong to a board: the ones of the old board mean nothing on the new one.
      await tx.cardLabel.deleteMany({where: {cardId: card.id}});
      await tx.lane.updateMany({
        where: {id: card.laneId, boardId: card.boardId, workspaceId: card.workspaceId},
        data: {cardCount: {decrement: 1}, updatedRev: revs.get(card.boardId)!},
      });
      await tx.activity.create({
        data: {workspaceId: card.workspaceId, boardId: target.boardId, cardId: card.id, actorId: userId, kind: 'card.moved', meta: {from: 'inbox'}},
      });
      return true;
    })
      .catch(err => {
        if (err instanceof LaneFull) return err.why;
        throw err;
      });
    if (done === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    if (done !== true) return c.json(problem('stale', 'That card already moved.'), 409);
    return c.json({ok: true, boardId: target.boardId, laneId: target.id});
  });
