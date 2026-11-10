import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {getEntitlements} from '../entitlements';
import {boardAccess, notFound} from '../workspaces';
import {idOf, invalid, objectOf, textField, type FieldError} from '../validation';

/**
 * Phase 3 saved filters: named snapshots of the board filter bar. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET    /boards/:id/saved-filters   mine plus the ones shared with the board (newest first, bounded)
 *   POST   /boards/:id/saved-filters   {name, filter, scope?} save the current filter bar
 *   PATCH  /saved-filters/:id          {name?, scope?} rename, share or unshare
 *   DELETE /saved-filters/:id          delete
 *
 * SCOPE. `private` (the default, every old row): only its author sees it, and any seat that may SEE the board
 * (viewers too) may keep their own. `board`: everyone with a seat on the board sees and applies it. Rules:
 *   - sharing (create with scope board, or private -> board) needs WRITE on the board, so a viewer cannot;
 *   - renaming, unsharing or deleting a shared filter: its author or a board admin (anyone else who can see it: 403);
 *   - someone else's private filter does not exist for anyone (404), an admin included;
 *   - a shared filter's ids are checked at save time against THIS board's labels and the workspace's members, so
 *     it never points at another board's data. It stores ids only: a reader's client resolves them against what
 *     that reader can already see, so a shared filter shows no name or label the reader could not see anyway.
 *   - the author's name comes only from the workspace's members (a person who left shows no name), never an email.
 * The workspace and the board are IN every `where`; another workspace's board, or a private board without a seat,
 * answers 404. Creating, renaming and sharing follow the usual write rules (archived board 409, read-only
 * workspace 409); deleting is always allowed.
 */

/** Filters one person may keep per board (private and shared together). */
export const MAX_PER_BOARD = 20;
/** Filters shared with everyone on one board. */
export const MAX_SHARED_PER_BOARD = 30;
const SCOPES = ['private', 'board'] as const;
type Scope = (typeof SCOPES)[number];
const SHARED_LOCK = 7101; // second key of the board-wide advisory lock for the shared list
const NAME_MAX = 60; // saved_filters.name is VarChar(60)
const TEXT_MAX = 80;
const MAX_IDS = 20;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const DUE = ['none', 'overdue', 'day', 'week', 'month'] as const;
const STATUS = ['complete', 'incomplete'] as const;

type FilterJson = {
  text?: string;
  labelIds?: number[];
  noLabels?: boolean;
  memberIds?: number[];
  noMembers?: boolean;
  dues?: (typeof DUE)[number][];
  dueFrom?: string;
  dueTo?: string;
  status?: (typeof STATUS)[number];
  priority?: (typeof PRIORITIES)[number];
  match?: 'all';
};

/** A real calendar date as YYYY-MM-DD (`2026-02-30` is refused). */
function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const bad = (message: string): {ok: false; error: FieldError} => ({ok: false, error: {code: 'invalid', message}});

function idList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_IDS) return null;
  const out: number[] = [];
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 2_147_483_647) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The board filter bar, strictly: only these keys, each of the right type and size. Anything else is refused
 * (never stored as-is). Ids here only SELECT cards on the client; they grant nothing.
 */
