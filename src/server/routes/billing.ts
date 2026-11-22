import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {sha256Hex} from '../../platform/auth/encoding';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {createCheckout, listGateways, listPrices} from '../../platform/payments';
import {
  type BillingMode,
  getAppSettings,
  getEntitlements,
  invalidateAppSettings,
  SAFETY_CAPS,
  startGraceForOverLimit,
} from '../entitlements';
import {flowRunsUsed} from '../flows/runs';
import {clearPublicPlans, getPublicPricing} from '../pricing';
import {softLimited} from '../soft-limit';
import {PERMISSIONS} from '../permissions';
import {idOf, intField, invalid, objectOf} from '../validation';
import {FILE_CEILING_MB} from '../../lib/file-limits';
import {MAX_BOARDS_CAP, MAX_FLOW_RUNS_INPUT, UNLIMITED_MEMBERS} from '../../lib/plan-limits';
import {notFound, requireWorkspaceRole} from '../workspaces';

/**
 * Billing (docs/product/SPEC.md §10, HANDOFF.md §2). Payments are sandbox only until the owner connects a
 * gateway; limits are decided ONLY by `entitlements.ts`.
 *
 * Workspace admins and owners (members of THAT workspace; anyone else gets 404):
 *   GET  /site-api/workspaces/:id/billing            plan, limits, usage, the plans on offer (any member)
 *   POST /site-api/workspaces/:id/billing/checkout   {plan, gateway?} start a sandbox checkout (admin+)
 *   GET  /site-api/billing/mine                      the workspaces the visitor owns or administers, with their plan
 * `site:billing:manage` (owners of the site, /dashboard Billing):
 *   GET  /site-api/billing/settings                  billing mode + grace days
 *   PUT  /site-api/billing/settings                  {billingMode, graceDays}
 * `site:plans:manage` (/dashboard Plan limits):
 *   GET   /site-api/billing/plans                    every plan's limits
 *   PATCH /site-api/billing/plans/:plan              {maxMembers, maxBoards, maxFileMb, flowRunsPerMonth, auditLog} (null = unlimited)
 * `site:workspace:read` (/dashboard Workspaces; every call is audited):
 *   GET  /site-api/billing/workspaces?before=        every workspace, newest first
 *
 * The plan of a workspace changes ONLY from the platform's membership events (`payments-hooks.ts`).
 */

const MB = 1024 * 1024;
const PAGE_SIZE = 20;
const GATEWAY = /^[a-z0-9_-]{1,40}$/;
/** The plans on offer (browser shape, no price key): changes only in PATCH /billing/plans/:plan, which clears it. */
const PLANS_CACHE_KEY = 'billing:plans:v2';
const PLANS_TTL = 86_400;
const PLAN_RE = /^[a-z][a-z0-9-]{0,15}$/;

/** What the browser may see of one plan (never the price key: only whether it can be bought). */
const planOut = (row: {
  plan: string;
  rank: number;
  maxMembers: number;
  maxBoards: number | null;
  maxFileBytes: bigint;
  flowRunsPerMonth: number | null;
  auditLog: boolean;
  priceKeyMonthly: string;
}) => ({
  plan: row.plan,
  rank: row.rank,
  /** null = unlimited (at the safety cap). */
  maxMembers: row.maxMembers >= UNLIMITED_MEMBERS ? null : row.maxMembers,
  maxBoards: row.maxBoards,
  maxFileBytes: Number(row.maxFileBytes),
  flowRunsPerMonth: row.flowRunsPerMonth,
  auditLog: row.auditLog,
  purchasable: row.priceKeyMonthly !== '',
});

const planSelect = {
  plan: true,
  rank: true,
  maxMembers: true,
  maxBoards: true,
  maxFileBytes: true,
  flowRunsPerMonth: true,
  auditLog: true,
  priceKeyMonthly: true,
} as const;

/** A limit that may be left empty for "unlimited" (null). */
const optionalInt = (value: unknown, min: number, max: number) => (value === null ? ({ok: true, value: null} as const) : intField(value, min, max));

const checkoutBody = validator('json', (value, c) => {
  const body = objectOf(value);
  const plan = typeof body?.plan === 'string' ? body.plan.trim() : '';
  const gateway = typeof body?.gateway === 'string' && body.gateway ? body.gateway : undefined;
  if (!PLAN_RE.test(plan)) return invalid(c, {plan: {code: 'invalid', message: 'Choose a plan.'}});
  if (gateway !== undefined && !GATEWAY.test(gateway)) return invalid(c, {gateway: {code: 'invalid', message: 'Choose a way to pay.'}});
  return {plan, gateway};
});

