import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

const url = '/site-api/notification-email';

/** Notification email setting: own row only, validated input, default off, never an address (real Postgres). */
describe.skipIf(!DATABASE_URL)('notification email route (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let annId: number;
  let bobId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
  });

  const modeOf = async (userId: number) => (await db.userProfile.findUnique({where: {userId}}))?.emailNotifyMode ?? 'off';

  it('requires sign-in', async () => {
    const anon = new Browser(app);
    expect((await anon.get(url)).status).toBe(401);
    expect((await anon.request('PATCH', url, {mode: 'digest'})).status).toBe(401);
  });

  it('defaults to off and is never cached or shows an address', async () => {
    const res = await ann.get(url);
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('off');
    expect(JSON.stringify(res.json)).not.toContain('@');
  });

  it('changes only the signed-in user row, and starts the cursor at the newest notification', async () => {
    const ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id as number;
    const n = await db.notification.create({data: {userId: annId, workspaceId: ws, kind: 'mentioned'}});
    const res = await ann.request('PATCH', url, {mode: 'immediate'});
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('immediate');
    expect(await modeOf(annId)).toBe('immediate');
    expect(await modeOf(bobId)).toBe('off');
    expect((await db.userProfile.findUniqueOrThrow({where: {userId: annId}})).emailNotifyCursor).toBe(n.id);
    expect((await bob.get(url)).json.mode).toBe('off');
    // a body that names another user is ignored: it still only touches the viewer
    await bob.request('PATCH', url, {mode: 'digest', userId: annId, user_id: annId});
    expect(await modeOf(annId)).toBe('immediate');
    expect(await modeOf(bobId)).toBe('digest');
  });

  it('does not reset the send gap when switching off and on', async () => {
    await ann.request('PATCH', url, {mode: 'digest'});
    const at = new Date('2026-01-01T00:00:00Z');
    await db.userProfile.update({where: {userId: annId}, data: {emailNotifiedAt: at}});
    await ann.request('PATCH', url, {mode: 'off'});
    await ann.request('PATCH', url, {mode: 'digest'});
    expect((await db.userProfile.findUniqueOrThrow({where: {userId: annId}})).emailNotifiedAt?.getTime()).toBe(at.getTime());
  });

  it('rejects invalid modes and shapes without writing', async () => {
    for (const body of [{}, {mode: 'daily'}, {mode: 5}, {mode: null}, {mode: ['digest']}, {mode: 'OFF'}, [], 'digest']) {
      const res = await ann.request('PATCH', url, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await modeOf(annId)).toBe('off');
  });

  it('is backed by a CHECK constraint on the mode', async () => {
    await ann.request('PATCH', url, {mode: 'digest'});
    await expect(db.$executeRaw`UPDATE user_profiles SET email_notify_mode = 'weekly' WHERE user_id = ${annId}`).rejects.toThrow();
  });
});
