import {Hono} from 'hono';
import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {notifyWatchers} from '../card-watch';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {boardAccess, notFound} from '../workspaces';
import {idOf} from '../validation';
import {atomically, body, cardCtx, errAt, Gone, noStore, refused, seatFilter, send} from './card-detail';
import {bumpRev, cardFinder, keyAfter, type Tx} from './boards';

/**
 * A card to ANOTHER board of the same workspace: move it (it keeps its id, so every link to it still works) or copy it.
 *
 *   POST /cards/:id/move-to-board  {boardId, laneId, afterId?}   move; end of the lane when afterId is missing
 *   POST /cards/:id/copy-to-board  {boardId, laneId}             copy, last in the lane
 *
 * Rules (all server side; the client only offers them):
 *  - The caller needs WRITE on the source card (cardCtx: 404 other workspace / no seat, 403 viewer, 409 archived board
 *    or read-only workspace) AND write on the target board (boardAccess: 404 when it is not visible to them, 403 viewer,
 *    409 archived or read-only). A board of another workspace is a 404, never a copy across workspaces. A
 *    personal Inbox is never a target (404).
 *  - The target lane must be an open lane OF THE TARGET BOARD and below MAX_CARDS_PER_LANE (409 lane_card_limit).
 *  - Same board: 422, the normal move route does that.
 *  - A MOVE: labels follow by name (case-insensitive; labels with no namesake on the target are dropped); assignees and
 *    followers and checklist-item people stay only while they have a seat on the target (private board seat, Inbox owner); notifications of this card
 *    for people with no seat there are deleted and the rest point at the new board; custom field values and the repeat rule
 *    belong to the old board and are removed; checklists,
 *    comments and attachments stay. Both boards get a rev bump in ONE transaction, locked in id order (no deadlock).
 *  - A COPY: title, description, priority, estimate, dates, checklists (unticked), labels by name and assignees with a
 *    seat. No comments, attachments, field values, dependencies or repeat rule.
 *  - Flows do not run for a cross-board move or copy.
 */

class LaneFull extends Error {}
class LaneGone extends Error {}
class Stale extends Error {}

const targetBody = (withAfter: boolean) =>
  body(v => {
    const boardId = v.boardId;
    const laneId = v.laneId;
    if (typeof boardId !== 'number' || !Number.isSafeInteger(boardId) || boardId <= 0 || boardId > 2_147_483_647) {
      return errAt('boardId', {code: 'required', message: 'Choose a board.'});
    }
    if (typeof laneId !== 'number' || !Number.isSafeInteger(laneId) || laneId <= 0 || laneId > 2_147_483_647) {
      return errAt('laneId', {code: 'required', message: 'Choose a lane.'});
    }
    let afterId: number | null = null;
    if (withAfter && v.afterId !== undefined && v.afterId !== null) {
      if (typeof v.afterId !== 'number' || !Number.isSafeInteger(v.afterId) || v.afterId <= 0 || v.afterId > 2_147_483_647) {
        return errAt('afterId', {code: 'invalid', message: 'Unknown position.'});
      }
      afterId = v.afterId;
    }
    return {ok: true as const, value: {boardId, laneId, afterId}};
  });

/** Right after sibling `afterId`, or LAST in the lane when it is missing (the move route's null means first; here it means end). */
async function keyFor(db: PrismaClient | Tx, workspaceId: number, laneId: number, afterId: number | null) {
  if (afterId !== null) return keyAfter(cardFinder(db, workspaceId, laneId), afterId, null);
  const last = await cardFinder(db, workspaceId, laneId)({}, 'desc');
  return generateKeyBetween(last?.position ?? null, null);
}

type Target = {boardId: number; laneId: number; visibility: string; inboxOf: number | null};
type Refuse = {status: 403 | 404 | 409; body: ReturnType<typeof problem>};
const refuseWith = (status: Refuse['status'], error: string, message: string): Refuse => ({status, body: problem(error, message)});

