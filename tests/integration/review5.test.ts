import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Review 5: chat card links, Inbox people lists, label edits in a read-only workspace (real Postgres). */
describe.skipIf(!DATABASE_URL)('review 5 (integration)', () => {
  let ann: Browser; // owner
  let mia: Browser; // member, no seat on the private board
  let wsA: number;
  let channel: number;
  let ids: Record<string, number>;
  let secretCard: number;
  let openCard: number;
  let annInboxCard: number;
  let miaInboxCard: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.52');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    channel = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'})).json.conversation.id;
    const lane = async (name: string, visibility?: string) => {
      const b = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name, lanes: ['L'], ...(visibility ? {visibility} : {})});
      return (await ann.get(`/site-api/boards/${b.json.board.id}`)).json.lanes[0].id as number;
    };
    secretCard = (await ann.post(`/site-api/lanes/${await lane('Secret', 'private')}/cards`, {title: 'Hidden'})).json.items[0].id;
    openCard = (await ann.post(`/site-api/lanes/${await lane('Open')}/cards`, {title: 'Visible'})).json.items[0].id;
    annInboxCard = (await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Ann inbox'})).json.card?.id ?? (await db.card.findFirstOrThrow({where: {board: {inboxOf: ids.ann}}})).id;
    miaInboxCard = (await mia.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'Mia inbox'})).json.card?.id ?? (await db.card.findFirstOrThrow({where: {board: {inboxOf: ids.mia}}})).id;
  });

  const send = (b: Browser, body: string, extra: J = {}) =>
    b.post(`/site-api/conversations/${channel}/messages`, {body, clientId: `c-${Math.random().toString(36).slice(2, 12)}`, ...extra});

  it('chat send: cards of a private board without a seat, or another user\'s Inbox, are dropped like a nonexistent card', async () => {
    const ghost = await send(mia, 'ghost', {cardIds: [99999999]});
    expect(ghost.status).toBe(201);
    for (const card of [secretCard, annInboxCard]) {
      const res = await send(mia, 'try', {cardIds: [card]});
      expect(res.status).toBe(ghost.status);
      expect(res.json.message.cardIds).toEqual(ghost.json.message.cardIds);
      expect(JSON.stringify(res.json)).not.toContain('Hidden');
    }
    const ok = await send(mia, 'fine', {cardIds: [openCard, miaInboxCard]});
    expect(ok.json.message.cardIds.sort()).toEqual([openCard, miaInboxCard].sort());
    // The owner sees private boards, but still not another person's Inbox.
    const owner = await send(ann, 'owner', {cardIds: [secretCard, miaInboxCard]});
    expect(owner.json.message.cardIds).toEqual([secretCard]);
  });

  it('chat edit: the same filter applies', async () => {
    const msg = (await send(mia, 'plain')).json.message;
    const ghost = await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'e1', cardIds: [99999999]});
    for (const card of [secretCard, annInboxCard]) {
      const res = await mia.request('PATCH', `/site-api/messages/${msg.id}`, {body: 'e2', cardIds: [card]});
      expect(res.status).toBe(ghost.status);
      expect(res.json.message.cardIds).toEqual(ghost.json.message.cardIds);
    }
    expect(await db.messageCardRef.count({where: {messageId: BigInt(msg.id)}})).toBe(0);
  });

  it('an Inbox card\'s people list holds only the Inbox owner', async () => {
    const people = async (b: Browser, card: number) => ((await b.get(`/site-api/cards/${card}/people`)).json.items as {id: number}[]).map(p => p.id);
    expect(await people(ann, annInboxCard)).toEqual([ids.ann]);
    expect(await people(mia, miaInboxCard)).toEqual([ids.mia]);
    // Someone else's Inbox card is 404 for them.
    expect((await mia.get(`/site-api/cards/${annInboxCard}/people`)).status).toBe(404);
    // Assigning the other person is refused; a public board card still lists both.
    expect((await ann.request('PUT', `/site-api/cards/${annInboxCard}/members/${ids.mia}`, {})).status).not.toBe(200);
    expect((await people(ann, openCard)).sort()).toEqual([ids.ann, ids.mia].sort());
  });

  it('PATCH /labels/:id answers 409 workspace_read_only in a read-only workspace', async () => {
    const board = (await db.board.findFirstOrThrow({where: {workspaceId: wsA, name: 'Open'}})).id;
    const label = (await ann.post(`/site-api/boards/${board}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
    const res = await ann.request('PATCH', `/site-api/labels/${label}`, {name: 'Renamed'});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('workspace_read_only');
    expect((await db.label.findUniqueOrThrow({where: {id: label}})).name).toBe('Bug');
  });
});
