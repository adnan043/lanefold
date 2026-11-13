import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";

import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { audit, normalizeEmail } from "../../platform/auth";
import {
  randomBytes,
  sha256Hex,
  toBase64Url,
} from "../../platform/auth/encoding";
import {
  permissionScope,
  problem,
  requireAuth,
  withDb,
  withViewer,
} from "../../platform/guards";
import { config } from "../../platform/config";
import { PERMISSIONS } from "../permissions";
import { forgetEntitlements, getEntitlements } from "../entitlements";
import { softCount, softHit } from "../soft-limit";
import {
  enqueueInviteEmails,
  sealInviteItem,
} from "../jobs/invite-email";
import { mailConfigured } from "../mail/send";
import { acceptSeat, boardForLink, inviterMayInviteToBoard, type SeatResult } from "../board-seats";
import { inviteLink, renderInviteEmail } from "../mail/templates";
import { idOf, intField, invalid, objectOf } from "../validation";
import {
  isWorkspaceRole,
  membership,
  notFound,
  requireWorkspaceRole,
  ROLE_RANK,
  type WorkspaceRole,
} from "../workspaces";

/**
 * Phase 4: members, join links, invites, roles (docs/product/SPEC.md §7, HANDOFF.md §4: links only, no emails).
 *
 * Workspace members (any other visitor gets 404, exactly like a missing workspace):
 *   GET    /workspaces/:id/members?after=             directory, keyset on user id (50 a page); names only
 *                                                     (a MASKED email, m•••@domain, only for admins and owners)
 *   PATCH  /workspaces/:id/members/:userId            {role} change a role (admin+; see canChangeRole)
 *   DELETE /workspaces/:id/members/:userId            remove a member (admin+; see canManageMember)
 *   POST   /workspaces/:id/leave                      leave (the last owner cannot)
 * Admins and owners:
 *   GET    /workspaces/:id/join-links?before=         links (never the token: only its hash is stored)
 *   POST   /workspaces/:id/join-links                 {role, expiresInDays, maxUses}  -> {token} shown ONCE
 *   DELETE /workspaces/:id/join-links/:linkId         revoke
 *   GET    /workspaces/:id/invites?before=            single-use invites
 *   POST   /workspaces/:id/invites                    {role, expiresInDays, email?, sendEmail?}   -> {token} shown ONCE (+ emailStatus, emailPreview in test mode)
 *   DELETE /workspaces/:id/invites/:inviteId          revoke
 *   POST   /workspaces/:id/invites/:inviteId/email    {email} send the invite email again (Phase 11; rotates the token)
 * Anyone signed in:
 *   POST   /invites/accept                            {token} join with a link or an invite (a link is NOT a sign-in)
 *
 * Tokens: 32 random bytes, `lj_` (join link) or `iv_` (invite) + base64url; stored as SHA-256 only. An invite may be
 * bound to an email (stored only as a SHA-256 of the lower-cased address); it then works for that account only.
 * Every "not valid" case (unknown, expired, used up, revoked, bound to another email) answers the same 404.
 * The seat is taken with ONE conditional update (`member_count < limit`) inside the same transaction that
 * consumes the link and adds the member, so a full workspace never ends with a consumed link.
 */

const PAGE = 50;
const LIST_PAGE = 30;
/** Links and invites one workspace may create per hour (bounded count on our own table, security.md A06). */
const CREATE_PER_HOUR = 30;
const GRANTABLE = ["viewer", "member", "admin"] as const;
const TOKEN_RE = /^(lj|iv|bl)_[A-Za-z0-9_-]{43}$/;
export const INVALID_INVITE = "This invite link is not valid any more.";

/* ------------------------------------------------------------------ pure rules (unit tested) */

/**
 * THE OWNER IS KING (owner decision). Admins may grant admin (canGrant allows it: links, invites, role changes), but:
 *  - the owner can demote or remove ANY admin and revoke EVERY invite and join link, whoever made it;
 *  - an admin can never touch the owner (role, removal, the owner's links and invites), never make anyone an owner
 *    (`owner` is not grantable; ownership only moves through POST /workspaces/:id/transfer, owner only), and never
 *    demote or remove another admin: only the owner may.
 * An owner is never changed or removed by anyone else; admins manage members and viewers; owners manage admins too.
 */
export function canManageMember(
  actor: WorkspaceRole,
  target: WorkspaceRole,
): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  return actor === "admin" && ROLE_RANK[target] < ROLE_RANK.admin;
}

/** Nobody grants `owner` (use the owner-only transfer), nor more than they hold; an admin may grant admin. See canManageMember. */
export function canGrant(actor: WorkspaceRole, role: WorkspaceRole): boolean {
  return role !== "owner" && ROLE_RANK[role] <= ROLE_RANK[actor];
}

/** `m•••@•••.com`: the domain is masked too (first letter + full domain would nearly identify a person). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const dot = email.lastIndexOf(".");
  const tld = dot > at + 1 && dot < email.length - 1 ? email.slice(dot) : "";
  const domain = `•••${tld}`;
  // A short local part would leak the whole address with its first letter: show none of it.
  if (at <= 3) return `•••@${domain}`;
  return `${email[0]}•••@${domain}`;
}

/** The kind of a token, from its shape alone. */
export function tokenKind(token: string): "join" | "invite" | "board" | null {
  if (!TOKEN_RE.test(token)) return null;
  return token.startsWith("lj_") ? "join" : token.startsWith("bl_") ? "board" : "invite";
}

