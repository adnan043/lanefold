import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {pulseRows} from '../../src/server/routes/chat';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/** `/chat/pulse`: newest first under the cap, board chats follow board visibility, channels and DMs stay (real Postgres). */
describe.skipIf(!DATABASE_URL)('chat pulse (integration, real Postgres)', () => {
  let ann: Browser;
  let mia: Browser;
  let wsA: number;
  let ids: Record<string, number>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.42');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
  });

  const pulse = async (b: Browser) => (await b.get('/site-api/chat/pulse')).json.items as {conversationId: number}[];

  it('keeps the newest conversations when over the cap, newest first', async () => {
    const made: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await db.conversation.create({data: {workspaceId: wsA, kind: 'group', name: `g${i}`, updatedAt: new Date(Date.now() - (5 - i) * 60_000)}});
      await db.conversationMember.create({data: {conversationId: c.id, userId: ids.mia!, workspaceId: wsA}});
      made.push(c.id);
    }
    const rows = await pulseRows(db as any, ids.mia!, 3);
    expect(rows.map(r => r.conversation.id)).toEqual([made[4], made[3], made[2]]);
    const all = await pulse(mia);
    expect(all.slice(0, 5).map(r => r.conversationId)).toEqual([...made].reverse());
  });

  it('hides a board chat after losing the board seat, but keeps channels and DMs', async () => {
    const boardId = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', lanes: ['To do']})).json.board.id;
    await db.board.update({where: {id: boardId}, data: {visibility: 'private'}});
    await db.boardMember.create({data: {boardId, userId: ids.mia!, workspaceId: wsA, role: 'member'}});
    const board = await mia.get(`/site-api/boards/${boardId}/conversation`);
    expect(board.status).toBe(200);
    const boardConv = board.json.conversation.id;
    const dm = await db.conversation.create({data: {workspaceId: wsA, kind: 'dm', dmKey: `${ids.ann}:${ids.mia}`}});
    await db.conversationMember.createMany({data: [ids.ann!, ids.mia!].map(userId => ({conversationId: dm.id, userId, workspaceId: wsA}))});

    const before = (await pulse(mia)).map(r => r.conversationId);
    expect(before).toContain(boardConv);
    expect(before).toContain(dm.id);

    await db.boardMember.delete({where: {boardId_userId: {boardId, userId: ids.mia!}}});
    const after = (await pulse(mia)).map(r => r.conversationId);
    expect(after).not.toContain(boardConv);
    expect(after).toContain(dm.id);
    const channels = await db.conversation.findMany({where: {workspaceId: wsA, kind: 'channel'}, select: {id: true}});
    const myChannels = await db.conversationMember.findMany({where: {userId: ids.mia!, conversationId: {in: channels.map(c => c.id)}}});
    for (const m of myChannels) expect(after).toContain(m.conversationId);
  });
});
