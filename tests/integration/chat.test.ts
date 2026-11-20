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

  it('rate limits sending at exactly 20 a minute', async () => {
    for (let i = 0; i < 20; i++) expect((await send(mia, channel, `spam ${i}`)).status, `message ${i + 1}`).toBe(201);
    const over = await send(mia, channel, 'one too many');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('30');
    // A retried send of a message already written is a replay, never refused by the limit.
    const sent = await db.message.findFirst({where: {conversationId: channel, senderId: ids.mia!}, select: {clientId: true}, orderBy: {seq: 'desc'}});
    expect((await send(mia, channel, 'spam 19', sent!.clientId)).status).toBe(200);
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
    const conv = (await mia.post(`/site-api/boards/${boardA}/conversation`)).json.conversation.id;
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

  it('members: a group lists its people by name, a channel answers with its scope, outsiders get 404', async () => {
    const group = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'group', name: 'Trio', userIds: [ids.mia, ids.vic]});
    expect(group.status).toBe(201);
    const gid = group.json.conversation.id;
    const listed = await mia.get(`/site-api/conversations/${gid}/members`);
    expect(listed.status).toBe(200);
    expect(listed.json.scope).toBe('members');
    expect((listed.json.items as J[]).map(p => p.name)).toEqual(['ann', 'mia', 'vic']);
    expect((listed.json.items as J[]).map(p => p.role)).toEqual(['owner', 'member', 'viewer']);
    expect(JSON.stringify(listed.json)).not.toContain('@example.test');
    // someone who left the workspace drops off the list
    await db.workspaceMember.deleteMany({where: {workspaceId: wsA, userId: ids.vic!}});
    expect(((await ann.get(`/site-api/conversations/${gid}/members`)).json.items as J[]).map(p => p.name)).toEqual(['ann', 'mia']);
    expect((await bob.get(`/site-api/conversations/${gid}/members`)).status).toBe(404);
    const chan = await mia.get(`/site-api/conversations/${channel}/members`);
    expect(chan.json).toEqual({scope: 'workspace', items: []});
    expect((await bob.get(`/site-api/conversations/${channel}/members`)).status).toBe(404);
    // A DM: its two people only; a workspace member outside it gets 404, like an outsider.
    const dm = (await mia.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.ann]})).json.conversation.id;
    expect(((await mia.get(`/site-api/conversations/${dm}/members`)).json.items as J[]).map(p => p.name)).toEqual(['ann', 'mia']);
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.vic!, role: 'viewer'}});
    expect((await vic.get(`/site-api/conversations/${dm}/members`)).status).toBe(404);
  });

  it('chat-people: names and roles of the workspace in one answer, never emails, members only', async () => {
    const res = await mia.get(`/site-api/workspaces/${wsA}/chat-people`);
    expect(res.status).toBe(200);
    expect(res.json.truncated).toBe(false);
    expect(res.json.items).toEqual([
      {userId: ids.ann, name: 'ann', role: 'owner', isMe: false},
      {userId: ids.mia, name: 'mia', role: 'member', isMe: true},
      {userId: ids.vic, name: 'vic', role: 'viewer', isMe: false},
    ]);
    expect(JSON.stringify(res.json)).not.toContain('@example.test');
    expect((await bob.get(`/site-api/workspaces/${wsA}/chat-people`)).status).toBe(404);
  });

  it('a message carries the names of the people it mentions', async () => {
    const sent = await send(mia, channel, 'hi @ann and @vic', undefined, {mentions: [ids.ann, ids.vic]});
    expect(sent.json.message.mentionNames).toEqual(['ann', 'vic']);
    const listed = (await vic.get(`/site-api/conversations/${channel}/messages`)).json.items as J[];
    expect(listed.at(-1)).toMatchObject({mentions: [ids.ann, ids.vic], mentionNames: ['ann', 'vic']});
  });

  it('board chat: GET only reads, POST creates and seats once, a repeat writes nothing', async () => {
    const first = await mia.get(`/site-api/boards/${boardA}/conversation`);
    expect(first.status).toBe(200);
    expect(first.json.conversation).toBeNull();
    expect(await db.conversation.count({where: {boardId: boardA}})).toBe(0);
    const made = await mia.post(`/site-api/boards/${boardA}/conversation`);
    expect(made.status).toBe(201);
    expect(made.json.conversation).toMatchObject({kind: 'board', joined: true, canWrite: true});
    const conv = made.json.conversation.id as number;
    // vic sees it without a seat (GET writes nothing), then takes one with POST.
    const seen = await vic.get(`/site-api/boards/${boardA}/conversation`);
    expect(seen.json.conversation).toMatchObject({id: conv, joined: false, canWrite: false});
    expect(await db.conversationMember.count({where: {conversationId: conv, userId: ids.vic}})).toBe(0);
    expect((await vic.post(`/site-api/boards/${boardA}/conversation`)).status).toBe(200);
    expect(await db.conversationMember.count({where: {conversationId: conv}})).toBe(2);
    const marker = await db.conversationMember.findUniqueOrThrow({where: {conversationId_userId: {conversationId: conv, userId: ids.mia!}}, select: {createdAt: true}});
    const again = await mia.post(`/site-api/boards/${boardA}/conversation`);
    expect(again.status).toBe(200);
    expect(again.json.conversation.id).toBe(conv);
    expect((await mia.get(`/site-api/boards/${boardA}/conversation`)).json.conversation).toMatchObject({id: conv, joined: true});
    expect(await db.conversation.count({where: {boardId: boardA}})).toBe(1);
    expect(await db.conversationMember.findUniqueOrThrow({where: {conversationId_userId: {conversationId: conv, userId: ids.mia!}}, select: {createdAt: true}})).toEqual(marker);
    expect((await bob.post(`/site-api/boards/${boardA}/conversation`)).status).toBe(404);
  });

  it('archiving a channel: owners and admins only, hidden from the list and the pulse, read-only, restorable', async () => {
    const msg = (await send(mia, channel, 'before')).json.message.id;
    expect((await mia.request('PUT', `/site-api/conversations/${channel}/archive`)).status).toBe(403);
    expect((await vic.request('PUT', `/site-api/conversations/${channel}/archive`)).status).toBe(403);
    expect((await bob.request('PUT', `/site-api/conversations/${channel}/archive`)).status).toBe(404);
    expect((await ann.request('PUT', `/site-api/conversations/${channel}/archive`)).json).toEqual({archived: true});
    expect((await ann.request('PUT', `/site-api/conversations/${channel}/archive`)).status).toBe(200); // a repeat changes nothing
    expect(await db.auditEvent.count({where: {action: 'chat.channel_archived'}})).toBe(1);

    const list = (await mia.get(`/site-api/workspaces/${wsA}/conversations`)).json.items as J[];
    expect(list.map(c => c.id)).not.toContain(channel);
    expect(((await mia.get('/site-api/chat/pulse')).json.items as J[]).map(p => p.conversationId)).not.toContain(channel);
    // Still readable (history kept), never writable: not by its authors, not by its moderators.
    const read = await mia.get(`/site-api/conversations/${channel}/messages`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({archived: true, canWrite: false, canModerate: false});
    expect((await mia.get(`/site-api/conversations/${channel}`)).json.conversation).toMatchObject({archived: true, canWrite: false});
    expect((await send(mia, channel, 'after')).status).toBe(403);
    expect((await send(ann, channel, 'after')).status).toBe(403);
    expect((await mia.request('PATCH', `/site-api/messages/${msg}`, {body: 'edit'})).status).toBe(403);
    expect((await mia.delete(`/site-api/messages/${msg}`)).status).toBe(403);
    expect((await ann.request('PUT', `/site-api/messages/${msg}/pin`)).status).toBe(403);
    expect((await mia.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'})).status).toBe(403);

    // A DM or a board chat is not a channel: nothing to archive.
    const dm = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.mia]})).json.conversation.id;
    expect((await ann.request('PUT', `/site-api/conversations/${dm}/archive`)).status).toBe(404);
    const board = (await ann.post(`/site-api/boards/${boardA}/conversation`)).json.conversation.id;
    expect((await ann.request('PUT', `/site-api/conversations/${board}/archive`)).status).toBe(404);

    // Restore: owners and admins only; it is back in the list and writable.
    expect((await mia.delete(`/site-api/conversations/${channel}/archive`)).status).toBe(403);
    expect((await ann.delete(`/site-api/conversations/${channel}/archive`)).json).toEqual({archived: false});
    expect(((await mia.get(`/site-api/workspaces/${wsA}/conversations`)).json.items as J[]).map(c => c.id)).toContain(channel);
    expect((await send(mia, channel, 'back')).status).toBe(201);
    expect(await db.auditEvent.count({where: {action: 'chat.channel_restored'}})).toBe(1);
  });

  it('an archived #general does not block a new one', async () => {
    await ann.request('PUT', `/site-api/conversations/${channel}/archive`);
    const again = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'});
    expect(again.status).toBe(201);
    expect(again.json.conversation.id).not.toBe(channel);
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

  it('a person named only by an edit is told once', async () => {
    const msg = (await send(mia, channel, 'hello')).json.message;
    const count = () => db.notification.count({where: {userId: ids.ann, kind: 'message_mention'}});
    expect(await count()).toBe(0);
    expect((await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'hello @ann', mentions: [ids.ann]})).status).toBe(200);
    expect(await count()).toBe(1);
    // Edited again with the same mention: not told twice.
    await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'hello again @ann', mentions: [ids.ann]});
    expect(await count()).toBe(1);
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

  it('one reaction per person: another emoji replaces mine, even under concurrent requests', async () => {
    const msg = (await send(ann, channel, 'pick one')).json.message.id;
    await mia.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    const switched = await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '🎉'});
    expect(switched.status).toBe(200);
    expect(switched.json.reactions).toEqual(
      expect.arrayContaining([{emoji: '👍', count: 1, mine: false}, {emoji: '🎉', count: 1, mine: true}]),
    );
    expect(switched.json.reactions).toHaveLength(2);
    await Promise.all(['❤️', '🔥', '😄', '✅', '🤔'].map(emoji => ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji})));
    expect(await db.messageReaction.count({where: {messageId: BigInt(msg), userId: ids.ann!}})).toBe(1);
    expect(await db.messageReaction.count({where: {messageId: BigInt(msg), userId: ids.mia!}})).toBe(1);
  });
  it('switching my emoji is never refused by the 20-kinds cap (only a new kind from someone else is)', async () => {
    const msg = (await send(ann, channel, 'busy')).json.message.id;
    const emoji = ['👍', '❤️', '😂', '🎉', '😮', '🙏', '👎', '👏', '🔥', '🚀', '✅', '👀', '😀', '😍', '🤔', '😅', '😢', '😡', '💯', '💡', '⭐', '🙌'];
    // 19 kinds from 19 other people, then mine: 20 kinds.
    const others = await db.user.createManyAndReturn({
      data: emoji.slice(0, 19).map((_, i) => ({email: `reactor${i}@example.test`, name: `Reactor ${i}`, passwordHash: 'x'})),
      select: {id: true},
    });
    await db.messageReaction.createMany({data: others.map((u, i) => ({messageId: BigInt(msg), userId: u.id, emoji: emoji[i]!}))});
    expect((await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: emoji[19]})).status).toBe(200);
    // My only reaction moves to a 21st emoji: still 20 kinds.
    const switched = await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: emoji[20]});
    expect(switched.status).toBe(200);
    expect(switched.json.reactions).toHaveLength(20);
    // A new kind from someone else would make 21.
    const refused = await mia.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: emoji[21]});
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('limit_reached');
  });

  it('the pulse editRev moves on edits, reactions, pins, deletes and replies, never on a plain send', async () => {
    const rev = async () => ((await ann.get('/site-api/chat/pulse')).json.items as J[]).find(p => p.conversationId === channel)?.editRev as number;
    const msg = (await send(ann, channel, 'first')).json.message.id;
    const r0 = await rev();
    expect(typeof r0).toBe('number');
    await send(mia, channel, 'second');
    expect(await rev()).toBe(r0);
    expect((await ann.request('PATCH', `/site-api/messages/${msg}`, {body: 'first, edited'})).status).toBe(200);
    expect(await rev()).toBe(r0 + 1);
    await mia.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(await rev()).toBe(r0 + 2);
    await mia.request('DELETE', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(await rev()).toBe(r0 + 3);
    // Removing a reaction I do not have changes nothing.
    await mia.request('DELETE', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(await rev()).toBe(r0 + 3);
    expect((await ann.request('PUT', `/site-api/messages/${msg}/pin`, {})).status).toBe(200);
    expect(await rev()).toBe(r0 + 4);
    await send(mia, channel, 'a reply', undefined, {parentId: msg});
    expect(await rev()).toBe(r0 + 5);
    expect((await ann.request('DELETE', `/site-api/messages/${msg}`, {})).status).toBe(200);
    expect(await rev()).toBe(r0 + 6);
    // The messages page carries the same counter.
    expect((await ann.get(`/site-api/conversations/${channel}/messages`)).json.editRev).toBe(r0 + 6);
  });

  it("in someone's Inbox chat, nobody else can be mentioned (not even workspace owners)", async () => {
    expect((await mia.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'note to self'})).status).toBe(201);
    const inbox = await db.board.findFirstOrThrow({where: {inboxOf: ids.mia!}, select: {id: true}});
    const chat = (await mia.post(`/site-api/boards/${inbox.id}/conversation`, {})).json.conversation.id;
    const sent = await send(mia, chat, 'hey @ann and @mia', undefined, {mentions: [ids.ann!, ids.mia!]});
    expect(sent.status).toBe(201);
    expect(sent.json.message.mentions).toEqual([ids.mia!]);
    expect(await db.notification.count({where: {userId: ids.ann!, kind: 'message_mention'}})).toBe(0);
    // And the owner still cannot open it.
    expect((await ann.get(`/site-api/conversations/${chat}/messages`)).status).toBe(404);
  });
});
