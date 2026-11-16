import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";

import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import {
  problem,
  requireAuth,
  withDb,
  withViewer,
} from "../../platform/guards";
import { idOf, invalid, objectOf } from "../validation";

/**
 * In-app notifications (SPEC Phase 4). Every row is the visitor's own: `user_id` is IN every `where`.
 * Rows of a workspace the visitor left, or of a board or chat they lost access to, are left out. Another person's notification id answers 404.
 *
 *   GET  /notifications?before=&unread=1&workspaceId=   newest first, keyset on id (20 a page)
 *   GET  /notifications/unread-count                    exact up to 99, then 99 with `more: true`
 *   POST /notifications/:id/read                        mark one read
 *   POST /notifications/read-all                        {workspaceId?} mark mine read
 * Ids are BigInt: serialized as strings. Actors are shown by name, never by email.
 */
const PAGE = 20;
/** Most rows one list call looks at (visible or not): a user who lost access to many boards never triggers a long scan. */
const SCAN = 100;
const COUNT_CAP = 99;
/** Unread rows the badge count looks at before the visibility check (bounds the work for rows the user can no longer see). */
const SCAN_CAP = 5000;

const noStore = createMiddleware(async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

const bigId = (value: unknown): bigint | undefined => {
  if (typeof value !== "string" || !/^\d{1,18}$/.test(value)) return undefined;
  const n = BigInt(value);
  return n > 0n ? n : undefined;
};

const listQuery = validator("query", (value, c) => {
  const before =
    typeof value.before === "string" && value.before !== ""
      ? bigId(value.before)
      : undefined;
  if (
    typeof value.before === "string" &&
    value.before !== "" &&
    before === undefined
  ) {
    return invalid(c, {
      before: {
        code: "invalid",
        message: "Use the cursor from the previous page.",
      },
    });
  }
  const workspaceRaw =
    typeof value.workspaceId === "string" && value.workspaceId !== ""
      ? value.workspaceId
      : undefined;
  const workspaceId = workspaceRaw ? idOf(workspaceRaw) : undefined;
  if (workspaceRaw && !workspaceId)
    return invalid(c, {
      workspaceId: { code: "invalid", message: "Choose a workspace." },
    });
  return { before, workspaceId, unread: value.unread === "1" };
});

const readAllBody = validator("json", (value, c) => {
  const body = objectOf(value) ?? {};
  if (body.workspaceId === undefined || body.workspaceId === null)
    return { workspaceId: undefined };
  const workspaceId = idOf(String(body.workspaceId));
  if (typeof body.workspaceId !== "number" || !workspaceId)
    return invalid(c, {
      workspaceId: { code: "invalid", message: "Choose a workspace." },
    });
  return { workspaceId };
});

/**
 * SQL (alias `n` = notifications) that keeps only rows whose board or chat the visitor may still see: a private
 * board needs a seat (or workspace owner/admin), a DM or group needs a membership row, a board chat follows its
 * board, a channel follows the workspace membership. A row that lost its target is EXCLUDED (list and count), not
 * returned hollow. All values are bound parameters.
 */
function visibleSql(userId: number): Prisma.Sql {
  const boardOk = (boardId: Prisma.Sql) => Prisma.sql`EXISTS (
    SELECT 1 FROM boards b
    WHERE b.id = ${boardId} AND b.workspace_id = n.workspace_id
      AND (b.inbox_of IS NULL OR b.inbox_of = ${userId})
      AND (b.visibility <> 'private'
        OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${userId})
        OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = b.workspace_id AND wm.user_id = ${userId} AND wm.role IN ('owner', 'admin'))))`;
  return Prisma.sql`(n.board_id IS NULL OR ${boardOk(Prisma.sql`n.board_id`)})
    AND (n.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations cv
      WHERE cv.id = n.conversation_id AND cv.workspace_id = n.workspace_id
        AND (cv.kind = 'channel'
          OR (cv.kind = 'board' AND cv.board_id IS NOT NULL AND ${boardOk(Prisma.sql`cv.board_id`)})
          OR (cv.kind NOT IN ('channel', 'board')
            AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = cv.id AND cm.user_id = ${userId})))))`;
}

type Row = {
  id: bigint;
  workspace_id: number;
  kind: string;
  actor_id: number | null;
  board_id: number | null;
  card_id: number | null;
  conversation_id: number | null;
  read_at: Date | null;
  created_at: Date;
};

export const notificationRoutes = new Hono()
  .use("/notifications/*", noStore)

  .get(
    "/notifications",
    listQuery,
    withViewer,
    requireAuth,
    withDb,
    async (c) => {
      const { db, viewer } = c.var;
      const { before, workspaceId, unread } = c.req.valid("query");
      // ONE query. Only workspaces I am a member of (and not archived) are in scope; at most SCAN candidate rows
      // (newest first, owner + keyset in the index), each checked for visibility; rows whose board or chat the visitor
      // lost are skipped, never scanned without limit. The actor's name and a digest row's numbers come in the same read.
      const candidates = await db.$queryRaw<
        (Row & {
          visible: boolean;
          actor_name: string | null;
          due_count: number | null;
          overdue_count: number | null;
          mention_count: number | null;
        })[]
      >`
        SELECT n.id, n.workspace_id, n.kind, n.actor_id, n.board_id, n.card_id, n.conversation_id, n.read_at, n.created_at,
          (${visibleSql(viewer.id!)}) AS visible,
          u.name AS actor_name, d.due_count, d.overdue_count, d.mention_count
        FROM (
          SELECT * FROM notifications x
          WHERE x.user_id = ${viewer.id!}
            ${workspaceId ? Prisma.sql`AND x.workspace_id = ${workspaceId}` : Prisma.empty}
            AND EXISTS (
              SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id AND w.archived_at IS NULL
              WHERE wm.workspace_id = x.workspace_id AND wm.user_id = ${viewer.id!})
            ${unread ? Prisma.sql`AND x.read_at IS NULL` : Prisma.empty}
            ${before ? Prisma.sql`AND x.id < ${before}` : Prisma.empty}
          ORDER BY x.id DESC
          LIMIT ${SCAN}
        ) n
        LEFT JOIN users u ON u.id = n.actor_id
        LEFT JOIN digests d ON n.kind = 'digest' AND d.notification_id = n.id AND d.user_id = ${viewer.id!}
        ORDER BY n.id DESC`;
      type Candidate = (typeof candidates)[number];
      const page: Candidate[] = [];
      let lastSeen: bigint | null = null;
      let stoppedEarly = false;
      for (const r of candidates) {
        if (page.length === PAGE) {
          stoppedEarly = true;
          break;
        }
        lastSeen = r.id;
        if (r.visible) page.push(r);
      }
      // More to fetch when the scan was cut by the page size or by the SCAN bound (the next call continues after the last row looked at).
      const hasMore = stoppedEarly || candidates.length === SCAN;
      return c.json({
        items: page.map((r) => ({
          digest:
            r.kind === "digest" && r.due_count !== null
              ? {
                  due: r.due_count,
                  overdue: r.overdue_count!,
                  mentions: r.mention_count!,
                }
              : null,
          id: String(r.id),
          workspaceId: r.workspace_id,
          kind: r.kind,
          actor:
            r.actor_id === null
              ? null
              : { id: r.actor_id, name: r.actor_name ?? null },
          boardId: r.board_id,
          // A card is only meaningful with its board.
          cardId: r.board_id === null ? null : r.card_id,
          conversationId: r.conversation_id,
          read: r.read_at !== null,
          createdAt: r.created_at,
        })),
        nextBefore: hasMore && lastSeen !== null ? String(lastSeen) : null,
      });
    },
  )

  .get(
    "/notifications/unread-count",
    withViewer,
    requireAuth,
    withDb,
    async (c) => {
      const { db, viewer } = c.var;
      // ONE query: my unread, still-visible rows joined to my live (not archived) workspaces; at most COUNT_CAP + 1 rows are read.
      // The inner scan is capped at SCAN_CAP newest unread rows BEFORE the per-row visibility check, so a pathological history never
      // makes the count walk it all. Rows of lost access are deleted when access goes (notification-cleanup.ts), so the cap is a safety net
      // (index user_id, read_at, id), not a limit anyone reaches; the visible-row LIMIT stops the scan at 100 anyway.
      const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM (
          SELECT n.id, n.workspace_id, n.board_id, n.conversation_id FROM notifications n
          WHERE n.user_id = ${viewer.id!} AND n.read_at IS NULL
          ORDER BY n.id DESC LIMIT ${SCAN_CAP}
        ) n
        JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.user_id = ${viewer.id!}
        JOIN workspaces w ON w.id = wm.workspace_id AND w.archived_at IS NULL
        WHERE ${visibleSql(viewer.id!)}
        LIMIT ${COUNT_CAP + 1}
      ) t`;
      const n = row?.n ?? 0;
      return c.json({ count: Math.min(n, COUNT_CAP), more: n > COUNT_CAP });
    },
  )

  .post(
    "/notifications/read-all",
    readAllBody,
    withViewer,
    requireAuth,
    withDb,
    async (c) => {
      const { db, viewer } = c.var;
      const { workspaceId } = c.req.valid("json");
      const result = await db.notification.updateMany({
        where: {
          userId: viewer.id!,
          readAt: null,
          ...(workspaceId ? { workspaceId } : {}),
        },
        data: { readAt: new Date() },
      });
      return c.json({ updated: result.count });
    },
  )

  .post(
    "/notifications/:id/read",
    withViewer,
    requireAuth,
    withDb,
    async (c) => {
      const id = bigId(c.req.param("id"));
      if (!id)
        return c.json(problem("not_found", "No such notification."), 404);
      const { db, viewer } = c.var;
      // Owner IN the where: someone else's notification is a 404. Already read stays read (readAt keeps its first value).
      // The usual case (unread) is ONE statement; only when nothing changed is it looked up (already read, or not theirs).
      const { count } = await db.notification.updateMany({
        where: { id, userId: viewer.id!, readAt: null },
        data: { readAt: new Date() },
      });
      if (count === 0) {
        const found = await db.notification.findFirst({
          where: { id, userId: viewer.id! },
          select: { id: true },
        });
        if (!found)
          return c.json(problem("not_found", "No such notification."), 404);
      }
      return c.json({ id: String(id), read: true });
    },
  );