export function parseFilter(value: unknown): {ok: true; value: FilterJson} | {ok: false; error: FieldError} {
  const v = objectOf(value);
  if (!v) return bad('Send the filter as an object.');
  const allowed = new Set(['text', 'labelIds', 'noLabels', 'memberIds', 'noMembers', 'due', 'dues', 'dueFrom', 'dueTo', 'status', 'priority', 'match']);
  if (Object.keys(v).some(k => !allowed.has(k))) return bad('That filter has fields Lanefold does not know.');
  const out: FilterJson = {};
  if (v.text !== undefined) {
    const text = textField(v.text, 0, TEXT_MAX);
    if (!text.ok) return text;
    if (text.value) out.text = text.value;
  }
  for (const key of ['labelIds', 'memberIds'] as const) {
    if (v[key] === undefined) continue;
    const ids = idList(v[key]);
    if (!ids) return bad(`${key} must be a list of at most ${MAX_IDS} ids.`);
    if (ids.length) out[key] = ids;
  }
  for (const key of ['noLabels', 'noMembers'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'boolean') return bad(`${key} must be true or false.`);
    if (v[key]) out[key] = true;
  }
  // `due` is the old single value (`today` is now `day`); `dues` is the list.
  const dueInput: unknown[] = Array.isArray(v.dues) ? v.dues : v.dues === undefined ? [] : [null];
  if (v.due !== undefined) dueInput.push(v.due === 'today' ? 'day' : v.due);
  if (dueInput.length > DUE.length + 1 || dueInput.some(d => typeof d !== 'string' || !(DUE as readonly string[]).includes(d))) return bad('Pick due states from the list.');
  const dues = DUE.filter(d => dueInput.includes(d));
  if (dues.length) out.dues = dues;
  for (const key of ['dueFrom', 'dueTo'] as const) {
    if (v[key] === undefined) continue;
    if (!isISODate(v[key])) return bad('Custom due dates must be real dates like 2026-11-05.');
    out[key] = v[key];
  }
  if (out.dueFrom && out.dueTo && out.dueFrom > out.dueTo) return bad('The custom due range must start before it ends.');
  if (v.status !== undefined) {
    if (typeof v.status !== 'string' || !(STATUS as readonly string[]).includes(v.status)) return bad('Pick complete or not complete.');
    out.status = v.status as FilterJson['status'];
  }
  if (v.match !== undefined) {
    if (v.match !== 'any' && v.match !== 'all') return bad('Match any or all.');
    if (v.match === 'all') out.match = 'all';
  }
  if (v.priority !== undefined) {
    if (typeof v.priority !== 'string' || !(PRIORITIES as readonly string[]).includes(v.priority)) return bad('Pick a priority from the list.');
    out.priority = v.priority as FilterJson['priority'];
  }
  if (Object.keys(out).length === 0) return bad('Set at least one filter before saving.');
  return {ok: true, value: out};
}

/** A stored filter read back as the same strict shape (an unreadable one counts as empty, so it is never shared). */
function parseStored(value: unknown): FilterJson {
  const parsed = parseFilter(value);
  return parsed.ok ? parsed.value : {};
}

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const scopeField = (value: unknown): {ok: true; value: Scope | undefined} | {ok: false; error: FieldError} => {
  if (value === undefined) return {ok: true, value: undefined};
  if (typeof value !== 'string' || !(SCOPES as readonly string[]).includes(value)) return bad('Share with the board, or keep it private.');
  return {ok: true, value: value as Scope};
};

const createBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  const errors: Record<string, FieldError> = {};
  const name = textField(v.name, 1, NAME_MAX);
  if (!name.ok) errors.name = name.error;
  const filter = parseFilter(v.filter);
  if (!filter.ok) errors.filter = filter.error;
  const scope = scopeField(v.scope);
  if (!scope.ok) errors.scope = scope.error;
  if (!name.ok || !filter.ok || !scope.ok) return invalid(c, errors);
  return {name: name.value, filter: filter.value, scope: scope.value ?? ('private' as Scope)};
});

const patchBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  const errors: Record<string, FieldError> = {};
  let name: string | undefined;
  if (v.name !== undefined) {
    const n = textField(v.name, 1, NAME_MAX);
    if (n.ok) name = n.value;
    else errors.name = n.error;
  }
  const scope = scopeField(v.scope);
  if (!scope.ok) errors.scope = scope.error;
  if (Object.keys(errors).length) return invalid(c, errors);
  if (name === undefined && !(scope.ok && scope.value)) return invalid(c, {name: {code: 'invalid', message: 'Send a new name or a new scope.'}});
  return {name, scope: scope.ok ? scope.value : undefined};
});

const SELECT = {id: true, userId: true, name: true, filter: true, scope: true, createdAt: true} as const;
type Row = {id: number; userId: number; name: string; filter: unknown; scope: string; createdAt: Date};
const forbidden = (c: {json: (b: unknown, s: 403) => Response}) => c.json(problem('forbidden', 'You do not have access to this.'), 403);

