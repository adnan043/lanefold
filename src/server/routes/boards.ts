import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {evenKeys, keyOrNull} from '../../lib/position-key';
import {dropNotificationsForPrivateBoard} from '../notification-cleanup';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {withFaces} from '../card-faces';
import {reserveCardNumbers} from '../card-number';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {notifyWatchers} from '../card-watch';
import {runFlows} from '../flows/engine';
import {ensureGeneralChannel} from '../general-channel';
import {boardAccess, membership, notFound, rankOf, type BoardAccess, boardReachable} from '../workspaces';
import {bgImageUrl} from '../bg-image';
import {HEX_RE, idOf, intField, invalid, objectOf, textField, type FieldError} from '../validation';

/**
 * Phase 1: workspaces (mine, create), boards, lanes and cards. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET  /workspaces                           my workspaces (switcher)
 *   POST /workspaces                           create one (I become its owner)
 *   GET  /workspaces/:id/boards?before=        boards I may see (keyset on id, 30 a page)
 *   POST /workspaces/:id/boards                create a board (member and up)
 *   GET  /boards/:id                           board + lanes + first 15 cards per lane (SPEC §13)
 *   PATCH /boards/:id                          name, visibility, background, archive (board admin)
 *   PUT|DELETE /boards/:id/star                star / unstar for me
 *   GET  /boards/:id/rev                       the poll: one tiny read (SPEC §8)
 *   GET  /boards/:id/changes?since=            lanes and cards changed after `rev`
 *   POST /boards/:id/lanes                     add a lane (at the end)
 *   PATCH /lanes/:id   POST /lanes/:id/move   POST /lanes/:id/archive
 *   GET  /lanes/:id/cards?after=               one lane's next cards (keyset on position, id)
 *   POST /lanes/:id/cards                      add 1 to 20 cards (multi-line paste)
 *   PATCH /cards/:id   POST /cards/:id/move    POST /cards/:id/archive|restore
 *
 * Access: ids in URLs only SELECT. `boardAccess()` (workspaces.ts) puts the visitor's workspace membership
 * IN its query; a board, lane or card of a workspace they are not in answers 404, exactly like a missing one.
 * Every write also carries `workspace_id` and `board_id` in its `where`. Positions are fractional-indexing
 * keys computed HERE from a neighbour id (the client never sends a key). Every write transaction bumps
 * `boards.rev` and stamps `updated_rev` on the rows it changes; archive instead of delete, so deltas see it.
 */

const BOARDS_PAGE = 30;
const CARDS_PAGE = 30;
/** First cards per lane in the board answer, and the whole answer's hard cap (SPEC §13). */
const LANE_FIRST = 15;
const BOARD_CARD_CAP = 150;
export const MAX_LANES = 50;
const MAX_NEW_CARDS = 20;
const CHANGES_CAP = 300;
const MAX_OWN_WORKSPACES = 10;
/** Boards one person may create in one workspace per hour. */
const BOARDS_PER_HOUR = 20;
const VISIBILITIES = ['private', 'workspace', 'public'] as const;
/** `image` (an uploaded photo, `routes/board-background.ts`) only on an edit, and only once the board has one. */
const BG_KINDS = ['color', 'gradient', 'pattern', 'image'] as const;
const BG_PATTERNS = ['none', 'dots', 'grid', 'lines'] as const;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

/* --------------------------------------------------------------- shapes */

type Refusal = {status: 403 | 404 | 409; body: ReturnType<typeof problem>};
const refuse = (status: Refusal['status'], error: string, message: string): Refusal => ({status, body: problem(error, message)});

const cardCols = {
  id: true,
  number: true,
  laneId: true,
  title: true,
  position: true,
  priority: true,
  startDate: true,
  dueDate: true,
  createdAt: true,
  completedAt: true,
  checklistTotal: true,
  checklistDone: true,
  commentCount: true,
  attachmentCount: true,
  archivedAt: true,
  updatedRev: true,
} as const;

type CardRow = {
  id: number;
  number?: number | null;
  laneId: number;
  title: string;
  position: string;
  priority: string;
  startDate?: Date | null;
  dueDate: Date | null;
  createdAt?: Date;
  completedAt: Date | null;
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  attachmentCount: number;
  archivedAt?: Date | null;
  updatedRev?: bigint;
};

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function cardShape(r: CardRow) {
  return {
    id: r.id,
    number: r.number ?? null,
    laneId: r.laneId,
    title: r.title,
    position: r.position,
    priority: r.priority,
    dueDate: dayOf(r.dueDate),
    startDate: r.startDate === undefined ? undefined : dayOf(r.startDate),
    createdAt: r.createdAt === undefined ? undefined : dayOf(r.createdAt),
    completed: r.completedAt !== null,
    checklistTotal: r.checklistTotal,
    checklistDone: r.checklistDone,
    commentCount: r.commentCount,
    attachmentCount: r.attachmentCount,
    archived: r.archivedAt != null,
    rev: r.updatedRev === undefined ? undefined : String(r.updatedRev),
  };
}

/** The page after a (position, id) cursor, same order as the first page (`position` is COLLATE "C"). */
async function cardsAfter(db: PrismaClient, workspaceId: number, laneId: number, cursor: {position: string; id: number}) {
  const rows = await db.$queryRaw<
    {id: number; number: number | null; lane_id: number; title: string; position: string; priority: string; start_date: Date | null; due_date: Date | null; created_at: Date; completed_at: Date | null;
     checklist_total: number; checklist_done: number; comment_count: number; attachment_count: number; archived_at: Date | null; updated_rev: bigint}[]
  >`
    SELECT id, number, lane_id, title, position, priority, start_date, due_date, created_at, completed_at, checklist_total, checklist_done,
           comment_count, attachment_count, archived_at, updated_rev
    FROM cards
    WHERE workspace_id = ${workspaceId} AND lane_id = ${laneId} AND archived_at IS NULL
      AND (position, id) > (${cursor.position}::text COLLATE "C", ${cursor.id}::int)
    ORDER BY position COLLATE "C", id
    LIMIT ${CARDS_PAGE + 1}`;
  return rows.map(r => ({
    id: r.id, number: r.number, laneId: r.lane_id, title: r.title, position: r.position, priority: r.priority, startDate: r.start_date, dueDate: r.due_date, createdAt: r.created_at,
    completedAt: r.completed_at, checklistTotal: r.checklist_total, checklistDone: r.checklist_done,
    commentCount: r.comment_count, attachmentCount: r.attachment_count, archivedAt: r.archived_at, updatedRev: r.updated_rev,
  }));
}

const laneCols = {
  id: true,
  name: true,
  position: true,
  colorHex: true,
  wipLimit: true,
  cardCount: true,
  collapsed: true,
  archivedAt: true,
  updatedRev: true,
} as const;

type LaneRow = {
  id: number;
  name: string;
  position: string;
  colorHex: string | null;
  wipLimit: number | null;
  cardCount: number;
  collapsed: boolean;
  archivedAt: Date | null;
  updatedRev: bigint;
};

