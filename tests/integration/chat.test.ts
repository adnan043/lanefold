import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Chat: access, cross-workspace isolation, idempotent sends, keyset paging, unread, edit/delete, reactions (real Postgres). */
describe.skipIf(!DATABASE_URL)('chat (integration, real Postgres)', () => {
  let ann: Browser; // owner of workspace A
  let mia: Browser; // member of A
  let vic: Browser; // viewer of A
  let bob: Browser; // owner of workspace B, no seat in A
  let wsA: number;
  let boardA: number;
  let channel: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.32');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.33');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.34');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.vic!, role: 'viewer'}});
    const made = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'});
    // The workspace already has its #general: asking again returns that same channel (200), never a second one.
    expect([200, 201]).toContain(made.status);
    channel = made.json.conversation.id;
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  });

  const send = (b: Browser, conv: number, body: string, clientId = `c-${Math.random().toString(36).slice(2, 12)}`, extra: J = {}) =>
    b.post(`/site-api/conversations/${conv}/messages`, {body, clientId, ...extra});

  it('another workspace gets 404 on every conversation and message route', async () => {
    const sent = await send(ann, channel, 'secret');
    const msg = sent.json.message.id;
    for (const path of [`/site-api/workspaces/${wsA}/conversations`, `/site-api/boards/${boardA}/conversation`, `/site-api/conversations/${channel}/messages`]) {
      expect((await bob.get(path)).status, path).toBe(404);
    }
    const writes: [string, string, unknown][] = [
      ['POST', `/site-api/conversations/${channel}/messages`, {body: 'x', clientId: 'abcdefgh1'}],
      ['POST', `/site-api/conversations/${channel}/read`, {seq: 1}],
      ['PUT', `/site-api/conversations/${channel}/mute`, {}],
      ['PATCH', `/site-api/messages/${msg}`, {body: 'x'}],
      ['DELETE', `/site-api/messages/${msg}`, {}],
      ['PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'}],
      ['PUT', `/site-api/messages/${msg}/pin`, {}],
      ['POST', `/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'x'}],
    ];
    for (const [method, path, body] of writes) expect((await bob.request(method, path, body)).status, `${method} ${path}`).toBe(404);
    expect((await ann.get(`/site-api/conversations/${channel}/messages`)).json.items[0].body).toBe('secret');
  });

  it('sends idempotently, pages by seq and polls with after', async () => {
    const first = await send(mia, channel, 'one', 'client-key-1');
    expect(first.status).toBe(201);
    const retry = await send(mia, channel, 'one', 'client-key-1');
    expect(retry.status).toBe(200);
    expect(retry.json.message.id).toBe(first.json.message.id);
    // another sender cannot take the key
    expect((await send(ann, channel, 'two', 'client-key-1')).status).toBe(409);
    for (let i = 2; i <= 5; i++) await send(mia, channel, `m${i}`);
    const page = await ann.get(`/site-api/conversations/${channel}/messages?limit=3`);
    expect((page.json.items as J[]).map(m => m.seq)).toEqual([3, 4, 5]);
    expect(page.json.nextBefore).toBe(3);
    const older = await ann.get(`/site-api/conversations/${channel}/messages?before=3`);
    expect((older.json.items as J[]).map(m => m.seq)).toEqual([1, 2]);
    expect(older.json.nextBefore).toBeNull();
    const poll = await ann.get(`/site-api/conversations/${channel}/messages?after=4`);
    expect((poll.json.items as J[]).map(m => m.seq)).toEqual([5]);
    // no emails anywhere
    expect(JSON.stringify(page.json)).not.toContain('@example.test');
    expect(page.json.items[0].sender.name).toBe('mia');
  });

  it('validates: empty, too long, bad key', async () => {
    expect((await send(ann, channel, '   ')).status).toBe(422);
    expect((await send(ann, channel, 'x'.repeat(4001))).status).toBe(422);
    expect((await send(ann, channel, 'ok', 'bad key!')).status).toBe(422);
  });

  it('rate limits sending', async () => {
    let last = 201;
    for (let i = 0; i < 22 && last === 201; i++) last = (await send(mia, channel, `spam ${i}`)).status;
    expect(last).toBe(429);
  });

  it('unread math, read marker and pulse', async () => {
    for (let i = 0; i < 3; i++) await send(mia, channel, `hi ${i}`);
    // ann joined by creating the channel, lastReadSeq 0
    let pulse = (await ann.get('/site-api/chat/pulse')).json.items as J[];
    expect(pulse.find(p => p.conversationId === channel)).toMatchObject({lastSeq: 3, unread: 3});
    expect((await ann.post(`/site-api/conversations/${channel}/read`, {seq: 2})).json.unread).toBe(1);
    // the marker never moves back and never past the last message
    expect((await ann.post(`/site-api/conversations/${channel}/read`, {seq: 1})).json.lastReadSeq).toBe(2);
    expect((await ann.post(`/site-api/conversations/${channel}/read`, {seq: 99})).json.unread).toBe(0);
    pulse = (await mia.get('/site-api/chat/pulse')).json.items as J[];
    expect(pulse.find(p => p.conversationId === channel)?.unread).toBe(0); // the sender has read their own
  });

  it('viewers read but cannot send, react or create channels', async () => {
    const sent = await send(ann, channel, 'hello');
    expect((await vic.get(`/site-api/conversations/${channel}/messages`)).status).toBe(200);
    expect((await send(vic, channel, 'no')).status).toBe(403);
    expect((await vic.request('PUT', `/site-api/messages/${sent.json.message.id}/reactions`, {emoji: '👍'})).status).toBe(403);
    expect((await vic.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'x'})).status).toBe(403);
  });

  it('board chat follows the board role; private boards hide it', async () => {
    const conv = (await mia.get(`/site-api/boards/${boardA}/conversation`)).json.conversation.id;
    expect((await send(mia, conv, 'on the board')).status).toBe(201);
    expect((await send(vic, conv, 'viewer')).status).toBe(403);
    await ann.request('PATCH', `/site-api/boards/${boardA}`, {visibility: 'private'});
    expect((await mia.get(`/site-api/conversations/${conv}/messages`)).status).toBe(404);
    expect((await ann.get(`/site-api/conversations/${conv}/messages`)).status).toBe(200);
  });

  it('DMs: one per pair, only the two people, never cross-workspace', async () => {
    const dm = await mia.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.ann]});
    expect(dm.status).toBe(201);
    const again = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.mia]});
    expect(again.status).toBe(200);
    expect(again.json.conversation.id).toBe(dm.json.conversation.id);
    expect(dm.json.conversation.name).toBe('ann');
    await send(mia, dm.json.conversation.id, 'private');
    expect((await vic.get(`/site-api/conversations/${dm.json.conversation.id}/messages`)).status).toBe(404);
    expect((await mia.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.bob]})).status).toBe(422);
  });

  it('threads, mentions and card refs stay inside the workspace', async () => {
    const root = (await send(ann, channel, 'root')).json.message;
    const reply = await send(mia, channel, 'reply @ann', undefined, {parentId: root.id, mentions: [ids.ann, ids.bob]});
    expect(reply.status).toBe(201);
    expect(reply.json.message.mentions).toEqual([ids.ann]); // bob is not in this workspace
    const top = await ann.get(`/site-api/conversations/${channel}/messages`);
    expect((top.json.items as J[]).map(m => m.body)).toEqual(['root']);
    expect(top.json.items[0].replyCount).toBe(1);
    const thread = await ann.get(`/site-api/conversations/${channel}/messages?parent=${root.id}`);
    expect((thread.json.items as J[]).map(m => m.body)).toEqual(['reply @ann']);
    expect(await db.notification.count({where: {userId: ids.ann, kind: 'message_mention'}})).toBe(1);
  });

  it('someone removed and added back gets their old DM again (not a 404)', async () => {
    const dm = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.mia]});
    const conv = dm.json.conversation.id as number;
    await send(ann, conv, 'before');
    expect((await ann.request('DELETE', `/site-api/workspaces/${wsA}/members/${ids.mia}`)).status).toBe(200);
    expect((await mia.get(`/site-api/conversations/${conv}/messages`)).status).toBe(404); // gone while removed
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    const back = await mia.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.ann]});
    expect(back.status).toBe(200);
    expect(back.json.conversation.id).toBe(conv);
    expect((await mia.get(`/site-api/conversations/${conv}/messages`)).status).toBe(200);
    expect((await send(mia, conv, 'I am back')).status).toBe(201);
  });

  it('mention spam is capped: one sender reaches a person at most 20 times an hour', async () => {
    for (let round = 0; round < 2; round++) {
      // Chat's own send limit is 20 a minute: age the first round's messages so the second may follow.
      for (let i = 0; i < 13; i++) expect((await send(mia, channel, `@ann ping ${round}-${i}`, undefined, {mentions: [ids.ann]})).status).toBe(201);
      await db.message.updateMany({where: {senderId: ids.mia}, data: {createdAt: new Date(Date.now() - 120_000)}});
    }
    expect(await db.notification.count({where: {userId: ids.ann, kind: 'message_mention', actorId: ids.mia}})).toBe(20);
  });

  it('edit and delete: own only, moderators may delete, deleted text never returns', async () => {
    const msg = (await send(mia, channel, 'mine')).json.message.id;
    expect((await vic.request('PATCH', `/site-api/messages/${msg}`, {body: 'hax'})).status).toBe(404);
    expect((await ann.request('PATCH', `/site-api/messages/${msg}`, {body: 'hax'})).status).toBe(404);
    const edited = await mia.request('PATCH', `/site-api/messages/${msg}`, {body: 'edited'});
    expect(edited.json.message).toMatchObject({body: 'edited', edited: true});
    // a member cannot delete another's message; an admin can, and it is audited
    const other = (await send(ann, channel, 'ann says')).json.message.id;
    expect((await mia.delete(`/site-api/messages/${other}`)).status).toBe(404);
    expect((await ann.delete(`/site-api/messages/${msg}`)).status).toBe(200);
    expect(await db.auditEvent.count({where: {action: 'chat.message_deleted'}})).toBe(1);
    const list = await mia.get(`/site-api/conversations/${channel}/messages`);
    const gone = (list.json.items as J[]).find(m => m.id === msg);
    expect(gone).toMatchObject({deleted: true, body: ''});
  });

  it('reactions toggle and group', async () => {
    const msg = (await send(ann, channel, 'react')).json.message.id;
    await mia.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    const res = await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(res.json.reactions).toEqual([{emoji: '👍', count: 2, mine: true}]);
    expect((await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: 'x'})).status).toBe(422);
    const removed = await ann.request('DELETE', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(removed.json.reactions).toEqual([{emoji: '👍', count: 1, mine: false}]);
  });
});
