import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import {requireAuth, withDb, withViewer} from '../../platform/guards';
import {getEntitlements} from '../entitlements';
import {notFound, requireWorkspaceRole} from '../workspaces';

/**
 * The workspace's own audit log (Team plan feature `auditLog`, SPEC §10): who did what to its members, boards,
 * sharing, chat moderation and automations, newest first.
 *
 *   GET /site-api/workspaces/:id/audit?before=<event id>   workspace owners and admins (others: 403, outsiders: 404)
 *
 * The plan does not have the feature: 200 `{available: false, events: []}` (the screen shows the upgrade prompt).
 * Events come from the platform's `audit_events` (written by `audit()` everywhere), matched to the workspace by
 * their target: the workspace itself, one of its boards (not personal Inbox boards), or a channel / message /
 * automation event whose `meta.workspaceId` is this workspace. Site-level events (billing mode, plan limits,
 * branding, staff listings) never appear here.
 *
 * Output is curated, never the raw `meta`: names only (never an email), and a from / to role or plan.
 */

const PAGE_SIZE = 30;
const BEFORE = /^[1-9]\d{0,17}$/;
const SHORT = /^[a-z0-9_-]{1,24}$/;

const query = validator('query', value => {
  const raw = typeof value.before === 'string' ? value.before : '';
  return {before: BEFORE.test(raw) ? BigInt(raw) : null};
});

type Row = {
  id: bigint;
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  meta: unknown;
  created_at: Date;
  label: string | null;
};

/** The ids of the people an event names besides its actor (`meta` keys written by the routes that audit). */
function subjectIdOf(action: string, meta: Record<string, unknown>): number | null {
  const raw = action === 'workspace.ownership_transferred' ? meta.to : action === 'chat.message_deleted' ? meta.senderId : meta.userId;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

const short = (value: unknown): string | null => (typeof value === 'string' && SHORT.test(value) ? value : null);

export const workspaceAuditRoutes = new Hono().get(
  '/workspaces/:id/audit',
  query,
  withViewer,
  requireAuth,
  withDb,
  requireWorkspaceRole('admin'),
  async c => {
    const {db, workspaceId} = c.var;
    const {before} = c.req.valid('query');
    c.header('Cache-Control', 'private, no-store');

    const entitlements = await getEntitlements(db, workspaceId);
    if (!entitlements) return notFound(c);
    if (!entitlements.features.auditLog) return c.json({available: false as const, events: [], nextBefore: null});

    const ws = String(workspaceId);
    const older = before ? Prisma.sql`AND e.id < ${before}` : Prisma.empty;
    const take = PAGE_SIZE + 1;
    // ONE prepared statement: three index-backed branches, each already newest-first and limited, then merged.
    const rows = await db.$queryRaw<Row[]>`
      SELECT id, actor_user_id, action, target_type, meta, created_at, label FROM (
        (SELECT e.id, e.actor_user_id, e.action, e.target_type, e.meta, e.created_at, NULL::text AS label
           FROM audit_events e
          WHERE e.target_type = 'workspace' AND e.target_id = ${ws} ${older}
          ORDER BY e.id DESC LIMIT ${take})
        UNION ALL
        (SELECT e.id, e.actor_user_id, e.action, e.target_type, e.meta, e.created_at, b.name::text AS label
           FROM boards b
           JOIN audit_events e ON e.target_type = 'board' AND e.target_id = b.id::text
          WHERE b.workspace_id = ${workspaceId} AND b.inbox_of IS NULL ${older}
          ORDER BY e.id DESC LIMIT ${take})
        UNION ALL
        (SELECT e.id, e.actor_user_id, e.action, e.target_type, e.meta, e.created_at, COALESCE(f.name, cv.name)::text AS label
           FROM audit_events e
           LEFT JOIN flows f ON e.target_type = 'flow' AND f.workspace_id = ${workspaceId} AND f.id::text = e.target_id
           LEFT JOIN conversations cv ON e.target_type IN ('conversation', 'message') AND cv.workspace_id = ${workspaceId}
                AND cv.kind = 'channel'
                AND cv.id::text = CASE WHEN e.target_type = 'conversation' THEN e.target_id ELSE e.meta->>'conversationId' END
          WHERE e.target_type IN ('conversation', 'message', 'flow') AND e.meta->>'workspaceId' = ${ws} ${older}
          ORDER BY e.id DESC LIMIT ${take})
      ) merged
      ORDER BY id DESC
      LIMIT ${take}`;

    const page = rows.slice(0, PAGE_SIZE);
    const metas = page.map(row => (row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? (row.meta as Record<string, unknown>) : {}));
    const people = new Set<number>();
    page.forEach((row, i) => {
      if (row.actor_user_id) people.add(row.actor_user_id);
      const subject = subjectIdOf(row.action, metas[i]!);
      if (subject) people.add(subject);
    });
    // Names only (never an email), one query for the whole page.
    const users = people.size
      ? await db.user.findMany({where: {id: {in: [...people]}}, select: {id: true, name: true}, take: people.size})
      : [];
    const nameOf = new Map(users.map(user => [user.id, user.name]));
    const person = (id: number | null) => (id ? {id, name: nameOf.get(id) ?? null} : null);

    return c.json({
      available: true as const,
      events: page.map((row, i) => {
        const meta = metas[i]!;
        return {
          id: String(row.id),
          at: row.created_at.toISOString(),
          action: row.action,
          actor: person(row.actor_user_id),
          subject: person(subjectIdOf(row.action, meta)),
          target: row.target_type && row.target_type !== 'workspace' ? {type: row.target_type, name: row.label} : null,
          // Roles or plans only (`to` of an ownership transfer is a user id: that one is the subject).
          detail: {from: short(meta.from), to: short(meta.to)},
        };
      }),
      nextBefore: rows.length > PAGE_SIZE ? String(page.at(-1)!.id) : null,
    });
  },
);
