import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** Security review 4: a link or invite never grants more than its maker holds now (real Postgres; skipped without TEST_DATABASE_URL). */
describe.skipIf(!DATABASE_URL)('review 4: members escalation (integration)', () => {
  let ann: Browser; // owner
  let bob: Browser; // admin
  let dee: Browser; // outsider
  let ids: Record<string, number>;
  let ws: number;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.64');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), dee: await userId('dee@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: ids.bob!, role: 'admin'}});
    await db.workspace.update({where: {id: ws}, data: {memberCount: {increment: 1}}});
  });

  it('an admin link made by an admin who was demoted since is dead', async () => {
    const link = (await bob.post(`/site-api/workspaces/${ws}/join-links`, {role: 'admin', maxUses: 3})).json as J;
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.bob}`, {role: 'member'})).status).toBe(200);
    expect((await dee.post('/site-api/invites/accept', {token: link.token})).status).toBe(404);
    expect(await db.workspaceMember.count({where: {workspaceId: ws, userId: ids.dee!}})).toBe(0);
  });

  it('an admin invite made by an admin who was demoted since is dead', async () => {
    const invite = (await bob.post(`/site-api/workspaces/${ws}/invites`, {role: 'admin'})).json as J;
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.bob}`, {role: 'viewer'})).status).toBe(200);
    expect((await dee.post('/site-api/invites/accept', {token: invite.token})).status).toBe(404);
  });

  it('an admin link from a current admin still works', async () => {
    const link = (await bob.post(`/site-api/workspaces/${ws}/join-links`, {role: 'admin', maxUses: 3})).json as J;
    const res = await dee.post('/site-api/invites/accept', {token: link.token});
    expect(res.status).toBe(201);
    expect(res.json.role).toBe('admin');
  });

  it('a stranger cannot read or change members, links or ownership of the workspace (404)', async () => {
    expect((await dee.get(`/site-api/workspaces/${ws}/members`)).status).toBe(404);
    expect((await dee.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.bob}`, {role: 'viewer'})).status).toBe(404);
    expect((await dee.post(`/site-api/workspaces/${ws}/transfer`, {userId: ids.dee})).status).toBe(404);
    expect((await dee.post(`/site-api/workspaces/${ws}/billing/checkout`, {plan: 'pro'})).status).toBe(404);
  });

  it('an admin cannot transfer ownership (403)', async () => {
    expect((await bob.post(`/site-api/workspaces/${ws}/transfer`, {userId: ids.bob})).status).toBe(403);
  });
});