const settingsBody = validator('json', (value, c) => {
  const body = objectOf(value);
  const mode = body?.billingMode;
  if (mode !== 'PAID' && mode !== 'FREE_FOR_ALL') return invalid(c, {billingMode: {code: 'invalid', message: 'Choose paid or free for all.'}});
  const days = intField(body?.graceDays, 0, 365);
  if (!days.ok) return invalid(c, {graceDays: days.error});
  return {billingMode: mode as BillingMode, graceDays: days.value};
});

const planBody = validator('json', (value, c) => {
  const body = objectOf(value);
  // Members, boards and flow runs: null = unlimited (members are then stored at the safety cap).
  const members = optionalInt(body?.maxMembers, 1, SAFETY_CAPS.maxMembers - 1);
  const boards = optionalInt(body?.maxBoards, 1, MAX_BOARDS_CAP - 1);
  const fileMb = intField(body?.maxFileMb, 1, FILE_CEILING_MB);
  const runs = optionalInt(body?.flowRunsPerMonth, 0, MAX_FLOW_RUNS_INPUT);
  const errors: Record<string, {code: string; message: string}> = {};
  if (!members.ok) errors.maxMembers = members.error;
  if (!boards.ok) errors.maxBoards = boards.error;
  if (!fileMb.ok) errors.maxFileMb = fileMb.error;
  if (!runs.ok) errors.flowRunsPerMonth = runs.error;
  if (typeof body?.auditLog !== 'boolean') errors.auditLog = {code: 'invalid', message: 'Choose on or off.'};
  if (!members.ok || !boards.ok || !fileMb.ok || !runs.ok || Object.keys(errors).length) return invalid(c, errors);
  return {
    maxMembers: members.value ?? UNLIMITED_MEMBERS,
    maxBoards: boards.value,
    maxFileBytes: BigInt(fileMb.value * MB),
    flowRunsPerMonth: runs.value,
    auditLog: body!.auditLog as boolean,
  };
});