const laneShape = (r: LaneRow) => ({
  id: r.id,
  name: r.name,
  position: r.position,
  colorHex: r.colorHex,
  wipLimit: r.wipLimit,
  cardCount: r.cardCount,
  collapsed: r.collapsed,
  archived: r.archivedAt !== null,
  rev: String(r.updatedRev),
});

const boardCols = {
  id: true,
  workspaceId: true,
  name: true,
  visibility: true,
  bgKind: true,
  bgColor1: true,
  bgColor2: true,
  bgAngle: true,
  bgPattern: true,
  bgFileId: true,
  archivedAt: true,
  rev: true,
} as const;

/* ------------------------------------------------------------ validation */

const fieldFail = (errors: Record<string, FieldError>) => errors;

const dateOnly = (v: unknown): {ok: true; value: Date | null} | {ok: false} => {
  if (v === null) return {ok: true, value: null};
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return {ok: false};
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? {ok: false} : {ok: true, value: d};
};

const hexOf = (v: unknown) => (typeof v === 'string' && HEX_RE.test(v) ? v.toUpperCase() : null);

const cursorQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before : '',
  after: typeof value.after === 'string' ? value.after : '',
  since: typeof value.since === 'string' ? value.since : '',
}));

type NewWorkspace = {name: string};
const workspaceBody = validator('json', (value, c) => {
  const body = objectOf(value);
  const name = textField(body?.name, 1, 80);
  if (!name.ok) return invalid(c, fieldFail({name: name.error}));
  return {name: name.value} satisfies NewWorkspace;
});

type NewBoard = {
  name: string;
  visibility: string;
  bgKind: string;
  bgColor1?: string;
  bgColor2?: string;
  bgAngle?: number;
  bgPattern?: string;
  lanes: string[];
};

/** Create (`partial = false`) or edit (`partial = true`) a board. Background fields are optional in both. */
function boardBody(partial: boolean) {
  return validator('json', (value, c) => {
    const v = objectOf(value);
    if (!v) return invalid(c, {name: {code: 'required', message: 'Enter a name.'}});
    const errors: Record<string, FieldError> = {};
    const out: Partial<NewBoard> & {archived?: boolean} = {};
    if (!partial || v.name !== undefined) {
      const name = textField(v.name, 1, 80);
      if (name.ok) out.name = name.value;
      else errors.name = name.error;
    }
    if (v.visibility !== undefined) {
      if (typeof v.visibility === 'string' && (VISIBILITIES as readonly string[]).includes(v.visibility)) out.visibility = v.visibility;
      else errors.visibility = {code: 'invalid', message: 'Choose private, workspace or public.'};
    }
    if (v.bgKind !== undefined) {
      if (typeof v.bgKind === 'string' && (BG_KINDS as readonly string[]).includes(v.bgKind) && (partial || v.bgKind !== 'image')) out.bgKind = v.bgKind;
      else errors.bgKind = {code: 'invalid', message: 'Choose a colour or a gradient.'};
    }
    for (const key of ['bgColor1', 'bgColor2'] as const) {
      if (v[key] === undefined) continue;
      const hex = hexOf(v[key]);
      if (hex) out[key] = hex;
      else errors[key] = {code: 'invalid', message: 'Use a colour like #5B5BD6.'};
    }
    if (v.bgAngle !== undefined) {
      const angle = intField(v.bgAngle, 0, 360);
      if (angle.ok) out.bgAngle = angle.value;
      else errors.bgAngle = angle.error;
    }
    if (v.bgPattern !== undefined) {
      if (typeof v.bgPattern === 'string' && (BG_PATTERNS as readonly string[]).includes(v.bgPattern)) out.bgPattern = v.bgPattern;
      else errors.bgPattern = {code: 'invalid', message: 'Unknown pattern.'};
    }
    if (partial && v.archived !== undefined) {
      if (typeof v.archived === 'boolean') out.archived = v.archived;
      else errors.archived = {code: 'invalid', message: 'Use true or false.'};
    }
    if (!partial && v.lanes !== undefined) {
      if (Array.isArray(v.lanes) && v.lanes.length <= 10) {
        const names: string[] = [];
        for (const item of v.lanes) {
          const n = textField(item, 1, 80);
          if (n.ok) names.push(n.value);
          else errors.lanes = n.error;
        }
        out.lanes = names;
      } else errors.lanes = {code: 'out_of_range', message: 'Use up to 10 lanes.'};
    }
    if (Object.keys(errors).length) return invalid(c, errors);
    return partial ? out : ({visibility: 'workspace', bgKind: 'color', lanes: [], ...out} as NewBoard);
  });
}

const laneBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const v = objectOf(value);
    if (!v) return invalid(c, {name: {code: 'required', message: 'Enter a name.'}});
    const errors: Record<string, FieldError> = {};
    const out: {name?: string; colorHex?: string | null; wipLimit?: number | null; collapsed?: boolean} = {};
    if (!partial || v.name !== undefined) {
      const name = textField(v.name, 1, 80);
      if (name.ok) out.name = name.value;
      else errors.name = name.error;
    }
    if (v.colorHex !== undefined) {
      if (v.colorHex === null) out.colorHex = null;
      else {
        const hex = hexOf(v.colorHex);
        if (hex) out.colorHex = hex;
        else errors.colorHex = {code: 'invalid', message: 'Use a colour like #5B5BD6.'};
      }
    }
    if (v.wipLimit !== undefined) {
      if (v.wipLimit === null) out.wipLimit = null;
      else {
        const wip = intField(v.wipLimit, 1, 999);
        if (wip.ok) out.wipLimit = wip.value;
        else errors.wipLimit = wip.error;
      }
    }
    if (v.collapsed !== undefined) {
      if (typeof v.collapsed === 'boolean') out.collapsed = v.collapsed;
      else errors.collapsed = {code: 'invalid', message: 'Use true or false.'};
    }
    if (Object.keys(errors).length) return invalid(c, errors);
    return out;
  });

/** Where to put something: right after sibling `afterId`, or first when null. */
const moveBody = (withLane: boolean) =>
  validator('json', (value, c) => {
    const v = objectOf(value);
    const errors: Record<string, FieldError> = {};
    let afterId: number | null = null;
    if (v?.afterId !== null && v?.afterId !== undefined) {
      if (typeof v.afterId === 'number' && Number.isSafeInteger(v.afterId) && v.afterId > 0 && v.afterId <= 2_147_483_647) afterId = v.afterId;
      else errors.afterId = {code: 'invalid', message: 'Unknown position.'};
    }
    let laneId = 0;
    if (withLane) {
      if (typeof v?.laneId === 'number' && Number.isSafeInteger(v.laneId) && v.laneId > 0) laneId = v.laneId;
      else errors.laneId = {code: 'required', message: 'Choose a lane.'};
    }
    if (Object.keys(errors).length) return invalid(c, errors);
    return {afterId, laneId};
  });

const newCardsBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const raw = Array.isArray(v?.titles) ? v.titles : [v?.title];
  if (raw.length < 1 || raw.length > MAX_NEW_CARDS) {
    return invalid(c, {title: {code: 'out_of_range', message: `Add 1 to ${MAX_NEW_CARDS} cards at a time.`}});
  }
  const titles: string[] = [];
  for (const item of raw) {
    const t = textField(item, 1, 200);
    if (!t.ok) return invalid(c, {title: t.error});
    titles.push(t.value);
  }
  return {titles};
});

const cardPatchBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  const out: {title?: string; priority?: string; dueDate?: Date | null; completed?: boolean} = {};
  if (v?.title !== undefined) {
    const t = textField(v.title, 1, 200);
    if (t.ok) out.title = t.value;
    else errors.title = t.error;
  }
  if (v?.priority !== undefined) {
    if (typeof v.priority === 'string' && (PRIORITIES as readonly string[]).includes(v.priority)) out.priority = v.priority;
    else errors.priority = {code: 'invalid', message: 'Unknown priority.'};
  }
  if (v?.dueDate !== undefined) {
    const d = dateOnly(v.dueDate);
    if (d.ok) out.dueDate = d.value;
    else errors.dueDate = {code: 'invalid', message: 'Use a date like 2026-12-31.'};
  }
  if (v?.completed !== undefined) {
    if (typeof v.completed === 'boolean') out.completed = v.completed;
    else errors.completed = {code: 'invalid', message: 'Use true or false.'};
  }
  if (!Object.keys(out).length && !Object.keys(errors).length) errors.title = {code: 'required', message: 'Nothing to change.'};
  if (Object.keys(errors).length) return invalid(c, errors);
  return out;
});

/* ---------------------------------------------------------------- access */

type Need = 'read' | 'write' | 'admin';

/**
 * Board access for one request, or the refusal to send. 404 for a board the visitor cannot see (never 403:
 * no oracle); 403 when they can see it but may not do `need`; 409 when the board is archived or the
 * workspace is read-only (writes only).
 */
