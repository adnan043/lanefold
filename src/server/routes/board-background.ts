import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {BG_IMAGE_MAX_BYTES, BG_IMAGE_TYPES, bgImageUrl} from '../bg-image';
import {forgetEntitlements, getEntitlements} from '../entitlements';
import {completeUpload, createUpload, deleteFile, fileUrl} from '../files';
import {notFound} from '../workspaces';
import {idOf, intField, invalid, objectOf, textField} from '../validation';
import {boardFor, bumpRev, noStore, refused} from './boards';

/**
 * A board's background photo (docs/agent/files.md, three steps). Mounted at `/` in `app.ts`.
 *
 *   POST   /boards/:id/background/upload                step 1: checks, one-time upload URL, an unfinished row
 *   POST   /boards/:id/background/:uploadId/complete    step 3: confirm, reserve space, make it the background
 *   GET    /boards/:id/background                       access check, then a short link to the photo
 *   DELETE /boards/:id/background                       remove the photo (the board goes back to its colour)
 *
 * The photo is an `attachments` row with no card and no message: the table's triggers give its bytes back
 * to the workspace and queue the stored file for deletion whenever the row goes, and the sweep removes an
 * upload never confirmed. `boards.bg_file_id` points at it. Changing the photo, uploading and removing are for
 * board admins (like the rest of the board's settings); seeing it is for anyone who can see the board.
 */

const UNFINISHED_UPLOADS = 10;
const TERMINAL_UPLOAD_CODES = new Set(['E_FILE_TYPE', 'E_FILE_EMPTY', 'E_FILE_TOO_LARGE', 'E_FILE_SIZE_MISMATCH', 'E_FILE_NOT_FOUND', 'E_UPLOAD_TOKEN', 'E_UPLOAD_EXPIRED', 'E_STORAGE_LIMIT']);
const BAD_IMAGE = {code: 'bg_image_invalid', message: 'Pick a PNG, JPEG, WebP, GIF or AVIF image up to 10 MB.'};

class OutOfSpace extends Error {}

const uploadBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  const name = textField(v.name, 1, 200);
  if (!name.ok) return invalid(c, {name: name.error});
  const contentType = typeof v.contentType === 'string' ? v.contentType.toLowerCase().slice(0, 127) : '';
  if (!BG_IMAGE_TYPES.has(contentType)) return invalid(c, {file: BAD_IMAGE});
  const size = intField(v.size, 1, BG_IMAGE_MAX_BYTES);
  if (!size.ok) return invalid(c, {file: BAD_IMAGE});
  return {name: name.value.replace(/[\\/]/g, '_'), contentType, size: size.value};
});

