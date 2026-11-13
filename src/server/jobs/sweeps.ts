import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {forgetEntitlements, startGraceForWorkspaces} from '../entitlements';
import {cutoff, DEFAULT_RETENTION, DELETE_BATCH, keepDays, MAX_DELETE_BATCHES, MAX_PAGES, nextCursor, PAGE_SIZE} from './logic';

const UPLOAD_BATCH = 25;
const UPLOAD_BATCHES = 4;

/** Daily: workspaces whose paid membership ended go back to the free plan. Idempotent, keyset-paged. */
export async function sweepEndedMemberships(db: PrismaClient): Promise<{moved: number}> {
  const free = await db.planLimit.findUnique({where: {plan: 'free'}, select: {maxMembers: true}});
  if (!free) return {moved: 0};
  let cursor = 0;
  let moved = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    // The subscription is matched to the workspace it paid for (memberships.workspace_id). Older rows without a
    // workspace (NULL) are never matched by user: they cannot downgrade anything.
    const rows = await db.$queryRaw<{id: number; plan: string}[]>`
      SELECT w.id, w.plan
      FROM workspaces w
      JOIN plan_limits p ON p.plan = w.plan AND p.price_key_monthly <> ''
      WHERE w.id > ${cursor} AND w.plan <> 'free'
        AND EXISTS (
          SELECT 1 FROM memberships m WHERE m.workspace_id = w.id AND m.price_key = p.price_key_monthly)
        AND NOT EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.workspace_id = w.id AND m.price_key = p.price_key_monthly
            AND (m.status IN ('active', 'trialing', 'past_due') OR m.access_ends_at > now()))
      ORDER BY w.id LIMIT ${PAGE_SIZE}`;
    if (rows.length) {
      // ONE statement for the page. Conditional on the plan we read: a repeat or a concurrent upgrade changes nothing.
      const moves = await db.$queryRaw<{id: number; from_plan: string}[]>`
        UPDATE workspaces w SET plan = 'free', member_limit = ${free.maxMembers}
        FROM unnest(${rows.map(r => r.id)}::int[], ${rows.map(r => r.plan)}::text[]) AS r(id, plan)
        WHERE w.id = r.id AND w.plan = r.plan
        RETURNING w.id, r.plan AS from_plan`;
      if (moves.length) {
        moved += moves.length;
        await startGraceForWorkspaces(db, moves.map(m => m.id));
        for (const m of moves) forgetEntitlements(db, m.id);
        // One insert for the page's audit rows (the audit helper writes one row per call).
        try {
          await db.auditEvent.createMany({
            data: moves.map(m => ({
              actorUserId: null,
              action: 'workspace.plan_changed',
              targetType: 'workspace',
              targetId: String(m.id),
              meta: {from: m.from_plan, to: 'free', by: 'sweep'},
            })),
          });
        } catch (err) {
          console.error(`audit workspace.plan_changed: ${(err as Error).message}`);
        }
      }
    }
    const next = nextCursor(rows);
    if (next === null) break;
    cursor = next;
  }
  return {moved};
}

/** Daily: start the grace clock for workspaces now over their limits, drop it for those back under. */
export async function sweepGrace(db: PrismaClient): Promise<{checked: number}> {
  let cursor = 0;
  let checked = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await db.$queryRaw<{id: number}[]>`
      SELECT w.id
      FROM workspaces w
      JOIN plan_limits p ON p.plan = w.plan
      JOIN app_settings s ON s.id = 1
      WHERE w.id > ${cursor}
        AND (
          (s.billing_mode = 'PAID' AND w.grace_until IS NULL
            AND (w.member_count > p.max_members OR w.storage_used_bytes > p.storage_quota_bytes))
          OR (w.grace_until IS NOT NULL
            AND (s.billing_mode = 'FREE_FOR_ALL' OR (w.member_count <= p.max_members AND w.storage_used_bytes <= p.storage_quota_bytes))))
      ORDER BY w.id LIMIT ${PAGE_SIZE}`;
    if (rows.length) {
      const ids = rows.map(r => r.id);
      await startGraceForWorkspaces(db, ids);
      for (const id of ids) forgetEntitlements(db, id);
      checked += ids.length;
    }
    const next = nextCursor(rows);
    if (next === null) break;
    cursor = next;
  }
  return {checked};
}

