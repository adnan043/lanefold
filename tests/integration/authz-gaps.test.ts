import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Gaps the authz matrix (authz-matrix.test.ts) leaves: it runs ONE shared fixture per route and checks
 * workspace outsiders, roles and the private board, but not
 *
 *   - the PLATFORM routes that need a session (two-factor, change e-mail, delete account, change password,
 *     PATCH /auth/me): signed out must be 401 (the matrix only checks a few of them),
 *   - a direct message: a member of the SAME workspace who is not one of the two people gets 404 everywhere
 *     (the matrix checks channels and board chats only), and it never shows in their conversation list,
 *   - another person's membership (a plan): cancelling it is a 404, also for an admin of another workspace.
 *
 * Needs TEST_DATABASE_URL (a throwaway Postgres; the tables are emptied), like the other integration files.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

describe.skipIf(!DATABASE_URL)('authz gaps (integration, real Postgres)', () => {
  let anon: Browser;
  let ann: Browser; // A: owner, a party of the DM
  let mia: Browser; // A: member, the other party of the DM
  let nick: Browser; // A: member, NOT in the DM
  let adm: Browser; // A: admin, NOT in the DM (admins read boards, never other people's DMs)
  let vic: Browser; // A: viewer, NOT in the DM
  let bob: Browser; // owner of B
  let ids: Record<'ann' | 'mia' | 'nick' | 'adm' | 'vic' | 'bob', number>;
  let wsA: number;
  let wsB: number;
  let dm: number;
  let dmMsg: number;

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    anon = new Browser(app, '203.0.113.70');
    // The first account becomes the SITE owner (see authz-matrix.test.ts): keep it out of the six.
    await signedIn(app, 'root@example.test', undefined, '203.0.113.69');
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    adm = await signedIn(app, 'adm@example.test', undefined, '203.0.113.72');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.73');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.74');
    nick = await signedIn(app, 'nick@example.test', undefined, '203.0.113.75');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.76');
    ids = {
      ann: await userId('ann@example.test'),
      adm: await userId('adm@example.test'),
      mia: await userId('mia@example.test'),
      vic: await userId('vic@example.test'),
      nick: await userId('nick@example.test'),
      bob: await userId('bob@example.test'),
    };
    wsA = (await ann.post('/site-api/workspaces', {name: 'ZQXGAPA workspace'})).json.workspace.id as number;
    wsB = (await bob.post('/site-api/workspaces', {name: 'ZQXGAPB workspace'})).json.workspace.id as number;
    for (const [id, role] of [[ids.adm, 'admin'], [ids.mia, 'member'], [ids.vic, 'viewer'], [ids.nick, 'member']] as const) {
      await db.workspaceMember.create({data: {workspaceId: wsA, userId: id, role}});
    }
    const made = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.mia]});
    if (made.status !== 201 && made.status !== 200) throw new Error(`dm ${made.status} ${JSON.stringify(made.json)}`);
    dm = Number(made.json.conversation.id);
    const msg = await db.message.create({
      data: {conversationId: dm, workspaceId: wsA, seq: 1n, senderId: ids.ann, bodyMd: 'ZQXDM secret hello', clientId: 'gaps-dm-0001'},
      select: {id: true},
    });
    await db.conversation.update({where: {id: dm}, data: {lastSeq: 1n}});
    dmMsg = Number(msg.id);
  });
  afterAll(() => db.$disconnect());

  /* ------------------------------------------------------------------- platform routes: signed out is 401 */

  const SIGNED_OUT: [string, string][] = [
    ['POST', '/site-api/auth/two-factor/setup'],
    ['POST', '/site-api/auth/two-factor/enable'],
    ['POST', '/site-api/auth/two-factor/disable'],
    ['POST', '/site-api/auth/two-factor/recovery-codes'],
    ['POST', '/site-api/auth/email'],
    ['POST', '/site-api/auth/delete-account'],
    ['POST', '/site-api/auth/change-password'],
    ['PATCH', '/site-api/auth/me'],
  ];
  it.each(SIGNED_OUT)('signed out: %s %s answers 401 (422 when the body is checked first)', async (method, path) => {
    const res = await anon.request(method, path, {});
    expect([401, 422], `${method} ${path} -> ${res.status}`).toContain(res.status);
    // A 422 carries the platform's validation text, which holds an EXAMPLE address ("like name@example.com"), not a person's.
    if (res.status === 401) expect(JSON.stringify(res.json)).not.toMatch(EMAIL_RE);
    else expect(JSON.stringify(res.json).replace(/name@example\.com/g, '')).not.toMatch(EMAIL_RE);
  });

  /* ------------------------------------------------------------------- a direct message of two people */

  it('only the two people of a DM read it; everybody else, in the workspace or outside it, gets 404', async () => {
    const problems: string[] = [];
    const calls: [string, string, unknown?][] = [
      ['GET', `/site-api/conversations/${dm}`],
      ['GET', `/site-api/conversations/${dm}/messages`],
      ['POST', `/site-api/conversations/${dm}/messages`, {body: 'intruder', clientId: 'gaps-intruder-1'}],
      ['POST', `/site-api/conversations/${dm}/read`, {seq: 0}],
      ['PUT', `/site-api/conversations/${dm}/mute`, {}],
      ['DELETE', `/site-api/conversations/${dm}/mute`],
      ['PATCH', `/site-api/messages/${dmMsg}`, {body: 'edited'}],
      ['DELETE', `/site-api/messages/${dmMsg}`],
      ['PUT', `/site-api/messages/${dmMsg}/reactions`, {emoji: '👍'}],
      ['DELETE', `/site-api/messages/${dmMsg}/reactions`, {emoji: '👍'}],
      ['PUT', `/site-api/messages/${dmMsg}/pin`, {}],
      ['DELETE', `/site-api/messages/${dmMsg}/pin`],
    ];
    const outsiders: [string, Browser][] = [['member nick', nick], ['admin adm', adm], ['viewer vic', vic], ['owner of B', bob]];
    for (const [name, who] of outsiders) {
      for (const [method, path, body] of calls) {
        const res = await who.request(method, path, body);
        if (res.status !== 404) problems.push(`${name} ${method} ${path}: expected 404, got ${res.status}`);
        if (JSON.stringify(res.json).includes('ZQXDM')) problems.push(`${name} ${method} ${path}: leaks the message`);
      }
    }
    // Signed out: 401 on the same routes (a body validator may answer 422 first).
    for (const [method, path, body] of calls) {
      const res = await anon.request(method, path, body);
      if (![401, 422].includes(res.status)) problems.push(`signed out ${method} ${path}: expected 401, got ${res.status}`);
    }
    expect(problems).toEqual([]);

    // Nothing changed, and the parties still read it.
    expect(await db.message.count({where: {conversationId: dm}})).toBe(1);
    expect((await db.message.findUniqueOrThrow({where: {id: BigInt(dmMsg)}, select: {bodyMd: true}})).bodyMd).toBe('ZQXDM secret hello');
    for (const who of [ann, mia]) {
      const res = await who.get(`/site-api/conversations/${dm}/messages`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.json)).toContain('ZQXDM');
    }
  });

  it('a DM is not in the conversation list of anybody but its two people', async () => {
    for (const [name, who] of [['nick', nick], ['adm', adm], ['vic', vic]] as const) {
      const res = await who.get(`/site-api/workspaces/${wsA}/conversations`);
      expect(res.status, name).toBe(200);
      expect(res.json.items.some((x: {id: string | number}) => Number(x.id) === dm), `${name} lists the DM`).toBe(false);
    }
    for (const [name, who] of [['ann', ann], ['mia', mia]] as const) {
      const res = await who.get(`/site-api/workspaces/${wsA}/conversations`);
      expect(res.json.items.some((x: {id: string | number}) => Number(x.id) === dm), `${name} lists the DM`).toBe(true);
    }
  });

  it('a DM cannot be opened with a person of another workspace, and a viewer may start only a DM', async () => {
    const out = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.bob]});
    expect(out.status).toBe(422);
    const channel = await vic.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'zqxgap'});
    expect(channel.status).toBe(403);
    expect((await bob.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.ann]})).status).toBe(404);
  });

  /* ------------------------------------------------------------------- memberships (plans) */

  it('cancelling a membership that is not yours (or your workspace’s) is a 404', async () => {
    await db.membership.createMany({
      data: [
        {subscriptionId: 'sub_gaps_bob', priceKey: 'pro', status: 'active', userId: ids.bob},
        {subscriptionId: 'sub_gaps_wsb', priceKey: 'pro', status: 'active', userId: ids.bob, workspaceId: wsB},
      ],
    });
    for (const [name, who] of [['ann (owner A)', ann], ['adm (admin A)', adm], ['mia', mia], ['vic', vic]] as const) {
      for (const sub of ['sub_gaps_bob', 'sub_gaps_wsb']) {
        const res = await who.post(`/site-api/memberships/${sub}/cancel`, {});
        expect(res.status, `${name} cancels ${sub}`).toBe(404);
      }
      const list = await who.get('/site-api/memberships');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.json), `${name} lists a membership of B`).not.toContain('sub_gaps_');
    }
    // A workspace's plan is not its buyer's alone to cancel once they are no longer an admin there.
    await db.membership.create({data: {subscriptionId: 'sub_gaps_wsa', priceKey: 'pro', status: 'active', userId: ids.nick, workspaceId: wsA}});
    for (const [name, who] of [['nick (member, the buyer)', nick], ['vic', vic], ['bob', bob]] as const) {
      const res = await who.post('/site-api/memberships/sub_gaps_wsa/cancel', {});
      expect(res.status, `${name} cancels the plan of A`).toBe(404);
    }
  });
});
