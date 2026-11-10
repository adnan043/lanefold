import { createMiddleware } from "hono/factory";

import type { PrismaClient } from "../generated/prisma/client";
import type { Viewer } from "../platform/types";
import { problem } from "../platform/guards";
import { idOf } from "./validation";

/**
 * Workspace access: the ONE place that turns "who is the visitor" into "what may they do in this workspace"
 * (docs/agent/roles-and-permissions.md, Teams recipe; docs/product/SPEC.md §7).
 *
 * Ids in URLs only SELECT. Access comes from `workspace_members` / `board_members` read per request, and
 * `workspace_id` is in EVERY `where` of every route. Not yours or not found => 404 (same answer, no oracle).
 *
 * For a route file:
 *   .get('/:id/things', withViewer, requireAuth, withDb, requireWorkspaceRole('member'), async c => {
 *     const {workspaceId, member} = c.var;   // member.role / member.rank
 *   })
 *   .get('/:id', ..., async c => {
 *     const access = await boardAccess(c.var.db, boardId, c.var.viewer.id!);
 *     if (!access) return notFound(c, 'board');  // or !access.canWrite => forbidden(c)
 *   })
 */

export const WORKSPACE_ROLES = ["viewer", "member", "admin", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** owner > admin > member > viewer. */
export const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === "string" && Object.hasOwn(ROLE_RANK, value);

export const rankOf = (role: string): number =>
  isWorkspaceRole(role) ? ROLE_RANK[role] : 0;

export const notFound = (
  c: { json: (body: unknown, status: 404) => Response },
  what = "workspace",
) => c.json(problem("not_found", `No such ${what}.`), 404);

export type Membership = { role: WorkspaceRole; rank: number };

/** The visitor's role in a workspace (ONE query), or null when they are not a member. */
export async function membership(
  db: PrismaClient,
  workspaceId: number,
  userId: number,
): Promise<Membership | null> {
  // An archived workspace does not exist for its members: the check is in the query.
  const row = await db.workspaceMember.findFirst({
    where: { workspaceId, userId, workspace: { archivedAt: null } },
    select: { role: true },
  });
  if (!row || !isWorkspaceRole(row.role)) return null;
  return { role: row.role, rank: ROLE_RANK[row.role] };
}

export type WorkspaceVars = {
  viewer: Viewer;
  db: PrismaClient;
  workspaceId: number;
  member: Membership;
};

/**
 * Route guard: the workspace in `:param` (default `id`) must exist AND the signed-in visitor must be a member.
 * Not a member (or no such workspace, or a bad id) => 404; a member below `min` => 403.
 * Use after `withViewer, requireAuth, withDb`.
 */
export const requireWorkspaceRole = (
  min: WorkspaceRole = "viewer",
  param = "id",
) =>
  createMiddleware<{ Variables: WorkspaceVars }>(async (c, next) => {
    const workspaceId = idOf(c.req.param(param));
    if (!workspaceId) return notFound(c);
    const member = await membership(c.var.db, workspaceId, c.var.viewer.id!);
    if (!member) return notFound(c);
    if (member.rank < ROLE_RANK[min])
      return c.json(
        problem("forbidden", "You do not have access to this."),
        403,
      );
    c.set("workspaceId", workspaceId);
    c.set("member", member);
    await next();
  });

/* ------------------------------------------------------------------ boards */

export type BoardRole = "admin" | "member" | "viewer";
export type BoardAccess = {
  workspaceId: number;
  /** `guest`: not a member of the workspace, only a seat on this board (rankOf('guest') is 0: no workspace right). */
  workspaceRole: WorkspaceRole | "guest";
  /** Not a workspace member: sees this board only through their seat. */
  guest: boolean;
  /** The personal Inbox board of the visitor. */
  inbox: boolean;
  /** Who may add people (`admins` or `members`) and whether workspace members may join by themselves. */
  memberInvites: string;
  selfJoin: boolean;
  /** The visitor has a seat (a board_members row) on this board. */
  seated: boolean;
  boardRole: BoardRole;
  canWrite: boolean;
  canAdmin: boolean;
  visibility: string;
  archived: boolean;
  /** `boards.rev` read in the same query (the poll uses it, so access and revision are ONE round trip). */
  rev: bigint;
  /** Name and background, read in the same query (the delta route returns them without a second board read). */
  name: string;
  bgKind: string;
  bgColor1: string;
  bgColor2: string;
  bgAngle: number;
  bgPattern: string;
  /** The uploaded background photo's file id (`bgImageUrl` makes its address), or null. */
  bgFileId: string | null;
};

/**
 * Pure rules. Workspace owners and admins are always board admins. Workspace viewers are always viewers (a private board still needs
 * their seat to be visible). Members: the board_members override (admin, member, viewer) when there is one,
 * else their workspace role.
 * Private boards are visible only to board members and workspace owners/admins; `workspace` and `public`
 * boards to every workspace member (the public read-only LINK is a separate, tokened route).
 */
export function resolveBoardRole(
  workspaceRole: WorkspaceRole,
  visibility: string,
  override: BoardRole | null,
): BoardRole | null {
  if (workspaceRole === "owner" || workspaceRole === "admin") return "admin";
  if (visibility === "private" && !override) return null;
  // A workspace viewer is ALWAYS a viewer: no board override (kept from before a demotion) may raise it.
  if (workspaceRole === "viewer") return "viewer";
  if (override) return override;
  return workspaceRole === "member" ? "member" : "viewer";
}

const BOARD_ROLES = new Set<string>(["admin", "member", "viewer"]);

/** Guests: a seat gives at most `member` (never board admin). */
export const guestRole = (seat: BoardRole): BoardRole => (seat === "admin" ? "member" : seat);

/**
 * Prisma `where` for a board the user may reach at all (the 404 filter before boardAccess decides): a board of a live
 * workspace they are a member of, or one they hold a seat on (a guest). boardAccess() still decides what they may do.
 */
export const boardReachable = (userId: number) => ({
  AND: [
    { workspace: { archivedAt: null } },
    { OR: [{ workspace: { members: { some: { userId } } } }, { boardMembers: { some: { userId } } }] },
  ],
});

/**
 * What the visitor may do on one board (ONE query), or null: no such board, not in its workspace (and no seat on it),
 * or a private board they have no seat on. Another user's personal Inbox board is never visible.
 * A GUEST (a seat, no workspace membership) gets their seat's role, at most `member`, on any visibility.
 */
export async function boardAccess(
  db: PrismaClient,
  boardId: number,
  userId: number,
): Promise<BoardAccess | null> {
  const board = await db.board.findFirst({
    // The visitor's workspace membership is IN the query: a board of a workspace they are not in does not exist.
    where: { id: boardId, ...boardReachable(userId) },
    select: {
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
      boardMembers: { where: { userId }, select: { role: true }, take: 1 },
      workspace: {
        select: {
          members: { where: { userId }, select: { role: true }, take: 1 },
        },
      },
    },
  });
  if (!board) return null;
  const rawRole = board.workspace.members[0]?.role;
  if (board.inboxOf !== null && board.inboxOf !== userId) return null;
  const rawOverride = board.boardMembers[0]?.role;
  const override =
    rawOverride && BOARD_ROLES.has(rawOverride)
      ? (rawOverride as BoardRole)
      : null;
  let wsRole: WorkspaceRole | "guest";
  let boardRole: BoardRole | null;
  if (rawRole === undefined) {
    // Not a workspace member: a guest, ONLY through a seat on a shared board (never an Inbox).
    if (!override || board.inboxOf !== null) return null;
    wsRole = "guest";
    boardRole = guestRole(override);
  } else {
    if (!isWorkspaceRole(rawRole)) return null;
    wsRole = rawRole;
    // A personal Inbox belongs to its owner whatever the workspace role.
    boardRole =
      board.inboxOf === userId
        ? "admin"
        : resolveBoardRole(rawRole, board.visibility, override);
  }
  if (!boardRole) return null;
  return {
    workspaceId: board.workspaceId,
    workspaceRole: wsRole,
    guest: wsRole === "guest",
    inbox: board.inboxOf !== null,
    memberInvites: board.memberInvites,
    selfJoin: board.selfJoin,
    seated: override !== null,
    boardRole,
    canWrite: boardRole !== "viewer",
    canAdmin: boardRole === "admin",
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
