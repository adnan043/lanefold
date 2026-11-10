import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** A checklist item can name one person and a due day: who may set it, who is told, what survives (real Postgres). */
describe.skipIf(!DATABASE_URL)('checklist item assignee and due date (integration, real Postgres)', () => {
  let ann: Browser; // owner of A, the actor
  let cat: Browser; // member of A
  let dan: Browser; // member of A, but not on the private board
  let bob: Browser; // other workspace
  let viewer: Browser; // viewer in A
  let wsA: number;
  let boardA: number;
  let privateBoard: number;
  let card: number;
  let list: number;
  let item: number;
  let catId: number;
  let danId: number;
  let annId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    cat = await signedIn(app, 'cat@example.test', undefined, '203.0.113.72');
    dan = await signedIn(app, 'dan@example.test', undefined, '203.0.113.73');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.74');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.75');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const ids = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    annId = await ids('ann@example.test');
    catId = await ids('cat@example.test');
    danId = await ids('dan@example.test');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: catId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: danId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await ids('vic@example.test'), role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    const lane = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'With a list'})).json.items[0].id;
    list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Steps'})).json.checklist.id;
    item = (await ann.post(`/site-api/checklists/${list}/items`, {texts: ['First']})).json.items[0].id;
  });

  const detail = async (who: Browser) => (await who.get(`/site-api/cards/${card}/detail`)).json as J;
  const patch = (who: Browser, body: J, id = item) => who.request('PATCH', `/site-api/checklist-items/${id}`, body);
  const told = (userId: number) => db.notification.count({where: {userId, kind: 'assigned', cardId: card}});

  it('a new item has no person and no day; the detail shows both once set, with a name and never an email', async () => {
    const before = (await detail(ann)).checklists[0].items[0];
    expect(before).toMatchObject({text: 'First', done: false, assignee: null, dueDate: null});
    const res = await patch(ann, {assigneeId: catId, dueDate: '2030-03-04'});
    expect(res.status).toBe(200);
    const after = (await detail(cat)).checklists[0].items[0];
    expect(after.assignee).toEqual({id: catId, name: expect.any(String)});
    expect(after.dueDate).toBe('2030-03-04');
    expect(JSON.stringify(await detail(cat))).not.toContain('@example.test');
    const row = await db.checklistItem.findUniqueOrThrow({where: {id: item}, select: {assigneeId: true, dueDate: true}});
    expect(row.assigneeId).toBe(catId);
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2030-03-04');
  });

  it('changes and clears each on its own (null clears, absent leaves it)', async () => {
    await patch(ann, {assigneeId: catId, dueDate: '2030-03-04'});
    await patch(ann, {dueDate: null});
    let it = (await detail(ann)).checklists[0].items[0];
    expect(it.assignee?.id).toBe(catId);
    expect(it.dueDate).toBeNull();
    await patch(ann, {assigneeId: null});
    it = (await detail(ann)).checklists[0].items[0];
    expect(it.assignee).toBeNull();
    // Ticking it does not touch either.
    await patch(ann, {assigneeId: catId, dueDate: '2030-05-05'});
    await patch(ann, {done: true});
    it = (await detail(ann)).checklists[0].items[0];
    expect(it).toMatchObject({done: true, dueDate: '2030-05-05'});
    expect(it.assignee?.id).toBe(catId);
  });

  it('refuses a bad id or date with a field error, and a person who cannot see the board with 404', async () => {
    expect((await patch(ann, {dueDate: '2030-02-31'})).status).toBe(422);
    expect((await patch(ann, {dueDate: 'tomorrow'})).status).toBe(422);
    expect((await patch(ann, {assigneeId: 'cat'})).status).toBe(422);
    expect((await patch(ann, {assigneeId: -3})).status).toBe(422);
    expect((await patch(ann, {assigneeId: 99999999})).status).toBe(404);
    // Bob belongs to another workspace: he cannot be put on Alpha's item.
    const bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    expect((await patch(ann, {assigneeId: bobId})).status).toBe(404);
    expect(await db.checklistItem.count({where: {id: item, assigneeId: {not: null}}})).toBe(0);
  });

  it('on a private board only people with a seat can be chosen', async () => {
    privateBoard = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', lanes: ['L'], visibility: 'private'})).json.board.id;
    const lane = (await ann.get(`/site-api/boards/${privateBoard}`)).json.lanes[0].id;
    const c2 = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Hidden'})).json.items[0].id;
    const l2 = (await ann.post(`/site-api/cards/${c2}/checklists`, {title: 'S'})).json.checklist.id;
    const i2 = (await ann.post(`/site-api/checklists/${l2}/items`, {texts: ['x']})).json.items[0].id;
    expect((await patch(ann, {assigneeId: danId}, i2)).status).toBe(404); // no seat
    await db.boardMember.create({data: {boardId: privateBoard, workspaceId: wsA, userId: catId, role: 'member'}});
    expect((await patch(ann, {assigneeId: catId}, i2)).status).toBe(200); // has a seat
    expect((await patch(ann, {assigneeId: danId}, i2)).status).toBe(404); // still none
  });

  it('a viewer is refused (403), another workspace gets 404 and nothing changes', async () => {
    expect((await patch(viewer, {assigneeId: catId})).status).toBe(403);
    expect((await patch(bob, {assigneeId: catId})).status).toBe(404);
    expect((await patch(bob, {dueDate: '2030-01-01'})).status).toBe(404);
    expect((await bob.request('POST', `/site-api/checklists/${list}/items`, {texts: ['x'], assigneeId: catId})).status).toBe(404);
    const row = await db.checklistItem.findUniqueOrThrow({where: {id: item}, select: {assigneeId: true, dueDate: true}});
    expect(row).toEqual({assigneeId: null, dueDate: null});
  });

  it('tells the new person (not the actor), makes them follow the card, and is quiet when nothing changed', async () => {
    expect((await patch(ann, {assigneeId: catId})).status).toBe(200);
    expect(await told(catId)).toBe(1);
    expect(await db.cardWatcher.count({where: {cardId: card, userId: catId}})).toBe(1);
    // Same person again, and clearing, send nothing.
    await patch(ann, {assigneeId: catId});
    await patch(ann, {assigneeId: null});
    expect(await told(catId)).toBe(1);
    // Giving it to yourself tells nobody.
    await patch(ann, {assigneeId: annId});
    expect(await told(annId)).toBe(0);
    // A day alone tells nobody.
    await patch(ann, {dueDate: '2030-06-06'});
    expect(await told(danId)).toBe(0);
  });

  it('new items can carry the same person and day, validated the same way', async () => {
    const ok = await ann.request('POST', `/site-api/checklists/${list}/items`, {texts: ['a', 'b'], assigneeId: catId, dueDate: '2030-07-07'});
    expect(ok.status).toBe(201);
    for (const i of ok.json.items) expect(i).toMatchObject({assignee: {id: catId}, dueDate: '2030-07-07'});
    expect(await told(catId)).toBe(1);
    expect((await ann.request('POST', `/site-api/checklists/${list}/items`, {texts: ['c'], assigneeId: 99999999})).status).toBe(404);
    expect((await ann.request('POST', `/site-api/checklists/${list}/items`, {texts: ['c'], dueDate: 'x'})).status).toBe(422);
    expect(await db.checklistItem.count({where: {checklistId: list}})).toBe(3);
  });

  it('new items can carry a due time and a reminder, validated like the PATCH', async () => {
    const at = '2030-07-07T15:30:00.000Z';
    const ok = await ann.request('POST', `/site-api/checklists/${list}/items`, {texts: ['t1', 't2'], dueDate: '2030-07-07', dueAt: at, dueRemindMinutes: 60});
    expect(ok.status).toBe(201);
    for (const i of ok.json.items) expect(i).toMatchObject({dueDate: '2030-07-07', dueAt: at, dueRemindMinutes: 60});
    const post = (body: object) => ann.request('POST', `/site-api/checklists/${list}/items`, {texts: ['x'], ...body});
    expect((await post({dueAt: at})).status).toBe(422); // a time needs its day
    expect((await post({dueDate: '2030-07-07', dueAt: '2030-07-10T15:30:00.000Z'})).status).toBe(422); // not on that day
    expect((await post({dueDate: '2030-07-07', dueAt: at, dueRemindMinutes: 7})).status).toBe(422); // not in the list
    const dayOnly = await post({dueDate: '2030-07-07', dueRemindMinutes: 60});
    expect(dayOnly.status).toBe(201);
    expect(dayOnly.json.items[0]).toMatchObject({dueAt: null, dueRemindMinutes: null}); // no reminder without a time
  });

  it('deleting the person\'s account keeps the item and its day and clears the name', async () => {
    await patch(ann, {assigneeId: danId, dueDate: '2030-08-08'});
    await db.user.delete({where: {id: danId}});
    const row = await db.checklistItem.findUniqueOrThrow({where: {id: item}, select: {assigneeId: true, dueDate: true}});
    expect(row.assigneeId).toBeNull();
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2030-08-08');
    expect((await detail(ann)).checklists[0].items[0].assignee).toBeNull();
  });

  it('moving the card to a private board drops a person with no seat there but keeps the item and day', async () => {
    const target = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', lanes: ['L'], visibility: 'private'})).json.board.id;
    const lane = (await ann.get(`/site-api/boards/${target}`)).json.lanes[0].id;
    await patch(ann, {assigneeId: danId, dueDate: '2030-09-09'});
    const res = await ann.post(`/site-api/cards/${card}/move-to-board`, {boardId: target, laneId: lane});
    expect(res.status).toBe(200);
    const row = await db.checklistItem.findUniqueOrThrow({where: {id: item}, select: {assigneeId: true, dueDate: true, text: true}});
    expect(row.assigneeId).toBeNull();
    expect(row.text).toBe('First');
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2030-09-09');
  });
});
