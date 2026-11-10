import type {PrismaClient} from '../generated/prisma/client';
import {audit} from '../platform/auth';
import {getEntitlements} from './entitlements';
import {boardAccess, guestRole, type BoardAccess, type BoardRole} from './workspaces';

/**
 * Seats on a board, shared by the "Share" routes (board-members.ts) and the invite accept route (members.ts).
 *
 * A seat (board_members row) is either a workspace member's role on that board, or a GUEST's only way in: a person
 * who is not a workspace member and sees just the boards they hold a seat on (workspaces.ts boardAccess). Guests are
 * never board admins, are not counted as workspace members, and are capped per workspace at the plan's member limit.
 */

/** Who may add people to the board: board admins, or (when the board allows it) its non-guest members. */
export const canInvite = (access: Pick<BoardAccess, 'canAdmin' | 'boardRole' | 'guest' | 'memberInvites' | 'archived' | 'inbox'>) =>
  !access.archived && !access.inbox && (access.canAdmin || (access.memberInvites === 'members' && access.boardRole === 'member' && !access.guest));

/**
 * The seat a person gets for an asked role, from their workspace role (null = not a member: a guest).
 * Owners and admins need no seat (null); a workspace viewer is only ever a viewer; a guest is at most a member.
 */
export function seatRoleFor(wsRole: string | null, asked: BoardRole): BoardRole | null {
  if (wsRole === 'owner' || wsRole === 'admin') return null;
  if (wsRole === 'viewer') return 'viewer';
  if (wsRole === null) return guestRole(asked);
  return asked;
}

/** True when the workspace already has as many guests as its plan allows members (one bounded query). */
export async function guestCapReached(db: PrismaClient, workspaceId: number): Promise<boolean> {
  const ent = await getEntitlements(db, workspaceId);
  if (!ent) return true;
  const cap = ent.limits.maxMembers;
  const [row] = await db.$queryRaw<{n: number}[]>`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT bm.user_id FROM board_members bm
      WHERE bm.workspace_id = ${workspaceId}
        AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = bm.workspace_id AND m.user_id = bm.user_id)
      LIMIT ${cap + 1}) g`;
  return (row?.n ?? 0) >= cap;
}

export type SeatResult =
  | {ok: true; boardId: number; workspaceId: number; alreadyMember: boolean; guest: boolean; role: BoardRole | null}
  | {ok: false; status: 404 | 409; code: string; message: string};

const INVALID = {ok: false as const, status: 404 as const, code: 'invalid_invite', message: 'This invite link is not valid any more.'};

/**
 * Seats `userId` on `boardId` from an accepted invite or link. `consume` marks the invite used (or checks the link)
 * inside the same transaction and returns false when it is no longer usable. Never changes an existing seat's role.
 * Round trips: board + role read (1), guest cap when a guest (1-2), the transaction.
 */
export async function acceptSeat(
  db: PrismaClient,
  input: {
    boardId: number;
    workspaceId: number;
    userId: number;
    role: BoardRole;
    via: 'invite' | 'link';
    /** When the invite was made; null for a link (its age is not kept). */
    madeAt: Date | null;
  },
  consume: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<boolean>,
): Promise<SeatResult> {
  const {boardId, workspaceId, userId} = input;
  // The board must be a live shared board of a live workspace; the person's workspace role and seat in the same read.
  const [row] = await db.$queryRaw<{wsRole: string | null; seat: string | null; removedAt: Date | null}[]>`
    SELECT (SELECT role FROM workspace_members WHERE workspace_id = b.workspace_id AND user_id = ${userId}) AS "wsRole",
           (SELECT role FROM board_members WHERE board_id = b.id AND user_id = ${userId}) AS seat,
           (SELECT removed_at FROM workspace_removals WHERE workspace_id = b.workspace_id AND user_id = ${userId}) AS "removedAt"
    FROM boards b JOIN workspaces w ON w.id = b.workspace_id AND w.archived_at IS NULL
    WHERE b.id = ${boardId} AND b.workspace_id = ${workspaceId} AND b.archived_at IS NULL AND b.inbox_of IS NULL`;
  if (!row) return INVALID;
  const done = (alreadyMember: boolean, role: BoardRole | null): SeatResult => ({ok: true, boardId, workspaceId, alreadyMember, guest: row.wsRole === null, role});
  const role = seatRoleFor(row.wsRole, input.role);
  // Already in (a workspace owner/admin, or a seat): nothing changes, nobody is promoted or demoted by a link.
  if (role === null || row.seat !== null) {
    await db.$transaction(async tx => void (await consume(tx)));
    return done(true, (row.seat as BoardRole | null) ?? null);
  }
  if (row.wsRole === null) {
    // Removed from (or left) this workspace: an older invite, or any link, cannot bring them back as a guest. Only an
    // email invite made AFTER the removal (a deliberate re-invite) works, as for workspace links and invites.
    if (row.removedAt && (input.madeAt === null || row.removedAt > input.madeAt)) return INVALID;
    const ent = await getEntitlements(db, workspaceId);
    if (!ent) return INVALID;
    if (ent.readOnly) return {ok: false, status: 409, code: 'workspace_read_only', message: 'This workspace is read-only until its plan limits are fixed.'};
    if (await guestCapReached(db, workspaceId)) {
      return {ok: false, status: 409, code: 'guest_limit_reached', message: 'This workspace has reached its guest limit. Ask an admin to upgrade the plan.'};
    }
  }
  const added = await db.$transaction(async tx => {
    if (!(await consume(tx))) return null;
    const n = await tx.$executeRaw`
      INSERT INTO board_members (board_id, user_id, workspace_id, role) VALUES (${boardId}, ${userId}, ${workspaceId}, ${role}::varchar)
      ON CONFLICT (board_id, user_id) DO NOTHING`;
    if (n > 0) {
      await tx.activity.create({data: {workspaceId, boardId, actorId: userId, kind: 'board.member_joined', meta: {via: input.via, role}}});
    }
    return n > 0;
  });
  if (added === null) return INVALID;
  if (added) {
    await audit(db, {actorUserId: userId, action: 'board.member.joined', target: ['board', boardId], meta: {via: input.via, role, guest: row.wsRole === null}});
  }
  return done(!added, role);
}

/** The invite link of a board, only while it may still be used: live board, and its maker may still add people. */
export async function boardForLink(db: PrismaClient, tokenHash: string) {
  const board = await db.board.findFirst({
    where: {inviteLinkHash: tokenHash, archivedAt: null, inboxOf: null, workspace: {archivedAt: null}},
    select: {id: true, workspaceId: true, inviteLinkRole: true, inviteLinkBy: true},
  });
  if (!board || !board.inviteLinkBy || (board.inviteLinkRole !== 'member' && board.inviteLinkRole !== 'viewer')) return null;
  const maker = await boardAccess(db, board.id, board.inviteLinkBy);
  if (!maker || !canInvite(maker)) return null;
  return {boardId: board.id, workspaceId: board.workspaceId, role: board.inviteLinkRole as BoardRole};
}

/** Board invites by email: the inviter must STILL be able to add people to that board (checked again when mailing). */
export async function inviterMayInviteToBoard(db: PrismaClient, boardId: number, inviterId: number): Promise<boolean> {
  const access = await boardAccess(db, boardId, inviterId);
  if (!access || !canInvite(access)) return false;
  const ent = await getEntitlements(db, access.workspaceId);
  return !!ent && !ent.readOnly;
}