export async function boardFor(db: PrismaClient, userId: number, boardId: number | undefined, need: Need, allowArchived = false) {
  if (!boardId) return refuse(404, 'not_found', 'No such board.');
  const access = await boardAccess(db, boardId, userId);
  if (!access) return refuse(404, 'not_found', 'No such board.');
  if (need === 'admin' && !access.canAdmin) return refuse(403, 'forbidden', 'You do not have access to this.');
  if (need !== 'read') {
    if (!access.canWrite) return refuse(403, 'forbidden', 'You do not have access to this.');
    if (access.archived && !allowArchived) return refuse(409, 'board_archived', 'This board is archived.');
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return refuse(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
  }
  return {boardId, access};
}

export const refused = (r: Refusal | {boardId: number; access: BoardAccess}): r is Refusal => 'status' in r;

/** A lane the visitor may act on: the lane row only selects the board; access decides. */
export async function laneFor(db: PrismaClient, userId: number, laneId: number | undefined, need: Need) {
  if (!laneId) return refuse(404, 'not_found', 'No such lane.');
  const lane = await db.lane.findFirst({
    // The visitor's workspace membership is IN the query; boardFor() then decides what they may do.
    where: {id: laneId, archivedAt: null, board: boardReachable(userId)},
    select: {id: true, boardId: true, workspaceId: true},
  });
  if (!lane) return refuse(404, 'not_found', 'No such lane.');
  const ctx = await boardFor(db, userId, lane.boardId, need);
  if (refused(ctx)) return ctx; // 403 / 409 stay what they are: the visitor can already see this board
  if (ctx.access.workspaceId !== lane.workspaceId) return refuse(404, 'not_found', 'No such lane.');
  return {...ctx, lane};
}

async function cardFor(db: PrismaClient, userId: number, cardId: number | undefined, need: Need) {
  if (!cardId) return refuse(404, 'not_found', 'No such card.');
  const card = await db.card.findFirst({
    where: {id: cardId, board: boardReachable(userId)},
    select: {id: true, boardId: true, laneId: true, workspaceId: true, archivedAt: true},
  });
  if (!card) return refuse(404, 'not_found', 'No such card.');
  const ctx = await boardFor(db, userId, card.boardId, need);
  if (refused(ctx)) return ctx;
  if (ctx.access.workspaceId !== card.workspaceId) return refuse(404, 'not_found', 'No such card.');
  return {...ctx, card};
}

/** Thrown inside a transaction to roll it back when the target lane is at MAX_CARDS_PER_LANE. */
class LaneFull extends Error {}
/** Thrown inside the move transaction when the card is no longer where the client saw it (rolls back the rev bump). */
class StaleMove extends Error {}
/** Thrown inside the move transaction when the target lane was archived or removed meanwhile. */
class LaneGone extends Error {}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** `boards.rev + 1`, row-locked: concurrent writers on one board queue here, so every change gets its own rev. */
export async function bumpRev(tx: Tx, boardId: number, workspaceId: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`
    UPDATE boards SET rev = rev + 1, updated_at = now()
    WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  if (!rows[0]) throw new Error('board vanished');
  return rows[0].rev;
}

type Sibling = {id: number; position: string};

/**
 * The key for "right after `afterId`" (first when null) among `siblings`, a finder bound to ONE lane/board.
 * Never renumbers siblings. A stale `afterId` (moved or archived meanwhile) is a 409 the client answers by
 * reloading; equal keys from a race fall back to the end.
 */
export async function keyAfter(
  find: (extra: object, order: 'asc' | 'desc') => Promise<Sibling | null>,
  afterId: number | null,
  movingId: number | null,
  onExhausted: 'end' | 'signal' = 'end'
): Promise<string | 'stale' | 'exhausted'> {
  if (afterId !== null && afterId === movingId) return 'stale';
  const not = movingId === null ? {} : {id: {not: movingId}};
  if (afterId === null) {
    const first = await find(not, 'asc');
    return generateKeyBetween(null, first?.position ?? null);
  }
  const after = await find({id: afterId}, 'asc');
  if (!after) return 'stale';
  const next = await find({...not, OR: [{position: {gt: after.position}}, {position: after.position, id: {gt: after.id}}]}, 'asc');
  // Equal/out-of-order neighbours or a key that grew too long for the column: fall back to the end of the list.
  const between = keyOrNull(after.position, next?.position ?? null);
  if (between !== null) return between;
  if (onExhausted === 'signal') return 'exhausted';
  const last = await find(not, 'desc');
  return generateKeyBetween(last?.position ?? null, null);
}

/**
 * Renumber the open siblings of a lane (or the board's open lanes) with fresh evenly spaced keys in ONE statement:
 * one bounded read of the ids in order, then a single UPDATE ... FROM unnest. Only called under the board row lock,
 * with the rev the surrounding write will commit, so `/changes` lists every renumbered row (or says `truncated`
 * past its cap and the client reloads). The moving row is left out: its own key is written by the move.
 */
async function rebalance(tx: Tx, kind: 'cards' | 'lanes', scopeId: number, boardId: number, workspaceId: number, movingId: number, rev: bigint) {
  const ids =
    kind === 'cards'
      ? await tx.card.findMany({
          where: {workspaceId, laneId: scopeId, archivedAt: null, id: {not: movingId}},
          orderBy: [...order('asc')], take: MAX_CARDS_PER_LANE + 1, select: {id: true},
        })
      : await tx.lane.findMany({
          where: {workspaceId, boardId, archivedAt: null, id: {not: movingId}},
          orderBy: [...order('asc')], take: MAX_LANES + 1, select: {id: true},
        });
  if (!ids.length) return;
  const idList = ids.map(r => r.id);
  const keys = evenKeys(idList.length);
  if (kind === 'cards') {
    await tx.$executeRaw`
      UPDATE cards SET position = u.k, updated_rev = ${rev}::bigint
      FROM unnest(${idList}::int[], ${keys}::text[]) AS u(id, k)
      WHERE cards.id = u.id AND cards.workspace_id = ${workspaceId}::int AND cards.board_id = ${boardId}::int AND cards.lane_id = ${scopeId}::int`;
  } else {
    await tx.$executeRaw`
      UPDATE lanes SET position = u.k, updated_rev = ${rev}::bigint
      FROM unnest(${idList}::int[], ${keys}::text[]) AS u(id, k)
      WHERE lanes.id = u.id AND lanes.workspace_id = ${workspaceId}::int AND lanes.board_id = ${boardId}::int`;
  }
}

export const order = (dir: 'asc' | 'desc') => [{position: dir}, {id: dir}] as const;
const laneFinder = (tx: Tx | PrismaClient, workspaceId: number, boardId: number) => (extra: object, dir: 'asc' | 'desc') =>
  tx.lane.findFirst({where: {workspaceId, boardId, archivedAt: null, ...extra}, select: {id: true, position: true}, orderBy: [...order(dir)]});
export const cardFinder = (tx: Tx | PrismaClient, workspaceId: number, laneId: number) => (extra: object, dir: 'asc' | 'desc') =>
  tx.card.findFirst({where: {workspaceId, laneId, archivedAt: null, ...extra}, select: {id: true, position: true}, orderBy: [...order(dir)]});

const stale = (c: {json: (b: unknown, s: 409) => Response}) => c.json(problem('stale', 'That changed while you were working. Reloading the board.'), 409);

/** Positions for `n` new rows at the END of a list whose last key is `last`. */
export function keysAtEnd(last: string | null, n: number): string[] {
  const keys: string[] = [];
  let prev = last;
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, null);
    keys.push(prev);
  }
  return keys;
}

/** Visibility of boards in lists: private boards only to members of them and to workspace owners/admins. */
const seeableBoards = (userId: number, rank: number) =>
  rank >= 3 ? {} : {OR: [{visibility: {not: 'private'}}, {boardMembers: {some: {userId}}}]};

function slugOf(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 40) || 'workspace';
  const rand = crypto.getRandomValues(new Uint8Array(4));
  return `${base}-${[...rand].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

const cursorOfCard = /^([^|\u0000]{1,64})\|(\d{1,10})$/u;

/* ---------------------------------------------------------------- routes */

export const boardRoutes = new Hono()
  /* -------------------------------------------------------- workspaces */
  .get('/workspaces', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const rows = await c.var.db.workspaceMember.findMany({
      where: {userId, workspace: {archivedAt: null}},
      orderBy: {workspaceId: 'asc'},
      take: 50,
      select: {role: true, workspace: {select: {id: true, name: true, slug: true, plan: true, memberCount: true}}},
    });
    return c.json({items: rows.map(r => ({...r.workspace, role: r.role}))});
  })

  .post('/workspaces', workspaceBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const {name} = c.req.valid('json');
    // Count and insert under a lock on the creator's user row: two parallel requests cannot both pass the cap.
    const workspace = await c.var.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const owned = await tx.workspace.count({where: {createdBy: userId, archivedAt: null}});
      if (owned >= MAX_OWN_WORKSPACES) return null;
      const created = await tx.workspace.create({
        data: {name, slug: slugOf(name), createdBy: userId, memberCount: 1, members: {create: {userId, role: 'owner'}}},
        select: {id: true, name: true, slug: true, plan: true, memberCount: true},
      });
      // In the same transaction: a workspace never exists without its #general.
      await ensureGeneralChannel(tx, created.id, userId);
      return created;
    });
    if (!workspace) return c.json(problem('limit_reached', `You can create up to ${MAX_OWN_WORKSPACES} workspaces.`), 409);
    return c.json({workspace: {...workspace, role: 'owner'}}, 201);
  })

  /* ------------------------------------------------------------ boards */
  .get('/workspaces/:id/boards', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(c.var.db, workspaceId, userId);
    if (!member) return notFound(c);
    const before = idOf(c.req.valid('query').before);
    const rows = await c.var.db.board.findMany({
      where: {workspaceId, archivedAt: null, inboxOf: null, ...(before ? {id: {lt: before}} : {}), ...seeableBoards(userId, member.rank)},
      orderBy: {id: 'desc'},
      take: BOARDS_PAGE + 1,
      select: {...boardCols, boardStars: {where: {userId}, select: {userId: true}, take: 1}},
    });
    const page = rows.slice(0, BOARDS_PAGE);
    return c.json({
      items: page.map(b => ({
        id: b.id,
        name: b.name,
        visibility: b.visibility,
        bgKind: b.bgKind,
        bgColor1: b.bgColor1,
        bgColor2: b.bgColor2,
        bgAngle: b.bgAngle,
        bgPattern: b.bgPattern,
        bgImage: bgImageUrl(b.id, b.bgFileId),
        starred: b.boardStars.length > 0,
      })),
      nextBefore: rows.length > BOARDS_PAGE ? page.at(-1)!.id : null,
    });
  })

  .post('/workspaces/:id/boards', boardBody(false), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(c.var.db, workspaceId, userId);
    if (!member) return notFound(c);
    if (rankOf(member.role) < 2) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const ent = await getEntitlements(c.var.db, workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const recent = await c.var.db.board.findMany({
      where: {workspaceId, createdBy: userId, createdAt: {gt: new Date(Date.now() - 3_600_000)}},
      select: {id: true},
      take: BOARDS_PER_HOUR,
    });
    if (recent.length >= BOARDS_PER_HOUR) {
      c.header('Retry-After', '600');
      return c.json(problem('board_rate_limited', 'You created many boards in the last hour. Try again later.'), 429);
    }
    const body = c.req.valid('json') as NewBoard;
    const keys = keysAtEnd(null, body.lanes.length);
    const board = await c.var.db.$transaction(async tx => {
      const row = await tx.board.create({
        data: {
          workspaceId,
          name: body.name,
          visibility: body.visibility,
          bgKind: body.bgKind,
          ...(body.bgColor1 ? {bgColor1: body.bgColor1} : {}),
          ...(body.bgColor2 ? {bgColor2: body.bgColor2} : {}),
          ...(body.bgAngle !== undefined ? {bgAngle: body.bgAngle} : {}),
          ...(body.bgPattern ? {bgPattern: body.bgPattern} : {}),
          rev: 1n,
          createdBy: userId,
        },
        select: boardCols,
      });
      // The creator is a board admin: without this row a member could not open their own private board.
      await tx.boardMember.create({data: {boardId: row.id, workspaceId, userId, role: 'admin'}});
      if (body.lanes.length) {
        await tx.lane.createMany({
          data: body.lanes.map((name, i) => ({boardId: row.id, workspaceId, name, position: keys[i]!, updatedRev: 1n})),
        });
      }
      await tx.activity.create({data: {workspaceId, boardId: row.id, actorId: userId, kind: 'board.created', meta: {name: body.name}}});
      return row;
    });
    return c.json({board: {id: board.id, name: board.name, visibility: board.visibility}}, 201);
  })

  .get('/boards/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const ctx = await boardFor(db, userId, boardId, 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {access} = ctx;
    const workspaceId = access.workspaceId;
    // Board and lanes in parallel, then ONE statement for the cards: a UNION ALL of per-lane LIMIT queries
    // that each walk the partial open index (a window function over the whole board sorts every open card).
    const [board, lanes, prefs] = await Promise.all([
      db.board.findFirst({
        where: {id: ctx.boardId, workspaceId},
        select: {...boardCols, boardStars: {where: {userId}, select: {userId: true}, take: 1}},
      }),
      db.lane.findMany({
        where: {workspaceId, boardId: ctx.boardId, archivedAt: null},
        orderBy: [...order('asc')],
        take: MAX_LANES,
        select: laneCols,
      }),
      // This person's own pins and watches on this board: one more read in the same round trip.
      db.lanePref.findMany({where: {userId, workspaceId, boardId: ctx.boardId}, take: MAX_LANES, select: {laneId: true, pinned: true, watching: true}}),
    ]);
    const prefOf = new Map(prefs.map(p => [p.laneId, p]));
    const cards = lanes.length
      ? await db.$queryRaw<
          {id: number; number: number | null; lane_id: number; title: string; position: string; priority: string; start_date: Date | null; due_date: Date | null; created_at: Date; completed_at: Date | null;
           checklist_total: number; checklist_done: number; comment_count: number; attachment_count: number}[]
        >`
          SELECT id, number, lane_id, title, position, priority, start_date, due_date, created_at, completed_at, checklist_total, checklist_done,
                 comment_count, attachment_count
          FROM (
            ${Prisma.join(
              lanes.map(
                (l, i) => Prisma.sql`(SELECT ${i}::int AS ord, id, number, lane_id, title, position, priority, start_date, due_date, created_at, completed_at, checklist_total, checklist_done,
                      comment_count, attachment_count
                    FROM cards
                    WHERE workspace_id = ${workspaceId} AND board_id = ${ctx.boardId} AND lane_id = ${l.id} AND archived_at IS NULL
                    ORDER BY position COLLATE "C", id
                    LIMIT ${LANE_FIRST + 1})`
              ),
              ' UNION ALL '
            )}
          ) t
          ORDER BY ord, position COLLATE "C", id
          LIMIT ${BOARD_CARD_CAP + 50}`
      : [];
    if (!board) return notFound(c, 'board');
    const byLane = new Map<number, ReturnType<typeof cardShape>[]>();
    let total = 0;
    for (const r of cards) {
      const list = byLane.get(r.lane_id) ?? [];
      // The 16th row only proves there is more; the hard cap leaves later lanes to load on scroll.
      if (list.length >= LANE_FIRST || total >= BOARD_CARD_CAP) continue;
      list.push(
        cardShape({
          id: r.id,
          number: r.number,
          laneId: r.lane_id,
          title: r.title,
          position: r.position,
          priority: r.priority,
          startDate: r.start_date,
          dueDate: r.due_date,
          createdAt: r.created_at,
          completedAt: r.completed_at,
          checklistTotal: r.checklist_total,
          checklistDone: r.checklist_done,
          commentCount: r.comment_count,
          attachmentCount: r.attachment_count,
        })
      );
      byLane.set(r.lane_id, list);
      total++;
    }
    // Labels, assignees and cover for every card in the answer: three more statements for the WHOLE board.
    const faced = new Map((await withFaces(c.var.db, workspaceId, [...byLane.values()].flat())).map(card => [card.id, card]));
    return c.json({
      board: {
        id: board.id,
        workspaceId,
        name: board.name,
        visibility: board.visibility,
        bgKind: board.bgKind,
        bgColor1: board.bgColor1,
        bgColor2: board.bgColor2,
        bgAngle: board.bgAngle,
        bgPattern: board.bgPattern,
        bgImage: bgImageUrl(board.id, board.bgFileId),
        archived: board.archivedAt !== null,
        rev: String(board.rev),
        starred: board.boardStars.length > 0,
        role: access.boardRole,
        canWrite: access.canWrite,
        canAdmin: access.canAdmin,
        // A guest sees only this board of the workspace (no chat, search or workspace pages).
        guest: access.guest,
      },
      lanes: lanes.map(l => {
        const list = (byLane.get(l.id) ?? []).map(card => faced.get(card.id) ?? card);
        const pref = prefOf.get(l.id);
        return {...laneShape(l), pinned: pref?.pinned ?? false, watching: pref?.watching ?? false, cards: list, loaded: list.length > 0 || l.cardCount === 0, hasMore: l.cardCount > list.length};
      }),
    });
  })

  .patch('/boards/:id', boardBody(true), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const body = c.req.valid('json') as Partial<NewBoard> & {archived?: boolean};
    const ctx = await boardFor(c.var.db, userId, idOf(c.req.param('id')), 'admin', body.archived === false);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {archived, lanes: _ignored, ...fields} = body;
    if (fields.bgKind === 'image' && !ctx.access.bgFileId) return invalid(c, {bgKind: {code: 'invalid', message: 'Upload a photo first.'}});
    const data = {
      ...fields,
      // Leaving `public` kills the share link for good: the old token must not come alive again if the board is later set to public.
      ...(fields.visibility !== undefined && fields.visibility !== 'public' ? {shareTokenHash: null, shareExpiresAt: null} : {}),
      ...(archived === undefined ? {} : {archivedAt: archived ? new Date() : null}),
    };
    if (!Object.keys(data).length) return c.json(problem('invalid_input', 'Nothing to change.'), 422);
    const rev = await c.var.db.$transaction(async tx => {
      const next = await bumpRev(tx, ctx.boardId, workspaceId);
      await tx.board.updateMany({where: {id: ctx.boardId, workspaceId}, data});
      // Turned private: people without a seat can never see its notifications again; drop them (the badge never scans dead rows).
      if (fields.visibility === 'private') await dropNotificationsForPrivateBoard(tx, ctx.boardId, workspaceId);
      await tx.activity.create({
        data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: archived === undefined ? 'board.updated' : archived ? 'board.archived' : 'board.restored'},
      });
      return next;
    });
    return c.json({ok: true, rev: String(rev)});
  })

  .put('/boards/:id/star', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(c.var.db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    await c.var.db.boardStar.upsert({
      where: {userId_boardId: {userId, boardId: ctx.boardId}},
      create: {userId, boardId: ctx.boardId},
      update: {},
      select: {userId: true},
    });
    return c.json({ok: true, starred: true});
  })

  .delete('/boards/:id/star', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(c.var.db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    await c.var.db.boardStar.deleteMany({where: {userId, boardId: ctx.boardId}});
    return c.json({ok: true, starred: false});
  })

  /* -------------------------------------------------------------- sync */
  .get('/boards/:id/rev', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    if (!boardId) return notFound(c, 'board');
    // ONE query: access (membership, private-board seat) and the revision together.
    const access = await boardAccess(c.var.db, boardId, userId);
    if (!access) return notFound(c, 'board');
    return c.json({rev: String(access.rev), archived: access.archived});
  })

  .get('/boards/:id/changes', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await boardFor(db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const raw = c.req.valid('query').since;
    if (!/^\d{1,15}$/.test(raw)) return invalid(c, {since: {code: 'invalid', message: 'Send the revision you have.'}});
    const since = BigInt(raw);
    // The revision is read FIRST and the lanes/cards are bounded by it (updatedRev <= rev): the three reads run in
    // separate snapshots, so a write that lands in between (rev bump + row change commit together) is either
    // inside this delta or has updatedRev > rev and comes with the next one; it can never be skipped.
    // Revision, name and background come from the access read (one query, already the first read).
    const board = ctx.access;
    const upto = {gt: since, lte: board.rev};
    const [lanes, cards] = await Promise.all([
      db.lane.findMany({where: {workspaceId, boardId: ctx.boardId, updatedRev: upto}, orderBy: {updatedRev: 'asc'}, take: CHANGES_CAP + 1, select: laneCols}),
      db.card.findMany({where: {workspaceId, boardId: ctx.boardId, updatedRev: upto}, orderBy: {updatedRev: 'asc'}, take: CHANGES_CAP + 1, select: cardCols}),
    ]);
    // Too many changes for a delta: the client reloads the board instead.
    const truncated = lanes.length > CHANGES_CAP || cards.length > CHANGES_CAP;
    return c.json({
      rev: String(board.rev),
      archived: board.archived,
      board: {
        name: board.name,
        visibility: board.visibility,
        bgKind: board.bgKind,
        bgColor1: board.bgColor1,
        bgColor2: board.bgColor2,
        bgAngle: board.bgAngle,
        bgPattern: board.bgPattern,
        bgImage: bgImageUrl(ctx.boardId, board.bgFileId),
        role: ctx.access.boardRole,
        canWrite: ctx.access.canWrite,
        canAdmin: ctx.access.canAdmin,
      },
      truncated,
      lanes: truncated ? [] : lanes.map(laneShape),
      cards: truncated ? [] : await withFaces(db, workspaceId, cards.map(cardShape)),
    });
  })

  /* ------------------------------------------------------------- lanes */
  .post('/boards/:id/lanes', laneBody(false), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const input = c.req.valid('json');
    const result = await c.var.db.$transaction(async tx => {
      const rev = await bumpRev(tx, ctx.boardId, workspaceId);
      // Count and last key are read AFTER the board lock: two parallel adds cannot share a key or pass the cap together.
      const [count, last] = await Promise.all([
        tx.lane.count({where: {workspaceId, boardId: ctx.boardId, archivedAt: null}}),
        laneFinder(tx, workspaceId, ctx.boardId)({}, 'desc'),
      ]);
      if (count >= MAX_LANES) return 'limit' as const;
      const lane = await tx.lane.create({
        data: {
          boardId: ctx.boardId,
          workspaceId,
          name: input.name!,
          position: generateKeyBetween(last?.position ?? null, null),
          colorHex: input.colorHex ?? null,
          wipLimit: input.wipLimit ?? null,
          updatedRev: rev,
        },
        select: laneCols,
      });
      await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.created', meta: {name: lane.name}}});
      return {lane, rev};
    });
    if (result === 'limit') return c.json(problem('limit_reached', `A board holds up to ${MAX_LANES} lanes.`), 409);
    return c.json({lane: {...laneShape(result.lane), cards: [], loaded: true, hasMore: false}, rev: String(result.rev)}, 201);
  })

  .patch('/lanes/:id', laneBody(true), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const input = c.req.valid('json');
    if (!Object.keys(input).length) return c.json(problem('invalid_input', 'Nothing to change.'), 422);
    const {workspaceId} = ctx.access;
    const out = await c.var.db.$transaction(async tx => {
      const rev = await bumpRev(tx, ctx.boardId, workspaceId);
      const {count} = await tx.lane.updateMany({
        where: {id: ctx.lane.id, boardId: ctx.boardId, workspaceId, archivedAt: null},
        data: {...input, updatedRev: rev},
      });
      if (!count) return null;
      if (input.name !== undefined) {
        await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.updated', meta: {laneId: ctx.lane.id}}});
      }
      return rev;
    });
    return out === null ? notFound(c, 'lane') : c.json({ok: true, rev: String(out)});
  })

  .post('/lanes/:id/move', moveBody(false), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {afterId} = c.req.valid('json');
    const early = await keyAfter(laneFinder(c.var.db, workspaceId, ctx.boardId), afterId, ctx.lane.id);
    if (early === 'stale') return stale(c);
    const out = await c.var.db
      .$transaction(async tx => {
        const rev = await bumpRev(tx, ctx.boardId, workspaceId);
        // Recomputed under the board lock (bumpRev took it): the siblings are exactly as they are now.
        let key = await keyAfter(laneFinder(tx, workspaceId, ctx.boardId), afterId, ctx.lane.id, 'signal');
        if (key === 'exhausted') {
          await rebalance(tx, 'lanes', ctx.boardId, ctx.boardId, workspaceId, ctx.lane.id, rev);
          key = await keyAfter(laneFinder(tx, workspaceId, ctx.boardId), afterId, ctx.lane.id);
        }
        if (key === 'stale' || key === 'exhausted') throw new StaleMove();
        await tx.lane.updateMany({where: {id: ctx.lane.id, boardId: ctx.boardId, workspaceId}, data: {position: key, updatedRev: rev}});
        await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.moved', meta: {laneId: ctx.lane.id}}});
        return {rev, key};
      })
      .catch(err => {
        if (err instanceof StaleMove) return null;
        throw err;
      });
    if (!out) return stale(c);
    return c.json({ok: true, rev: String(out.rev), position: out.key});
  })

  .post('/lanes/:id/archive', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const rev = await c.var.db.$transaction(async tx => {
      const next = await bumpRev(tx, ctx.boardId, workspaceId);
      await tx.lane.updateMany({where: {id: ctx.lane.id, boardId: ctx.boardId, workspaceId}, data: {archivedAt: new Date(), updatedRev: next}});
      await tx.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'lane.archived', meta: {laneId: ctx.lane.id}}});
      return next;
    });
    return c.json({ok: true, rev: String(rev)});
  })

  /* ------------------------------------------------------------- cards */
  .get('/lanes/:id/cards', cursorQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const ctx = await laneFor(c.var.db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const after = c.req.valid('query').after;
    let cursor: {position: string; id: number} | null = null;
    if (after) {
      const m = cursorOfCard.exec(after);
      if (!m) return invalid(c, {after: {code: 'invalid', message: 'Unknown page.'}});
      const cursorId = Number(m[2]);
      if (!(cursorId > 0 && cursorId <= 2_147_483_647)) return invalid(c, {after: {code: 'invalid', message: 'Unknown page.'}});
      cursor = {position: m[1]!, id: cursorId};
    }
    // Row comparison reads only the next page from the (workspace, lane, position, id) index; the OR form re-reads the rest of the lane.
    const rows = cursor ? await cardsAfter(c.var.db, workspaceId, ctx.lane.id, cursor) : await c.var.db.card.findMany({
      where: {workspaceId, laneId: ctx.lane.id, archivedAt: null},
      orderBy: [...order('asc')],
      take: CARDS_PAGE + 1,
      select: cardCols,
    });
    const page = rows.slice(0, CARDS_PAGE);
    const last = page.at(-1);
    return c.json({items: await withFaces(c.var.db, workspaceId, page.map(cardShape)), next: rows.length > CARDS_PAGE && last ? `${last.position}|${last.id}` : null});
  })

  .post('/lanes/:id/cards', newCardsBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await laneFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {titles} = c.req.valid('json');
    const out = await c.var.db.$transaction(async tx => {
      const rev = await bumpRev(tx, ctx.boardId, workspaceId);
      // The last key is read AFTER the board lock, so two parallel adds never get the same keys.
      const last = await cardFinder(tx, workspaceId, ctx.lane.id)({}, 'desc');
      const keys = keysAtEnd(last?.position ?? null, titles.length);
      // The per-lane cap is ONE conditional update, so two parallel adds cannot both pass it.
      const room = await tx.$queryRaw<{id: number}[]>`
        UPDATE lanes SET card_count = card_count + ${titles.length}::int, updated_rev = ${rev}
        WHERE id = ${ctx.lane.id} AND board_id = ${ctx.boardId} AND workspace_id = ${workspaceId}
          AND card_count + ${titles.length}::int <= ${MAX_CARDS_PER_LANE}::int
        RETURNING id`;
      if (!room[0]) return null;
      const firstNumber = await reserveCardNumbers(tx, ctx.boardId, workspaceId, titles.length);
      const cards = await tx.card.createManyAndReturn({
        data: titles.map((title, i) => ({
          number: firstNumber + i,
          boardId: ctx.boardId,
          laneId: ctx.lane.id,
          workspaceId,
          title,
          position: keys[i]!,
          updatedRev: rev,
          createdBy: userId,
        })),
        select: cardCols,
      });
      await tx.activity.createMany({
        data: cards.map(card => ({workspaceId, boardId: ctx.boardId, cardId: card.id, actorId: userId, kind: 'card.created', meta: {title: card.title}})),
      });
      // Whoever makes a card follows it (one statement for all the new cards).
      await tx.cardWatcher.createMany({data: cards.map(card => ({cardId: card.id, userId})), skipDuplicates: true});
      return {cards, rev};
    });
    if (!out) return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    // Flows (Phase 7) run after the commit and never fail the request.
    await runFlows(c.var.db, out.cards.map(card => ({kind: 'card_created' as const, workspaceId, boardId: ctx.boardId, cardId: card.id, laneId: ctx.lane.id})));
    return c.json({items: out.cards.map(cardShape), rev: String(out.rev)}, 201);
  })

  .patch('/cards/:id', cardPatchBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await cardFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {completed, ...fields} = c.req.valid('json');
    const out = await c.var.db.$transaction(async tx => {
      const rev = await bumpRev(tx, ctx.boardId, workspaceId);
      // What it was, read under the board lock, so followers hear only about a real change.
      const before = await tx.card.findFirst({where: {id: ctx.card.id, boardId: ctx.boardId, workspaceId}, select: {dueDate: true, completedAt: true}});
      const {count} = await tx.card.updateMany({
        where: {id: ctx.card.id, boardId: ctx.boardId, workspaceId, archivedAt: null},
        data: {...fields, ...(completed === undefined ? {} : {completedAt: completed ? new Date() : null}), updatedRev: rev},
      });
      if (!count) return null;
      const card = await tx.card.findFirst({where: {id: ctx.card.id, boardId: ctx.boardId, workspaceId}, select: cardCols});
      await tx.activity.create({
        data: {workspaceId, boardId: ctx.boardId, cardId: ctx.card.id, actorId: userId, kind: 'card.updated', meta: {fields: Object.keys(c.req.valid('json'))}},
      });
      return {
        card,
        rev,
        dueChanged: fields.dueDate !== undefined && (fields.dueDate?.getTime() ?? null) !== (before?.dueDate?.getTime() ?? null),
        justCompleted: completed === true && before?.completedAt === null,
      };
    });
    if (!out?.card) return notFound(c, 'card');
    // After the commit, never failing the request: the people who follow the card hear about it.
    const watched = {workspaceId, boardId: ctx.boardId, cardId: ctx.card.id};
    if (out.justCompleted) await notifyWatchers(c.var.db, watched, userId, 'card_done');
    else if (out.dueChanged) await notifyWatchers(c.var.db, watched, userId, 'card_due');
    return c.json({card: cardShape(out.card), rev: String(out.rev)});
  })

  .post('/cards/:id/move', moveBody(true), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await cardFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const {laneId, afterId} = c.req.valid('json');
    // Validate and compute first (outside the transaction); the rev and its row lock come last.
    const target = await c.var.db.lane.findFirst({where: {id: laneId, boardId: ctx.boardId, workspaceId, archivedAt: null}, select: {id: true}});
    if (!target) return c.json(problem('not_found', 'No such lane.'), 404);
    const from = ctx.card.laneId;
    // Early answer only; the key that is written is recomputed inside the transaction, under the board lock.
    const early = await keyAfter(cardFinder(c.var.db, workspaceId, laneId), afterId, ctx.card.id);
    if (early === 'stale') return stale(c);
    const out = await c.var.db
      .$transaction(async tx => {
      // ONE statement under the board lock: bump rev, move the card (only while it is still in `from`), move the
      // lane counters (the target only below the cap) and write the activity row. Flags say what did not apply;
      // throwing rolls the whole statement back, so a refused move changes nothing.
      const cross = from !== laneId;
      // Take the board lock FIRST, then recompute the key against the siblings as they are now: a parallel move
      // that committed since the pre-check cannot leave us a stale key (two cards sharing one).
      const locked = await tx.$queryRaw<{rev: bigint}[]>`SELECT rev FROM boards WHERE id = ${ctx.boardId}::int AND workspace_id = ${workspaceId}::int FOR UPDATE`;
      if (!locked[0]) throw new Error('board vanished');
      let fresh = await keyAfter(cardFinder(tx, workspaceId, laneId), afterId, ctx.card.id, 'signal');
      if (fresh === 'exhausted') {
        // The gap is used up: renumber the lane's cards, stamped with the rev the statement below will commit
        // (the board is locked, so it is exactly rev + 1), then place the card in the fresh gap. One rev bump.
        await rebalance(tx, 'cards', laneId, ctx.boardId, workspaceId, ctx.card.id, locked[0].rev + 1n);
        fresh = await keyAfter(cardFinder(tx, workspaceId, laneId), afterId, ctx.card.id);
      }
      if (fresh === 'stale' || fresh === 'exhausted') throw new StaleMove();
      const key = fresh;
      const rows = await tx.$queryRaw<{rev: bigint | null; moved: number; room: boolean; open: boolean}[]>`
        WITH b AS (
          UPDATE boards SET rev = rev + 1, updated_at = now()
          WHERE id = ${ctx.boardId}::int AND workspace_id = ${workspaceId}::int RETURNING rev
        ), c AS (
          UPDATE cards SET lane_id = ${laneId}::int, position = ${key}, updated_rev = b.rev
          FROM b
          WHERE cards.id = ${ctx.card.id}::int AND cards.board_id = ${ctx.boardId}::int AND cards.workspace_id = ${workspaceId}::int
            AND cards.lane_id = ${from}::int AND cards.archived_at IS NULL
          RETURNING cards.id
        ), t AS (
          UPDATE lanes SET card_count = card_count + 1, updated_rev = b.rev
          FROM b
          WHERE ${cross}::boolean AND EXISTS (SELECT 1 FROM c)
            AND lanes.id = ${laneId}::int AND lanes.board_id = ${ctx.boardId}::int AND lanes.workspace_id = ${workspaceId}::int
            AND lanes.archived_at IS NULL AND lanes.card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
          RETURNING lanes.id
        ), f AS (
          UPDATE lanes SET card_count = card_count - 1, updated_rev = b.rev
          FROM b
          WHERE ${cross}::boolean AND EXISTS (SELECT 1 FROM c) AND EXISTS (SELECT 1 FROM t)
            AND lanes.id = ${from}::int AND lanes.board_id = ${ctx.boardId}::int AND lanes.workspace_id = ${workspaceId}::int
          RETURNING lanes.id
        ), a AS (
          INSERT INTO activity (workspace_id, board_id, card_id, actor_id, kind, meta)
          SELECT ${workspaceId}::int, ${ctx.boardId}::int, ${ctx.card.id}::int, ${userId}::int, 'card.moved',
                 jsonb_build_object('from', ${from}::int, 'to', ${laneId}::int)
          WHERE EXISTS (SELECT 1 FROM c) AND (NOT ${cross}::boolean OR EXISTS (SELECT 1 FROM t))
          RETURNING id
        )
        SELECT (SELECT rev FROM b) AS rev, (SELECT count(*)::int FROM c) AS moved,
               (NOT ${cross}::boolean OR EXISTS (SELECT 1 FROM t)) AS room,
               EXISTS (SELECT 1 FROM lanes WHERE id = ${laneId}::int AND board_id = ${ctx.boardId}::int AND archived_at IS NULL) AS open`;
      const row = rows[0];
      if (!row?.rev) throw new Error('board vanished');
      if (!row.moved) throw new StaleMove(); // rolls back the rev bump: nothing changed
      if (!row.room) throw row.open ? new LaneFull() : new LaneGone(); // rolls back the bump and the card update
      const rev = row.rev;
      return {rev, key};
    })
      .catch(err => {
        if (err instanceof LaneFull) return 'full' as const;
        if (err instanceof StaleMove) return 'stale' as const;
        if (err instanceof LaneGone) return 'gone' as const;
        throw err;
      });
    if (out === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    if (out === 'stale') return stale(c);
    if (out === 'gone') return c.json(problem('not_found', 'No such lane.'), 404);
    if (from !== laneId) await notifyWatchers(c.var.db, {workspaceId, boardId: ctx.boardId, cardId: ctx.card.id}, userId, 'card_moved');
    if (from !== laneId) await runFlows(c.var.db, [{kind: 'card_moved', workspaceId, boardId: ctx.boardId, cardId: ctx.card.id, laneId, fromLaneId: from}]);
    return c.json({ok: true, rev: String(out.rev), position: out.key});
  })

  .post('/cards/:id/archive', withViewer, requireAuth, withDb, noStore, async c => archiveCard(c, true))
  .post('/cards/:id/restore', withViewer, requireAuth, withDb, noStore, async c => archiveCard(c, false));

