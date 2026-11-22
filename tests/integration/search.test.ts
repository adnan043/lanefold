import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** Search, My Day, Inbox: workspace and private-board isolation, no emails, wildcards, triage (real Postgres). */
describe.skipIf(!DATABASE_URL)('search, my day and inbox (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let bob: Browser; // owns workspace B, no seat in A
  let mia: Browser; // member of A, no seat on A's private board
  let vic: Browser; // viewer in A
  let wsA: number;
  let openBoard: number;
  let privBoard: number;
  let openLane: number;
  let privLane: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.32');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.33');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.34');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await userId('mia@example.test'), role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await userId('vic@example.test'), role: 'viewer'}});
    openBoard = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    privBoard = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap secret', visibility: 'private', lanes: ['To do']})).json.board.id;
    openLane = (await ann.get(`/site-api/boards/${openBoard}`)).json.lanes[0].id;
    privLane = (await ann.get(`/site-api/boards/${privBoard}`)).json.lanes[0].id;
  });

  const search = (b: Browser, q: string, ws = wsA) => b.get(`/site-api/workspaces/${ws}/search?q=${encodeURIComponent(q)}`);

  it('searches cards, boards and people, and never answers with an email', async () => {
    await ann.post(`/site-api/lanes/${openLane}/cards`, {title: 'Plan the launch'});
    const res = await search(ann, 'launch');
    expect(res.status).toBe(200);
    expect((res.json.cards as J[]).map(c => c.title)).toEqual(['Plan the launch']);
    const boards = await search(ann, 'roadmap');
    expect((boards.json.boards as J[]).map(b => b.name).sort()).toEqual(['Roadmap', 'Roadmap secret']);
    const people = await search(ann, 'mia');
    expect(Object.keys(people.json.people[0]).sort()).toEqual(['id', 'name', 'role']);
    expect(JSON.stringify([res.json, boards.json, people.json])).not.toContain('@example.test');
  });

  it('finds a card by its description and treats % and _ as plain text', async () => {
    const card = (await ann.post(`/site-api/lanes/${openLane}/cards`, {title: 'Alpha'})).json.items[0].id;
    await db.card.update({where: {id: card}, data: {descriptionMd: 'budget is 100% done'}});
    expect((await search(ann, 'budget')).json.cards).toHaveLength(1);
    expect((await search(ann, '100%')).json.cards).toHaveLength(1);
    expect((await search(ann, '%%')).json.cards).toHaveLength(0);
    expect((await search(ann, '__')).json.cards).toHaveLength(0);
    expect((await search(ann, 'a')).json.cards).toHaveLength(0); // under two characters: nothing
    expect((await search(ann, 'bu')).json.cards).toHaveLength(0); // two characters: titles only, never descriptions
    expect((await search(ann, 'Al')).json.cards).toHaveLength(1);
  });

  it("another workspace's user gets 404", async () => {
    expect((await search(bob, 'roadmap')).status).toBe(404);
  });

  it('keeps private boards and their cards out of results for members without a seat', async () => {
    await ann.post(`/site-api/lanes/${privLane}/cards`, {title: 'Salary review'});
    expect((await search(ann, 'salary')).json.cards).toHaveLength(1);
    const asMia = await search(mia, 'salary');
    expect(asMia.json.cards).toHaveLength(0);
    expect((await search(mia, 'secret')).json.boards).toHaveLength(0);
    await db.boardMember.create({data: {boardId: privBoard, userId: await userId('mia@example.test'), workspaceId: wsA, role: 'member'}});
    expect((await search(mia, 'salary')).json.cards).toHaveLength(1);
  });

  it('My Day lists my assignments only, groups them, and hides boards I cannot see', async () => {
    const open = (await ann.post(`/site-api/lanes/${openLane}/cards`, {titles: ['Late', 'Soon', 'Whenever']})).json.items as J[];
    const priv = (await ann.post(`/site-api/lanes/${privLane}/cards`, {title: 'Hidden'})).json.items[0];
    const annId = await userId('ann@example.test');
    const miaId = await userId('mia@example.test');
    await db.card.update({where: {id: open[0].id}, data: {dueDate: new Date('2026-05-01')}});
    await db.card.update({where: {id: open[1].id}, data: {dueDate: new Date('2026-05-04')}});
    for (const c of open) await db.cardMember.create({data: {cardId: c.id, userId: annId, workspaceId: wsA}});
    await db.cardMember.create({data: {cardId: priv.id, userId: miaId, workspaceId: wsA}}); // assigned, but no seat
    await db.cardMember.create({data: {cardId: priv.id, userId: annId, workspaceId: wsA}});
    const today = new Date().toISOString().slice(0, 10);
    const day = await ann.get(`/site-api/my-day?today=${today}`);
    expect(day.status).toBe(200);
    expect((day.json.items as J[]).map(i => [i.title, i.group]).sort()).toEqual([['Hidden', 'none'], ['Late', 'overdue'], ['Soon', 'overdue'], ['Whenever', 'none']].sort());
    expect((await mia.get('/site-api/my-day')).json.items).toEqual([]);
    expect((await bob.get('/site-api/my-day')).json.items).toEqual([]);
    expect((await ann.get('/site-api/my-day?today=nope')).status).toBe(422);
    expect((await ann.get('/site-api/my-day?today=1999-01-01')).status).toBe(422);
    // A card done more than a day ago (left in a Done lane, never archived) does not come back.
    await db.card.update({where: {id: open[2].id}, data: {completedAt: new Date(Date.now() - 2 * 86_400_000)}});
    expect(((await ann.get('/site-api/my-day')).json.items as J[]).map(i => i.title)).not.toContain('Whenever');
    // Cards just done stay in My Day, marked done and in place (by due date), until they are archived.
    await ann.request('PATCH', `/site-api/cards/${open[0].id}`, {completed: true});
    const after = (await ann.get('/site-api/my-day')).json.items as J[];
    expect(after.find(i => i.title === 'Late')?.completed).toBe(true);
    expect(after.find(i => i.title === 'Soon')?.completed).toBe(false);
    expect(after[0]?.title).toBe('Late');
    await ann.request('POST', `/site-api/cards/${open[0].id}/archive`, {});
    expect(((await ann.get('/site-api/my-day')).json.items as J[]).map(i => i.title)).not.toContain('Late');
  });

  it('the personal Inbox is gone: its routes are 404 for everyone', async () => {
    expect((await ann.get(`/site-api/workspaces/${wsA}/inbox`)).status).toBe(404);
    expect((await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'x'})).status).toBe(404);
    expect((await ann.post(`/site-api/inbox/cards/1/triage`, {laneId: openLane})).status).toBe(404);
  });
});
