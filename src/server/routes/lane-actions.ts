import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {evenKeys} from '../../lib/position-key';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {MAX_CARDS_PER_LANE} from '../entitlements';
import {idOf, invalid, objectOf, textField} from '../validation';
import {notFound} from '../workspaces';
import {bumpRev, keysAtEnd, laneFor, MAX_LANES, noStore, order, refused, type Tx} from './boards';

/**
 * The "List actions" menu of a lane (Phase 1 follow-up). Mounted ONCE at `/` in `app.ts`.
 *
 *   POST /lanes/:id/copy          a copy of the lane (name, colour, limit, open cards) right after it
 *   POST /lanes/:id/move-cards    every open card to the end of another lane of the same board
 *   POST /lanes/:id/archive-cards archive every open card of the lane
 *   POST /lanes/:id/sort          renumber the lane's cards by name, creation day or due day
 *   PUT  /lanes/:id/prefs         this person's own pin / watch flags for the lane
 *
 * Every route finds the lane through `laneFor` (workspace membership IN the query, then board access), so another
 * workspace's lane id is a 404. The four writes need write access and bump the board `rev` like every board write.
 */

/** Sort choices: the ORDER BY comes from this fixed map, never from the request. */
const SORTS = {
  name: [{title: 'asc'}, {id: 'asc'}],
  newest: [{createdAt: 'desc'}, {id: 'desc'}],
  oldest: [{createdAt: 'asc'}, {id: 'asc'}],
  due: [{dueDate: {sort: 'asc', nulls: 'last'}}, {id: 'asc'}],
} as const;
type SortKey = keyof typeof SORTS;

const copyBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const name = textField(v?.name, 1, 80);
  if (!name.ok) return invalid(c, {name: name.error});
  return {name: name.value};
});

const moveCardsBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const raw = v?.toLaneId;
  const toLaneId = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 2_147_483_647 ? raw : 0;
  if (!toLaneId) return invalid(c, {toLaneId: {code: 'required', message: 'Choose a lane.'}});
  return {toLaneId};
});

const sortBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const by = typeof v?.by === 'string' && Object.hasOwn(SORTS, v.by) ? (v.by as SortKey) : null;
  if (!by) return invalid(c, {by: {code: 'invalid', message: 'Choose how to sort.'}});
  return {by};
});

const prefsBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const out: {pinned?: boolean; watching?: boolean} = {};
  if (v?.pinned !== undefined) {
    if (typeof v.pinned !== 'boolean') return invalid(c, {pinned: {code: 'invalid', message: 'Use true or false.'}});
    out.pinned = v.pinned;
  }
  if (v?.watching !== undefined) {
    if (typeof v.watching !== 'boolean') return invalid(c, {watching: {code: 'invalid', message: 'Use true or false.'}});
    out.watching = v.watching;
  }
  if (out.pinned === undefined && out.watching === undefined) return invalid(c, {pinned: {code: 'required', message: 'Nothing to change.'}});
  return out;
});

/** Thrown inside a transaction to roll back its rev bump when the request cannot go ahead. */
class Refuse extends Error {
  constructor(readonly code: 'limit_reached' | 'lane_full' | 'not_found') {
    super(code);
  }
}

/** Fresh evenly spaced keys for `ids`, in the order given, in ONE statement (the board row is locked by `bumpRev`). */
async function renumberCards(tx: Tx, ids: number[], laneId: number, boardId: number, workspaceId: number, rev: bigint) {
  if (!ids.length) return;
  const keys = evenKeys(ids.length);
  await tx.$executeRaw`
    UPDATE cards SET position = u.k, updated_rev = ${rev}::bigint
    FROM unnest(${ids}::int[], ${keys}::text[]) AS u(id, k)
    WHERE cards.id = u.id AND cards.workspace_id = ${workspaceId}::int AND cards.board_id = ${boardId}::int AND cards.lane_id = ${laneId}::int`;
}

const refusal = (err: unknown) => {
  if (err instanceof Refuse) return err.code;
  throw err;
};

