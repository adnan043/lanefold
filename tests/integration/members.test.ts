import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {notify} from '../../src/server/notifications';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** Members, invites, roles, leaving and notifications (real Postgres; skipped without TEST_DATABASE_URL). */
describe.skipIf(!DATABASE_URL)('members and invites (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let bob: Browser;
  let cy: Browser;
  let dee: Browser; // outsider
  let ids: Record<string, number>;
  let wsA: number;
  let wsB: number;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 10}});
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 10}});
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.42');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.43');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.44');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), cy: await userId('cy@example.test'), dee: await userId('dee@example.test')};
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    wsB = (await dee.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id as number;
  });

  const add = async (workspaceId: number, userId: number, role: string) => {
    await db.workspaceMember.create({data: {workspaceId, userId, role}});
    await db.workspace.update({where: {id: workspaceId}, data: {memberCount: {increment: 1}}});
  };
  const memberCount = async (id: number) => (await db.workspace.findUniqueOrThrow({where: {id}, select: {memberCount: true}})).memberCount;
  const link = async (as: Browser, ws: number, body: J = {}) => (await as.post(`/site-api/workspaces/${ws}/join-links`, body)).json as J;

  it('other workspaces answer 404 on every member route', async () => {
    const paths: [string, string, J?][] = [
      ['GET', `/site-api/workspaces/${wsB}/members`],
      ['PATCH', `/site-api/workspaces/${wsB}/members/${ids.dee}`, {role: 'viewer'}],
      ['DELETE', `/site-api/workspaces/${wsB}/members/${ids.dee}`],
      ['POST', `/site-api/workspaces/${wsB}/leave`],
      ['GET', `/site-api/workspaces/${wsB}/join-links`],
      ['POST', `/site-api/workspaces/${wsB}/join-links`, {}],
      ['GET', `/site-api/workspaces/${wsB}/invites`],
      ['POST', `/site-api/workspaces/${wsB}/invites`, {}],
      ['DELETE', `/site-api/workspaces/${wsB}/join-links/1`],
    ];
    for (const [method, path, body] of paths) expect((await ann.request(method, path, body)).status, `${method} ${path}`).toBe(404);
    expect((await new Browser(app).get(`/site-api/workspaces/${wsA}/members`)).status).toBe(401);
  });

  it('a viewer or member cannot invite, change roles or remove', async () => {
    await add(wsA, ids.bob!, 'viewer');
    await add(wsA, ids.cy!, 'member');
    for (const who of [bob, cy]) {
      expect((await who.post(`/site-api/workspaces/${wsA}/join-links`, {})).status).toBe(403);
      expect((await who.post(`/site-api/workspaces/${wsA}/invites`, {})).status).toBe(403);
      expect((await who.get(`/site-api/workspaces/${wsA}/join-links`)).status).toBe(403);
      expect((await who.request('PATCH', `/site-api/workspaces/${wsA}/members/${ids.ann}`, {role: 'viewer'})).status).toBe(403);
      expect((await who.delete(`/site-api/workspaces/${wsA}/members/${ids.ann}`)).status).toBe(403);
    }
    expect((await bob.get(`/site-api/workspaces/${wsA}/members`)).status).toBe(200);
  });

  it('the directory never shows emails to members, and only masked ones to admins', async () => {
    await add(wsA, ids.bob!, 'member');
    const asMember = await bob.get(`/site-api/workspaces/${wsA}/members`);
    // A member sees only their own address, never another's.
    expect(JSON.stringify(asMember.json)).not.toMatch(/ann@example\.test|maskedEmail/);
    expect((asMember.json.items as J[]).find(m => m.userId === ids.bob)!.email).toMatch(/^bob@example\.test$/);
    const asOwner = await ann.get(`/site-api/workspaces/${wsA}/members`);
    // A workspace owner who is not a site admin: others masked, never a full address.
    expect(JSON.stringify(asOwner.json)).not.toMatch(/bob@example\.test/);
    expect((asOwner.json.items as J[]).find(m => m.userId === ids.bob)!.maskedEmail).toBe('•••@•••.test');
  });

  it('a join link: the token is shown once, stored hashed, and works up to max uses', async () => {
    const made = await link(ann, wsA, {role: 'member', maxUses: 2, expiresInDays: 3});
    expect(made.token).toMatch(/^lj_/);
    const stored = await db.workspaceJoinLink.findMany({select: {tokenHash: true}});
    expect(stored[0]!.tokenHash).not.toContain(made.token);
    expect(JSON.stringify((await ann.get(`/site-api/workspaces/${wsA}/join-links`)).json)).not.toContain(made.token);

    const joined = await bob.post('/site-api/invites/accept', {token: made.token});
    expect(joined.status).toBe(201);
    expect(joined.json).toMatchObject({workspaceId: wsA, role: 'member', alreadyMember: false});
    expect(await memberCount(wsA)).toBe(2);
    // Bob again: already in, nothing consumed. Cy takes the last use; Dee finds it used up.
    expect((await bob.post('/site-api/invites/accept', {token: made.token})).json.alreadyMember).toBe(true);
    expect((await cy.post('/site-api/invites/accept', {token: made.token})).status).toBe(201);
    expect((await dee.post('/site-api/invites/accept', {token: made.token})).status).toBe(404);
  });

  it('expired, revoked, malformed and unknown tokens all answer the same 404', async () => {
    const expired = await link(ann, wsA, {});
    await db.workspaceJoinLink.update({where: {id: expired.id}, data: {expiresAt: new Date(Date.now() - 1000)}});
    const revoked = await link(ann, wsA, {});
    expect((await ann.delete(`/site-api/workspaces/${wsA}/join-links/${revoked.id}`)).status).toBe(200);
    const answers = [];
    for (const token of [expired.token, revoked.token, `lj_${'A'.repeat(43)}`, `iv_${'B'.repeat(43)}`]) {
      const r = await cy.post('/site-api/invites/accept', {token});
      answers.push([r.status, r.json.error]);
    }
    expect(new Set(answers.map(a => a.join()))).toEqual(new Set(['404,invalid_invite']));
    expect((await cy.post('/site-api/invites/accept', {token: 'nope'})).status).toBe(422);
    expect((await new Browser(app).post('/site-api/invites/accept', {token: expired.token})).status).toBe(401);
  });

  it('an invite bound to an email works only for that account and only once', async () => {
    const made = (await ann.post(`/site-api/workspaces/${wsA}/invites`, {role: 'viewer', email: 'Cy@Example.test'})).json as J;
    expect(made.token).toMatch(/^iv_/);
    const row = await db.workspaceInvite.findFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('cy@');
    expect((await bob.post('/site-api/invites/accept', {token: made.token})).status).toBe(404);
    expect((await cy.post('/site-api/invites/accept', {token: made.token})).status).toBe(201);
    expect((await dee.post('/site-api/invites/accept', {token: made.token})).status).toBe(404);
    expect((await ann.get(`/site-api/workspaces/${wsA}/invites`)).json.items[0]).toMatchObject({used: true, active: false, boundToEmail: true});
  });

  it('links and invites die with their maker\'s admin rights, whatever role they grant', async () => {
    await add(wsA, ids.bob!, 'admin');
    const memberLink = await link(bob, wsA, {role: 'member', maxUses: 10});
    const viewerInvite = (await bob.post(`/site-api/workspaces/${wsA}/invites`, {role: 'viewer'})).json as J;
    // While Bob is an admin, his link works.
    expect((await cy.post('/site-api/invites/accept', {token: memberLink.token})).status).toBe(201);
    // Removed: neither his join link nor his invite lets anyone else in.
    expect((await ann.delete(`/site-api/workspaces/${wsA}/members/${ids.bob}`)).status).toBe(200);
    for (const token of [memberLink.token, viewerInvite.token]) {
      const r = await dee.post('/site-api/invites/accept', {token});
      expect([r.status, r.json.error]).toEqual([404, 'invalid_invite']);
    }
    // Demoted below admin: the same.
    await add(wsA, ids.bob!, 'admin');
    const later = await link(bob, wsA, {role: 'member', maxUses: 10});
    expect((await ann.request('PATCH', `/site-api/workspaces/${wsA}/members/${ids.bob}`, {role: 'member'})).status).toBe(200);
    expect((await dee.post('/site-api/invites/accept', {token: later.token})).status).toBe(404);
    expect((await db.workspaceMember.findFirst({where: {workspaceId: wsA, userId: ids.dee}}))).toBeNull();
  });

  it('the member cap is enforced on accept and a full workspace keeps the link unspent', async () => {
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 2}});
    const made = await link(ann, wsA, {maxUses: 5});
    expect((await bob.post('/site-api/invites/accept', {token: made.token})).status).toBe(201);
    const full = await cy.post('/site-api/invites/accept', {token: made.token});
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('member_limit_reached');
    expect(await memberCount(wsA)).toBe(2);
    expect((await db.workspaceJoinLink.findFirstOrThrow()).uses).toBe(1);
    // A full workspace also refuses to mint more links.
    expect((await ann.post(`/site-api/workspaces/${wsA}/join-links`, {})).status).toBe(409);
    // Freeing a seat lets Cy in.
    expect((await bob.post(`/site-api/workspaces/${wsA}/leave`)).status).toBe(200);
    expect((await cy.post('/site-api/invites/accept', {token: made.token})).status).toBe(201);
  });

  it('two people racing for the last seat: exactly one wins', async () => {
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 2}});
    const made = await link(ann, wsA, {maxUses: 5});
    const results = await Promise.all([bob, cy].map(b => b.post('/site-api/invites/accept', {token: made.token})));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await memberCount(wsA)).toBe(2);
  });

  it('role changes: admin cannot touch an admin or the owner, nobody changes their own, owner is never granted', async () => {
    await add(wsA, ids.bob!, 'admin');
    await add(wsA, ids.cy!, 'member');
    const patch = (who: Browser, target: number, role: string) => who.request('PATCH', `/site-api/workspaces/${wsA}/members/${target}`, {role});
    expect((await patch(bob, ids.cy!, 'admin')).status).toBe(200);
    expect((await patch(bob, ids.ann!, 'viewer')).status).toBe(403);
    expect((await patch(bob, ids.bob!, 'viewer')).status).toBe(409);
    expect((await patch(ann, ids.cy!, 'owner')).status).toBe(422);
    // Cy is now an admin: bob (admin) cannot demote Cy, the owner can.
    expect((await patch(bob, ids.cy!, 'viewer')).status).toBe(403);
    expect((await patch(ann, ids.cy!, 'viewer')).status).toBe(200);
    expect((await patch(ann, ids.dee!, 'viewer')).status).toBe(404);
    expect((await db.auditEvent.findMany({where: {action: 'workspace.member.role_changed'}})).length).toBe(2);
  });

  it('removing a member frees the seat and clears board seats; leaving works, the last owner cannot leave', async () => {
    await add(wsA, ids.bob!, 'member');
    await add(wsA, ids.cy!, 'member');
    expect(await memberCount(wsA)).toBe(3);
    expect((await ann.delete(`/site-api/workspaces/${wsA}/members/${ids.bob}`)).status).toBe(200);
    expect(await memberCount(wsA)).toBe(2);
    expect((await bob.get(`/site-api/workspaces/${wsA}/members`)).status).toBe(404);
    expect((await ann.delete(`/site-api/workspaces/${wsA}/members/${ids.ann}`)).status).toBe(409);
    expect((await ann.post(`/site-api/workspaces/${wsA}/leave`)).status).toBe(409);
    expect((await cy.post(`/site-api/workspaces/${wsA}/leave`)).status).toBe(200);
    expect(await memberCount(wsA)).toBe(1);
    expect((await cy.post(`/site-api/workspaces/${wsA}/leave`)).status).toBe(404);
    // With a second owner, the first may leave.
    await add(wsA, ids.dee!, 'owner');
    expect((await ann.post(`/site-api/workspaces/${wsA}/leave`)).status).toBe(200);
  });

  it('notifications: own rows only, keyset paging, mark read, no one else, no non-members', async () => {
    await add(wsA, ids.bob!, 'member');
    expect(await notify(db, [ids.bob!, ids.ann!, ids.dee!], {workspaceId: wsA, kind: 'assigned', actorId: ids.ann!, cardId: 1})).toBe(1);
    // Two actors share the 24: one actor can send a person at most NOTIFICATIONS_PER_ACTOR_HOUR (20) an hour.
    for (let i = 0; i < 24; i++) await notify(db, [ids.bob!], {workspaceId: wsA, kind: 'comment', actorId: i % 2 === 0 ? ids.dee! : ids.ann!});
    const first = await bob.get('/site-api/notifications');
    expect(first.json.items).toHaveLength(20);
    expect(first.json.items[0].actor).toEqual({id: ids.ann, name: 'ann'});
    expect(JSON.stringify(first.json)).not.toContain('@example.test');
    const second = await bob.get(`/site-api/notifications?before=${first.json.nextBefore}`);
    expect(second.json.items).toHaveLength(5);
    expect(second.json.nextBefore).toBeNull();
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(25);

    const mine = first.json.items[0].id as string;
    expect((await ann.post(`/site-api/notifications/${mine}/read`)).status).toBe(404);
    expect((await bob.post(`/site-api/notifications/${mine}/read`)).status).toBe(200);
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(24);
    expect((await bob.post('/site-api/notifications/read-all', {})).json.updated).toBe(24);
    expect((await bob.get('/site-api/notifications?unread=1')).json.items).toHaveLength(0);
    expect((await ann.get('/site-api/notifications')).json.items).toHaveLength(0);
    // After leaving, the workspace's notifications are hidden.
    await bob.post(`/site-api/workspaces/${wsA}/leave`);
    expect((await bob.get('/site-api/notifications')).json.items).toHaveLength(0);
  });

  it('demoting to viewer clears board seats: a board creator keeps no write access', async () => {
    await add(wsA, ids.bob!, 'member');
    const made = await bob.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Bob board'});
    const boardId = made.json.board?.id ?? made.json.id;
    expect(typeof boardId).toBe('number');
    expect((await db.boardMember.findFirstOrThrow({where: {boardId, userId: ids.bob!}})).role).toBe('admin');
    expect((await ann.request('PATCH', `/site-api/workspaces/${wsA}/members/${ids.bob}`, {role: 'viewer'})).status).toBe(200);
    expect((await db.boardMember.findFirstOrThrow({where: {boardId, userId: ids.bob!}})).role).toBe('viewer');
    // Even if an old admin row came back, the clamp keeps the viewer read-only.
    await db.boardMember.updateMany({where: {boardId, userId: ids.bob!}, data: {role: 'admin'}});
    const rename = await bob.request('PATCH', `/site-api/boards/${boardId}`, {name: 'Hijack'});
    expect([403, 404]).toContain(rename.status);
  });

  it('unread count joins live workspaces only and returns no restricted ids', async () => {
    await add(wsA, ids.bob!, 'member');
    const board = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private'});
    const boardId = board.json.board?.id ?? board.json.id;
    await notify(db, [ids.bob!], {workspaceId: wsA, kind: 'assigned', actorId: ids.ann!, boardId, cardId: 1});
    // Bob has no seat on the private board: the row is left out of the count and the list (no hollow row).
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(0);
    expect((await bob.get('/site-api/notifications')).json.items).toHaveLength(0);
    // With a seat the row comes back, with its board.
    await db.boardMember.create({data: {boardId, userId: ids.bob!, workspaceId: wsA, role: 'viewer'}});
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(1);
    expect((await bob.get('/site-api/notifications')).json.items[0].boardId).toBe(boardId);
    await db.workspace.update({where: {id: wsA}, data: {archivedAt: new Date()}});
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(0);
  });

  it('an invite bound to an email still works with a differently-cased address (normalised compare)', async () => {
    const made = (await ann.post(`/site-api/workspaces/${wsA}/invites`, {role: 'viewer', email: 'CY@Example.test'})).json as J;
    expect((await cy.post('/site-api/invites/accept', {token: made.token})).status).toBe(201);
  });
});