/** The target board and lane, proven writable for this person and in the SAME workspace as the card. */
async function targetFor(db: PrismaClient, userId: number, workspaceId: number, boardId: number, laneId: number): Promise<Target | Refuse> {
  const access = await boardAccess(db, boardId, userId);
  if (!access || access.workspaceId !== workspaceId) return refuseWith(404, 'not_found', 'No such board.');
  if (!access.canWrite) return refuseWith(403, 'forbidden', 'You do not have access to this.');
  if (access.archived) return refuseWith(409, 'board_archived', 'This board is archived.');
  const [ent, lane, board] = await Promise.all([
    getEntitlements(db, workspaceId),
    db.lane.findFirst({where: {id: laneId, boardId, workspaceId, archivedAt: null}, select: {id: true}}),
    db.board.findFirst({where: {id: boardId, workspaceId}, select: {inboxOf: true}}),
  ]);
  if (ent?.readOnly) return refuseWith(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
  if (!lane || !board) return refuseWith(404, 'not_found', 'No such lane.');
  // A personal Inbox is never a target (its own cap and rules live in the Inbox routes): it does not exist for this call.
  if (board.inboxOf !== null) return refuseWith(404, 'not_found', 'No such board.');
  return {boardId, laneId, visibility: access.visibility, inboxOf: board.inboxOf};
}
const isRefuse = (r: Target | Refuse): r is Refuse => 'status' in r;

/** SQL: the card's people who have NO seat on the target (not an active member, or no seat on a private board / Inbox). */
const noSeat = (workspaceId: number, userCol: Prisma.Sql, target: Target) => Prisma.sql`
  NOT EXISTS (
    SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::int AND m.user_id = ${userCol} AND u.status = 'active'
    ${seatFilter({visibility: target.visibility, boardId: target.boardId, inboxOf: target.inboxOf})})`;

export const cardMoveBoardRoutes = new Hono()
  .post('/cards/:id/move-to-board', targetBody(true), withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const {boardId, laneId, afterId} = c.req.valid('json');
    if (boardId === ctx.boardId) return c.json(problem('same_board', 'The card is already on this board. Move it to a lane instead.'), 422);
    const target = await targetFor(db, userId, ctx.workspaceId, boardId, laneId);
    if (isRefuse(target)) return c.json(target.body, target.status);
    const {workspaceId} = ctx;
    const from = ctx.card.laneId;
    const srcBoard = ctx.boardId;
    // Early answer only; the key that is written is computed again inside the transaction, under both board locks.
    if ((await keyFor(db, workspaceId, laneId, afterId)) === 'stale') return stale(c);

    const out = await db
      .$transaction(async tx => {
        // Both boards, locked in id order. The target's rev is the one the moved card is stamped with; the source's
        // rev stamps the lane counter.
        const revs = new Map<number, bigint>();
        for (const id of [srcBoard, boardId].sort((a, b) => a - b)) revs.set(id, await bumpRev(tx, id, workspaceId));
        const srcRev = revs.get(srcBoard)!;
        const tgtRev = revs.get(boardId)!;

        const key = await keyFor(tx, workspaceId, laneId, afterId);
        if (key === 'stale' || key === 'exhausted') throw new Stale();

        // A new number on the target board (the id, and so every link, stays; the old number is never reused).
        const number = await reserveCardNumbers(tx, boardId, workspaceId, 1);
        // The card must still be where the client saw it; the keys of the import are of the old board.
        const {count} = await tx.card.updateMany({
          where: {id: ctx.cardId, boardId: srcBoard, laneId: from, workspaceId, archivedAt: null},
          data: {number, boardId, laneId, position: key, updatedRev: tgtRev, importId: null, externalId: null},
        });
        if (!count) throw new Stale();

        const room = await tx.$queryRaw<{id: number}[]>`
          UPDATE lanes SET card_count = card_count + 1, updated_rev = ${tgtRev}::bigint
          WHERE id = ${laneId}::int AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int
            AND archived_at IS NULL AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
          RETURNING id`;
        if (!room[0]) {
          const open = await tx.lane.findFirst({where: {id: laneId, boardId, workspaceId, archivedAt: null}, select: {id: true}});
          throw open ? new LaneFull() : new LaneGone(); // rolls back both bumps and the card update
        }
        await tx.lane.updateMany({where: {id: from, boardId: srcBoard, workspaceId}, data: {cardCount: {decrement: 1}, updatedRev: srcRev}});

        await tx.cardFieldValue.deleteMany({where: {cardId: ctx.cardId, workspaceId}});
        await tx.cardRecurrence.deleteMany({where: {cardId: ctx.cardId, workspaceId}});

        // Labels follow by name; the old board's labels are then removed from the card.
        await tx.$executeRaw`
          INSERT INTO card_labels (card_id, label_id)
          SELECT DISTINCT ${ctx.cardId}::int, l2.id
          FROM card_labels cl
          JOIN labels l1 ON l1.id = cl.label_id AND l1.board_id = ${srcBoard}::int AND l1.workspace_id = ${workspaceId}::int
          JOIN labels l2 ON l2.board_id = ${boardId}::int AND l2.workspace_id = ${workspaceId}::int AND lower(l2.name) = lower(l1.name)
          WHERE cl.card_id = ${ctx.cardId}::int
          ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`
          DELETE FROM card_labels cl USING labels l1
          WHERE cl.card_id = ${ctx.cardId}::int AND cl.label_id = l1.id AND l1.board_id = ${srcBoard}::int`;

        // People without a seat on the target leave the card; the others' notifications follow it.
        await tx.$executeRaw`
          DELETE FROM card_members cm WHERE cm.card_id = ${ctx.cardId}::int AND cm.workspace_id = ${workspaceId}::int AND ${noSeat(workspaceId, Prisma.sql`cm.user_id`, target)}`;
        await tx.$executeRaw`
          DELETE FROM card_watchers w WHERE w.card_id = ${ctx.cardId}::int AND ${noSeat(workspaceId, Prisma.sql`w.user_id`, target)}`;
        // A checklist item keeps its text and day but loses a person who cannot see the target board.
        await tx.$executeRaw`
          UPDATE checklist_items ci SET assignee_id = NULL
          FROM checklists cl
          WHERE cl.id = ci.checklist_id AND cl.card_id = ${ctx.cardId}::int AND cl.workspace_id = ${workspaceId}::int
            AND ci.workspace_id = ${workspaceId}::int AND ci.assignee_id IS NOT NULL
            AND ${noSeat(workspaceId, Prisma.sql`ci.assignee_id`, target)}`;
        await tx.$executeRaw`
          DELETE FROM notifications n WHERE n.card_id = ${ctx.cardId}::int AND n.workspace_id = ${workspaceId}::int AND ${noSeat(workspaceId, Prisma.sql`n.user_id`, target)}`;
        await tx.notification.updateMany({where: {cardId: ctx.cardId, workspaceId}, data: {boardId}});

        const meta = {fromBoard: srcBoard, toBoard: boardId, from, to: laneId};
        await tx.activity.createMany({
          data: [srcBoard, boardId].map(b => ({workspaceId, boardId: b, cardId: ctx.cardId, actorId: userId, kind: 'card.moved', meta})),
        });
        return {rev: tgtRev, sourceRev: srcRev, position: key, number};
      })
      .catch(err => {
        if (err instanceof LaneFull) return 'full' as const;
        if (err instanceof LaneGone) return 'gone' as const;
        if (err instanceof Stale) return 'stale' as const;
        throw err;
      });
    if (out === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    if (out === 'gone') return c.json(problem('not_found', 'No such lane.'), 404);
    if (out === 'stale') return stale(c);
    await notifyWatchers(db, {workspaceId, boardId, cardId: ctx.cardId}, userId, 'card_moved');
    return c.json({ok: true, boardId, laneId, position: out.position, number: out.number, rev: String(out.rev), sourceRev: String(out.sourceRev)});
  })

  .post('/cards/:id/copy-to-board', targetBody(false), withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    // Reading the source is enough to copy it; the right that matters is write on the target.
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    if (ctx.card.archivedAt) return notFound(c, 'card');
    const {boardId, laneId} = c.req.valid('json');
    const target = await targetFor(db, userId, ctx.workspaceId, boardId, laneId);
    if (isRefuse(target)) return c.json(target.body, target.status);
    const {workspaceId} = ctx;
    const src = await db.card.findFirst({
      where: {id: ctx.cardId, boardId: ctx.boardId, workspaceId, archivedAt: null},
      select: {
        title: true, descriptionMd: true, priority: true, estimateMinutes: true, startDate: true, dueDate: true,
        labels: {select: {label: {select: {name: true}}}, take: 50},
        members: {select: {userId: true}, take: 50},
        checklists: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 20, select: {title: true, position: true, items: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100, select: {text: true, position: true}}}},
      },
    });
    if (!src) return notFound(c, 'card');
    const out = await atomically(db, async tx => copyInto(tx, {workspaceId, userId, sourceCardId: ctx.cardId, src, target}))
      .catch(err => { if (err instanceof LaneFull) return 'full' as const; throw err; });
    if (out === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    return out && typeof out === 'object' ? c.json(out, 201) : notFound(c, 'card');
  });

const stale = (c: {json: (b: unknown, s: 409) => Response}) => c.json(problem('stale', 'That changed while you were working. Reloading the board.'), 409);

type CopySource = {
  title: string; descriptionMd: string; priority: string; estimateMinutes: number | null; startDate: Date | null; dueDate: Date | null;
  labels: {label: {name: string}}[]; members: {userId: number}[];
  checklists: {title: string; position: string; items: {text: string; position: string}[]}[];
};

async function copyInto(tx: Tx, a: {workspaceId: number; userId: number; sourceCardId: number; src: CopySource; target: Target}) {
  const {workspaceId, userId, src, target} = a;
  const rev = await bumpRev(tx, target.boardId, workspaceId);
  const last = await tx.card.findFirst({where: {workspaceId, laneId: target.laneId, archivedAt: null}, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
  const room = await tx.$queryRaw<{id: number}[]>`
    UPDATE lanes SET card_count = card_count + 1, updated_rev = ${rev}::bigint
    WHERE id = ${target.laneId}::int AND board_id = ${target.boardId}::int AND workspace_id = ${workspaceId}::int
      AND archived_at IS NULL AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
    RETURNING id`;
  if (!room[0]) {
    const open = await tx.lane.findFirst({where: {id: target.laneId, boardId: target.boardId, workspaceId, archivedAt: null}, select: {id: true}});
    // Throw (not return) so the transaction rolls back the rev bump: a refused copy leaves the board untouched.
    throw open ? new LaneFull() : new Gone();
  }
  const names = [...new Set(src.labels.map(l => l.label.name.toLowerCase()))];
  const labelIds = names.length
    ? await tx.$queryRaw<{id: number}[]>`
        SELECT DISTINCT ON (lower(name)) id FROM labels
        WHERE board_id = ${target.boardId}::int AND workspace_id = ${workspaceId}::int AND lower(name) IN (${Prisma.join(names)})
        ORDER BY lower(name), id LIMIT 50`
    : [];
  const people = src.members.length
    ? await tx.$queryRaw<{id: number}[]>`
        SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ${workspaceId}::int AND u.status = 'active' AND u.id IN (${Prisma.join(src.members.map(m => m.userId))})
        ${seatFilter({visibility: target.visibility, boardId: target.boardId, inboxOf: target.inboxOf})}
        LIMIT 50`
    : [];
  const items = src.checklists.reduce((n, l) => n + l.items.length, 0);
  const title = `${src.title} (copy)`.slice(0, 200);
  const number = await reserveCardNumbers(tx, target.boardId, workspaceId, 1);
  const copy = await tx.card.create({
    data: {
      number,
      boardId: target.boardId, laneId: target.laneId, workspaceId, title,
      descriptionMd: src.descriptionMd, priority: src.priority, estimateMinutes: src.estimateMinutes, startDate: src.startDate, dueDate: src.dueDate,
      position: generateKeyBetween(last?.position ?? null, null),
      checklistTotal: items, checklistDone: 0, updatedRev: rev, createdBy: userId,
      labels: {create: labelIds.map(l => ({labelId: l.id}))},
      members: {create: people.map(p => ({userId: p.id, workspaceId}))},
      checklists: {create: src.checklists.map(l => ({workspaceId, title: l.title, position: l.position, items: {create: l.items.map(i => ({workspaceId, text: i.text, position: i.position}))}}))},
    },
    select: {id: true},
  });
  await tx.cardWatcher.createMany({data: [{cardId: copy.id, userId}], skipDuplicates: true});
  await tx.activity.create({data: {workspaceId, boardId: target.boardId, cardId: copy.id, actorId: userId, kind: 'card.created', meta: {title, copiedFrom: a.sourceCardId}}});
  return {cardId: copy.id, number, boardId: target.boardId, laneId: target.laneId, rev: String(rev)};
}
