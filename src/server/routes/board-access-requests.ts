import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {afterResponse} from '../after-response';
import {acceptSeat, canInvite} from '../board-seats';
import {enqueueAccessApprovedEmail} from '../jobs/access-request-email';
import {notify} from '../notifications';
import {idOf, invalid, objectOf} from '../validation';
import {boardAccess} from '../workspaces';
import {boardFor, noStore, refused} from './boards';
import {inviteCtx, isRefusal} from './board-members';

/**
 * Asking to join a board you cannot open (the "This board is private: send a request" screen), and answering it.
 * Mounted ONCE at `/` in `app.ts`.
 *
 *   GET  /boards/:id/access-request            {status: none | pending | member}     the visitor's own request
 *   POST /boards/:id/access-request            {status: pending | member}            ask (any signed-in person)
 *   GET  /boards/:id/access-requests           {items}                               the pending list: who may add people
 *   POST /access-requests/:id/approve  {role}  seat them (member or viewer)          who may add people
 *   POST /access-requests/:id/decline                                                who may add people
 *
 * The requester's side never tells whether a board exists: a missing, archived or Inbox board answers exactly like a
 * real one (`pending`), and nothing about the board (its name, its workspace) is ever returned. Only someone who can
 * already open it learns `member`. A request again after a decline is quiet for DECLINE_QUIET_DAYS (no new
 * notification), so admins are not pestered. New requests are capped per person per hour (counted in the table itself).
 *
 * The approver side is guarded like adding people (board-members.ts inviteCtx: board access IN the query, 404 when
 * they cannot see the board, 403 when they may not add people, 409 archived / Inbox / read-only). The request row is
 * found by its id AND its board, so an id from another board is a 404. Approving goes through acceptSeat() (guest cap
 * under the workspace lock, never a demotion, never a role above member) and claims the row in the same transaction,
 * so two admins approving at once seat the person once. Names only: the requester's address never leaves the server.
 */

const NEW_REQUESTS_PER_HOUR = 10;
const DECLINE_QUIET_DAYS = 7;
const MAX_LIST = 50;
const MAX_APPROVERS_NOTIFIED = 20;

const roleBody = validator('json', (value, c) => {
  const role = objectOf(value)?.role ?? 'member';
  if (role !== 'member' && role !== 'viewer') return invalid(c, {role: {code: 'invalid', message: 'Choose member or viewer.'}});
  return {role: role as 'member' | 'viewer'};
});

const NO_REQUEST = problem('not_found', 'No such request.');

/** The people told about a new request: the workspace's owners and admins and the board's seated admins (bounded). */
async function approversOf(db: PrismaClient, boardId: number, workspaceId: number): Promise<number[]> {
  const rows = await db.$queryRaw<{user_id: number}[]>`
    SELECT m.user_id FROM workspace_members m
    WHERE m.workspace_id = ${workspaceId}
      AND (m.role IN ('owner', 'admin')
        OR (m.role = 'member' AND EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = ${boardId} AND bm.user_id = m.user_id AND bm.role = 'admin')))
    ORDER BY (m.role = 'member') DESC, m.user_id
    LIMIT ${MAX_APPROVERS_NOTIFIED}`;
  return rows.map(r => r.user_id);
}

