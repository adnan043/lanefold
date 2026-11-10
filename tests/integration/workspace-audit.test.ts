import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/**
 * The workspace audit log: owners and admins of THAT workspace only (another workspace: 404, a member: 403),
 * Team plan only (else `available: false`), only that workspace's events, names but never emails, keyset pages.
 */
describe.skipIf(!DATABASE_URL)('workspace audit log (integration, real Postgres)', () => {
  let admin: Browser;
  let member: Browser;
  let outsider: Browser;
  let w1: number;
  let w2: number;
  let adminId: number;
  let memberId: number;
  let outsiderId: number;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID'}});
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID'}});
    await invalidateAppSettings();
    admin = await signedIn(app, 'auditadmin@example.test', undefined, '203.0.113.61');
    member = await signedIn(app, 'auditmember@example.test', undefined, '203.0.113.62');
    outsider = await signedIn(app, 'auditoutsider@example.test', undefined, '203.0.113.63');
    adminId = await userId('auditadmin@example.test');
    memberId = await userId('auditmember@example.test');
    outsiderId = await userId('auditoutsider@example.test');
    w1 = (await db.workspace.create({data: {name: 'One', slug: 'audit-one', plan: 'team', createdBy: adminId, memberCount: 2}, select: {id: true}})).id;
    w2 = (await db.workspace.create({data: {name: 'Two', slug: 'audit-two', plan: 'team', createdBy: outsiderId, memberCount: 1}, select: {id: true}})).id;
    await db.workspaceMember.createMany({
      data: [
        {workspaceId: w1, userId: adminId, role: 'admin'},
        {workspaceId: w1, userId: memberId, role: 'member'},
        {workspaceId: w2, userId: outsiderId, role: 'owner'},
      ],
    });
    const b1 = (await db.board.create({data: {workspaceId: w1, name: 'Roadmap'}, select: {id: true}})).id;
    const b2 = (await db.board.create({data: {workspaceId: w2, name: 'Secret plans'}, select: {id: true}})).id;
    await db.auditEvent.createMany({
      data: [
        {actorUserId: adminId, action: 'workspace.member.role_changed', targetType: 'workspace', targetId: String(w1), meta: {userId: memberId, from: 'viewer', to: 'member'}},
        {actorUserId: adminId, action: 'board.share.create', targetType: 'board', targetId: String(b1), meta: {workspaceId: w1}},
        {actorUserId: adminId, action: 'flow.delete', targetType: 'flow', targetId: '999', meta: {workspaceId: w1, boardId: b1}},
        {actorUserId: outsiderId, action: 'workspace.renamed', targetType: 'workspace', targetId: String(w2), meta: {}},
        {actorUserId: outsiderId, action: 'board.exported', targetType: 'board', targetId: String(b2), meta: {format: 'csv'}},
        {actorUserId: outsiderId, action: 'flow.create', targetType: 'flow', targetId: '998', meta: {workspaceId: w2}},
        {actorUserId: adminId, action: 'billing.mode_changed', targetType: 'app_settings', targetId: '1', meta: {from: 'PAID', to: 'FREE_FOR_ALL'}},
      ],
    });
  });

  const path = (id: number | string, before = '') => `/site-api/workspaces/${id}/audit${before ? `?before=${before}` : ''}`;

  it('admins see THEIR workspace only; members 403; outsiders and bad ids 404; signed out 401', async () => {
    const ok = await admin.get(path(w1));
    expect(ok.status).toBe(200);
    expect(ok.json.available).toBe(true);
    const events = ok.json.events as {action: string; actor: {name: string}; subject: {id: number} | null; target: {name: string | null} | null}[];
    expect(events.map(e => e.action)).toEqual(['flow.delete', 'board.share.create', 'workspace.member.role_changed']);
    expect(events[1]!.target?.name).toBe('Roadmap');
    expect(events[2]!.subject?.id).toBe(memberId);
    const body = JSON.stringify(ok.json);
    expect(body).not.toContain('@'); // names only, never an email
    expect(body).not.toContain('Secret plans');
    expect(body).not.toContain('billing.mode_changed');

    expect((await member.get(path(w1))).status).toBe(403);
    expect((await outsider.get(path(w1))).status).toBe(404);
    expect((await admin.get(path(w2))).status).toBe(404);
    expect((await admin.get(path('abc'))).status).toBe(404);
    expect((await new Browser(app).get(path(w1))).status).toBe(401);
  });

  it('a plan without the audit log answers available: false and no events', async () => {
    await db.workspace.update({where: {id: w1}, data: {plan: 'free'}});
    const res = await admin.get(path(w1));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({available: false, events: [], nextBefore: null});
  });

  it('pages newest first with a keyset cursor', async () => {
    const extra = Array.from({length: 35}, (_, i) => ({
      actorUserId: adminId,
      action: 'workspace.joinlink.created',
      targetType: 'workspace',
      targetId: String(w1),
      meta: {n: i},
    }));
    await db.auditEvent.createMany({data: extra});
    const first = await admin.get(path(w1));
    const page1 = first.json.events as {id: string}[];
    expect(page1).toHaveLength(30);
    expect(typeof first.json.nextBefore).toBe('string');
    const second = await admin.get(path(w1, first.json.nextBefore as string));
    const page2 = second.json.events as {id: string}[];
    expect(page2).toHaveLength(8);
    expect(second.json.nextBefore).toBeNull();
    const ids = [...page1, ...page2].map(e => BigInt(e.id));
    expect(new Set(ids.map(String)).size).toBe(38);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! < ids[i - 1]!).toBe(true);
  });
});
