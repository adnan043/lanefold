import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import '../../src/server/background';
import {app} from '../../src/server/app';
import {runInviteEmails, sealInviteItem} from '../../src/server/jobs/invite-email';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';
import {env} from './support/cloudflare-workers';

const ADDRESS = 'zqx-review6-4410@example.test';
const WRONG = 'someone-else-9921@example.test';

describe.skipIf(!DATABASE_URL)('review 6: invite resend and job re-check (integration, real Postgres)', () => {
  let ann: Browser; // owner
  let bob: Browser; // admin, creates the invites
  let nick: Browser; // second admin
  let ws: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    env.RESEND_API_KEY = 're_test_key_never_real';
    env.MAIL_FROM = 'Lanefold <no-reply@example.test>';
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    nick = await signedIn(app, 'nick@example.test', undefined, '203.0.113.73');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), nick: await userId('nick@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    for (const key of ['bob', 'nick'] as const) await db.workspaceMember.create({data: {workspaceId: ws, userId: ids[key]!, role: 'admin'}});
    await db.workspace.update({where: {id: ws}, data: {memberCount: 3}});
  });
  afterAll(() => {
    delete env.RESEND_API_KEY;
    delete env.MAIL_FROM;
  });

  const makeInvite = async () => {
    const res = await bob.post(`/site-api/workspaces/${ws}/invites`, {email: ADDRESS, sendEmail: true});
    expect(res.status).toBe(201);
    await db.workspaceInvite.update({where: {id: res.json.id}, data: {emailStatus: 'failed'}});
    return res.json as {id: number; token: string};
  };

  describe('resend', () => {
    it('a wrong address from a non-creator admin is the same 404 as an unknown invite', async () => {
      const made = await makeInvite();
      const wrong = await nick.post(`/site-api/workspaces/${ws}/invites/${made.id}/email`, {email: WRONG});
      const unknown = await nick.post(`/site-api/workspaces/${ws}/invites/999999/email`, {email: WRONG});
      expect(wrong.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(wrong.json).toEqual(unknown.json);
    });

    it('the creator still gets 422 mismatch for a wrong address', async () => {
      const made = await makeInvite();
      const res = await bob.post(`/site-api/workspaces/${ws}/invites/${made.id}/email`, {email: WRONG});
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.json)).toContain('mismatch');
    });

    it('a non-creator admin with the right address can resend', async () => {
      const made = await makeInvite();
      const res = await nick.post(`/site-api/workspaces/${ws}/invites/${made.id}/email`, {email: ADDRESS});
      expect(res.status).toBe(200);
    });
  });

  describe('job re-check (inviterMayEmail)', () => {
    const job = {attempt: 1, maxAttempts: 5};
    const setup = async () => {
      const made = await makeInvite();
      await db.workspaceInvite.update({where: {id: made.id}, data: {emailStatus: 'queued'}});
      const item = (await sealInviteItem(ids.bob!, made.id, ADDRESS, made.token))!;
      return {made, data: {v: 1, w: ws, by: ids.bob!, items: [item]}};
    };

    it('an inviter demoted to member: marked failed, nothing sent', async () => {
      const {made, data} = await setup();
      const before = (await db.workspaceInvite.findUniqueOrThrow({where: {id: made.id}})).emailAttempts;
      await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: ws, userId: ids.bob!}}, data: {role: 'member'}});
      let calls = 0;
      await runInviteEmails(db, data, job, {send: async () => (calls++, {kind: 'sent' as const, id: 'm'})});
      expect(calls).toBe(0);
      const r = await db.workspaceInvite.findUniqueOrThrow({where: {id: made.id}});
      expect(r.emailStatus).toBe('failed');
      expect(r.emailAttempts).toBe(before);
    });

    it('an inviter removed from the workspace: marked failed, nothing sent', async () => {
      const {made, data} = await setup();
      await db.workspaceMember.delete({where: {workspaceId_userId: {workspaceId: ws, userId: ids.bob!}}});
      let calls = 0;
      await runInviteEmails(db, data, job, {send: async () => (calls++, {kind: 'sent' as const, id: 'm'})});
      expect(calls).toBe(0);
      expect((await db.workspaceInvite.findUniqueOrThrow({where: {id: made.id}})).emailStatus).toBe('failed');
    });

    it('a still-admin inviter sends normally (control)', async () => {
      const {made, data} = await setup();
      let calls = 0;
      await runInviteEmails(db, data, job, {send: async () => (calls++, {kind: 'sent' as const, id: 'm'})});
      expect(calls).toBe(1);
      expect((await db.workspaceInvite.findUniqueOrThrow({where: {id: made.id}})).emailStatus).toBe('sent');
    });
  });
});