export const boardAccessRequestRoutes = new Hono()
  .get('/boards/:id/access-request', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    if (!boardId) return c.json({status: 'none'});
    const [access, row] = await Promise.all([
      boardAccess(db, boardId, me),
      db.boardAccessRequest.findUnique({where: {boardId_userId: {boardId, userId: me}}, select: {status: true}}),
    ]);
    if (access) return c.json({status: 'member'});
    // A declined request still reads as pending: the requester is not told "no" (as other kanban tools do).
    return c.json({status: row && row.status !== 'approved' ? 'pending' : 'none'});
  })

  .post('/boards/:id/access-request', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    if (!boardId) return c.json({status: 'pending'}, 202);
    const since = new Date(Date.now() - 3600_000);
    const [access, recent, board] = await Promise.all([
      boardAccess(db, boardId, me),
      // Bounded on @@index([userId, requestedAt]).
      db.boardAccessRequest.findMany({where: {userId: me, requestedAt: {gt: since}}, select: {id: true}, take: NEW_REQUESTS_PER_HOUR}),
      db.board.findFirst({where: {id: boardId, archivedAt: null, inboxOf: null, workspace: {archivedAt: null}}, select: {workspaceId: true}}),
    ]);
    if (access) return c.json({status: 'member'});
    if (recent.length >= NEW_REQUESTS_PER_HOUR) {
      c.header('Retry-After', '3600');
      return c.json(problem('rate_limited', 'Too many access requests. Try again in an hour.'), 429);
    }
    // No such board (or one nobody can join): the same answer as a real one, and nothing stored.
    if (!board) return c.json({status: 'pending'}, 202);
    // ONE statement: a new request, or a closed one opened again (approved earlier but no access now, or declined
    // long enough ago). An open request, or one declined recently, is left as it is and nobody is notified.
    const quiet = new Date(Date.now() - DECLINE_QUIET_DAYS * 86_400_000);
    const opened = await db.$queryRaw<{id: number}[]>`
      INSERT INTO board_access_requests (board_id, workspace_id, user_id)
      VALUES (${boardId}, ${board.workspaceId}, ${me})
      ON CONFLICT (board_id, user_id) DO UPDATE
        SET status = 'pending', requested_at = now(), decided_at = NULL, decided_by = NULL, workspace_id = EXCLUDED.workspace_id
        WHERE board_access_requests.status = 'approved'
           OR (board_access_requests.status = 'declined' AND board_access_requests.decided_at < ${quiet})
      RETURNING id`;
    if (opened[0]) {
      const requestId = opened[0].id;
      await afterResponse(c, 'access request notify', async () => {
        const approvers = await approversOf(db, boardId, board.workspaceId);
        await Promise.all([
          notify(db, approvers, {workspaceId: board.workspaceId, kind: 'access_request', actorId: me, boardId}),
          audit(db, {actorUserId: me, action: 'board.access.requested', target: ['board', boardId], meta: {requestId}}),
        ]);
      });
    }
    return c.json({status: 'pending'}, 202);
  })

  .get('/boards/:id/access-requests', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await boardFor(db, me, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    if (!canInvite(ctx.access)) return c.json({items: [], canAnswer: false});
    const {workspaceId} = ctx.access;
    // ONE bounded query on @@index([boardId, status, id desc]): names only (never an address), and whether they would
    // join as a guest (not in this workspace).
    const rows = await db.$queryRaw<{id: number; userId: number; name: string; guest: boolean; requestedAt: Date}[]>`
      SELECT r.id, r.user_id AS "userId", u.name,
             NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${workspaceId} AND m.user_id = r.user_id) AS guest,
             r.requested_at AS "requestedAt"
      FROM board_access_requests r
      JOIN users u ON u.id = r.user_id AND u.status = 'active'
      WHERE r.board_id = ${ctx.boardId} AND r.status = 'pending'
      ORDER BY r.id DESC
      LIMIT ${MAX_LIST}`;
    return c.json({
      canAnswer: true,
      items: rows.map(r => ({id: r.id, userId: r.userId, name: r.name, guest: r.guest, requestedAt: r.requestedAt.toISOString()})),
    });
  })

  .post('/access-requests/:id/approve', roleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const id = idOf(c.req.param('id'));
    if (!id) return c.json(NO_REQUEST, 404);
    // Only an ACTIVE account can be seated (the list hides the others; a suspended account would still take a guest
    // seat). Requests have no Prisma relation to users, so the status is joined here.
    const [row] = await db.$queryRaw<{boardId: number; workspaceId: number; userId: number}[]>`
      SELECT r.board_id AS "boardId", r.workspace_id AS "workspaceId", r.user_id AS "userId"
      FROM board_access_requests r
      JOIN users u ON u.id = r.user_id AND u.status = 'active'
      WHERE r.id = ${id} AND r.status = 'pending'`;
    if (!row) return c.json(NO_REQUEST, 404);
    // The approver must be able to add people to THAT board right now (their access is in the query: 404 otherwise).
    const ctx = await inviteCtx(db, me, row.boardId);
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    if (row.workspaceId !== workspaceId) return c.json(NO_REQUEST, 404);
    const {role} = c.req.valid('json');
    let decidedAt: Date | null = null;
    const seat = await acceptSeat(
      db,
      // A board admin's approval is the deliberate act that lifts an earlier removal (as their re-add does); a member
      // who may add people cannot undo an admin's removal (madeAt null: acceptSeat refuses a removed person).
      {boardId: row.boardId, workspaceId, userId: row.userId, role, via: 'request', madeAt: ctx.access.canAdmin ? new Date() : null},
      async tx => {
        const claimed = await tx.$queryRaw<{decided_at: Date}[]>`
          UPDATE board_access_requests SET status = 'approved', decided_at = now(), decided_by = ${me}
          WHERE id = ${id} AND board_id = ${row.boardId} AND status = 'pending'
          RETURNING decided_at`;
        decidedAt = claimed[0]?.decided_at ?? null;
        return claimed.length > 0;
      }
    );
    if (!seat.ok) {
      if (seat.code === 'invalid_invite') {
        return ctx.access.canAdmin
          ? c.json(NO_REQUEST, 404)
          : c.json(problem('removed_by_admin', 'A board admin removed this person from the board. Only a board admin can add them back.'), 403);
      }
      return c.json(problem(seat.code, seat.message), seat.status);
    }
    // Another admin answered first (the claim found nothing): nothing more to do here.
    if (!decidedAt) return c.json(NO_REQUEST, 404);
    const at: Date = decidedAt;
    await afterResponse(c, 'access approved', async () => {
      await Promise.all([
        // In app for workspace members (notify() skips people outside the workspace); the email reaches everyone.
        notify(db, [row.userId], {workspaceId, kind: 'access_granted', actorId: me, boardId: row.boardId}),
        enqueueAccessApprovedEmail(c.req.url, id, at),
        audit(db, {actorUserId: me, action: 'board.access.approved', target: ['board', row.boardId], meta: {requestId: id, userId: row.userId, role: seat.role}}),
      ]);
    });
    return c.json({ok: true, alreadyMember: seat.alreadyMember, guest: seat.guest});
  })

  .post('/access-requests/:id/decline', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const id = idOf(c.req.param('id'));
    if (!id) return c.json(NO_REQUEST, 404);
    const row = await db.boardAccessRequest.findFirst({where: {id, status: 'pending'}, select: {boardId: true, workspaceId: true, userId: true}});
    if (!row) return c.json(NO_REQUEST, 404);
    // Declining needs no write rights on the board (an archived board or a read-only workspace may still say no).
    const ctx = await inviteCtx(db, me, row.boardId, true);
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    if (row.workspaceId !== ctx.access.workspaceId) return c.json(NO_REQUEST, 404);
    const n = await db.$executeRaw`
      UPDATE board_access_requests SET status = 'declined', decided_at = now(), decided_by = ${me}
      WHERE id = ${id} AND board_id = ${row.boardId} AND status = 'pending'`;
    if (n === 0) return c.json(NO_REQUEST, 404);
    await audit(db, {actorUserId: me, action: 'board.access.declined', target: ['board', row.boardId], meta: {requestId: id, userId: row.userId}});
    return c.json({ok: true});
  });
