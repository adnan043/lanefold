import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** GET /boards/:id/people: who is listed with which role, private boards, isolation, no email (real Postgres). */
describe.skipIf(!DATABASE_URL)('board people (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let ben: Browser; // member of A
  let bob: Browser; // owner of B (other workspace)
  let annId: number;
  let benId: number;
  let cyId: number; // viewer of A
  let wsA: number;
  let boardA: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.91');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.92');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.93');
    await signedIn(app, 'cy@example.test', undefined, '203.0.113.94');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const id = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    annId = await id('ann@example.test');
    benId = await id('ben@example.test');
    cyId = await id('cy@example.test');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: cyId, role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  });

  const people = (who: Browser, board = boardA, q = '') => who.get(`/site-api/boards/${board}/people${q ? `?q=${q}` : ''}`);

  it('lists everyone who can see the board with their board role, names only', async () => {
    const res = await people(ben);
    expect(res.status).toBe(200);
    expect(res.json.more).toBe(false);
    const byId = new Map(res.json.items.map((p: J) => [p.id, p]));
    expect(byId.get(annId)).toMatchObject({role: 'admin'});
    expect(byId.get(benId)).toMatchObject({role: 'member'});
    expect(byId.get(cyId)).toMatchObject({role: 'viewer'});
    expect(JSON.stringify(res.json)).not.toContain('@');
  });

  it('a private board lists only workspace admins and its board members', async () => {
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    await db.boardMember.create({data: {boardId: boardA, userId: benId, workspaceId: wsA, role: 'member'}});
    const res = await people(ann);
    expect(res.json.items.map((p: J) => p.id).sort()).toEqual([annId, benId].sort());
  });

  it('filters by name', async () => {
    const res = await people(ann, boardA, 'be');
    expect(res.json.items.map((p: J) => p.id)).toEqual([benId]);
  });

  it('another workspace, or a private board without a seat, is a 404', async () => {
    expect((await people(bob)).status).toBe(404);
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    expect((await people(ben)).status).toBe(404);
  });

  it('a guest sees only the people seated on the board and the workspace admins, not the whole workspace', async () => {
    // bob (another workspace) gets a guest seat on a board every member of A can see.
    const bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    await db.boardMember.create({data: {boardId: boardA, userId: bobId, workspaceId: wsA, role: 'member'}});
    await db.boardMember.create({data: {boardId: boardA, userId: benId, workspaceId: wsA, role: 'member'}});
    const res = await people(bob);
    expect(res.status).toBe(200);
    // ann: owner (runs every board); ben: seated. cy (a viewer of A without a seat) is not named to the guest.
    expect(res.json.items.map((p: J) => p.id).sort()).toEqual([annId, benId].sort());
    // A member of the workspace still sees everyone who can see the board.
    expect((await people(ben)).json.items.map((p: J) => p.id).sort()).toEqual([annId, benId, cyId].sort());
  });

  it('the card people picker shows a guest the same narrowed list (GET /cards/:id/people)', async () => {
    const bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    await db.boardMember.create({data: {boardId: boardA, userId: bobId, workspaceId: wsA, role: 'member'}});
    await db.boardMember.create({data: {boardId: boardA, userId: benId, workspaceId: wsA, role: 'member'}});
    const lane = (await db.lane.findFirstOrThrow({where: {boardId: boardA}, select: {id: true}})).id;
    const card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Plan'})).json.card.id;
    const picker = (who: Browser) => who.get(`/site-api/cards/${card}/people`);
    const asGuest = await picker(bob);
    expect(asGuest.status).toBe(200);
    // Workspace members only (the guest is not one): ann (owner) and ben (seated); never cy (no seat).
    expect(asGuest.json.items.map((p: J) => p.id).sort()).toEqual([annId, benId].sort());
    expect((await picker(ben)).json.items.map((p: J) => p.id).sort()).toEqual([annId, benId, cyId].sort());
  });
});
