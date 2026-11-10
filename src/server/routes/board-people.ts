import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {requireAuth, withDb, withViewer} from '../../platform/guards';
import {idOf, likeEscape} from '../validation';
import {boardAccess, isWorkspaceRole, notFound, resolveBoardRole, type BoardRole} from '../workspaces';
import {noStore} from './boards';

/**
 * Who is on a board: everyone who can see it, with their role ON THIS BOARD. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET /boards/:id/people?q=   {items: [{id, name, role: 'admin'|'member'|'viewer'}], more: boolean}
 *
 * Guards: withViewer, requireAuth, withDb, then the board access (the visitor's workspace membership is IN its query:
 * another workspace's board, or a private board they have no seat on, is a 404). Any role may read it, like the card
 * people picker. ONE query, bounded (LIMIT + 1 for `more`), names only: an email never leaves here.
 * Who counts: active workspace members; a private board only its board members and the workspace owners/admins; a
 * personal Inbox only its owner (the same rules as boardAccess / seatFilter).
 */

const PAGE = 200;

const peopleQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 80) : '',
}));

export const boardPeopleRoutes = new Hono().get('/boards/:id/people', peopleQuery, withViewer, requireAuth, withDb, noStore, async c => {
  const db = c.var.db;
  const boardId = idOf(c.req.param('id'));
  const access = boardId ? await boardAccess(db, boardId, c.var.viewer.id!) : null;
  if (!boardId || !access) return notFound(c, 'board');
  const q = c.req.valid('query').q;
  const like = `%${likeEscape(q)}%`;
  const rows = await db.$queryRaw<{id: number; name: string; wsRole: string; boardRole: string | null; inboxOf: number | null; visibility: string}[]>`
    SELECT u.id, u.name, m.role AS "wsRole", bm.role AS "boardRole", b.inbox_of AS "inboxOf", b.visibility
    FROM boards b
    JOIN workspace_members m ON m.workspace_id = b.workspace_id
    JOIN users u ON u.id = m.user_id
    LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = m.user_id
    WHERE b.id = ${boardId} AND b.workspace_id = ${access.workspaceId} AND u.status = 'active'
      AND (b.inbox_of IS NULL OR b.inbox_of = m.user_id)
      AND (b.visibility <> 'private' OR b.inbox_of IS NOT NULL OR m.role IN ('owner', 'admin') OR bm.user_id IS NOT NULL)
      AND (${q}::text = '' OR u.name ILIKE ${like})
    ORDER BY u.name, u.id
    LIMIT ${PAGE + 1}`;
  const items = rows.slice(0, PAGE).flatMap(r => {
    if (!isWorkspaceRole(r.wsRole)) return [];
    const override = r.boardRole === 'admin' || r.boardRole === 'member' || r.boardRole === 'viewer' ? (r.boardRole as BoardRole) : null;
    const role = r.inboxOf !== null ? 'admin' : resolveBoardRole(r.wsRole, r.visibility, override);
    return role ? [{id: r.id, name: r.name, role}] : [];
  });
  return c.json({items, more: rows.length > PAGE});
});
