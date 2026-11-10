import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {audit, normalizeEmail} from '../../platform/auth';
import {config} from '../../platform/config';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {bgImageUrl} from '../bg-image';
import {canInvite, guestCapReached, seatRoleFor} from '../board-seats';
import {getEntitlements} from '../entitlements';
import {enqueueInviteEmails, sealInviteItem} from '../jobs/invite-email';
import {mailConfigured} from '../mail/send';
import {inviteLink, renderInviteEmail} from '../mail/templates';
import {notify} from '../notifications';
import {softHit, softLimited} from '../soft-limit';
import {idOf, invalid, likeEscape, objectOf} from '../validation';
import {guestRole, isWorkspaceRole, notFound, resolveBoardRole, type BoardAccess, type BoardRole} from '../workspaces';
import {boardFor, bumpRev, noStore, refused} from './boards';
import {createdRecently, emailLimited, inviteEmailHash, newToken} from './members';
import {sha256Hex} from '../../platform/auth/encoding';

/**
 * Who is on a board ("Share" in the board header), like the board members of other kanban tools.
 * Mounted ONCE at `/` in `app.ts`.
 *
 *   GET    /boards/:id/members                    {members, admins, me, can…, settings}   anyone who can see the board
 *   GET    /boards/:id/members/candidates?q=      workspace people without a seat           those who may add people
 *   PUT    /boards/:id/members/:userId  {role}    add a workspace member / change a role    add: who may add people; change: board admins
 *   DELETE /boards/:id/members/:userId            remove a seat                            board admins; anyone for their OWN seat (leave)
 *   POST   /boards/:id/join                       a workspace member takes a seat themselves (when the board allows it)
 *   PATCH  /boards/:id/sharing   {memberInvites?, selfJoin?}                                board admins
 *   GET    /boards/:id/invites                    pending email invites (no address: only a hash is kept)
 *   POST   /boards/:id/invites   {email, role}    a workspace member gets a seat at once; anyone else an emailed invite (a guest)
 *   DELETE /boards/:id/invites/:inviteId          revoke a pending email invite
 *   GET    /boards/:id/invite-link                {active, role}
 *   POST   /boards/:id/invite-link  {role}        create or replace the link: {url} ONCE (only its SHA-256 is kept)
 *   DELETE /boards/:id/invite-link                remove the link
 *   GET    /guest-boards                          the boards I am a guest on (seats in workspaces I am not a member of)
 *
 * The rules (resolveBoardRole, boardAccess in workspaces.ts; board-seats.ts): a seat makes a PRIVATE board visible and,
 * on any board, sets the person's role there. A GUEST is a person with a seat but no workspace membership: they see only
 * the boards they are seated on, at most as a member. Workspace owners and admins already admin every board (no seat).
 * "Who may add people" is the board's `member_invites`: board admins, or also its non-guest members (who then add as
 * member or viewer only, and never change or remove anyone else).
 *
 * Guards: validator, withViewer, requireAuth, withDb, then boardFor(): the visitor's workspace membership or seat is IN
 * its query (another workspace's board, or a private board without a seat, is a 404); 403 when they may see it but not
 * do this; writes refuse an archived board, an Inbox and a read-only workspace (409). No site permission: like the
 * workspace members routes, this is the workspace's own collaboration, decided by roles inside it. A person added
 * directly must be an ACTIVE member of THE SAME workspace, checked in the write's own statement. Names only: an email
 * never leaves here (an invite keeps only a keyed hash of the address).
 *
 * Losing access to a board (a guest removed or leaving any board; anyone losing a seat on a private board) removes the
 * person's traces there in ONE statement, in the transaction that also bumps the board's rev.
 */

const ROLES = ['admin', 'member', 'viewer'] as const;
const MAX_LIST = 200;
const MAX_CANDIDATES = 20;
const MAX_PENDING = 50;
const INVITE_DAYS = 14;
const LINK_OPS_PER_HOUR = 20;

const roleOf = (value: unknown): BoardRole | null =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value) ? (value as BoardRole) : null;