/* ------------------------------------------------------------------ helpers */

const noStore = createMiddleware(async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * The hash an email-bound invite stores: HMAC-SHA256 keyed by the site secret, so a leaked table cannot be
 * brute-forced against guessed addresses. Without a secret it falls back to the plain SHA-256.
 */
export async function inviteEmailHash(email: string): Promise<string> {
  const secret = config.jwtSecret;
  if (!secret) return sha256Hex(email);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`invite-email:${email}`),
    ),
  );
}

export const newToken = (prefix: "lj" | "iv" | "bl") =>
  `${prefix}_${toBase64Url(randomBytes(32))}`;

/** Thrown inside a transaction to roll it back with an answer. */
class Refuse extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refusal = (
  c: { json: (body: unknown, status: 404 | 409) => Response },
  err: unknown,
) => {
  if (err instanceof Refuse)
    return c.json(problem(err.code, err.message), err.status);
  throw err;
};

const FORBIDDEN_BODY = problem("forbidden", "You do not have access to this.");

/** Workspace row locked for the rest of the transaction: serializes joins, leaves and removals. */
const lockWorkspace = (tx: Prisma.TransactionClient, workspaceId: number) =>
  tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;

/** Frees the seat, records the removal (leaving counts too) and drops the person's per-workspace links (boards, cards, chats). */
async function removeFromWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: number,
  userId: number,
  role: string,
): Promise<boolean> {
  await lockWorkspace(tx, workspaceId);
  const gone = await tx.workspaceMember.deleteMany({
    where: { workspaceId, userId, role },
  });
  if (gone.count === 0) return false;
  await tx.workspace.updateMany({
    where: { id: workspaceId, memberCount: { gt: 0 } },
    data: { memberCount: { decrement: 1 } },
  });
  // Remember when they left: an older join link or invite cannot bring them back (see POST /invites/accept).
  // clock_timestamp(): the moment of the removal, after the workspace lock was won.
  await tx.$executeRaw`INSERT INTO workspace_removals (workspace_id, user_id, removed_at) VALUES (${workspaceId}, ${userId}, clock_timestamp()) ON CONFLICT (workspace_id, user_id) DO UPDATE SET removed_at = EXCLUDED.removed_at`;
  await Promise.all([
    tx.boardMember.deleteMany({ where: { workspaceId, userId } }),
    tx.cardMember.deleteMany({ where: { workspaceId, userId } }),
    tx.conversationMember.deleteMany({ where: { workspaceId, userId } }),
    // Their notifications here can never be shown again: drop them so list and badge never scan dead rows.
    tx.notification.deleteMany({ where: { userId, workspaceId } }),
  ]);
  return true;
}

/**
 * Owner is king: an admin cannot revoke what an owner made. Returns the extra `where` for a revoke by this actor:
 * nothing for an owner, "not created by a current owner" for an admin (bounded: a workspace has a handful of owners).
 */
async function notOwnerMade(
  db: PrismaClient,
  workspaceId: number,
  actor: WorkspaceRole,
) {
  if (actor === "owner") return {};
  const owners = await db.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { userId: true },
    take: 50,
  });
  if (owners.length === 0) return {};
  return {
    OR: [
      { createdBy: null },
      { createdBy: { notIn: owners.map((o) => o.userId) } },
    ],
  };
}

// NOTE (review 5, low 3): createdRecently / emailLimited below are read-then-write soft caps, on purpose. The
// platform's atomic limiter (src/platform/auth/rate-limit.ts, advisory lock + insert-then-count) is keyed by hashed
// email/IP and writes `login_attempts`; it cannot count workspace-scoped rows. A burst can overshoot a cap by a few
// invites; hard bounds remain (MAX_BATCH, EMAIL_ATTEMPTS_MAX per invite, member seat limit).
export async function createdRecently(
  db: PrismaClient,
  workspaceId: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 3600_000);
  const [links, invites] = await Promise.all([
    db.workspaceJoinLink.findMany({
      where: { workspaceId, createdAt: { gt: since } },
      select: { id: true },
      take: CREATE_PER_HOUR + 1,
    }),
    db.workspaceInvite.findMany({
      where: { workspaceId, createdAt: { gt: since } },
      select: { id: true },
      take: CREATE_PER_HOUR + 1,
    }),
  ]);
  return links.length + invites.length > CREATE_PER_HOUR;
}

/* ------------------------------------------------------------------ validators */

const roleOf = (value: unknown, fallback?: WorkspaceRole) => {
  const role = value === undefined && fallback ? fallback : value;
  return isWorkspaceRole(role) &&
    (GRANTABLE as readonly string[]).includes(role)
    ? role
    : null;
};

const afterQuery = validator("query", (value) => ({
  after: idOf(typeof value.after === "string" ? value.after : ""),
}));
const beforeQuery = validator("query", (value) => ({
  before: idOf(typeof value.before === "string" ? value.before : ""),
}));

const roleBody = validator("json", (value, c) => {
  const role = roleOf(objectOf(value)?.role);
  if (!role)
    return invalid(c, {
      role: { code: "invalid", message: "Choose viewer, member or admin." },
    });
  return { role };
});

