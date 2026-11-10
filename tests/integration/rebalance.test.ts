import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {MAX_KEY_LENGTH} from '../../src/lib/position-key';
import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

const LONG = 'a0' + 'V'.repeat(MAX_KEY_LENGTH); // a valid key whose neighbour gap cannot take another character

describe.skipIf(!DATABASE_URL)('lane rebalancing (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let boardId: number;
  let lane1: number;
  let lane2: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.32');
    const wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    boardId = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['One', 'Two']})).json.board.id;
    const got = await ann.get(`/site-api/boards/${boardId}`);
    lane1 = got.json.lanes[0].id;
    lane2 = got.json.lanes[1].id;
  });

  const titles = async (lane: number) => {
    const rows = await db.card.findMany({where: {laneId: lane, archivedAt: null}, orderBy: [{position: 'asc'}, {id: 'asc'}], select: {title: true}});
    return rows.map(r => r.title);
  };

  async function exhaustedLane() {
    const made = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['A', 'B', 'C', 'D']});
    const ids = (made.json.items as J[]).map(c => c.id as number);
    // A and B sit in a gap that cannot take a key; C and D follow.
    await db.card.update({where: {id: ids[0]}, data: {position: LONG}});
    await db.card.update({where: {id: ids[1]}, data: {position: LONG + 'V'}});
    await db.card.update({where: {id: ids[2]}, data: {position: 'a1'}});
    await db.card.update({where: {id: ids[3]}, data: {position: 'a2'}});
    return ids;
  }

  it('drops a card into the exhausted gap, renumbers the lane, and bumps rev once', async () => {
    const ids = await exhaustedLane();
    const other = (await ann.post(`/site-api/lanes/${lane2}/cards`, {title: 'X'})).json.items[0].id as number;
    const before = BigInt((await ann.get(`/site-api/boards/${boardId}/rev`)).json.rev);
    const moved = await ann.post(`/site-api/cards/${other}/move`, {laneId: lane1, afterId: ids[0]});
    expect(moved.status).toBe(200);
    expect(BigInt(moved.json.rev)).toBe(before + 1n);
    expect(await titles(lane1)).toEqual(['A', 'X', 'B', 'C', 'D']);
    const rows = await db.card.findMany({where: {laneId: lane1}, select: {position: true, updatedRev: true}});
    for (const r of rows) {
      expect(r.position.length).toBeLessThan(10);
      expect(r.updatedRev).toBe(before + 1n);
    }
    expect(new Set(rows.map(r => r.position)).size).toBe(rows.length);
    const delta = await ann.get(`/site-api/boards/${boardId}/changes?since=${before}`);
    expect(delta.json.truncated).toBe(false);
    expect((delta.json.cards as J[]).map(c => c.id).sort()).toEqual([...ids, other].sort());
  });

  it('rebalances on a same-lane reorder too', async () => {
    const ids = await exhaustedLane();
    const moved = await ann.post(`/site-api/cards/${ids[3]}/move`, {laneId: lane1, afterId: ids[0]});
    expect(moved.status).toBe(200);
    expect(await titles(lane1)).toEqual(['A', 'D', 'B', 'C']);
    const rows = await db.card.findMany({where: {laneId: lane1}, select: {position: true}});
    expect(Math.max(...rows.map(r => r.position.length))).toBeLessThan(10);
  });

  it('reports a full reload (truncated) when the renumbered lane exceeds the delta cap', async () => {
    const ids = await exhaustedLane();
    const fill = Array.from({length: 310}, (_, i) => `F${i}`);
    for (let i = 0; i < fill.length; i += 10) expect((await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: fill.slice(i, i + 10)})).status).toBe(201);
    const other = (await ann.post(`/site-api/lanes/${lane2}/cards`, {title: 'X'})).json.items[0].id as number;
    const before = (await ann.get(`/site-api/boards/${boardId}/rev`)).json.rev as string;
    expect((await ann.post(`/site-api/cards/${other}/move`, {laneId: lane1, afterId: ids[0]})).status).toBe(200);
    const delta = await ann.get(`/site-api/boards/${boardId}/changes?since=${before}`);
    expect(delta.json.truncated).toBe(true);
    expect((await titles(lane1)).slice(0, 3)).toEqual(['A', 'X', 'B']);
  });

  it('renumbers lanes when a lane drops into an exhausted lane gap', async () => {
    const third = (await ann.post(`/site-api/boards/${boardId}/lanes`, {name: 'Three'})).json.lane.id as number;
    await db.lane.update({where: {id: lane1}, data: {position: LONG}});
    await db.lane.update({where: {id: lane2}, data: {position: LONG + 'V'}});
    const before = BigInt((await ann.get(`/site-api/boards/${boardId}/rev`)).json.rev);
    const moved = await ann.post(`/site-api/lanes/${third}/move`, {afterId: lane1});
    expect(moved.status).toBe(200);
    expect(BigInt(moved.json.rev)).toBe(before + 1n);
    const lanes = await db.lane.findMany({where: {boardId}, orderBy: [{position: 'asc'}, {id: 'asc'}], select: {id: true, position: true}});
    expect(lanes.map(l => l.id)).toEqual([lane1, third, lane2]);
    expect(Math.max(...lanes.map(l => l.position.length))).toBeLessThan(10);
  });

  it("another workspace's user cannot trigger or see a rebalance (404)", async () => {
    const ids = await exhaustedLane();
    expect((await bob.post(`/site-api/cards/${ids[3]}/move`, {laneId: lane1, afterId: ids[0]})).status).toBe(404);
    expect(await titles(lane1)).toEqual(['A', 'B', 'C', 'D']);
  });
});