const roleBody = validator('json', (value, c) => {
  const role = roleOf(objectOf(value)?.role);
  if (!role) return invalid(c, {role: {code: 'invalid', message: 'Choose admin, member or viewer.'}});
  return {role};
});

const inviteBody = validator('json', (value, c) => {
  const body = objectOf(value) ?? {};
  const errors: Record<string, {code: string; message: string}> = {};
  const email = normalizeEmail(body.email);
  if (!email) errors.email = {code: 'invalid', message: 'Enter a valid email address.'};
  const role = roleOf(body.role ?? 'member');
  if (!role) errors.role = {code: 'invalid', message: 'Choose admin, member or viewer.'};
  if (Object.keys(errors).length) return invalid(c, errors);
  return {email: email!, role: role!};
});

const linkBody = validator('json', (value, c) => {
  const role = objectOf(value)?.role ?? 'member';
  if (role !== 'member' && role !== 'viewer') return invalid(c, {role: {code: 'invalid', message: 'Choose member or viewer.'}});
  return {role: role as 'member' | 'viewer'};
});

const sharingBody = validator('json', (value, c) => {
  const body = objectOf(value) ?? {};
  const out: {memberInvites?: 'admins' | 'members'; selfJoin?: boolean} = {};
  if (body.memberInvites !== undefined) {
    if (body.memberInvites !== 'admins' && body.memberInvites !== 'members') {
      return invalid(c, {memberInvites: {code: 'invalid', message: 'Choose admins or members.'}});
    }
    out.memberInvites = body.memberInvites;
  }
  if (body.selfJoin !== undefined) {
    if (typeof body.selfJoin !== 'boolean') return invalid(c, {selfJoin: {code: 'invalid', message: 'Choose on or off.'}});
    out.selfJoin = body.selfJoin;
  }
  if (!Object.keys(out).length) return invalid(c, {input: {code: 'invalid', message: 'Nothing to change.'}});
  return out;
});

const candidatesQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 80) : '',
}));

const asSeat = (role: string | null): BoardRole | null => (role === 'admin' || role === 'member' || role === 'viewer' ? role : null);

type Refusal = {status: 403 | 404 | 409; body: ReturnType<typeof problem>};
const refuse = (status: Refusal['status'], code: string, message: string): Refusal => ({status, body: problem(code, message)});
const isRefusal = (r: unknown): r is Refusal => typeof r === 'object' && r !== null && 'status' in r && 'body' in r;
const FORBIDDEN = () => refuse(403, 'forbidden', 'You do not have access to this.');

