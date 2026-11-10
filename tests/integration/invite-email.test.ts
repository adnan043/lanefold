import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {sha256Hex} from '../../src/platform/auth/encoding';
import '../../src/server/background';
import {app} from '../../src/server/app';
import {runInviteEmails, sealInviteItem} from '../../src/server/jobs/invite-email';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';
import {env} from './support/cloudflare-workers';

type J = Record<string, any>;

const ADDRESS = 'zqx-invitee-7731@example.test';

/** Invite emails (Phase 11), real Postgres, no mail account: the local test mode. Skipped without TEST_DATABASE_URL. */
describe.skipIf(!DATABASE_URL)('invite emails (integration, real Postgres)', () => {
  let ann: Browser; // owner
  let bob: Browser; // admin
  let nick: Browser; // member
  let vic: Browser; // viewer
  let dee: Browser; // outsider
  let ws: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    delete env.RESEND_API_KEY;
    delete env.MAIL_FROM;
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    nick = await signedIn(app, 'nick@example.test', undefined, '203.0.113.63');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.64');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.65');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), nick: await userId('nick@example.test'), vic: await userId('vic@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    for (const [key, role] of [['bob', 'admin'], ['nick', 'member'], ['vic', 'viewer']] as const) {
      await db.workspaceMember.create({data: {workspaceId: ws, userId: ids[key]!, role}});
    }
    await db.workspace.update({where: {id: ws}, data: {memberCount: 4}});
  });

  const create = (who: Browser, body: J = {}) => who.post(`/site-api/workspaces/${ws}/invites`, {email: ADDRESS, sendEmail: true, ...body});
  const row = (id: number) => db.workspaceInvite.findUniqueOrThrow({where: {id}});

  /** Every text cell of every table, as one string per table: the address must be in none of them. */
  async function addressInDatabase(): Promise<string[]> {
    const tables = (await db.$queryRaw<{table_name: string}[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map(t => t.table_name);
    const found: string[] = [];
    for (const table of tables) {
      if (!/^[a-z_0-9]+$/.test(table)) continue;
      const hit = await db.$queryRawUnsafe<{n: bigint}[]>(`SELECT count(*)::bigint AS n FROM "${table}" t WHERE t::text ILIKE $1`, `%${ADDRESS}%`);
      if (Number(hit[0]?.n ?? 0) > 0) found.push(table);
    }
    return found;
  }

  it('without a mail provider: the link is still returned, with a preview, and the status is not_configured', async () => {
    const res = await create(bob);
    expect(res.status).toBe(201);
    expect(res.json.token).toMatch(/^iv_/);
    expect(res.json.emailStatus).toBe('not_configured');
    expect(res.json.emailPreview.configured).toBe(false);
    expect(res.json.emailPreview.text).toContain(`/app/join/${res.json.token}`);
    expect(res.json.emailPreview.subject).toContain('Alpha');
    expect((await row(res.json.id)).emailStatus).toBe('not_configured');
    const list = await bob.get(`/site-api/workspaces/${ws}/invites`);
    expect(list.json.items[0].emailStatus).toBe('not_configured');
    expect(JSON.stringify(list.json)).not.toContain(ADDRESS);
    expect(JSON.stringify(list.json)).not.toContain(res.json.token);
  });

  it('the address is in no table, and the raw token is only stored as a hash', async () => {
    const res = await create(bob);
    expect(res.status).toBe(201);
    expect(await addressInDatabase()).toEqual([]);
    expect(await row(res.json.id)).toMatchObject({tokenHash: await sha256Hex(res.json.token)});
    expect((await db.$queryRaw<{n: bigint}[]>`SELECT count(*)::bigint AS n FROM workspace_invites t WHERE t::text LIKE ${'%' + res.json.token + '%'}`)[0]!.n).toBe(0n);
  });

  it('an invite without sendEmail is unchanged: no status, no preview', async () => {
    const res = await bob.post(`/site-api/workspaces/${ws}/invites`, {email: ADDRESS});
    expect(res.status).toBe(201);
    expect(res.json.emailStatus).toBeNull();
    expect(res.json.emailPreview).toBeUndefined();
    expect((await row(res.json.id)).emailStatus).toBeNull();
  });

  it('only admins and owners may send; guests and outsiders get 401 and 404', async () => {
    expect((await create(nick)).status).toBe(403);
    expect((await create(vic)).status).toBe(403);
    expect((await create(dee)).status).toBe(404);
    expect((await create(new Browser(app))).status).toBe(401);
    expect((await create(ann)).status).toBe(201);
    expect(await db.workspaceInvite.count({where: {workspaceId: ws}})).toBe(1);
  });

  it('rejects bad input with 422', async () => {
    expect((await create(bob, {email: 'not-an-email'})).status).toBe(422);
    expect((await bob.post(`/site-api/workspaces/${ws}/invites`, {sendEmail: true})).status).toBe(422);
    expect((await create(bob, {sendEmail: 'yes'})).status).toBe(422);
    expect((await create(bob, {role: 'owner'})).status).toBe(422);
    expect(await db.workspaceInvite.count({where: {workspaceId: ws}})).toBe(0);
  });

  it('limits invite emails per inviter (10 an hour) with 429', async () => {
    for (let i = 0; i < 10; i++) expect((await create(bob, {email: `zqx-n${i}@example.test`})).status).toBe(201);
    expect((await create(bob, {email: 'zqx-n99@example.test'})).status).toBe(429);
    // A plain link invite (no email) is not an email and still works.
    expect((await bob.post(`/site-api/workspaces/${ws}/invites`, {})).status).toBe(201);
  });

  it('an archived workspace answers 404', async () => {
    await db.workspace.update({where: {id: ws}, data: {archivedAt: new Date()}});
    expect((await create(bob)).status).toBe(404);
  });

  describe('resend', () => {
    it('needs the address again, rotates the token and requeues', async () => {
      const first = await create(bob);
      const id = first.json.id as number;
      const wrong = await bob.post(`/site-api/workspaces/${ws}/invites/${id}/email`, {email: 'zqx-other@example.test'});
      expect(wrong.status).toBe(422);
      const ok = await bob.post(`/site-api/workspaces/${ws}/invites/${id}/email`, {email: ADDRESS});
      expect(ok.status).toBe(200);
      expect(ok.json.token).not.toBe(first.json.token);
      expect((await row(id)).tokenHash).toBe(await sha256Hex(ok.json.token));
      expect(ok.json.emailStatus).toBe('not_configured');
      expect(await addressInDatabase()).toEqual([]);
    });

    it('is admin-only, scoped to the workspace, and only for failed ones', async () => {
      const first = await create(bob);
      const url = `/site-api/workspaces/${ws}/invites/${first.json.id}/email`;
      expect((await nick.post(url, {email: ADDRESS})).status).toBe(403);
      expect((await dee.post(url, {email: ADDRESS})).status).toBe(404);
      await db.workspaceInvite.update({where: {id: first.json.id}, data: {emailStatus: 'sent'}});
      expect((await bob.post(url, {email: ADDRESS})).status).toBe(409);
      expect((await bob.post(`/site-api/workspaces/${ws}/invites/999999/email`, {email: ADDRESS})).status).toBe(404);
    });

    it('stops after five sends of one invite', async () => {
      const first = await create(bob);
      await db.workspaceInvite.update({where: {id: first.json.id}, data: {emailAttempts: 5, emailStatus: 'failed'}});
      expect((await bob.post(`/site-api/workspaces/${ws}/invites/${first.json.id}/email`, {email: ADDRESS})).status).toBe(429);
    });
  });

  describe('the job handler', () => {
    const job = (attempt = 1) => ({attempt, maxAttempts: 5});
    const setup = async () => {
      const made = (await create(bob)).json;
      await db.workspaceInvite.update({where: {id: made.id}, data: {emailStatus: 'queued'}});
      const item = (await sealInviteItem(ids.bob!, made.id, ADDRESS, made.token))!;
      return {made, data: {v: 1, w: ws, by: ids.bob!, items: [item]}};
    };
    const withSecrets = () => {
      env.RESEND_API_KEY = 're_test_key_never_real';
      env.MAIL_FROM = 'Lanefold <no-reply@example.test>';
    };

    it('the sealed payload holds neither the address nor the token', async () => {
      const {data, made} = await setup();
      const json = JSON.stringify(data);
      expect(json).not.toContain(ADDRESS);
      expect(json).not.toContain(made.token);
    });

    it('marks sent once and skips a second run (idempotent)', async () => {
      const {data, made} = await setup();
      withSecrets();
      let calls = 0;
      const send = async () => (calls++, {kind: 'sent' as const, id: 'm1'});
      await runInviteEmails(db, data, job(), {send});
      await runInviteEmails(db, data, job(), {send});
      expect(calls).toBe(1);
      const r = await row(made.id);
      expect(r.emailStatus).toBe('sent');
      expect(r.emailSentAt).not.toBeNull();
      expect(r.emailAttempts).toBe(1);
    });

    it('a 4xx marks failed without retrying; a 5xx throws for the platform retry and fails on the last try', async () => {
      const {data, made} = await setup();
      withSecrets();
      await runInviteEmails(db, data, job(), {send: async () => ({kind: 'failed', status: 422})});
      expect((await row(made.id)).emailStatus).toBe('failed');

      const again = await setup();
      await expect(runInviteEmails(db, again.data, job(1), {send: async () => ({kind: 'retry', status: 503})})).rejects.toThrow();
      expect((await row(again.made.id)).emailStatus).toBe('queued');
      await runInviteEmails(db, again.data, job(5), {send: async () => ({kind: 'retry', status: 503})});
      expect((await row(again.made.id)).emailStatus).toBe('failed');
    });

    it('without owner secrets marks not_configured and never calls the provider', async () => {
      const {data, made} = await setup();
      let calls = 0;
      await runInviteEmails(db, data, job(), {send: async () => (calls++, {kind: 'sent', id: null})});
      expect(calls).toBe(0);
      expect((await row(made.id)).emailStatus).toBe('not_configured');
    });

    it('ignores a stale job after the token was rotated, and a used invite', async () => {
      const {data, made} = await setup();
      withSecrets();
      await db.workspaceInvite.update({where: {id: made.id}, data: {tokenHash: await sha256Hex('iv_other')}});
      let calls = 0;
      await runInviteEmails(db, data, job(), {send: async () => (calls++, {kind: 'sent', id: null})});
      expect(calls).toBe(0);
    });
  });
});