export const laneActionRoutes = new Hono()
  .post('/lanes/:id/copy', copyBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {name} = c.req.valid('json');
    const out = await c.var.db
      .$transaction(async tx => {
        const rev = await bumpRev(tx, ctx.boardId, workspaceId);
        // Everything below is read AFTER the board lock: two parallel copies never share a key or pass the cap together.
        const [source, count, cards] = await Promise.all([
          tx.lane.findFirst({
            where: {id: ctx.lane.id, boardId: ctx.boardId, workspaceId, archivedAt: null},
            select: {position: true, colorHex: true, wipLimit: true, collapsed: true},
          }),
          tx.lane.count({where: {workspaceId, boardId: ctx.boardId, archivedAt: null}}),
          tx.card.findMany({
            where: {workspaceId, laneId: ctx.lane.id, archivedAt: null},
            orderBy: [...order('asc')],
            take: MAX_CARDS_PER_LANE,
            select: {title: true, descriptionMd: true, priority: true, estimateMinutes: true, startDate: true, dueDate: true},
          }),
        ]);
        if (!source) throw new Refuse('not_found');
        if (count >= MAX_LANES) throw new Refuse('limit_reached');
        const next = await tx.lane.findFirst({
          where: {workspaceId, boardId: ctx.boardId, archivedAt: null, OR: [{position: {gt: source.position}}, {position: source.position, id: {gt: ctx.lane.id}}]},
          orderBy: [...order('asc')],
          select: {position: true},
        });
        let position: string;
        try {
          position = generateKeyBetween(source.position, next?.position ?? null);
        } catch {
          // No room between the two keys: the copy goes to the end of the board instead.
          const last = await tx.lane.findFirst({where: {workspaceId, boardId: ctx.boardId, archivedAt: null}, orderBy: [...order('desc')], select: {position: true}});
          position = generateKeyBetween(last?.position ?? null, null);
        }
        const lane = await tx.lane.create({
          data: {boardId: ctx.boardId, workspaceId, name, position, colorHex: source.colorHex, wipLimit: source.wipLimit, collapsed: source.collapsed, cardCount: cards.length, updatedRev: rev},
          select: {id: true},
        });
        if (cards.length) {
          const keys = keysAtEnd(null, cards.length);
          const firstNumber = await reserveCardNumbers(tx, ctx.boardId, workspaceId, cards.length);
          await tx.card.createMany({
            data: cards.map((card, i) => ({
              number: firstNumber + i,
              boardId: ctx.boardId,
              laneId: lane.id,
              workspaceId,
              title: card.title,
              descriptionMd: card.descriptionMd,
              priority: card.priority,
              estimateMinutes: card.estimateMinutes,
              startDate: card.startDate,
              dueDate: card.dueDate,
              position: keys[i]!,
              updatedRev: rev,
              createdBy: userId,
            })),
          });
        }
        await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.created', meta: {name, copiedFrom: ctx.lane.id}}});
        return {laneId: lane.id, rev};
      })
      .catch(refusal);
    if (out === 'limit_reached') return c.json(problem('limit_reached', `A board holds up to ${MAX_LANES} lanes.`), 409);
    if (typeof out === 'string') return notFound(c, 'lane');
    return c.json({laneId: out.laneId, rev: String(out.rev)}, 201);
  })

  .post('/lanes/:id/move-cards', moveCardsBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {toLaneId} = c.req.valid('json');
    if (toLaneId === ctx.lane.id) return invalid(c, {toLaneId: {code: 'invalid', message: 'Choose a different lane.'}});
    const out = await c.var.db
      .$transaction(async tx => {
        const rev = await bumpRev(tx, ctx.boardId, workspaceId);
        // The target must be an open lane of THIS board and workspace (never an id from another board).
        const [target, ids, last] = await Promise.all([
          tx.lane.findFirst({where: {id: toLaneId, boardId: ctx.boardId, workspaceId, archivedAt: null}, select: {id: true}}),
          tx.card.findMany({
            where: {workspaceId, laneId: ctx.lane.id, archivedAt: null},
            orderBy: [...order('asc')],
            take: MAX_CARDS_PER_LANE + 1,
            select: {id: true},
          }),
          tx.card.findFirst({where: {workspaceId, laneId: toLaneId, archivedAt: null}, orderBy: [...order('desc')], select: {position: true}}),
        ]);
        if (!target) throw new Refuse('not_found');
        const moving = ids.slice(0, MAX_CARDS_PER_LANE).map(r => r.id);
        if (!moving.length) return {moved: 0, rev};
        // The target's cap is ONE conditional update, so two parallel moves cannot both pass it.
        const room = await tx.$queryRaw<{id: number}[]>`
          UPDATE lanes SET card_count = card_count + ${moving.length}::int, updated_rev = ${rev}::bigint
          WHERE id = ${toLaneId} AND board_id = ${ctx.boardId} AND workspace_id = ${workspaceId}
            AND card_count + ${moving.length}::int <= ${MAX_CARDS_PER_LANE}::int
          RETURNING id`;
        if (!room[0]) throw new Refuse('lane_full');
        const keys = keysAtEnd(last?.position ?? null, moving.length);
        await tx.$executeRaw`
          UPDATE cards SET lane_id = ${toLaneId}::int, position = u.k, updated_rev = ${rev}::bigint
          FROM unnest(${moving}::int[], ${keys}::text[]) AS u(id, k)
          WHERE cards.id = u.id AND cards.workspace_id = ${workspaceId}::int AND cards.board_id = ${ctx.boardId}::int
            AND cards.lane_id = ${ctx.lane.id}::int AND cards.archived_at IS NULL`;
        await tx.$executeRaw`
          UPDATE lanes SET card_count = GREATEST(card_count - ${moving.length}::int, 0), updated_rev = ${rev}::bigint
          WHERE id = ${ctx.lane.id} AND board_id = ${ctx.boardId} AND workspace_id = ${workspaceId}`;
        await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.moved', meta: {laneId: ctx.lane.id, toLaneId, cards: moving.length}}});
        return {moved: moving.length, rev};
      })
      .catch(refusal);
    if (out === 'not_found') return notFound(c, 'lane');
    if (out === 'lane_full') return c.json(problem('lane_full', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    if (out === 'limit_reached') return c.json(problem('limit_reached', 'Limit reached.'), 409);
    return c.json({moved: out.moved, rev: String(out.rev)});
  })

  .post('/lanes/:id/archive-cards', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const out = await c.var.db.$transaction(async tx => {
      const rev = await bumpRev(tx, ctx.boardId, workspaceId);
      const {count} = await tx.card.updateMany({
        where: {workspaceId, boardId: ctx.boardId, laneId: ctx.lane.id, archivedAt: null},
        data: {archivedAt: new Date(), updatedRev: rev},
      });
      if (count) {
        await tx.$executeRaw`
          UPDATE lanes SET card_count = GREATEST(card_count - ${count}::int, 0), updated_rev = ${rev}::bigint
          WHERE id = ${ctx.lane.id} AND board_id = ${ctx.boardId} AND workspace_id = ${workspaceId}`;
        await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.updated', meta: {laneId: ctx.lane.id, archivedCards: count}}});
      }
      return {archived: count, rev};
    });
    return c.json({archived: out.archived, rev: String(out.rev)});
  })

  .post('/lanes/:id/sort', sortBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {by} = c.req.valid('json');
    const rev = await c.var.db.$transaction(async tx => {
      const next = await bumpRev(tx, ctx.boardId, workspaceId);
      const rows = await tx.card.findMany({
        where: {workspaceId, laneId: ctx.lane.id, archivedAt: null},
        orderBy: SORTS[by].map(o => ({...o})),
        take: MAX_CARDS_PER_LANE,
        select: {id: true},
      });
      await renumberCards(tx, rows.map(r => r.id), ctx.lane.id, ctx.boardId, workspaceId, next);
      return next;
    });
    return c.json({ok: true, rev: String(rev)});
  })

  .put('/lanes/:id/prefs', prefsBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    // Pinning and watching are this person's own view: reading the board is enough, and the board's rev is untouched.
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const input = c.req.valid('json');
    const pref = await c.var.db.lanePref.upsert({
      where: {userId_laneId: {userId, laneId: ctx.lane.id}},
      create: {userId, laneId: ctx.lane.id, workspaceId, boardId: ctx.boardId, ...input},
      update: input,
      select: {pinned: true, watching: true},
    });
    // A row exists only while a flag is on.
    if (!pref.pinned && !pref.watching) await c.var.db.lanePref.deleteMany({where: {userId, laneId: ctx.lane.id, pinned: false, watching: false}});
    return c.json({pinned: pref.pinned, watching: pref.watching});
  });
