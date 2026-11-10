import {describe, expect, it, vi} from 'vitest';

const ent = vi.hoisted(() => ({value: {readOnly: false} as {readOnly: boolean} | null}));
vi.mock('../src/server/entitlements', () => ({getEntitlements: async () => ent.value}));

import {inviterMayEmail, runInviteEmails} from '../src/server/jobs/invite-email';

const fakeDb = (member: {role: string} | null) => {
  const updates: unknown[] = [];
  const db = {
    workspaceMember: {findFirst: vi.fn(async () => member)},
    user: {findUnique: async () => ({name: 'Ana'})},
    workspaceInvite: {
      findMany: async () => [{id: 1, role: 'member', expiresAt: new Date(Date.now() + 1e6), tokenHash: 'h', emailStatus: 'queued', workspace: {name: 'W', defaultLocale: 'en'}}],
      updateMany: vi.fn(async (args: unknown) => {
        updates.push(args);
        return {count: 1};
      }),
    },
  };
  return {db: db as never, raw: db, updates};
};

describe('invite email run-time re-check', () => {
  it('allows a current admin/owner of a writable workspace', async () => {
    ent.value = {readOnly: false};
    expect(await inviterMayEmail(fakeDb({role: 'admin'}).db, 1, 2)).toBe(true);
  });

  it('asks only for admin/owner in a non-archived workspace', async () => {
    const f = fakeDb({role: 'owner'});
    await inviterMayEmail(f.db, 1, 2);
    expect((f.raw.workspaceMember.findFirst.mock.calls as unknown[][])[0]![0]).toMatchObject({
      where: {workspaceId: 1, userId: 2, role: {in: ['admin', 'owner']}, workspace: {archivedAt: null}},
    });
  });

  it('refuses a demoted or removed inviter', async () => {
    ent.value = {readOnly: false};
    expect(await inviterMayEmail(fakeDb(null).db, 1, 2)).toBe(false);
  });

  it('refuses a read-only or missing-entitlements workspace', async () => {
    ent.value = {readOnly: true};
    expect(await inviterMayEmail(fakeDb({role: 'admin'}).db, 1, 2)).toBe(false);
    ent.value = null;
    expect(await inviterMayEmail(fakeDb({role: 'admin'}).db, 1, 2)).toBe(false);
  });

  it('the job sends nothing and marks the invite failed when the inviter is no longer an admin', async () => {
    const f = fakeDb(null);
    const send = vi.fn();
    await runInviteEmails(f.db, {v: 1, w: 1, by: 2, items: [{id: 1, s: 'x'}]}, {attempt: 1, maxAttempts: 3}, {send: send as never});
    expect(send).not.toHaveBeenCalled();
    expect(f.updates[0]).toMatchObject({where: {id: 1, workspaceId: 1}, data: {emailStatus: 'failed'}});
  });
});
