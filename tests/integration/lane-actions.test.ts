import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** The "Lane actions" menu routes: copy, move all cards, archive all cards, sort, pin / watch (real Postgres). */
describe.skipIf(!DATABASE_URL)('lane actions (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let bob: Browser; // owns workspace B, no seat in A
  let viewer: Browser; // viewer in A
  let wsA: number;
  let boardA: number;
  let lane1: number;
  let lane2: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.21');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.22');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.23');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vic.id, role: 'viewer'}});
    const made = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']});
    boardA = made.json.board.id;
    const got = await ann.get(`/site-api/boards/${boardA}`);
    lane1 = got.json.lanes[0].id;
    lane2 = got.json.lanes[1].id;
  });

  const titles = async (b: Browser, lane: number) => {
    const res = await b.get(`/site-api/lanes/${lane}/cards`);
    return (res.json.items as J[]).map(c => c.title);
  };
  const lanesOf = async (b: Browser) => (await b.get(`/site-api/boards/${boardA}`)).json.lanes as J[];

  it('another workspace gets 404, a viewer 403 (except prefs, which are personal), signed out 401', async () => {
    const writes: [string, string, unknown][] = [
      ['POST', `/site-api/lanes/${lane1}/copy`, {name: 'x'}],
      ['POST', `/site-api/lanes/${lane1}/move-cards`, {toLaneId: lane2}],
      ['POST', `/site-api/lanes/${lane1}/archive-cards`, {}],
      ['POST', `/site-api/lanes/${lane1}/sort`, {by: 'name'}],
      ['PUT', `/site-api/lanes/${lane1}/prefs`, {pinned: true}],
    ];
    for (const [method, path, body] of writes) {
      expect((await new Browser(app).request(method, path, body)).status, `signed out ${path}`).toBe(401);
      expect((await bob.request(method, path, body)).status, `bob ${path}`).toBe(404);
      if (!path.endsWith('/prefs')) expect((await viewer.request(method, path, body)).status, `viewer ${path}`).toBe(403);
    }
    expect((await viewer.request('PUT', `/site-api/lanes/${lane1}/prefs`, {pinned: true})).status).toBe(200);
    // Nothing of the above changed the lane.
    expect((await lanesOf(ann))[0]).toMatchObject({name: 'To do', cardCount: 0});
  });

  it('copy: new lane right after the source with its color, limit and open cards in order', async () => {
    await ann.request('PATCH', `/site-api/lanes/${lane1}`, {colorHex: '#22C55E', wipLimit: 5});
    await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['One', 'Two', 'Three']});
    const res = await ann.post(`/site-api/lanes/${lane1}/copy`, {name: 'To do (copy)'});
    expect(res.status).toBe(201);
    const lanes = await lanesOf(ann);
    expect(lanes.map(l => l.name)).toEqual(['To do', 'To do (copy)', 'Doing']);
    expect(lanes[1]).toMatchObject({colorHex: '#22C55E', wipLimit: 5, cardCount: 3});
    expect(await titles(ann, res.json.laneId)).toEqual(['One', 'Two', 'Three']);
    expect(await titles(ann, lane1)).toEqual(['One', 'Two', 'Three']);
    expect((await ann.post(`/site-api/lanes/${lane1}/copy`, {name: ''})).status).toBe(422);
  });

  it('move-cards: all cards to the end of the other lane, counts kept, cross-board target refused', async () => {
    await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['A', 'B']});
    await ann.post(`/site-api/lanes/${lane2}/cards`, {titles: ['X']});
    const res = await ann.post(`/site-api/lanes/${lane1}/move-cards`, {toLaneId: lane2});
    expect(res.status).toBe(200);
    expect(res.json.moved).toBe(2);
    expect(await titles(ann, lane2)).toEqual(['X', 'A', 'B']);
    expect(await titles(ann, lane1)).toEqual([]);
    const lanes = await lanesOf(ann);
    expect([lanes[0].cardCount, lanes[1].cardCount]).toEqual([0, 3]);
    expect((await ann.post(`/site-api/lanes/${lane1}/move-cards`, {toLaneId: lane1})).status).toBe(422);
    // A lane of another workspace is "not found", never a place cards can go.
    const otherBoard = (await bob.get('/site-api/workspaces')).json.items[0].id;
    const b = await bob.post(`/site-api/workspaces/${otherBoard}/boards`, {name: 'Other', lanes: ['Theirs']});
    const theirLane = (await bob.get(`/site-api/boards/${b.json.board.id}`)).json.lanes[0].id;
    await ann.post(`/site-api/lanes/${lane2}/cards`, {titles: ['Mine']});
    expect((await ann.post(`/site-api/lanes/${lane2}/move-cards`, {toLaneId: theirLane})).status).toBe(404);
    expect(await titles(bob, theirLane)).toEqual([]);
  });

  it('archive-cards: every open card leaves the lane and the counter goes to 0', async () => {
    await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['A', 'B']});
    const res = await ann.post(`/site-api/lanes/${lane1}/archive-cards`, {});
    expect(res.json.archived).toBe(2);
    expect(await titles(ann, lane1)).toEqual([]);
    expect((await lanesOf(ann))[0].cardCount).toBe(0);
    expect((await ann.post(`/site-api/lanes/${lane1}/archive-cards`, {})).json.archived).toBe(0);
  });

  it('sort: by name, by due day (no due day last), rejects an unknown sort', async () => {
    const add = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['Charlie', 'Alpha', 'Bravo']});
    const [charlie, alpha, bravo] = (add.json.items as J[]).map(c => c.id);
    await ann.request('PATCH', `/site-api/cards/${bravo}`, {dueDate: '2030-01-01'});
    await ann.request('PATCH', `/site-api/cards/${charlie}`, {dueDate: '2029-01-01'});
    expect((await ann.post(`/site-api/lanes/${lane1}/sort`, {by: 'name'})).status).toBe(200);
    expect(await titles(ann, lane1)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await ann.post(`/site-api/lanes/${lane1}/sort`, {by: 'due'});
    expect(await titles(ann, lane1)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(alpha).toBeGreaterThan(0);
    expect((await ann.post(`/site-api/lanes/${lane1}/sort`, {by: 'title; DROP TABLE cards'})).status).toBe(422);
  });

  it('prefs: pin and watch are per person, come back on the board answer and clear their row when both are off', async () => {
    expect((await ann.request('PUT', `/site-api/lanes/${lane1}/prefs`, {pinned: true, watching: true})).json).toEqual({pinned: true, watching: true});
    expect((await lanesOf(ann))[0]).toMatchObject({pinned: true, watching: true});
    expect((await lanesOf(viewer))[0]).toMatchObject({pinned: false, watching: false});
    await ann.request('PUT', `/site-api/lanes/${lane1}/prefs`, {pinned: false});
    expect(await db.lanePref.count()).toBe(1);
    await ann.request('PUT', `/site-api/lanes/${lane1}/prefs`, {watching: false});
    expect(await db.lanePref.count()).toBe(0);
    expect((await ann.request('PUT', `/site-api/lanes/${lane1}/prefs`, {})).status).toBe(422);
    expect((await ann.request('PUT', `/site-api/lanes/${lane1}/prefs`, {pinned: 'yes'})).status).toBe(422);
  });
});