/** Open boards of a workspace, counted up to the safety cap (bounded; index boards(workspace_id, archived_at, id)). */
async function openBoards(db: Pick<PrismaClient, '$queryRaw'>, workspaceId: number): Promise<number> {
  const [row] = await db.$queryRaw<{n: number}[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM boards WHERE workspace_id = ${workspaceId}::int AND archived_at IS NULL LIMIT ${SAFETY_CAPS.maxBoards}::int
    ) open_boards`;
  return row?.n ?? 0;
}

const beforeQuery = validator('query', value => ({before: idOf(typeof value.before === 'string' ? value.before : '')}));

export const billingRoutes = new Hono()
  // ---- public: the plans the pricing page shows (cached; no visitor data, no price keys) ------------
  .get('/billing/public-plans', withDb, async c => {
    const pricing = await getPublicPricing(c.var.db, c.req.url);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(pricing);
  })

  // ---- a workspace's own billing -------------------------------------------------------------------
  .get('/workspaces/:id/billing', withViewer, requireAuth, withDb, requireWorkspaceRole('viewer'), async c => {
    const {db, workspaceId, member} = c.var;
    const [entitlements, plans, workspace, payments, boards, flowRuns] = await Promise.all([
      getEntitlements(db, workspaceId),
      cache.getOrSet(PLANS_CACHE_KEY, PLANS_TTL, async () =>
        (await db.planLimit.findMany({select: planSelect, orderBy: {rank: 'asc'}, take: 10})).map(planOut),
      ),
      db.workspace.findUnique({where: {id: workspaceId}, select: {id: true, name: true, plan: true}}),
      paymentsStatus(c.req.url),
      openBoards(db, workspaceId),
      flowRunsUsed(db, workspaceId),
    ]);
    if (!entitlements || !workspace) return notFound(c);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      workspace,
      // Usage of the limits a plan sets (like Trello): members, open boards, flow runs this month. No storage limit.
      entitlements: {...entitlements, usage: {...entitlements.usage, boards, flowRuns}},
      plans,
      canManage: member.rank >= 3,
      payments,
    });
  })

  .post('/workspaces/:id/billing/checkout', checkoutBody, withViewer, requireAuth, withDb, requireWorkspaceRole('admin'), async c => {
    const {db, workspaceId, viewer} = c.var;
    const {plan, gateway} = c.req.valid('json');
    if (await softLimited(viewer.id!, 'checkout', 10, 600)) {
      c.header('Retry-After', '60');
      return c.json(problem('rate_limited', 'Too many checkout attempts. Wait a few minutes and try again.'), 429);
    }
    const [entitlements, plans] = await Promise.all([
      getEntitlements(db, workspaceId),
      db.planLimit.findMany({select: planSelect, take: 10}),
    ]);
    if (!entitlements) return notFound(c);
    if (!entitlements.upgradeUi) return c.json(problem('billing_disabled', 'Plans are not needed right now: every feature is unlocked.'), 409);
    const target = plans.find(row => row.plan === plan);
    const current = plans.find(row => row.plan === entitlements.plan);
    if (!target || target.priceKeyMonthly === '') return c.json(problem('not_found', 'That plan cannot be bought.'), 404);
    if (target.plan === entitlements.plan || (current && target.rank <= current.rank)) {
      return c.json(problem('not_an_upgrade', 'Choose a plan bigger than the current one.'), 409);
    }
    // A subscription for this plan or a bigger one is already running (a second tab, another admin, or one paid but not
    // yet applied): a second checkout would bill twice, and the hook cancels only LOWER plans.
    const [running] = await db.$queryRaw<{plan: string}[]>`
      SELECT p.plan FROM memberships m JOIN plan_limits p ON p.price_key_monthly = m.price_key AND p.price_key_monthly <> ''
      WHERE m.workspace_id = ${workspaceId} AND m.status IN ('active', 'trialing', 'past_due') AND m.access_ends_at IS NULL
        AND p.rank >= ${target.rank}
        AND (${!config.production}::boolean OR m.mode = 'live')
      LIMIT 1`;
    if (running) {
      return c.json(problem('already_subscribed', 'This workspace already has a subscription for this plan or a bigger one. Refresh the page to see it.'), 409);
    }
    // The price is named by KEY, from our own table: never an amount, never the browser's choice.
    const price = target.priceKeyMonthly;
    let chosen = gateway;
    if (!chosen) {
      const ways = await listGateways(c.req.url, price);
      if (ways.ok && ways.data.length > 1) return c.json({choose: true as const, gateways: ways.data});
      if (ways.ok && ways.data.length === 1) chosen = ways.data[0]!.slug;
    }
    // One open checkout per workspace, plan and way to pay for an hour, whoever starts it: two admins (or one admin
    // back after the platform's own 2-minute key) get the SAME checkout, never a second subscription billed alongside.
    const idempotencyKey = (await sha256Hex(`plan-checkout:${workspaceId}:${target.plan}:${chosen ?? ''}:${Math.floor(Date.now() / 3_600_000)}`)).slice(0, 48);
    const started = await createCheckout(c.req.url, {
      price,
      quantity: 1,
      idempotencyKey,
      successPath: '/thanks/',
      cancelPath: '/app/settings/billing',
      // The hook reads the workspace from `customerRef` (`<userId>:<workspaceId>`), set ONLY here.
      customerRef: `${viewer.id}:${workspaceId}`,
      metadata: {workspaceId: String(workspaceId), plan: target.plan},
      email: viewer.email ?? undefined,
      name: viewer.name ?? undefined,
      ...(chosen ? {gateway: chosen} : {}),
    });
    if (!started.ok) {
      const status = started.status === 404 ? 404 : started.status === 422 ? 422 : started.status === 0 ? 503 : 502;
      return c.json(problem(started.code.toLowerCase(), started.message), status);
    }
    c.header('Cache-Control', 'private, no-store');
    const {id, mode, embedded, paid} = started.data;
    // Already paid under this key (another admin just paid it): the thanks page, nothing new is started.
    if (paid) return c.json({choose: false as const, redirectUrl: `/thanks/?checkout=${encodeURIComponent(id)}`, id, mode, embedded: null});
    return c.json({choose: false as const, redirectUrl: `/checkout/?id=${encodeURIComponent(id)}`, id, mode, embedded: embedded ?? null});
  })

  // ---- the visitor's own workspaces (owner or admin) ------------------------------------------------
  .get('/billing/mine', withViewer, requireAuth, withDb, async c => {
    const rows = await c.var.db.workspaceMember.findMany({
      where: {userId: c.var.viewer.id!, role: {in: ['owner', 'admin']}, workspace: {archivedAt: null}},
      select: {
        role: true,
        workspace: {select: {id: true, name: true, plan: true, memberCount: true, storageUsedBytes: true, graceUntil: true}},
      },
      orderBy: {workspaceId: 'asc'},
      take: 50,
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      workspaces: rows.map(({role, workspace}) => ({
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        role,
        memberCount: workspace.memberCount,
        storageUsedBytes: Number(workspace.storageUsedBytes),
        graceUntil: workspace.graceUntil?.toISOString() ?? null,
      })),
    });
  })

  // ---- site owners: billing mode ---------------------------------------------------------------------
  .get('/billing/settings', withViewer, requireAuth, requirePermission(PERMISSIONS.BILLING_MANAGE), withDb, async c => {
    const [settings, payments] = await Promise.all([getAppSettings(c.var.db), paymentsStatus(c.req.url)]);
    c.header('Cache-Control', 'private, no-store');
    return c.json({billingMode: settings.billingMode, graceDays: settings.graceDays, payments});
  })

  .put('/billing/settings', settingsBody, withViewer, requireAuth, requirePermission(PERMISSIONS.BILLING_MANAGE), withDb, async c => {
    const {billingMode, graceDays} = c.req.valid('json');
    const db = c.var.db;
    const before = await getAppSettings(db);
    await db.appSettings.upsert({
      where: {id: 1},
      create: {id: 1, billingMode, graceDays},
      update: {billingMode, graceDays},
      select: {id: true},
    });
    await invalidateAppSettings();
    // Switching to PAID starts the grace clock of workspaces already over their plan; FREE_FOR_ALL clears it.
    if (before.billingMode !== billingMode) await startGraceForOverLimit(db);
    await audit(db, {
      actorUserId: c.var.viewer.id,
      action: 'billing.mode_changed',
      target: ['app_settings', 1],
      meta: {from: before.billingMode, to: billingMode, graceDays},
    });
    return c.json({billingMode, graceDays});
  })

  // ---- site owners: plan limits --------------------------------------------------------------------
  .get('/billing/plans', withViewer, requireAuth, requirePermission(PERMISSIONS.PLANS_MANAGE), withDb, async c => {
    const rows = await c.var.db.planLimit.findMany({select: {...planSelect, updatedAt: true}, orderBy: {rank: 'asc'}, take: 10});
    c.header('Cache-Control', 'private, no-store');
    return c.json({plans: rows.map(row => ({...planOut(row), priceKey: row.priceKeyMonthly, updatedAt: row.updatedAt.toISOString()}))});
  })

  .patch('/billing/plans/:plan', planBody, withViewer, requireAuth, requirePermission(PERMISSIONS.PLANS_MANAGE), withDb, async c => {
    const plan = c.req.param('plan');
    if (!PLAN_RE.test(plan)) return c.json(problem('not_found', 'No such plan.'), 404);
    const db = c.var.db;
    const data = c.req.valid('json');
    // `updateMany` keeps "not found" a plain count of 0 (no throw) and never creates a plan.
    const {count} = await db.planLimit.updateMany({where: {plan}, data});
    if (!count) return c.json(problem('not_found', 'No such plan.'), 404);
    await invalidateAppSettings();
    await Promise.all([cache.del(PLANS_CACHE_KEY), clearPublicPlans()]);
    // Limits lowered: workspaces on this plan that are now over start their grace period.
    await startGraceForOverLimit(db, {plan});
    await audit(db, {
      actorUserId: c.var.viewer.id,
      action: 'plan.limits_changed',
      target: ['plan_limits', plan],
      meta: {maxMembers: data.maxMembers, maxBoards: data.maxBoards, flowRunsPerMonth: data.flowRunsPerMonth, auditLog: data.auditLog},
    });
    const row = await db.planLimit.findUnique({where: {plan}, select: {...planSelect, updatedAt: true}});
    return row ? c.json({plan: {...planOut(row), priceKey: row.priceKeyMonthly, updatedAt: row.updatedAt.toISOString()}}) : notFound(c, 'plan');
  })

  // ---- site staff: every workspace -------------------------------------------------------------------
  .get('/billing/workspaces', beforeQuery, withViewer, requireAuth, requirePermission(PERMISSIONS.WORKSPACE_READ), withDb, async c => {
    const {before} = c.req.valid('query');
    const db = c.var.db;
    const rows = await db.workspace.findMany({
      where: before ? {id: {lt: before}} : undefined,
      select: {id: true, name: true, slug: true, plan: true, memberCount: true, storageUsedBytes: true, graceUntil: true, createdAt: true},
      orderBy: {id: 'desc'},
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    // Every staff access to other people's workspaces is on the record (no names, no emails).
    await audit(db, {actorUserId: c.var.viewer.id, action: 'workspace.staff_list', target: ['workspace', 'all'], meta: {count: page.length}});
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      workspaces: page.map(row => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        plan: row.plan,
        memberCount: row.memberCount,
        storageUsedBytes: Number(row.storageUsedBytes),
        graceUntil: row.graceUntil?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextBefore: rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
    });
  });

/** `{ready, mode}` of the payment account, or null when the platform cannot say (never throws). */
async function paymentsStatus(url: string): Promise<{ready: boolean; mode: 'test' | 'live'} | null> {
  try {
    const catalogue = await listPrices(url, {ttlSeconds: 60});
    return catalogue.ok ? {ready: catalogue.data.ready, mode: catalogue.data.mode} : null;
  } catch {
    return null;
  }
}
