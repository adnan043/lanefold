import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Archived lists, restore, duplicate and the settings patch: access and isolation (real Postgres). */
describe.skipIf(!DATABASE_URL)('board extras (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let bob: Browser; // owns workspace B, no seat in A
  let viewer: Browser; // viewer in A
  let wsA: number;
  let boardA: number;
  let lane1: number;
  let card: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.32');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.33');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vic.id, role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']})).json.board.id;
    lane1 = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Old news'})).json.items[0].id;
  });

  it("another workspace's user gets 404 on every extra route", async () => {
    await ann.post(`/site-api/cards/${card}/archive`);
    expect((await bob.get(`/site-api/boards/${boardA}/archived-cards`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/boards/archived`)).status).toBe(404);
    expect((await bob.post(`/site-api/boards/${boardA}/duplicate`, {})).status).toBe(404);
    expect((await bob.request('PATCH', `/site-api/boards/${boardA}`, {archived: false})).status).toBe(404);
    expect((await bob.post(`/site-api/cards/${card}/restore`)).status).toBe(404);
  });

  it('requires sign-in', async () => {
    const anon = new Browser(app);
    expect((await anon.get(`/site-api/boards/${boardA}/archived-cards`)).status).toBe(401);
    expect((await anon.post(`/site-api/boards/${boardA}/duplicate`, {})).status).toBe(401);
  });

  it('lists archived cards and restores one back to its lane', async () => {
    await ann.post(`/site-api/cards/${card}/archive`);
    const list = await ann.get(`/site-api/boards/${boardA}/archived-cards`);
    expect(list.status).toBe(200);
    expect((list.json.items as J[]).map(c => [c.id, c.title, c.laneName])).toEqual([[card, 'Old news', 'To do']]);
    expect(list.json.canRestore).toBe(true);
    expect((await ann.post(`/site-api/cards/${card}/restore`)).status).toBe(200);
    expect((await ann.get(`/site-api/boards/${boardA}/archived-cards`)).json.items).toHaveLength(0);
    const got = await ann.get(`/site-api/boards/${boardA}`);
    expect(got.json.lanes[0].cardCount).toBe(1);
  });

  it('lets a viewer read archived cards but not restore, and never duplicate', async () => {
    await ann.post(`/site-api/cards/${card}/archive`);
    const list = await viewer.get(`/site-api/boards/${boardA}/archived-cards`);
    expect(list.status).toBe(200);
    expect(list.json.canRestore).toBe(false);
    expect((await viewer.post(`/site-api/cards/${card}/restore`)).status).toBe(403);
    expect((await viewer.post(`/site-api/boards/${boardA}/duplicate`, {})).status).toBe(403);
    expect((await viewer.request('PATCH', `/site-api/boards/${boardA}`, {archived: false})).status).toBe(403);
  });

  it('refuses duplicate for a board-level viewer who is a workspace member', async () => {
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: wsA, userId: vic.id}}, data: {role: 'member'}});
    await db.boardMember.create({data: {boardId: boardA, workspaceId: wsA, userId: vic.id, role: 'viewer'}});
    expect((await viewer.post(`/site-api/boards/${boardA}/duplicate`, {})).status).toBe(403);
  });

  it('lists archived boards and restores them; viewers cannot restore', async () => {
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {archived: true})).status).toBe(200);
    const list = await ann.get(`/site-api/workspaces/${wsA}/boards/archived`);
    expect((list.json.items as J[]).map(b => [b.id, b.name, b.canRestore])).toEqual([[boardA, 'Roadmap', true]]);
    expect(((await viewer.get(`/site-api/workspaces/${wsA}/boards/archived`)).json.items as J[]).map(b => b.canRestore)).toEqual([false]);
    expect((await viewer.request('PATCH', `/site-api/boards/${boardA}`, {archived: false})).status).toBe(403);
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {archived: false})).status).toBe(200);
    expect((await ann.get(`/site-api/workspaces/${wsA}/boards/archived`)).json.items).toHaveLength(0);
    expect(((await ann.get(`/site-api/workspaces/${wsA}/boards`)).json.items as J[]).map(b => b.id)).toEqual([boardA]);
  });

  it('hides archived private boards from members without a seat', async () => {
    const priv = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private'})).json.board.id;
    await ann.request('PATCH', `/site-api/boards/${priv}`, {archived: true});
    expect((await viewer.get(`/site-api/workspaces/${wsA}/boards/archived`)).json.items).toHaveLength(0);
    expect((await viewer.get(`/site-api/boards/${priv}/archived-cards`)).status).toBe(404);
  });

  it('duplicates settings, lanes and open cards; the copier becomes its admin', async () => {
    await ann.request('PATCH', `/site-api/boards/${boardA}`, {bgKind: 'gradient', bgColor1: '#6366F1', bgColor2: '#EC4899', bgAngle: 135});
    await ann.request('PATCH', `/site-api/lanes/${lane1}`, {wipLimit: 3});
    const ws = await db.board.findUniqueOrThrow({where: {id: boardA}, select: {workspaceId: true}});
    const label = await db.label.create({data: {boardId: boardA, workspaceId: ws.workspaceId, name: 'Bug', colorHex: '#EF4444'}});
    const annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    await db.cardLabel.create({data: {cardId: card, labelId: label.id}});
    await db.cardMember.create({data: {cardId: card, userId: annId, workspaceId: ws.workspaceId}});
    await db.checklist.create({data: {cardId: card, workspaceId: ws.workspaceId, title: 'Steps', position: 'a0', items: {create: [{workspaceId: ws.workspaceId, text: 'One', position: 'a0'}]}}});
    const gone = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Archived one'})).json.items[0].id;
    await ann.post(`/site-api/cards/${gone}/archive`);

    const made = await ann.post(`/site-api/boards/${boardA}/duplicate`, {name: 'Roadmap (copy)'});
    expect(made.status).toBe(201);
    const copyId = made.json.board.id;
    const copy = await ann.get(`/site-api/boards/${copyId}`);
    expect(copy.json.board).toMatchObject({name: 'Roadmap (copy)', bgKind: 'gradient', bgColor1: '#6366F1', bgAngle: 135, canAdmin: true});
    expect((copy.json.lanes as J[]).map(l => [l.name, l.wipLimit, l.cardCount])).toEqual([['To do', 3, 1], ['Doing', null, 0]]);
    const copied = await db.card.findMany({
      where: {boardId: copyId},
      select: {id: true, number: true, title: true, checklistTotal: true, labels: {select: {label: {select: {name: true, boardId: true}}}}, members: {select: {userId: true}}, checklists: {select: {title: true, items: {select: {text: true}}}}},
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({number: 1, title: 'Old news', checklistTotal: 1, labels: [{label: {name: 'Bug', boardId: copyId}}], members: [{userId: annId}], checklists: [{title: 'Steps', items: [{text: 'One'}]}]});
    expect(copied[0]!.id).not.toBe(card);
    // The original is untouched, and the copy hands out the next number after the copied ones.
    expect(await db.card.count({where: {boardId: boardA}})).toBe(2);
    expect((await db.board.findUniqueOrThrow({where: {id: copyId}, select: {nextCardNumber: true}})).nextCardNumber).toBeGreaterThan(1);

    const bare = await ann.post(`/site-api/boards/${boardA}/duplicate`, {name: 'Bare', cards: false});
    expect(bare.status).toBe(201);
    expect(await db.card.count({where: {boardId: bare.json.board.id}})).toBe(0);
    expect((await ann.post(`/site-api/boards/${boardA}/duplicate`, {name: ''})).status).toBe(422);
    expect((await ann.post(`/site-api/boards/${boardA}/duplicate`, {cards: 'yes'})).status).toBe(422);
  });

  it('saves the settings drawer fields: gradient, angle, visibility and a card limit', async () => {
    const res = await ann.request('PATCH', `/site-api/boards/${boardA}`, {name: 'New', visibility: 'private', bgKind: 'gradient', bgColor1: '#0EA5E9', bgColor2: '#1E3A8A', bgAngle: 135});
    expect(res.status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/lanes/${lane1}`, {wipLimit: 0})).status).toBe(422);
    expect((await ann.request('PATCH', `/site-api/lanes/${lane1}`, {wipLimit: 5})).status).toBe(200);
    const got = await ann.get(`/site-api/boards/${boardA}`);
    expect(got.json.board).toMatchObject({name: 'New', visibility: 'private', bgKind: 'gradient'});
    expect(got.json.lanes[0].wipLimit).toBe(5);
    expect((await viewer.get(`/site-api/boards/${boardA}`)).status).toBe(404);
  });

  it('lists archived lanes with card counts and restores one at the end of the board', async () => {
    await ann.post(`/site-api/lanes/${lane1}/archive`);
    const list = await ann.get(`/site-api/boards/${boardA}/archived-lanes`);
    expect(list.status).toBe(200);
    expect((list.json.items as J[]).map(l => [l.id, l.name, l.cardCount])).toEqual([[lane1, 'To do', 1]]);
    expect(list.json.canRestore).toBe(true);
    expect((await ann.get(`/site-api/boards/${boardA}`)).json.lanes.map((l: J) => l.name)).toEqual(['Doing']);
    const restored = await ann.post(`/site-api/lanes/${lane1}/restore`);
    expect(restored.status).toBe(200);
    expect((await ann.get(`/site-api/boards/${boardA}/archived-lanes`)).json.items).toHaveLength(0);
    const got = await ann.get(`/site-api/boards/${boardA}`);
    expect(got.json.lanes.map((l: J) => l.name)).toEqual(['Doing', 'To do']);
    expect(got.json.lanes[1].cardCount).toBe(1);
    expect((await ann.post(`/site-api/lanes/${lane1}/restore`)).status).toBe(404);
    const rows = await db.activity.findMany({where: {boardId: boardA, kind: 'lane.restored'}, select: {id: true}});
    expect(rows).toHaveLength(1);
  });

  it('lane restore: another workspace gets 404, a viewer 403, anonymous 401', async () => {
    await ann.post(`/site-api/lanes/${lane1}/archive`);
    expect((await bob.get(`/site-api/boards/${boardA}/archived-lanes`)).status).toBe(404);
    expect((await bob.post(`/site-api/lanes/${lane1}/restore`)).status).toBe(404);
    expect((await viewer.get(`/site-api/boards/${boardA}/archived-lanes`)).json.canRestore).toBe(false);
    expect((await viewer.post(`/site-api/lanes/${lane1}/restore`)).status).toBe(403);
    expect((await new Browser(app).post(`/site-api/lanes/${lane1}/restore`)).status).toBe(401);
  });
});
