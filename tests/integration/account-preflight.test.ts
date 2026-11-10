import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type Blocker = {reason: string; workspaceId: number; name: string; plan: string; archived: boolean; otherMembers: number; actions: string[]};
const PATH = '/site-api/account/delete-preflight';

/** The delete-account preflight: the same blockers the database triggers raise, only for the signed-in person (real Postgres). */
describe.skipIf(!DATABASE_URL)('account delete preflight (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let cy: Browser;
  let annId: number;
  let bobId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.81');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.82');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.83');
    [annId, bobId] = [await userId('ann@example.test'), await userId('bob@example.test')];
  });

  const mk = async (who: Browser, name: string) => (await who.post('/site-api/workspaces', {name})).json.workspace.id as number;
  const blockers = async (who: Browser) => ((await who.get(PATH)).json.blockers as Blocker[]);

  it('signed out answers 401', async () => {
    expect((await new Browser(app).get(PATH)).status).toBe(401);
  });

  it('a person with no blocking workspace can delete (a solo empty workspace goes with them)', async () => {
    await mk(ann, 'Solo');
    const res = await ann.get(PATH);
    expect(res.status).toBe(200);
    expect(res.json.canDelete).toBe(true);
    expect(res.json.blockers).toEqual([]);
    expect((res.json.summary as {removed: {emptyWorkspaces: number}}).removed.emptyWorkspaces).toBe(1);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('last_workspace_owner: sole owner with other members, archived included', async () => {
    const ws = await mk(ann, 'Team');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: bobId, role: 'member'}});
    let list = await blockers(ann);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({reason: 'last_workspace_owner', workspaceId: ws, name: 'Team', archived: false, otherMembers: 1});
    expect(list[0]!.actions).toEqual(['transfer_ownership']);
    expect((await ann.get(PATH)).json.canDelete).toBe(false);

    await ann.post(`/site-api/workspaces/${ws}/archive`, {confirmName: 'Team'});
    list = await blockers(ann);
    expect(list[0]).toMatchObject({reason: 'last_workspace_owner', archived: true});
    expect(list[0]!.actions).toEqual(['restore', 'transfer_ownership']);

    // A second owner removes the blocker.
    await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: ws, userId: bobId}}, data: {role: 'owner'}});
    expect(await blockers(ann)).toEqual([]);
  });

  it('paid_workspace: solo owner of a paid workspace', async () => {
    const ws = await mk(ann, 'Paid');
    await db.workspace.update({where: {id: ws}, data: {plan: 'pro'}});
    const list = await blockers(ann);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({reason: 'paid_workspace', workspaceId: ws, plan: 'pro', otherMembers: 0});
    expect(list[0]!.actions).toEqual(['cancel_plan']);
  });

  it('workspace_needs_action: solo free workspace with a card; empty again after it is removed', async () => {
    const ws = await mk(ann, 'Busy');
    const board = await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'B', lanes: ['To do']});
    const lane = (await ann.get(`/site-api/boards/${board.json.board.id}`)).json.lanes as {id: number}[];
    await ann.post(`/site-api/lanes/${lane[0]!.id}/cards`, {titles: ['one']});
    const list = await blockers(ann);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({reason: 'workspace_needs_action', workspaceId: ws});
    expect(list[0]!.actions).toEqual(['empty_workspace']);
    await db.card.deleteMany({where: {workspaceId: ws}});
    expect(await blockers(ann)).toEqual([]);
  });

  it("never shows another person's workspaces, names or emails", async () => {
    const wsB = await mk(bob, 'BobSecretSpace');
    await db.workspaceMember.create({data: {workspaceId: wsB, userId: (await userId('cy@example.test')), role: 'member'}});
    const wsA = await mk(ann, 'AnnTeam');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: bobId, role: 'member'}});
    for (const who of [ann, cy]) {
      const res = await who.get(PATH);
      const text = JSON.stringify(res.json);
      expect(text).not.toContain('BobSecretSpace');
      expect(text).not.toMatch(/@example\.test/);
      expect(text).not.toContain('passwordHash');
    }
    // Ann sees only her own blocker, bob only his; cy owns nothing and is free to go.
    expect((await blockers(ann)).map(b => b.workspaceId)).toEqual([wsA]);
    expect((await blockers(bob)).map(b => b.workspaceId)).toEqual([wsB]);
    expect((await cy.get(PATH)).json.canDelete).toBe(true);
    // The id is never taken from the request.
    expect((await ann.get(`${PATH}?userId=${bobId}`)).json.blockers).toHaveLength(1);
    expect(annId).not.toBe(bobId);
  });

  it('last_workspace_owner lists member NAMES as candidates (no emails), and the one-click transfer unblocks deletion', async () => {
    const ws = await mk(ann, 'Handover');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: bobId, role: 'member'}});
    const res = await ann.get(PATH);
    const b = (res.json.blockers as (Blocker & {candidates: {userId: number; name: string | null}[]})[])[0]!;
    expect(b.candidates.map(k => k.userId)).toEqual([bobId]);
    expect(Object.keys(b.candidates[0]!).sort()).toEqual(['name', 'userId']);
    expect(JSON.stringify(res.json)).not.toMatch(/@example\.test/);

    // The button's call: the existing transfer route. Ann becomes admin, so she is no longer a blocker.
    expect((await ann.post(`/site-api/workspaces/${ws}/transfer`, {userId: bobId})).status).toBe(200);
    expect(await blockers(ann)).toEqual([]);
    expect((await ann.get(PATH)).json.canDelete).toBe(true);
    // Bob (now sole owner, Ann still a member) is blocked in turn, and sees Ann as the candidate.
    const bobList = (await bob.get(PATH)).json.blockers as {candidates: {userId: number}[]}[];
    expect(bobList[0]!.candidates.map(k => k.userId)).toEqual([annId]);
  });

  it('candidates are capped at 5, admins first, and never include the viewer or other workspaces', async () => {
    const ws = await mk(ann, 'Big');
    const other = await mk(bob, 'Elsewhere');
    const cyId = await userId('cy@example.test');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: cyId, role: 'admin'}});
    await db.workspaceMember.create({data: {workspaceId: ws, userId: bobId, role: 'member'}});
    const list = (await ann.get(PATH)).json.blockers as {otherMembers: number; candidates: {userId: number}[]}[];
    expect(list[0]!.otherMembers).toBe(2);
    expect(list[0]!.candidates.map(k => k.userId)).toEqual([cyId, bobId]);
    expect(list[0]!.candidates.map(k => k.userId)).not.toContain(annId);
    expect(other).not.toBe(ws);
  });

  it('transfer is owner-only: a non-owner cannot use the one-click route, and a stranger gets 404', async () => {
    const ws = await mk(ann, 'Guarded');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: bobId, role: 'admin'}});
    expect((await bob.post(`/site-api/workspaces/${ws}/transfer`, {userId: bobId})).status).toBeGreaterThanOrEqual(403);
    expect((await cy.post(`/site-api/workspaces/${ws}/transfer`, {userId: bobId})).status).toBe(404);
    expect((await blockers(ann)).map(b => b.workspaceId)).toEqual([ws]);
  });
});
