import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {evenKeys} from '../../lib/position-key';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {MAX_CARDS_PER_LANE} from '../entitlements';
import {softLimited} from '../soft-limit';
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

const LANE_COPIES_PER_HOUR = 30;

export const laneActionRoutes = new Hono()
  .post('/lanes/:id/copy', copyBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    // A copy writes up to a full lane of cards and archiving frees the lane cap: a per-user hourly cap bounds it.
    if (await softLimited(userId, 'lane-copy', LANE_COPIES_PER_HOUR, 3600)) {
      return c.json(problem('rate_limited', 'You copied many lists in the last hour. Try again later.'), 429);
    }
    const {name} = c.req.valid('json');
    const out = await c.var.db
      .$transaction(async tx => {
        const rev = await bumpRev(tx, ctx.boardId, workspaceId);
        // Everything below is read AFTER the board lock: two parallel copies never share a key or pass the cap together,
        // and the source lane's cards cannot change between the count here and the copy below (every card write locks the board).
        // ONE read: the source lane, the board's open lanes, the next lane's key and how many cards will be copied.
        const [source] = await tx.$queryRaw<
          {position: string; color_hex: string | null; wip_limit: number | null; collapsed: boolean; lanes: number; next: string | null; cards: number}[]
        >`
          SELECT s.position, s.color_hex, s.wip_limit, s.collapsed,
                 (SELECT count(*)::int FROM lanes o
                  WHERE o.workspace_id = ${workspaceId}::int AND o.board_id = ${ctx.boardId}::int AND o.archived_at IS NULL) AS lanes,
                 (SELECT n.position FROM lanes n
                  WHERE n.workspace_id = ${workspaceId}::int AND n.board_id = ${ctx.boardId}::int AND n.archived_at IS NULL
                    AND (n.position, n.id) > (s.position, s.id)
                  ORDER BY n.position, n.id LIMIT 1) AS next,
                 (SELECT count(*)::int FROM (
                    SELECT 1 FROM cards k
                    WHERE k.workspace_id = ${workspaceId}::int AND k.board_id = ${ctx.boardId}::int AND k.lane_id = s.id AND k.archived_at IS NULL
                    LIMIT ${MAX_CARDS_PER_LANE}::int) q) AS cards
          FROM lanes s
          WHERE s.id = ${ctx.lane.id}::int AND s.board_id = ${ctx.boardId}::int AND s.workspace_id = ${workspaceId}::int AND s.archived_at IS NULL
          LIMIT 1`;
        if (!source) throw new Refuse('not_found');
        if (source.lanes >= MAX_LANES) throw new Refuse('limit_reached');
        let position: string;
        try {
          position = generateKeyBetween(source.position, source.next);
        } catch {
          // No room between the two keys: the copy goes to the end of the board instead.
          const last = await tx.lane.findFirst({where: {workspaceId, boardId: ctx.boardId, archivedAt: null}, orderBy: [...order('desc')], select: {position: true}});
          position = generateKeyBetween(last?.position ?? null, null);
        }
        const n = source.cards;
        const lane = await tx.lane.create({
          data: {boardId: ctx.boardId, workspaceId, name, position, colorHex: source.color_hex, wipLimit: source.wip_limit, collapsed: source.collapsed, cardCount: n, updatedRev: rev},
          select: {id: true},
        });
        if (n) {
          // The cards are copied by the database (INSERT ... SELECT): their descriptions never travel to the Worker.
          // Same columns, order (position, id), fresh keys and consecutive new numbers as before.
          const keys = keysAtEnd(null, n);
          const firstNumber = await reserveCardNumbers(tx, ctx.boardId, workspaceId, n);
          const copied = await tx.$executeRaw`
            INSERT INTO cards (number, board_id, lane_id, workspace_id, title, description_md, priority, estimate_minutes, start_date, due_date,
                               position, updated_rev, created_by, updated_at)
            SELECT ${firstNumber}::int + s.rn::int - 1, ${ctx.boardId}::int, ${lane.id}::int, ${workspaceId}::int, s.title, s.description_md, s.priority,
                   s.estimate_minutes, s.start_date, s.due_date, k.key, ${rev}::bigint, ${userId}::int, now()
            FROM (
              SELECT title, description_md, priority, estimate_minutes, start_date, due_date, row_number() OVER (ORDER BY position, id) AS rn
              FROM cards
              WHERE workspace_id = ${workspaceId}::int AND board_id = ${ctx.boardId}::int AND lane_id = ${ctx.lane.id}::int AND archived_at IS NULL
              ORDER BY position, id
              LIMIT ${n}::int
            ) s
            JOIN unnest(${keys}::text[]) WITH ORDINALITY AS k(key, i) ON k.i = s.rn`;
          // The lane's counter was written as `n`: anything else means the source changed under the lock (it cannot).
          if (copied !== n) throw new Error('lane copy count mismatch');
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
