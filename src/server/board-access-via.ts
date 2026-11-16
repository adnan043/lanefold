import type {PrismaClient} from '../generated/prisma/client';
import {getEntitlements} from './entitlements';
import {boardReachable, guestRole, isWorkspaceRole, resolveBoardRole, type BoardAccess, type BoardRole, type WorkspaceRole} from './workspaces';

/**
 * Board access read in the SAME query as the row a route starts from (a card, a lane or the board itself), so
 * the card/lane routes pay one round trip for "find it + may I" instead of two (performance.md › round trips).
 *
 * The rules are EXACTLY boardAccess() in workspaces.ts (tests/board-access-via.test.ts runs both on the same rows):
 * the same `boardReachable` filter in the `where`, the same columns, the same resolution. The only extra column
 * is the workspace's grace clock, which lets a write skip the entitlements read when it cannot be read-only.
 */

const BOARD_ROLES = new Set<string>(['admin', 'member', 'viewer']);

/** What boardAccess() selects from `boards`, plus `workspace.graceUntil`. */
export const accessSelect = (userId: number) => ({
  workspaceId: true,
  visibility: true,
  inboxOf: true,
  archivedAt: true,
  rev: true,
  name: true,
  bgKind: true,
  bgColor1: true,
  bgColor2: true,
  bgAngle: true,
  bgPattern: true,
  bgFileId: true,
  memberInvites: true,
  selfJoin: true,
  boardMembers: {where: {userId}, select: {role: true}, take: 1},
  workspace: {select: {graceUntil: true, members: {where: {userId}, select: {role: true}, take: 1}}},
});

export type AccessRow = {
  workspaceId: number;
  visibility: string;
  inboxOf: number | null;
  archivedAt: Date | null;
  rev: bigint;
  name: string;
  bgKind: string;
  bgColor1: string;
  bgColor2: string;
  bgAngle: number;
  bgPattern: string;
  bgFileId: string | null;
  memberInvites: string;
  selfJoin: boolean;
  boardMembers: {role: string}[];
  workspace: {graceUntil?: Date | null; members: {role: string}[]};
};

/** boardAccess()'s resolution, on a row already read with `accessSelect` (and filtered by `boardReachable`). */
export function resolveAccess(board: AccessRow, userId: number): BoardAccess | null {
  const rawRole = board.workspace.members[0]?.role;
  if (board.inboxOf !== null && board.inboxOf !== userId) return null;
  const rawOverride = board.boardMembers[0]?.role;
  const override = rawOverride && BOARD_ROLES.has(rawOverride) ? (rawOverride as BoardRole) : null;
  let wsRole: WorkspaceRole | 'guest';
  let boardRole: BoardRole | null;
  if (rawRole === undefined) {
    if (!override || board.inboxOf !== null) return null;
    wsRole = 'guest';
    boardRole = guestRole(override);
  } else {
    if (!isWorkspaceRole(rawRole)) return null;
    wsRole = rawRole;
    boardRole = board.inboxOf === userId ? (rawRole === 'viewer' ? 'viewer' : 'admin') : resolveBoardRole(rawRole, board.visibility, override);
  }
  if (!boardRole) return null;
  return {
    workspaceId: board.workspaceId,
    workspaceRole: wsRole,
    guest: wsRole === 'guest',
    inbox: board.inboxOf !== null,
    memberInvites: board.memberInvites,
    selfJoin: board.selfJoin,
    seated: override !== null,
    boardRole,
    canWrite: boardRole !== 'viewer',
    canAdmin: boardRole === 'admin',
    visibility: board.visibility,
    archived: board.archivedAt !== null,
    rev: board.rev,
    name: board.name,
    bgKind: board.bgKind,
    bgColor1: board.bgColor1,
    bgColor2: board.bgColor2,
    bgAngle: board.bgAngle,
    bgPattern: board.bgPattern,
    bgFileId: board.bgFileId,
  };
}

export type Gated = {access: BoardAccess; graceUntil: Date | null};

/** boardAccess() plus the grace clock, ONE query; null exactly when boardAccess() is null. */
export async function boardAccessGated(db: PrismaClient, boardId: number, userId: number): Promise<Gated | null> {
  const board = await db.board.findFirst({where: {id: boardId, ...boardReachable(userId)}, select: accessSelect(userId)});
  if (!board) return null;
  const access = resolveAccess(board, userId);
  return access ? {access, graceUntil: board.workspace.graceUntil} : null;
}

/**
 * A card and the access to its board in ONE query (cardFor / cardCtx). `targetLaneId` also reads that lane of the
 * same board (open only), for a move: `targetLane` is null when it is missing, archived or on another board.
 * Null when the card is not found or not reachable; `access` null when boardAccess() would refuse its board.
 */
export async function cardWithAccess(db: PrismaClient, cardId: number, userId: number, targetLaneId?: number) {
  const row = await db.card.findFirst({
    where: {id: cardId, board: boardReachable(userId)},
    select: {
      id: true,
      boardId: true,
      laneId: true,
      workspaceId: true,
      archivedAt: true,
      board: {
        select: {
          ...accessSelect(userId),
          lanes: {where: {id: targetLaneId ?? -1, archivedAt: null}, select: {id: true, workspaceId: true}, take: 1},
        },
      },
    },
  });
  if (!row) return null;
  const access = resolveAccess(row.board, userId);
  const lane = targetLaneId === undefined ? undefined : row.board.lanes[0];
  return {
    card: {id: row.id, boardId: row.boardId, laneId: row.laneId, workspaceId: row.workspaceId, archivedAt: row.archivedAt, inboxOf: row.board.inboxOf},
    access,
    graceUntil: row.board.workspace.graceUntil,
    targetLane: lane === undefined ? undefined : lane && lane.workspaceId === row.board.workspaceId ? {id: lane.id} : null,
  };
}

/** An open lane and the access to its board in ONE query (laneFor). Null / `access` null as for cardWithAccess. */
export async function laneWithAccess(db: PrismaClient, laneId: number, userId: number) {
  const row = await db.lane.findFirst({
    where: {id: laneId, archivedAt: null, board: boardReachable(userId)},
    select: {id: true, boardId: true, workspaceId: true, board: {select: accessSelect(userId)}},
  });
  if (!row) return null;
  const access = resolveAccess(row.board, userId);
  return {lane: {id: row.id, boardId: row.boardId, workspaceId: row.workspaceId}, access, graceUntil: row.board.workspace.graceUntil};
}

/**
 * `getEntitlements(db, workspaceId).readOnly`, without the read when the answer is certain: read-only needs a grace
 * clock that has RUN OUT (entitlements.ts computeEntitlements: `graceOver` needs `graceUntil <= now`), so a clock
 * still running means not read-only whatever the limits. No clock (the usual case) or an expired one: the full read,
 * which also starts a missing clock for a workspace over its limits, as before.
 */
export async function workspaceReadOnly(db: PrismaClient, workspaceId: number, graceUntil: Date | null | undefined): Promise<boolean> {
  if (graceUntil && graceUntil.getTime() > Date.now()) return false;
  const ent = await getEntitlements(db, workspaceId);
  return ent?.readOnly === true;
}
