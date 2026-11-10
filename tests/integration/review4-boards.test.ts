import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {resolveBoardRole} from '../../src/server/workspaces';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

describe('resolveBoardRole (pure)', () => {
  it('clamps a workspace viewer to viewer whatever the override', () => {
    expect(resolveBoardRole('viewer', 'workspace', 'admin')).toBe('viewer');
    expect(resolveBoardRole('viewer', 'private', 'admin')).toBe('viewer');
    expect(resolveBoardRole('viewer', 'private', null)).toBeNull();
    expect(resolveBoardRole('member', 'private', null)).toBeNull();
    expect(resolveBoardRole('member', 'private', 'viewer')).toBe('viewer');
    expect(resolveBoardRole('admin', 'private', null)).toBe('admin');
  });
});

/** Review 4: private boards, sync feeds and ids in bodies (real Postgres). */
describe.skipIf(!DATABASE_URL)('review 4: boards authorization (integration)', () => {
  let ann: Browser; // owner of A
  let mia: Browser; // member of A, no seat on the private board
  let vic: Browser; // viewer of A with a stale admin seat on the private board
  let bob: Browser; // owner of B
  let wsA: number;
  let wsB: number;
  let secret: number;
  let secretLane: number;
  let secretCard: number;
  let openBoard: number;
  let openLane: number;
  let bobLane: number;
  let bobCard: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.42');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.43');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.44');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    wsB = (await bob.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id;
    const id = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await id('mia@example.test'), role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: await id('vic@example.test'), role: 'viewer'}});
    const priv = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private', lanes: ['S1']});
    secret = priv.json.board.id;
    secretLane = (await ann.get(`/site-api/boards/${secret}`)).json.lanes[0].id;
    secretCard = (await ann.post(`/site-api/lanes/${secretLane}/cards`, {title: 'Hidden'})).json.items[0].id;
    const open = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Open', lanes: ['O1']});
    openBoard = open.json.board.id;
    openLane = (await ann.get(`/site-api/boards/${openBoard}`)).json.lanes[0].id;
    // vic: viewer in the workspace, but a leftover admin seat on the private board (a demotion that kept the row).
    await db.boardMember.create({data: {boardId: secret, workspaceId: wsA, userId: await id('vic@example.test'), role: 'admin'}});
    const bb = await bob.post(`/site-api/workspaces/${wsB}/boards`, {name: 'B board', lanes: ['B1']});
    bobLane = (await bob.get(`/site-api/boards/${bb.json.board.id}`)).json.lanes[0].id;
    bobCard = (await bob.post(`/site-api/lanes/${bobLane}/cards`, {title: 'Bob card'})).json.items[0].id;
  });

  it('a member without a seat gets 404 on every sync, lane and card route of a private board', async () => {
    for (const path of [`/site-api/boards/${secret}`, `/site-api/boards/${secret}/rev`, `/site-api/boards/${secret}/changes?since=0`, `/site-api/lanes/${secretLane}/cards`]) {
      expect((await mia.get(path)).status, path).toBe(404);
    }
    const writes: [string, string, unknown][] = [
      ['PATCH', `/site-api/boards/${secret}`, {name: 'x'}],
      ['POST', `/site-api/boards/${secret}/lanes`, {name: 'x'}],
      ['POST', `/site-api/lanes/${secretLane}/cards`, {title: 'x'}],
      ['PATCH', `/site-api/cards/${secretCard}`, {title: 'x'}],
      ['POST', `/site-api/cards/${secretCard}/move`, {laneId: secretLane, afterId: null}],
      ['POST', `/site-api/cards/${secretCard}/archive`, {}],
      ['PUT', `/site-api/boards/${secret}/star`, {}],
    ];
    for (const [method, path, body] of writes) expect((await mia.request(method, path, body)).status, `${method} ${path}`).toBe(404);
  });

  it('a workspace viewer keeps read-only access even with a stale admin seat', async () => {
    const got = await vic.get(`/site-api/boards/${secret}`);
    expect(got.status).toBe(200);
    expect(got.json.board.role).toBe('viewer');
    expect(got.json.board.canAdmin).toBe(false);
    expect((await vic.request('PATCH', `/site-api/boards/${secret}`, {name: 'x'})).status).toBe(403);
    expect((await vic.post(`/site-api/lanes/${secretLane}/cards`, {title: 'x'})).status).toBe(403);
    expect((await vic.post(`/site-api/cards/${secretCard}/move`, {laneId: secretLane, afterId: null})).status).toBe(403);
    const feed = await vic.get(`/site-api/boards/${secret}/changes?since=0`);
    expect(feed.json.board.canWrite).toBe(false);
  });

  it('the changes feed of one board never carries rows of another board', async () => {
    const feed = await ann.get(`/site-api/boards/${openBoard}/changes?since=0`);
    expect(feed.status).toBe(200);
    const laneIds = (feed.json.lanes as J[]).map(l => l.id);
    const cardIds = (feed.json.cards as J[]).map(k => k.id);
    expect(laneIds).toContain(openLane);
    expect(laneIds).not.toContain(secretLane);
    expect(cardIds).not.toContain(secretCard);
  });

  it('ids in the body cannot cross boards or workspaces', async () => {
    const mine = (await ann.post(`/site-api/lanes/${openLane}/cards`, {title: 'Mine'})).json.items[0].id;
    // Target lane of another workspace / another board of the same workspace: 404, card unchanged.
    expect((await ann.post(`/site-api/cards/${mine}/move`, {laneId: bobLane, afterId: null})).status).toBe(404);
    expect((await ann.post(`/site-api/cards/${mine}/move`, {laneId: secretLane, afterId: null})).status).toBe(404);
    // A neighbour id from another lane / workspace is only "stale", never used for a key.
    expect((await ann.post(`/site-api/cards/${mine}/move`, {laneId: openLane, afterId: bobCard})).status).toBe(409);
    expect((await ann.post(`/site-api/cards/${mine}/move`, {laneId: openLane, afterId: secretCard})).status).toBe(409);
    expect((await ann.post(`/site-api/lanes/${openLane}/move`, {afterId: secretLane})).status).toBe(409);
    const row = await db.card.findUniqueOrThrow({where: {id: mine}, select: {laneId: true, workspaceId: true}});
    expect(row).toEqual({laneId: openLane, workspaceId: wsA});
    // Ignored body fields: workspace and board come from the server.
    const made = await ann.post(`/site-api/lanes/${openLane}/cards`, {title: 'x', workspaceId: wsB, boardId: secret});
    const created = await db.card.findUniqueOrThrow({where: {id: made.json.items[0].id}, select: {workspaceId: true, boardId: true}});
    expect(created).toEqual({workspaceId: wsA, boardId: openBoard});
  });

  it('attachments of a private board are not viewable, renamed or removed without a seat', async () => {
    const att = await db.attachment.create({data: {workspaceId: wsA, cardId: secretCard, name: 'a', url: 'https://example.test/a', ready: true, uploadedBy: null}});
    expect((await mia.get(`/site-api/attachments/${att.id}/view`)).status).toBe(404);
    expect((await mia.request('PATCH', `/site-api/attachments/${att.id}`, {name: 'x'})).status).toBe(404);
    expect((await mia.request('DELETE', `/site-api/attachments/${att.id}`)).status).toBe(404);
    expect((await bob.get(`/site-api/attachments/${att.id}/view`)).status).toBe(404);
    expect((await mia.get(`/site-api/cards/${secretCard}/detail`)).status).toBe(404);
  });
});
