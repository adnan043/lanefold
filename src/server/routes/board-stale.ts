import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {audit} from '../../platform/auth';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {isStaleDays, type StaleDays} from '../../lib/stale';
import {getEntitlements} from '../entitlements';
import {idOf, invalid, objectOf} from '../validation';
import {boardAccess, notFound} from '../workspaces';
import {noStore} from './boards';

/**
 * Stale card warning, the board's setting (the job is src/server/jobs/stale-cards.ts). Mounted ONCE at `/` in `app.ts`.
 *
 *   GET /boards/:id/stale-days   {staleDays: 3 | 7 | 14 | 30 | null}   null = off (the default)
 *   PUT /boards/:id/stale-days   {staleDays}                           the same value back
 *
 * Guards: validator, withViewer, requireAuth, withDb, then the board access (the visitor's workspace membership is IN
 * its query: another workspace's board is a 404) and board ADMIN (403). The write also refuses an archived board, a
 * read-only workspace (409); a personal Inbox is a 404 (the UPDATE's `where` excludes it). One conditional UPDATE with the workspace in its `where`.
 */

const forbidden = (c: {json: (b: unknown, s: 403) => Response}) => c.json(problem('forbidden', 'You do not have access to this.'), 403);

const staleBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const raw = v?.staleDays;
  if (raw === null || isStaleDays(raw)) return {staleDays: raw as StaleDays | null};
  return invalid(c, {staleDays: {code: 'invalid', message: 'Choose off, 3, 7, 14 or 30 days.'}});
});

export const boardStaleRoutes = new Hono()
  .get('/boards/:id/stale-days', withViewer, requireAuth, withDb, noStore, async c => {
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, c.var.viewer.id!) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canAdmin) return forbidden(c);
    const row = await c.var.db.board.findFirst({
      where: {id: boardId, workspaceId: access.workspaceId},
      select: {staleDays: true},
    });
    if (!row) return notFound(c, 'board');
    return c.json({staleDays: isStaleDays(row.staleDays) ? row.staleDays : null});
  })

  .put('/boards/:id/stale-days', staleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canAdmin) return forbidden(c);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const {staleDays} = c.req.valid('json');
    const {count} = await db.board.updateMany({
      where: {id: boardId, workspaceId: access.workspaceId, archivedAt: null, inboxOf: null},
      data: {staleDays},
    });
    if (count === 0) return notFound(c, 'board');
    await audit(db, {actorUserId: userId, action: 'board.stale.set', target: ['board', boardId], meta: {workspaceId: access.workspaceId, staleDays}});
    return c.json({staleDays});
  });
