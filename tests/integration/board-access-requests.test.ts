import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Asking to join a board you cannot open, and answering it (real Postgres): who may see, approve and decline. */
describe.skipIf(!DATABASE_URL)('board access requests (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let ben: Browser; // member of A, no seat on the private board
  let dee: Browser; // member of A, seated member of the private board
  let bob: Browser; // owner of B (another workspace)
  let annId: number;
  let benId: number;
  let deeId: number;
  let bobId: number;
  let wsA: number;
  let board: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.121');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.122');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.123');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.124');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const id = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    [annId, benId, deeId, bobId] = await Promise.all(['ann', 'ben', 'dee', 'bob'].map(n => id(`${n}@example.test`)));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: deeId, role: 'member'}});
    board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', lanes: ['To do'], visibility: 'private'})).json.board.id;
    expect((await ann.request('PUT', `/site-api/boards/${board}/members/${deeId}`, {role: 'member'})).status).toBe(200);
  });

  const ask = (who: Browser, b = board) => who.post(`/site-api/boards/${b}/access-request`, {});
  const mine = (who: Browser, b = board) => who.get(`/site-api/boards/${b}/access-request`);
  const list = (who: Browser, b = board) => who.get(`/site-api/boards/${b}/access-requests`);
  const approve = (who: Browser, id: number, role = 'member') => who.post(`/site-api/access-requests/${id}/approve`, {role});
  const decline = (who: Browser, id: number) => who.post(`/site-api/access-requests/${id}/decline`, {});
  const requestId = async (userId: number) => (await db.boardAccessRequest.findUniqueOrThrow({where: {boardId_userId: {boardId: board, userId}}, select: {id: true}})).id;

  it('a workspace member asks for a private board; admins are told and see a name, never an address', async () => {
    expect((await mine(ben)).json.status).toBe('none');
    const res = await ask(ben);
    expect(res.status).toBe(202);
    expect(res.json).toEqual({status: 'pending'});
    expect((await mine(ben)).json.status).toBe('pending');
    // The workspace owner is told; the seated member (not a board admin) is not.
    expect(await db.notification.count({where: {userId: annId, kind: 'access_request', boardId: board}})).toBe(1);
    expect(await db.notification.count({where: {userId: deeId, kind: 'access_request'}})).toBe(0);
    const members = await ann.get(`/site-api/boards/${board}/members`);
    expect(members.json.accessRequests).toBe(1);
    const rows = await list(ann);
    expect(rows.status).toBe(200);
    expect(rows.json.items.map((r: J) => [r.userId, r.name, r.guest])).toEqual([[benId, 'ben', false]]);
    expect(JSON.stringify(rows.json)).not.toContain('@');
    // Asking again while it waits changes nothing and tells nobody again.
    expect((await ask(ben)).status).toBe(202);
    expect(await db.notification.count({where: {userId: annId, kind: 'access_request'}})).toBe(1);
  });

  it('never tells whether a board exists, and never names it', async () => {
    const missing = await ask(ben, 999999);
    expect(missing.status).toBe(202);
    expect(missing.json).toEqual({status: 'pending'});
    expect(await db.boardAccessRequest.count()).toBe(0);
    const real = await ask(bob);
    expect(real.status).toBe(202);
    expect(real.json).toEqual({status: 'pending'});
    expect(JSON.stringify(real.json)).not.toContain('Secret');
    // Someone who can already open it is told so.
    expect((await ask(ann)).json.status).toBe('member');
    expect((await mine(dee)).json.status).toBe('member');
  });

  it('only someone who may add people to THAT board sees or answers its requests', async () => {
    await ask(ben);
    const id = await requestId(benId);
    // The requester cannot see the board: 404, and cannot approve themselves.
    expect((await list(ben)).status).toBe(404);
    expect((await approve(ben, id)).status).toBe(404);
    // Another workspace: 404 (the board does not exist for them), nothing changes.
    expect((await list(bob)).status).toBe(404);
    expect((await approve(bob, id)).status).toBe(404);
    expect((await decline(bob, id)).status).toBe(404);
    // A seated member while only admins may add people: sees no list, may not answer.
    expect((await list(dee)).json).toEqual({items: [], canAnswer: false});
    expect((await dee.get(`/site-api/boards/${board}/members`)).json.accessRequests).toBe(0);
    expect((await approve(dee, id)).status).toBe(403);
    expect((await db.boardAccessRequest.findUniqueOrThrow({where: {id}, select: {status: true}})).status).toBe('pending');
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);
  });

  it('approving seats the person once with the chosen role, and tells them', async () => {
    await ask(ben);
    const id = await requestId(benId);
    const res = await approve(ann, id, 'viewer');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ok: true, guest: false});
    const seen = await ben.get(`/site-api/boards/${board}`);
    expect(seen.status).toBe(200);
    expect(seen.json.board.role).toBe('viewer');
    expect((await mine(ben)).json.status).toBe('member');
    expect(await db.notification.count({where: {userId: benId, kind: 'access_granted', boardId: board}})).toBe(1);
    // A second answer (another admin, a double click) finds nothing to do.
    expect((await approve(ann, id)).status).toBe(404);
    expect((await decline(ann, id)).status).toBe(404);
    expect(await db.boardMember.count({where: {boardId: board, userId: benId}})).toBe(1);
    // Only member or viewer: never admin through a request.
    await ask(dee); // already in: nothing stored
    expect((await approve(ann, id, 'admin')).status).toBe(422);
  });

  it('someone from another workspace joins as a guest when approved', async () => {
    await ask(bob);
    const id = await requestId(bobId);
    expect((await list(ann)).json.items.map((r: J) => [r.userId, r.guest])).toEqual([[bobId, true]]);
    expect((await approve(ann, id, 'member')).json).toMatchObject({ok: true, guest: true});
    const seen = await bob.get(`/site-api/boards/${board}`);
    expect(seen.status).toBe(200);
    expect(seen.json.board.role).toBe('member');
    // Still not a member of the workspace itself.
    expect(await db.workspaceMember.count({where: {workspaceId: wsA, userId: bobId}})).toBe(0);
  });

  it('a decline is quiet: the requester still sees "pending", asking again does not notify for a week', async () => {
    await ask(ben);
    const id = await requestId(benId);
    expect((await decline(ann, id)).status).toBe(200);
    expect((await mine(ben)).json.status).toBe('pending');
    expect((await list(ann)).json.items).toEqual([]);
    expect((await ask(ben)).status).toBe(202);
    expect((await db.boardAccessRequest.findUniqueOrThrow({where: {id}, select: {status: true}})).status).toBe('declined');
    expect(await db.notification.count({where: {userId: annId, kind: 'access_request'}})).toBe(1);
    // After the quiet week, a new request opens it again.
    await db.boardAccessRequest.update({where: {id}, data: {decidedAt: new Date(Date.now() - 8 * 86_400_000)}});
    await ask(ben);
    expect((await db.boardAccessRequest.findUniqueOrThrow({where: {id}, select: {status: true}})).status).toBe('pending');
    expect(await db.notification.count({where: {userId: annId, kind: 'access_request'}})).toBe(2);
  });

  it('a member who may add people cannot let back in someone a board admin removed; a board admin can', async () => {
    await ann.request('PATCH', `/site-api/boards/${board}/sharing`, {memberInvites: 'members'});
    await ann.request('PUT', `/site-api/boards/${board}/members/${benId}`, {role: 'member'});
    expect((await ann.delete(`/site-api/boards/${board}/members/${benId}`)).status).toBe(200);
    await ask(ben);
    const id = await requestId(benId);
    const refused = await approve(dee, id);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('removed_by_admin');
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);
    expect((await approve(ann, id)).status).toBe(200);
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(200);
  });

  it('a suspended account is neither counted nor seated (it would take a guest seat)', async () => {
    expect((await ask(bob)).status).toBe(202);
    const id = await requestId(bobId);
    await db.user.update({where: {id: bobId}, data: {status: 'suspended'}});
    // The header count matches the list: both hide the suspended requester.
    expect((await ann.get(`/site-api/boards/${board}/members`)).json.accessRequests).toBe(0);
    expect((await list(ann)).json.items).toEqual([]);
    // Approving by id (a stale list) seats nobody.
    expect((await approve(ann, id)).status).toBe(404);
    expect(await db.boardMember.count({where: {boardId: board, userId: bobId}})).toBe(0);
    // Active again: the same request can be answered.
    await db.user.update({where: {id: bobId}, data: {status: 'active'}});
    expect((await ann.get(`/site-api/boards/${board}/members`)).json.accessRequests).toBe(1);
    expect((await approve(ann, id)).status).toBe(200);
    expect(await db.boardMember.count({where: {boardId: board, userId: bobId}})).toBe(1);
  });
});