/** Daily: delete old expired/used invites, expired/revoked join links and old read notifications and abandoned uploads, in bounded batches. */
export async function cleanupOld(db: PrismaClient, data: unknown, now = Date.now()): Promise<{invites: number; joinLinks: number; notifications: number; uploads: number}> {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const inviteBefore = cutoff(now, keepDays(d.inviteDays, DEFAULT_RETENTION.inviteDays));
  const notifBefore = cutoff(now, keepDays(d.notificationDays, DEFAULT_RETENTION.notificationDays));
  let invites = 0;
  let joinLinks = 0;
  let notifications = 0;
  let uploads = 0;

  let cursor = 0;
  for (let i = 0; i < MAX_DELETE_BATCHES; i++) {
    const rows = await db.$queryRaw<{id: number}[]>`
      WITH batch AS (
        SELECT id FROM workspace_invites
        WHERE id > ${cursor} AND (expires_at < ${inviteBefore} OR used_at < ${inviteBefore})
        ORDER BY id LIMIT ${DELETE_BATCH})
      DELETE FROM workspace_invites WHERE id IN (SELECT id FROM batch) RETURNING id`;
    invites += rows.length;
    if (rows.length < DELETE_BATCH) break;
    cursor = Math.max(...rows.map(r => r.id));
  }

  cursor = 0;
  for (let i = 0; i < MAX_DELETE_BATCHES; i++) {
    const rows = await db.$queryRaw<{id: number}[]>`
      WITH batch AS (
        SELECT id FROM workspace_join_links
        WHERE id > ${cursor} AND (expires_at < ${inviteBefore} OR revoked_at < ${inviteBefore})
        ORDER BY id LIMIT ${DELETE_BATCH})
      DELETE FROM workspace_join_links WHERE id IN (SELECT id FROM batch) RETURNING id`;
    joinLinks += rows.length;
    if (rows.length < DELETE_BATCH) break;
    cursor = Math.max(...rows.map(r => r.id));
  }

  // Oldest read rows first on notifications_read_at_idx: each batch reads only rows it deletes (deleted rows are gone,
  // so no cursor), instead of walking the table by id and skipping unread rows.
  for (let i = 0; i < MAX_DELETE_BATCHES; i++) {
    const rows = await db.$queryRaw<{id: bigint}[]>`
      WITH batch AS (
        SELECT id FROM notifications
        WHERE read_at < ${notifBefore}
        ORDER BY read_at LIMIT ${DELETE_BATCH})
      DELETE FROM notifications WHERE id IN (SELECT id FROM batch) RETURNING id`;
    notifications += rows.length;
    if (rows.length < DELETE_BATCH) break;
  }

  // Abandoned uploads: a row created at step 1 (files.md) that was never confirmed, older than an hour (the upload route only counts the last hour). The stored
  // file goes first through the platform; a row stays for the next run when the platform could not delete it.
  const staleUpload = new Date(now - 3_600_000);
  // A row the platform keeps refusing to delete stays forever, so a run never starts at id 0 only: it starts at a
  // random id of the stale rows and pages up by id (keyset), then wraps to the front with what is left of its budget.
  const newest = await db.attachment.findFirst({where: {ready: false, createdAt: {lt: staleUpload}}, orderBy: {id: 'desc'}, select: {id: true}});
  const start = newest ? Math.floor(Math.random() * newest.id) : 0;
  let uploadCursor = start;
  let wrapped = start === 0;
  for (let i = 0; i < UPLOAD_BATCHES; i++) {
    const rows = await db.attachment.findMany({
      where: {ready: false, createdAt: {lt: staleUpload}, id: wrapped && start > 0 ? {gt: uploadCursor, lte: start} : {gt: uploadCursor}},
      orderBy: {id: 'asc'},
      take: UPLOAD_BATCH,
      select: {id: true, fileId: true},
    });
    if (!rows.length) {
      if (wrapped) break;
      wrapped = true;
      uploadCursor = 0;
      continue;
    }
    // The ROW goes first, only while it is still not ready (a /complete in between wins and the row stays); the
    // AFTER DELETE trigger queues the stored file in file_deletions and the hourly file-cleanup job removes the bytes.
    const ids = rows.map(r => r.id);
    const deleted = await db.$queryRaw<{id: number}[]>`DELETE FROM attachments WHERE id IN (${Prisma.join(ids)}) AND ready = false RETURNING id`;
    uploads += deleted.length;
    uploadCursor = rows[rows.length - 1]!.id;
    if (rows.length < UPLOAD_BATCH) {
      if (wrapped) break;
      wrapped = true;
      uploadCursor = 0;
    }
  }
  return {invites, joinLinks, notifications, uploads};
}
