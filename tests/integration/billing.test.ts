import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {applyWorkspacePlan, paymentHooks, recordMembership} from '../../src/server/payments-hooks';
import {Browser, configureEnv, DATABASE_URL, db, ownerSignedIn, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Phase 0.7: workspace billing, plan limits, staff workspaces and the plan hook, against a real Postgres.
 * Ids in URLs only SELECT: another workspace's billing is a 404, never a 403 or a leak.
 */

const membership = (customerRef: string | null, price: string, status: 'active' | 'canceled' | 'past_due', accessEndsAt: string | null = null) => ({
  id: `sub_${price}`,
  price,
  email: null,
  status,
  currentPeriodEnd: null,
  accessEndsAt,
  customerRef,
  checkoutId: null,
});

async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

const PRO = {maxMembers: 50, maxFileBytes: 104857600, storageQuotaBytes: 21474836480, maxFlows: 10, auditLog: false};

describe.skipIf(!DATABASE_URL)('billing (integration, real Postgres)', () => {
  let admin: Browser;
  let member: Browser;
  let outsider: Browser;
  let staff: Browser;
  let w1: number;
  let w2: number;
  let adminId: number;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.planLimit.update({where: {plan: 'pro'}, data: PRO});
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID', graceDays: 14}});
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await db.planLimit.update({where: {plan: 'pro'}, data: PRO});
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID', graceDays: 14}});
    admin = await signedIn(app, 'wsadmin@example.test', undefined, '203.0.113.51');
    member = await signedIn(app, 'wsmember@example.test', undefined, '203.0.113.52');
    outsider = await signedIn(app, 'outsider@example.test', undefined, '203.0.113.53');
    // The site owner: only the platform's "View as admin" makes one (an `owner` role set by hand is removed).
    staff = await ownerSignedIn(app, undefined, '203.0.113.54');
    for (const email of ['wsadmin', 'wsmember', 'outsider']) await setRoles(`${email}@example.test`, 'member');
    adminId = await userId('wsadmin@example.test');
    const memberId = await userId('wsmember@example.test');
    const outsiderId = await userId('outsider@example.test');
    w1 = (await db.workspace.create({data: {name: 'One', slug: 'one', createdBy: adminId, memberCount: 2}, select: {id: true}})).id;
    w2 = (await db.workspace.create({data: {name: 'Two', slug: 'two', createdBy: outsiderId, memberCount: 1}, select: {id: true}})).id;
    await db.workspaceMember.createMany({
      data: [
        {workspaceId: w1, userId: adminId, role: 'admin'},
        {workspaceId: w1, userId: memberId, role: 'member'},
        {workspaceId: w2, userId: outsiderId, role: 'owner'},
      ],
    });
  });

  it('shows billing to members of THAT workspace only (other workspace: 404)', async () => {
    const ok = await member.get(`/site-api/workspaces/${w1}/billing`);
    expect(ok.status).toBe(200);
    expect(ok.json.canManage).toBe(false);
    expect((ok.json.entitlements as {plan: string}).plan).toBe('free');
    expect(JSON.stringify(ok.json)).not.toContain('pro-monthly'); // price keys stay on the server
    expect((await outsider.get(`/site-api/workspaces/${w1}/billing`)).status).toBe(404);
    expect((await member.get(`/site-api/workspaces/${w2}/billing`)).status).toBe(404);
    expect((await member.get('/site-api/workspaces/abc/billing')).status).toBe(404);
    expect((await new Browser(app).get(`/site-api/workspaces/${w1}/billing`)).status).toBe(401);
  });

  it('checkout: not a member 404, plain member 403, bad plan 422, unbuyable plan 404, free-for-all 409', async () => {
    const path = (id: number) => `/site-api/workspaces/${id}/billing/checkout`;
    expect((await outsider.post(path(w1), {plan: 'pro'})).status).toBe(404);
    expect((await member.post(path(w1), {plan: 'pro'})).status).toBe(403);
    expect((await admin.post(path(w1), {plan: 'NOPE!'})).status).toBe(422);
    expect((await admin.post(path(w1), {plan: 'free'})).status).toBe(404);
    expect((await admin.post(path(w1), {plan: 'ghost'})).status).toBe(404);
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'FREE_FOR_ALL'}});
    const {invalidateAppSettings} = await import('../../src/server/entitlements');
    await invalidateAppSettings();
    expect((await admin.post(path(w1), {plan: 'pro'})).status).toBe(409);
  });

  it('"mine" lists only the workspaces the visitor owns or administers', async () => {
    const mine = await admin.get('/site-api/billing/mine');
    expect((mine.json.workspaces as {id: number}[]).map(w => w.id)).toEqual([w1]);
    expect(((await member.get('/site-api/billing/mine')).json.workspaces as unknown[]).length).toBe(0);
  });

  it('a late ended event of an old subscription keeps the plan while another membership is active', async () => {
    const ref = `${adminId}:${w1}`;
    const run = (m: ReturnType<typeof membership>) => inRequestScope(() => applyWorkspacePlan(m));
    await run(membership(ref, 'pro-monthly', 'active'));
    await db.membership.create({data: {subscriptionId: 'sub_new', priceKey: 'pro-monthly', status: 'active', workspaceId: w1, userId: adminId}});
    expect((await run(membership(ref, 'pro-monthly', 'canceled'))).changed).toBe(false);
    expect((await db.workspace.findUniqueOrThrow({where: {id: w1}})).plan).toBe('pro');
    await db.membership.update({where: {subscriptionId: 'sub_new'}, data: {status: 'canceled'}});
    expect((await run(membership(ref, 'pro-monthly', 'canceled'))).changed).toBe(true);
  });

  it('the membership hook sets, keeps and ends a workspace plan, idempotently', async () => {
    const ref = `${adminId}:${w1}`;
    const plan = async () => (await db.workspace.findUniqueOrThrow({where: {id: w1}})).plan;
    const run = (m: ReturnType<typeof membership>) => inRequestScope(() => applyWorkspacePlan(m));

    expect((await run(membership(ref, 'pro-monthly', 'active'))).changed).toBe(true);
    expect(await plan()).toBe('pro');
    expect((await db.workspace.findUniqueOrThrow({where: {id: w1}})).memberLimit).toBe(50);
    expect((await run(membership(ref, 'pro-monthly', 'active'))).changed).toBe(false);
    expect((await run(membership(ref, 'team-monthly', 'active'))).changed).toBe(true);
    expect(await plan()).toBe('team');
    // An old Pro subscription ending never undoes the Team upgrade.
    expect((await run(membership(ref, 'pro-monthly', 'canceled'))).changed).toBe(false);
    expect(await plan()).toBe('team');
    // Still inside the paid period: access stays.
    expect((await run(membership(ref, 'team-monthly', 'canceled', new Date(Date.now() + 86_400_000).toISOString()))).changed).toBe(false);
    expect((await run(membership(ref, 'team-monthly', 'canceled'))).changed).toBe(true);
    expect(await plan()).toBe('free');
    // Unknown workspace, no workspace in the reference, unknown price: nothing happens.
    expect((await run(membership(`${adminId}:999999`, 'pro-monthly', 'active'))).changed).toBe(false);
    expect((await run(membership(String(adminId), 'pro-monthly', 'active'))).changed).toBe(false);
    expect((await run(membership(ref, 'other-price', 'active'))).changed).toBe(false);
    expect(await db.auditEvent.count({where: {action: 'workspace.plan_changed'}})).toBe(3);
  });

  it('plan limits: owners only, validated, lowering starts the grace clock', async () => {
    expect((await admin.get('/site-api/billing/plans')).status).toBe(403);
    expect((await member.request('PATCH', '/site-api/billing/plans/pro', {...PRO, maxFileMb: 100, storageGb: 20})).status).toBe(403);
    const list = await staff.get('/site-api/billing/plans');
    expect(list.status).toBe(200);
    expect((list.json.plans as {plan: string}[]).map(p => p.plan).sort()).toEqual(['free', 'pro', 'team']);

    const body = {maxMembers: 1, maxFileMb: 50, storageGb: 5, maxFlows: 3, auditLog: true};
    expect((await staff.request('PATCH', '/site-api/billing/plans/pro', {...body, maxMembers: 0})).status).toBe(422);
    expect((await staff.request('PATCH', '/site-api/billing/plans/pro', {...body, maxFileMb: 101})).status).toBe(422);
    expect((await staff.request('PATCH', '/site-api/billing/plans/pro', {...body, auditLog: 'yes'})).status).toBe(422);
    expect((await staff.request('PATCH', '/site-api/billing/plans/ghost', body)).status).toBe(404);

    await db.workspace.update({where: {id: w1}, data: {plan: 'pro'}});
    const saved = await staff.request('PATCH', '/site-api/billing/plans/pro', body);
    expect(saved.status).toBe(200);
    const row = await db.planLimit.findUniqueOrThrow({where: {plan: 'pro'}});
    expect(row.maxMembers).toBe(1);
    expect(Number(row.maxFileBytes)).toBe(50 * 1024 * 1024);
    expect(row.auditLog).toBe(true);
    // Workspace One has 2 members on a 1-member plan: grace starts, nothing is deleted.
    expect((await db.workspace.findUniqueOrThrow({where: {id: w1}})).graceUntil).not.toBeNull();
    expect((await db.workspace.findUniqueOrThrow({where: {id: w2}})).graceUntil).toBeNull();
    expect(await db.auditEvent.count({where: {action: 'plan.limits_changed'}})).toBe(1);
  });

  it('billing mode: owners only, audited', async () => {
    expect((await admin.get('/site-api/billing/settings')).status).toBe(403);
    expect((await admin.request('PUT', '/site-api/billing/settings', {billingMode: 'FREE_FOR_ALL', graceDays: 14})).status).toBe(403);
    expect((await staff.request('PUT', '/site-api/billing/settings', {billingMode: 'MAYBE', graceDays: 14})).status).toBe(422);
    expect((await staff.request('PUT', '/site-api/billing/settings', {billingMode: 'FREE_FOR_ALL', graceDays: 9999})).status).toBe(422);
    const done = await staff.request('PUT', '/site-api/billing/settings', {billingMode: 'FREE_FOR_ALL', graceDays: 7});
    expect(done.status).toBe(200);
    expect((await db.appSettings.findUniqueOrThrow({where: {id: 1}})).billingMode).toBe('FREE_FOR_ALL');
    expect(await db.auditEvent.count({where: {action: 'billing.mode_changed'}})).toBe(1);
  });

  it('staff see every workspace (audited); members and admins of one do not', async () => {
    expect((await admin.get('/site-api/billing/workspaces')).status).toBe(403);
    const all = await staff.get('/site-api/billing/workspaces');
    expect(all.status).toBe(200);
    expect((all.json.workspaces as {id: number}[]).map(w => w.id)).toEqual([w2, w1]);
    expect(JSON.stringify(all.json)).not.toContain('@example.test');
    expect(await db.auditEvent.count({where: {action: 'workspace.staff_list'}})).toBe(1);
  });
  it('an upgrade keeps the HIGHEST plan (a stale lower event cannot flip it back) and cancels the lower subscription at period end', async () => {
    const ref = `${adminId}:${w1}`;
    const sub = (id: string, price: string, status: 'active' | 'canceled' = 'active', accessEndsAt: string | null = null) => ({
      ...membership(ref, price, status, accessEndsAt),
      id,
    });
    const plan = async () => (await db.workspace.findUniqueOrThrow({where: {id: w1}})).plan;
    const hook = (m: ReturnType<typeof sub>, at: string) =>
      inRequestScope(() => paymentHooks.onMembershipChanged!(m, {id: `e_${at}`, type: 'membership.started', mode: 'test', createdAt: at, source: 'event'}));

    // Intercept ONLY the platform's cancel call; everything else goes on to the harness.
    const cancelled: {id: string; atPeriodEnd: unknown}[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const hit = /\/payments\/memberships\/([^/]+)\/cancel$/.exec(url);
      if (!hit) return previous(input, init);
      cancelled.push({id: hit[1]!, atPeriodEnd: (JSON.parse(String(init?.body)) as {atPeriodEnd?: unknown}).atPeriodEnd});
      const body = {data: {membership: {...sub(hit[1]!, 'pro-monthly', 'canceled', new Date(Date.now() + 86_400_000).toISOString())}}};
      return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
    }) as typeof fetch;
    try {
      await hook(sub('sub_pro', 'pro-monthly'), '2026-01-01T00:00:00.000Z');
      expect(await plan()).toBe('pro');
      expect(cancelled).toEqual([]);
      await hook(sub('sub_team', 'team-monthly'), '2026-02-01T00:00:00.000Z');
      expect(await plan()).toBe('team');
      expect(cancelled).toEqual([{id: 'sub_pro', atPeriodEnd: true}]);
      // A stale / repeated lower-plan event after the upgrade: the plan stays team.
      await hook(sub('sub_pro', 'pro-monthly'), '2026-03-01T00:00:00.000Z');
      expect(await plan()).toBe('team');
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('recording a membership never blanks the buyer, the email or the workspace', async () => {
    const full = {...membership(`${adminId}:${w1}`, 'pro-monthly', 'active'), id: 'sub_keep', email: 'Buyer@Example.test'};
    await inRequestScope(() => recordMembership(full, 'test', '2026-01-01T00:00:00.000Z'));
    await inRequestScope(() => recordMembership({...full, customerRef: null, email: null, status: 'past_due'}, 'test', '2026-01-02T00:00:00.000Z'));
    const row = await db.membership.findUniqueOrThrow({where: {subscriptionId: 'sub_keep'}});
    expect(row.status).toBe('past_due');
    expect(row.userId).toBe(adminId);
    expect(row.workspaceId).toBe(w1);
    expect(row.email).toBe('buyer@example.test');
    // A confirm without a timestamp leaves lastEventAt alone, so an older real event is still applied.
    await inRequestScope(() => recordMembership({...full, status: 'active'}, 'test'));
    expect((await db.membership.findUniqueOrThrow({where: {subscriptionId: 'sub_keep'}})).lastEventAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('the generic checkout route refuses a plan price key (plans are sold only through the workspace route)', async () => {
    const plans = await db.planLimit.findMany({where: {priceKeyMonthly: {not: ''}}, select: {priceKeyMonthly: true}});
    expect(plans.length).toBeGreaterThan(0);
    for (const {priceKeyMonthly} of plans) {
      expect((await admin.post('/site-api/checkout', {price: priceKeyMonthly})).status).toBe(404);
      expect((await new Browser(app).post('/site-api/checkout', {price: priceKeyMonthly})).status).toBe(404);
    }
  });

  it('plan limits: storage must strictly grow free < pro < team', async () => {
    const GB = 1024 ** 3;
    const [free, team] = await Promise.all([db.planLimit.findUniqueOrThrow({where: {plan: 'free'}}), db.planLimit.findUniqueOrThrow({where: {plan: 'team'}})]);
    const body = {maxMembers: 50, maxFileMb: 100, maxFlows: 10, auditLog: false};
    const patch = (storageGb: number) => staff.request('PATCH', '/site-api/billing/plans/pro', {...body, storageGb});
    const atFree = await patch(Math.max(1, Math.floor(Number(free.storageQuotaBytes) / GB)));
    expect(atFree.status).toBe(422);
    expect(JSON.stringify(atFree.json)).toContain('storageGb');
    expect((await patch(Math.ceil(Number(team.storageQuotaBytes) / GB))).status).toBe(422);
    expect((await db.planLimit.findUniqueOrThrow({where: {plan: 'pro'}})).storageQuotaBytes).toBe(BigInt(PRO.storageQuotaBytes));
    expect((await patch(20)).status).toBe(200);
  });

  it('a workspace over its limit with no grace clock gets one when its entitlements are read', async () => {
    await db.workspace.update({where: {id: w1}, data: {memberCount: 100000, graceUntil: null}});
    const res = await member.get(`/site-api/workspaces/${w1}/billing`);
    expect(res.status).toBe(200);
    expect((res.json.entitlements as {overLimit: boolean; graceUntil: string | null}).overLimit).toBe(true);
    expect((res.json.entitlements as {graceUntil: string | null}).graceUntil).not.toBeNull();
    expect((await db.workspace.findUniqueOrThrow({where: {id: w1}})).graceUntil).not.toBeNull();
  });
});