/** The browser shape. `author` is a name only (null when the author left the workspace), never an email. */
const present = (r: Row, me: number, names: Map<number, string>) => ({
  id: r.id,
  name: r.name,
  filter: r.filter,
  scope: r.scope === 'board' ? 'board' : 'private',
  mine: r.userId === me,
  author: r.scope === 'board' ? { name: names.get(r.userId) ?? null } : null,
  createdAt: r.createdAt.toISOString(),
});

/** Names of the given people, but only those who are still members of this workspace (one query). */
async function authorNames(db: PrismaClient, workspaceId: number, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.$queryRaw<{id: number; name: string}[]>`SELECT u.id, u.name FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ${workspaceId} WHERE u.id IN (${Prisma.join(ids)})`;
  return new Map(rows.map(r => [r.id, r.name]));
}

/** Write rules shared by create, rename and share: archived board and read-only workspace refuse. */
async function writeBlocked(c: {json: (b: unknown, s: 409) => Response}, db: PrismaClient, access: {archived: boolean; workspaceId: number}) {
  if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
  const ent = await getEntitlements(db, access.workspaceId);
  if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
  return null;
}

/**
 * A filter shared with the board points only at THIS board's labels and at people of this workspace, so it can
 * never carry another board's or workspace's ids. Checked when a filter becomes shared (two counts, in parallel).
 */
async function sharedIdsValid(db: PrismaClient, boardId: number, workspaceId: number, filter: FilterJson): Promise<boolean> {
  const [labels, people] = await Promise.all([
    filter.labelIds?.length ? db.label.count({where: {boardId, workspaceId, id: {in: filter.labelIds}}}) : Promise.resolve(0),
    filter.memberIds?.length ? db.workspaceMember.count({where: {workspaceId, userId: {in: filter.memberIds}}}) : Promise.resolve(0),
  ]);
  return labels === (filter.labelIds?.length ?? 0) && people === (filter.memberIds?.length ?? 0);
}

const badIds = (c: {json: (b: unknown, s: 422) => Response}) =>
  c.json({...problem('invalid', 'This filter points at labels or people that are not on this board.'), fields: {filter: {code: 'invalid', message: 'Pick only labels and people of this board.'}}}, 422);

/**
 * A filter I may see (mine, or shared with the board) by id, with my access to its board; null is a 404.
 * Someone else's private filter is never found, whoever asks.
 */
async function visibleById(db: PrismaClient, id: number, userId: number) {
  const row = await db.savedFilter.findFirst({where: {id, OR: [{userId}, {scope: 'board'}]}, select: {id: true, userId: true, scope: true, boardId: true, workspaceId: true, filter: true}});
  if (!row) return null;
  const access = await boardAccess(db, row.boardId, userId);
  if (!access || access.workspaceId !== row.workspaceId) return null;
  return {row, access};
}

