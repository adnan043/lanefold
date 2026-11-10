import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** `#42` in a board chat resolves to a card of THAT board the reader may open, and to nothing else (real Postgres). */
describe.skipIf(!DATABASE_URL)('chat card numbers (integration, real Postgres)', () => {
  let ann: Browser; // owner of workspace A
  let ben: Browser; // member of A, no seat on the private board
  let bob: Browser; // owner of another workspace
  let ws: number;
  let boardA: number;
  let boardB: number;
  let priv: number;
  let convA: number;
  let cardsA: J[];
  let secret: J;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.81');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.82');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.83');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: benId, role: 'member'}});
    boardA = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    boardB = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Release', lanes: ['Backlog']})).json.board.id;
    priv = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Secret', lanes: ['Hidden'], visibility: 'private'})).json.board.id;
    const lane = async (id: number) => (await ann.get(`/site-api/boards/${id}`)).json.lanes[0].id as number;
    cardsA = (await ann.post(`/site-api/lanes/${await lane(boardA)}/cards`, {titles: ['Alpha one', 'Alpha two', 'Alpha three']})).json.items;
    await ann.post(`/site-api/lanes/${await lane(boardB)}/cards`, {titles: ['Beta one']});
    secret = (await ann.post(`/site-api/lanes/${await lane(priv)}/cards`, {titles: ['TOP SECRET plan']})).json.items[0];
    convA = (await ann.get(`/site-api/boards/${boardA}/conversation`)).json.conversation.id;
  });

  const send = (b: Browser, conv: number, body: string, extra: J = {}) =>
    b.post(`/site-api/conversations/${conv}/messages`, {body, clientId: `c-${Math.random().toString(36).slice(2, 12)}`, ...extra});
  const page = async (b: Browser, conv: number, q = '') => (await b.get(`/site-api/conversations/${conv}/messages${q}`)).json.items as J[];

  it('resolves the numbers of this board, with id, board and title only, and leaves unknown ones as text', async () => {
    const sent = await send(ann, convA, 'see #1 and #3, not #99');
    expect(sent.status).toBe(201);
    const refs = sent.json.message.numberRefs as J;
    expect(Object.keys(refs).sort()).toEqual(['1', '3']);
    expect(refs['1']).toEqual({id: cardsA[0]!.id, boardId: boardA, title: 'Alpha one'});
    expect(refs['3']).toEqual({id: cardsA[2]!.id, boardId: boardA, title: 'Alpha three'});
    // The same on a list read, by another member of the workspace.
    const read = await page(ben, convA);
    expect(read).toHaveLength(1);
    expect(read[0]!.numberRefs['1'].title).toBe('Alpha one');
    expect(read[0]!.numberRefs['99']).toBeUndefined();
  });

  it('the number means the card of THIS board: another board with the same number is never shown', async () => {
    // Beta one is #1 on the other board; the chat of board A shows Alpha one.
    const sent = await send(ann, convA, '#1');
    expect(sent.json.message.numberRefs['1'].boardId).toBe(boardA);
    expect(JSON.stringify(sent.json)).not.toContain('Beta one');
    const convB = (await ann.get(`/site-api/boards/${boardB}/conversation`)).json.conversation.id;
    const other = await send(ann, convB, '#1');
    expect(other.json.message.numberRefs['1'].title).toBe('Beta one');
  });

  it('never leaks a private board card: its number in another board chat stays plain text and its title travels nowhere', async () => {
    expect(secret.number).toBe(1);
    const sent = await send(ann, convA, 'what about #1?');
    expect(JSON.stringify(sent.json)).not.toContain('TOP SECRET');
    expect(JSON.stringify(await page(ben, convA))).not.toContain('TOP SECRET');
    // A member with no seat cannot even open the private board's chat.
    const privConv = (await ann.get(`/site-api/boards/${priv}/conversation`)).json.conversation.id;
    await send(ann, privConv, 'plan is #1');
    expect((await ben.get(`/site-api/conversations/${privConv}/messages`)).status).toBe(404);
    // A seated member does see it, in that chat only.
    const benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    await db.boardMember.create({data: {boardId: priv, workspaceId: ws, userId: benId, role: 'member'}});
    const seen = await page(ben, privConv);
    expect(seen[0]!.numberRefs['1'].title).toBe('TOP SECRET plan');
  });

  it('another workspace gets 404 on the chat and learns nothing', async () => {
    await send(ann, convA, '#1 #2');
    expect((await bob.get(`/site-api/conversations/${convA}/messages`)).status).toBe(404);
    expect((await send(bob, convA, '#1')).status).toBe(404);
  });

  it('an archived card is plain text again (same answer as an unknown number)', async () => {
    await send(ann, convA, '#2');
    expect((await page(ann, convA))[0]!.numberRefs['2'].title).toBe('Alpha two');
    expect((await ann.post(`/site-api/cards/${cardsA[1]!.id}/archive`, {})).status).toBeLessThan(300);
    expect((await page(ann, convA))[0]!.numberRefs).toEqual({});
  });

  it('is not a thing outside a board chat (channel), in code, or in a deleted message', async () => {
    const channel = (await ann.post(`/site-api/workspaces/${ws}/conversations`, {kind: 'channel', name: 'general'})).json.conversation.id;
    expect((await send(ann, channel, 'see #1')).json.message.numberRefs).toEqual({});
    expect((await send(ann, convA, 'run `git log #1` and C#1')).json.message.numberRefs).toEqual({});
    const msg = (await send(ann, convA, 'gone #1')).json.message;
    expect(Object.keys(msg.numberRefs)).toEqual(['1']);
    expect((await ann.delete(`/site-api/messages/${msg.id}`)).status).toBeLessThan(300);
    const after = (await page(ann, convA)).find(m => m.id === msg.id)!;
    expect(after.numberRefs).toEqual({});
    expect(after.body).toBe('');
  });

  it('works in thread replies, in the polling read and after an edit', async () => {
    const top = (await send(ann, convA, 'parent')).json.message;
    const reply = await send(ben, convA, 'cf #2', {parentId: top.id});
    expect(reply.status).toBe(201);
    expect(reply.json.message.numberRefs['2'].title).toBe('Alpha two');
    const thread = await page(ann, convA, `?parent=${top.id}`);
    expect(thread[0]!.numberRefs['2'].id).toBe(cardsA[1]!.id);
    const polled = (await ann.get(`/site-api/conversations/${convA}/messages?after=0`)).json.items as J[];
    expect(polled.length).toBeGreaterThan(0);
    const edited = await ann.request('PATCH', `/site-api/messages/${top.id}`, {body: 'now #3'});
    expect(edited.status).toBe(200);
    expect(edited.json.message.numberRefs['3'].title).toBe('Alpha three');
  });
});
