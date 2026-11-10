import type {PrismaClient} from '../../generated/prisma/client';
import {SiteKeyMissing} from '../../platform/api';
import {config} from '../../platform/config';
import {deleteFile} from '../../platform/files';

/** Files per round trip, rounds per run, parallel platform calls, and tries before a file id is given up. */
const BATCH = 25;
const MAX_BATCHES = 20;
const PARALLEL = 5;
export const MAX_FILE_ATTEMPTS = 20;
const KEEP_DONE_DAYS = 7;

type Remove = (id: string) => Promise<{ok: boolean; status?: number; code?: string}>;

const platformRemove: Remove = async id => deleteFile(config.siteUrl ?? 'http://localhost', id);

/**
 * Hourly: deletes the stored bytes of files whose row is gone (the `file_deletions` outbox, filled by database
 * triggers on attachments, card covers, board backgrounds; see the account deletion migration). Keyset-paged and
 * bounded; a 404 with the platform's E_FILE_NOT_FOUND code counts as done; a 4xx or a throw (a malformed id) is a failed
 * attempt and is given up after MAX_FILE_ATTEMPTS (logged by id, never a secret); status 0 (platform unreachable) and
 * 5xx are retried without counting; a missing Site Key (not deployed) leaves the row untouched. Safe to run twice.
 */
export async function cleanupDeletedFiles(db: PrismaClient, remove: Remove = platformRemove): Promise<{deleted: number; failed: number; gaveUp: number}> {
  let cursor = 0n;
  let deleted = 0;
  let failed = 0;
  let gaveUp = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db.fileDeletion.findMany({
      where: {doneAt: null, id: {gt: cursor}},
      orderBy: {id: 'asc'},
      take: BATCH,
      select: {id: true, fileId: true, attempts: true},
    });
    if (!rows.length) break;
    const done: bigint[] = [];
    const retry: bigint[] = [];
    const giveUp: bigint[] = [];
    for (let at = 0; at < rows.length; at += PARALLEL) {
      await Promise.all(
        rows.slice(at, at + PARALLEL).map(async row => {
          try {
            const res = await remove(row.fileId);
            if (res.ok || (res.status === 404 && res.code === 'E_FILE_NOT_FOUND')) done.push(row.id);
            else if (!res.status || res.status >= 500) return; // unreachable or platform trouble: next run, uncounted
            else if (row.attempts + 1 >= MAX_FILE_ATTEMPTS) giveUp.push(row.id);
            else retry.push(row.id);
          } catch (error) {
            if (error instanceof SiteKeyMissing) return; // no platform to call from here: leave the row untouched
            if (row.attempts + 1 >= MAX_FILE_ATTEMPTS) giveUp.push(row.id);
            else retry.push(row.id);
          }
        })
      );
    }
    if (done.length)
      await db.fileDeletion.updateMany({
        where: {id: {in: done}, doneAt: null},
        data: {doneAt: new Date()},
      });
    if (retry.length)
      await db.fileDeletion.updateMany({
        where: {id: {in: retry}},
        data: {attempts: {increment: 1}},
      });
    if (giveUp.length) {
      await db.fileDeletion.updateMany({
        where: {id: {in: giveUp}},
        data: {attempts: {increment: 1}, doneAt: new Date()},
      });
      console.warn(`file-cleanup: gave up on file_deletions ids ${giveUp.join(',')}`);
    }
    deleted += done.length;
    failed += retry.length;
    gaveUp += giveUp.length;
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH) break;
  }
  // Finished rows older than a week go (bounded).
  const keepBefore = new Date(Date.now() - KEEP_DONE_DAYS * 86_400_000);
  await db.$executeRaw`
    DELETE FROM file_deletions WHERE id IN (
      SELECT id FROM file_deletions WHERE done_at < ${keepBefore} ORDER BY id LIMIT 500)`;
  return {deleted, failed, gaveUp};
}
