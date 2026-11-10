import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/** Rename, ownership transfer, #general and preferences (real Postgres; skipped without TEST_DATABASE_URL). */
describe.skipIf(!DATABASE_URL)('workspace settings (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let bob: Browser; // member of A
  let cy: Browser; // admin of A
  let dee: Browser; // owner of B
  let ids: Record<string, number>;
  let wsA: number;
  let wsB: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.52');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.53');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.54');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), cy: await userId('cy@example.test'), dee: await userId('dee@example.test')};
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    wsB = (await dee.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id as number;
    await db.workspaceMember.createMany({data: [{workspaceId: wsA, userId: ids.bob!, role: 'member'}, {workspaceId: wsA, userId: ids.cy!, role: 'admin'}]});
  });

  const role = async (ws: number, user: number) => (await db.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: ws, userId: user}}})).role;

  it('creating a workspace also creates #general with its creator in it', async () => {
    const rows = await db.conversation.findMany({where: {workspaceId: wsA, kind: 'channel'}, select: {name: true, members: {select: {userId: true}}}});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('general');
    expect(rows[0]!.members.map(m => m.userId)).toEqual([ids.ann]);
  });

  it('another workspace answers 404 on every route; guests get 401', async () => {
    expect((await ann.request('PATCH', `/site-api/workspaces/${wsB}`, {name: 'x'})).status).toBe(404);
    expect((await ann.post(`/site-api/workspaces/${wsB}/transfer`, {userId: ids.dee})).status).toBe(404);
    expect((await new Browser(app).request('PATCH', `/site-api/workspaces/${wsA}`, {name: 'x'})).status).toBe(401);
    expect((await new Browser(app).get('/site-api/preferences')).status).toBe(401);
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsB}})).name).toBe('Beta');
  });

  it('rename: admins and owners only, validated, audited', async () => {
    expect((await bob.request('PATCH', `/site-api/workspaces/${wsA}`, {name: 'Nope'})).status).toBe(403);
    expect((await ann.request('PATCH', `/site-api/workspaces/${wsA}`, {name: '   '})).status).toBe(422);
    expect((await ann.request('PATCH', `/site-api/workspaces/${wsA}`, {name: 'x'.repeat(81)})).status).toBe(422);
    expect((await cy.request('PATCH', `/site-api/workspaces/${wsA}`, {name: 'Alpha Two'})).status).toBe(200);
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsA}})).name).toBe('Alpha Two');
    expect(await db.auditEvent.count({where: {action: 'workspace.renamed', targetId: String(wsA)}})).toBe(1);
  });

  it('transfer: owner only, to an existing member; the old owner becomes admin', async () => {
    expect((await cy.post(`/site-api/workspaces/${wsA}/transfer`, {userId: ids.bob})).status).toBe(403);
    expect((await ann.post(`/site-api/workspaces/${wsA}/transfer`, {userId: ids.ann})).status).toBe(409);
    expect((await ann.post(`/site-api/workspaces/${wsA}/transfer`, {userId: ids.dee})).status).toBe(404); // not a member here
    expect((await ann.post(`/site-api/workspaces/${wsA}/transfer`, {userId: 'x'})).status).toBe(422);
    expect(await role(wsA, ids.ann!)).toBe('owner');
    expect((await ann.post(`/site-api/workspaces/${wsA}/transfer`, {userId: ids.bob})).status).toBe(200);
    expect(await role(wsA, ids.bob!)).toBe('owner');
    expect(await role(wsA, ids.ann!)).toBe('admin');
    expect(await db.workspaceMember.count({where: {workspaceId: wsA, role: 'owner'}})).toBe(1);
    expect((await ann.post(`/site-api/workspaces/${wsA}/transfer`, {userId: ids.cy})).status).toBe(403); // no longer owner
    expect(await db.auditEvent.count({where: {action: 'workspace.ownership_transferred'}})).toBe(1);
  });

  it('preferences: defaults, validated save, per user', async () => {
    expect((await ann.get('/site-api/preferences')).json.preferences).toMatchObject({locale: 'en', themeMode: 'system', density: 'comfortable'});
    expect((await ann.request('PATCH', '/site-api/preferences', {locale: 'xx'})).status).toBe(422);
    expect((await ann.request('PATCH', '/site-api/preferences', {})).status).toBe(422);
    expect((await ann.request('PATCH', '/site-api/preferences', {locale: 'bn', themeMode: 'dark', density: 'compact'})).status).toBe(200);
    expect((await ann.get('/site-api/preferences')).json.preferences).toEqual({locale: 'bn', themeMode: 'dark', density: 'compact', fontScale: 100, radius: 'soft', reduceMotion: false});
    expect((await bob.get('/site-api/preferences')).json.preferences.locale).toBe('en');
  });
});
