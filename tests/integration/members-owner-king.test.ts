import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The owner is king, and a removed member cannot rejoin with an old link (real Postgres; skipped without TEST_DATABASE_URL). */
describe.skipIf(!DATABASE_URL)('owner is king and removals (integration, real Postgres)', () => {
  let ann: Browser; // owner
  let bob: Browser; // admin
  let cy: Browser; // admin
  let dee: Browser; // outsider
  let ids: Record<string, number>;
  let ws: number;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 10}});
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 10}});
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.52');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.53');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.54');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), cy: await userId('cy@example.test'), dee: await userId('dee@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
  });

  const add = async (userId: number, role: string) => {
    await db.workspaceMember.create({data: {workspaceId: ws, userId, role}});
    await db.workspace.update({where: {id: ws}, data: {memberCount: {increment: 1}}});
  };
  const patch = (who: Browser, target: number, role: string) => who.request('PATCH', `/site-api/workspaces/${ws}/members/${target}`, {role});
  const link = async (as: Browser, body: J = {}) => (await as.post(`/site-api/workspaces/${ws}/join-links`, {maxUses: 5, ...body})).json as J;
  const invite = async (as: Browser, body: J = {}) => (await as.post(`/site-api/workspaces/${ws}/invites`, body)).json as J;
  const accept = (who: Browser, token: string) => who.post('/site-api/invites/accept', {token});

  describe('owner is king', () => {
    it('the owner demotes or removes any admin', async () => {
      await add(ids.bob!, 'admin');
      await add(ids.cy!, 'admin');
      expect((await patch(ann, ids.bob!, 'member')).status).toBe(200);
      expect((await ann.delete(`/site-api/workspaces/${ws}/members/${ids.cy}`)).status).toBe(200);
      expect(await db.workspaceMember.count({where: {workspaceId: ws, role: 'admin'}})).toBe(0);
    });

    it('an admin may grant admin (link, invite, role change) but never owner', async () => {
      await add(ids.bob!, 'admin');
      await add(ids.cy!, 'member');
      expect((await bob.post(`/site-api/workspaces/${ws}/join-links`, {role: 'admin', maxUses: 2})).status).toBe(201);
      expect((await bob.post(`/site-api/workspaces/${ws}/invites`, {role: 'admin'})).status).toBe(201);
      expect((await patch(bob, ids.cy!, 'admin')).status).toBe(200);
      for (const role of ['owner']) {
        expect((await patch(bob, ids.cy!, role)).status).toBe(422);
        expect((await bob.post(`/site-api/workspaces/${ws}/join-links`, {role, maxUses: 2})).status).toBe(422);
        expect((await bob.post(`/site-api/workspaces/${ws}/invites`, {role})).status).toBe(422);
      }
    });

    it('an admin can never touch the owner, nor another admin', async () => {
      await add(ids.bob!, 'admin');
      await add(ids.cy!, 'admin');
      for (const role of ['viewer', 'member', 'admin']) expect((await patch(bob, ids.ann!, role)).status, `owner -> ${role}`).toBe(403);
      expect((await bob.delete(`/site-api/workspaces/${ws}/members/${ids.ann}`)).status).toBe(403);
      expect((await patch(bob, ids.cy!, 'member')).status).toBe(403);
      expect((await bob.delete(`/site-api/workspaces/${ws}/members/${ids.cy}`)).status).toBe(403);
      expect((await patch(bob, ids.dee!, 'member')).status).toBe(404);
      expect(await db.workspaceMember.count({where: {workspaceId: ws}})).toBe(3);
      expect((await db.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: ws, userId: ids.ann!}}})).role).toBe('owner');
    });

    it('the owner revokes every link and invite, including ones an admin made with role admin', async () => {
      await add(ids.bob!, 'admin');
      const l = await link(bob, {role: 'admin'});
      const i = await invite(bob, {role: 'admin'});
      expect((await ann.delete(`/site-api/workspaces/${ws}/join-links/${l.id}`)).status).toBe(200);
      expect((await ann.delete(`/site-api/workspaces/${ws}/invites/${i.id}`)).status).toBe(200);
      expect((await accept(dee, l.token)).status).toBe(404);
      expect((await accept(dee, i.token)).status).toBe(404);
    });

    it('an admin cannot revoke what the owner made (it stays usable), but revokes their own', async () => {
      await add(ids.bob!, 'admin');
      const l = await link(ann, {role: 'member'});
      const i = await invite(ann, {role: 'member'});
      expect((await bob.delete(`/site-api/workspaces/${ws}/join-links/${l.id}`)).status).toBe(404);
      expect((await bob.delete(`/site-api/workspaces/${ws}/invites/${i.id}`)).status).toBe(404);
      expect((await db.workspaceJoinLink.findUniqueOrThrow({where: {id: l.id}})).revokedAt).toBeNull();
      expect(await db.workspaceInvite.count({where: {id: i.id}})).toBe(1);
      expect((await accept(dee, l.token)).status).toBe(201);
      const own = await link(bob, {role: 'member'});
      expect((await bob.delete(`/site-api/workspaces/${ws}/join-links/${own.id}`)).status).toBe(200);
    });

    it('only the owner transfers ownership; an admin cannot', async () => {
      await add(ids.bob!, 'admin');
      expect((await bob.post(`/site-api/workspaces/${ws}/transfer`, {userId: ids.bob})).status).toBe(403);
      expect((await ann.post(`/site-api/workspaces/${ws}/transfer`, {userId: ids.bob})).status).toBe(200);
      expect((await db.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: ws, userId: ids.bob!}}})).role).toBe('owner');
    });
  });

  describe('a removed member and old links', () => {
    it('removed with the old join link: 404 and nothing consumed', async () => {
      const l = await link(ann, {role: 'member'});
      expect((await accept(bob, l.token)).status).toBe(201);
      expect((await ann.delete(`/site-api/workspaces/${ws}/members/${ids.bob}`)).status).toBe(200);
      expect(await db.workspaceRemoval.count({where: {workspaceId: ws, userId: ids.bob!}})).toBe(1);
      const usesBefore = (await db.workspaceJoinLink.findUniqueOrThrow({where: {id: l.id}})).uses;
      const again = await accept(bob, l.token);
      expect(again.status).toBe(404);
      expect(again.json.code ?? again.json.error?.code ?? 'invalid_invite').toMatch(/invalid_invite/);
      expect((await db.workspaceJoinLink.findUniqueOrThrow({where: {id: l.id}})).uses).toBe(usesBefore);
      expect(await db.workspaceMember.count({where: {workspaceId: ws, userId: ids.bob!}})).toBe(0);
      // Someone else still uses the same link.
      expect((await accept(cy, l.token)).status).toBe(201);
    });

    it('removed with an old invite: 404 and the invite stays unused', async () => {
      const i = await invite(ann, {role: 'member'});
      expect((await accept(bob, i.token)).status).toBe(201);
      const j = await invite(ann, {role: 'member'});
      await db.workspaceInvite.update({where: {id: j.id}, data: {createdAt: new Date(Date.now() - 60_000)}});
      expect((await ann.delete(`/site-api/workspaces/${ws}/members/${ids.bob}`)).status).toBe(200);
      expect((await accept(bob, j.token)).status).toBe(404);
      expect((await db.workspaceInvite.findUniqueOrThrow({where: {id: j.id}})).usedAt).toBeNull();
    });

    it('a link or invite created after the removal works, and clears the marker', async () => {
      await add(ids.bob!, 'member');
      expect((await ann.delete(`/site-api/workspaces/${ws}/members/${ids.bob}`)).status).toBe(200);
      await wait(20);
      const l = await link(ann, {role: 'member'});
      const joined = await accept(bob, l.token);
      expect(joined.status).toBe(201);
      expect(await db.workspaceRemoval.count({where: {workspaceId: ws, userId: ids.bob!}})).toBe(0);
      // Removed again, then re-invited by a fresh single-use invite.
      expect((await ann.delete(`/site-api/workspaces/${ws}/members/${ids.bob}`)).status).toBe(200);
      expect((await accept(bob, l.token)).status).toBe(404);
      await wait(20);
      const i = await invite(ann, {role: 'viewer'});
      expect((await accept(bob, i.token)).status).toBe(201);
    });

    it('leaving counts as removal', async () => {
      const l = await link(ann, {role: 'member'});
      expect((await accept(cy, l.token)).status).toBe(201);
      expect((await cy.post(`/site-api/workspaces/${ws}/leave`)).status).toBe(200);
      expect(await db.workspaceRemoval.count({where: {workspaceId: ws, userId: ids.cy!}})).toBe(1);
      expect((await accept(cy, l.token)).status).toBe(404);
      expect(await db.workspaceMember.count({where: {workspaceId: ws, userId: ids.cy!}})).toBe(0);
    });

    it('a person never removed is unaffected, and an outsider sees no removal data', async () => {
      const l = await link(ann, {role: 'member'});
      expect((await accept(dee, l.token)).status).toBe(201);
      expect(await db.workspaceRemoval.count()).toBe(0);
    });
  });
});
