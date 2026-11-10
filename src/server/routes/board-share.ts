import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';

import {audit} from '../../platform/auth';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {getEntitlements} from '../entitlements';
import {PERMISSIONS} from '../permissions';
import {idOf, invalid, objectOf} from '../validation';
import {boardAccess, notFound} from '../workspaces';
import {sha256Hex} from './public-board';

/**
 * Owner side of the public board link (docs/product/public-board-design.md). Mounted ONCE at `/` in `app.ts`.
 *
 *   GET    /boards/:id/share   {active}   is a link live? (never the token)
 *   POST   /boards/:id/share   create, or rotate when one exists: returns {url} ONCE (the server keeps only SHA-256)
 *   DELETE /boards/:id/share   revoke: clears the hash, visibility back to `workspace`
 *
 * Guards: validator-free (no body), withViewer, requireAuth, requirePermission('site:board:share'), withDb, then the
 * board access (workspace membership IN the query: another workspace is a 404) and board admin (403).
 * Writes also refuse a read-only workspace, an archived board, an Inbox and a private board (making a private board
 * public would widen who sees it, and the old visibility is not stored to restore it).
 */

const TOKEN_BYTES = 32; // 43 base64url characters
const OPS_PER_HOUR = 10;
const OPS_WINDOW_S = 3600;
/** Allowed lifetimes in days; absent or null means the link never expires. (The design's plan cap `public_link_max_days` is not built.) */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

/** 32 random bytes as 43 base64url characters (no padding). */
export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const shareUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/b/${token}/`;

const forbidden = (c: {json: (b: unknown, s: 403) => Response}) => c.json(problem('forbidden', 'You do not have access to this.'), 403);

export const boardShareRoutes = new Hono()
  .get('/boards/:id/share', withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_SHARE), withDb, noStore, async c => {
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, c.var.viewer.id!) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canAdmin) return forbidden(c);
    const row = await c.var.db.board.findFirst({
      where: {id: boardId, workspaceId: access.workspaceId},
      select: {visibility: true, shareTokenHash: true, shareExpiresAt: true},
    });
    if (!row) return notFound(c, 'board');
    const expired = row.shareExpiresAt !== null && row.shareExpiresAt.getTime() <= Date.now();
    return c.json({active: row.visibility === 'public' && row.shareTokenHash !== null && !expired, expiresAt: row.shareExpiresAt?.toISOString() ?? null});
  })

  .post('/boards/:id/share', withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_SHARE), withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canAdmin) return forbidden(c);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    if (access.visibility === 'private') {
      return c.json(problem('board_private', 'A private board cannot have a public link. Make it visible to the workspace first.'), 409);
    }
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);

    // Optional body {expiresInDays: 7 | 30 | 90 | null}; an empty body means "never expires".
    const body = objectOf(await c.req.json().catch(() => null));
    const days = body?.expiresInDays ?? null;
    if (days !== null && !(SHARE_EXPIRY_DAYS as readonly unknown[]).includes(days)) {
      return invalid(c, {expiresInDays: {code: 'invalid', message: 'Choose 7, 30 or 90 days, or no expiry.'}});
    }
    const expiresAt = days === null ? null : new Date(Date.now() + (days as number) * 86_400_000);

    // Rate limit per user (Site Cache counter; approximate, which is enough to stop a script).
    const key = `shareops:${userId}`;
    const n = ((await cache.get<number>(key)) ?? 0) + 1;
    await cache.set(key, n, OPS_WINDOW_S);
    if (n > OPS_PER_HOUR) {
      c.header('Retry-After', String(OPS_WINDOW_S));
      return c.json(problem('rate_limited', 'You changed public links many times. Try again later.'), 429);
    }

    const token = newShareToken();
    const hash = await sha256Hex(token);
    const {workspaceId} = access;
    // ONE conditional write: the board must still be this workspace's, a real shared board, not archived, not private.
    const rows = await db.$queryRaw<{had: string | null}[]>`
      UPDATE boards b SET share_token_hash = ${hash}, share_expires_at = ${expiresAt}::timestamptz, visibility = 'public', rev = b.rev + 1, updated_at = now()
      FROM (SELECT share_token_hash FROM boards WHERE id = ${boardId} AND workspace_id = ${workspaceId}) old
      WHERE b.id = ${boardId} AND b.workspace_id = ${workspaceId} AND b.inbox_of IS NULL
        AND b.archived_at IS NULL AND b.visibility <> 'private'
      RETURNING old.share_token_hash AS had`;
    if (!rows[0]) return notFound(c, 'board');
    const rotated = rows[0].had !== null;
    await cache.delPrefix(`pubboard:${boardId}:`);
    await audit(db, {actorUserId: userId, action: rotated ? 'board.share.rotate' : 'board.share.create', target: ['board', boardId], meta: {workspaceId, expiresInDays: typeof days === "number" ? days : null}});
    const origin = config.siteUrl ?? new URL(c.req.url).origin;
    return c.json({active: true, rotated, expiresAt: expiresAt?.toISOString() ?? null, url: shareUrl(origin, token)}, rotated ? 200 : 201);
  })

  .delete('/boards/:id/share', withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_SHARE), withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canAdmin) return forbidden(c);
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const {workspaceId} = access;
    // Idempotent: the hash is cleared whatever the state; visibility only leaves `public`.
    const rows = await db.$queryRaw<{id: number}[]>`
      UPDATE boards SET share_token_hash = NULL, share_expires_at = NULL,
        visibility = CASE WHEN visibility = 'public' THEN 'workspace' ELSE visibility END,
        rev = rev + 1, updated_at = now()
      WHERE id = ${boardId} AND workspace_id = ${workspaceId} AND inbox_of IS NULL
      RETURNING id`;
    if (!rows[0]) return notFound(c, 'board');
    await cache.delPrefix(`pubboard:${boardId}:`);
    await audit(db, {actorUserId: userId, action: 'board.share.revoke', target: ['board', boardId], meta: {workspaceId}});
    return c.json({active: false});
  });