/** The board, when the visitor may add people to it right now (404 / 403 / 409 otherwise). */
async function inviteCtx(db: PrismaClient, userId: number, boardId: number | undefined): Promise<Refusal | {boardId: number; access: BoardAccess}> {
  const ctx = await boardFor(db, userId, boardId, 'read');
  if (refused(ctx)) return ctx as Refusal;
  if (ctx.access.archived) return refuse(409, 'board_archived', 'This board is archived.');
  if (ctx.access.inbox) return refuse(409, 'inbox_board', 'A personal Inbox cannot be shared.');
  if (!canInvite(ctx.access)) return FORBIDDEN();
  const ent = await getEntitlements(db, ctx.access.workspaceId);
  if (ent?.readOnly) return refuse(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
  return ctx;
}

/** The person's workspace role (null = not a member) and seat on the board, in one read. */
async function personOn(db: PrismaClient, boardId: number, workspaceId: number, userId: number) {
  const [row] = await db.$queryRaw<{wsRole: string | null; seat: string | null; active: boolean | null}[]>`
    SELECT (SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}) AS "wsRole",
           (SELECT role FROM board_members WHERE board_id = ${boardId} AND user_id = ${userId}) AS seat,
           (SELECT status = 'active' FROM users WHERE id = ${userId}) AS active`;
  return row ?? {wsRole: null, seat: null, active: null};
}

const linkUrl = (requestUrl: string, token: string) => inviteLink(config.siteUrl ?? new URL(requestUrl).origin, token);

export const boardMemberRoutes = new Hono()
  .get('/boards/:id/members', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await boardFor(db, me, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    // ONE query, bounded: the seated people (workspace members AND guests) and the workspace owners/admins.
    const rows = await db.$queryRaw<{id: number; name: string; wsRole: string | null; seat: string | null; visibility: string; inboxOf: number | null}[]>`
      WITH people AS (
        SELECT user_id FROM board_members WHERE board_id = ${ctx.boardId}
        UNION
        SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId} AND role IN ('owner', 'admin'))
      SELECT u.id, u.name, m.role AS "wsRole", bm.role AS seat, b.visibility, b.inbox_of AS "inboxOf"
      FROM people p
      JOIN users u ON u.id = p.user_id AND u.status = 'active'
      JOIN boards b ON b.id = ${ctx.boardId} AND b.workspace_id = ${workspaceId}
      LEFT JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = p.user_id
      LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = p.user_id
      WHERE b.inbox_of IS NULL OR b.inbox_of = p.user_id
      ORDER BY u.name, u.id
      LIMIT ${MAX_LIST + 1}`;
    const members: {id: number; name: string; role: BoardRole; seat: BoardRole; guest: boolean; workspaceRole: string | null}[] = [];
    const admins: {id: number; name: string; workspaceRole: string}[] = [];
    for (const r of rows.slice(0, MAX_LIST)) {
      const seat = asSeat(r.seat);
      if (r.wsRole === null) {
        if (seat && r.inboxOf === null) members.push({id: r.id, name: r.name, role: guestRole(seat), seat, guest: true, workspaceRole: null});
        continue;
      }
      if (!isWorkspaceRole(r.wsRole)) continue;
      if (r.wsRole === 'owner' || r.wsRole === 'admin' || r.inboxOf !== null) {
        admins.push({id: r.id, name: r.name, workspaceRole: r.wsRole});
      } else if (seat) {
        const role = resolveBoardRole(r.wsRole, r.visibility, seat);
        if (role) members.push({id: r.id, name: r.name, role, seat, guest: false, workspaceRole: r.wsRole});
      }
    }
    const a = ctx.access;
    const live = !a.archived && !a.inbox;
    return c.json({
      members,
      admins,
      more: rows.length > MAX_LIST,
      me: {seated: a.seated, guest: a.guest},
      canManage: a.canAdmin && live,
      canInvite: canInvite(a),
      // A workspace member (not owner/admin) without a seat on a board they see may join it when the board allows it.
      canJoin: live && a.selfJoin && !a.seated && !a.guest && (a.workspaceRole === 'member' || a.workspaceRole === 'viewer'),
      memberInvites: a.memberInvites,
      selfJoin: a.selfJoin,
    });
  })

  .get('/boards/:id/members/candidates', candidatesQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await inviteCtx(db, c.var.viewer.id!, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const {q} = c.req.valid('query');
    const like = `%${likeEscape(q)}%`;
    // Workspace members and viewers with no seat yet (owners/admins already see every board). Names only, bounded.
    const items = await db.$queryRaw<{id: number; name: string; workspaceRole: string}[]>`
      SELECT u.id, u.name, m.role AS "workspaceRole"
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${ctx.access.workspaceId} AND m.role IN ('member', 'viewer') AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = ${ctx.boardId} AND bm.user_id = m.user_id)
        AND (${q}::text = '' OR u.name ILIKE ${like})
      ORDER BY u.name, u.id
      LIMIT ${MAX_CANDIDATES}`;
    return c.json({items});
  })

  .put('/boards/:id/members/:userId', roleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const targetId = idOf(c.req.param('userId'));
    if (!targetId) return notFound(c, 'member');
    const {role} = c.req.valid('json');
    const {workspaceId} = ctx.access;
    const admin = ctx.access.canAdmin;
    // A member who may add people adds as member or viewer only, and never changes an existing seat.
    if (!admin && role === 'admin') return c.json(FORBIDDEN().body, 403);

    // ONE statement decides and writes: the person must be an active member or viewer of THIS workspace (a viewer only
    // as a board viewer) and the board a shared board of it. A concurrent role change or removal writes nothing.
    const written = await db.$queryRaw<{inserted: boolean; before: string | null}[]>`
      WITH old AS (SELECT role FROM board_members WHERE board_id = ${ctx.boardId} AND user_id = ${targetId})
      INSERT INTO board_members (board_id, user_id, workspace_id, role)
      SELECT b.id, m.user_id, b.workspace_id, ${role}::varchar
      FROM boards b
      JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = ${targetId}
      JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE b.id = ${ctx.boardId} AND b.workspace_id = ${workspaceId} AND b.inbox_of IS NULL
        AND (m.role = 'member' OR (m.role = 'viewer' AND ${role}::text = 'viewer'))
      ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE ${admin}::boolean
      RETURNING (xmax = 0) AS inserted, (SELECT role FROM old) AS before`;

    if (!written[0]) {
      // Why nothing was written (the refusal path only).
      const p = await personOn(db, ctx.boardId, workspaceId, targetId);
      if (!p.active) return notFound(c, 'member');
      if (p.wsRole === null) {
        // A guest's role can be changed by a board admin (never to admin); guests are added only by invite.
        if (!p.seat) return notFound(c, 'member');
        if (!admin) return c.json({userId: targetId, role: asSeat(p.seat), added: false});
        if (role === 'admin') return invalid(c, {role: {code: 'guest_no_admin', message: 'A guest cannot be a board admin.'}});
        const done = await db.boardMember.updateMany({where: {boardId: ctx.boardId, userId: targetId, workspaceId}, data: {role}});
        if (done.count === 0) return notFound(c, 'member');
        await audit(db, {actorUserId: me, action: 'board.member.role_changed', target: ['board', ctx.boardId], meta: {userId: targetId, from: p.seat, to: role, guest: true}});
        return c.json({userId: targetId, role, added: false});
      }
      if (p.seat && !admin) return c.json({userId: targetId, role: asSeat(p.seat), added: false});
      if (p.wsRole === 'owner' || p.wsRole === 'admin') {
        return c.json(problem('workspace_admin', 'Workspace owners and admins already manage every board.'), 409);
      }
      if (p.wsRole === 'viewer') {
        return invalid(c, {role: {code: 'viewer_only', message: 'A workspace viewer can only be a viewer on a board.'}});
      }
      return notFound(c, 'member');
    }
    const {inserted, before} = written[0];
    if (inserted) {
      await Promise.all([
        notify(db, [targetId], {workspaceId, kind: 'board_member', actorId: me, boardId: ctx.boardId}),
        db.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: me, kind: 'board.member_added', meta: {userId: targetId, role}}}),
        audit(db, {actorUserId: me, action: 'board.member.added', target: ['board', ctx.boardId], meta: {userId: targetId, role}}),
      ]);
    } else if (before !== role) {
      await audit(db, {actorUserId: me, action: 'board.member.role_changed', target: ['board', ctx.boardId], meta: {userId: targetId, from: before, to: role}});
    }
    return c.json({userId: targetId, role, added: inserted});
  })

  .delete('/boards/:id/members/:userId', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const targetId = idOf(c.req.param('userId'));
    const self = targetId === me;
    // Leaving needs only to see the board (an archived one too); removing someone else needs board admin.
    const ctx = await boardFor(db, me, idOf(c.req.param('id')), self ? 'read' : 'admin', true);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    if (!targetId) return notFound(c, 'member');
    const {workspaceId} = ctx.access;
    const boardId = ctx.boardId;

    const out = await db.$transaction(async tx => {
      const gone = await tx.boardMember.deleteMany({where: {boardId, userId: targetId, workspaceId}});
      if (gone.count === 0) return null;
      // The board row is locked here (bumpRev), so the visibility read below is the one that stands until commit.
      await bumpRev(tx, boardId, workspaceId);
      const [row] = await tx.$queryRaw<{visibility: string; wsRole: string | null}[]>`
        SELECT b.visibility, (SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${targetId}) AS "wsRole"
        FROM boards b WHERE b.id = ${boardId} AND b.workspace_id = ${workspaceId}`;
      // A guest loses the board whatever its visibility; a member only a private one (owners/admins never).
      const lostAccess = !!row && (row.wsRole === null || (row.visibility === 'private' && row.wsRole !== 'owner' && row.wsRole !== 'admin'));
      if (lostAccess) await dropBoardTraces(tx, boardId, workspaceId, targetId);
      await tx.activity.create({
        data: {workspaceId, boardId, actorId: me, kind: self ? 'board.member_left' : 'board.member_removed', meta: {userId: targetId}},
      });
      return {lostAccess};
    });
    if (!out) return notFound(c, 'member');
    await audit(db, {actorUserId: me, action: self ? 'board.member.left' : 'board.member.removed', target: ['board', boardId], meta: {userId: targetId}});
    return c.json({ok: true, lostAccess: out.lostAccess});
  })

  .post('/boards/:id/join', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await boardFor(db, me, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const a = ctx.access;
    if (a.seated) return c.json({ok: true, joined: false, role: a.boardRole});
    if (a.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    if (a.inbox) return c.json(problem('inbox_board', 'A personal Inbox cannot be shared.'), 409);
    if (a.workspaceRole === 'owner' || a.workspaceRole === 'admin') {
      return c.json(problem('workspace_admin', 'Workspace owners and admins already manage every board.'), 409);
    }
    if (a.guest || !a.selfJoin) return c.json(problem('join_disabled', 'Ask a board admin to add you.'), 403);
    const role: BoardRole = a.workspaceRole === 'viewer' ? 'viewer' : 'member';
    // The board must still allow it and the visitor still be a member/viewer: both inside the write.
    const n = await db.$executeRaw`
      INSERT INTO board_members (board_id, user_id, workspace_id, role)
      SELECT b.id, m.user_id, b.workspace_id, ${role}::varchar
      FROM boards b JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = ${me} AND m.role IN ('member', 'viewer')
      WHERE b.id = ${ctx.boardId} AND b.workspace_id = ${a.workspaceId} AND b.self_join AND b.visibility <> 'private'
        AND b.archived_at IS NULL AND b.inbox_of IS NULL
      ON CONFLICT (board_id, user_id) DO NOTHING`;
    if (n > 0) {
      await Promise.all([
        db.activity.create({data: {workspaceId: a.workspaceId, boardId: ctx.boardId, actorId: me, kind: 'board.member_joined', meta: {via: 'join', role}}}),
        audit(db, {actorUserId: me, action: 'board.member.joined', target: ['board', ctx.boardId], meta: {via: 'join', role}}),
      ]);
    }
    return c.json({ok: true, joined: n > 0, role});
  })

  .patch('/boards/:id/sharing', sharingBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await boardFor(db, me, idOf(c.req.param('id')), 'admin');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    if (ctx.access.inbox) return c.json(problem('inbox_board', 'A personal Inbox cannot be shared.'), 409);
    const data = c.req.valid('json');
    await db.board.updateMany({where: {id: ctx.boardId, workspaceId: ctx.access.workspaceId}, data});
    await audit(db, {actorUserId: me, action: 'board.sharing.updated', target: ['board', ctx.boardId], meta: data});
    return c.json({
      memberInvites: data.memberInvites ?? ctx.access.memberInvites,
      selfJoin: data.selfJoin ?? ctx.access.selfJoin,
    });
  })

  // ---- email invites ----------------------------------------------------------------------------
  .get('/boards/:id/invites', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const rows = await db.workspaceInvite.findMany({
      where: {workspaceId: ctx.access.workspaceId, boardId: ctx.boardId, usedAt: null, expiresAt: {gt: new Date()}},
      orderBy: {id: 'desc'},
      take: MAX_PENDING,
      select: {id: true, boardRole: true, expiresAt: true, emailStatus: true, createdBy: true},
    });
    return c.json({
      items: rows.map(r => ({
        id: r.id,
        role: asSeat(r.boardRole) ?? 'member',
        expiresAt: r.expiresAt,
        emailStatus: r.emailStatus,
        // A board admin revokes any; a member who invited, their own.
        canRevoke: ctx.access.canAdmin || r.createdBy === me,
      })),
    });
  })

  .post('/boards/:id/invites', inviteBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const {email, role} = c.req.valid('json');
    const {workspaceId} = ctx.access;
    if (!ctx.access.canAdmin && role === 'admin') return c.json(FORBIDDEN().body, 403);

    // Someone of this workspace already: seated at once (their workspace role still caps the seat), no email.
    // ONE read: the address's active account, its role in this workspace and its seat on the board.
    const [user] = await db.$queryRaw<{id: number; wsRole: string | null; seat: string | null}[]>`
      SELECT u.id,
             (SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = u.id) AS "wsRole",
             (SELECT role FROM board_members WHERE board_id = ${ctx.boardId} AND user_id = u.id) AS seat
      FROM users u WHERE u.email = ${email} AND u.status = 'active'`;
    if (user) {
      const p = user;
      if (p.wsRole !== null) {
        const seatRole = seatRoleFor(p.wsRole, role);
        if (seatRole === null || p.seat !== null) return c.json({result: 'already'});
        const n = await db.$executeRaw`
          INSERT INTO board_members (board_id, user_id, workspace_id, role)
          SELECT ${ctx.boardId}, m.user_id, m.workspace_id, ${seatRole}::varchar FROM workspace_members m
          WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${user.id} AND m.role IN ('member', 'viewer')
          ON CONFLICT (board_id, user_id) DO NOTHING`;
        if (n > 0) {
          await Promise.all([
            notify(db, [user.id], {workspaceId, kind: 'board_member', actorId: me, boardId: ctx.boardId}),
            db.activity.create({data: {workspaceId, boardId: ctx.boardId, actorId: me, kind: 'board.member_added', meta: {userId: user.id, role: seatRole}}}),
            audit(db, {actorUserId: me, action: 'board.member.added', target: ['board', ctx.boardId], meta: {userId: user.id, role: seatRole}}),
          ]);
        }
        return c.json({result: n > 0 ? 'added' : 'already'});
      }
    }

    // Anyone else becomes a GUEST when they accept: an emailed invite bound to this address (only its keyed hash is kept).
    // Independent checks, in parallel.
    const [capped, recent, mailed] = await Promise.all([guestCapReached(db, workspaceId), createdRecently(db, workspaceId), emailLimited(db, workspaceId, me)]);
    if (capped) {
      return c.json(problem('guest_limit_reached', 'This workspace has reached its guest limit. Ask an admin to upgrade the plan.'), 409);
    }
    if (recent) return c.json(problem('rate_limited', 'Too many invites. Try again in an hour.'), 429);
    if (mailed) {
      return c.json(problem('rate_limited', 'Too many invite emails. Try again in an hour, or share the link yourself.'), 429);
    }
    const token = newToken('iv');
    const configured = mailConfigured();
    const boardRole = guestRole(role);
    const row = await db.workspaceInvite.create({
      data: {
        workspaceId,
        boardId: ctx.boardId,
        role: 'guest',
        boardRole,
        tokenHash: await sha256Hex(token),
        emailHash: await inviteEmailHash(email),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        createdBy: me,
        emailStatus: 'queued',
        emailQueuedAt: new Date(),
      },
      select: {id: true, expiresAt: true},
    });
    await audit(db, {actorUserId: me, action: 'board.invite.created', target: ['board', ctx.boardId], meta: {inviteId: row.id, role: boardRole}});
    let emailStatus = configured ? 'queued' : 'not_configured';
    const item = await sealInviteItem(me, row.id, email, token);
    const queued = item !== null && (await enqueueInviteEmails(c.req.url, workspaceId, me, [item], `invite-email-${row.id}-0`));
    if (!queued) {
      emailStatus = 'failed';
      await db.workspaceInvite.updateMany({where: {id: row.id, workspaceId}, data: {emailStatus: 'failed'}});
    }
    // `?b=1` only tells the join page to speak of a board; the token alone decides what the link does.
    const link = `${linkUrl(c.req.url, token)}?b=1`;
    // Local test mode (email not set up, or the editor Preview): the inviter sees what would be sent. Never stored or logged.
    let emailPreview: {subject: string; text: string; configured: boolean} | null = null;
    if (!configured || config.preview) {
      const [board, ws] = await Promise.all([
        db.board.findFirst({where: {id: ctx.boardId, workspaceId}, select: {name: true}}),
        db.workspace.findUnique({where: {id: workspaceId}, select: {name: true, defaultLocale: true}}),
      ]);
      const mail = renderInviteEmail({
        locale: ws?.defaultLocale,
        inviterName: c.var.viewer.name ?? '',
        workspaceName: ws?.name ?? '',
        boardName: board?.name ?? '',
        role: boardRole,
        expiresAt: row.expiresAt,
        link,
      });
      emailPreview = {subject: mail.subject, text: mail.text, configured};
    }
    return c.json({result: 'invited', inviteId: row.id, emailStatus, link, ...(emailPreview ? {emailPreview} : {})}, 201);
  })

  .delete('/boards/:id/invites/:inviteId', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const inviteId = idOf(c.req.param('inviteId'));
    if (!inviteId) return notFound(c, 'invite');
    const done = await db.workspaceInvite.deleteMany({
      where: {id: inviteId, workspaceId: ctx.access.workspaceId, boardId: ctx.boardId, usedAt: null, ...(ctx.access.canAdmin ? {} : {createdBy: me})},
    });
    if (done.count === 0) return notFound(c, 'invite');
    await audit(db, {actorUserId: me, action: 'board.invite.revoked', target: ['board', ctx.boardId], meta: {inviteId}});
    return c.json({revoked: true});
  })

  // ---- invite link ------------------------------------------------------------------------------
  .get('/boards/:id/invite-link', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await inviteCtx(db, c.var.viewer.id!, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    const row = await db.board.findFirst({
      where: {id: ctx.boardId, workspaceId: ctx.access.workspaceId},
      select: {inviteLinkHash: true, inviteLinkRole: true},
    });
    return c.json({active: !!row?.inviteLinkHash, role: row?.inviteLinkHash ? row.inviteLinkRole : null});
  })

  .post('/boards/:id/invite-link', linkBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    if (await softLimited(me, 'board-link', LINK_OPS_PER_HOUR, 3600)) {
      return c.json(problem('rate_limited', 'Too many link changes. Try again in an hour.'), 429);
    }
    await softHit(me, 'board-link', 3600);
    const {role} = c.req.valid('json');
    const token = newToken('bl');
    // A board admin replaces any link; a member (when members may add people) only one they made, or a new one.
    const mine = ctx.access.canAdmin ? {} : {OR: [{inviteLinkHash: null}, {inviteLinkBy: me}]};
    const n = await db.board.updateMany({
      where: {id: ctx.boardId, workspaceId: ctx.access.workspaceId, archivedAt: null, inboxOf: null, ...mine},
      data: {inviteLinkHash: await sha256Hex(token), inviteLinkRole: role, inviteLinkBy: me},
    });
    if (n.count === 0) return c.json(FORBIDDEN().body, 403);
    await audit(db, {actorUserId: me, action: 'board.invite_link.created', target: ['board', ctx.boardId], meta: {role}});
    return c.json({url: linkUrl(c.req.url, token), role}, 201);
  })

  .delete('/boards/:id/invite-link', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const ctx = await inviteCtx(db, me, idOf(c.req.param('id')));
    if (isRefusal(ctx)) return c.json(ctx.body, ctx.status);
    // A board admin removes any link; a member only one they made.
    const n = await db.board.updateMany({
      where: {id: ctx.boardId, workspaceId: ctx.access.workspaceId, ...(ctx.access.canAdmin ? {} : {inviteLinkBy: me})},
      data: {inviteLinkHash: null, inviteLinkRole: null, inviteLinkBy: null},
    });
    if (n.count === 0) return c.json(FORBIDDEN().body, 403);
    await audit(db, {actorUserId: me, action: 'board.invite_link.removed', target: ['board', ctx.boardId]});
    return c.json({ok: true});
  })

  // ---- the boards I am a guest on --------------------------------------------------------------
  .get('/guest-boards', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    // Seats in workspaces I am NOT a member of (index board_members(user_id, workspace_id)); bounded.
    const rows = await c.var.db.$queryRaw<{
      id: number; name: string; visibility: string; bg_kind: string; bg_color_1: string; bg_color_2: string; bg_angle: number;
      bg_pattern: string; bg_file_id: string | null; workspace_name: string; starred: boolean;
    }[]>`
      SELECT b.id, b.name, b.visibility, b.bg_kind, b.bg_color_1, b.bg_color_2, b.bg_angle, b.bg_pattern, b.bg_file_id,
             w.name AS workspace_name,
             EXISTS (SELECT 1 FROM board_stars s WHERE s.user_id = ${me} AND s.board_id = b.id) AS starred
      FROM board_members bm
      JOIN boards b ON b.id = bm.board_id AND b.workspace_id = bm.workspace_id AND b.archived_at IS NULL AND b.inbox_of IS NULL
      JOIN workspaces w ON w.id = b.workspace_id AND w.archived_at IS NULL
      WHERE bm.user_id = ${me}
        AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = bm.workspace_id AND m.user_id = ${me})
      ORDER BY w.name, b.name, b.id
      LIMIT 100`;
    return c.json({
      items: rows.map(b => ({
        id: b.id,
        name: b.name,
        visibility: b.visibility,
        bgKind: b.bg_kind,
        bgColor1: b.bg_color_1,
        bgColor2: b.bg_color_2,
        bgAngle: b.bg_angle,
        bgPattern: b.bg_pattern,
        bgImage: bgImageUrl(b.id, b.bg_file_id),
        starred: b.starred,
        workspaceName: b.workspace_name,
      })),
    });
  });

