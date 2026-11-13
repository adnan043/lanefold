import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Board seats ("Share"): add, change role, remove, leave; private board access and cleanup; isolation (real Postgres). */
describe.skipIf(!DATABASE_URL)('board members (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let ben: Browser; // member of A
  let cy: Browser; // viewer of A
  let bob: Browser; // owner of B (other workspace)
  let annId: number;
  let benId: number;
  let cyId: number;
  let bobId: number;
  let wsA: number;
  let board: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.101');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.102');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.103');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.104');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const id = async (email: string) => (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    [annId, benId, cyId, bobId] = await Promise.all(['ann', 'ben', 'cy', 'bob'].map(n => id(`${n}@example.test`)));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: cyId, role: 'viewer'}});
    board = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', lanes: ['To do'], visibility: 'private'})).json.board.id;
  });

  const put = (who: Browser, userId: number, role: string, b = board) => who.request('PUT', `/site-api/boards/${b}/members/${userId}`, {role});
  const del = (who: Browser, userId: number, b = board) => who.delete(`/site-api/boards/${b}/members/${userId}`);
  const members = (who: Browser, b = board) => who.get(`/site-api/boards/${b}/members`);

  it('a private board is a 404 until someone adds you; then you see it with that role', async () => {
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);
    const res = await put(ann, benId, 'member');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({userId: benId, role: 'member', added: true});
    const seen = await ben.get(`/site-api/boards/${board}`);
    expect(seen.status).toBe(200);
    expect(seen.json.board.role).toBe('member');
    // In-app notification for the person added.
    expect(await db.notification.count({where: {userId: benId, kind: 'board_member', boardId: board}})).toBe(1);
  });

  it('lists seats and workspace admins by name only, never an email', async () => {
    await put(ann, benId, 'viewer');
    const res = await members(ben);
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: J) => [m.id, m.role])).toEqual([[benId, 'viewer']]);
    expect(res.json.admins.map((a: J) => a.id)).toEqual([annId]);
    expect(res.json.canManage).toBe(false);
    expect(JSON.stringify(res.json)).not.toContain('@');
    const cands = await ann.get(`/site-api/boards/${board}/members/candidates`);
    expect(cands.json.items.map((c: J) => c.id)).toEqual([cyId]);
    expect(JSON.stringify(cands.json)).not.toContain('@');
  });

  it('changes a role; a workspace viewer can only be a viewer; workspace admins are refused', async () => {
    await put(ann, benId, 'member');
    const changed = await put(ann, benId, 'admin');
    expect(changed.json).toMatchObject({role: 'admin', added: false});
    expect((await put(ann, cyId, 'member')).status).toBe(422);
    expect((await put(ann, cyId, 'viewer')).status).toBe(200);
    expect((await put(ann, annId, 'member')).status).toBe(409);
    expect((await put(ann, 999999, 'member')).status).toBe(404);
    expect((await put(ann, benId, 'owner')).status).toBe(422);
  });

  it('only board admins manage seats; another workspace is a 404', async () => {
    await put(ann, benId, 'member');
    expect((await put(ben, cyId, 'viewer')).status).toBe(403);
    expect((await del(ben, cyId)).status).toBe(403);
    expect((await ben.get(`/site-api/boards/${board}/members/candidates`)).status).toBe(403);
    expect((await members(bob)).status).toBe(404);
    expect((await put(bob, bobId, 'admin')).status).toBe(404);
    // A person of another workspace can never be seated here.
    expect((await put(ann, bobId, 'member')).status).toBe(404);
    // A seated board admin (workspace member) may manage seats.
    await put(ann, benId, 'admin');
    expect((await put(ben, cyId, 'viewer')).status).toBe(200);
  });

  it('removing a seat on a private board takes the person off its cards and notifications', async () => {
    await put(ann, benId, 'member');
    const laneId = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    expect((await ann.post(`/site-api/lanes/${laneId}/cards`, {title: 'Plan'})).status).toBeLessThan(300);
    const cardId = (await db.card.findFirstOrThrow({where: {boardId: board}, select: {id: true}})).id;
    await db.cardMember.create({data: {cardId, userId: benId, workspaceId: wsA}});
    await db.cardWatcher.create({data: {cardId, userId: benId}});
    const res = await del(ann, benId);
    expect(res.status).toBe(200);
    expect(res.json.lostAccess).toBe(true);
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);
    expect(await db.cardMember.count({where: {cardId, userId: benId}})).toBe(0);
    expect(await db.cardWatcher.count({where: {cardId, userId: benId}})).toBe(0);
    expect(await db.notification.count({where: {userId: benId, boardId: board}})).toBe(0);
    expect((await del(ann, benId)).status).toBe(404);
  });

  it('anyone can leave; on a workspace board leaving keeps workspace access', async () => {
    await put(ann, benId, 'viewer');
    const left = await del(ben, benId);
    expect(left.json.lostAccess).toBe(true);
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);

    const shared = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Open', lanes: ['To do']})).json.board.id;
    await put(ann, benId, 'member', shared);
    const out = await del(ben, benId, shared);
    expect(out.json.lostAccess).toBe(false);
    expect((await ben.get(`/site-api/boards/${shared}`)).json.board.role).toBe('member');
  });

  it('a workspace member a board admin held to viewer cannot lift it by leaving (or re-joining)', async () => {
    const shared = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Open', lanes: ['To do']})).json.board.id;
    await put(ann, benId, 'viewer', shared);
    const left = await del(ben, benId, shared);
    expect(left.status).toBe(409);
    expect(left.json.error).toBe('seat_restricted');
    expect((await ben.post(`/site-api/boards/${shared}/join`, {})).json.role).toBe('viewer');
    const board = await ben.get(`/site-api/boards/${shared}`);
    expect(board.json.board.role).toBe('viewer');
    expect((await ben.post(`/site-api/boards/${shared}/lanes`, {name: 'Mine'})).status).toBe(403);
    // A board admin can still lift it.
    expect((await del(ann, benId, shared)).status).toBe(200);
    expect((await ben.get(`/site-api/boards/${shared}`)).json.board.role).toBe('member');
  });

  /* ------------------------------------------------------------------ guests, links, join, settings */

  const tokenOf = (link: string) => new URL(link).pathname.split('/').pop()!;

  it('an email invite makes an outsider a GUEST: this board only, at most member, nothing of the workspace', async () => {
    const other = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Other', lanes: ['To do']})).json.board.id;
    const inv = await ann.post(`/site-api/boards/${board}/invites`, {email: 'bob@example.test', role: 'admin'});
    expect(inv.status).toBe(201);
    expect(inv.json.result).toBe('invited');
    expect(JSON.stringify(inv.json)).not.toContain('bob@example.test');
    // Bound to bob's address: someone else cannot use it.
    const stolen = await ben.post('/site-api/invites/accept', {token: tokenOf(inv.json.link)});
    expect(stolen.status).toBe(404);
    const ok = await bob.post('/site-api/invites/accept', {token: tokenOf(inv.json.link)});
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({boardId: board, guest: true, alreadyMember: false});
    // Used once.
    expect((await bob.post('/site-api/invites/accept', {token: tokenOf(inv.json.link)})).status).toBe(404);

    const seen = await bob.get(`/site-api/boards/${board}`);
    expect(seen.status).toBe(200);
    expect(seen.json.board).toMatchObject({guest: true, role: 'member', canAdmin: false});
    // Nothing else of the workspace.
    expect((await bob.get(`/site-api/boards/${other}`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/boards`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/members`)).status).toBe(404);
    expect((await bob.get('/site-api/guest-boards')).json.items.map((b: J) => b.id)).toEqual([board]);
    // Listed as a guest; never made board admin.
    const list = await members(ann);
    expect(list.json.members.find((m: J) => m.id === bobId)).toMatchObject({guest: true, role: 'member'});
    expect((await put(ann, bobId, 'admin')).status).toBe(422);
    expect((await put(ann, bobId, 'viewer')).status).toBe(200);
    // A guest cannot add people.
    expect((await bob.post(`/site-api/boards/${board}/invites`, {email: 'x@example.test', role: 'member'})).status).toBe(403);
    // Removed: the board is gone for them, whatever its visibility.
    await db.board.update({where: {id: board}, data: {visibility: 'workspace'}});
    expect((await del(ann, bobId)).json.lostAccess).toBe(true);
    expect((await bob.get(`/site-api/boards/${board}`)).status).toBe(404);
  });

  it('an email invite to a workspace member seats them at once; a pending invite can be revoked', async () => {
    const res = await ann.post(`/site-api/boards/${board}/invites`, {email: 'ben@example.test', role: 'member'});
    expect(res.json.result).toBe('added');
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(200);
    const inv = await ann.post(`/site-api/boards/${board}/invites`, {email: 'new@example.test', role: 'viewer'});
    const pending = await ann.get(`/site-api/boards/${board}/invites`);
    expect(pending.json.items).toHaveLength(1);
    expect(JSON.stringify(pending.json)).not.toContain('@');
    expect((await ann.delete(`/site-api/boards/${board}/invites/${inv.json.inviteId}`)).json.revoked).toBe(true);
    // The workspace's own invite list never shows board invites.
    expect((await ann.get(`/site-api/workspaces/${wsA}/invites`)).json.items).toHaveLength(0);
  });

  it('address checks are capped per inviter (30 an hour): no unlimited guessing of who is a member', async () => {
    // 30 checks of already-seated or made-up workspace addresses: each answers, none emails anyone.
    for (let i = 0; i < 30; i++) {
      const res = await ann.post(`/site-api/boards/${board}/invites`, {email: i === 0 ? 'ben@example.test' : `ben${i}@example.test`, role: 'member'});
      expect(res.status, `check ${i}`).not.toBe(429);
      // Made-up addresses go the invite way; age those rows so the separate invite/email caps don't trip first.
      await db.workspaceInvite.updateMany({data: {createdAt: new Date(Date.now() - 7_200_000), emailQueuedAt: new Date(Date.now() - 7_200_000)}});
    }
    const next = await ann.post(`/site-api/boards/${board}/invites`, {email: 'ben@example.test', role: 'member'});
    expect(next.status).toBe(429);
    // The checks are audited on the inviter, not the board: the workspace audit log stays readable.
    expect(await db.auditEvent.count({where: {action: 'board.invite.lookup', targetType: 'user'}})).toBe(30);
  });

  it('an invite link seats whoever opens it (a guest when outside), and dies when removed or its maker loses the right', async () => {
    const made = await ann.post(`/site-api/boards/${board}/invite-link`, {role: 'viewer'});
    expect(made.status).toBe(201);
    const token = tokenOf(made.json.url);
    expect(token.startsWith('bl_')).toBe(true);
    const joined = await bob.post('/site-api/invites/accept', {token});
    expect(joined.json).toMatchObject({boardId: board, guest: true});
    expect((await bob.get(`/site-api/boards/${board}`)).json.board.role).toBe('viewer');
    expect((await ann.get(`/site-api/boards/${board}/invite-link`)).json).toEqual({active: true, role: 'viewer'});
    await ann.delete(`/site-api/boards/${board}/invite-link`);
    expect((await cy.post('/site-api/invites/accept', {token})).status).toBe(404);

    // A link made by a board member (when members may add people) stops working once that is switched off.
    await put(ann, benId, 'member');
    await ann.request('PATCH', `/site-api/boards/${board}/sharing`, {memberInvites: 'members'});
    const byBen = await ben.post(`/site-api/boards/${board}/invite-link`, {role: 'member'});
    expect(byBen.status).toBe(201);
    expect((await ben.post(`/site-api/boards/${board}/invite-link`, {role: 'member'})).status).toBe(201);
    await ann.request('PATCH', `/site-api/boards/${board}/sharing`, {memberInvites: 'admins'});
    expect((await cy.post('/site-api/invites/accept', {token: tokenOf(byBen.json.url)})).status).toBe(404);
  });

  it('members may add people only when the board allows it, and then only as member or viewer', async () => {
    await put(ann, benId, 'member');
    expect((await put(ben, cyId, 'viewer')).status).toBe(403);
    await ann.request('PATCH', `/site-api/boards/${board}/sharing`, {memberInvites: 'members'});
    expect((await put(ben, cyId, 'viewer')).status).toBe(200);
    expect((await put(ben, cyId, 'admin')).status).toBe(403);
    // ...and never change or remove anyone else.
    expect((await del(ben, cyId)).status).toBe(403);
    expect((await ben.request('PATCH', `/site-api/boards/${board}/sharing`, {selfJoin: false})).status).toBe(403);
  });

  it('a workspace member joins a workspace board themselves unless the board turned it off; never a private one', async () => {
    const open = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Open', lanes: ['To do']})).json.board.id;
    expect((await members(ben, open)).json.canJoin).toBe(true);
    const joined = await ben.post(`/site-api/boards/${open}/join`, {});
    expect(joined.json).toMatchObject({joined: true, role: 'member'});
    expect((await cy.post(`/site-api/boards/${open}/join`, {})).json.role).toBe('viewer');
    // The creator already holds a seat: nothing changes.
    expect((await ann.post(`/site-api/boards/${open}/join`, {})).json).toMatchObject({joined: false});
    expect((await ben.post(`/site-api/boards/${board}/join`, {})).status).toBe(404);
    const closed = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Closed', lanes: ['To do']})).json.board.id;
    await ann.request('PATCH', `/site-api/boards/${closed}/sharing`, {selfJoin: false});
    expect((await ben.post(`/site-api/boards/${closed}/join`, {})).status).toBe(403);
    expect((await members(ben, closed)).json.canJoin).toBe(false);
  });

  it('someone removed from the workspace cannot come back as a guest by link or by an older invite', async () => {
    const old = await ann.post(`/site-api/boards/${board}/invites`, {email: 'ben@example.test', role: 'member'});
    expect(old.json.result).toBe('added'); // ben is a member: seated at once
    const link = await ann.post(`/site-api/boards/${board}/invite-link`, {role: 'member'});
    // ben leaves the workspace (removal recorded), then tries the board link.
    await db.boardMember.deleteMany({where: {boardId: board, userId: benId}});
    await db.workspaceMember.deleteMany({where: {workspaceId: wsA, userId: benId}});
    await db.workspaceRemoval.create({data: {workspaceId: wsA, userId: benId}});
    expect((await ben.post('/site-api/invites/accept', {token: tokenOf(link.json.url)})).status).toBe(404);
    expect((await ben.get(`/site-api/boards/${board}`)).status).toBe(404);
    // A deliberate email invite made after the removal works (as a guest).
    const again = await ann.post(`/site-api/boards/${board}/invites`, {email: 'ben@example.test', role: 'member'});
    expect(again.json.result).toBe('invited');
    const ok = await ben.post('/site-api/invites/accept', {token: tokenOf(again.json.link)});
    expect(ok.json).toMatchObject({boardId: board, guest: true});
  });

  it('a member may not replace or remove an invite link a board admin made', async () => {
    await put(ann, benId, 'member');
    await ann.request('PATCH', `/site-api/boards/${board}/sharing`, {memberInvites: 'members'});
    await ann.post(`/site-api/boards/${board}/invite-link`, {role: 'viewer'});
    expect((await ben.post(`/site-api/boards/${board}/invite-link`, {role: 'member'})).status).toBe(403);
    expect((await ben.delete(`/site-api/boards/${board}/invite-link`)).status).toBe(403);
    expect((await ann.get(`/site-api/boards/${board}/invite-link`)).json).toEqual({active: true, role: 'viewer'});
  });
});
