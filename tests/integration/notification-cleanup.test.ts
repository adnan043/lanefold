import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {dropNotificationsFor} from '../../src/server/notification-cleanup';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

describe.skipIf(!DATABASE_URL)('notifications of lost access (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let ids: Record<string, number>;
  let ws: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: ids.bob!, role: 'member'}});
  });

  const row = (boardId: number | null, userId: number, conversationId: number | null = null) => ({
    userId, workspaceId: ws, kind: 'comment', boardId, conversationId, actorId: ids.ann!,
  });

  it('turning a board private deletes the rows of people with no seat, keeps seated people and admins', async () => {
    const boardId = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Open', visibility: 'workspace', lanes: ['One']})).json.board.id as number;
    await db.notification.createMany({data: [row(boardId, ids.bob!), row(boardId, ids.ann!), row(null, ids.bob!)]});
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBe(2);
    const res = await ann.request('PATCH', `/site-api/boards/${boardId}`, {visibility: 'private'});
    expect(res.status).toBe(200);
    expect(await db.notification.count({where: {userId: ids.bob!, boardId}})).toBe(0);
    expect(await db.notification.count({where: {userId: ids.bob!, boardId: null}})).toBe(1);
    expect(await db.notification.count({where: {userId: ids.ann!, boardId}})).toBe(1);
  });

  it('dropNotificationsFor removes only that person and that board', async () => {
    const boardId = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Open', lanes: ['One']})).json.board.id as number;
    await db.notification.createMany({data: [row(boardId, ids.bob!), row(boardId, ids.ann!)]});
    const n = await db.$transaction(tx => dropNotificationsFor(tx, ids.bob!, {boardId}));
    expect(n).toBe(1);
    expect(await db.notification.count({where: {boardId}})).toBe(1);
  });

  it('the unread count is exact past 500 unread rows', async () => {
    const boardId = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Open', lanes: ['One']})).json.board.id as number;
    // Newest 600 rows point at a conversation bob is not in (hidden); the older 3 are visible.
    const conv = await db.conversation.create({data: {workspaceId: ws, kind: 'group', createdBy: ids.ann!}, select: {id: true}});
    await db.notification.createMany({data: [row(boardId, ids.bob!), row(boardId, ids.bob!), row(boardId, ids.bob!)]});
    await db.notification.createMany({data: Array.from({length: 600}, () => row(null, ids.bob!, conv.id))});
    const res = await bob.get('/site-api/notifications/unread-count');
    expect(res.json).toEqual({count: 3, more: false});
  });
});