export const boardBackgroundRoutes = new Hono()
  .post('/boards/:id/background/upload', uploadBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(db, userId, idOf(c.req.param('id')), 'admin');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const input = c.req.valid('json');
    const [ent, unfinished] = await Promise.all([
      getEntitlements(db, workspaceId),
      // Bounded: at most UNFINISHED_UPLOADS rows, on the (uploaded_by, created_at) index.
      db.attachment.findMany({where: {uploadedBy: userId, ready: false, fileId: {not: null}, createdAt: {gte: new Date(Date.now() - 3_600_000)}}, take: UNFINISHED_UPLOADS, select: {id: true}}),
    ]);
    if (!ent) return notFound(c, 'workspace');
    if (input.size > ent.limits.maxFileBytes) return c.json(problem('file_too_large', "That file is over your plan's file size limit."), 413);
    if (ent.usage.storageUsedBytes + input.size > ent.limits.storageQuotaBytes) {
      return c.json(problem('storage_quota', 'This workspace is out of file space. Remove files or upgrade the plan.'), 402);
    }
    if (unfinished.length >= UNFINISHED_UPLOADS) return c.json(problem('rate_limited', 'Too many uploads at once. Wait a moment and try again.'), 429);
    const grant = await createUpload(c.req.url, input); // private: shown only through GET /boards/:id/background
    if (!grant.ok) {
      const status = grant.status === 402 ? 402 : grant.status >= 500 ? 503 : 400;
      return c.json(problem(grant.code, grant.message), status);
    }
    const row = await db.attachment.create({
      data: {workspaceId, cardId: null, fileId: grant.data.file.id, name: input.name, contentType: input.contentType, size: input.size, ready: false, uploadedBy: userId},
      select: {id: true},
    });
    return c.json({uploadId: row.id, upload: grant.data.upload}, 201);
  })

  .post('/boards/:id/background/:uploadId/complete', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(db, userId, idOf(c.req.param('id')), 'admin');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const boardId = ctx.boardId;
    const uploadId = idOf(c.req.param('uploadId'));
    if (!uploadId) return notFound(c, 'file');
    // Only my own unfinished background upload in this workspace (never a card's or a message's file).
    const row = await db.attachment.findFirst({
      where: {id: uploadId, workspaceId, cardId: null, messageId: null, uploadedBy: userId, fileId: {not: null}},
      select: {id: true, fileId: true, size: true, ready: true},
    });
    if (!row?.fileId) return notFound(c, 'file');
    const fileId = row.fileId;
    if (row.ready) return c.json({ok: true, bgKind: ctx.access.bgKind, bgImage: bgImageUrl(boardId, ctx.access.bgFileId)});
    const done = await completeUpload(c.req.url, fileId);
    if (!done.ok) {
      if (TERMINAL_UPLOAD_CODES.has(done.code)) await db.attachment.deleteMany({where: {id: row.id, workspaceId, ready: false}});
      return c.json(problem(done.code, done.message), done.status === 402 ? 402 : 400);
    }
    const ent = await getEntitlements(db, workspaceId);
    const quota = ent?.limits.storageQuotaBytes ?? 0;
    try {
      const rev = await db.$transaction(async tx => {
        const next = await bumpRev(tx, boardId, workspaceId); // locks the board: two photos land one after the other
        const flipped = await tx.attachment.updateMany({where: {id: row.id, workspaceId, cardId: null, ready: false}, data: {ready: true}});
        if (flipped.count === 0) return null; // a second confirm: already counted
        const reserved = await tx.$executeRaw`
          UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ${row.size}
          WHERE id = ${workspaceId} AND storage_used_bytes + ${row.size} <= ${quota}`;
        if (reserved === 0) throw new OutOfSpace();
        const before = await tx.board.findFirst({where: {id: boardId, workspaceId}, select: {bgFileId: true}});
        await tx.board.updateMany({where: {id: boardId, workspaceId}, data: {bgKind: 'image', bgFileId: fileId}});
        // The previous photo goes: its row's triggers give the space back and queue the stored file for deletion.
        if (before?.bgFileId && before.bgFileId !== fileId) {
          await tx.attachment.deleteMany({where: {workspaceId, fileId: before.bgFileId, cardId: null, messageId: null}});
        }
        await tx.activity.create({data: {workspaceId, boardId, actorId: userId, kind: 'board.updated'}});
        return next;
      });
      forgetEntitlements(db, workspaceId);
      return c.json({ok: true, ...(rev === null ? {} : {rev: String(rev)}), bgKind: 'image', bgImage: bgImageUrl(boardId, fileId)});
    } catch (error) {
      if (!(error instanceof OutOfSpace)) throw error;
      await Promise.all([deleteFile(c.req.url, fileId), db.attachment.deleteMany({where: {id: row.id, workspaceId, ready: false}})]);
      return c.json(problem('storage_quota', 'This workspace is out of file space. Remove files or upgrade the plan.'), 402);
    }
  })

  // Shown as a CSS background: access first (the same read as the board), then a short link. Never a saved link.
  .get('/boards/:id/background', withViewer, requireAuth, withDb, async c => {
    const ctx = await boardFor(c.var.db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) {
      c.header('Cache-Control', 'private, no-store');
      return c.json(ctx.body, ctx.status);
    }
    const fileId = ctx.access.bgFileId;
    if (!fileId) {
      c.header('Cache-Control', 'private, no-store');
      return notFound(c, 'file');
    }
    const link = await fileUrl(c.req.url, fileId, {expiresIn: 3600});
    if (!link.ok) {
      c.header('Cache-Control', 'private, no-store');
      return c.json(problem(link.code, link.message), link.status === 404 ? 404 : 503);
    }
    // The link lasts an hour; this browser may reuse the redirect for 5 minutes (one person's, never shared).
    c.header('Cache-Control', 'private, max-age=300');
    return c.redirect(link.data.url, 302);
  })

  .delete('/boards/:id/background', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(db, userId, idOf(c.req.param('id')), 'admin');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {workspaceId} = ctx.access;
    const boardId = ctx.boardId;
    if (!ctx.access.bgFileId) return notFound(c, 'file');
    const out = await db.$transaction(async tx => {
      const next = await bumpRev(tx, boardId, workspaceId);
      const before = await tx.board.findFirst({where: {id: boardId, workspaceId}, select: {bgFileId: true, bgKind: true}});
      if (!before?.bgFileId) return null;
      const bgKind = before.bgKind === 'image' ? 'color' : before.bgKind;
      await tx.board.updateMany({where: {id: boardId, workspaceId}, data: {bgFileId: null, bgKind}});
      await tx.attachment.deleteMany({where: {workspaceId, fileId: before.bgFileId, cardId: null, messageId: null}});
      await tx.activity.create({data: {workspaceId, boardId, actorId: userId, kind: 'board.updated'}});
      return {rev: next, bgKind};
    });
    if (!out) return notFound(c, 'file');
    forgetEntitlements(db, workspaceId);
    return c.json({ok: true, rev: String(out.rev), bgKind: out.bgKind, bgImage: null});
  });
