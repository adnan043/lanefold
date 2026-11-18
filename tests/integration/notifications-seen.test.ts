import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** "Seen" apart from "read": opening the list clears the red count, each notification stays unread (real Postgres). */
describe.skipIf(!DATABASE_URL)('notifications seen (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let ids: Record<string, number>;
  let ws: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test')};
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: ids.bob!, role: 'member'}});
  });

  const notify = (userId: number, n = 1) =>
    db.notification.createMany({data: Array.from({length: n}, () => ({userId, workspaceId: ws, kind: 'comment', actorId: ids.ann!}))});
  const count = async (b: Browser) => (await b.get('/site-api/notifications/unread-count')).json.count as number;
  const unreadInList = async (b: Browser) => ((await b.get('/site-api/notifications')).json.items as J[]).filter(n => !n.read).length;

  it('opening the list clears the count but leaves every notification unread; a new one counts again', async () => {
    await notify(ids.bob!, 3);
    expect(await count(bob)).toBe(3);

    expect((await bob.post('/site-api/notifications/seen', {})).status).toBe(200);
    expect(await count(bob)).toBe(0);
    expect(await unreadInList(bob)).toBe(3);
    expect(await db.notification.count({where: {userId: ids.bob!, readAt: null}})).toBe(3);

    // Something new after that: the count shows only it.
    await notify(ids.bob!, 1);
    expect(await count(bob)).toBe(1);
    expect(await unreadInList(bob)).toBe(4);

    // Read all: nothing unread, nothing counted.
    expect((await bob.post('/site-api/notifications/read-all', {})).status).toBe(200);
    expect(await count(bob)).toBe(0);
    expect(await unreadInList(bob)).toBe(0);
  });

  it('seen is per person, and works with no notifications yet', async () => {
    expect((await ann.post('/site-api/notifications/seen', {})).status).toBe(200);
    await notify(ids.bob!, 2);
    await notify(ids.ann!, 1);
    await bob.post('/site-api/notifications/seen', {});
    expect(await count(bob)).toBe(0);
    expect(await count(ann)).toBe(1);
  });
});
