import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Boards, lanes, cards: access, cross-workspace isolation, ordering, counters and sync (real Postgres). */
describe.skipIf(!DATABASE_URL)('boards (integration, real Postgres)', () => {
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
    expect(made.status).toBe(201);
    boardA = made.json.board.id;
    const got = await ann.get(`/site-api/boards/${boardA}`);
    lane1 = got.json.lanes[0].id;
    lane2 = got.json.lanes[1].id;
  });

  // The list is keyset-paged: follow `next` so long lanes come back whole.
  const titles = async (b: Browser, lane: number) => {
    const out: string[] = [];
    let after: string | null = null;
    do {
      const res: {json: J} = await b.get(`/site-api/lanes/${lane}/cards${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      out.push(...(res.json.items as J[]).map(c => c.title));
      after = res.json.next ?? null;
    } while (after);
    return out;
  };

  it('requires sign-in and creates a workspace owned by the creator', async () => {
    expect((await new Browser(app).get('/site-api/workspaces')).status).toBe(401);
    const mine = await ann.get('/site-api/workspaces');
    expect((mine.json.items as J[]).map(w => [w.name, w.role])).toEqual([['Alpha', 'owner']]);
  });

  it("another workspace's user gets 404 on every board, lane and card route", async () => {
    const add = await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Secret'});
    const card = add.json.items[0].id;
    const reads = [
      `/site-api/workspaces/${wsA}/boards`,
      `/site-api/boards/${boardA}`,
      `/site-api/boards/${boardA}/rev`,
      `/site-api/boards/${boardA}/changes?since=0`,
      `/site-api/lanes/${lane1}/cards`,
    ];
    for (const path of reads) expect((await bob.get(path)).status, path).toBe(404);
    const writes: [string, string, unknown][] = [
      ['PATCH', `/site-api/boards/${boardA}`, {name: 'x'}],
      ['PUT', `/site-api/boards/${boardA}/star`, {}],
      ['POST', `/site-api/workspaces/${wsA}/boards`, {name: 'x'}],
      ['POST', `/site-api/boards/${boardA}/lanes`, {name: 'x'}],
      ['PATCH', `/site-api/lanes/${lane1}`, {name: 'x'}],
      ['POST', `/site-api/lanes/${lane1}/move`, {afterId: null}],
      ['POST', `/site-api/lanes/${lane1}/archive`, {}],
      ['POST', `/site-api/lanes/${lane1}/cards`, {title: 'x'}],
      ['PATCH', `/site-api/cards/${card}`, {title: 'x'}],
      ['POST', `/site-api/cards/${card}/move`, {laneId: lane2, afterId: null}],
      ['POST', `/site-api/cards/${card}/archive`, {}],
    ];
    for (const [method, path, body] of writes) expect((await bob.request(method, path, body)).status, `${method} ${path}`).toBe(404);
    expect(await titles(ann, lane1)).toEqual(['Secret']);
  });

  it('keeps a viewer read-only', async () => {
    expect((await viewer.get(`/site-api/boards/${boardA}`)).json.board.canWrite).toBe(false);
    expect((await viewer.post(`/site-api/lanes/${lane1}/cards`, {title: 'x'})).status).toBe(403);
    expect((await viewer.post(`/site-api/workspaces/${wsA}/boards`, {name: 'x'})).status).toBe(403);
    expect((await viewer.request('PATCH', `/site-api/boards/${boardA}`, {name: 'x'})).status).toBe(403);
  });

  it('hides a private board from members without a seat', async () => {
    const priv = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private'});
    const id = priv.json.board.id;
    expect((await viewer.get(`/site-api/boards/${id}`)).status).toBe(404);
    const list = await viewer.get(`/site-api/workspaces/${wsA}/boards`);
    expect((list.json.items as J[]).map(b => b.name)).toEqual(['Roadmap']);
    expect((await ann.get(`/site-api/boards/${id}`)).status).toBe(200);
  });

  it('lets a plain member open, and administer, the private board they created', async () => {
    const mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.24');
    const miaRow = await db.user.findUniqueOrThrow({where: {email: 'mia@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: miaRow.id, role: 'member'}});
    const made = await mia.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Mine', visibility: 'private'});
    expect(made.status).toBe(201);
    const got = await mia.get(`/site-api/boards/${made.json.board.id}`);
    expect(got.status).toBe(200);
    expect(got.json.board.canAdmin).toBe(true);
    expect((await viewer.get(`/site-api/boards/${made.json.board.id}`)).status).toBe(404);
  });

  it('validates input with field errors', async () => {
    const res = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: '   '});
    expect(res.status).toBe(422);
    expect(res.json.fields.name).toBeTruthy();
    expect((await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'x'.repeat(201)})).status).toBe(422);
    expect((await ann.request('PATCH', `/site-api/lanes/${lane1}`, {colorHex: 'red'})).status).toBe(422);
    expect((await ann.post(`/site-api/cards/1/move`, {laneId: 'x'})).status).toBe(422);
  });

  it('adds many cards at once and counts them on the lane', async () => {
    const res = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['A', 'B', 'C']});
    expect(res.status).toBe(201);
    expect(await titles(ann, lane1)).toEqual(['A', 'B', 'C']);
    const got = await ann.get(`/site-api/boards/${boardA}`);
    expect(got.json.lanes[0].cardCount).toBe(3);
    expect(got.json.lanes[0].cards).toHaveLength(3);
  });

  it('reorders many cards with byte-order keys (COLLATE "C") and never renumbers siblings', async () => {
    const first = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['c0', 'c1']});
    let ids = (first.json.items as J[]).map(c => c.id);
    const expected = ['c0', 'c1'];
    // Keep inserting at the front and in the middle: keys grow but the order must always match.
    for (let i = 2; i < 40; i++) {
      const added = await ann.post(`/site-api/lanes/${lane1}/cards`, {title: `c${i}`});
      const id = added.json.items[0].id as number;
      const afterIndex = i % 3 === 0 ? -1 : Math.floor(ids.length / 2);
      const moved = await ann.post(`/site-api/cards/${id}/move`, {laneId: lane1, afterId: afterIndex < 0 ? null : ids[afterIndex]});
      expect(moved.status).toBe(200);
      ids.splice(afterIndex + 1, 0, id);
      expected.splice(afterIndex + 1, 0, `c${i}`);
    }
    expect(await titles(ann, lane1)).toEqual(expected);
    const positions = await db.card.findMany({where: {laneId: lane1}, select: {position: true}, orderBy: {position: 'asc'}});
    const sorted = positions.map(p => p.position);
    expect(sorted).toEqual([...sorted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('moves a card across lanes: counters, rev and the changes feed follow', async () => {
    const card = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Move me'})).json.items[0].id as number;
    const before = (await ann.get(`/site-api/boards/${boardA}/rev`)).json.rev as string;
    const moved = await ann.post(`/site-api/cards/${card}/move`, {laneId: lane2, afterId: null});
    expect(moved.status).toBe(200);
    expect(BigInt(moved.json.rev)).toBeGreaterThan(BigInt(before));
    const got = await ann.get(`/site-api/boards/${boardA}`);
    expect(got.json.lanes.map((l: J) => l.cardCount)).toEqual([0, 1]);
    const delta = await ann.get(`/site-api/boards/${boardA}/changes?since=${before}`);
    expect(delta.json.cards.map((c: J) => [c.id, c.laneId])).toEqual([[card, lane2]]);
    expect((delta.json.lanes as J[]).map(l => l.id).sort()).toEqual([lane1, lane2].sort());
    // A card cannot be moved into a lane of another board or workspace.
    const other = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Other', lanes: ['L']});
    const foreign = (await ann.get(`/site-api/boards/${other.json.board.id}`)).json.lanes[0].id;
    expect((await ann.post(`/site-api/cards/${card}/move`, {laneId: foreign, afterId: null})).status).toBe(404);
  });

  it('the changes feed carries the board fields and the caller role, and never skips past its own rev', async () => {
    const before = (await ann.get(`/site-api/boards/${boardA}/rev`)).json.rev as string;
    const card = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Delta'})).json.items[0].id as number;
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {name: 'Renamed', visibility: 'private'})).status).toBe(200);
    const delta = await ann.get(`/site-api/boards/${boardA}/changes?since=${before}`);
    expect(delta.status).toBe(200);
    expect(delta.json.board).toMatchObject({name: 'Renamed', visibility: 'private', role: 'admin', canWrite: true, canAdmin: true});
    expect(delta.json.cards.map((c: J) => c.id)).toEqual([card]);
    // Asking from the returned rev yields nothing new (everything up to it was delivered).
    const again = await ann.get(`/site-api/boards/${boardA}/changes?since=${delta.json.rev}`);
    expect(again.json.cards).toEqual([]);
    expect(again.json.lanes).toEqual([]);
  });

  it('restoring a card respects the lane cap and an archived lane', async () => {
    const made = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['r']});
    const card = made.json.items[0].id as number;
    expect((await ann.post(`/site-api/cards/${card}/archive`)).status).toBe(200);
    await db.lane.update({where: {id: lane1}, data: {cardCount: 500}});
    const full = await ann.post(`/site-api/cards/${card}/restore`);
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('lane_card_limit');
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).archivedAt).not.toBeNull();
    expect((await db.lane.findUniqueOrThrow({where: {id: lane1}})).cardCount).toBe(500);
    await db.lane.update({where: {id: lane1}, data: {cardCount: 0, archivedAt: new Date()}});
    const gone = await ann.post(`/site-api/cards/${card}/restore`);
    expect(gone.status).toBe(404);
    expect((await db.lane.findUniqueOrThrow({where: {id: lane1}})).cardCount).toBe(0);
  });

  it('keeps keys distinct when cards are moved after the same neighbour in parallel', async () => {
    const made = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['anchor', 'x', 'y', 'z']});
    const [anchor, x, y, z] = (made.json.items as J[]).map(c => c.id as number);
    const res = await Promise.all([x, y, z].map(id => ann.post(`/site-api/cards/${id}/move`, {laneId: lane2, afterId: null})));
    expect(res.every(r => r.status === 200)).toBe(true);
    const rows = await db.card.findMany({where: {laneId: lane2}, select: {position: true}});
    expect(new Set(rows.map(r => r.position)).size).toBe(3);
    expect(anchor).toBeGreaterThan(0);
  });

  it('archives and restores a card (undo), keeping the counter right', async () => {
    const card = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Gone'})).json.items[0].id as number;
    expect((await ann.post(`/site-api/cards/${card}/archive`)).status).toBe(200);
    expect(await titles(ann, lane1)).toEqual([]);
    expect((await ann.post(`/site-api/cards/${card}/archive`)).status).toBe(404);
    expect((await ann.post(`/site-api/cards/${card}/restore`)).status).toBe(200);
    expect(await titles(ann, lane1)).toEqual(['Gone']);
    expect((await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].cardCount).toBe(1);
  });

  it('pages a lane with a keyset cursor', async () => {
    const names = Array.from({length: 20}, (_, i) => `k${i}`);
    await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: names});
    await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: names.map(n => `${n}b`)});
    const page1 = await ann.get(`/site-api/lanes/${lane1}/cards`);
    expect(page1.json.items).toHaveLength(30);
    expect(page1.json.next).toBeTruthy();
    const page2 = await ann.get(`/site-api/lanes/${lane1}/cards?after=${encodeURIComponent(page1.json.next)}`);
    expect(page2.json.items).toHaveLength(10);
    expect(page2.json.next).toBeNull();
    const board = await ann.get(`/site-api/boards/${boardA}`);
    expect(board.json.lanes[0].cards).toHaveLength(15);
    expect(board.json.lanes[0].hasMore).toBe(true);
  });

  it('reorders lanes and archives a board', async () => {
    expect((await ann.post(`/site-api/lanes/${lane2}/move`, {afterId: null})).status).toBe(200);
    expect(((await ann.get(`/site-api/boards/${boardA}`)).json.lanes as J[]).map(l => l.id)).toEqual([lane2, lane1]);
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {archived: true})).status).toBe(200);
    expect((await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'x'})).status).toBe(409);
    expect((await ann.request('PATCH', `/site-api/boards/${boardA}`, {archived: false})).status).toBe(200);
  });

  it('refuses a move into a full lane and leaves both counters alone', async () => {
    const made = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['a']});
    expect(made.status).toBe(201);
    const card = made.json.items[0].id;
    await db.lane.update({where: {id: lane2}, data: {cardCount: 500}});
    const res = await ann.post(`/site-api/cards/${card}/move`, {laneId: lane2, afterId: null});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('lane_card_limit');
    expect((await db.lane.findUniqueOrThrow({where: {id: lane1}})).cardCount).toBe(1);
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).laneId).toBe(lane1);
  });

  it('keeps counters and order right when cards move into one lane in parallel', async () => {
    const names = Array.from({length: 8}, (_, i) => `p${i}`);
    const made = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: names});
    const ids = (made.json.items as J[]).map(c => c.id as number);
    const results = await Promise.all(ids.map(id => ann.post(`/site-api/cards/${id}/move`, {laneId: lane2, afterId: null})));
    expect(results.map(r => r.status)).toEqual(ids.map(() => 200));
    // Every move got its own rev.
    expect(new Set(results.map(r => String(r.json.rev))).size).toBe(ids.length);
    const counts = async () => {
      const lanes = await db.lane.findMany({where: {id: {in: [lane1, lane2]}}, orderBy: {id: 'asc'}, select: {id: true, cardCount: true}});
      const real = await Promise.all(lanes.map(l => db.card.count({where: {laneId: l.id, archivedAt: null}})));
      return {stored: lanes.map(l => l.cardCount), real};
    };
    expect(await counts()).toEqual({stored: [0, ids.length], real: [0, ids.length]});
    expect(await titles(ann, lane2)).toHaveLength(ids.length);
    // Sequential moves back, each after the previous: counters follow and positions are distinct and ordered.
    let after: number | null = null;
    for (const id of ids) {
      expect((await ann.post(`/site-api/cards/${id}/move`, {laneId: lane1, afterId: after})).status).toBe(200);
      after = id;
    }
    expect(await counts()).toEqual({stored: [ids.length, 0], real: [ids.length, 0]});
    const back = await db.card.findMany({where: {laneId: lane1}, select: {id: true, position: true}});
    expect(new Set(back.map(r => r.position)).size).toBe(ids.length);
    const order = await db.$queryRaw<{id: number}[]>`SELECT id FROM cards WHERE lane_id = ${lane1}::int ORDER BY position COLLATE "C", id`;
    expect(order.map(r => r.id)).toEqual(ids);
  });
});
