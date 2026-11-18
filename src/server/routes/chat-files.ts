import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {CHAT_FILE_MAX_BYTES, CHAT_FILE_TYPES, CHAT_INLINE_TYPES, chatFileShape} from '../../lib/chat-files';
import {forgetEntitlements, getEntitlements} from '../entitlements';
import {completeUpload, createUpload, fileUrl} from '../files';
import {notFound} from '../workspaces';
import {idOf, invalid, objectOf, textField} from '../validation';
import {conversationAccess, noStore, requireConversation} from './chat';

/**
 * Files sent in chat (files.md, three steps). The rows live in `attachments` (as card files do) with `message_id` set
 * once the file is sent:
 *
 *   POST   /conversations/:id/attachments   1. may I send here + the rules + room → a one-time upload URL, an unsent row
 *          (the browser PUTs the bytes straight to the storage)
 *   POST   /chat/attachments/:id/complete   3. the platform confirms the stored file; the bytes are counted (quota)
 *   DELETE /chat/attachments/:id            an unsent file taken out of the composer
 *   GET    /chat/attachments/:id/view       a sent file: the conversation's read access, then a 5-minute link
 *
 * Sending (`POST /conversations/:id/messages`, `attachmentIds`) links the uploader's own ready, unsent files of that
 * workspace to the message. Deleting the message deletes its rows; the AFTER DELETE triggers give the bytes back and
 * queue the stored file for deletion. Unsent files are swept after a day (jobs/sweeps.ts).
 */

/** Unconfirmed uploads one person may have started in the last hour (as for cards). */
const UNFINISHED_PER_HOUR = 10;
/** Files one person may have waiting in composers (uploaded, not sent yet). */
const UNSENT_MAX = 20;
/** A platform refusal that can never succeed: the unfinished row goes at once. */
const TERMINAL_UPLOAD_CODES = new Set(['E_FILE_TYPE', 'E_FILE_EMPTY', 'E_FILE_TOO_LARGE', 'E_FILE_SIZE_MISMATCH', 'E_FILE_TYPE_MISMATCH', 'E_FILE_NOT_FOUND', 'E_UPLOAD_TOKEN', 'E_UPLOAD_EXPIRED', 'E_STORAGE_LIMIT']);

class OutOfSpace extends Error {}

const uploadBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  const name = textField(v.name, 1, 200);
  if (!name.ok) return invalid(c, {name: name.error});
  const contentType = typeof v.contentType === 'string' ? v.contentType.toLowerCase().slice(0, 127) : '';
  if (!CHAT_FILE_TYPES.includes(contentType)) {
    return invalid(c, {file: {code: 'E_FILE_TYPE', message: 'Send a PDF, Word, Excel, PowerPoint, text, CSV, ZIP or picture file.'}});
  }
  const size = typeof v.size === 'number' && Number.isSafeInteger(v.size) ? v.size : 0;
  if (size < 1 || size > CHAT_FILE_MAX_BYTES) return invalid(c, {file: {code: 'E_FILE_TOO_LARGE', message: 'Pick a file from 1 byte up to 100 MB.'}});
  // A name is shown and becomes the download's file name: no path separators, quotes or control characters.
  return {name: name.value.replace(/[\\/"\u0000-\u001f\u007f]/g, '_'), contentType, size};
});

/** My unsent file (ready or not) by id, or null. Unsent = on no card and no message: only its uploader ever sees it. */
const unsentOf = (db: PrismaClient, me: number, raw: string) => {
  const id = idOf(raw);
  if (!id) return Promise.resolve(null);
  return db.attachment.findFirst({
    where: {id, uploadedBy: me, cardId: null, messageId: null, fileId: {not: null}},
    select: {id: true, workspaceId: true, fileId: true, size: true, ready: true, name: true, contentType: true},
  });
};

export const chatFileRoutes = new Hono()
  // 1. Ask for an upload URL: I may send in this conversation, the workspace may take the file, and I am not flooding.
  .post('/conversations/:id/attachments', uploadBody, withViewer, requireAuth, withDb, requireConversation('send'), noStore, async c => {
    const me = c.var.viewer.id!;
    const {db, access: a} = c.var;
    const input = c.req.valid('json');
    const hourAgo = new Date(Date.now() - 3_600_000);
    // Both caps in ONE bounded read (each count stops at its cap; the unsent one is the partial attachments_unsent_idx).
    const [ent, [caps]] = await Promise.all([
      getEntitlements(db, a.workspaceId),
      db.$queryRaw<{unfinished: number; unsent: number}[]>`
        SELECT
          (SELECT count(*) FROM (SELECT 1 FROM attachments
            WHERE uploaded_by = ${me} AND ready = false AND file_id IS NOT NULL AND created_at >= ${hourAgo} LIMIT ${UNFINISHED_PER_HOUR}) u)::int AS unfinished,
          (SELECT count(*) FROM (SELECT 1 FROM attachments
            WHERE uploaded_by = ${me} AND card_id IS NULL AND message_id IS NULL AND file_id IS NOT NULL LIMIT ${UNSENT_MAX}) w)::int AS unsent`,
    ]);
    const unfinished = caps?.unfinished ?? 0;
    const unsent = caps?.unsent ?? 0;
    if (!ent) return notFound(c, 'workspace');
    if (ent.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    if (input.size > ent.limits.maxFileBytes) return c.json(problem('file_too_large', "That file is over your plan's file size limit."), 413);
    if (ent.usage.storageUsedBytes + input.size > ent.limits.storageQuotaBytes) {
      return c.json(problem('storage_quota', 'This workspace is out of file space. Remove files or upgrade the plan.'), 402);
    }
    if (unfinished >= UNFINISHED_PER_HOUR || unsent >= UNSENT_MAX) {
      c.header('Retry-After', '60');
      return c.json(problem('rate_limited', 'Too many files waiting to be sent. Send or remove some first.'), 429);
    }
    const grant = await createUpload(c.req.url, input); // private by default
    if (!grant.ok) {
      // E_STORAGE_NEEDS_PACK / E_STORAGE_OFF / E_STORAGE_LIMIT…: the client shows the words (the owner has to act).
      return c.json(problem(grant.code, grant.message), grant.status === 402 ? 402 : grant.status >= 500 ? 503 : 400);
    }
    const row = await db.attachment.create({
      data: {workspaceId: a.workspaceId, fileId: grant.data.file.id, name: input.name, contentType: input.contentType, size: input.size, ready: false, uploadedBy: me},
      select: {id: true},
    });
    return c.json({attachmentId: row.id, upload: grant.data.upload}, 201);
  })

  // 3. The bytes are stored: the platform confirms, then the space is reserved with ONE conditional UPDATE.
  .post('/chat/attachments/:id/complete', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const row = await unsentOf(db, me, c.req.param('id'));
    if (!row || !row.fileId) return notFound(c, 'file');
    if (row.ready) return c.json({attachment: chatFileShape(row)});
    const done = await completeUpload(c.req.url, row.fileId);
    if (!done.ok) {
      // A refusal that can never succeed: the row goes now (the trigger queues the stored file). "Not uploaded yet"
      // can be retried.
      if (TERMINAL_UPLOAD_CODES.has(done.code)) await db.attachment.deleteMany({where: {id: row.id, uploadedBy: me, ready: false}});
      return c.json(problem(done.code, done.message), done.status === 402 ? 402 : 400);
    }
    // Still in the workspace (removed since asking for the link: the file never counts against its space).
    const [ent, member] = await Promise.all([
      getEntitlements(db, row.workspaceId),
      db.workspaceMember.findFirst({where: {workspaceId: row.workspaceId, userId: me}, select: {userId: true}}),
    ]);
    if (!member) {
      await db.attachment.deleteMany({where: {id: row.id, uploadedBy: me, ready: false}});
      return notFound(c, 'file');
    }
    const quota = ent?.limits.storageQuotaBytes ?? 0;
    try {
      const flipped = await db.$transaction(async tx => {
        const {count} = await tx.attachment.updateMany({where: {id: row.id, uploadedBy: me, ready: false}, data: {ready: true}});
        if (count === 0) return false; // a second confirm: already counted
        const reserved = await tx.$executeRaw`
          UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ${row.size}
          WHERE id = ${row.workspaceId} AND archived_at IS NULL AND storage_used_bytes + ${row.size} <= ${quota}`;
        if (reserved === 0) throw new OutOfSpace();
        return true;
      });
      if (flipped) forgetEntitlements(db, row.workspaceId);
      return c.json({attachment: chatFileShape(row)});
    } catch (error) {
      if (!(error instanceof OutOfSpace)) throw error;
      // Not ready, so no bytes to give back; the AFTER DELETE trigger queues the stored file for deletion.
      await db.attachment.deleteMany({where: {id: row.id, uploadedBy: me, ready: false}});
      return c.json(problem('storage_quota', 'This workspace is out of file space. Remove files or upgrade the plan.'), 402);
    }
  })

  // Taken out of the composer before sending. A sent file goes with its message (delete the message).
  .delete('/chat/attachments/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const row = await unsentOf(db, me, c.req.param('id'));
    if (!row) return notFound(c, 'file');
    // The triggers give the bytes back (when it was ready) and queue the stored file for deletion.
    await db.attachment.deleteMany({where: {id: row.id, uploadedBy: me, cardId: null, messageId: null}});
    forgetEntitlements(db, row.workspaceId);
    return c.json({ok: true});
  })

  // Show or download a sent file: whoever may read the conversation, now. Never a saved link.
  .get('/chat/attachments/:id/view', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'file');
    const row = await db.attachment.findFirst({
      where: {id, ready: true, fileId: {not: null}, messageId: {not: null}, message: {deletedAt: null}},
      select: {fileId: true, contentType: true, workspaceId: true, message: {select: {conversationId: true, workspaceId: true}}},
    });
    if (!row?.fileId || !row.message || row.message.workspaceId !== row.workspaceId) return notFound(c, 'file');
    const a = await conversationAccess(db, row.message.conversationId, me);
    if (!a || a.workspaceId !== row.workspaceId) return notFound(c, 'file');
    const download = c.req.query('download') === '1' || !CHAT_INLINE_TYPES.includes(row.contentType);
    const link = await fileUrl(c.req.url, row.fileId, {expiresIn: 300, download});
    if (!link.ok) return c.json(problem(link.code, link.message), 400);
    // Never cached (withViewer marks every answer `private, no-store`): each view checks access again.
    return c.redirect(link.data.url, 302);
  });
