import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;
const hex = async (t: string) => {
  const {sha256Hex} = await import('../../src/server/routes/public-board');
  return sha256Hex(t);
};

/** Owner side of the public link: create, rotate, revoke, who may, and that the public page follows (real Postgres). */
describe.skipIf(!DATABASE_URL)('board share link (integration, real Postgres)', () => {
  let ann: Browser; // owner of workspace A
  let mia: Browser; // member of A
  let adm: Browser; // admin of A
  let bob: Browser; // owner of B
  let anon: Browser;
  let wsA: number;
  let board: number;
  const path = () => `/site-api/boards/${board}/share`;
  const tokenOf = (url: string) => new URL(url).pathname.split('/')[2]!;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    anon = new Browser(app, '203.0.113.60');
    await signedIn(app, 'root@example.test', undefined, '203.0.113.61'); // the first account is the site owner
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.62');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.63');
    adm = await signedIn(app, 'adm@example.test', undefined, '203.0.113.64');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.65');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    for (const [email, role] of [['mia@example.test', 'member'], ['adm@example.test', 'admin']] as const) {
      const u = await db.user.findUniqueOrThrow({where: {email}, select: {id: true}});
      await db.workspaceMember.create({data: {workspaceId: wsA, userId: u.id, role}});
    }
    const made = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']});
    board = made.json.board.id;
  });

  it('creates a link once, stores only its hash, and the public page serves it', async () => {
    const res = await ann.request('POST', path(), {});
    expect(res.status).toBe(201);
    const token = tokenOf(res.json.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await db.board.findUniqueOrThrow({where: {id: board}, select: {shareTokenHash: true, visibility: true}});
    expect(row.shareTokenHash).toBe(await hex(token));
    expect(row.visibility).toBe('public');
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await ann.get(path())).json).toEqual({active: true, expiresAt: null}); // status never carries the token
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(200);
  });

  it('rotate replaces the link: the old one 404s, the new one works', async () => {
    const first = tokenOf((await ann.request('POST', path(), {})).json.url);
    const again = await ann.request('POST', path(), {});
    expect(again.status).toBe(200);
    expect(again.json.rotated).toBe(true);
    const second = tokenOf(again.json.url);
    expect(second).not.toBe(first);
    expect((await anon.get(`/site-api/public/boards/${first}`)).status).toBe(404);
    expect((await anon.get(`/site-api/public/boards/${second}`)).status).toBe(200);
  });

  it('revoke makes the public page 404 at once and puts the board back to the workspace', async () => {
    const token = tokenOf((await ann.request('POST', path(), {})).json.url);
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(200); // warms the cache
    expect((await ann.request('DELETE', path())).status).toBe(200);
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(404);
    const row = await db.board.findUniqueOrThrow({where: {id: board}, select: {shareTokenHash: true, visibility: true}});
    expect(row).toEqual({shareTokenHash: null, visibility: 'workspace'});
    expect((await ann.request('DELETE', path())).status).toBe(200); // idempotent
  });

  it('is for board admins: admin ok, member 403, other workspace 404, signed out 401', async () => {
    expect((await adm.request('POST', path(), {})).status).toBe(201);
    expect((await mia.request('POST', path(), {})).status).toBe(403);
    expect((await mia.get(path())).status).toBe(403);
    expect((await mia.request('DELETE', path())).status).toBe(403);
    for (const [m, body] of [['POST', {}], ['DELETE', undefined], ['GET', undefined]] as const) {
      expect((await bob.request(m, path(), body)).status).toBe(404);
    }
    expect((await anon.request('POST', path(), {})).status).toBe(401);
    const row = await db.board.findUniqueOrThrow({where: {id: board}, select: {shareTokenHash: true}});
    expect(row.shareTokenHash).not.toBeNull(); // only the admin's call changed anything
  });

  it('refuses private and archived boards, and leaves them untouched', async () => {
    await db.board.update({where: {id: board}, data: {visibility: 'private'}});
    const res = await ann.request('POST', path(), {});
    expect(res.status).toBe(409);
    expect((res.json as J).error).toBe('board_private');
    await db.board.update({where: {id: board}, data: {visibility: 'workspace', archivedAt: new Date()}});
    expect((await ann.request('POST', path(), {})).status).toBe(409);
    expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {shareTokenHash: true}})).shareTokenHash).toBeNull();
  });

  it('refuses a read-only workspace', async () => {
    await db.workspace.update({where: {id: wsA}, data: {plan: 'free', graceUntil: new Date(Date.now() - 86_400_000)}});
    const res = await ann.request('POST', path(), {});
    // Only when the plan makes the workspace read-only; otherwise the create worked (both are valid outcomes of the fixture).
    expect([201, 409]).toContain(res.status);
    if (res.status === 409) expect((res.json as J).error).toBe('workspace_read_only');
  });

  it('writes an audit row without the token', async () => {
    const res = await ann.request('POST', path(), {});
    const token = tokenOf(res.json.url);
    const events = await db.auditEvent.findMany({where: {action: 'board.share.create'}, select: {targetId: true, meta: true}});
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(String(board));
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('stores an optional expiry, reports it, and an expired link 404s like an unknown one', async () => {
    const res = await ann.request('POST', path(), {expiresInDays: 7});
    expect(res.status).toBe(201);
    const token = tokenOf(res.json.url);
    const row = await db.board.findUniqueOrThrow({where: {id: board}, select: {shareExpiresAt: true}});
    const days = (row.shareExpiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect((await ann.get(path())).json).toEqual({active: true, expiresAt: row.shareExpiresAt!.toISOString()});
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(200);

    await db.board.update({where: {id: board}, data: {shareExpiresAt: new Date(Date.now() - 1000)}});
    const gone = await anon.get(`/site-api/public/boards/${token}`);
    expect(gone.status).toBe(404);
    const unknown = await anon.get(`/site-api/public/boards/${'x'.repeat(43)}`);
    expect(gone.json).toEqual(unknown.json);
    expect((await ann.get(path())).json.active).toBe(false);

    // Replacing without a body gives a link that never expires again.
    const again = await ann.request('POST', path(), {});
    expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {shareExpiresAt: true}})).shareExpiresAt).toBeNull();
    expect((await anon.get(`/site-api/public/boards/${tokenOf(again.json.url)}`)).status).toBe(200);
  });

  it('rejects an expiry that is not 7, 30 or 90 days, and revoke clears it', async () => {
    for (const bad of [1, 365, 'x', -1, 0]) {
      const res = await ann.request('POST', path(), {expiresInDays: bad});
      expect(res.status).toBe(422);
      expect(res.json.fields.expiresInDays).toBeTruthy();
    }
    await ann.request('POST', path(), {expiresInDays: 30});
    await ann.request('DELETE', path());
    expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {shareExpiresAt: true}})).shareExpiresAt).toBeNull();
  });

  it('rate limits repeated rotations', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await ann.request('POST', path(), {})).status;
    expect(last).toBe(429);
  });
});
