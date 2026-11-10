import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Card watch: the toggle, who is told about a change, and who is not (real Postgres). */
describe.skipIf(!DATABASE_URL)('card watch (integration, real Postgres)', () => {
  let ann: Browser; // owner of A, the actor
  let cat: Browser; // member of A, watches
  let bob: Browser; // other workspace
  let viewer: Browser; // viewer in A
  let wsA: number;
  let boardA: number;
  let laneA: number;
  let laneB: number;
  let card: number;
  let catId: number;
  let annId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    cat = await signedIn(app, 'cat@example.test', undefined, '203.0.113.62');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.63');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.64');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const ids = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    catId = await ids('cat@example.test');
    annId = await ids('ann@example.test');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: catId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await ids('vic@example.test'), role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']})).json.board.id;
    const lanes = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes;
    laneA = lanes[0].id;
    laneB = lanes[1].id;
    card = (await ann.post(`/site-api/lanes/${laneA}/cards`, {title: 'Watched'})).json.items[0].id;
  });

  const detail = async (who: Browser) => (await who.get(`/site-api/cards/${card}/detail`)).json as J;
  const heard = (userId: number, kind: string) => db.notification.count({where: {userId, kind, cardId: card}});

  it('toggles per person, is idempotent, and the detail says whether you watch', async () => {
    // The creator follows the card they made.
    expect((await detail(ann)).watching).toBe(true);
    expect((await detail(cat)).watching).toBe(false);
    expect((await cat.request('PUT', `/site-api/cards/${card}/watch`)).json).toEqual({watching: true});
    expect((await cat.request('PUT', `/site-api/cards/${card}/watch`)).status).toBe(200);
    expect(await db.cardWatcher.count({where: {cardId: card, userId: catId}})).toBe(1);
    expect((await detail(cat)).watching).toBe(true);
    expect((await detail(ann)).watching).toBe(true); // someone else's flag is not mine
    expect((await cat.request('DELETE', `/site-api/cards/${card}/watch`)).json).toEqual({watching: false});
    expect((await detail(cat)).watching).toBe(false);
  });

  it('a viewer may watch (reading is enough); another workspace gets 404 and no row', async () => {
    expect((await viewer.request('PUT', `/site-api/cards/${card}/watch`)).status).toBe(200);
    expect((await bob.request('PUT', `/site-api/cards/${card}/watch`)).status).toBe(404);
    expect((await bob.request('DELETE', `/site-api/cards/${card}/watch`)).status).toBe(404);
    expect(await db.cardWatcher.count({where: {cardId: card}})).toBe(2); // ann (creator) and the viewer
    expect((await ann.request('PUT', '/site-api/cards/99999999/watch')).status).toBe(404);
  });

  it('tells a watcher about a move, a due date change, a completion and an assignment, never the actor', async () => {
    await cat.request('PUT', `/site-api/cards/${card}/watch`);
    expect((await ann.post(`/site-api/cards/${card}/move`, {laneId: laneB})).status).toBe(200);
    expect(await heard(catId, 'card_moved')).toBe(1);
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: '2030-01-15'})).status).toBe(200);
    expect(await heard(catId, 'card_due')).toBe(1);
    // The same date again is not a change.
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: '2030-01-15'});
    expect(await heard(catId, 'card_due')).toBe(1);
    expect((await ann.request('PATCH', `/site-api/cards/${card}`, {dueDate: '2030-02-01'})).status).toBe(200);
    expect(await heard(catId, 'card_due')).toBe(2);
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {completed: true});
    expect(await heard(catId, 'card_done')).toBe(1);
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {completed: true}); // already done
    expect(await heard(catId, 'card_done')).toBe(1);
    // Ann follows too (she made the card) but did every one of these herself.
    expect(await db.notification.count({where: {userId: annId, cardId: card}})).toBe(0);
    // Assignment: the new assignee follows from then on and gets the plain "assigned"; others hear "card_member".
    await ann.request('PUT', `/site-api/cards/${card}/members/${catId}`);
    expect(await heard(catId, 'assigned')).toBe(1);
    expect(await heard(catId, 'card_member')).toBe(0);
    expect(await db.cardWatcher.count({where: {cardId: card, userId: catId}})).toBe(1);
  });

  it('a comment from someone else reaches the watcher; the commenter starts watching', async () => {
    await ann.request('DELETE', `/site-api/cards/${card}/watch`);
    await ann.request('PUT', `/site-api/cards/${card}/watch`);
    expect((await cat.post(`/site-api/cards/${card}/comments`, {body: 'Looks good', mentions: []})).status).toBe(201);
    expect(await heard(annId, 'comment')).toBe(1);
    expect(await heard(catId, 'comment')).toBe(0);
    expect((await detail(cat)).watching).toBe(true);
  });

  it('does not tell someone who lost access, nor someone who stopped watching', async () => {
    await cat.request('PUT', `/site-api/cards/${card}/watch`);
    // The board turns private: cat has no seat on it any more.
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {visibility: 'private'})).status).toBe(200);
    await db.notification.deleteMany({});
    await ann.post(`/site-api/cards/${card}/move`, {laneId: laneB});
    expect(await db.notification.count({where: {userId: catId}})).toBe(0);
    // Back to a workspace board, but cat stops watching.
    await ann.request('PATCH', `/site-api/boards/${boardA}`, {visibility: 'workspace'});
    await cat.request('DELETE', `/site-api/cards/${card}/watch`);
    await ann.post(`/site-api/cards/${card}/move`, {laneId: laneA});
    expect(await db.notification.count({where: {userId: catId}})).toBe(0);
  });
});
