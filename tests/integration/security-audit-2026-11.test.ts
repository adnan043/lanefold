import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/**
 * Regression tests for the 2026-11-16 full security check (real Postgres):
 * - cutting access still works while a workspace is read-only (share link, archive, private, seat, invite link);
 * - archiving a board ends its public link for good;
 * - a guest a board admin removed cannot come back through the board's invite link;
 * - parallel accepts cannot push guests past the plan's cap;
 * - only the uploader (or a board admin) renames an attachment;
 * - a member cannot fill the workspace's channel slots;
 * - the hourly board cap holds under a burst of parallel creates.
 */
describe.skipIf(!DATABASE_URL)('security check 2026-11 (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let ben: Browser; // member of A
  let bob: Browser; // outsider (becomes a guest)
  let cat: Browser; // outsider
  let dan: Browser; // outsider
  let anon: Browser;
  let wsA: number;
  let board: number;
  let benId: number;
  let bobId: number;
  const tokenOf = (url: string) => new URL(url).pathname.split('/').filter(Boolean).pop()!;
  const readOnly = () => db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    anon = new Browser(app, '203.0.113.170');
    await signedIn(app, 'root@example.test', undefined, '203.0.113.171'); // the first account is the site owner
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.172');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.173');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.174');
    cat = await signedIn(app, 'cat@example.test', undefined, '203.0.113.175');
    dan = await signedIn(app, 'dan@example.test', undefined, '203.0.113.176');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    const id = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    benId = await id('ben@example.test');
    bobId = await id('bob@example.test');
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 2}});
    board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  }, 60_000);

  const shareToken = async () => tokenOf((await ann.request('POST', `/site-api/boards/${board}/share`, {})).json.url);
  const guestLink = async (role = 'member') => tokenOf((await ann.post(`/site-api/boards/${board}/invite-link`, {role})).json.url);

  describe('a read-only workspace can still cut access', () => {
    it('revokes the public link', async () => {
      const token = await shareToken();
      await readOnly();
      expect((await ann.request('POST', `/site-api/boards/${board}/share`, {})).status).toBe(409); // granting stays blocked
      expect((await ann.request('DELETE', `/site-api/boards/${board}/share`)).status).toBe(200);
      expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(404);
    });

    it('archives or makes private, but other board edits stay blocked', async () => {
      await readOnly();
      const rename = await ann.request('PATCH', `/site-api/boards/${board}`, {name: 'Renamed'});
      expect(rename.status).toBe(409);
      expect((rename.json as J).error).toBe('workspace_read_only');
      // A mix of a revoke and a grant is not a revoke.
      expect((await ann.request('PATCH', `/site-api/boards/${board}`, {visibility: 'private', name: 'X'})).status).toBe(409);
      expect((await ann.request('PATCH', `/site-api/boards/${board}`, {visibility: 'public'})).status).toBe(409);
      // Still board-admin only.
      expect((await ben.request('PATCH', `/site-api/boards/${board}`, {archived: true})).status).toBe(403);
      expect((await ann.request('PATCH', `/site-api/boards/${board}`, {visibility: 'private'})).status).toBe(200);
      expect((await ann.request('PATCH', `/site-api/boards/${board}`, {archived: true})).status).toBe(200);
      // Restoring gives access back: blocked while read-only.
      expect((await ann.request('PATCH', `/site-api/boards/${board}`, {archived: false})).status).toBe(409);
    });

    it('removes a guest and withdraws the invite link', async () => {
      const token = await guestLink();
      expect((await bob.post('/site-api/invites/accept', {token})).status).toBe(201);
      await readOnly();
      expect((await ann.delete(`/site-api/boards/${board}/invite-link`)).status).toBe(200);
      expect((await ann.delete(`/site-api/boards/${board}/members/${bobId}`)).status).toBe(200);
      expect((await bob.get(`/site-api/boards/${board}`)).status).toBe(404);
      // A plain member still cannot remove anyone.
      expect((await ben.delete(`/site-api/boards/${board}/members/${bobId}`)).status).toBe(403);
    });
  });

  it('archiving ends the public link: restoring the board does not bring the old token back', async () => {
    const token = await shareToken();
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/boards/${board}`, {archived: true})).status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/boards/${board}`, {archived: false})).status).toBe(200);
    expect((await anon.get(`/site-api/public/boards/${token}`)).status).toBe(404);
    const row = await db.board.findUniqueOrThrow({where: {id: board}, select: {shareTokenHash: true, visibility: true}});
    expect(row).toEqual({shareTokenHash: null, visibility: 'workspace'});
  });

  it('a guest removed by an admin cannot rejoin with the board link; one who left on their own can', async () => {
    const token = await guestLink();
    expect((await bob.post('/site-api/invites/accept', {token})).json).toMatchObject({boardId: board, guest: true});
    expect((await ann.delete(`/site-api/boards/${board}/members/${bobId}`)).status).toBe(200);
    expect((await bob.post('/site-api/invites/accept', {token})).status).toBe(404);
    expect((await bob.get(`/site-api/boards/${board}`)).status).toBe(404);

    expect((await cat.post('/site-api/invites/accept', {token})).status).toBe(201);
    const catId = (await db.user.findUniqueOrThrow({where: {email: 'cat@example.test'}, select: {id: true}})).id;
    expect((await cat.delete(`/site-api/boards/${board}/members/${catId}`)).status).toBe(200); // leaving
    expect((await cat.post('/site-api/invites/accept', {token})).status).toBe(201);
  });

  it('parallel accepts cannot seat more guests than the plan allows', async () => {
    const plan = (await db.workspace.findUniqueOrThrow({where: {id: wsA}, select: {plan: true}})).plan;
    const before = await db.planLimit.findUniqueOrThrow({where: {plan}, select: {maxMembers: true}});
    try {
      // The guest cap is the plan's member limit, counted over guests alone: room for two.
      await db.planLimit.update({where: {plan}, data: {maxMembers: 2}});
      await invalidateAppSettings();
      const token = await guestLink();
      const results = await Promise.all([bob, cat, dan].map(b => b.post('/site-api/invites/accept', {token})));
      const seated = results.filter(r => r.status === 201).length;
      expect(seated).toBe(2);
      expect(results.filter(r => r.status === 409).every(r => (r.json as J).error === 'guest_limit_reached')).toBe(true);
      const guests = await db.$queryRaw<{n: number}[]>`
        SELECT count(*)::int AS n FROM board_members bm
        WHERE bm.workspace_id = ${wsA} AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = bm.workspace_id AND m.user_id = bm.user_id)`;
      expect(guests[0]!.n).toBe(2);
    } finally {
      await db.planLimit.update({where: {plan}, data: {maxMembers: before.maxMembers}});
      await invalidateAppSettings();
    }
  });

  it('only the uploader or a board admin renames an attachment', async () => {
    const lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    const card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Spec'})).json.items[0].id;
    await ann.request('PUT', `/site-api/boards/${board}/members/${benId}`, {role: 'member'});
    const annLink = (await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://example.com/a', name: 'Invoice'})).json.attachment.id;
    const benLink = (await ben.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://example.com/b', name: 'Notes'})).json.attachment.id;
    expect((await ben.request('PATCH', `/site-api/attachments/${annLink}`, {name: 'Pay here'})).status).toBe(403);
    expect((await ben.request('PATCH', `/site-api/attachments/${benLink}`, {name: 'My notes'})).status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/attachments/${benLink}`, {name: 'Team notes'})).status).toBe(200); // board admin
    const names = await db.attachment.findMany({where: {id: {in: [annLink, benLink]}}, select: {id: true, name: true}, orderBy: {id: 'asc'}});
    expect(names.map(n => n.name)).toEqual(['Invoice', 'Team notes']);
  });

  it('a member starts at most 5 channels an hour; an admin is not held to it', async () => {
    const make = (who: Browser, name: string) => who.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name});
    for (let i = 0; i < 5; i++) expect((await make(ben, `ben-${i}`)).status).toBe(201);
    const sixth = await make(ben, 'ben-5');
    expect(sixth.status).toBe(429);
    expect((sixth.json as J).error).toBe('conversation_rate_limited');
    for (let i = 0; i < 6; i++) expect((await make(ann, `ann-${i}`)).status).toBe(201);
  });

  it('the hourly board cap holds under a burst of parallel creates', async () => {
    const made = await Promise.all(Array.from({length: 26}, (_, i) => ann.post(`/site-api/workspaces/${wsA}/boards`, {name: `B${i}`})));
    const created = await db.board.count({where: {workspaceId: wsA, createdBy: (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}})).id, inboxOf: null}});
    expect(created).toBeLessThanOrEqual(20);
    expect(made.filter(r => r.status === 429).length).toBeGreaterThanOrEqual(6);
  });
});
