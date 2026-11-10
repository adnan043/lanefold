import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {getEntitlements} from '../entitlements';
import {boardAccess, membership, notFound, rankOf, boardReachable} from '../workspaces';
import {idOf, invalid, objectOf, textField} from '../validation';
import {seatFilter} from './card-detail';

/**
 * Phase 1 board extras. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET  /workspaces/:id/boards/archived?before=   archived boards I may see (keyset on id, 30 a page)
 *   GET  /boards/:id/archived-cards?before=        archived cards of one board (keyset on id, 30 a page)
 *   GET  /boards/:id/archived-lanes?before=        archived lanes of one board, with card_count (keyset on id, 30 a page)
 *   POST /lanes/:id/restore                        bring an archived lane back at the end of the board (write rights)
 *   POST /boards/:id/duplicate {name?, cards?}     copy a board's settings, lanes and labels, and (cards: true, the
 *                                                  default) its open cards with their labels, assignees and checklists;
 *                                                  member and up. Comments, attachments, covers and custom field values
 *                                                  stay with the original. Over MAX_COPY_CARDS open cards → 409.
 *
 * Restore uses the existing `PATCH /boards/:id {archived:false}` and `POST /cards/:id/restore`.
 * Access: `boardAccess()` / `membership()` put the visitor's workspace membership IN the query; another
 * workspace's ids answer 404, a viewer gets 403 on the write.
 */

const PAGE = 30;
const MAX_LANES = 50; // same cap as POST /boards/:id/lanes

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

const BOARDS_PER_HOUR = 20;
/** One duplicate copies at most this many open cards (one request on the Worker: bounded memory and time). */
const MAX_COPY_CARDS = 1000;
const MAX_COPY_LABELS = 200;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const cursorQuery = validator('query', value => ({before: typeof value.before === 'string' ? value.before : ''}));

const duplicateBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  if (v.cards !== undefined && typeof v.cards !== 'boolean') return invalid(c, {cards: {code: 'invalid', message: 'Must be true or false.'}});
  const cards = v.cards !== false;
  if (v.name === undefined) return {name: null as string | null, cards};
  const name = textField(v.name, 1, 80);
  if (!name.ok) return invalid(c, {name: name.error});
  return {name: name.value as string | null, cards};
});