/**
 * The person can no longer open this board: take them off its cards, checklist items, followed cards, notifications
 * and the board chat's read state. ONE statement (data-modifying CTEs), each part limited to this board's rows of ONE
 * person through an index on user_id / assignee_id; every value bound.
 */
async function dropBoardTraces(tx: Prisma.TransactionClient, boardId: number, workspaceId: number, userId: number) {
  await tx.$executeRaw`
    WITH board_cards AS (SELECT id FROM cards WHERE board_id = ${boardId} AND workspace_id = ${workspaceId}),
    assigned AS (
      DELETE FROM card_members cm WHERE cm.user_id = ${userId} AND cm.workspace_id = ${workspaceId}
        AND cm.card_id IN (SELECT id FROM board_cards)),
    followed AS (
      DELETE FROM card_watchers w WHERE w.user_id = ${userId} AND w.card_id IN (SELECT id FROM board_cards)),
    items AS (
      UPDATE checklist_items ci SET assignee_id = NULL
      FROM checklists cl
      WHERE ci.assignee_id = ${userId} AND ci.workspace_id = ${workspaceId} AND ci.checklist_id = cl.id
        AND cl.card_id IN (SELECT id FROM board_cards)),
    board_chat AS (SELECT id FROM conversations WHERE board_id = ${boardId} AND workspace_id = ${workspaceId}),
    notes AS (
      DELETE FROM notifications n WHERE n.user_id = ${userId} AND n.workspace_id = ${workspaceId}
        AND (n.board_id = ${boardId} OR n.conversation_id IN (SELECT id FROM board_chat))),
    chat AS (
      DELETE FROM conversation_members m WHERE m.user_id = ${userId} AND m.workspace_id = ${workspaceId}
        AND m.conversation_id IN (SELECT id FROM board_chat))
    SELECT 1`;
}
