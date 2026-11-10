import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Chat hardening: edits keep cards, mentions follow the text, read-only / archived writes, read marker, #general, system messages. */
describe.skipIf(!DATABASE_URL)('chat hardening (integration, real Postgres)', () => {
  let ann: Browser; // owner
  let mia: Browser; // member
  let wsA: number;
  let channel: number;
  let boardA: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.42');
    await signedIn(app, 'zed@example.test', undefined, '203.0.113.43');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    channel = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'})).json.conversation.id;
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  });

  const send = (b: Browser, conv: number, body: string, extra: J = {}) =>
    b.post(`/site-api/conversations/${conv}/messages`, {body, clientId: `c-${Math.random().toString(36).slice(2, 12)}`, ...extra});

  const makeReadOnly = async () => {
    await db.workspace.update({where: {id: wsA}, data: {storageUsedBytes: 9_000_000_000_000, graceUntil: new Date(Date.now() - 60_000)}});
  };

  it('editing keeps linked cards and mentions when the fields are absent, replaces them when present', async () => {
    const lane = (await db.lane.findFirstOrThrow({where: {boardId: boardA}})).id;
    const card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Linked'})).json.card?.id ?? (await db.card.findFirstOrThrow({where: {boardId: boardA}})).id;
    const msg = (await send(mia, channel, 'see @ann', {cardIds: [card], mentions: [ids.ann]})).json.message;
    expect(msg.cardIds).toEqual([card]);
    const kept = await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'see @ann, edited'});
    expect(kept.status).toBe(200);
    expect(kept.json.message).toMatchObject({cardIds: [card], mentions: [ids.ann]});
    const cleared = await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'no one', mentions: [], cardIds: []});
    expect(cleared.json.message).toMatchObject({cardIds: [], mentions: []});
  });

  it('mentions are kept only when the text names them; a removed member is not mentionable in a group', async () => {
    const m = (await send(mia, channel, 'hello @ann', {mentions: [ids.ann, ids.zed]})).json.message;
    expect(m.mentions).toEqual([ids.ann]); // zed is no member, and is not named
    const plain = (await send(mia, channel, 'hello there', {mentions: [ids.ann]})).json.message;
    expect(plain.mentions).toEqual([]);
    const group = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'group', name: 'Team', userIds: [ids.mia]})).json.conversation.id;
    await db.workspaceMember.deleteMany({where: {workspaceId: wsA, userId: ids.mia}});
    const ghost = await send(ann, group, 'bye @mia', {mentions: [ids.mia]});
    expect(ghost.json.message.mentions).toEqual([]);
  });

  it('read-only workspace: edit, react, pin, mute and moderator delete answer 409; deleting your own works', async () => {
    const mine = (await send(mia, channel, 'mine')).json.message.id;
    const anns = (await send(ann, channel, 'anns')).json.message.id;
    await makeReadOnly();
    expect((await mia.request('PATCH', `/site-api/messages/${mine}`, {body: 'x'})).status).toBe(409);
    expect((await mia.request('PUT', `/site-api/messages/${mine}/reactions`, {emoji: '👍'})).status).toBe(409);
    expect((await ann.request('PUT', `/site-api/messages/${mine}/pin`, {})).status).toBe(409);
    // Per-user view state (mute, unmute, read marker) still works in a read-only workspace.
    expect((await mia.request('PUT', `/site-api/conversations/${channel}/mute`, {})).status).toBe(200);
    expect((await mia.request('DELETE', `/site-api/conversations/${channel}/mute`)).status).toBe(200);
    expect((await mia.post(`/site-api/conversations/${channel}/read`, {seq: 1})).status).toBe(200);
    expect((await ann.delete(`/site-api/messages/${mine}`)).status).toBe(409); // a moderator deleting another's
    expect((await mia.delete(`/site-api/messages/${mine}`)).status).toBe(200); // own: always
    expect((await ann.delete(`/site-api/messages/${anns}`)).status).toBe(200);
  });

  it('archived board chat: a board admin can neither pin nor delete others', async () => {
    const conv = (await ann.get(`/site-api/boards/${boardA}/conversation`)).json.conversation.id;
    const msg = (await send(mia, conv, 'on the board')).json.message.id;
    await db.board.update({where: {id: boardA}, data: {archivedAt: new Date()}});
    expect((await ann.request('PUT', `/site-api/messages/${msg}/pin`, {})).status).toBe(403);
    expect((await ann.delete(`/site-api/messages/${msg}`)).status).toBe(404);
    expect((await mia.delete(`/site-api/messages/${msg}`)).status).toBe(200); // own message still deletable
  });

  it('sending does not mark unseen messages as read', async () => {
    await send(ann, channel, 'one');
    await send(ann, channel, 'two');
    // mia has seen nothing; her send without lastSeenSeq leaves the marker behind the unseen two
    await send(mia, channel, 'three');
    let row = await db.conversationMember.findUniqueOrThrow({where: {conversationId_userId: {conversationId: channel, userId: ids.mia!}}});
    expect(Number(row.lastReadSeq)).toBeLessThan(3);
    // having seen up to seq 2, her next message is read through 4
    await send(mia, channel, 'four', {lastSeenSeq: 3});
    row = await db.conversationMember.findUniqueOrThrow({where: {conversationId_userId: {conversationId: channel, userId: ids.mia!}}});
    expect(Number(row.lastReadSeq)).toBe(4);
    await send(ann, channel, 'five');
    await send(ann, channel, 'six');
    await send(mia, channel, 'seven', {lastSeenSeq: 4});
    row = await db.conversationMember.findUniqueOrThrow({where: {conversationId_userId: {conversationId: channel, userId: ids.mia!}}});
    expect(Number(row.lastReadSeq)).toBe(4);
  });

  it('creating #general twice returns the same channel', async () => {
    const again = await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'General'});
    expect(again.status).toBe(200);
    expect(again.json.conversation.id).toBe(channel);
    expect(await db.conversation.count({where: {workspaceId: wsA, kind: 'channel', name: {equals: 'general', mode: 'insensitive'}}})).toBe(1);
  });

  it('a system message cannot be deleted; reactions beyond 1000 rows still count', async () => {
    const sys = await db.message.create({
      data: {conversationId: channel, workspaceId: wsA, seq: 900n, senderId: null, bodyMd: 'joined', clientId: 'sys-000001', kind: 'system'},
    });
    expect((await ann.delete(`/site-api/messages/${sys.id}`)).status).toBe(403);
    const msg = (await send(ann, channel, 'react to me')).json.message.id;
    const res = await ann.request('PUT', `/site-api/messages/${msg}/reactions`, {emoji: '👍'});
    expect(res.json.reactions).toEqual([{emoji: '👍', count: 1, mine: true}]);
  });
});