/** Archive (`true`) or restore a card; the lane's counter follows in the same transaction. */
async function archiveCard(
  c: {var: {db: PrismaClient; viewer: {id?: number | null}}; req: {param: (name: string) => string}; json: (body: unknown, status?: 404 | 403 | 409) => Response},
  archive: boolean
) {
  const userId = c.var.viewer.id!;
  const ctx = await cardFor(c.var.db, userId, idOf(c.req.param('id')), 'write');
  if (refused(ctx)) return c.json(ctx.body, ctx.status);
  const {workspaceId} = ctx.access;
  const rev = await c.var.db
    .$transaction(async tx => {
      const next = await bumpRev(tx, ctx.boardId, workspaceId);
      // The lane is read AFTER the row lock: a concurrent move cannot make the counter follow the wrong lane.
      const current = await tx.card.findFirst({
        where: {id: ctx.card.id, boardId: ctx.boardId, workspaceId, archivedAt: archive ? null : {not: null}},
        select: {laneId: true},
      });
      if (!current) return null;
      // Restore: the lane counter goes up ONLY while the lane is open and below the cap (the same conditional
      // update as the move); otherwise the whole transaction (bump included) rolls back and the client is told why.
      // Archive: the counter goes down (an archived lane keeps its own counter untouched below).
      const lane = await tx.lane.updateMany({
        where: archive
          ? {id: current.laneId, boardId: ctx.boardId, workspaceId}
          : {id: current.laneId, boardId: ctx.boardId, workspaceId, archivedAt: null, cardCount: {lt: MAX_CARDS_PER_LANE}},
        data: {cardCount: archive ? {decrement: 1} : {increment: 1}, updatedRev: next},
      });
      if (!lane.count) {
        const open = await tx.lane.findFirst({where: {id: current.laneId, boardId: ctx.boardId, workspaceId, archivedAt: null}, select: {id: true}});
        throw open ? new LaneFull() : new LaneGone();
      }
      const {count} = await tx.card.updateMany({
        where: {id: ctx.card.id, boardId: ctx.boardId, workspaceId, archivedAt: archive ? null : {not: null}},
        data: {archivedAt: archive ? new Date() : null, updatedRev: next},
      });
      if (!count) return null;
      await tx.activity.create({
        data: {workspaceId, boardId: ctx.boardId, cardId: ctx.card.id, actorId: userId, kind: archive ? 'card.archived' : 'card.restored'},
      });
      return next;
    })
    .catch(err => {
      if (err instanceof LaneFull) return 'full' as const;
      if (err instanceof LaneGone) return 'gone' as const;
      throw err;
    });
  if (rev === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
  if (rev === 'gone') return c.json(problem('not_found', 'No such lane.'), 404);
  return rev === null ? c.json(problem('not_found', 'No such card.'), 404) : c.json({ok: true, rev: String(rev)});
}