const linkBody = validator("json", (value, c) => {
  const body = objectOf(value) ?? {};
  const errors: Record<string, { code: string; message: string }> = {};
  const role = roleOf(body.role, "member");
  if (!role)
    errors.role = {
      code: "invalid",
      message: "Choose viewer, member or admin.",
    };
  const days = intField(body.expiresInDays ?? 7, 1, 30);
  if (!days.ok) errors.expiresInDays = days.error;
  const maxUses = intField(body.maxUses ?? 10, 1, 100);
  if (!maxUses.ok) errors.maxUses = maxUses.error;
  if (Object.keys(errors).length) return invalid(c, errors);
  return {
    role: role!,
    expiresInDays: (days as { value: number }).value,
    maxUses: (maxUses as { value: number }).value,
  };
});

const inviteBody = validator("json", (value, c) => {
  const body = objectOf(value) ?? {};
  const errors: Record<string, { code: string; message: string }> = {};
  const role = roleOf(body.role, "member");
  if (!role)
    errors.role = {
      code: "invalid",
      message: "Choose viewer, member or admin.",
    };
  const days = intField(body.expiresInDays ?? 7, 1, 30);
  if (!days.ok) errors.expiresInDays = days.error;
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    email = normalizeEmail(body.email);
    if (!email)
      errors.email = {
        code: "invalid",
        message: "Enter a valid email address, or leave it empty.",
      };
  }
  // Phase 11: `sendEmail` only makes sense with an address.
  let sendEmail = false;
  if (body.sendEmail !== undefined && body.sendEmail !== null) {
    if (typeof body.sendEmail !== "boolean")
      errors.sendEmail = { code: "invalid", message: "Send email must be true or false." };
    else if (body.sendEmail && !email && !errors.email)
      errors.sendEmail = {
        code: "email_required",
        message: "Enter an email address to send the invite by email.",
      };
    else sendEmail = body.sendEmail;
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  return {
    role: role!,
    expiresInDays: (days as { value: number }).value,
    email,
    sendEmail,
  };
});

const resendBody = validator("json", (value, c) => {
  const email = normalizeEmail(objectOf(value)?.email);
  if (!email)
    return invalid(c, {
      email: { code: "invalid", message: "Enter the invited email address." },
    });
  return { email };
});

/**
 * Invite emails one workspace / one inviter may queue per hour (counted on the invite rows; no address is stored).
 * The inviter's count spans EVERY workspace: otherwise one account with many workspaces multiplies it.
 */
const EMAIL_PER_HOUR_WORKSPACE = 30;
const EMAIL_PER_HOUR_INVITER = 10;
/** Sends per invite (the first one and every Resend), so one row cannot be used to flood an address. */
const EMAIL_ATTEMPTS_MAX = 5;

export async function emailLimited(
  db: PrismaClient,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 3600_000);
  const [ws, mine] = await Promise.all([
    db.workspaceInvite.findMany({
      where: { workspaceId, emailQueuedAt: { gt: since } },
      select: { id: true },
      take: EMAIL_PER_HOUR_WORKSPACE,
    }),
    db.workspaceInvite.findMany({
      where: { createdBy: userId, emailQueuedAt: { gt: since } }, // @@index([createdBy, emailQueuedAt])
      select: { id: true },
      take: EMAIL_PER_HOUR_INVITER,
    }),
  ]);
  return (
    ws.length >= EMAIL_PER_HOUR_WORKSPACE || mine.length >= EMAIL_PER_HOUR_INVITER
  );
}

/**
 * The email as it would be sent, shown ONLY to the inviter who just made the invite and only when email is not set up
 * (or in the Preview): never stored, never logged. The link is built from the request's own origin when the site address
 * is unknown.
 */
async function previewFor(
  c: { req: { url: string } },
  db: PrismaClient,
  workspaceId: number,
  inviterName: string | null,
  role: string,
  expiresAt: Date,
  token: string,
) {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, defaultLocale: true },
  });
  if (!ws) return null;
  const mail = renderInviteEmail({
    locale: ws.defaultLocale,
    inviterName: inviterName ?? "",
    workspaceName: ws.name,
    role,
    expiresAt,
    link: inviteLink(config.siteUrl ?? new URL(c.req.url).origin, token),
  });
  return { subject: mail.subject, text: mail.text };
}

const acceptBody = validator("json", (value, c) => {
  const token = objectOf(value)?.token;
  if (typeof token !== "string" || !tokenKind(token.trim()))
    return invalid(c, {
      token: { code: "invalid", message: "This invite link is not valid." },
    });
  return { token: token.trim() };
});

const expiry = (days: number) => new Date(Date.now() + days * 86_400_000);

/* ------------------------------------------------------------------ routes */

