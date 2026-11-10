import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** GET /conversations/:id, canModerate on the messages answer, members search (real Postgres). */
describe.skipIf(!DATABASE_URL)('chat extras (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let mia: Browser; // member of A
  let bob: Browser; // owner of B
  let wsA: number;
  let wsB: number;
  let channel: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.42');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.43');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    wsB = (await bob.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id;
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    channel = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'})).json.conversation.id;
  });

  it('GET /conversations/:id: members see it, another workspace gets 404, a DM stays private', async () => {
    const ok = await mia.get(`/site-api/conversations/${channel}`);
    expect(ok.status).toBe(200);
    expect(ok.json.conversation).toMatchObject({id: channel, kind: 'channel', name: 'general', workspaceId: wsA, canWrite: true, canModerate: false});
    expect((await ann.get(`/site-api/conversations/${channel}`)).json.conversation.canModerate).toBe(true);
    expect((await bob.get(`/site-api/conversations/${channel}`)).status).toBe(404);
    expect((await ann.get('/site-api/conversations/abc')).status).toBe(404);
    // reading metadata does not join
    expect((await db.conversationMember.count({where: {conversationId: channel, userId: ids.mia!}}))).toBe(0);
    const dm = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.mia!]});
    const dmId = dm.json.conversation.id;
    expect((await mia.get(`/site-api/conversations/${dmId}`)).json.conversation.peer.name).toBe('ann');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.bob!, role: 'member'}});
    expect((await bob.get(`/site-api/conversations/${dmId}`)).status).toBe(404);
  });

  it('board chat metadata follows board access', async () => {
    const board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    const conv = (await ann.get(`/site-api/boards/${board}/conversation`)).json.conversation.id;
    const res = await mia.get(`/site-api/conversations/${conv}`);
    expect(res.json.conversation).toMatchObject({kind: 'board', boardId: board, name: 'Roadmap'});
    expect((await bob.get(`/site-api/conversations/${conv}`)).status).toBe(404);
  });

  it('messages answer carries canModerate', async () => {
    expect((await ann.get(`/site-api/conversations/${channel}/messages`)).json.canModerate).toBe(true);
    expect((await mia.get(`/site-api/conversations/${channel}/messages`)).json.canModerate).toBe(false);
  });

  it('members search: names only, bounded, scoped to the workspace', async () => {
    const res = await mia.get(`/site-api/workspaces/${wsA}/members/search?q=AN`);
    expect(res.status).toBe(200);
    expect((res.json.items as J[]).map(i => i.name)).toEqual(['ann']);
    expect(JSON.stringify(res.json)).not.toContain('@');
    const all = await mia.get(`/site-api/workspaces/${wsA}/members/search?q=`);
    expect((all.json.items as J[]).length).toBe(2);
    expect((await mia.get(`/site-api/workspaces/${wsA}/members/search?q=%25`)).json.items).toEqual([]);
    expect((await mia.get(`/site-api/workspaces/${wsA}/members/search?q=${'x'.repeat(41)}`)).status).toBe(422);
    // another workspace: 404; Bob sees only his own people
    expect((await bob.get(`/site-api/workspaces/${wsA}/members/search?q=a`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsB}/members/search?q=ann`)).json.items).toEqual([]);
  });

  it('GET /cards/refs: batched, isolated by workspace and private board, no emails', async () => {
    const open = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Open', lanes: ['To do']})).json.board.id;
    const priv = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private', lanes: ['To do']})).json.board.id;
    const openLane = (await ann.get(`/site-api/boards/${open}`)).json.lanes[0].id;
    const privLane = (await ann.get(`/site-api/boards/${priv}`)).json.lanes[0].id;
    const a = (await ann.post(`/site-api/lanes/${openLane}/cards`, {title: 'Open card'})).json.items[0].id;
    const b = (await ann.post(`/site-api/lanes/${privLane}/cards`, {title: 'Secret card'})).json.items[0].id;
    const q = (who: Browser, list: string) => who.get(`/site-api/cards/refs?ids=${list}`);

    const own = await q(ann, `${b},${a},${a}`);
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toContain('no-store');
    expect((own.json.items as J[]).map(i => i.id).sort()).toEqual([a, b].sort());
    expect((own.json.items as J[]).find(i => i.id === a)).toEqual({id: a, number: 1, title: 'Open card', boardId: open, boardName: 'Open', done: false});
    expect(JSON.stringify(own.json)).not.toContain('@');
    // a plain member sees the open board's card, not the private one (absent, not an error)
    expect(((await q(mia, `${a},${b}`)).json.items as J[]).map(i => i.id)).toEqual([a]);
    // a private board member sees it
    await db.boardMember.create({data: {boardId: priv, userId: ids.mia!, workspaceId: wsA, role: 'member'}});
    expect(((await q(mia, `${a},${b}`)).json.items as J[]).length).toBe(2);
    // another workspace sees nothing, same status as for ids that do not exist
    const other = await q(bob, `${a},${b},999999`);
    expect(other.status).toBe(200);
    expect(other.json.items).toEqual([]);
    // validation
    expect((await q(ann, '')).status).toBe(422);
    expect((await q(ann, '1,x')).status).toBe(422);
    expect((await q(ann, '0')).status).toBe(422);
    expect((await q(ann, Array.from({length: 21}, (_, i) => i + 1).join(','))).status).toBe(422);
  });

  describe('POST /messages/:id/card', () => {
    const post = (b: Browser, msg: string, body: J) => b.post(`/site-api/messages/${msg}/card`, body);
    let board: number;
    let lane: number;
    let msg: string;

    beforeEach(async () => {
      board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
      lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
      msg = (await ann.post(`/site-api/conversations/${channel}/messages`, {body: 'Fix the login\nit breaks on Safari', clientId: 'client-card-1'})).json.message.id;
    });

    it('creates the card, attaches it to the message and logs activity', async () => {
      const res = await post(mia, msg, {laneId: lane});
      expect(res.status).toBe(201);
      expect(res.json.card).toMatchObject({boardId: board, laneId: lane, title: 'Fix the login'});
      const card = await db.card.findUniqueOrThrow({where: {id: res.json.card.id}});
      expect(card.descriptionMd).toContain('it breaks on Safari');
      expect(card.descriptionMd).toContain('From chat: #general');
      expect((await db.lane.findUniqueOrThrow({where: {id: lane}})).cardCount).toBe(1);
      expect(await db.messageCardRef.count({where: {cardId: card.id}})).toBe(1);
      expect(await db.activity.count({where: {cardId: card.id, kind: 'card.created'}})).toBe(1);
      const custom = await post(ann, msg, {laneId: lane, title: '  Own title '});
      expect(custom.json.card.title).toBe('Own title');
      expect((await post(ann, msg, {laneId: lane, title: 'x'.repeat(201)})).status).toBe(422);
      expect((await post(ann, msg, {})).status).toBe(422);
    });

    it('another workspace gets 404 for the message and for a lane of another workspace', async () => {
      expect((await post(bob, msg, {laneId: lane})).status).toBe(404);
      const boardB = (await bob.post(`/site-api/workspaces/${wsB}/boards`, {name: 'Beta board', lanes: ['L']})).json.board.id;
      const laneB = (await bob.get(`/site-api/boards/${boardB}`)).json.lanes[0].id;
      expect((await post(ann, msg, {laneId: laneB})).status).toBe(404);
      expect((await post(ann, 'abc', {laneId: lane})).status).toBe(404);
    });

    it('a viewer of the board gets 403', async () => {
      await db.boardMember.create({data: {boardId: board, workspaceId: wsA, userId: ids.mia!, role: 'viewer'}});
      expect((await post(mia, msg, {laneId: lane})).status).toBe(403);
    });

    it('a private board without a seat is a 404 (its name never leaks)', async () => {
      const priv = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private', lanes: ['L']})).json.board.id;
      const privLane = (await ann.get(`/site-api/boards/${priv}`)).json.lanes[0].id;
      const res = await post(mia, msg, {laneId: privLane});
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.json)).not.toContain('Secret');
    });

    it('a read-only workspace refuses with 409', async () => {
      await db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
      const res = await post(ann, msg, {laneId: lane});
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('workspace_read_only');
    });
  });
});

