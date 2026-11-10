import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {forgetEntitlements, getEntitlements, invalidateAppSettings, startGraceForOverLimit} from '../../src/server/entitlements';
import {boardAccess, isWorkspaceRole, membership, rankOf} from '../../src/server/workspaces';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** Workspace access, roles and entitlement limits (real Postgres). */
describe.skipIf(!DATABASE_URL)('workspaces and entitlements (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let wsA: number;
  let wsB: number;
  let annId: number;
  let bobId: number;
  let boardA: number;

  // The harness shares one client; in production the client (and so the memo) is per request.
  const ent = (id: number) =>
    inRequestScope(() => {
      forgetEntitlements(db, id);
      return getEntitlements(db, id);
    });
  const setMode = async (billingMode: 'PAID' | 'FREE_FOR_ALL') => {
    await db.appSettings.update({where: {id: 1}, data: {billingMode, graceDays: 14}});
    await invalidateAppSettings();
  };

  beforeAll(configureEnv);
  afterAll(async () => {
    await setMode('PAID');
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    // Other files edit plan_limits (and a crashed run can leave them edited): start from the seeded plans.
    await db.$executeRaw`UPDATE plan_limits SET max_members = 10, max_file_bytes = 10485760, storage_quota_bytes = 1073741824, max_flows = 0, audit_log = false WHERE plan = 'free'`;
    await db.$executeRaw`UPDATE plan_limits SET max_members = 100, max_file_bytes = 104857600, storage_quota_bytes = 107374182400, max_flows = 100, audit_log = true WHERE plan = 'team'`;
    await setMode('PAID');
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.32');
    annId = await userId('ann@example.test');
    bobId = await userId('bob@example.test');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    wsB = (await bob.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id;
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  });

  const addMember = (workspaceId: number, userId: number, role: string) =>
    db.workspaceMember.create({data: {workspaceId, userId, role}});

  it('membership() returns the role in THIS workspace only', async () => {
    expect(await membership(db, wsA, annId)).toEqual({role: 'owner', rank: 4});
    expect(await membership(db, wsA, bobId)).toBeNull();
    expect(await membership(db, 999999, annId)).toBeNull();
    await addMember(wsA, bobId, 'viewer');
    expect(await membership(db, wsA, bobId)).toEqual({role: 'viewer', rank: 1});
    expect(await membership(db, wsB, bobId)).toMatchObject({role: 'owner'});
  });

  it('an unknown stored role gives no access at all', async () => {
    // The database CHECK refuses an unknown role, so the schema itself is the first wall.
    await expect(db.$executeRaw`UPDATE workspace_members SET role = 'god' WHERE workspace_id = ${wsA} AND user_id = ${annId}`).rejects.toThrow(/workspace_members_role_check/);
    // The app's own rule (defence in depth, for a stored value the CHECK might one day allow) gives no rank.
    expect(isWorkspaceRole('god')).toBe(false);
    expect(rankOf('god')).toBe(0);
    expect(await membership(db, wsA, annId)).toMatchObject({role: 'owner'});
  });

  it('role rules on boards: owner/admin admin, member writes, viewer reads, private needs a seat', async () => {
    await addMember(wsA, bobId, 'member');
    expect(await boardAccess(db, boardA, bobId)).toMatchObject({boardRole: 'member', canWrite: true, canAdmin: false});
    await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: wsA, userId: bobId}}, data: {role: 'viewer'}});
    expect(await boardAccess(db, boardA, bobId)).toMatchObject({boardRole: 'viewer', canWrite: false});
    await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: wsA, userId: bobId}}, data: {role: 'admin'}});
    expect(await boardAccess(db, boardA, bobId)).toMatchObject({boardRole: 'admin', canAdmin: true});
    await db.workspaceMember.update({where: {workspaceId_userId: {workspaceId: wsA, userId: bobId}}, data: {role: 'member'}});
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    expect(await boardAccess(db, boardA, bobId)).toBeNull();
    await db.boardMember.create({data: {workspaceId: wsA, boardId: boardA, userId: bobId, role: 'viewer'}});
    expect(await boardAccess(db, boardA, bobId)).toMatchObject({boardRole: 'viewer'});
    expect(await boardAccess(db, boardA, annId)).toMatchObject({boardRole: 'admin'});
  });

  it('a board of another workspace is invisible: helper null, routes 404', async () => {
    expect(await boardAccess(db, boardA, bobId)).toBeNull();
    expect((await bob.get(`/site-api/boards/${boardA}`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/boards`)).status).toBe(404);
    expect((await bob.get(`/site-api/workspaces/${wsA}/billing`)).status).toBe(404);
    // A malformed id is the same 404, not a 400/500.
    expect((await bob.get('/site-api/workspaces/abc/boards')).status).toBe(404);
    expect((await bob.get('/site-api/workspaces/0/boards')).status).toBe(404);
  });

  it('a personal Inbox board is never visible to other members, owner or not', async () => {
    const inbox = await db.board.create({
      data: {workspaceId: wsA, name: 'Inbox', visibility: 'private', createdBy: bobId, inboxOf: bobId},
      select: {id: true},
    });
    await addMember(wsA, bobId, 'member');
    expect(await boardAccess(db, inbox.id, bobId)).toMatchObject({boardRole: 'admin'});
    expect(await boardAccess(db, inbox.id, annId)).toBeNull();
  });

  it('entitlements: null for no workspace, plan limits for each plan, member counts as usage', async () => {
    expect(await ent(999999)).toBeNull();
    const free = (await ent(wsA))!;
    expect(free).toMatchObject({plan: 'free', billingMode: 'PAID', readOnly: false, upgradeUi: true});
    expect(free.limits).toMatchObject({maxMembers: 10, maxFileBytes: 10 * 1024 * 1024, storageQuotaBytes: 1024 ** 3});
    expect(free.usage.members).toBe(1);
    await db.workspace.update({where: {id: wsA}, data: {plan: 'team'}});
    const team = (await ent(wsA))!;
    expect(team.limits).toMatchObject({maxMembers: 100, maxFileBytes: 100 * 1024 * 1024});
    expect(team.features.auditLog).toBe(true);
  });

  it('member cap: over the free limit starts grace, then read-only; boards refuse writes; heals when back under', async () => {
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 11}});
    expect((await ent(wsA))!).toMatchObject({overLimit: true, inGrace: true, readOnly: false});
    await startGraceForOverLimit(db, {workspaceId: wsA});
    const clock = await db.workspace.findUniqueOrThrow({where: {id: wsA}, select: {graceUntil: true}});
    expect(clock.graceUntil).not.toBeNull();
    // Starting it again does not restart the clock.
    await startGraceForOverLimit(db, {workspaceId: wsA});
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsA}, select: {graceUntil: true}})).graceUntil).toEqual(clock.graceUntil);

    await db.workspace.update({where: {id: wsA}, data: {graceUntil: new Date(Date.now() - 1000)}});
    expect((await ent(wsA))!).toMatchObject({overLimit: true, inGrace: false, readOnly: true});
    const blocked = await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'More'});
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('workspace_read_only');
    expect((await ann.get(`/site-api/boards/${boardA}`)).status).toBe(200); // reads keep working
    // The other workspace is unaffected.
    expect((await ent(wsB))!.readOnly).toBe(false);

    await db.workspace.update({where: {id: wsA}, data: {memberCount: 10}});
    await startGraceForOverLimit(db, {workspaceId: wsA});
    expect((await ent(wsA))!).toMatchObject({overLimit: false, readOnly: false, graceUntil: null});
    expect((await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'More'})).status).toBe(201);
  });

  it('storage cap counts like the member cap, boundary is inclusive', async () => {
    await db.workspace.update({where: {id: wsA}, data: {storageUsedBytes: BigInt(1024 ** 3)}});
    expect((await ent(wsA))!.overLimit).toBe(false);
    await db.workspace.update({where: {id: wsA}, data: {storageUsedBytes: BigInt(1024 ** 3 + 1)}});
    expect((await ent(wsA))!.overLimit).toBe(true);
  });

  it('file cap follows the plan, and FREE_FOR_ALL swaps in the safety caps and ignores overage', async () => {
    expect((await ent(wsA))!.limits.maxFileBytes).toBe(10 * 1024 * 1024);
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 50, graceUntil: new Date(Date.now() - 1000)}});
    expect((await ent(wsA))!.readOnly).toBe(true);
    await setMode('FREE_FOR_ALL');
    const e = (await ent(wsA))!;
    expect(e).toMatchObject({billingMode: 'FREE_FOR_ALL', overLimit: false, readOnly: false, upgradeUi: false});
    expect(e.limits).toMatchObject({maxMembers: 500, maxFileBytes: 100 * 1024 * 1024});
    await startGraceForOverLimit(db);
    expect((await db.workspace.findUniqueOrThrow({where: {id: wsA}, select: {graceUntil: true}})).graceUntil).toBeNull();
  });

  it('a workspace whose plan row is missing falls back to the strict plan, never crashes', async () => {
    await db.$executeRaw`UPDATE workspaces SET plan = 'ghost' WHERE id = ${wsA}`;
    expect((await ent(wsA))!).toMatchObject({plan: 'ghost', limits: {maxMembers: 10}});
  });

  it('entitlements are memoized per client (one per request) until forgotten', async () => {
    await inRequestScope(async () => {
      const first = await getEntitlements(db, wsA);
      await db.workspace.update({where: {id: wsA}, data: {memberCount: 5}});
      expect(await getEntitlements(db, wsA)).toBe(first);
    });
    forgetEntitlements(db, wsA);
    expect((await ent(wsA))!.usage.members).toBe(5);
  });
});
