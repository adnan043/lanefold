import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Lane paging by (position, id) row comparison and the board-open per-lane query: byte order, ties, non-ASCII keys. */
describe.skipIf(!DATABASE_URL)('lane paging and board open (integration, real Postgres)', () => {
  let ann: Browser;
  let boardId: number;
  let laneId: number;
  let wsId: number;
  let createdBy: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    createdBy = (await db.user.findFirstOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    wsId = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    boardId = (await ann.post(`/site-api/workspaces/${wsId}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']})).json.board.id;
    laneId = (await ann.get(`/site-api/boards/${boardId}`)).json.lanes[0].id;
  });

  it('pages are the byte order of (position, id), ties and non-ASCII included, with no gap or repeat', async () => {
    await ann.post(`/site-api/lanes/${laneId}/cards`, {titles: ['seed']});
    const keys = ['a0', 'a0', 'a0', 'B1', 'b1', 'Zz', 'a1', 'é1', 'é1', 'a0V', 'a', 'ß', '~', '0'];
    const rows = [];
    for (let i = 0; i < 70; i++) rows.push(keys[i % keys.length]! + (i % 3 === 0 ? '' : String(i % 5)));
    await db.card.createMany({
      data: rows.map((position, i) => ({workspaceId: wsId, boardId, laneId, title: `c${i}`, position, updatedRev: 1n, createdBy})),
    });
    const all = await db.card.findMany({where: {laneId, archivedAt: null}, select: {id: true, position: true}});
    const expected = all
      .sort((x, y) => Buffer.compare(Buffer.from(x.position), Buffer.from(y.position)) || x.id - y.id)
      .map(r => r.id);
    const seen: number[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const res: {status: number; json: J} = await ann.get(`/site-api/lanes/${laneId}/cards${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.json.items.map((i: J) => i.id));
      after = res.json.next;
      if (!after) break;
    }
    expect(seen).toEqual(expected);
  });

  it('board open caps by lane position, not lane id, after lanes are reordered', async () => {
    const lanes = (await ann.get(`/site-api/boards/${boardId}`)).json.lanes;
    const [first, second] = [lanes[0].id, lanes[1].id];
    // Move the first lane (lowest id) after the second: the second lane is now left-most.
    expect((await ann.post(`/site-api/lanes/${first}/move`, {afterId: second})).status).toBe(200);
    await db.card.createMany({
      data: Array.from({length: 20}, (_, i) => ({workspaceId: wsId, boardId, laneId: second, title: `s${i}`, position: `a${String(i).padStart(2, '0')}`, updatedRev: 1n, createdBy})),
    });
    await db.card.createMany({
      data: Array.from({length: 20}, (_, i) => ({workspaceId: wsId, boardId, laneId: first, title: `f${i}`, position: `a${String(i).padStart(2, '0')}`, updatedRev: 1n, createdBy})),
    });
    const res = await ann.get(`/site-api/boards/${boardId}`);
    expect(res.json.lanes.map((l: J) => l.id)).toEqual([second, first]);
    expect(res.json.lanes[0].cards.map((c: J) => c.title)).toEqual(Array.from({length: 15}, (_, i) => `s${i}`));
  });

  it('a card cursor above the int range is a 422, not a 500', async () => {
    expect((await ann.get(`/site-api/lanes/${laneId}/cards?after=${encodeURIComponent('a0|9999999999')}`)).status).toBe(422);
  });

  it('board open returns 15 cards per lane in lane then position order and says there is more', async () => {
    await db.card.createMany({
      data: Array.from({length: 20}, (_, i) => ({workspaceId: wsId, boardId, laneId, title: `c${i}`, position: `a${String(i).padStart(2, '0')}`, updatedRev: 1n, createdBy})),
    });
    await db.lane.update({where: {id: laneId}, data: {cardCount: 20}});
    const res = await ann.get(`/site-api/boards/${boardId}`);
    const lane = res.json.lanes[0];
    expect(lane.cards.map((c: J) => c.title)).toEqual(Array.from({length: 15}, (_, i) => `c${i}`));
    expect(lane.hasMore).toBe(true);
    expect(res.json.lanes[1].cards).toEqual([]);
  });
});
