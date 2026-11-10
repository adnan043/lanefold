import {describe, expect, it, vi} from 'vitest';

import {SiteKeyMissing} from '../src/platform/api';
import {cleanupDeletedFiles, MAX_FILE_ATTEMPTS} from '../src/server/jobs/files';

type Row = {id: bigint; fileId: string; attempts: number};

/** An in-memory outbox: findMany honours `id > cursor` and `take`, updateMany records what happened. */
function fakeDb(all: Row[]) {
  const updates: {where: any; data: any}[] = [];
  const db = {
    fileDeletion: {
      findMany: vi.fn(async (args: any) => all.filter(r => r.id > args.where.id.gt).slice(0, args.take)),
      updateMany: vi.fn(async (args: any) => {
        updates.push(args);
        return {count: 0};
      }),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  return {db, updates};
}
const row = (id: number, attempts = 0): Row => ({id: BigInt(id), fileId: `file_${id}`, attempts});
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('cleanupDeletedFiles', () => {
  it('marks removed files done and prunes finished rows', async () => {
    const {db, updates} = fakeDb([row(1), row(2)]);
    const r = await cleanupDeletedFiles(db as never, async () => ({ok: true}));
    expect(r).toEqual({deleted: 2, failed: 0, gaveUp: 0});
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where.id.in.sort()).toEqual([1n, 2n]);
    expect(updates[0]!.data.doneAt).toBeInstanceOf(Date);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('counts a 404 E_FILE_NOT_FOUND as done, but a bare 404 as a failed attempt', async () => {
    const {db, updates} = fakeDb([row(1), row(2)]);
    const remove = async (id: string) => (id === 'file_1' ? {ok: false, status: 404, code: 'E_FILE_NOT_FOUND'} : {ok: false, status: 404});
    const r = await cleanupDeletedFiles(db as never, remove);
    expect(r).toEqual({deleted: 1, failed: 1, gaveUp: 0});
    expect(updates.find(u => u.data.attempts)!.where.id.in).toEqual([2n]);
  });

  it('leaves rows untouched and uncounted on 5xx and status 0 (platform trouble)', async () => {
    const {db, updates} = fakeDb([row(1), row(2), row(3)]);
    const remove = async (id: string) => (id === 'file_1' ? {ok: false, status: 503} : id === 'file_2' ? {ok: false, status: 0} : {ok: false});
    const r = await cleanupDeletedFiles(db as never, remove);
    expect(r).toEqual({deleted: 0, failed: 0, gaveUp: 0});
    expect(updates).toHaveLength(0);
  });

  it('leaves rows untouched when there is no Site Key', async () => {
    const {db, updates} = fakeDb([row(1)]);
    const r = await cleanupDeletedFiles(db as never, async () => {
      throw new SiteKeyMissing('none');
    });
    expect(r).toEqual({deleted: 0, failed: 0, gaveUp: 0});
    expect(updates).toHaveLength(0);
  });

  it('retries a thrown error, and gives up on the last allowed attempt', async () => {
    const warn = quiet();
    const {db, updates} = fakeDb([row(1, 0), row(2, MAX_FILE_ATTEMPTS - 1)]);
    const r = await cleanupDeletedFiles(db as never, async () => {
      throw new Error('malformed id');
    });
    expect(r).toEqual({deleted: 0, failed: 1, gaveUp: 1});
    const gave = updates.find(u => u.data.doneAt)!;
    expect(gave.where.id.in).toEqual([2n]);
    expect(warn.mock.calls[0]![0]).toContain('2');
    warn.mockRestore();
  });

  it('gives up on a 4xx at the attempt limit', async () => {
    const warn = quiet();
    const {db} = fakeDb([row(1, MAX_FILE_ATTEMPTS - 1)]);
    const r = await cleanupDeletedFiles(db as never, async () => ({ok: false, status: 400}));
    expect(r.gaveUp).toBe(1);
    warn.mockRestore();
  });

  it('pages by keyset and stops after a short page', async () => {
    const rows = Array.from({length: 30}, (_, i) => row(i + 1));
    const {db} = fakeDb(rows);
    const remove = vi.fn(async () => ({ok: true}));
    const r = await cleanupDeletedFiles(db as never, remove);
    expect(r.deleted).toBe(30);
    expect(remove).toHaveBeenCalledTimes(30);
    expect(db.fileDeletion.findMany).toHaveBeenCalledTimes(2);
  });

  it('does nothing on an empty outbox', async () => {
    const {db} = fakeDb([]);
    expect(await cleanupDeletedFiles(db as never, async () => ({ok: true}))).toEqual({deleted: 0, failed: 0, gaveUp: 0});
  });
});