export const boardExtraRoutes = new Hono()
  .get('/workspaces/:id/boards/archived', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(c.var.db, workspaceId, userId);
    if (!member) return notFound(c);
    const before = idOf(c.req.valid('query').before);
    const rows = await c.var.db.board.findMany({
      where: {
        workspaceId,
        archivedAt: {not: null},
        inboxOf: null,
        ...(before ? {id: {lt: before}} : {}),
        ...(member.rank >= 3 ? {} : {OR: [{visibility: {not: 'private'}}, {boardMembers: {some: {userId}}}]}),
      },
      orderBy: {id: 'desc'},
      take: PAGE + 1,
      select: {
        id: true,
        name: true,
        visibility: true,
        bgKind: true,
        bgColor1: true,
        bgColor2: true,
        bgAngle: true,
        archivedAt: true,
        boardMembers: {where: {userId}, select: {role: true}, take: 1},
      },
    });
    const page = rows.slice(0, PAGE);
    return c.json({
      items: page.map(b => ({
        id: b.id,
        name: b.name,
        visibility: b.visibility,
        bgKind: b.bgKind,
        bgColor1: b.bgColor1,
        bgColor2: b.bgColor2,
        bgAngle: b.bgAngle,
        archivedAt: b.archivedAt?.toISOString() ?? null,
        // The PATCH re-checks; this only decides whether the button shows.
        canRestore: member.rank >= 3 || b.boardMembers[0]?.role === 'admin',
      })),
      nextBefore: rows.length > PAGE ? page.at(-1)!.id : null,
    });
  })

  .get('/boards/:id/archived-cards', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    const before = idOf(c.req.valid('query').before);
    const rows = await c.var.db.card.findMany({
      where: {workspaceId: access.workspaceId, boardId, archivedAt: {not: null}, ...(before ? {id: {lt: before}} : {})},
      orderBy: {id: 'desc'},
      take: PAGE + 1,
      select: {id: true, title: true, archivedAt: true, lane: {select: {name: true, archivedAt: true}}},
    });
    const page = rows.slice(0, PAGE);
    return c.json({
      items: page.map(r => ({
        id: r.id,
        title: r.title,
        laneName: r.lane.name,
        laneArchived: r.lane.archivedAt !== null,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      })),
      canRestore: access.canWrite && !access.archived,
      nextBefore: rows.length > PAGE ? page.at(-1)!.id : null,
    });
  })

  .get('/boards/:id/archived-lanes', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    const before = idOf(c.req.valid('query').before);
    // One query: the lanes and their live card counts (no query per row).
    const rows = await c.var.db.$queryRaw<{id: number; name: string; archived_at: Date | null; card_count: bigint}[]>`
      WITH page AS (
        SELECT l.id, l.name, l.archived_at
        FROM lanes l
        WHERE l.workspace_id = ${access.workspaceId} AND l.board_id = ${boardId} AND l.archived_at IS NOT NULL
          ${before ? Prisma.sql`AND l.id < ${before}` : Prisma.empty}
        ORDER BY l.id DESC
        LIMIT ${PAGE + 1}
      )
      SELECT p.id, p.name, p.archived_at, count(k.id) AS card_count
      FROM page p
      LEFT JOIN cards k ON k.lane_id = p.id AND k.board_id = ${boardId} AND k.workspace_id = ${access.workspaceId} AND k.archived_at IS NULL
      GROUP BY p.id, p.name, p.archived_at
      ORDER BY p.id DESC`;
    const page = rows.slice(0, PAGE);
    return c.json({
      items: page.map(r => ({id: r.id, name: r.name, cardCount: Number(r.card_count), archivedAt: r.archived_at?.toISOString() ?? null})),
      canRestore: access.canWrite && !access.archived,
      nextBefore: rows.length > PAGE ? page.at(-1)!.id : null,
    });
  })

  .post('/lanes/:id/restore', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const laneId = idOf(c.req.param('id'));
    // The visitor's workspace membership is IN the query: another workspace's lane is a 404.
    const lane = laneId
      ? await db.lane.findFirst({where: {id: laneId, board: boardReachable(userId)}, select: {id: true, boardId: true, workspaceId: true, archivedAt: true}})
      : null;
    if (!lane) return notFound(c, 'lane');
    const access = await boardAccess(db, lane.boardId, userId);
    if (!access || access.workspaceId !== lane.workspaceId) return notFound(c, 'lane');
    if (!access.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const {workspaceId} = access;
    const result = await db.$transaction(async (tx: Tx) => {
      const rows = await tx.$queryRaw<{rev: bigint}[]>`
        UPDATE boards SET rev = rev + 1, updated_at = now()
        WHERE id = ${lane.boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
      if (!rows[0]) throw new Error('board vanished');
      const rev = rows[0].rev;
      // Count and last key are read AFTER the board lock, like POST /boards/:id/lanes.
      const [count, last] = await Promise.all([
        tx.lane.count({where: {workspaceId, boardId: lane.boardId, archivedAt: null}}),
        tx.lane.findFirst({where: {workspaceId, boardId: lane.boardId, archivedAt: null}, select: {position: true}, orderBy: [{position: 'desc'}, {id: 'desc'}]}),
      ]);
      if (count >= MAX_LANES) return 'limit' as const;
      const {count: changed} = await tx.lane.updateMany({
        where: {id: lane.id, boardId: lane.boardId, workspaceId, archivedAt: {not: null}},
        data: {archivedAt: null, position: generateKeyBetween(last?.position ?? null, null), updatedRev: rev},
      });
      if (!changed) return 'gone' as const; // already restored by someone else
      await tx.activity.create({data: {workspaceId, boardId: lane.boardId, actorId: userId, kind: 'lane.restored', meta: {laneId: lane.id}}});
      return rev;
    });
    if (result === 'limit') return c.json(problem('limit_reached', `A board holds up to ${MAX_LANES} lanes.`), 409);
    if (result === 'gone') return notFound(c, 'lane');
    return c.json({ok: true, rev: String(result)});
  })

  .post('/boards/:id/duplicate', duplicateBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    const {workspaceId} = access;
    if (!access.canWrite || rankOf(access.workspaceRole) < 2) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const ent = await getEntitlements(db, workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const recent = await db.board.findMany({
      where: {workspaceId, createdBy: userId, createdAt: {gt: new Date(Date.now() - 3_600_000)}},
      select: {id: true},
      take: BOARDS_PER_HOUR,
    });
    if (recent.length >= BOARDS_PER_HOUR) {
      c.header('Retry-After', '600');
      return c.json(problem('board_rate_limited', 'You created many boards in the last hour. Try again later.'), 429);
    }
    const keepCards = c.req.valid('json').cards;
    const [source, cards] = await Promise.all([
      db.board.findFirst({
        where: {id: boardId, workspaceId, inboxOf: null},
        select: {
          name: true,
          visibility: true,
          bgKind: true,
          bgColor1: true,
          bgColor2: true,
          bgAngle: true,
          bgPattern: true,
          nextCardNumber: true,
          lanes: {where: {archivedAt: null}, orderBy: [{position: 'asc'}, {id: 'asc'}], take: MAX_LANES, select: {id: true, name: true, position: true, colorHex: true, wipLimit: true}},
          labels: {orderBy: {id: 'asc'}, take: MAX_COPY_LABELS, select: {id: true, name: true, colorHex: true}},
        },
      }),
      keepCards
        ? db.card.findMany({
            where: {boardId, workspaceId, archivedAt: null, lane: {archivedAt: null}},
            orderBy: {id: 'asc'},
            take: MAX_COPY_CARDS + 1,
            select: {
              laneId: true,
              number: true,
              title: true,
              descriptionMd: true,
              position: true,
              priority: true,
              estimateMinutes: true,
              startDate: true,
              dueDate: true,
              dueAt: true,
              dueRemindMinutes: true,
              completedAt: true,
              labels: {select: {labelId: true}},
              members: {select: {userId: true}},
              checklists: {
                orderBy: [{position: 'asc'}, {id: 'asc'}],
                select: {
                  title: true,
                  position: true,
                  items: {orderBy: [{position: 'asc'}, {id: 'asc'}], select: {text: true, position: true, doneAt: true, assigneeId: true, dueDate: true, dueAt: true, dueRemindMinutes: true}},
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    if (!source) return notFound(c, 'board');
    if (cards.length > MAX_COPY_CARDS) {
      return c.json(problem('board_copy_too_big', `A board with more than ${MAX_COPY_CARDS} open cards cannot be copied with its cards.`), 409);
    }
    const name = (c.req.valid('json').name ?? `${source.name.slice(0, 73)} (copy)`).slice(0, 80);
    const board = await db.$transaction(async tx => {
      const row = await tx.board.create({
        data: {
          workspaceId,
          name,
          visibility: source.visibility,
          // The photo belongs to this board (its file is removed with it): a copy keeps the colours only.
          bgKind: source.bgKind === 'image' ? 'color' : source.bgKind,
          bgColor1: source.bgColor1,
          bgColor2: source.bgColor2,
          bgAngle: source.bgAngle,
          bgPattern: source.bgPattern,
          rev: 1n,
          createdBy: userId,
        },
        select: {id: true, name: true, visibility: true},
      });
      await tx.boardMember.create({data: {boardId: row.id, workspaceId, userId, role: 'admin'}});
      await copyContent(tx, {workspaceId, userId, boardId: row.id, visibility: row.visibility, source, cards});
      await tx.activity.create({data: {workspaceId, boardId: row.id, actorId: userId, kind: 'board.created', meta: {name, copiedFrom: boardId}}});
      return row;
    });
    return c.json({board}, 201);
  });

type CopyCard = {
  laneId: number;
  number: number | null;
  title: string;
  descriptionMd: string;
  position: string;
  priority: string;
  estimateMinutes: number | null;
  startDate: Date | null;
  dueDate: Date | null;
  dueAt: Date | null;
  dueRemindMinutes: number | null;
  completedAt: Date | null;
  labels: {labelId: number}[];
  members: {userId: number}[];
  checklists: {
    title: string;
    position: string;
    items: {text: string; position: string; doneAt: Date | null; assigneeId: number | null; dueDate: Date | null; dueAt: Date | null; dueRemindMinutes: number | null}[];
  }[];
};

type CopySource = {
  nextCardNumber: number;
  lanes: {id: number; name: string; position: string; colorHex: string | null; wipLimit: number | null}[];
  labels: {id: number; name: string; colorHex: string}[];
};

/**
 * Lanes, labels and cards of a duplicated board, in a fixed number of statements (never one per card).
 * Rows are matched back to their source by a unique key: lanes by position, cards by number, checklists by
 * (card, position); labels by id order, which is the order of `data` (one multi-row INSERT).
 */
async function copyContent(tx: Tx, a: {workspaceId: number; userId: number; boardId: number; visibility: string; source: CopySource; cards: CopyCard[]}) {
  const {workspaceId, userId, boardId, source} = a;
  const perLane = new Map<number, number>();
  for (const card of a.cards) perLane.set(card.laneId, (perLane.get(card.laneId) ?? 0) + 1);

  const lanes = source.lanes.length
    ? await tx.lane.createManyAndReturn({
        // Positions stay valid: they were unique keys of one list and the copy is a new list.
        data: source.lanes.map(l => ({boardId, workspaceId, name: l.name, position: l.position, colorHex: l.colorHex, wipLimit: l.wipLimit, cardCount: perLane.get(l.id) ?? 0, updatedRev: 1n})),
        select: {id: true, position: true},
      })
    : [];
  const laneByKey = new Map(lanes.map(l => [l.position, l.id]));
  const laneMap = new Map(source.lanes.map(l => [l.id, laneByKey.get(l.position)!]));

  const labels = source.labels.length
    ? await tx.label.createManyAndReturn({data: source.labels.map(l => ({boardId, workspaceId, name: l.name, colorHex: l.colorHex})), select: {id: true}})
    : [];
  const newLabelIds = labels.map(l => l.id).sort((x, y) => x - y);
  const labelMap = new Map(source.labels.map((l, i) => [l.id, newLabelIds[i]!]));

  const cards = a.cards.filter(card => laneMap.has(card.laneId));
  if (!cards.length) return;

  // Card numbers carry over (#12 stays #12 in the copy); a card from before numbering gets the next free one.
  let next = source.nextCardNumber;
  const numbered = cards.map(card => ({card, number: card.number ?? next++}));
  const highest = numbered.reduce((m, n) => Math.max(m, n.number), 0);
  await tx.board.update({where: {id: boardId}, data: {nextCardNumber: Math.max(next, highest + 1)}, select: {id: true}});

  // Assignees must still be able to see the copy (a private copy seats only the copier and workspace admins).
  const wanted = [...new Set(cards.flatMap(card => [...card.members.map(m => m.userId), ...card.checklists.flatMap(l => l.items.flatMap(i => (i.assigneeId ? [i.assigneeId] : [])))]))];
  const allowed = new Set(
    wanted.length
      ? (
          await tx.$queryRaw<{id: number}[]>`
            SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
            WHERE m.workspace_id = ${workspaceId}::int AND u.status = 'active' AND u.id IN (${Prisma.join(wanted)})
            ${seatFilter({visibility: a.visibility, boardId, inboxOf: null})}
            LIMIT ${wanted.length}`
        ).map(r => r.id)
      : [],
  );

  const created = await tx.card.createManyAndReturn({
    data: numbered.map(({card, number}) => ({
      number,
      boardId,
      laneId: laneMap.get(card.laneId)!,
      workspaceId,
      title: card.title,
      descriptionMd: card.descriptionMd,
      position: card.position,
      priority: card.priority,
      estimateMinutes: card.estimateMinutes,
      startDate: card.startDate,
      dueDate: card.dueDate,
      dueAt: card.dueAt,
      dueRemindMinutes: card.dueRemindMinutes,
      completedAt: card.completedAt,
      checklistTotal: card.checklists.reduce((n, l) => n + l.items.length, 0),
      checklistDone: card.checklists.reduce((n, l) => n + l.items.filter(i => i.doneAt).length, 0),
      updatedRev: 1n,
      createdBy: userId,
    })),
    select: {id: true, number: true},
  });
  const cardByNumber = new Map(created.map(r => [r.number!, r.id]));
  const made = numbered.map(({card, number}) => ({card, id: cardByNumber.get(number)!}));

  const cardLabels = made.flatMap(m => m.card.labels.flatMap(l => (labelMap.has(l.labelId) ? [{cardId: m.id, labelId: labelMap.get(l.labelId)!}] : [])));
  const cardMembers = made.flatMap(m => m.card.members.flatMap(p => (allowed.has(p.userId) ? [{cardId: m.id, userId: p.userId, workspaceId}] : [])));
  // One connection per transaction: these run one after the other anyway.
  if (cardLabels.length) await tx.cardLabel.createMany({data: cardLabels, skipDuplicates: true});
  if (cardMembers.length) await tx.cardMember.createMany({data: cardMembers, skipDuplicates: true});

  const lists = made.flatMap(m => m.card.checklists.map(l => ({cardId: m.id, source: l})));
  if (!lists.length) return;
  const listRows = await tx.checklist.createManyAndReturn({
    data: lists.map(l => ({cardId: l.cardId, workspaceId, title: l.source.title, position: l.source.position})),
    select: {id: true, cardId: true, position: true},
  });
  const listsByKey = new Map<string, number[]>();
  for (const r of listRows.sort((x, y) => x.id - y.id)) {
    const key = `${r.cardId}:${r.position}`;
    listsByKey.set(key, [...(listsByKey.get(key) ?? []), r.id]);
  }
  // Two lists of one card may share a key: hand their new ids out in insert order.
  const items = lists.flatMap(l => {
    const checklistId = listsByKey.get(`${l.cardId}:${l.source.position}`)?.shift();
    if (checklistId === undefined) return [];
    return l.source.items.map(i => ({
      checklistId,
      workspaceId,
      text: i.text,
      position: i.position,
      doneAt: i.doneAt,
      assigneeId: i.assigneeId && allowed.has(i.assigneeId) ? i.assigneeId : null,
      dueDate: i.dueDate,
      dueAt: i.dueAt,
      dueRemindMinutes: i.dueRemindMinutes,
    }));
  });
  if (items.length) await tx.checklistItem.createMany({data: items});
}