export const savedFilterRoutes = new Hono()
  .get('/boards/:id/saved-filters', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    // Mine (at most MAX_PER_BOARD) plus the shared ones (at most MAX_SHARED_PER_BOARD): bounded by the sum.
    const rows = await c.var.db.savedFilter.findMany({
      where: {boardId, workspaceId: access.workspaceId, OR: [{userId}, {scope: 'board'}]},
      orderBy: {id: 'desc'},
      take: MAX_PER_BOARD + MAX_SHARED_PER_BOARD,
      select: SELECT,
    });
    const authors = [...new Set(rows.filter(r => r.scope === 'board' && r.userId !== userId).map(r => r.userId))];
    const names = await authorNames(c.var.db, access.workspaceId, authors);
    return c.json({items: rows.map(r => present(r, userId, names)), max: MAX_PER_BOARD, maxShared: MAX_SHARED_PER_BOARD, canShare: access.canWrite, canAdmin: access.canAdmin});
  })

  .post('/boards/:id/saved-filters', createBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    const {name, filter, scope} = c.req.valid('json');
    if (scope === 'board' && !access.canWrite) return forbidden(c);
    const blocked = await writeBlocked(c, db, access);
    if (blocked) return blocked;
    const {workspaceId} = access;
    if (scope === 'board' && !(await sharedIdsValid(db, boardId, workspaceId, filter))) return badIds(c);
    const created = await db.$transaction(async tx => {
      // One person's saves on one board take turns, so the cap holds under double clicks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userId}::int, ${boardId}::int)`;
      const mine = await tx.savedFilter.count({where: {userId, boardId, workspaceId}});
      if (mine >= MAX_PER_BOARD) return 'mine' as const;
      if (scope === 'board') {
        // The board's shared list takes turns too (a second key, so it never blocks a personal save).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${boardId}::int, ${SHARED_LOCK}::int)`;
        const shared = await tx.savedFilter.count({where: {boardId, workspaceId, scope: 'board'}});
        if (shared >= MAX_SHARED_PER_BOARD) return 'shared' as const;
      }
      return tx.savedFilter.create({data: {userId, boardId, workspaceId, name, filter, scope}, select: SELECT});
    });
    if (created === 'mine') return c.json(problem('limit_reached', `You can keep up to ${MAX_PER_BOARD} saved filters per board.`), 409);
    if (created === 'shared') return c.json(problem('limit_reached', `A board can share up to ${MAX_SHARED_PER_BOARD} saved filters.`), 409);
    const names = await authorNames(db, workspaceId, scope === 'board' ? [userId] : []);
    return c.json({item: present(created, userId, names)}, 201);
  })

  .patch('/saved-filters/:id', patchBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const id = idOf(c.req.param('id'));
    const found = id ? await visibleById(db, id, userId) : null;
    if (!id || !found) return notFound(c, 'saved filter');
    const {row, access} = found;
    // A shared filter belongs to its author and to the board's admins; anyone else who can see it may only use it.
    if (row.userId !== userId && !access.canAdmin) return forbidden(c);
    const {name, scope} = c.req.valid('json');
    const sharing = scope === 'board' && row.scope !== 'board';
    // Sharing is a write (a viewer cannot); unsharing is allowed to whoever owns or administers it.
    if (sharing && !access.canWrite) return forbidden(c);
    const blocked = await writeBlocked(c, db, access);
    if (blocked) return blocked;
    if (sharing && !(await sharedIdsValid(db, row.boardId, row.workspaceId, parseStored(row.filter)))) return badIds(c);
    const updated = await db.$transaction(async tx => {
      if (sharing) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${row.boardId}::int, ${SHARED_LOCK}::int)`;
        const shared = await tx.savedFilter.count({where: {boardId: row.boardId, workspaceId: row.workspaceId, scope: 'board'}});
        if (shared >= MAX_SHARED_PER_BOARD) return 'shared' as const;
      }
      // Id, owner-or-shared and workspace are IN the where; the scope can only change from what we just read.
      const {count} = await tx.savedFilter.updateMany({
        where: {id, workspaceId: row.workspaceId, boardId: row.boardId, OR: [{userId}, {scope: 'board'}]},
        data: {...(name !== undefined ? {name} : {}), ...(scope !== undefined ? {scope} : {})},
      });
      return count ? tx.savedFilter.findFirst({where: {id, workspaceId: row.workspaceId}, select: SELECT}) : null;
    });
    if (updated === 'shared') return c.json(problem('limit_reached', `A board can share up to ${MAX_SHARED_PER_BOARD} saved filters.`), 409);
    if (!updated) return notFound(c, 'saved filter');
    const names = await authorNames(db, row.workspaceId, updated.scope === 'board' ? [updated.userId] : []);
    return c.json({item: present(updated, userId, names)});
  })

  .delete('/saved-filters/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const id = idOf(c.req.param('id'));
    const found = id ? await visibleById(db, id, userId) : null;
    if (!id || !found) return notFound(c, 'saved filter');
    if (found.row.userId !== userId && !found.access.canAdmin) return forbidden(c);
    const {count} = await db.savedFilter.deleteMany({where: {id, workspaceId: found.row.workspaceId, boardId: found.row.boardId, OR: [{userId}, {scope: 'board'}]}});
    if (!count) return notFound(c, 'saved filter');
    return c.json({ok: true});
  });
