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
  });

  it("another workspace's user gets 404", async () => {
    expect((await search(bob, 'roadmap')).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/inbox`)).status).toBe(404);
    expect((await bob.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'x'})).status).toBe(404);
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
    // Done cards leave My Day.
    await ann.request('PATCH', `/site-api/cards/${open[0].id}`, {completed: true});
    expect(((await ann.get('/site-api/my-day')).json.items as J[]).map(i => i.title)).not.toContain('Late');
  });

  it('captures into a personal Inbox board, one per user, and nobody else can reach it', async () => {
    expect((await ann.get(`/site-api/workspaces/${wsA}/inbox`)).json.boardId).toBeNull();
    const first = await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Buy stamps'});
    expect(first.status).toBe(201);
    const [a, b] = await Promise.all([
      ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Two'}),
      ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Three'}),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const inboxBoards = await db.board.findMany({where: {inboxOf: await userId('ann@example.test')}, select: {id: true, visibility: true}});
    expect(inboxBoards).toHaveLength(1);
    const mine = await ann.get(`/site-api/workspaces/${wsA}/inbox`);
    expect((mine.json.items as J[]).map(i => i.title).sort()).toEqual(['Buy stamps', 'Three', 'Two']);
    // Not in the boards list, not for others: not even for an owner of the workspace.
    const list = await ann.get(`/site-api/workspaces/${wsA}/boards`);
    expect((list.json.items as J[]).map(x => x.name).sort()).toEqual(['Roadmap', 'Roadmap secret']);
    expect((await mia.get(`/site-api/workspaces/${wsA}/inbox`)).json.items).toEqual([]);
    expect((await mia.get(`/site-api/boards/${inboxBoards[0]!.id}`)).status).toBe(404);
    expect((await search(mia, 'stamps')).json.cards).toHaveLength(0);
    expect((await search(ann, 'stamps')).json.cards).toHaveLength(1);
    // A viewer may not capture; validation answers 422.
    expect((await vic.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'x'})).status).toBe(403);
    expect((await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: '  '})).status).toBe(422);
  });

  it('triages an Inbox card into a board lane the visitor may write; others get 404', async () => {
    const card = (await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Sort me'})).json.card.id as number;
    const miaCard = (await mia.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Mia private'})).json.card.id as number;
    // Someone else's Inbox card, and another workspace's user: 404.
    expect((await mia.post(`/site-api/inbox/cards/${card}/triage`, {laneId: openLane})).status).toBe(404);
    expect((await bob.post(`/site-api/inbox/cards/${card}/triage`, {laneId: openLane})).status).toBe(404);
    // A lane of a board Mia has no seat on: 404, and the card stays in her Inbox.
    expect((await mia.post(`/site-api/inbox/cards/${miaCard}/triage`, {laneId: privLane})).status).toBe(404);
    // A viewer-only board role: 403 (Mia is made a viewer on the open board).
    await db.boardMember.create({data: {boardId: openBoard, userId: await userId('mia@example.test'), workspaceId: wsA, role: 'viewer'}});
    expect((await mia.post(`/site-api/inbox/cards/${miaCard}/triage`, {laneId: openLane})).status).toBe(403);
    expect((await mia.get(`/site-api/workspaces/${wsA}/inbox`)).json.items).toHaveLength(1);
    // The owner: moves it, counters and the Inbox follow.
    const ok = await ann.post(`/site-api/inbox/cards/${card}/triage`, {laneId: openLane});
    expect(ok.status).toBe(200);
    expect((await ann.get(`/site-api/workspaces/${wsA}/inbox`)).json.items).toEqual([]);
    const board = await ann.get(`/site-api/boards/${openBoard}`);
    expect(board.json.lanes[0].cards.map((c: J) => c.title)).toEqual(['Sort me']);
    expect(board.json.lanes[0].cardCount).toBe(1);
    // A card already on a board is not an Inbox card any more.
    expect((await ann.post(`/site-api/inbox/cards/${card}/triage`, {laneId: openLane})).status).toBe(404);
    expect((await ann.post(`/site-api/inbox/cards/${card}/triage`, {laneId: 'x'})).status).toBe(422);
  });
});
