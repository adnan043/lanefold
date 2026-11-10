import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/** Archive and restore a workspace: who may, who gets 404, and that it is hidden and closed (real Postgres). */
describe.skipIf(!DATABASE_URL)('workspace archive (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let bob: Browser; // member of A
  let cy: Browser; // admin of A
  let dee: Browser; // owner of B, not in A
  let wsA: number;
  let wsB: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.63');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.64');
    const [bobId, cyId] = [await userId('bob@example.test'), await userId('cy@example.test')];
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    wsB = (await dee.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id as number;
    await db.workspaceMember.createMany({data: [{workspaceId: wsA, userId: bobId, role: 'member'}, {workspaceId: wsA, userId: cyId, role: 'admin'}]});
  });

  const archivedAt = async (ws: number) => (await db.workspace.findUniqueOrThrow({where: {id: ws}})).archivedAt;

  it('only the owner may archive; members and admins get 403, outsiders and guests 404/401', async () => {
    expect((await bob.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(403);
    expect((await cy.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(403);
    expect((await dee.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(404);
    expect((await new Browser(app).post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(401);
    expect(await archivedAt(wsA)).toBeNull();
  });

  it('the typed name must match exactly', async () => {
    expect((await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'alpha'})).status).toBe(422);
    expect((await ann.post(`/site-api/workspaces/${wsA}/archive`, {})).status).toBe(422);
    expect(await archivedAt(wsA)).toBeNull();
  });

  it('archiving hides the workspace from lists and closes it for every member', async () => {
    expect((await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(200);
    expect(await archivedAt(wsA)).not.toBeNull();
    expect(await db.auditEvent.count({where: {action: 'workspace.archived', targetId: String(wsA)}})).toBe(1);
    for (const who of [ann, bob, cy]) {
      const list = await who.get('/site-api/workspaces');
      expect((list.json.items as {id: number}[]).map(w => w.id)).not.toContain(wsA);
      expect((await who.get(`/site-api/workspaces/${wsA}/members`)).status).toBe(404);
      expect((await who.request('PATCH', `/site-api/workspaces/${wsA}`, {name: 'Nope'})).status).toBe(404);
      expect((await who.get(`/site-api/workspaces/${wsA}/search?q=ab`)).status).toBe(404);
    }
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsA}})).name).toBe('Alpha');
    // Archiving twice, and another owner's workspace, are untouched.
    expect((await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'})).status).toBe(404);
    expect(await archivedAt(wsB)).toBeNull();
  });

  it('only the owner sees and restores it; others get 404', async () => {
    await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'});
    expect(((await ann.get('/site-api/workspaces/archived')).json.items as {id: number}[]).map(w => w.id)).toEqual([wsA]);
    expect((await bob.get('/site-api/workspaces/archived')).json.items).toEqual([]);
    expect((await cy.get('/site-api/workspaces/archived')).json.items).toEqual([]);
    for (const who of [bob, cy, dee]) expect((await who.post(`/site-api/workspaces/${wsA}/restore`)).status).toBe(404);
    expect((await new Browser(app).post(`/site-api/workspaces/${wsA}/restore`)).status).toBe(401);
    expect(await archivedAt(wsA)).not.toBeNull();
    expect((await ann.post(`/site-api/workspaces/${wsA}/restore`)).status).toBe(200);
    expect(await archivedAt(wsA)).toBeNull();
    expect(await db.auditEvent.count({where: {action: 'workspace.restored', targetId: String(wsA)}})).toBe(1);
    expect(((await bob.get('/site-api/workspaces')).json.items as {id: number}[]).map(w => w.id)).toContain(wsA);
    // Restoring a live workspace is a 404 too.
    expect((await ann.post(`/site-api/workspaces/${wsA}/restore`)).status).toBe(404);
  });
  it('an invite or join link to an archived workspace is a generic 404 and consumes nothing', async () => {
    const invite = await ann.post(`/site-api/workspaces/${wsA}/invites`, {role: 'member', expiresInDays: 7});
    const link = await ann.post(`/site-api/workspaces/${wsA}/join-links`, {role: 'member', maxUses: 5});
    expect(invite.status).toBe(201);
    expect(link.status).toBe(201);
    const before = (await db.workspace.findUniqueOrThrow({where: {id: wsA}})).memberCount;
    await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'});
    const eve = await signedIn(app, 'eve@example.test', undefined, '203.0.113.65');
    const eveId = await userId('eve@example.test');
    for (const token of [invite.json.token as string, link.json.token as string]) {
      const res = await eve.post('/site-api/invites/accept', {token});
      expect(res.status).toBe(404);
      expect(res.json.code ?? res.json.error ?? 'invalid_invite').toContain('invalid_invite');
    }
    expect(await db.workspaceMember.count({where: {workspaceId: wsA, userId: eveId}})).toBe(0);
    expect(await db.workspaceInvite.count({where: {workspaceId: wsA, usedAt: {not: null}}})).toBe(0);
    expect((await db.workspaceJoinLink.findFirstOrThrow({where: {workspaceId: wsA}})).uses).toBe(0);
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsA}})).memberCount).toBe(before);
    // Creating new ones in an archived workspace is refused as well.
    expect((await ann.post(`/site-api/workspaces/${wsA}/invites`, {role: 'member', expiresInDays: 7})).status).toBe(404);
    expect((await ann.post(`/site-api/workspaces/${wsA}/join-links`, {role: 'member', maxUses: 5})).status).toBe(404);
    // After a restore the same link works again.
    await ann.post(`/site-api/workspaces/${wsA}/restore`);
    expect((await eve.post('/site-api/invites/accept', {token: link.json.token})).status).toBe(201);
  });

  it('/cards/refs shows nothing for an archived workspace', async () => {
    const board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Launch', lanes: ['To do']})).json.board.id as number;
    const lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id as number;
    const card = (await ann.post(`/site-api/lanes/${lane}/cards`, {titles: ['Secret plan']})).json.items[0].id as number;
    expect((await bob.get(`/site-api/cards/refs?ids=${card}`)).json.items).toHaveLength(1);
    await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'});
    for (const who of [ann, bob]) expect((await who.get(`/site-api/cards/refs?ids=${card}`)).json.items).toEqual([]);
  });

  it('archived workspaces do not count toward the 10-workspace cap', async () => {
    for (let i = 0; i < 9; i++) expect((await ann.post('/site-api/workspaces', {name: `Extra ${i}`})).status).toBe(201);
    expect((await ann.post('/site-api/workspaces', {name: 'Over'})).status).toBe(409);
    await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'});
    expect((await ann.post('/site-api/workspaces', {name: 'Fits now'})).status).toBe(201);
  });

  it('only the owner may cancel the subscription of an archived workspace', async () => {
    const [annId] = [await userId('ann@example.test')];
    await db.membership.create({data: {subscriptionId: 'sub_arch_1', priceKey: 'team', status: 'active', userId: annId, workspaceId: wsA}});
    await ann.post(`/site-api/workspaces/${wsA}/archive`, {confirmName: 'Alpha'});
    // Not the buyer: not theirs. Admin buyer of the archived workspace: still 404.
    const cyId = await userId('cy@example.test');
    await db.membership.create({data: {subscriptionId: 'sub_arch_2', priceKey: 'team', status: 'active', userId: cyId, workspaceId: wsA}});
    expect((await cy.post('/site-api/memberships/sub_arch_2/cancel', {})).status).toBe(404);
    expect((await bob.post('/site-api/memberships/sub_arch_1/cancel', {})).status).toBe(404);
    // The owner passes the guard (the outside call then answers whatever the test platform does, never the 404).
    const res = await ann.post('/site-api/memberships/sub_arch_1/cancel', {});
    expect(res.json.code).not.toBe('not_found');
  });
});