export const memberRoutes = new Hono()
  .use("/workspaces/*", noStore)
  .use("/invites/*", noStore)

  // ---- the directory ---------------------------------------------------------------------------
  .get(
    "/workspaces/:id/members",
    afterQuery,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("viewer"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      const { after } = c.req.valid("query");
      const rows = await db.workspaceMember.findMany({
        where: { workspaceId, ...(after ? { userId: { gt: after } } : {}) },
        orderBy: { userId: "asc" },
        take: PAGE + 1,
        select: { userId: true, role: true, createdAt: true },
      });
      const page = rows.slice(0, PAGE);
      const users = page.length
        ? await db.user.findMany({
            where: { id: { in: page.map((r) => r.userId) } },
            select: { id: true, name: true, email: true },
            take: PAGE,
          })
        : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      const seesMasked = member.rank >= ROLE_RANK.admin;
      // A full address leaves the server only to its owner or a site admin the server checked (AGENTS.md › Never).
      const seesFull = (await permissionScope(c, PERMISSIONS.USER_READ)) === "all";
      return c.json({
        items: page.map((r) => {
          const user = byId.get(r.userId);
          const role = isWorkspaceRole(r.role) ? r.role : "viewer";
          return {
            userId: r.userId,
            name: user?.name ?? null,
            // Full: your own, or for a site admin (site:user:read). Masked: workspace admins. Else none.
            ...(user && (r.userId === viewer.id || seesFull)
              ? { email: user.email }
              : seesMasked && user
                ? { maskedEmail: maskEmail(user.email) }
                : {}),
            role,
            joinedAt: r.createdAt,
            isMe: r.userId === viewer.id,
            canManage:
              seesMasked &&
              r.userId !== viewer.id &&
              canManageMember(member.role, role),
          };
        }),
        nextAfter: rows.length > PAGE ? page[page.length - 1]!.userId : null,
        me: { role: member.role },
      });
    },
  )

  // ---- change a role -------------------------------------------------------------------------
  .patch(
    "/workspaces/:id/members/:userId",
    roleBody,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      const targetId = idOf(c.req.param("userId"));
      if (!targetId) return notFound(c, "member");
      const { role } = c.req.valid("json");
      const target = await membership(db, workspaceId, targetId);
      if (!target) return notFound(c, "member");
      if (targetId === viewer.id)
        return c.json(
          problem("cannot_change_own_role", "You cannot change your own role."),
          409,
        );
      if (
        !canManageMember(member.role, target.role) ||
        !canGrant(member.role, role)
      )
        return c.json(FORBIDDEN_BODY, 403);
      if (target.role !== role) {
        // Conditional on the role we read: a concurrent change makes this a 409, never a silent overwrite.
        const changed = await db.$transaction(async (tx) => {
          const done = await tx.workspaceMember.updateMany({
            where: { workspaceId, userId: targetId, role: target.role },
            data: { role },
          });
          if (done.count === 0) return false;
          // A viewer never keeps a write seat on a board (resolveBoardRole clamps too; this keeps the rows honest).
          if (role === "viewer")
            await tx.boardMember.updateMany({
              where: { workspaceId, userId: targetId, role: { not: "viewer" } },
              data: { role: "viewer" },
            });
          return true;
        });
        if (!changed)
          return c.json(
            problem(
              "conflict",
              "This member was changed by someone else. Reload and try again.",
            ),
            409,
          );
        await audit(db, {
          actorUserId: viewer.id,
          action: "workspace.member.role_changed",
          target: ["workspace", workspaceId],
          meta: { userId: targetId, from: target.role, to: role },
        });
      }
      return c.json({ userId: targetId, role });
    },
  )

  // ---- remove a member -----------------------------------------------------------------------
  .delete(
    "/workspaces/:id/members/:userId",
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      const targetId = idOf(c.req.param("userId"));
      if (!targetId) return notFound(c, "member");
      const target = await membership(db, workspaceId, targetId);
      if (!target) return notFound(c, "member");
      if (targetId === viewer.id)
        return c.json(
          problem("use_leave", 'Use "Leave workspace" to remove yourself.'),
          409,
        );
      if (!canManageMember(member.role, target.role))
        return c.json(FORBIDDEN_BODY, 403);
      const removed = await db.$transaction((tx) =>
        removeFromWorkspace(tx, workspaceId, targetId, target.role),
      );
      forgetEntitlements(db, workspaceId);
      if (!removed) return notFound(c, "member");
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.member.removed",
        target: ["workspace", workspaceId],
        meta: { userId: targetId },
      });
      return c.json({ removed: true });
    },
  )

  // ---- leave ---------------------------------------------------------------------------------
  .post(
    "/workspaces/:id/leave",
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("viewer"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      try {
        await db.$transaction(async (tx) => {
          const left = await removeFromWorkspace(
            tx,
            workspaceId,
            viewer.id!,
            member.role,
          );
          if (!left) throw new Refuse(404, "not_found", "No such workspace.");
          if (member.role === "owner") {
            const owners = await tx.workspaceMember.count({
              where: { workspaceId, role: "owner" },
            });
            if (owners === 0)
              throw new Refuse(
                409,
                "last_owner",
                "You are the only owner. Make someone else an owner or delete the workspace first.",
              );
          }
        });
      } catch (err) {
        forgetEntitlements(db, workspaceId);
        return refusal(c, err);
      }
      forgetEntitlements(db, workspaceId);
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.member.left",
        target: ["workspace", workspaceId],
      });
      return c.json({ left: true });
    },
  )

  // ---- join links ----------------------------------------------------------------------------
  .get(
    "/workspaces/:id/join-links",
    beforeQuery,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId } = c.var;
      const { before } = c.req.valid("query");
      const rows = await db.workspaceJoinLink.findMany({
        where: { workspaceId, ...(before ? { id: { lt: before } } : {}) },
        orderBy: { id: "desc" },
        take: LIST_PAGE + 1,
        select: {
          id: true,
          role: true,
          expiresAt: true,
          maxUses: true,
          uses: true,
          revokedAt: true,
          createdBy: true,
          createdAt: true,
        },
      });
      const now = Date.now();
      const page = rows.slice(0, LIST_PAGE);
      return c.json({
        items: page.map((r) => ({
          id: r.id,
          role: r.role,
          expiresAt: r.expiresAt,
          maxUses: r.maxUses,
          uses: r.uses,
          revoked: r.revokedAt !== null,
          active:
            r.revokedAt === null &&
            r.expiresAt.getTime() > now &&
            r.uses < r.maxUses,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
        })),
        nextBefore: rows.length > LIST_PAGE ? page[page.length - 1]!.id : null,
      });
    },
  )

  .post(
    "/workspaces/:id/join-links",
    linkBody,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      const { role, expiresInDays, maxUses } = c.req.valid("json");
      if (!canGrant(member.role, role)) return c.json(FORBIDDEN_BODY, 403);
      const ent = await getEntitlements(db, workspaceId);
      if (!ent) return notFound(c);
      if (ent.readOnly)
        return c.json(
          problem(
            "workspace_read_only",
            "This workspace is read-only until its plan limits are fixed.",
          ),
          409,
        );
      if (ent.usage.members >= ent.limits.maxMembers)
        return c.json(
          problem(
            "member_limit_reached",
            "This workspace has reached its member limit.",
          ),
          409,
        );
      if (await createdRecently(db, workspaceId))
        return c.json(
          problem("rate_limited", "Too many invites. Try again in an hour."),
          429,
        );
      const token = newToken("lj");
      const row = await db.workspaceJoinLink.create({
        data: {
          workspaceId,
          tokenHash: await sha256Hex(token),
          role,
          expiresAt: expiry(expiresInDays),
          maxUses,
          createdBy: viewer.id!,
        },
        select: { id: true, role: true, expiresAt: true, maxUses: true },
      });
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.joinlink.created",
        target: ["workspace", workspaceId],
        meta: { linkId: row.id, role },
      });
      return c.json({ ...row, token }, 201);
    },
  )

  .delete(
    "/workspaces/:id/join-links/:linkId",
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, viewer, member } = c.var;
      const linkId = idOf(c.req.param("linkId"));
      if (!linkId) return notFound(c, "link");
      const done = await db.workspaceJoinLink.updateMany({
        where: {
          id: linkId,
          workspaceId,
          revokedAt: null,
          ...(await notOwnerMade(db, workspaceId, member.role)),
        },
        data: { revokedAt: new Date() },
      });
      if (done.count === 0) return notFound(c, "link");
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.joinlink.revoked",
        target: ["workspace", workspaceId],
        meta: { linkId },
      });
      return c.json({ revoked: true });
    },
  )

  // ---- single-use invites --------------------------------------------------------------------
  .get(
    "/workspaces/:id/invites",
    beforeQuery,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId } = c.var;
      const { before } = c.req.valid("query");
      const rows = await db.workspaceInvite.findMany({
        // Board invites (guests) belong to their board's Share panel, not to the workspace's invite list.
        where: { workspaceId, boardId: null, ...(before ? { id: { lt: before } } : {}) },
        orderBy: { id: "desc" },
        take: LIST_PAGE + 1,
        select: {
          id: true,
          role: true,
          emailHash: true,
          expiresAt: true,
          usedAt: true,
          createdBy: true,
          createdAt: true,
          emailStatus: true,
          emailSentAt: true,
        },
      });
      const now = Date.now();
      const page = rows.slice(0, LIST_PAGE);
      return c.json({
        items: page.map((r) => ({
          id: r.id,
          role: r.role,
          // Whether it is tied to an address; the address itself is never stored or shown.
          boundToEmail: r.emailHash !== null,
          // Phase 11: queued | sent | failed | not_configured, or null when no email was requested.
          emailStatus: r.emailStatus,
          emailSentAt: r.emailSentAt,
          expiresAt: r.expiresAt,
          used: r.usedAt !== null,
          active: r.usedAt === null && r.expiresAt.getTime() > now,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
        })),
        nextBefore: rows.length > LIST_PAGE ? page[page.length - 1]!.id : null,
      });
    },
  )

  .post(
    "/workspaces/:id/invites",
    inviteBody,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, member, viewer } = c.var;
      const { role, expiresInDays, email, sendEmail } = c.req.valid("json");
      if (!canGrant(member.role, role)) return c.json(FORBIDDEN_BODY, 403);
      const ent = await getEntitlements(db, workspaceId);
      if (!ent) return notFound(c);
      if (ent.readOnly)
        return c.json(
          problem(
            "workspace_read_only",
            "This workspace is read-only until its plan limits are fixed.",
          ),
          409,
        );
      if (ent.usage.members >= ent.limits.maxMembers)
        return c.json(
          problem(
            "member_limit_reached",
            "This workspace has reached its member limit.",
          ),
          409,
        );
      if (await createdRecently(db, workspaceId))
        return c.json(
          problem("rate_limited", "Too many invites. Try again in an hour."),
          429,
        );
      if (sendEmail && (await emailLimited(db, workspaceId, viewer.id!)))
        return c.json(
          problem(
            "rate_limited",
            "Too many invite emails. Try again in an hour, or share the link yourself.",
          ),
          429,
        );
      const token = newToken("iv");
      const configured = mailConfigured();
      const row = await db.workspaceInvite.create({
        data: {
          workspaceId,
          tokenHash: await sha256Hex(token),
          emailHash: email ? await inviteEmailHash(email) : null,
          role,
          expiresAt: expiry(expiresInDays),
          createdBy: viewer.id!,
          ...(sendEmail
            ? { emailStatus: "queued", emailQueuedAt: new Date() }
            : {}),
        },
        select: { id: true, role: true, expiresAt: true },
      });
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.invite.created",
        target: ["workspace", workspaceId],
        meta: { inviteId: row.id, role, bound: email !== null, emailed: sendEmail },
      });
      let emailStatus: string | null = null;
      if (sendEmail && email) {
        emailStatus = configured ? "queued" : "not_configured";
        const item = await sealInviteItem(viewer.id!, row.id, email, token);
        const queued =
          item !== null &&
          (await enqueueInviteEmails(
            c.req.url,
            workspaceId,
            viewer.id!,
            [item],
            `invite-email-${row.id}-0`,
          ));
        if (!queued) {
          emailStatus = "failed";
          await db.workspaceInvite.updateMany({
            where: { id: row.id, workspaceId },
            data: { emailStatus: "failed" },
          });
        }
      }
      // Local test mode: email is not set up, or this is the editor Preview. The inviter sees what would be sent.
      const emailPreview =
        sendEmail && (!configured || config.preview)
          ? await previewFor(c, db, workspaceId, viewer.name, role, row.expiresAt, token)
          : null;
      return c.json(
        {
          ...row,
          boundToEmail: email !== null,
          token,
          emailStatus,
          ...(emailPreview ? { emailPreview: { ...emailPreview, configured } } : {}),
        },
        201,
      );
    },
  )

  .delete(
    "/workspaces/:id/invites/:inviteId",
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, viewer, member } = c.var;
      const inviteId = idOf(c.req.param("inviteId"));
      if (!inviteId) return notFound(c, "invite");
      const done = await db.workspaceInvite.deleteMany({
        where: {
          id: inviteId,
          workspaceId,
          usedAt: null,
          ...(await notOwnerMade(db, workspaceId, member.role)),
        },
      });
      if (done.count === 0) return notFound(c, "invite");
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.invite.revoked",
        target: ["workspace", workspaceId],
        meta: { inviteId },
      });
      return c.json({ revoked: true });
    },
  )

  // Phase 11: send the invite email again (a failed or not-configured one). The token is stored only as a hash, so
  // a resend ROTATES it (the old link stops working) and the admin types the address again; it is checked against the
  // invite's keyed hash and travels only in the sealed job payload.
  .post(
    "/workspaces/:id/invites/:inviteId/email",
    resendBody,
    withViewer,
    requireAuth,
    withDb,
    requireWorkspaceRole("admin"),
    async (c) => {
      const { db, workspaceId, viewer, member } = c.var;
      const { email } = c.req.valid("json");
      const inviteId = idOf(c.req.param("inviteId"));
      if (!inviteId) return notFound(c, "invite");
      const invite = await db.workspaceInvite.findFirst({
        where: {
          id: inviteId,
          workspaceId,
          usedAt: null,
          expiresAt: { gt: new Date() },
          ...(await notOwnerMade(db, workspaceId, member.role)),
        },
        select: { id: true, role: true, emailHash: true, emailStatus: true, emailAttempts: true, expiresAt: true, createdBy: true },
      });
      if (!invite) return notFound(c, "invite");
      const matches =
        invite.emailHash !== null &&
        (invite.emailHash === (await inviteEmailHash(email)) ||
          invite.emailHash === (await sha256Hex(email)));
      // Only the inviter (who knows the address) hears about a mismatch; anyone else gets the same 404 as an
      // unknown invite, so a guessed address cannot be tested against it.
      if (!matches && invite.createdBy !== viewer.id) return notFound(c, "invite");
      if (!matches)
        return invalid(c, {
          email: {
            code: "mismatch",
            message: "That is not the address this invite was made for.",
          },
        });
      if (invite.emailStatus !== "failed" && invite.emailStatus !== "not_configured")
        return c.json(
          problem("not_resendable", "Only a failed invite email can be sent again."),
          409,
        );
      if (invite.emailAttempts >= EMAIL_ATTEMPTS_MAX)
        return c.json(
          problem("rate_limited", "This invite was already emailed several times. Share its link yourself."),
          429,
        );
      const ent = await getEntitlements(db, workspaceId);
      if (!ent) return notFound(c);
      if (ent.readOnly)
        return c.json(
          problem(
            "workspace_read_only",
            "This workspace is read-only until its plan limits are fixed.",
          ),
          409,
        );
      if (await emailLimited(db, workspaceId, viewer.id!))
        return c.json(
          problem(
            "rate_limited",
            "Too many invite emails. Try again in an hour, or share the link yourself.",
          ),
          429,
        );
      const token = newToken("iv");
      const configured = mailConfigured();
      const rotated = await db.workspaceInvite.updateMany({
        where: {
          id: invite.id,
          workspaceId,
          usedAt: null,
          emailStatus: { in: ["failed", "not_configured"] },
        },
        data: {
          tokenHash: await sha256Hex(token),
          emailStatus: "queued",
          emailQueuedAt: new Date(),
        },
      });
      if (rotated.count === 0)
        return c.json(
          problem("not_resendable", "Only a failed invite email can be sent again."),
          409,
        );
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.invite.email_resent",
        target: ["workspace", workspaceId],
        meta: { inviteId: invite.id },
      });
      let emailStatus = configured ? "queued" : "not_configured";
      const item = await sealInviteItem(viewer.id!, invite.id, email, token);
      const queued =
        item !== null &&
        (await enqueueInviteEmails(
          c.req.url,
          workspaceId,
          viewer.id!,
          [item],
          `invite-email-${invite.id}-${invite.emailAttempts + 1}`,
        ));
      if (!queued) {
        emailStatus = "failed";
        await db.workspaceInvite.updateMany({
          where: { id: invite.id, workspaceId },
          data: { emailStatus: "failed" },
        });
      }
      const emailPreview =
        !configured || config.preview
          ? await previewFor(c, db, workspaceId, viewer.name, invite.role, invite.expiresAt, token)
          : null;
      return c.json({
        id: invite.id,
        emailStatus,
        // The old link no longer works: the new one is shown to the admin who asked.
        token,
        ...(emailPreview ? { emailPreview: { ...emailPreview, configured } } : {}),
      });
    },
  )

  // ---- accept --------------------------------------------------------------------------------
  .post(
    "/invites/accept",
    acceptBody,
    withViewer,
    requireAuth,
    withDb,
    async (c) => {
      const { db, viewer } = c.var;
      const { token } = c.req.valid("json");
      const kind = tokenKind(token)!;
      const tokenHash = await sha256Hex(token);
      // Guessing tokens: after 10 misses in 10 minutes this user is slowed down (per user; the IP is not available here).
      if ((await softCount(viewer.id!, "invite-miss", 600)) >= 10) {
        c.header("Retry-After", "60");
        return c.json(
          problem(
            "rate_limited",
            "Too many invalid invite links. Wait a few minutes and try again.",
          ),
          429,
        );
      }
      const invalidInvite = async () => {
        await softHit(viewer.id!, "invite-miss", 600);
        return c.json(problem("invalid_invite", INVALID_INVITE), 404);
      };
      const seated = (res: SeatResult) =>
        res.ok
          ? c.json(
              { workspaceId: res.workspaceId, boardId: res.boardId, role: res.role, guest: res.guest, alreadyMember: res.alreadyMember },
              res.alreadyMember ? 200 : 201,
            )
          : res.status === 404
            ? invalidInvite()
            : c.json(problem(res.code, res.message), res.status);

      // A board's invite link (`bl_`): a seat on that board only (a guest when not a workspace member).
      if (kind === "board") {
        const link = await boardForLink(db, tokenHash);
        if (!link) return invalidInvite();
        return seated(await acceptSeat(db, { ...link, userId: viewer.id!, via: "link", madeAt: null }, async () => true));
      }

      // 1. The link or invite, only if usable right now. One generic answer for every reason it is not.
      const now = new Date();
      let workspaceId: number;
      let role: WorkspaceRole;
      let rowId: number;
      let maxUses = 0;
      let createdAt: Date;
      let createdBy: number | null = null;
      if (kind === "join") {
        const link = await db.workspaceJoinLink.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            workspaceId: true,
            role: true,
            expiresAt: true,
            maxUses: true,
            uses: true,
            revokedAt: true,
            createdAt: true,
            createdBy: true,
          },
        });
        if (
          !link ||
          link.revokedAt ||
          link.expiresAt <= now ||
          link.uses >= link.maxUses ||
          !isWorkspaceRole(link.role) ||
          link.role === "owner"
        )
          return invalidInvite();
        createdBy = link.createdBy;
        ({
          workspaceId,
          role,
          id: rowId,
          maxUses,
          createdAt,
        } = {
          workspaceId: link.workspaceId,
          role: link.role,
          id: link.id,
          maxUses: link.maxUses,
          createdAt: link.createdAt,
        });
      } else {
        const invite = await db.workspaceInvite.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            workspaceId: true,
            role: true,
            emailHash: true,
            expiresAt: true,
            usedAt: true,
            createdAt: true,
            createdBy: true,
            boardId: true,
            boardRole: true,
          },
        });
        const boardInvite = invite?.boardId != null;
        if (
          !invite ||
          invite.usedAt ||
          invite.expiresAt <= now ||
          !(boardInvite ? invite.role === "guest" : isWorkspaceRole(invite.role)) ||
          invite.role === "owner"
        )
          return invalidInvite();
        if (invite.emailHash) {
          const address =
            viewer.email && viewer.emailVerified
              ? normalizeEmail(viewer.email)
              : null;
          // New invites carry the keyed hash; invites made before it (they expire within 30 days) the plain SHA-256.
          const ok =
            address !== null &&
            ((await inviteEmailHash(address)) === invite.emailHash ||
              (await sha256Hex(address)) === invite.emailHash);
          if (!ok) return invalidInvite();
        }
        // A board invite (Share by email): a seat on that board, a guest when not a workspace member. It works only
        // while its inviter may still add people to that board, and is used once.
        if (invite.boardId !== null) {
          const boardRole = invite.boardRole === "admin" || invite.boardRole === "viewer" ? invite.boardRole : "member";
          if (!invite.createdBy || !(await inviterMayInviteToBoard(db, invite.boardId, invite.createdBy))) return invalidInvite();
          const inviteId = invite.id;
          const inviteWs = invite.workspaceId;
          return seated(
            await acceptSeat(
              db,
              { boardId: invite.boardId, workspaceId: inviteWs, userId: viewer.id!, role: boardRole, via: "invite", madeAt: invite.createdAt },
              async (tx) =>
                (await tx.workspaceInvite.updateMany({
                  where: { id: inviteId, workspaceId: inviteWs, usedAt: null, expiresAt: { gt: now } },
                  data: { usedAt: now },
                })).count > 0,
            ),
          );
        }
        createdBy = invite.createdBy;
        ({
          workspaceId,
          role,
          id: rowId,
          createdAt,
        } = {
          workspaceId: invite.workspaceId,
          role: invite.role as WorkspaceRole,
          id: invite.id,
          createdAt: invite.createdAt,
        });
      }

      // An archived workspace is closed to everyone: the same generic answer as any other dead link.
      const live = await db.workspace.findFirst({
        where: { id: workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!live) return invalidInvite();

      // 1b. A link or invite works only while its maker may still invite people here (an admin or the owner) NOW,
      // whatever role it grants: one made by someone since demoted or removed is dead. Otherwise a removed admin
      // could keep letting people in (themselves too, under a second address) with a link they kept.
      const maker = createdBy ? await membership(db, workspaceId, createdBy) : null;
      if (!maker || maker.rank < ROLE_RANK.admin) return invalidInvite();

      // 2. Already in: nothing is consumed, nobody is demoted or promoted by a link.
      const existing = await membership(db, workspaceId, viewer.id!);
      if (existing)
        return c.json({
          workspaceId,
          role: existing.role,
          alreadyMember: true,
        });

      // 2b. Removed (or left) after this link or invite was made: it cannot bring them back. The same generic answer;
      // a link made after the removal (a deliberate re-invite) works.
      const removal = await db.workspaceRemoval.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: viewer.id! } },
        select: { removedAt: true },
      });
      if (removal && removal.removedAt > createdAt) return invalidInvite();

      // 3. Plan rules.
      const ent = await getEntitlements(db, workspaceId);
      if (!ent) return invalidInvite();
      if (ent.readOnly)
        return c.json(
          problem(
            "workspace_read_only",
            "This workspace is read-only until its plan limits are fixed.",
          ),
          409,
        );
      const maxMembers = ent.limits.maxMembers;

      // 4. One transaction: consume the link, take a seat (conditional), add the member.
      try {
        await db.$transaction(async (tx) => {
          const used =
            kind === "join"
              ? await tx.workspaceJoinLink.updateMany({
                  where: {
                    id: rowId,
                    workspaceId,
                    revokedAt: null,
                    expiresAt: { gt: now },
                    uses: { lt: maxUses },
                  },
                  data: { uses: { increment: 1 } },
                })
              : await tx.workspaceInvite.updateMany({
                  where: {
                    id: rowId,
                    workspaceId,
                    usedAt: null,
                    expiresAt: { gt: now },
                  },
                  data: { usedAt: now },
                });
          if (used.count === 0)
            throw new Refuse(404, "invalid_invite", INVALID_INVITE);
          const seat = await tx.workspace.updateMany({
            where: {
              id: workspaceId,
              archivedAt: null,
              memberCount: { lt: maxMembers },
            },
            data: { memberCount: { increment: 1 } },
          });
          if (seat.count === 0) {
            // Archived between the check and here, or full: re-read to tell which.
            const gone = await tx.workspace.findFirst({
              where: { id: workspaceId, archivedAt: null },
              select: { id: true },
            });
            if (!gone) throw new Refuse(404, "invalid_invite", INVALID_INVITE);
          }
          if (seat.count === 0)
            throw new Refuse(
              409,
              "member_limit_reached",
              "This workspace has reached its member limit. Ask an admin to upgrade the plan.",
            );
          await tx.workspaceMember.create({
            data: { workspaceId, userId: viewer.id!, role },
            select: { userId: true },
          });
          // Back in: the marker has done its job.
          await tx.workspaceRemoval.deleteMany({
            where: { workspaceId, userId: viewer.id! },
          });
        });
      } catch (err) {
        forgetEntitlements(db, workspaceId);
        // Two clicks at once: the second finds the first's membership.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          return c.json({ workspaceId, role, alreadyMember: true });
        }
        return refusal(c, err);
      }
      forgetEntitlements(db, workspaceId);
      await audit(db, {
        actorUserId: viewer.id,
        action: "workspace.member.joined",
        target: ["workspace", workspaceId],
        meta: { via: kind, role },
      });
      return c.json({ workspaceId, role, alreadyMember: false }, 201);
    },
  );
